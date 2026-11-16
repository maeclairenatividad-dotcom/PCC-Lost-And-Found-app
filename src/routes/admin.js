const express = require('express');
const bcrypt = require('bcryptjs');
const { q, one, run, logActivity } = require('../db');
const {
  notify, isMailEnabled, getMailConfig, saveMailConfig, sendTestEmail
} = require('../mailer');
const { alertPossibleOwners, resolveLostReports, reconcileLostReports } = require('../matching');
const { wallDate, wallNow } = require('../helpers');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

// Badge count on the Claims nav item, on every admin page.
router.use(async (req, res, next) => {
  try {
    const row = await one("SELECT COUNT(*) AS n FROM claims WHERE status='pending'");
    res.locals.navPending = row.n;
  } catch (err) {
    res.locals.navPending = 0;
  }
  next();
});

const categories = () => q('SELECT * FROM categories ORDER BY name');

// =====================================================================
// Overview
// =====================================================================
router.get('/', async (req, res, next) => {
  try {
    const [stats] = await q(`
      SELECT
        (SELECT COUNT(*) FROM items WHERE status='pending_dropoff') AS awaiting,
        (SELECT COUNT(*) FROM items WHERE status='in_custody')      AS "inCustody",
        (SELECT COUNT(*) FROM claims WHERE status='pending')        AS "pendingClaims",
        (SELECT COUNT(*) FROM items WHERE status='returned')        AS returned,
        (SELECT COUNT(*) FROM lost_reports WHERE status='open')     AS "openLost",
        (SELECT COUNT(*) FROM users WHERE role='student')           AS students`);

    const queue = await q(`
      SELECT cl.*, i.title, i.ref_code AS item_ref, u.full_name AS claimant,
             (SELECT COUNT(*) FROM claim_proofs p WHERE p.claim_id = cl.id) AS proof_count
      FROM claims cl
      JOIN items i ON i.id = cl.item_id
      JOIN users u ON u.id = cl.claimant_id
      WHERE cl.status = 'pending'
      ORDER BY cl.created_at ASC LIMIT 8`);

    const dropoffs = await q(`
      SELECT i.*, u.full_name AS finder
      FROM items i JOIN users u ON u.id = i.finder_id
      WHERE i.status = 'pending_dropoff'
      ORDER BY i.created_at ASC LIMIT 8`);

    // Items past the claim window, ready to be cleared out.
    const windowDays = Number(process.env.CLAIM_WINDOW_DAYS || 90);
    const stale = await q(`
      SELECT i.*, CAST(julianday('now','localtime') - julianday(i.received_at) AS INTEGER) AS days_held
      FROM items i
      WHERE i.status = 'in_custody' AND i.received_at < datetime('now','localtime', ?)
      ORDER BY i.received_at ASC LIMIT 10`, [`-${windowDays} days`]);

    const activity = await q(`
      SELECT a.*, u.full_name AS actor
      FROM activity_log a LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC LIMIT 12`);

    // Returns per month, last 6 months, for the dashboard bar strip. Built in
    // JS so the query stays portable between SQLite and Postgres. Every month
    // is emitted even when it has zero returns, otherwise sparse data renders
    // as one lopsided bar instead of a six-month strip.
    const trendRows = await q(`
      SELECT released_at
      FROM items
      WHERE status='returned' AND released_at >= datetime('now','localtime','-6 months')
      ORDER BY released_at`);
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const now = wallNow();
    const trend = [];
    const byMonth = new Map();
    for (let back = 5; back >= 0; back--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
      const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const bucket = { ym, month: d.getUTCMonth() + 1, n: 0, label: MONTHS[d.getUTCMonth()] };
      trend.push(bucket);
      byMonth.set(ym, bucket);
    }
    for (const row of trendRows) {
      const d = wallDate(row.released_at);
      if (!d) continue;
      const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const bucket = byMonth.get(ym);
      if (bucket) bucket.n++;
    }

    res.render('admin/dashboard', {
      title: 'Property office', stats, queue, dropoffs, stale, activity, trend, windowDays
    });
  } catch (err) { next(err); }
});

