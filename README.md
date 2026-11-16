# Campus Lost & Found Management System

A web-based lost and found system for a school property office, with separate
interfaces for students and administrators.

Node.js + Express, server-rendered with EJS. No build step. Two database engines
are supported from the same code:

- **SQLite** (default) — a single `db/app.db` file, nothing to install. Best for
  local demos and offline use.
- **Postgres** — set `DATABASE_URL` and the same app runs on Neon, Supabase,
  Railway, RDS or a local Postgres server. Recommended for deployment.

---

## What it does

**Students**
- Log an item they found, with a photo, where and when they found it
- Record one hidden identifying detail that never appears in the public listing
- Search and browse everything currently held at the office
- Report something they lost, and get emailed when a similar item is handed in
- File a claim with up to five proof images, and track its status

**Administrators**
- Confirm a physical item has arrived at the counter and record its shelf location
- Review claims side by side: the finder's hidden detail against the claimant's answer,
  plus all proof images and the claimant's verified student number
- Approve a claim (releases the item, auto-rejects rival claims) or reject it with a reason
- Manage inventory, lost reports, accounts, and flag items past the claim window
- Read the full log of every notification the system produced

**Email** runs on free SMTP — a Gmail App Password or Brevo's free tier. While it is
switched off, every message is still written to `email_log` and printed to the console,
so the whole flow is demonstrable without credentials.

---

## How an item moves through the system

```
Student logs a found item
        │
        ▼
  Awaiting drop-off ──────► student brings it to the office
        │
        ▼  admin confirms receipt + records shelf location
   At the office  ◄──────────────────────┐   (claim rejected)
        │                                │
        ▼  student files a claim + proof │
  Claim under review ───────────────────┘
        │
        ▼  admin approves
  Returned to owner
```

An item held longer than `CLAIM_WINDOW_DAYS` is flagged on the admin dashboard for disposal.

---

## Setup

Requires **Node.js 20 or 22 LTS** (even-numbered LTS releases have prebuilt
`better-sqlite3` binaries, so nothing compiles on install).

### Local demo (SQLite, zero setup)

```bash
# 1. Install dependencies
npm install

# 2. Configure
cp .env.example .env
#    SESSION_SECRET is the only thing you really need to change in development
#    Leave DATABASE_URL commented out to use SQLite.

# 3. Build the database and load demo accounts/sample records
npm run db:init   # creates the tables (drops anything existing — dev only)
npm run seed      # demo accounts + sample records

# 4. Run it
npm start          # or: npm run dev  (auto-restart via nodemon)
```

The SQLite file is `db/app.db`. `npm run seed` also builds the schema on its own
if you skip `db:init`, so the shortest path to a working demo is just
`npm install && npm run seed && npm start`.

### Using Postgres (Neon)

Postgres is selected automatically when `DATABASE_URL` starts with `postgres://`
or `postgresql://`. Nothing else in the app changes.

