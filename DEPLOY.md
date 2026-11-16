# Deploying Campus Lost & Found

The app is a standard Node.js service: `npm ci --omit=dev` then `npm start`.
It needs **Node.js 20 or 22 LTS** and one of two database setups:

| Setup | What you need |
|---|---|
| **Neon Postgres** (recommended) | a `DATABASE_URL` — nothing to install, nothing to back up by hand |
| **SQLite** | a persistent disk for `db/app.db` (+ `-wal`, `-shm`) |

Both engines run the same code. The app picks Postgres when `DATABASE_URL`
starts with `postgres://` or `postgresql://`, and SQLite otherwise.

Uploaded photos (item pictures, claim proofs, avatars) are stored in the
`upload_files` table, so they survive redeploys even on hosts with an
ephemeral filesystem. No disk or object storage is needed for them.

---

## 1. Environment variables

Set these in the host's dashboard (or in `.env` on a VPS):

```ini
NODE_ENV=production
PORT=3000
SESSION_SECRET=<long random string>       # openssl rand -hex 32
BASE_URL=https://your-domain.example      # no trailing slash
COOKIE_SECURE=true                        # default in production; requires HTTPS

# ---- Database: pick one ----

# Neon / Postgres (recommended). Keep the ?sslmode=require that Neon gives you.
DATABASE_URL=postgresql://user:password@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require
# Wall-clock zone used for every timestamp the app writes. Default: Asia/Manila.
PG_TIMEZONE=Asia/Manila

# SQLite instead (leave DATABASE_URL unset):
# DB_PATH=/var/data/lost-and-found/app.db

# Email can also be set from Admin → Notifications after first login.
MAIL_ENABLED=false
MAIL_HOST=smtp.gmail.com
MAIL_PORT=587
MAIL_SECURE=false
MAIL_USER=your-account@gmail.com
MAIL_PASS=your-16-char-app-password
MAIL_FROM="Campus Lost & Found <your-account@gmail.com>"
ADMIN_ALERT_EMAIL=lostandfound@yourschool.edu.ph
```

Notes:

- `COOKIE_SECURE=true` means the browser only sends the session cookie over
  HTTPS. If you deliberately serve plain HTTP (LAN demo), set
  `COOKIE_SECURE=false` and `NODE_ENV=development`.
- `BASE_URL` is used in email links. Without it, links point at
  `http://localhost:PORT`.
- Mail settings entered in **Admin → Notifications** are stored in the
  database and override the corresponding `MAIL_*` env vars.
- Neon requires SSL. `db.js` turns SSL on automatically for any non-localhost
  host or when `PGSSL=true`, so the connection string works as pasted.
- **On Render's free tier, outbound SMTP to ports 25, 465 and 587 is blocked.**
  Use port **2525** (Brevo: `smtp-relay.brevo.com:2525`, SendGrid/Mailgun/Mailjet
  also accept it), tick nothing for SSL, or upgrade the instance. The
  **Provider quick setup** dropdown in Admin → Notifications fills the host,
  port and SSL flag for you.

---

## 2. Database on Neon

