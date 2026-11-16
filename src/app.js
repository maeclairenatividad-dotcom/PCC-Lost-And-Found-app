require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');

const helpers = require('./helpers');
const { verify, ensureSchema, close: closeDb, engine } = require('./db');
const { SessionStore } = require('./session-store');

const authRoutes = require('./routes/auth');
const studentRoutes = require('./routes/student');
const adminRoutes = require('./routes/admin');

const { isMailEnabled } = require('./mailer');

const app = express();

// Behind a reverse proxy / hosting load balancer, trust one hop so secure
// cookies and req.protocol work. Harmless for local development.
app.set('trust proxy', 1);

// ---- View engine -----------------------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// ---- Core middleware -------------------------------------------------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const secureCookies = String(process.env.COOKIE_SECURE).toLowerCase() === 'true'
  || (process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false');

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-secret',
  resave: false,
  saveUninitialized: false,
  store: new SessionStore({ ttlMs: 1000 * 60 * 60 * 8 }),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies,
    maxAge: 1000 * 60 * 60 * 8 // 8 hours
  }
}));
app.use(flash());

// Everything the layout needs, on every render.
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  res.locals.path = req.path;

  // Absolute URLs for the link preview tags (Open Graph / Twitter). Taken from
  // the request's own host, which Render/nginx pass through untouched, so a
  // stale BASE_URL can never break a shared link's preview.
  const siteUrl = `${req.protocol}://${req.get('host')}`;
  res.locals.siteUrl = siteUrl;
  res.locals.pageUrl = siteUrl + req.originalUrl.split('?')[0];

  Object.assign(res.locals, helpers);
  next();
});

// ---- Routes ----------------------------------------------------------
app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.redirect(req.session.user.role === 'admin' ? '/admin' : '/dashboard');
});

app.use('/', authRoutes);
app.use('/', studentRoutes);
app.use('/admin', adminRoutes);

// ---- Health check (for hosts / uptime monitors) ----------------------
app.get('/healthz', async (req, res) => {
  try {
    await verify();
    res.json({
      ok: true,
      engine,
      uptime: Math.round(process.uptime()),
      mail: await isMailEnabled()
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'database unavailable' });
  }
});

// ---- 404 -------------------------------------------------------------
app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Page not found',
    code: 404,
    message: 'That page does not exist. Check the address or head back to your dashboard.'
  });
});

// ---- Error handler ---------------------------------------------------
app.use((err, req, res, next) => {
  console.error(err);
  const isUpload = err.code === 'LIMIT_FILE_SIZE';
  res.status(isUpload ? 400 : 500).render('error', {
    title: 'Something broke',
    code: isUpload ? 400 : 500,
    message: isUpload
      ? 'That image is larger than 5 MB. Compress it and try again.'
      : (err.message || 'The server hit an unexpected problem. Try again.')
  });
});

// ---- Start -----------------------------------------------------------
const PORT = Number(process.env.PORT || 3000);

verify()
  .then(() => ensureSchema())
  .then(async () => {
    const mailOn = await isMailEnabled();
    const server = app.listen(PORT, () => {
      console.log(`\n  Lost & Found running at http://localhost:${PORT}`);
      console.log(`  Database:     ${engine}`);
      console.log(`  Email sending: ${mailOn ? 'ON (SMTP)' : 'OFF (logged to email_log)'}\n`);

      // A copy-pasted example value here means email links point nowhere.
      if (/your-app-name|your-domain|example\.com/i.test(String(process.env.BASE_URL || ''))) {
        console.warn('  ! BASE_URL still looks like an example value — links inside emails will be wrong.');
      }
    });

    // Close cleanly on Ctrl+C or a host's SIGTERM so writes are not left hanging.
    const shutdown = (signal) => {
      console.log(`\n  ${signal} received, shutting down…`);
      server.close(async () => {
        await closeDb();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 8000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })
  .catch((err) => {
    console.error('\n  Cannot open the database.');
    console.error(`  ${err.message}\n`);
    process.exit(1);
  });