// =====================================================================
// Inventory
// =====================================================================
router.get('/items', async (req, res, next) => {
  try {
    const status = req.query.status || 'all';
    const search = String(req.query.search || '').trim();

    const where = [];
    const params = [];
    if (status !== 'all') { where.push('i.status = ?'); params.push(status); }
    if (search) {
      where.push('(i.title LIKE ? OR i.ref_code LIKE ? OR i.found_location LIKE ? OR i.brand LIKE ?)');
      for (let n = 0; n < 4; n++) params.push(`%${search}%`);
    }

    const items = await q(`
      SELECT i.*, c.name AS category, u.full_name AS finder,
             (SELECT COUNT(*) FROM claims cl WHERE cl.item_id=i.id AND cl.status='pending') AS pending_claims
      FROM items i
      LEFT JOIN categories c ON c.id = i.category_id
      JOIN users u ON u.id = i.finder_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY i.created_at DESC LIMIT 300`, params);

    res.render('admin/items', {
      title: 'Inventory', items, filters: { status, search }
    });
  } catch (err) { next(err); }
});

router.get('/items/:id', async (req, res, next) => {
  try {
    const item = await one(`
      SELECT i.*, c.name AS category,
             f.full_name AS finder, f.email AS finder_email, f.student_no AS finder_no,
             r.full_name AS receiver
      FROM items i
      LEFT JOIN categories c ON c.id = i.category_id
      JOIN users f ON f.id = i.finder_id
      LEFT JOIN users r ON r.id = i.received_by
      WHERE i.id = ?`, [req.params.id]);

    if (!item) return res.redirect('/admin/items');

    const claims = await q(`
      SELECT cl.*, u.full_name AS claimant, u.student_no, u.email,
             (SELECT COUNT(*) FROM claim_proofs p WHERE p.claim_id=cl.id) AS proof_count
      FROM claims cl JOIN users u ON u.id = cl.claimant_id
      WHERE cl.item_id = ? ORDER BY cl.created_at DESC`, [item.id]);

    res.render('admin/item', {
      title: item.ref_code, item, claims, categories: await categories()
    });
  } catch (err) { next(err); }
});

/** Confirm the physical item has arrived at the office. */
router.post('/items/:id/receive', async (req, res, next) => {
  try {
    const item = await one('SELECT * FROM items WHERE id = ?', [req.params.id]);
    if (!item || item.status !== 'pending_dropoff') {
      req.flash('error', 'That item is not awaiting drop-off.');
      return res.redirect('/admin/items');
    }
    const shelf = String(req.body.storageLocation || '').trim();
    if (!shelf) {
      req.flash('error', 'Record where the item is stored, e.g. "Shelf B, bin 4".');
      return res.redirect(`/admin/items/${item.id}`);
    }

    await run(`
      UPDATE items
      SET status='in_custody', storage_location=?, received_by=?, received_at=datetime('now','localtime')
      WHERE id = ?`, [shelf, req.session.user.id, item.id]);

    await logActivity(req.session.user.id, 'item_received', 'item', item.id, item.ref_code);

    const finder = await one('SELECT email FROM users WHERE id = ?', [item.finder_id]);
    await notify(finder && finder.email, 'itemReceived', {
      refCode: item.ref_code, title: item.title, storage: shelf
    });

    const alerted = await alertPossibleOwners({ ...item, received_at: new Date() });

    req.flash('success', alerted
      ? `${item.ref_code} is now listed. ${alerted} student(s) with matching lost reports were emailed.`
      : `${item.ref_code} is now listed at the office.`);
    res.redirect(`/admin/items/${item.id}`);
  } catch (err) { next(err); }
});

router.post('/items/:id/update', async (req, res, next) => {
  try {
    const { title, description, categoryId, color, brand, storageLocation } = req.body;
    await run(`
      UPDATE items SET title=?, description=?, category_id=?, color=?, brand=?, storage_location=?
      WHERE id = ?`,
      [String(title).trim(), String(description).trim(), categoryId || null,
       color || null, brand || null, storageLocation || null, req.params.id]);
    await logActivity(req.session.user.id, 'item_edited', 'item', req.params.id, null);
    req.flash('success', 'Item record updated.');
    res.redirect(`/admin/items/${req.params.id}`);
  } catch (err) { next(err); }
});

/** Clear an item out after the claim window lapses. */
router.post('/items/:id/dispose', async (req, res, next) => {
  try {
    const item = await one('SELECT * FROM items WHERE id = ?', [req.params.id]);
    if (!item) return res.redirect('/admin/items');

    await run("UPDATE items SET status='disposed' WHERE id = ?", [item.id]);
    await run("UPDATE claims SET status='cancelled' WHERE item_id = ? AND status='pending'", [item.id]);
    await logActivity(req.session.user.id, 'item_disposed', 'item', item.id,
      String(req.body.reason || '').slice(0, 200));
    req.flash('success', `${item.ref_code} removed from inventory.`);
    res.redirect('/admin/items');
  } catch (err) { next(err); }
});

