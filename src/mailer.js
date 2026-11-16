/**
 * Email notifications.
 *
 * Costs nothing: point MAIL_* at a Gmail account with an App Password, or at
 * Brevo/Mailjet's free tier. While sending is off every message is written to
 * email_log and printed to the console instead, so the whole notification flow
 * is demonstrable without SMTP credentials.
 *
 * Config is read from env vars, but can be overridden from Admin → Notifications
 * (stored in the `settings` table) so it can be configured on deploy without
 * editing files.
 */
const nodemailer = require('nodemailer');
const { run, q } = require('./db');

const MAIL_KEYS = [
  'mail_enabled', 'mail_host', 'mail_port', 'mail_secure',
  'mail_user', 'mail_pass', 'mail_from', 'admin_alert_email', 'base_url',
  // Wording of the "come and collect it" email sent when a claim is approved.
  'pickup_location', 'pickup_hours'
];

function envDefaults() {
  return {
    mail_enabled: String(process.env.MAIL_ENABLED || 'false'),
    mail_host: process.env.MAIL_HOST || '',
    mail_port: String(process.env.MAIL_PORT || '587'),
    mail_secure: String(process.env.MAIL_SECURE || 'false'),
    mail_user: process.env.MAIL_USER || '',
    mail_pass: process.env.MAIL_PASS || '',
    mail_from: process.env.MAIL_FROM || '',
    admin_alert_email: process.env.ADMIN_ALERT_EMAIL || '',
    base_url: process.env.BASE_URL || '',
    pickup_location: process.env.PICKUP_LOCATION || '',
    pickup_hours: process.env.PICKUP_HOURS || ''
  };
}

let _settingsCache = null;
let _settingsCacheAt = 0;

async function readSettings() {
  const now = Date.now();
  if (_settingsCache && now - _settingsCacheAt < 3000) return _settingsCache;
  try {
    const rows = await q("SELECT key, value FROM settings WHERE key LIKE 'mail_%' OR key LIKE 'pickup_%' OR key IN ('admin_alert_email','base_url')");
    const map = {};
    rows.forEach((r) => { map[r.key] = r.value; });
    _settingsCache = map;
    _settingsCacheAt = now;
  } catch (err) {
    _settingsCache = _settingsCache || {};
  }
  return _settingsCache;
}

async function getMailConfig() {
  const defaults = envDefaults();
  const saved = await readSettings();
  const cfg = { ...defaults };
  for (const k of MAIL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(saved, k) && saved[k] !== '') cfg[k] = saved[k];
  }
  cfg.mail_enabled_bool = String(cfg.mail_enabled).toLowerCase() === 'true';
  cfg.mail_secure_bool = String(cfg.mail_secure).toLowerCase() === 'true';
  return cfg;
}

async function isMailEnabled() {
  return (await getMailConfig()).mail_enabled_bool;
}

async function saveMailConfig(input) {
  const allowed = new Set(MAIL_KEYS);
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) continue;
    const v = value == null ? '' : String(value);
    await run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, v]
    );
  }
  _settingsCache = null;
  _settingsCacheAt = 0;
}

function buildTransporter(cfg) {
  return nodemailer.createTransport({
    host: cfg.mail_host,
    port: Number(cfg.mail_port || 587),
    secure: cfg.mail_secure_bool,
    auth: cfg.mail_user ? { user: cfg.mail_user, pass: cfg.mail_pass } : undefined
  });
}

function wrap(heading, bodyHtml) {
  return `<div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;
    color:#1b2024;line-height:1.55">
    <div style="background:#0E5C5C;color:#fff;padding:18px 22px">
      <div style="font-size:17px;font-weight:700;letter-spacing:-0.01em">Campus Lost &amp; Found</div>
    </div>
    <div style="border:1px solid #dfe3e0;border-top:none;padding:24px 22px">
      <h2 style="margin:0 0 14px;font-size:19px">${heading}</h2>
      ${bodyHtml}
      <p style="margin-top:26px;font-size:13px;color:#6a7278">
        This is an automated message from the Student Affairs property office.
        Do not reply to this address.
      </p>
    </div>
  </div>`;
}

/**
 * Every notification the system can send. Each returns { subject, html }.
 * Templates receive (data, baseUrl) so links work in deployed environments.
 */
