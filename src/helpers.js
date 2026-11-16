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

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-PH', {
    year: 'numeric', month: 'short', day: 'numeric'
  });
}

function fmtDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-PH', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}

/** "3 days ago" style, for lists where exact time is noise. */
function timeAgo(d) {
  if (!d) return '—';
  const secs = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
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
  const x = d ? new Date(d) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

/** Days remaining in the claim window before an item is flagged for disposal. */
function daysLeft(receivedAt) {
  if (!receivedAt) return null;
  const window = Number(process.env.CLAIM_WINDOW_DAYS || 90);
  const elapsed = Math.floor((Date.now() - new Date(receivedAt).getTime()) / 86400000);
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
  PROGRAMS, sectionsFor
};
