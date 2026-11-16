const express = require('express');
const { q, one, run, nextRefCode, logActivity } = require('../db');
const { notify } = require('../mailer');
const { requireLogin, requireStudent } = require('../middleware/auth');
const { upload, webPath } = require('../middleware/upload');
const badges = require('../badges');

const router = express.Router();
const categories = () => q('SELECT * FROM categories ORDER BY name');

// =====================================================================
// Dashboard
// =====================================================================
router.get('/dashboard', requireStudent, async (req, res, next) => {
  try {
    const me = req.session.user.id;
    const [stats] = await q(`
      SELECT
        (SELECT COUNT(*) FROM items WHERE status = 'in_custody')              AS available,
        (SELECT COUNT(*) FROM items WHERE finder_id = ?)                      AS "myFinds",
        (SELECT COUNT(*) FROM claims WHERE claimant_id = ? AND status='pending') AS "myPending",
        (SELECT COUNT(*) FROM lost_reports WHERE student_id = ? AND status='open') AS "myLost"
    `, [me, me, me]);

    const recent = await q(`
      SELECT i.*, c.name AS category
      FROM items i LEFT JOIN categories c ON c.id = i.category_id
      WHERE i.status = 'in_custody'
      ORDER BY i.received_at DESC, i.id DESC LIMIT 6`);

    const myClaims = await q(`
      SELECT cl.*, i.title, i.ref_code AS item_ref, i.photo_path
      FROM claims cl JOIN items i ON i.id = cl.item_id
      WHERE cl.claimant_id = ?
      ORDER BY cl.created_at DESC LIMIT 4`, [me]);

    const todo = await q(`
      SELECT * FROM items
      WHERE finder_id = ? AND status = 'pending_dropoff'
      ORDER BY created_at DESC`, [me]);

    res.render('student/dashboard', {
      title: 'Dashboard', stats, recent, myClaims, todo,
      badges: badges.evaluate(await badges.statsFor(me))
    });
  } catch (err) { next(err); }
});

// =====================================================================
// Browse items held at the office
// =====================================================================
router.get('/items', requireLogin, async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const category = req.query.category ? Number(req.query.category) : null;
    const sort = req.query.sort === 'oldest' ? 'ASC' : 'DESC';

    const where = ["i.status IN ('in_custody','on_hold')"];
    const params = [];

    if (search) {
      where.push(`(i.title LIKE ? OR i.description LIKE ? OR i.brand LIKE ?
                   OR i.color LIKE ? OR i.found_location LIKE ? OR i.ref_code LIKE ?)`);
      for (let n = 0; n < 6; n++) params.push(`%${search}%`);
    }
    if (category) { where.push('i.category_id = ?'); params.push(category); }

    const items = await q(`
      SELECT i.*, c.name AS category
      FROM items i LEFT JOIN categories c ON c.id = i.category_id
      WHERE ${where.join(' AND ')}
      ORDER BY i.found_at ${sort}
      LIMIT 200`, params);

    res.render('student/browse', {
      title: 'Items at the office',
      items, categories: await categories(),
      filters: { search, category, sort: req.query.sort || 'newest' }
    });
  } catch (err) { next(err); }
});

// =====================================================================
// Log a found item
// =====================================================================
router.get('/found/new', requireStudent, async (req, res, next) => {
  try {
    res.render('student/report-found', {
      title: 'Log a found item', categories: await categories(), form: {}
    });
  } catch (err) { next(err); }
});

router.post('/found/new', requireStudent, upload.single('photo'), async (req, res, next) => {
  const form = {
    title: String(req.body.title || '').trim(),
    description: String(req.body.description || '').trim(),
    categoryId: req.body.categoryId || null,
    color: String(req.body.color || '').trim(),
    brand: String(req.body.brand || '').trim(),
    foundLocation: String(req.body.foundLocation || '').trim(),
    foundAt: req.body.foundAt,
    secretDetail: String(req.body.secretDetail || '').trim()
  };

  try {
    if (!form.title || !form.description || !form.foundLocation || !form.foundAt) {
      req.flash('error', 'Fill in what it is, where and when you found it.');
      return res.status(400).render('student/report-found', {
        title: 'Log a found item', categories: await categories(), form
      });
    }
    if (new Date(form.foundAt) > new Date()) {
      req.flash('error', 'The date found cannot be in the future.');
      return res.status(400).render('student/report-found', {
        title: 'Log a found item', categories: await categories(), form
      });
    }

    const refCode = await nextRefCode('items', 'LF');
    const me = req.session.user.id;
    const before = badges.evaluate(await badges.statsFor(me));
    const result = await run(`
      INSERT INTO items
        (ref_code, title, description, category_id, color, brand,
         found_location, found_at, photo_path, secret_detail, finder_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_dropoff')`,
      [refCode, form.title, form.description, form.categoryId || null,
       form.color || null, form.brand || null, form.foundLocation,
       new Date(form.foundAt), webPath(req.file), form.secretDetail || null,
       me]);

    const after = badges.evaluate(await badges.statsFor(me));
    const unlocked = after.list.filter((b) => b.earned && !before.earnedIds.includes(b.id));

    await logActivity(me, 'item_logged', 'item', result.insertId, refCode);
    await notify(req.session.user.email, 'foundLogged', {
      refCode, title: form.title, location: form.foundLocation
    });

    req.flash('success', unlocked.length
      ? `Logged as ${refCode}. New badge unlocked: ${unlocked.map((b) => b.name).join(', ')}!`
      : `Logged as ${refCode}. Bring it to the property office to finish.`);
    res.redirect('/my-items');
  } catch (err) { next(err); }
});

