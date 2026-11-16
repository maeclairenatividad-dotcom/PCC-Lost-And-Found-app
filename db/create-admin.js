/**
 * Create or reset the first staff account without loading demo data.
 *
 *   npm run admin:create
 *
 * Set ADMIN_EMAIL / ADMIN_NAME / ADMIN_PASSWORD in the environment (or .env)
 * for non-interactive use on a host. If they are missing, it prompts.
 * Re-running with an existing email resets that account's password and makes
 * sure it is an active admin — handy if you lose the password.
 */
require('dotenv').config();

const readline = require('readline/promises');
const bcrypt = require('bcryptjs');
const { one, run, ensureSchema, engine, close } = require('../src/db');

async function main() {
  const created = await ensureSchema();
  if (created) console.log(`Created the ${engine} schema.`);

  let email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  let name = String(process.env.ADMIN_NAME || 'Property office staff').trim();
  let password = String(process.env.ADMIN_PASSWORD || '');

  if (!email || !password) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!email) email = (await rl.question('Staff email: ')).trim().toLowerCase();
      if (!password) password = (await rl.question('Password (min 8 characters): ')).trim();
    } finally {
      rl.close();
    }
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('\n  That does not look like a valid email address.\n');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('\n  Use a password of at least 8 characters.\n');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);
  const existing = await one('SELECT id FROM users WHERE email = ?', [email]);

  if (existing) {
    await run(
      "UPDATE users SET full_name = ?, password_hash = ?, role = 'admin', is_active = TRUE WHERE id = ?",
      [name, hash, existing.id]
    );
    console.log(`\n  Reset staff account: ${email}\n`);
  } else {
    await run(
      "INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, 'admin')",
      [name, email, hash]
    );
    console.log(`\n  Created staff account: ${email}\n`);
  }

  console.log('  Sign in at /admin/login\n');
}

main()
  .then(() => close())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('\n  Could not create the staff account:', err.message, '\n');
    await close().catch(() => {});
    process.exit(1);
  });
