/**
 * Cross-reference a found item against open lost reports and email anyone whose
 * report plausibly matches. Keyword overlap on title, description and brand,
 * plus a category hit. Deliberately loose: a near miss costs one email, a
 * missed match costs a student their wallet.
 */
const { q, run, logActivity } = require('./db');
const { notify } = require('./mailer');

async function alertPossibleOwners(item) {
  const words = `${item.title} ${item.brand || ''} ${item.color || ''}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);

  if (!words.length && !item.category_id) return 0;

  const clauses = [];
  const params = [];

  for (const w of words) {
    clauses.push('(LOWER(l.title) LIKE ? OR LOWER(l.description) LIKE ? OR LOWER(l.brand) LIKE ?)');
    params.push(`%${w}%`, `%${w}%`, `%${w}%`);
  }
  if (item.category_id) {
    clauses.push('l.category_id = ?');
    params.push(item.category_id);
  }

  const matches = await q(`
    SELECT l.*, u.email
    FROM lost_reports l
    JOIN users u ON u.id = l.student_id
    WHERE l.status = 'open'
      AND l.student_id <> ?
      AND (${clauses.join(' OR ')})
    LIMIT 25`, [item.finder_id, ...params]);

  for (const m of matches) {
    await notify(m.email, 'possibleMatch', {
      lostTitle: m.title,
      lostRef: m.ref_code,
      title: item.title,
      location: item.found_location,
      foundDate: new Date(item.found_at).toLocaleDateString('en-PH'),
      itemId: item.id
    });
  }
  return matches.length;
}

/** Words too common to identify an object on their own ("lost", "the", "item"). */
const STOPWORDS = new Set([
  'the', 'and', 'with', 'for', 'from', 'this', 'that', 'these', 'those',
  'was', 'were', 'has', 'have', 'had', 'its', 'his', 'her', 'hers', 'our',
  'you', 'your', 'not', 'but', 'all', 'any', 'one', 'two', 'new', 'old',
  'lost', 'found', 'missing', 'item', 'items', 'thing', 'things',
  'color', 'colour', 'brand', 'size', 'small', 'medium', 'large', 'big'
]);

const COLOURS = new Set([
  'black', 'white', 'blue', 'red', 'green', 'yellow', 'pink', 'purple',
  'violet', 'silver', 'gold', 'golden', 'gray', 'grey', 'brown', 'orange',
  'maroon', 'beige', 'cream', 'navy', 'teal', 'rose', 'clear', 'transparent'
]);

/* Tracked apart from STOPWORDS: sharing only "pink" must never be enough to
 * declare a lost report found. */

function keywords(text, { descriptive = false } = {}) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2
      && !STOPWORDS.has(w)
      && !(descriptive && COLOURS.has(w)));
}

function sharedWords(a, b, opts) {
  const right = new Set(keywords(b, opts));
  return [...new Set(keywords(a, opts))].filter((w) => right.has(w));
}

/**
 * Does a lost report plausibly describe this item?
 *
 * Stricter than alertPossibleOwners on purpose: a title or brand word has to
 * overlap, so sharing a category or a colour alone never closes a report. The
 * report's title is compared without colour words, which stops "pink wallet"
 * matching a "pink tumbler" that the same student happened to claim.
 */
function lostReportMatchesItem(report, item) {
  const titleHit = sharedWords(report.title, item.title, { descriptive: true }).length > 0;
  const brandHit =
    sharedWords(report.brand, `${item.brand || ''} ${item.title || ''}`).length > 0 ||
    sharedWords(item.brand, `${report.brand || ''} ${report.title || ''}`).length > 0;
  // Descriptions are the fallback when the office listed the item under a
  // different name than the student used ("Dildo" vs "Pink item"). A shared
  // non-colour word there is still specific enough to act on.
  const descriptionHit = sharedWords(
    report.description, `${item.title || ''} ${item.description || ''}`, { descriptive: true }
  ).length > 0;
  return titleHit || brandHit || descriptionHit;
}

/**
 * When staff approve a claim the claimant has their item back, so any of their
 * still-open lost reports that describe that item are fulfilled. Returns the
 * reports that were marked resolved, for the audit log and the flash message.
 */
async function resolveLostReports(item, studentId) {
  const reports = await q(
    `SELECT id, ref_code, title, description, brand, color
     FROM lost_reports WHERE student_id = ? AND status = 'open'`,
    [studentId]
  );
  const matches = reports.filter((r) => lostReportMatchesItem(r, item));
  for (const r of matches) {
    await run("UPDATE lost_reports SET status = 'resolved' WHERE id = ?", [r.id]);
  }
  return matches;
}

/**
 * Repair lost reports that drifted before approval-time resolution existed
 * (or when a claim was approved on another instance). Any open report whose
 * owner already had a matching claim approved is marked found. Idempotent, so
 * it is safe to run at boot and before the admin list renders.
 */
async function reconcileLostReports() {
  const reports = await q(`
    SELECT l.id, l.ref_code, l.title, l.description, l.brand, l.color, l.student_id
    FROM lost_reports l
    WHERE l.status = 'open'
      AND EXISTS (
        SELECT 1 FROM claims cl JOIN items i ON i.id = cl.item_id
        WHERE cl.claimant_id = l.student_id
          AND cl.status = 'approved' AND i.status = 'returned'
      )`);

  const healed = [];
  for (const report of reports) {
    const items = await q(`
      SELECT i.id, i.ref_code, i.title, i.description, i.brand, i.color
      FROM claims cl JOIN items i ON i.id = cl.item_id
      WHERE cl.claimant_id = ? AND cl.status = 'approved' AND i.status = 'returned'`,
      [report.student_id]);

    const hit = items.find((item) => lostReportMatchesItem(report, item));
    if (!hit) continue;

    await run("UPDATE lost_reports SET status = 'resolved' WHERE id = ?", [report.id]);
    await logActivity(null, 'lost_resolved_auto', 'lost_report', report.id,
      `${report.ref_code} matched ${hit.ref_code}`);
    healed.push({ id: report.id, ref_code: report.ref_code, item_ref: hit.ref_code });
  }
  return healed;
}

module.exports = { alertPossibleOwners, lostReportMatchesItem, resolveLostReports, reconcileLostReports };