router.get('/my-items', requireStudent, async (req, res, next) => {
  try {
    const items = await q(`
      SELECT i.*, c.name AS category,
             (SELECT COUNT(*) FROM claims cl WHERE cl.item_id = i.id AND cl.status='pending') AS pending_claims
      FROM items i LEFT JOIN categories c ON c.id = i.category_id
      WHERE i.finder_id = ?
      ORDER BY i.created_at DESC`, [req.session.user.id]);
    res.render('student/my-items', { title: 'Items you turned in', items });
  } catch (err) { next(err); }
});

// =====================================================================
// Report something you lost
// =====================================================================
router.get('/lost', requireStudent, async (req, res, next) => {
  try {
    const reports = await q(`
      SELECT l.*, c.name AS category
      FROM lost_reports l LEFT JOIN categories c ON c.id = l.category_id
      WHERE l.student_id = ? ORDER BY l.created_at DESC`, [req.session.user.id]);
    res.render('student/my-lost', { title: 'Your lost reports', reports });
  } catch (err) { next(err); }
});

router.get('/lost/new', requireStudent, async (req, res, next) => {
  try {
    res.render('student/report-lost', {
      title: 'Report a lost item', categories: await categories(), form: {}
    });
  } catch (err) { next(err); }
});

router.post('/lost/new', requireStudent, upload.single('photo'), async (req, res, next) => {
  const form = {
    title: String(req.body.title || '').trim(),
    description: String(req.body.description || '').trim(),
    categoryId: req.body.categoryId || null,
    color: String(req.body.color || '').trim(),
    brand: String(req.body.brand || '').trim(),
    lostLocation: String(req.body.lostLocation || '').trim(),
    lostAt: req.body.lostAt
  };
  try {
    if (!form.title || !form.description || !form.lostLocation || !form.lostAt) {
      req.flash('error', 'Fill in what you lost, and where and when you last had it.');
      return res.status(400).render('student/report-lost', {
        title: 'Report a lost item', categories: await categories(), form
      });
    }

    const refCode = await nextRefCode('lost_reports', 'LR');
    const result = await run(`
      INSERT INTO lost_reports
        (ref_code, title, description, category_id, color, brand,
         lost_location, lost_at, photo_path, student_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [refCode, form.title, form.description, form.categoryId || null,
       form.color || null, form.brand || null, form.lostLocation,
       new Date(form.lostAt), webPath(req.file), req.session.user.id]);

    await logActivity(req.session.user.id, 'lost_reported', 'lost_report', result.insertId, refCode);
    req.flash('success', `Report ${refCode} filed. We will email you if a match turns up.`);
    res.redirect('/lost');
  } catch (err) { next(err); }
});

router.post('/lost/:id/close', requireStudent, async (req, res, next) => {
  try {
    const status = req.body.status === 'resolved' ? 'resolved' : 'closed';
    await run('UPDATE lost_reports SET status = ? WHERE id = ? AND student_id = ?',
      [status, req.params.id, req.session.user.id]);
    req.flash('success', status === 'resolved' ? 'Marked as found.' : 'Report closed.');
    res.redirect('/lost');
  } catch (err) { next(err); }
});

// =====================================================================
// Item detail + claiming
// =====================================================================
router.get('/items/:id', requireLogin, async (req, res, next) => {
  try {
    const item = await one(`
      SELECT i.*, c.name AS category, u.full_name AS finder_name
      FROM items i
      LEFT JOIN categories c ON c.id = i.category_id
      JOIN users u ON u.id = i.finder_id
      WHERE i.id = ?`, [req.params.id]);

    if (!item) {
      return res.status(404).render('error', {
        title: 'Item not found', code: 404,
        message: 'No item with that reference. It may have been returned and archived.'
      });
    }

    const myClaim = await one(
      'SELECT * FROM claims WHERE item_id = ? AND claimant_id = ?',
      [item.id, req.session.user.id]);

    res.render('student/item', { title: item.ref_code, item, myClaim });
  } catch (err) { next(err); }
});

router.get('/items/:id/claim', requireStudent, async (req, res, next) => {
  try {
    const item = await one('SELECT * FROM items WHERE id = ?', [req.params.id]);
    if (!item) return res.redirect('/items');

    if (item.status !== 'in_custody') {
      req.flash('error', 'This item is not open for claims right now.');
      return res.redirect(`/items/${item.id}`);
    }
    if (item.finder_id === req.session.user.id) {
      req.flash('error', 'You turned this item in, so you cannot claim it.');
      return res.redirect(`/items/${item.id}`);
    }
    const existing = await one(
      'SELECT id FROM claims WHERE item_id = ? AND claimant_id = ?',
      [item.id, req.session.user.id]);
    if (existing) {
      req.flash('error', 'You already filed a claim on this item.');
      return res.redirect('/claims');
    }

    res.render('student/claim-form', { title: 'Claim this item', item, form: {} });
  } catch (err) { next(err); }
});

router.post('/items/:id/claim', requireStudent, upload.array('proofs', 5), async (req, res, next) => {
  try {
    const item = await one('SELECT * FROM items WHERE id = ?', [req.params.id]);
    if (!item || item.status !== 'in_custody') {
      req.flash('error', 'This item is no longer open for claims.');
      return res.redirect('/items');
    }
    if (item.finder_id === req.session.user.id) {
      req.flash('error', 'You turned this item in, so you cannot claim it.');
      return res.redirect(`/items/${item.id}`);
    }

    const statement = String(req.body.statement || '').trim();
    const detailAnswer = String(req.body.detailAnswer || '').trim();

    if (!statement || !detailAnswer) {
      req.flash('error', 'Describe how you lost it and answer the identifying question.');
      return res.status(400).render('student/claim-form', {
        title: 'Claim this item', item, form: { statement, detailAnswer }
      });
    }
    if (!req.files || req.files.length === 0) {
      req.flash('error', 'Attach at least one photo or document proving ownership.');
      return res.status(400).render('student/claim-form', {
        title: 'Claim this item', item, form: { statement, detailAnswer }
      });
    }

    const refCode = await nextRefCode('claims', 'CL');
    const result = await run(`
      INSERT INTO claims (ref_code, item_id, claimant_id, statement, detail_answer)
      VALUES (?, ?, ?, ?, ?)`,
      [refCode, item.id, req.session.user.id, statement, detailAnswer]);

    const captions = [].concat(req.body.captions || []);
    for (let n = 0; n < req.files.length; n++) {
      await run(
        'INSERT INTO claim_proofs (claim_id, file_path, caption) VALUES (?, ?, ?)',
        [result.insertId, webPath(req.files[n]), captions[n] || null]);
    }

    // Freeze the item so nobody else claims it mid-review.
    await run("UPDATE items SET status = 'on_hold' WHERE id = ?", [item.id]);
    await logActivity(req.session.user.id, 'claim_filed', 'claim', result.insertId, refCode);

    await notify(req.session.user.email, 'claimFiled', {
      claimRef: refCode, title: item.title, itemRef: item.ref_code
    });
    await notify(process.env.ADMIN_ALERT_EMAIL, 'claimAlertAdmin', {
      claimRef: refCode, claimant: req.session.user.name, title: item.title,
      itemRef: item.ref_code, proofCount: req.files.length, claimId: result.insertId
    });

    req.flash('success', `Claim ${refCode} filed. Wait for the email before going to the office.`);
    res.redirect('/claims');
  } catch (err) { next(err); }
});

// =====================================================================
// My claims
// =====================================================================
router.get('/claims', requireStudent, async (req, res, next) => {
  try {
    const claims = await q(`
      SELECT cl.*, i.title, i.ref_code AS item_ref, i.photo_path, i.storage_location
      FROM claims cl JOIN items i ON i.id = cl.item_id
      WHERE cl.claimant_id = ?
      ORDER BY CASE cl.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'rejected' THEN 2 WHEN 'cancelled' THEN 3 ELSE 4 END, cl.created_at DESC`,
      [req.session.user.id]);

    for (const c of claims) {
      c.proofs = await q('SELECT * FROM claim_proofs WHERE claim_id = ?', [c.id]);
    }
    res.render('student/my-claims', { title: 'Your claims', claims });
  } catch (err) { next(err); }
});

router.post('/claims/:id/cancel', requireStudent, async (req, res, next) => {
  try {
    const claim = await one(
      'SELECT * FROM claims WHERE id = ? AND claimant_id = ?',
      [req.params.id, req.session.user.id]);
    if (!claim || claim.status !== 'pending') {
      req.flash('error', 'That claim can no longer be cancelled.');
      return res.redirect('/claims');
    }

    await run("UPDATE claims SET status = 'cancelled' WHERE id = ?", [claim.id]);

    // Release the hold unless another claim is still waiting.
    const others = await one(
      "SELECT COUNT(*) AS n FROM claims WHERE item_id = ? AND status = 'pending'",
      [claim.item_id]);
    if (!others.n) {
      await run("UPDATE items SET status = 'in_custody' WHERE id = ? AND status = 'on_hold'",
        [claim.item_id]);
    }

    await logActivity(req.session.user.id, 'claim_cancelled', 'claim', claim.id, claim.ref_code);
    req.flash('success', 'Claim cancelled.');
    res.redirect('/claims');
  } catch (err) { next(err); }
});

module.exports = router;
