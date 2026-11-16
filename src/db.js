/**
 * Database layer with two interchangeable engines.
 *
 *   DATABASE_URL=postgresql://…  -> Postgres (Neon, Supabase, Railway, RDS…)
 *   (no DATABASE_URL)            -> SQLite file via better-sqlite3
 *
 * The rest of the app is written once, in SQLite-flavoured SQL. When Postgres
 * is selected this module rewrites placeholders (`?` -> `$1`) and the handful
 * of SQLite date functions the app uses, and adds `RETURNING id` to inserts so
 * `result.insertId` keeps working.
 *
 * The public API is intentionally small and async for both engines:
 *   q(sql, params)     -> rows
 *   one(sql, params)   -> first row or null
 *   run(sql, params)   -> { insertId, affectedRows, changes }
 *   exec(sql)          -> run a multi-statement SQL string
 *   verify()           -> throws if the database is unreachable
 *   ensureSchema()     -> creates tables/categories if this is a fresh database
 */
const path = require('path');
const fs = require('fs');

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const isPostgres = /^postgres(ql)?:\/\//i.test(DATABASE_URL);

/**
 * Timestamps are stored as "wall clock" time (no timezone). Neon runs in UTC
 * by default; a Philippine school expects Philippine time. Every "now" written
 * by the app is computed as the current time *in this zone*, so dates display
 * correctly no matter where the database server sits.
 */
const TIMEZONE = process.env.PG_TIMEZONE || 'Asia/Manila';

/** SQL expression for "now" as a local wall-clock timestamp. */
function nowSql() {
  return `(CURRENT_TIMESTAMP AT TIME ZONE '${TIMEZONE.replace(/'/g, "''")}')`;
}

let db = null;   // better-sqlite3 instance (SQLite mode)
let pool = null; // pg Pool (Postgres mode)

if (isPostgres) {
  const pg = require('pg');

  // COUNT(*) is int8, which pg returns as a string by default. The app adds,
  // compares and renders those numbers, so parse them.
  pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

  const localHost = /@(localhost|127\.0\.0\.1)[:/]/i.test(DATABASE_URL);
  const wantsSSL = /sslmode=(require|verify-ca|verify-full)/i.test(DATABASE_URL)
    || String(process.env.PGSSL || '').toLowerCase() === 'true'
    || !localHost;

  pool = new pg.Pool({
    connectionString: DATABASE_URL,
    ssl: wantsSSL ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    application_name: 'pcc-lost-and-found'
  });

  pool.on('error', (err) => console.error('[postgres] idle client error:', err.message));
} else {
  const Database = require('better-sqlite3');

  // The whole database is one file. It is created on first use.
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'app.db');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Lightweight migrations: ensure tables added after v1 exist on older DBs.
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      sid        TEXT PRIMARY KEY,
      sess       TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);
}

/**
 * SQLite has no native Date type; dates are stored as "YYYY-MM-DD HH:MM:SS"
 * wall-clock strings. This normalises bound parameters: Dates become that
 * string, undefined -> null. Postgres uses the same shape so a timestamp
 * written by SQLite and one written by Postgres read back identically.
 */
function fixParams(params = []) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (p instanceof Date) return sqlDate(p);
    return p;
  });
}

function sqlDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Rewrite the SQLite-flavoured SQL used in the app for Postgres.
 * Everything here is deliberate and narrow — only the constructs this
 * codebase actually uses.
 */
function toPgSql(sql) {
  let out = String(sql);

  // CAST(julianday('now','localtime') - julianday(col) AS INTEGER) -> whole days
  out = out.replace(
    /CAST\(\s*julianday\(\s*'now'\s*,\s*'localtime'\s*\)\s*-\s*julianday\(\s*([^)]+?)\s*\)\s+AS\s+INTEGER\s*\)/gi,
    'FLOOR(EXTRACT(EPOCH FROM (LOCALTIMESTAMP - $1)) / 86400)::int'
  );

  // datetime('now','localtime', ?) — a bound interval such as '-90 days'
  out = out.replace(
    /datetime\(\s*'now'\s*,\s*'localtime'\s*,\s*\?\s*\)/gi,
    '(LOCALTIMESTAMP + (?::interval))'
  );

  // datetime('now','localtime','-6 months')
  out = out.replace(
    /datetime\(\s*'now'\s*,\s*'localtime'\s*,\s*'([^']+)'\s*\)/gi,
    "(LOCALTIMESTAMP + INTERVAL '$1')"
  );

  // datetime('now','localtime')
  out = out.replace(/datetime\(\s*'now'\s*,\s*'localtime'\s*\)/gi, 'LOCALTIMESTAMP');

  // strftime('%Y-%m', col) / CAST(strftime('%m', col) AS INTEGER)
  out = out.replace(/strftime\(\s*'%Y-%m'\s*,\s*([^)]+?)\s*\)/gi, "to_char($1, 'YYYY-MM')");
  out = out.replace(
    /CAST\(\s*strftime\(\s*'%m'\s*,\s*([^)]+?)\s*\)\s+AS\s+INTEGER\s*\)/gi,
    'EXTRACT(MONTH FROM $1)::int'
  );

  // The intermediate LOCALTIMESTAMP (from the rewrites above) becomes an
  // explicit wall-clock time in the configured zone.
  out = out.replace(/\bLOCALTIMESTAMP\b/gi, nowSql());

  // SQLite LIKE is case-insensitive for ASCII; Postgres LIKE is not.
  out = out.replace(/\bLIKE\b/gi, 'ILIKE');

  // Positional placeholders: ? -> $1, $2, …
  let n = 0;
  out = out.replace(/\?/g, () => `$${++n}`);

  return out;
}