// =====================================================================
// Claims review
// =====================================================================
router.get('/claims', async (req, res, next) => {
  try {
    const status = req.query.status || 'pending';
    const where = status === 'all' ? '' : 'WHERE cl.status = ?';
    const params = status === 'all' ? [] : [status];

    const claims = await q(`
      SELECT cl.*, i.title, i.ref_code AS item_ref, i.photo_path,
             u.full_name AS claimant, u.student_no,
             (SELECT COUNT(*) FROM claim_proofs p WHERE p.claim_id=cl.id) AS proof_count
      FROM claims cl
      JOIN items i ON i.id = cl.item_id
      JOIN users u ON u.id = cl.claimant_id
      ${where}
      ORDER BY cl.created_at DESC LIMIT 200`, params);

    res.render('admin/claims', { title: 'Claims', claims, filters: { status } });
  } catch (err) { next(err); }
});

router.get('/claims/:id', async (req, res, next) => {
  try {
    const claim = await one(`
      SELECT cl.*, i.title, i.description, i.ref_code AS item_ref, i.photo_path,
             i.found_location, i.found_at, i.secret_detail, i.storage_location, i.status AS item_status,
             i.id AS item_id, u.full_name AS claimant, u.student_no, u.email, u.program, u.section, u.phone
      FROM claims cl
      JOIN items i ON i.id = cl.item_id
      JOIN users u ON u.id = cl.claimant_id
      WHERE cl.id = ?`, [req.params.id]);

    if (!claim) return res.redirect('/admin/claims');

    const proofs = await q('SELECT * FROM claim_proofs WHERE claim_id = ?', [claim.id]);

    // Other students competing for the same item.
    const rivals = await q(`
      SELECT cl.id, cl.ref_code, cl.status, u.full_name
      FROM claims cl JOIN users u ON u.id = cl.claimant_id
      WHERE cl.item_id = ? AND cl.id <> ?`, [claim.item_id, claim.id]);

    res.render('admin/claim', { title: claim.ref_code, claim, proofs, rivals });
  } catch (err) { next(err); }
});

/** Approve: release the item to this claimant, close every rival claim. */
router.post('/claims/:id/approve', async (req, res, next) => {
  try {
    const claim = await one(`
      SELECT cl.*, i.title, i.description, i.ref_code AS item_ref, i.id AS item_id, i.brand, i.color,
             u.email, u.full_name
      FROM claims cl JOIN items i ON i.id = cl.item_id JOIN users u ON u.id = cl.claimant_id
      WHERE cl.id = ?`, [req.params.id]);

    if (!claim || claim.status !== 'pending') {
      req.flash('error', 'That claim has already been decided.');
      return res.redirect('/admin/claims');
    }
    const note = String(req.body.adminNote || '').trim();

    await run(`
      UPDATE claims SET status='approved', admin_note=?, reviewed_by=?, reviewed_at=datetime('now','localtime')
      WHERE id = ?`, [note || null, req.session.user.id, claim.id]);

    await run("UPDATE items SET status='returned', released_at=datetime('now','localtime') WHERE id = ?", [claim.item_id]);

    // The claimant now has the item, so close any of their still-open lost
    // reports that describe it. Without this a report can say "Still looking"
    // next to an item that was already returned.
    const resolvedReports = await resolveLostReports(
      { title: claim.title, description: claim.description, brand: claim.brand, color: claim.color },
      claim.claimant_id
    );
    for (const r of resolvedReports) {
      await logActivity(req.session.user.id, 'lost_resolved', 'lost_report', r.id, r.ref_code);
    }

    // Any rival pending claims are rejected with an explanation.
    const rivals = await q(`
      SELECT cl.id, cl.ref_code, u.email, i.title
      FROM claims cl JOIN users u ON u.id = cl.claimant_id JOIN items i ON i.id = cl.item_id
      WHERE cl.item_id = ? AND cl.id <> ? AND cl.status = 'pending'`, [claim.item_id, claim.id]);

    for (const r of rivals) {
      await run(`UPDATE claims SET status='rejected',
                 admin_note='Another claimant verified ownership first.',
                 reviewed_by=?, reviewed_at=datetime('now','localtime') WHERE id = ?`,
        [req.session.user.id, r.id]);
      await notify(r.email, 'claimRejected', {
        claimRef: r.ref_code, title: r.title,
        note: 'Another claimant verified ownership of this item.'
      });
    }

    await logActivity(req.session.user.id, 'claim_approved', 'claim', claim.id, claim.ref_code);

    // Tell the claimant it is ready to collect, with the pickup details the
    // office configured in Admin → Notifications.
    const mailCfg = await getMailConfig();
    await notify(claim.email, 'claimApproved', {
      title: claim.title,
      itemRef: claim.item_ref,
      claimRef: claim.ref_code,
      note,
      location: mailCfg.pickup_location,
      hours: mailCfg.pickup_hours,
      officeEmail: mailCfg.admin_alert_email
    });

    // Tell the finder their good deed landed.
    const finder = await one(`
      SELECT u.email FROM items i JOIN users u ON u.id = i.finder_id WHERE i.id = ?`,
      [claim.item_id]);
    await notify(finder && finder.email, 'itemReturned', {
      itemRef: claim.item_ref, title: claim.title
    });

    req.flash('success', `${claim.ref_code} approved. ${claim.full_name} was emailed the collection details.`
      + (resolvedReports.length
        ? ` Lost report${resolvedReports.length > 1 ? 's' : ''} ${resolvedReports.map((r) => r.ref_code).join(', ')} marked as found.`
        : ''));
    res.redirect('/admin/claims');
  } catch (err) { next(err); }
});