const templates = {
  welcome: (d, base) => ({
    subject: 'Your Lost & Found account is ready',
    html: wrap(`Welcome, ${d.name}`, `
      <p>You can now report items you have lost, log items you have found,
      and file claims on items held at the property office.</p>
      <p><a href="${base}/student/login" style="background:#0E5C5C;color:#fff;
      padding:10px 18px;text-decoration:none;display:inline-block">Sign in</a></p>`)
  }),

  foundLogged: (d) => ({
    subject: `Found item logged — ${d.refCode}`,
    html: wrap('Thanks for turning this in', `
      <p>You logged <strong>${d.title}</strong> as found at ${d.location}.</p>
      <p><strong>Bring the item to the property office</strong> (Student Affairs,
      ground floor) and give this reference number: <strong>${d.refCode}</strong>.
      It becomes searchable by other students once staff receive it.</p>`)
  }),

  itemReceived: (d) => ({
    subject: `${d.refCode} received at the office`,
    html: wrap('Item received', `
      <p><strong>${d.title}</strong> is now in custody at the property office
      (${d.storage}). It is listed publicly so the owner can find it.</p>
      <p>Thank you for handing it in.</p>`)
  }),

  claimFiled: (d, base) => ({
    subject: `Claim filed — ${d.claimRef}`,
    html: wrap('Your claim is under review', `
      <p>You filed a claim on <strong>${d.title}</strong> (${d.itemRef}).</p>
      <p>Staff will compare your proof against the item and email you a decision.
      Do not go to the office until your claim is approved.</p>
      <p><a href="${base}/claims">Track this claim</a></p>`)
  }),

  claimAlertAdmin: (d, base) => ({
    subject: `New claim to review — ${d.claimRef}`,
    html: wrap('A claim needs review', `
      <p>${d.claimant} filed claim <strong>${d.claimRef}</strong> on
      <strong>${d.title}</strong> (${d.itemRef}) with ${d.proofCount} proof file(s).</p>
      <p><a href="${base}/admin/claims/${d.claimId}">Open the claim</a></p>`)
  }),

  /**
   * Sent the moment staff approve a claim. This is the "your item is ready to
   * claim at the drop-off" message: where to go, when it is open, what to bring
   * and which reference to quote. Location and hours are editable from
   * Admin → Notifications so the office can change them without a redeploy.
   */
  claimApproved: (d) => {
    const where = d.location || 'Property Office drop-off counter, Student Affairs (ground floor)';
    const when = d.hours || 'Monday to Friday, 8:00 AM – 5:00 PM';

    const contact = d.officeEmail
      ? `<p style="font-size:13px;color:#6a7278">Can't make it during these hours?
         Email <a href="mailto:${d.officeEmail}">${d.officeEmail}</a> to arrange another time.</p>`
      : '';

    return {
      subject: `Ready to claim — ${d.itemRef}`,
      html: wrap('Your item is ready to claim', `
        <p>Good news: your claim on <strong>${d.title}</strong> was approved, and the
        item is now held for you at the drop-off.</p>

        <table role="presentation" style="border-collapse:collapse;margin:16px 0">
          <tr>
            <td style="padding:4px 12px 4px 0;font-weight:700;vertical-align:top">Where</td>
            <td style="padding:4px 0">${where}</td>
          </tr>
          <tr>
            <td style="padding:4px 12px 4px 0;font-weight:700;vertical-align:top">When</td>
            <td style="padding:4px 0">${when}</td>
          </tr>
          <tr>
            <td style="padding:4px 12px 4px 0;font-weight:700;vertical-align:top">Bring</td>
            <td style="padding:4px 0">Your <strong>student ID</strong>, and quote
              <strong>${d.itemRef}</strong></td>
          </tr>
        </table>

        <p>Staff will check your ID against the claim before releasing the item, so
        please collect it yourself. Claim reference: <strong>${d.claimRef}</strong>.</p>

        ${d.note ? `<p><em>Note from staff:</em> ${d.note}</p>` : ''}
        <p>If someone else tries to collect it on your behalf, message the office first.</p>
        ${contact}`)
    };
  },

  claimRejected: (d) => ({
    subject: `Claim not approved — ${d.claimRef}`,
    html: wrap('Your claim was not approved', `
      <p>Staff reviewed your claim on <strong>${d.title}</strong> and could not
      confirm ownership.</p>
      ${d.note ? `<p><em>Reason given:</em> ${d.note}</p>` : ''}
      <p>If you have stronger proof — a receipt, an older photo showing you with
      the item, or a serial number — visit the office in person.</p>`)
  }),

  possibleMatch: (d, base) => ({
    subject: `Possible match for your lost ${d.lostTitle}`,
    html: wrap('Something similar was turned in', `
      <p>A found item matches your report <strong>${d.lostRef}</strong>:</p>
      <p><strong>${d.title}</strong> — found at ${d.location} on ${d.foundDate}.</p>
      <p><a href="${base}/items/${d.itemId}">Check it and file a claim</a></p>
      <p>This is an automatic keyword match, so it may not be yours.</p>`)
  }),

  itemReturned: (d) => ({
    subject: `${d.itemRef} was returned to its owner`,
    html: wrap('Good news', `
      <p>The <strong>${d.title}</strong> you turned in was claimed and returned
      to its verified owner. Thanks for doing the right thing.</p>`)
  }),

  test: (d) => ({
    subject: 'Campus Lost & Found — test notification',
    html: wrap('Email sending is working', `
      <p>This is a test message sent from the admin notifications settings.</p>
      <p>If you can read this, SMTP is configured correctly.</p>`)
  })
};