/** Run a query and return rows only. */
async function q(sql, params = []) {
  if (isPostgres) {
    const res = await pool.query(toPgSql(sql), fixParams(params));
    return res.rows;
  }
  return db.prepare(sql).all(...fixParams(params));
}

/** Run a query and return the first row, or null. */
async function one(sql, params = []) {
  if (isPostgres) {
    const res = await pool.query(toPgSql(sql), fixParams(params));
    return res.rows[0] || null;
  }
  const row = db.prepare(sql).get(...fixParams(params));
  return row === undefined ? null : row;
}

/**
 * INSERT/UPDATE/DELETE. Returns { insertId, affectedRows } (and the raw row
 * count) so call sites written for MySQL/SQLite keep working. Postgres needs
 * an explicit RETURNING clause to hand back the new primary key.
 */
async function run(sql, params = []) {
  if (isPostgres) {
    let statement = toPgSql(sql);
    let returnedId = false;

    if (/^\s*INSERT\s+INTO\b/i.test(statement)
        && !/\bRETURNING\b/i.test(statement)
        && !/^\s*INSERT\s+INTO\s+(settings|sessions)\b/i.test(statement)) {
      statement += ' RETURNING id';
      returnedId = true;
    }

    const res = await pool.query(statement, fixParams(params));
    return {
      insertId: returnedId && res.rows[0] ? res.rows[0].id : undefined,
      affectedRows: res.rowCount,
      changes: res.rowCount,
      rows: res.rows
    };
  }

  const info = db.prepare(sql).run(...fixParams(params));
  return {
    insertId: info.lastInsertRowid,
    affectedRows: info.changes,
    changes: info.changes,
    lastInsertRowid: info.lastInsertRowid
  };
}

/** Run a multi-statement SQL string (used by db/init.js and the seed). */
async function exec(sql) {
  if (isPostgres) {
    await pool.query(String(sql).replace(/__NOW__/g, nowSql()));
    return;
  }
  return db.exec(sql);
}

/** Run a PRAGMA (SQLite only; a no-op on Postgres). */
function pragma(statement) {
  if (isPostgres) return [];
  return db.pragma(statement);
}

/** Smoke-test that the database is open and runnable. */
async function verify() {
  const row = await one('SELECT 1 AS ok');
  if (!row || Number(row.ok) !== 1) throw new Error('Database did not answer a SELECT 1.');
  return true;
}

/** Which schema file belongs to the active engine. */
function schemaFile() {
  return path.join(__dirname, '..', 'db', isPostgres ? 'schema.postgres.sql' : 'schema.sql');
}

/**
 * Create the schema if this database has never been set up. Safe to call on
 * every boot: both schema files use IF NOT EXISTS.
 */
async function ensureSchema() {
  const found = isPostgres
    ? await one(
        "SELECT 1 AS ok FROM information_schema.tables " +
        "WHERE table_schema = 'public' AND table_name = 'users'"
      )
    : await one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'");

  if (found) return false;

  const sql = fs.readFileSync(schemaFile(), 'utf8');
  await exec(sql);
  console.log(`[db] created a fresh ${isPostgres ? 'Postgres' : 'SQLite'} schema`);
  return true;
}

/**
 * Generate the next human-readable reference code for a table,
 * e.g. LF-2026-0043 for items, CL-2026-0007 for claims.
 */
async function nextRefCode(table, prefix) {
  const year = new Date().getFullYear();
  const like = `${prefix}-${year}-%`;
  const row = await one(
    `SELECT ref_code FROM ${table} WHERE ref_code LIKE ?
     ORDER BY id DESC LIMIT 1`,
    [like]
  );
  const last = row ? Number(row.ref_code.split('-')[2]) : 0;
  return `${prefix}-${year}-${String(last + 1).padStart(4, '0')}`;
}

/** Append a row to activity_log. Never throws — logging must not break a request. */
async function logActivity(actorId, action, entityType, entityId, detail) {
  try {
    await run(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, detail)
       VALUES (?, ?, ?, ?, ?)`,
      [actorId || null, action, entityType || null, entityId || null, detail || null]
    );
  } catch (err) {
    console.error('[activity_log]', err.message);
  }
}

/** Close the connection cleanly on shutdown. */
async function close() {
  if (isPostgres) {
    await pool.end();
    return;
  }
  try { db.close(); } catch (err) { /* already closed */ }
}

module.exports = {
  engine: isPostgres ? 'postgres' : 'sqlite',
  isPostgres,
  db,
  pool,
  q,
  one,
  run,
  exec,
  pragma,
  verify,
  ensureSchema,
  nextRefCode,
  logActivity,
  close
};
