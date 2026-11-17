/**
 * Date-and-time inputs that follow the school clock (Asia/Manila).
 *
 * The server can run in UTC (Render does), so a browser in Manila picking
 * "today" is 8 hours ahead of the server. Everything here works in wall-clock
 * terms for the configured zone instead of relying on the device's timezone:
 *
 *   - an empty field starts at "now" in the school's zone
 *   - the picker's max is now + 10 minutes, refreshed while the page is open
 *   - "Now" buttons (data-now-button) re-stamp the field
 *   - submit is blocked for a time that is still in the future
 */
(function () {
  var inputs = Array.prototype.slice.call(
    document.querySelectorAll('input[type="datetime-local"][data-now]')
  );
  if (!inputs.length) return;

  var GRACE_MINUTES = 10;

  function partsIn(date, timeZone) {
    var out = {};
    var fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    });
    fmt.formatToParts(date).forEach(function (p) { out[p.type] = p.value; });
    if (out.hour === '24') out.hour = '00';
    return out;
  }

  // Wall-clock time in the zone, encoded as a UTC millisecond number so two
  // datetimes can be compared without the browser's own timezone interfering.
  function wallMs(date, timeZone) {
    var p = partsIn(date, timeZone);
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }

  function parseValue(value) {
    var m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  }

  var pad = function (n) { return String(n).padStart(2, '0'); };

  function formatWall(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
      'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }

  function isFuture(value, timeZone) {
    var submitted = parseValue(value);
    if (isNaN(submitted)) return false;
    return submitted > wallMs(new Date(), timeZone) + GRACE_MINUTES * 60000;
  }

  inputs.forEach(function (input) {
    var timeZone = input.getAttribute('data-tz') || 'Asia/Manila';
    // Server-rendered values (a re-shown form after a validation error) must
    // survive; only a genuinely empty field is auto-filled.
    var auto = !input.value;

    function stampMax() {
      input.max = formatWall(wallMs(new Date(), timeZone) + GRACE_MINUTES * 60000);
    }

    function stampNow() {
      input.value = formatWall(wallMs(new Date(), timeZone));
      stampMax();
    }

    function refresh() {
      if (auto) input.value = formatWall(wallMs(new Date(), timeZone));
      stampMax();
    }

    input.addEventListener('input', function () { auto = false; });
    input.addEventListener('change', function () { auto = false; });

    if (auto) stampNow();
    stampMax();

    // Keep the default honest if the tab sits open before submitting.
    setInterval(refresh, 30000);

    var button = input.parentNode.querySelector('[data-now-button]');
    if (button) {
      button.addEventListener('click', function () {
        stampNow();
        auto = true;
        input.focus();
      });
    }
  });

  document.addEventListener('submit', function (event) {
    var firstBad = null;
    inputs.forEach(function (input) {
      var timeZone = input.getAttribute('data-tz') || 'Asia/Manila';
      input.setCustomValidity('');
      if (input.value && isFuture(input.value, timeZone)) {
        input.setCustomValidity('That time is in the future. Use a time that has already happened (Asia/Manila).');
        firstBad = firstBad || input;
      }
    });
    if (firstBad) {
      event.preventDefault();
      firstBad.reportValidity();
      firstBad.focus();
    }
  }, true);
})();
