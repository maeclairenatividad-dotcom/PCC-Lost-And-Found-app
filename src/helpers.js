/** Formatting helpers exposed to every EJS view. */

const STATUS = {
  pending_dropoff: { label: 'Awaiting drop-off', tone: 'wait' },
  in_custody:      { label: 'At the office',     tone: 'good' },
  on_hold:         { label: 'Claim under review',tone: 'busy' },
  returned:        { label: 'Returned to owner', tone: 'done' },
  disposed:        { label: 'Removed',           tone: 'mute' },
  pending:         { label: 'Under review',      tone: 'busy' },
  approved:        { label: 'Approved',          tone: 'good' },
  rejected:        { label: 'Not approved',      tone: 'bad'  },
  cancelled:       { label: 'Cancelled',         tone: 'mute' },
  open:            { label: 'Still looking',     tone: 'busy' },
  resolved:        { label: 'Found it',          tone: 'good' },
  closed:          { label: 'Closed',            tone: 'mute' }
};

const statusLabel = (s) => (STATUS[s] ? STATUS[s].label : s);
const statusTone  = (s) => (STATUS[s] ? STATUS[s].tone : 'mute');

/**
 * Timestamps in the database are wall-clock time in the school's zone (see
 * PG_TIMEZONE), not UTC instants. Parsing them with `new Date(value)` makes
 * the server's timezone leak in — on a UTC host a "23:00" row reads as 8 hours
 * in the future, so timeAgo() says "just now" all evening. Everything below
 * converts both stored values and "now" onto the same wall-clock basis.
 */
const TIMEZONE = process.env.PG_TIMEZONE || 'Asia/Manila';

/* Shown next to the date fields, and passed to /js/datetime-local.js. */
const APP_TIMEZONE = process.env.APP_TIMEZONE || TIMEZONE;

const ZONE_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23'
});

function instantToWallMs(date) {
  const p = {};
  for (const { type, value } of ZONE_PARTS.formatToParts(date)) {
    if (type !== 'literal') p[type] = Number(value);
  }
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** "Now" as the same wall-clock milliseconds basis as stored values. */
function nowWallMs() {
  return instantToWallMs(new Date());
}

/** Milliseconds for a stored timestamp, read as wall-clock time. */
function wallMs(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (value instanceof Date) return instantToWallMs(value);

  const s = String(value);
  if (/(?:z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? NaN : instantToWallMs(d);
  }

  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

/** Pseudo-UTC Date carrying the wall-clock components; format it in UTC. */
function wallDate(value) {
  const ms = wallMs(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** "Now" as a pseudo-UTC Date on the school's wall clock. */
function wallNow() {
  return new Date(nowWallMs());
}

function fmtDate(d) {
  const x = wallDate(d);
  if (!x) return '—';
  return x.toLocaleDateString('en-PH', {
    timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric'
  });
}

function fmtDateTime(d) {
  const x = wallDate(d);
  if (!x) return '—';
  return x.toLocaleString('en-PH', {
    timeZone: 'UTC',
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}

/** "3 days ago" style, for lists where exact time is noise. */
function timeAgo(d) {
  const then = wallMs(d);
  if (Number.isNaN(then)) return '—';
  const secs = Math.floor((nowWallMs() - then) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return fmtDate(d);
}

/** Value for a datetime-local input. */
function dtLocalValue(d) {
  const ms = d ? wallMs(d) : nowWallMs();
  if (Number.isNaN(ms)) return '';
  const x = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}T${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}`;
}

/**
 * True when a datetime-local value is later than "now" on the school clock.
 * Comparing wall-clock values avoids the server's own timezone (Render runs
 * UTC, 8 hours behind Manila). The grace window absorbs page-render delay and
 * a phone clock that is a few minutes ahead.
 */
function isFutureLocal(value, graceMinutes = 15) {
  const submitted = wallMs(value);
  if (Number.isNaN(submitted)) return false;
  return submitted > nowWallMs() + graceMinutes * 60000;
}

/** Days remaining in the claim window before an item is flagged for disposal. */
function daysLeft(receivedAt) {
  if (!receivedAt) return null;
  const window = Number(process.env.CLAIM_WINDOW_DAYS || 90);
  const elapsed = Math.floor((nowWallMs() - wallMs(receivedAt)) / 86400000);
  return window - elapsed;
}

/** Academic programs offered by the college, in display order. */
const PROGRAMS = [
  'BSIT', 'BSBA', 'BSCRIM', 'BSHM',
  'BSED English', 'BSED Math', 'BEED'
];

/** Section codes offered for a program, e.g. 1-A, 2-B, 4-C. */
const SECTION_LETTERS = ['A', 'B', 'C'];
function sectionsFor() {
  const out = [];
  for (let year = 1; year <= 4; year++) {
    for (const letter of SECTION_LETTERS) out.push(`${year}-${letter}`);
  }
  return out;
}

module.exports = {
  STATUS, statusLabel, statusTone, fmtDate, fmtDateTime, timeAgo, dtLocalValue, daysLeft,
  wallDate, wallNow, APP_TIMEZONE, isFutureLocal, PROGRAMS, sectionsFor
};