router.post('/claims/:id/reject', async (req, res, next) => {
  try {
    const claim = await one(`
      SELECT cl.*, i.title, i.id AS item_id, u.email
      FROM claims cl JOIN items i ON i.id = cl.item_id JOIN users u ON u.id = cl.claimant_id
      WHERE cl.id = ?`, [req.params.id]);

    if (!claim || claim.status !== 'pending') {
      req.flash('error', 'That claim has already been decided.');
      return res.redirect('/admin/claims');
    }
    const note = String(req.body.adminNote || '').trim();
    if (!note) {
      req.flash('error', 'Give a reason. The claimant sees it in their email.');
      return res.redirect(`/admin/claims/${claim.id}`);
    }

    await run(`
      UPDATE claims SET status='rejected', admin_note=?, reviewed_by=?, reviewed_at=datetime('now','localtime')
      WHERE id = ?`, [note, req.session.user.id, claim.id]);

    // Put the item back on the shelf unless someone else is still waiting.
    const others = await one(
      "SELECT COUNT(*) AS n FROM claims WHERE item_id = ? AND status='pending'", [claim.item_id]);
    if (!others.n) {
      await run("UPDATE items SET status='in_custody' WHERE id = ? AND status='on_hold'",
        [claim.item_id]);
    }

    await logActivity(req.session.user.id, 'claim_rejected', 'claim', claim.id, claim.ref_code);
    await notify(claim.email, 'claimRejected', {
      claimRef: claim.ref_code, title: claim.title, note
    });

    req.flash('success', `${claim.ref_code} rejected and the claimant was emailed.`);
    res.redirect('/admin/claims');
  } catch (err) { next(err); }
});

// =====================================================================
// Lost reports, users, email log
// =====================================================================
router.get('/lost-reports', async (req, res, next) => {
  try {
    // Heal rows that went stale before approval-time resolution (or were
    // approved by an older deploy) so this list always reflects the claims.
    let healed = [];
    try {
      healed = await reconcileLostReports();
    } catch (err) {
      console.error('[lost] reconcile failed:', err.message);
    }

    const reports = await q(`
      SELECT l.*, c.name AS category, u.full_name AS student, u.student_no, u.email
      FROM lost_reports l
      LEFT JOIN categories c ON c.id = l.category_id
      JOIN users u ON u.id = l.student_id
      ORDER BY CASE l.status WHEN 'open' THEN 0 WHEN 'resolved' THEN 1 WHEN 'closed' THEN 2 ELSE 3 END, l.created_at DESC LIMIT 200`);
    res.render('admin/lost-reports', { title: 'Lost reports', reports, healed });
  } catch (err) { next(err); }
});

/** Staff correction: mark a report found/closed, or reopen a mistaken one. */
router.post('/lost-reports/:id/status', async (req, res, next) => {
  try {
    const status = String(req.body.status || '');
    if (!['open', 'resolved', 'closed'].includes(status)) {
      req.flash('error', 'Unknown lost-report status.');
      return res.redirect('/admin/lost-reports');
    }

    const report = await one(
      'SELECT id, ref_code, status FROM lost_reports WHERE id = ?', [req.params.id]);
    if (!report) {
      req.flash('error', 'That lost report no longer exists.');
      return res.redirect('/admin/lost-reports');
    }

    await run('UPDATE lost_reports SET status = ? WHERE id = ?', [status, report.id]);
    await logActivity(req.session.user.id, `lost_${status}`, 'lost_report', report.id, report.ref_code);

    const label = status === 'resolved' ? 'marked as found'
      : status === 'closed' ? 'closed' : 'reopened';
    req.flash('success', `${report.ref_code} ${label}.`);
    res.redirect('/admin/lost-reports');
  } catch (err) { next(err); }
});

