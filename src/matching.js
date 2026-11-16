/**
 * Cross-reference a found item against open lost reports and email anyone whose
 * report plausibly matches. Keyword overlap on title, description and brand,
 * plus a category hit. Deliberately loose: a near miss costs one email, a
 * missed match costs a student their wallet.
 */
const { q } = require('./db');
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

module.exports = { alertPossibleOwners };
