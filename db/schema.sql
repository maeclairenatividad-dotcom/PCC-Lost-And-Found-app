-- =====================================================================
-- Campus Lost & Found Management System
-- SQLite schema
-- Run:  npm run db:init   (or just `npm run seed`, which builds it first)
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- users: students and administrators share one table, split by role
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  student_no    TEXT     NULL UNIQUE,
  full_name     TEXT     NOT NULL,
  email         TEXT     NOT NULL UNIQUE,
  phone         TEXT     NULL,
  program       TEXT     NULL,
  section       TEXT     NULL,
  avatar_path   TEXT     NULL,
  password_hash TEXT     NOT NULL,
  role          TEXT     NOT NULL DEFAULT 'student' CHECK (role IN ('student','admin')),
  is_active     INTEGER  NOT NULL DEFAULT 1,
  created_at    TEXT     NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ---------------------------------------------------------------------
-- categories: keeps search and matching consistent
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE
);

-- ---------------------------------------------------------------------
-- items: something a student FOUND and is turning in
--
-- status flow:
--   pending_dropoff -> student logged it, has not handed it to the office yet
--   in_custody      -> office physically received it, claimable
--   on_hold         -> a claim is under review, hidden from new claims
--   returned        -> released to the verified owner
--   disposed        -> claim window lapsed, removed from inventory
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_code         TEXT NOT NULL UNIQUE,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  category_id      INTEGER NULL,
  color            TEXT NULL,
  brand            TEXT NULL,
  found_location   TEXT NOT NULL,
  found_at         TEXT NOT NULL,
  photo_path       TEXT NULL,
  -- A detail the finder withholds from the public listing. The claimant must
  -- describe it correctly. This is what stops opportunistic claiming.
  secret_detail    TEXT NULL,
  finder_id        INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending_dropoff'
                   CHECK (status IN ('pending_dropoff','in_custody','on_hold','returned','disposed')),
  storage_location TEXT NULL,
  received_by      INTEGER NULL,
  received_at      TEXT NULL,
  released_at      TEXT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (finder_id)   REFERENCES users(id),
  FOREIGN KEY (received_by) REFERENCES users(id),
  FOREIGN KEY (category_id) REFERENCES categories(id)
);
CREATE INDEX IF NOT EXISTS idx_items_status   ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_found_at ON items(found_at);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category_id);

-- SQLite has no ON UPDATE CURRENT_TIMESTAMP, so keep updated_at honest.
CREATE TRIGGER IF NOT EXISTS trg_items_updated
AFTER UPDATE ON items
BEGIN
  UPDATE items SET updated_at = datetime('now','localtime') WHERE id = NEW.id;
END;

-- ---------------------------------------------------------------------
-- lost_reports: something a student LOST and is looking for
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lost_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_code      TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  category_id   INTEGER NULL,
  color         TEXT NULL,
  brand         TEXT NULL,
  lost_location TEXT NOT NULL,
  lost_at       TEXT NOT NULL,
  photo_path    TEXT NULL,
  student_id    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','closed')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (student_id)  REFERENCES users(id),
  FOREIGN KEY (category_id) REFERENCES categories(id)
);
CREATE INDEX IF NOT EXISTS idx_lost_status   ON lost_reports(status);
CREATE INDEX IF NOT EXISTS idx_lost_category ON lost_reports(category_id);

-- ---------------------------------------------------------------------
-- claims: a student asserting ownership of an item in custody
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claims (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_code      TEXT NOT NULL UNIQUE,
  item_id       INTEGER NOT NULL,
  claimant_id   INTEGER NOT NULL,
  statement     TEXT NOT NULL,   -- how and where they lost it
  detail_answer TEXT NOT NULL,   -- their answer to items.secret_detail
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  admin_note    TEXT NULL,
  reviewed_by   INTEGER NULL,
  reviewed_at   TEXT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (item_id, claimant_id),
  FOREIGN KEY (item_id)     REFERENCES items(id) ON DELETE CASCADE,
  FOREIGN KEY (claimant_id) REFERENCES users(id),
  FOREIGN KEY (reviewed_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);

-- ---------------------------------------------------------------------
-- claim_proofs: the photos/receipts a claimant uploads as evidence
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claim_proofs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id    INTEGER NOT NULL,
  file_path   TEXT NOT NULL,
  caption     TEXT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------
-- email_log: every notification, sent or simulated. Your audit trail.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient     TEXT NOT NULL,
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  template      TEXT NULL,
  status        TEXT NOT NULL CHECK (status IN ('sent','simulated','failed')),
  error_message TEXT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_email_created ON email_log(created_at);

-- ---------------------------------------------------------------------
-- activity_log: who did what, for the admin audit view
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NULL,
  entity_id   INTEGER NULL,
  detail      TEXT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (actor_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_log_created ON activity_log(created_at);

-- ---------------------------------------------------------------------
-- settings: key/value config (e.g. mail) editable from admin UI
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---------------------------------------------------------------------
-- sessions: keeps logins alive across restarts/redeploys
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  sess       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ---------------------------------------------------------------------
-- upload_files: uploaded images live in the database, not on the host's
-- filesystem, which most free hosts wipe on every deploy/restart
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS upload_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  filename   TEXT NULL,
  mime_type  TEXT NOT NULL,
  byte_size  INTEGER NOT NULL,
  data       BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------
INSERT INTO categories (name) VALUES
  ('Phones & tablets'), ('Laptops & chargers'), ('Wallets & IDs'),
  ('Bags & backpacks'), ('Keys'), ('Books & notebooks'), ('Clothing'),
  ('Eyewear'), ('Jewelry & watches'), ('Water bottles'), ('Umbrellas'), ('Other')
ON CONFLICT(name) DO NOTHING;

-- Accounts are created by the seed script so passwords are hashed properly:
--   npm run seed