1. Sign up at [neon.tech](https://neon.tech) and create a project. The free tier
   is enough for a capstone.
2. In **Connect**, copy the connection string. It looks like
   `postgresql://user:password@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require`.
   Keep the `?sslmode=require` part.
3. Put it in the host's environment as `DATABASE_URL` (locally, in `.env`).
4. Start the app. On first boot it creates every table and index it needs,
   because the schema files use `IF NOT EXISTS`.
5. Create the first staff account:
   `npm run admin:create` (see section 4).

Notes:

- **`npm run db:init` is destructive.** It drops every table and rebuilds the
  schema. Use it for a fresh development database, never on live data.
- **`npm run seed` loads demo accounts and sample records and truncates
  everything first.** Never run it on a real deployment.
- Neon's server runs in UTC. `PG_TIMEZONE` (default `Asia/Manila`) makes the app
  write timestamps in school-local time, so "3 hours ago" and date filters stay
  correct.
- Neon suspends idle databases and wakes them on the next connection. The first
  request after a quiet spell can take a second or two; that is normal.
- Backups: Neon keeps point-in-time history on its own, so you do not need the
  SQLite file-copy routine in section 6. Do still back up uploads.

---

## 3. Typical hosts

### Render / Railway / Fly.io (managed)

1. Push the project to GitHub and create a **Web Service**.
2. Build command: `npm ci --omit=dev`
3. Start command: `npm start`
4. Add the environment variables from section 1 (with a Neon `DATABASE_URL`).
5. No persistent disk is needed: photos live in the database and sessions too.
   (Only a SQLite deployment needs a disk, for `db/app.db`.)
6. Set the health check path to **`/healthz`**.
7. Open the app, sign in as staff, then configure email under
   **Notifications** and press **Send test email**.

### VPS / school server (Ubuntu + Nginx)

```bash
# 1. Install Node 22 LTS, then:
git clone <your repo> /var/www/lost-and-found
cd /var/www/lost-and-found
npm ci --omit=dev

# 2. Configure
cp .env.example .env
nano .env            # SESSION_SECRET, NODE_ENV=production, BASE_URL, DATABASE_URL or DB_PATH, SMTP

# 3. Run under PM2 so it restarts on reboot/crash
sudo npm i -g pm2
pm2 start src/app.js --name lost-and-found
pm2 save
pm2 startup          # follow the printed command
```

Nginx reverse proxy (HTTPS via Certbot):

```nginx
server {
  server_name lostandfound.yourschool.edu;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

```bash
sudo certbot --nginx -d lostandfound.yourschool.edu
```

The app already trusts one proxy hop and uses secure cookies in production, so
`https://` works without extra code.

---

## 4. First-run checklist

1. `GET /healthz` returns `{"ok":true,"engine":"postgres",...}` (or `"sqlite"`).
2. Create the first staff account (do **not** run `npm run seed` on a real
   deployment — it loads demo data):

   ```bash
   # interactive
   npm run admin:create

   # or non-interactive (Linux/macOS)
   ADMIN_EMAIL=you@school.edu ADMIN_NAME="Property office" \
   ADMIN_PASSWORD='a-long-password' npm run admin:create

   # Windows PowerShell equivalent
   $env:ADMIN_EMAIL='you@school.edu'
   $env:ADMIN_NAME='Property office'
   $env:ADMIN_PASSWORD='a-long-password'
   npm run admin:create
   ```

   Re-running the same command with an existing email resets that account's
   password.
3. Sign in as staff at `/admin/login`.
4. Open **Notifications** → fill in SMTP → enable sending → **Send test email**.
   The delivery log below shows `sent` or `failed` with the SMTP error.
5. Register a test student, log a found item, receive it, and file a claim.
6. Restart the service and confirm the session still works and photos still
   load (database-backed sessions, persistent uploads).

---

## 5. Upgrading an existing SQLite demo to Neon

There is no automatic data migration — the demo data can be recreated with
`npm run seed`, so the usual path is:

1. Create the Neon database and set `DATABASE_URL`.
2. Start the app once to create the schema (or run `npm run db:init` for a
   throwaway dev database).
3. `npm run admin:create` for the real staff account, then add real records
   through the UI.

If you need the old rows, use `pgloader` or export from `sqlite3` and import into
Postgres; the column names and types line up, but ids must be preserved in
dependency order (`users` → `categories` → `items`/`lost_reports` → `claims` →
`claim_proofs`).

---

## 6. Database backups (SQLite only)

SQLite is a single file. Back it up with the built-in backup command rather than
copying while the server is writing:

```bash
sqlite3 db/app.db ".backup '/backups/app-$(date +%F).db'"
```

Keep at least the last 7 daily copies plus `public/uploads/`. On Neon, use the
project's point-in-time restore instead.

---

## 7. What is already handled

- One codebase, two engines — SQLite locally, Postgres on Neon.
- Schema created automatically on first boot, on either engine.
- Database-backed sessions, so logins survive restarts and redeploys.
- `trust proxy` + `SameSite=Lax` + httpOnly cookies, secure cookies in production.
- Graceful shutdown on `SIGTERM`/`SIGINT` (closes SQLite / drains the pg pool).
- Health endpoint at `/healthz`, reporting the active engine.
- Mail failures never roll back a student action; they are logged in `email_log`.
- Admin-editable mail settings, with a test-send button.

Still recommended before a public launch: CSRF tokens, login rate limiting, and
server-side image re-encoding to remove EXIF metadata.
