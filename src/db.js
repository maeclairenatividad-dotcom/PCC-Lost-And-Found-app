const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// The whole database is one file. It is created on first use.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'app.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
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

/**
 * SQLite has no native Date column. Dates are stored as "YYYY-MM-DD HH:MM:SS"
 * in local time, so every helper in helpers.js parses them back the same way.
 * This normalises bound parameters: Dates become that string, undefined -> null.
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

/** Run a query and return rows only. */
async function q(sql, params = []) {
  return db.prepare(sql).all(...fixParams(params));
}

/** Run a query and return the first row, or null. */
async function one(sql, params = []) {
  const row = db.prepare(sql).get(...fixParams(params));
  return row === undefined ? null : row;
}

/**
 * INSERT/UPDATE/DELETE. Returns { insertId, affectedRows } (and the raw
 * better-sqlite3 info object) so call sites written for MySQL keep working.
 */
async function run(sql, params = []) {
  const info = db.prepare(sql).run(...fixParams(params));
  return {
    insertId: info.lastInsertRowid,
    affectedRows: info.changes,
    changes: info.changes,
    lastInsertRowid: info.lastInsertRowid
  };
}

/** Run a multi-statement SQL string (used by db/init.js and the seed). */
function exec(sql) {
  return db.exec(sql);
}

/** Run a PRAGMA (returns its result rows). */
function pragma(statement) {
  return db.pragma(statement);
}

/** Smoke-test that the database is open and runnable. */
async function verify() {
  const row = await one('SELECT 1 AS ok');
  if (!row || row.ok !== 1) throw new Error('Database did not answer a SELECT 1.');
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

module.exports = { db, q, one, run, exec, pragma, verify, nextRefCode, logActivity };