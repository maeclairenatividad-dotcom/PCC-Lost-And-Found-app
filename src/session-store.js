/**
 * Database-backed session store.
 *
 * express-session's default MemoryStore loses every login when the process
 * restarts and warns about leaks in production. This keeps sessions in the
 * app's own database (SQLite locally, Postgres on Neon), so a redeploy or
 * crash keeps people signed in.
 *
 * Uses the async query helpers from db.js, so the same class works on both
 * engines and is safe under Postgres' connection pool.
 */
const session = require('express-session');
const { one, run } = require('./db');

class SessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.ttlMs = Number(options.ttlMs) || 1000 * 60 * 60 * 8;

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
    one('SELECT sess FROM sessions WHERE sid = ? AND expires_at > ?', [sid, Date.now()])
      .then((row) => cb(null, row ? JSON.parse(row.sess) : null))
      .catch((err) => cb(err));
  }

  set(sid, sess, cb) {
    run(
      `INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at`,
      [sid, JSON.stringify(sess), this.expiryOf(sess)]
    )
      .then(() => cb && cb(null))
      .catch((err) => cb && cb(err));
  }

  touch(sid, sess, cb) {
    run('UPDATE sessions SET expires_at = ? WHERE sid = ?', [this.expiryOf(sess), sid])
      .then(() => cb && cb(null))
      .catch((err) => cb && cb(err));
  }

  destroy(sid, cb) {
    run('DELETE FROM sessions WHERE sid = ?', [sid])
      .then(() => cb && cb(null))
      .catch((err) => cb && cb(err));
  }

  clear(cb) {
    run('DELETE FROM sessions')
      .then(() => cb && cb(null))
      .catch((err) => cb && cb(err));
  }

  length(cb) {
    one('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?', [Date.now()])
      .then((row) => cb(null, row ? row.n : 0))
      .catch((err) => cb(err));
  }

  prune() {
    run('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]).catch((err) => {
      console.error('[sessions] cleanup failed:', err.message);
    });
  }
}

// Keep the old name as an alias so nothing breaks if it is imported directly.
module.exports = { SessionStore, SqliteSessionStore: SessionStore };
