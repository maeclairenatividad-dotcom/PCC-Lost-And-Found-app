/**
 * SQLite-backed session store.
 *
 * express-session's default MemoryStore loses every login when the process
 * restarts and warns about leaks in production. This keeps sessions in the same
 * SQLite file as everything else, so a redeploy or crash keeps people signed in.
 */
const session = require('express-session');
const { db } = require('./db');

class SqliteSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.ttlMs = Number(options.ttlMs) || 1000 * 60 * 60 * 8;

    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid        TEXT PRIMARY KEY,
        sess       TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    `);

    // Drop expired rows hourly. unref() so it never keeps the process alive.
    this.cleanup = setInterval(() => this.prune(), 1000 * 60 * 60);
    if (this.cleanup.unref) this.cleanup.unref();
  }

  expiryOf(sess) {
    if (sess && sess.cookie && sess.cookie.expires) {
      const t = new Date(sess.cookie.expires).getTime();
      if (!Number.isNaN(t)) return t;
    }
    return Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    try {
      const row = db
        .prepare('SELECT sess FROM sessions WHERE sid = ? AND expires_at > ?')
        .get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      db.prepare(`
        INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at
      `).run(sid, JSON.stringify(sess), this.expiryOf(sess));
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?')
        .run(this.expiryOf(sess), sid);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  clear(cb) {
    try {
      db.prepare('DELETE FROM sessions').run();
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  length(cb) {
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?').get(Date.now());
      cb(null, row.n);
    } catch (err) {
      cb(err);
    }
  }

  prune() {
    try {
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    } catch (err) {
      console.error('[sessions] cleanup failed:', err.message);
    }
  }
}

module.exports = { SqliteSessionStore };
