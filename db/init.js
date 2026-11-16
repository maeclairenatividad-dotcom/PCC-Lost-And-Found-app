/**
 * (Re)builds the database schema from scratch.
 *
 *   npm run db:init
 *
 * Drops every table first, so this is destructive — run it only to set up or
 * rebuild a development database. Demo data still needs `npm run seed` after.
 *
 * Works against whichever engine DATABASE_URL selects:
 *   - Postgres  -> db/schema.postgres.sql (TRUNCATE … RESTART IDENTITY)
 *   - SQLite    -> db/schema.sql
 */
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const { engine, isPostgres, exec, run, close } = require('../src/db');

const TABLES = [
  'claim_proofs', 'claims', 'items', 'lost_reports',
  'email_log', 'activity_log', 'settings', 'sessions', 'users', 'categories'
];

async function main() {
  console.log(`Rebuilding the ${engine} schema…`);
  console.log('Dropping existing tables…');

  if (isPostgres) {
    for (const t of TABLES) {
      await run(`DROP TABLE IF EXISTS ${t} CASCADE`);
    }
    await run('DROP FUNCTION IF EXISTS set_updated_at() CASCADE');
  } else {
    for (const t of TABLES) {
      await run(`DROP TABLE IF EXISTS ${t}`);
    }
  }

  const file = isPostgres ? 'schema.postgres.sql' : 'schema.sql';
  const schema = fs.readFileSync(path.join(__dirname, file), 'utf8');
  await exec(schema);

  console.log(`Schema ready (${file}).`);
  console.log('Now load the demo data:  npm run seed\n');
}

main()
  .then(() => close())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await close().catch(() => {});
    process.exit(1);
  });
