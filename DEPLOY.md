# Deploying Campus Lost & Found

The app is a standard Node.js service: `npm ci --omit=dev` then `npm start`.
It needs **Node.js 20 or 22 LTS** and a place to keep two things between
deploys:

| Path | Why it must persist |
|---|---|
| `db/app.db` (+ `-wal`, `-shm`) | every account, item, claim and email log |
| `public/uploads/` | photos and claim proof images |

If the host gives you an **ephemeral filesystem**, mount a persistent disk and
point the app at it. Without that, data disappears on the next deploy.

---

## 1. Environment variables

Set these in the host's dashboard (or in `.env` on a VPS):

```ini
NODE_ENV=production
PORT=3000
SESSION_SECRET=<long random string>       # openssl rand -hex 32
BASE_URL=https://your-domain.example      # no trailing slash
COOKIE_SECURE=true                        # default in production; requires HTTPS

# Optional: point the database somewhere persistent
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

---

## 2. Typical hosts

### Render / Railway / Fly.io (managed)

1. Push the project to GitHub and create a **Web Service**.
2. Build command: `npm ci --omit=dev`
3. Start command: `npm start`
4. Add the environment variables from section 1.
5. Add a **persistent volume/disk** and mount it, then either:
   - set `DB_PATH=/var/data/app.db` (or wherever the volume is), **and**
   - make `public/uploads` live on the volume. The easiest option is to symlink
     it once in a start command:
     `ln -sfn /var/data/uploads public/uploads && npm start`
     or mount the volume directly at `public/uploads`.
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
nano .env            # SESSION_SECRET, NODE_ENV=production, BASE_URL, SMTP

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

## 3. First-run checklist

1. `GET /healthz` returns `{"ok":true,...}`.
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
6. Confirm photos still load after a redeploy (persistent uploads).
7. Back up `db/app.db` and `public/uploads/` regularly.

---

## 4. Database backups

SQLite is a single file. Back it up with the built-in backup command rather than
copying while the server is writing:

```bash
sqlite3 db/app.db ".backup '/backups/app-$(date +%F).db'"
```

Keep at least the last 7 daily copies plus `public/uploads/`.

---

## 5. What is already handled

- SQLite-backed sessions, so logins survive restarts and redeploys.
- `trust proxy` + `SameSite=Lax` + httpOnly cookies, secure cookies in production.
- Graceful shutdown on `SIGTERM`/`SIGINT` (closes SQLite cleanly).
- Health endpoint at `/healthz`.
- Mail failures never roll back a student action; they are logged in `email_log`.
- Admin-editable mail settings, with a test-send button.

Still recommended before a public launch: CSRF tokens, login rate limiting, and
server-side image re-encoding to remove EXIF metadata.