router.get('/users', async (req, res, next) => {
  try {
    const users = await q(`
      SELECT u.*,
        (SELECT COUNT(*) FROM items i WHERE i.finder_id = u.id)   AS finds,
        (SELECT COUNT(*) FROM claims c WHERE c.claimant_id = u.id) AS claims
      FROM users u ORDER BY u.role, u.full_name`);
    res.render('admin/users', { title: 'Accounts', users });
  } catch (err) { next(err); }
});

router.post('/users/:id/toggle', async (req, res, next) => {
  try {
    if (Number(req.params.id) === req.session.user.id) {
      req.flash('error', 'You cannot disable your own account.');
      return res.redirect('/admin/users');
    }
    await run('UPDATE users SET is_active = NOT is_active WHERE id = ?', [req.params.id]);
    await logActivity(req.session.user.id, 'user_toggled', 'user', req.params.id, null);
    req.flash('success', 'Account status changed.');
    res.redirect('/admin/users');
  } catch (err) { next(err); }
});

/** Add another staff account for the office. */
router.post('/users/staff', async (req, res, next) => {
  try {
    const { fullName, email, password } = req.body;
    if (!fullName || !email || String(password).length < 8) {
      req.flash('error', 'Staff accounts need a name, email and an 8-character password.');
      return res.redirect('/admin/users');
    }
    const clash = await one('SELECT id FROM users WHERE email = ?', [String(email).toLowerCase()]);
    if (clash) {
      req.flash('error', 'That email is already registered.');
      return res.redirect('/admin/users');
    }
    await run(`
      INSERT INTO users (full_name, email, password_hash, role)
      VALUES (?, ?, ?, 'admin')`,
      [String(fullName).trim(), String(email).toLowerCase(), await bcrypt.hash(String(password), 10)]);
    req.flash('success', 'Staff account created.');
    res.redirect('/admin/users');
  } catch (err) { next(err); }
});

router.get('/emails', async (req, res, next) => {
  try {
    const [emails, cfg] = await Promise.all([
      q('SELECT * FROM email_log ORDER BY created_at DESC LIMIT 100'),
      getMailConfig()
    ]);
    res.render('admin/emails', {
      title: 'Notifications', emails,
      mailConfig: cfg,
      mailEnabled: cfg.mail_enabled_bool
    });
  } catch (err) { next(err); }
});

router.post('/emails/settings', async (req, res, next) => {
  try {
    const body = req.body || {};
    const input = {
      mail_enabled: body.mail_enabled === 'on' ? 'true' : 'false',
      mail_host: String(body.mail_host || '').trim(),
      mail_port: String(body.mail_port || '587').trim(),
      mail_secure: body.mail_secure === 'on' ? 'true' : 'false',
      mail_user: String(body.mail_user || '').trim(),
      mail_from: String(body.mail_from || '').trim(),
      admin_alert_email: String(body.admin_alert_email || '').trim(),
      base_url: String(body.base_url || '').trim().replace(/\/$/, ''),
      pickup_location: String(body.pickup_location || '').trim(),
      pickup_hours: String(body.pickup_hours || '').trim()
    };
    // Blank password = keep the saved one.
    if (String(body.mail_pass || '').trim()) input.mail_pass = String(body.mail_pass).trim();

    if (input.mail_enabled === 'true' && !input.mail_host) {
      req.flash('error', 'Add an SMTP host before turning sending on.');
      return res.redirect('/admin/emails');
    }

    await saveMailConfig(input);
    await logActivity(req.session.user.id, 'mail_settings_updated', 'settings', null, null);
    req.flash('success', 'Mail settings saved.');
    res.redirect('/admin/emails');
  } catch (err) { next(err); }
});

router.post('/emails/test', async (req, res, next) => {
  try {
    const to = String(req.body.testTo || req.session.user.email || '').trim();
    const result = await sendTestEmail(to);
    if (result.ok) {
      req.flash('success', `Test email sent to ${to}. Check the inbox (and spam).`);
    } else {
      req.flash('error', `Test failed: ${result.error}`);
    }
    res.redirect('/admin/emails');
  } catch (err) { next(err); }
});

module.exports = router;
