/**
 * Provider presets for the mail settings form.
 *
 * Picking a provider fills in host/port/SSL and nudges the placeholders for the
 * fields only the operator can know (username, key, From address). Nothing is
 * submitted by the dropdown itself — the values land in the real form fields,
 * so the operator can still edit every one of them before saving.
 *
 * Port 2525 is the default wherever the provider supports it, because Render's
 * free tier blocks outbound SMTP on 25, 465 and 587.
 */
(function () {
  var PRESETS = {
    brevo2525: {
      host: 'smtp-relay.brevo.com',
      port: '2525',
      secure: false,
      user: 'your Brevo login email',
      pass: 'Brevo SMTP key',
      from: 'Campus Lost & Found <your-verified-sender@gmail.com>',
      note: 'Brevo → SMTP & API → SMTP keys. The From address must be a verified sender in Brevo → Senders.'
    },
    brevo587: {
      host: 'smtp-relay.brevo.com',
      port: '587',
      secure: false,
      user: 'your Brevo login email',
      pass: 'Brevo SMTP key',
      from: 'Campus Lost & Found <your-verified-sender@gmail.com>',
      note: 'Port 587 is blocked on Render free web services — this only works on a paid instance or a VPS.'
    },
    brevo465: {
      host: 'smtp-relay.brevo.com',
      port: '465',
      secure: true,
      user: 'your Brevo login email',
      pass: 'Brevo SMTP key',
      from: 'Campus Lost & Found <your-verified-sender@gmail.com>',
      note: 'Port 465 uses implicit SSL. Also blocked on Render free web services.'
    },
    mailgun: {
      host: 'smtp.mailgun.org',
      port: '2525',
      secure: false,
      user: 'postmaster@your-domain (from Mailgun → Sending → SMTP credentials)',
      pass: 'Mailgun SMTP password',
      from: 'Campus Lost & Found <postmaster@your-domain>',
      note: 'Mailgun requires a verified sending domain before it will relay anything.'
    },
    sendgrid: {
      host: 'smtp.sendgrid.net',
      port: '2525',
      secure: false,
      user: 'apikey',
      pass: 'API key (Settings → API Keys)',
      from: 'Campus Lost & Found <your-verified-sender@example.com>',
      note: 'SendGrid usernames are literally "apikey" — the API key goes in the password field.'
    },
    mailjet: {
      host: 'in-v3.mailjet.com',
      port: '2525',
      secure: false,
      user: 'API key',
      pass: 'Secret key',
      from: 'Campus Lost & Found <your-verified-sender@example.com>',
      note: 'Mailjet uses the API key as username and the secret key as password.'
    },
    gmail: {
      host: 'smtp.gmail.com',
      port: '587',
      secure: false,
      user: 'youraccount@gmail.com',
      pass: '16-character app password',
      from: 'Campus Lost & Found <youraccount@gmail.com>',
      note: 'Needs 2-Step Verification, then an App Password. Port 587 is blocked on Render free — use Brevo 2525 there.'
    },
    zoho: {
      host: 'smtp.zoho.com',
      port: '587',
      secure: false,
      user: 'you@your-domain',
      pass: 'App-specific password',
      from: 'Campus Lost & Found <you@your-domain>',
      note: 'Port 587 is blocked on Render free web services.'
    }
  };

  var select = document.getElementById('mailPreset');
  if (!select) return;

  var host = document.getElementById('mail_host');
  var port = document.getElementById('mail_port');
  var user = document.getElementById('mail_user');
  var pass = document.getElementById('mail_pass');
  var from = document.getElementById('mail_from');
  var secure = document.querySelector('input[name="mail_secure"]');
  var hint = document.getElementById('mailPresetHint');
  var defaultHint = hint ? hint.textContent : '';

  select.addEventListener('change', function () {
    var p = PRESETS[select.value];
    if (!p) {
      if (hint) {
        hint.textContent = defaultHint;
        hint.style.color = '';
      }
      return;
    }

    host.value = p.host;
    port.value = p.port;
    if (secure) secure.checked = !!p.secure;

    user.placeholder = p.user;
    pass.placeholder = p.pass;
    from.placeholder = p.from;

    if (hint) {
      hint.textContent = p.note;
      hint.style.color = 'var(--tag)';
    }

    // Jump the operator straight to the first field only they can fill.
    user.focus();
  });
})();
