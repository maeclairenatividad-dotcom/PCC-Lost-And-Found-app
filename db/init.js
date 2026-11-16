/**
 * (Re)builds the database schema from scratch.
 *
 *   npm run db:init
 *
 * Drops every table first, so this is destructive — run it only to set up or
 * rebuild a development database. Demo data still needs `npm run seed` after.
 */
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const { exec, run } = require('../src/db');

async function main() {
  console.log('Dropping existing tables…');
  for (const t of [
    'claim_proofs', 'claims', 'items', 'lost_reports',
    'email_log', 'activity_log', 'settings', 'sessions', 'users', 'categories'
  ]) {
    await run(`DROP TABLE IF EXISTS ${t}`);
  }

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  exec(schema);
  console.log('Schema ready.');
  console.log('Now load the demo data:  npm run seed\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});