1. Create a free database at [neon.tech](https://neon.tech) and copy the
   connection string from the dashboard (it includes `?sslmode=require`).
2. Put it in `.env`:

   ```ini
   DATABASE_URL=postgresql://user:password@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require
   PG_TIMEZONE=Asia/Manila
   ```

3. Create the tables and, for a demo, the sample data:

   ```bash
   npm run db:init   # DESTRUCTIVE: drops and rebuilds every table
   npm run seed      # demo accounts + records — skip this on a real deployment
   npm start
   ```

   On a real deployment you can skip `db:init` entirely: the app creates the
   schema automatically on first boot. Then make the first staff account with
   `npm run admin:create`.

`PG_TIMEZONE` (default `Asia/Manila`) decides what "now" means when the app
writes timestamps, so dates look right even though Neon's server runs in UTC.
Sessions live in the database, so logins survive restarts and redeploys on both
engines.

Open http://localhost:3000 — it shows a sign-in landing page with a separate
portal for each role:

- Students: `/student/login` (also `/register` to create an account)
- Administrators: `/admin/login`

Demo accounts (password `Password123` for all):

| Role | Email |
|---|---|
| Admin | `admin@school.edu` |
| Student | `ana.reyes@student.school.edu` |
| Student | `joy.tabuena@student.school.edu` — has a claim waiting for review |

---

## Turning on real email

There are two ways to configure it — both work:

**Option A — admin UI (no file editing):** sign in as staff, open
**Notifications**, fill in the SMTP host/port/credentials, tick **Enable sending**,
save, then use **Send a test email**. Settings are stored in the database and
override `.env`.

**Option B — `.env`:**

```ini
MAIL_ENABLED=true
MAIL_HOST=smtp.gmail.com
MAIL_PORT=587
MAIL_SECURE=false
MAIL_USER=youraccount@gmail.com
MAIL_PASS=your16charapppassword
MAIL_FROM="Campus Lost & Found <youraccount@gmail.com>"
ADMIN_ALERT_EMAIL=where-claim-alerts-go@example.com
BASE_URL=https://your-deployed-domain
```

Gmail is free for a capstone: turn on 2-Step Verification, then create a
**16-character App Password** (Google Account → Security → App passwords). Gmail
caps free sending at roughly 500 messages a day. Brevo/Mailjet/SendGrid work the
same way with their own host and credentials.

**Hosting gotcha:** Render's free web services block outbound SMTP on ports
**25, 465 and 587** (since Sept 2025), so Gmail simply times out there. Use a
provider that accepts **port 2525** — Brevo's `smtp-relay.brevo.com:2525` is the
easiest free option — or upgrade the instance. The **Provider quick setup**
dropdown on the Notifications page fills these values in for you.

Sending never blocks a user action: if SMTP fails, the failure is recorded in
`email_log` with the error and the student's claim still goes through.

---

## Notifications the system sends

| Trigger | Goes to |
|---|---|
| Account created | The new student |
| Found item logged | The finder, with drop-off instructions |
| Office confirms receipt | The finder |
| New found item matches an open lost report | Every student with a matching report |
| Claim filed | The claimant (confirmation) and the office (alert) |
| Claim approved | The claimant, with collection instructions |
| Claim rejected | The claimant, with the reason staff wrote |
| Item returned | The student who originally found it |

---

## Project layout

```
db/
  schema.sql        tables, indexes, categories (SQLite)
  schema.postgres.sql  the same schema for Postgres (Neon, Supabase, RDS…)
  init.js           rebuilds the schema (destructive — dev only)
  seed.js           demo accounts and sample records
  create-admin.js   creates the first staff account (no demo data)
src/
  app.js            express setup, sessions, health check, error handling
  db.js             database layer: SQLite or Postgres, chosen by DATABASE_URL
  session-store.js  database-backed session store (logins survive restarts)
  mailer.js         nodemailer transport and all email templates
  matching.js       cross-references found items against lost reports
  helpers.js        date and status formatting shared with the views
  middleware/
    auth.js         requireLogin / requireStudent / requireAdmin
    upload.js       multer: images only, 5 MB, 5 files max
  routes/
    auth.js         sign in, register, profile, password
    student.js      browse, report found, report lost, claim, track
    admin.js        receive, review, decide, inventory, accounts, logs
views/              EJS templates
public/
  css/app.css       the whole design system
  uploads/          user-uploaded photos (gitignored)
```

---

## Design decisions worth defending in a panel

**The hidden identifying detail.** Photos alone are weak proof — anyone browsing the
listing can see the item and describe it. The finder records one detail that is never
published, and the claimant has to produce it blind. This is the single strongest
anti-fraud mechanism in the system and it costs nothing to run.

**Items are not claimable until staff physically have them.** A student logging a find
does not make the item available; the admin confirming receipt does. This keeps the
database and the shelf in agreement.

**Claiming puts the item on hold.** Only one claim can be under review at a time, so
two students cannot both be told to come collect the same wallet.

**Approving one claim rejects the rest,** with an explanation emailed automatically,
so nobody is left waiting indefinitely.

**Finders cannot claim their own entries** — an obvious fraud path, closed in code.

**Nothing is hard-deleted.** Disposal is a status change, and `activity_log` keeps the
audit trail intact for the whole record.

---

## Deployment

See **[DEPLOY.md](DEPLOY.md)** for a step-by-step guide (Neon/Render/Railway/VPS),
environment variables, uploads storage, SMTP, backups and a go-live checklist.
The short version for a Neon-backed deploy:

```bash
npm ci --omit=dev
cp .env.example .env    # DATABASE_URL, SESSION_SECRET, NODE_ENV=production, BASE_URL
npm run admin:create    # first staff account (no demo data)
npm start               # schema is created on boot; health check: GET /healthz
```

On SQLite instead, the steps are the same but you keep `DATABASE_URL` unset and
mount a persistent disk for `db/` (needed on hosts with an ephemeral filesystem).

---

## Security notes

Done: bcrypt password hashing (cost 10), httpOnly + SameSite session cookies,
secure cookies in production, a database-backed session store (logins survive
restarts), parameterised queries everywhere, image-only uploads with a size cap
and randomised filenames, role checks on every route, identical error text for
wrong email and wrong password, trust-proxy support for HTTPS hosts.

Before opening it to the public internet you should still add: CSRF tokens on
state-changing forms, rate limiting on the login route, and server-side image
re-encoding to strip EXIF location data from uploaded photos.