/**
 * Send (or simulate) one notification and record it in email_log.
 * Never throws: a mail failure must not roll back the user's action.
 */
async function notify(to, templateName, data = {}) {
  const build = templates[templateName];
  if (!build) {
    console.error(`[mail] unknown template: ${templateName}`);
    return;
  }
  if (!to) return;

  const cfg = await getMailConfig();
  const base = (cfg.base_url || '').replace(/\/$/, '') || `http://localhost:${process.env.PORT || 3000}`;
  const { subject, html } = build(data, base);
  const from = cfg.mail_from || cfg.mail_user || 'no-reply@example.com';

  if (!cfg.mail_enabled_bool) {
    console.log(`\n[mail:simulated] to=${to}\n  subject=${subject}\n`);
    await run(
      `INSERT INTO email_log (recipient, subject, body, template, status)
       VALUES (?, ?, ?, ?, 'simulated')`,
      [to, subject, html, templateName]
    ).catch(() => {});
    return;
  }

  try {
    const transporter = buildTransporter(cfg);
    await transporter.sendMail({ from, to, subject, html });
    await run(
      `INSERT INTO email_log (recipient, subject, body, template, status)
       VALUES (?, ?, ?, ?, 'sent')`,
      [to, subject, html, templateName]
    );
  } catch (err) {
    console.error('[mail:failed]', err.message);
    await run(
      `INSERT INTO email_log (recipient, subject, body, template, status, error_message)
       VALUES (?, ?, ?, ?, 'failed', ?)`,
      [to, subject, html, templateName, err.message]
    ).catch(() => {});
  }
}

/** Send a test email to `to`. Returns { ok, error } and always logs outcome. */
async function sendTestEmail(to) {
  if (!to) return { ok: false, error: 'No recipient email provided.' };
  const cfg = await getMailConfig();
  const base = (cfg.base_url || '').replace(/\/$/, '') || `http://localhost:${process.env.PORT || 3000}`;
  const { subject, html } = templates.test({}, base);
  const from = cfg.mail_from || cfg.mail_user || 'no-reply@example.com';

  if (!cfg.mail_enabled_bool) {
    await run(
      `INSERT INTO email_log (recipient, subject, body, template, status)
       VALUES (?, ?, ?, ?, 'simulated')`,
      [to, subject, html, 'test']
    ).catch(() => {});
    return { ok: false, error: 'Sending is off (simulated). Turn on "Enable sending" and save your SMTP settings first.' };
  }

  try {
    const transporter = buildTransporter(cfg);
    await transporter.sendMail({ from, to, subject, html });
    await run(
      `INSERT INTO email_log (recipient, subject, body, template, status)
       VALUES (?, ?, ?, ?, 'sent')`,
      [to, subject, html, 'test']
    );
    return { ok: true };
  } catch (err) {
    await run(
      `INSERT INTO email_log (recipient, subject, body, template, status, error_message)
       VALUES (?, ?, ?, ?, 'failed', ?)`,
      [to, subject, html, 'test', err.message]
    ).catch(() => {});
    return { ok: false, error: err.message };
  }
}

module.exports = { notify, templates, isMailEnabled, getMailConfig, saveMailConfig, sendTestEmail };
