/**
 * Creates the demo accounts and a realistic spread of records so the system has
 * something to show on first run.
 *
 *   npm run seed
 *
 * Safe to re-run: it clears the demo rows first. Never run it on real data.
 * If no schema exists yet it builds it (via db/schema.sql) first.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { q, one, run, exec, pragma } = require('../src/db');

const PASSWORD = 'Password123';

const daysAgo = (n, hour = 14) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d;
};

async function ensureSchema() {
  const found = await one("SELECT name FROM sqlite_master WHERE type='table' AND name='users'");
  if (found) return;
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  exec(schema);
}

async function main() {
  await ensureSchema();
  const hash = await bcrypt.hash(PASSWORD, 10);

  console.log('Clearing existing records…');
  pragma('foreign_keys = OFF');
  for (const t of ['claim_proofs', 'claims', 'items', 'lost_reports', 'email_log', 'activity_log', 'users']) {
    await run(`DELETE FROM ${t}`);
  }
  await run('DELETE FROM sqlite_sequence').catch(() => {});
  pragma('foreign_keys = ON');

  console.log('Creating accounts…');
  const people = [
    ['admin',   null,         'Property Office Admin', 'admin@school.edu',               null,      null,   null],
    ['student', '2022-00145', 'Ana Reyes',             'ana.reyes@student.school.edu',   'BSIT',    '1-A',  null],
    ['student', '2021-00932', 'Mark Villanueva',       'mark.v@student.school.edu',      'BSBA',    '2-B',  null],
    ['student', '2023-01188', 'Joy Tabuena',           'joy.tabuena@student.school.edu', 'BSCRIM',  '3-A',  null],
    ['student', '2022-00761', 'Rico Lim',              'rico.lim@student.school.edu',    'BSHM',    '4-C',  null]
  ];
  const ids = {};
  for (const [role, no, name, email, program, section] of people) {
    const r = await run(
      `INSERT INTO users (student_no, full_name, email, program, section, password_hash, role)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [no, name, email, program, section, hash, role]);
    ids[email] = r.insertId;
  }

  const cat = async (name) => (await one('SELECT id FROM categories WHERE name = ?', [name])).id;

  console.log('Creating found items…');
  const items = [
    { ref: 'LF-2026-0001', title: 'Black folding umbrella', cat: 'Umbrellas',
      desc: 'Compact black umbrella with a wooden handle. One rib is slightly bent.',
      color: 'Black', brand: 'Fibrella', where: 'Library, 2nd floor study area',
      days: 12, secret: 'Small ink stain on the strap',
      finder: 'ana.reyes@student.school.edu', status: 'in_custody', shelf: 'Shelf A, bin 2' },

    { ref: 'LF-2026-0002', title: 'Blue Hydro Flask water bottle', cat: 'Water bottles',
      desc: 'Matte blue insulated bottle, 32oz, covered in stickers.',
      color: 'Blue', brand: 'Hydro Flask', where: 'Gymnasium bleachers',
      days: 9, secret: 'Sticker of a red panda under the lid',
      finder: 'mark.v@student.school.edu', status: 'in_custody', shelf: 'Shelf A, bin 5' },

    { ref: 'LF-2026-0003', title: 'Student ID and small wallet', cat: 'Wallets & IDs',
      desc: 'Brown leather bifold with a student ID inside. Cash was not counted.',
      color: 'Brown', brand: null, where: 'Canteen, table near the window',
      days: 6, secret: 'Jeepney fare card tucked behind the ID',
      finder: 'joy.tabuena@student.school.edu', status: 'in_custody', shelf: 'Locked drawer 1' },

    { ref: 'LF-2026-0004', title: 'Grey laptop charger', cat: 'Laptops & chargers',
      desc: '65W USB-C charger with a frayed cable near the brick.',
      color: 'Grey', brand: 'Lenovo', where: 'Room 304, under the third desk',
      days: 3, secret: 'Name written in marker on the brick',
      finder: 'rico.lim@student.school.edu', status: 'in_custody', shelf: 'Shelf B, bin 1' },

    { ref: 'LF-2026-0005', title: 'Set of keys with a green lanyard', cat: 'Keys',
      desc: 'Three keys on a ring with a green nylon lanyard.',
      color: 'Green', brand: null, where: 'Covered court entrance',
      days: 1, secret: 'A small brass bottle opener on the ring',
      finder: 'ana.reyes@student.school.edu', status: 'pending_dropoff', shelf: null },

    { ref: 'LF-2026-0006', title: 'Prescription eyeglasses in a black case', cat: 'Eyewear',
      desc: 'Thin wire frames in a hard black case.',
      color: 'Silver', brand: null, where: 'Shuttle stop, main gate',
      days: 40, secret: 'Optical shop receipt folded inside the case',
      finder: 'mark.v@student.school.edu', status: 'returned', shelf: 'Shelf A, bin 3' }
  ];

  const itemIds = {};
  for (const it of items) {
    const r = await run(`
      INSERT INTO items
        (ref_code, title, description, category_id, color, brand, found_location, found_at,
         secret_detail, finder_id, status, storage_location, received_by, received_at, released_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [it.ref, it.title, it.desc, await cat(it.cat), it.color, it.brand, it.where,
       daysAgo(it.days), it.secret, ids[it.finder], it.status, it.shelf,
       it.status === 'pending_dropoff' ? null : ids['admin@school.edu'],
       it.status === 'pending_dropoff' ? null : daysAgo(it.days - 1, 9),
       it.status === 'returned' ? daysAgo(it.days - 5, 11) : null]);
    itemIds[it.ref] = r.insertId;
  }

  console.log('Creating lost reports…');
  const lost = [
    ['LR-2026-0001', 'Blue insulated water bottle', 'Dark blue, covered in stickers. Lost after intramurals practice.',
     'Water bottles', 'Blue', 'Hydro Flask', 'Gymnasium', 10, 'joy.tabuena@student.school.edu', 'open'],
    ['LR-2026-0002', 'Silver wire eyeglasses', 'Thin silver frames in a black case. I need them to read.',
     'Eyewear', 'Silver', null, 'Main gate shuttle stop', 41, 'rico.lim@student.school.edu', 'resolved'],
    ['LR-2026-0003', 'Black umbrella', 'Small foldable umbrella, wooden handle.',
     'Umbrellas', 'Black', null, 'Library', 13, 'mark.v@student.school.edu', 'open']
  ];
  for (const [ref, title, desc, catName, color, brand, where, days, email, status] of lost) {
    await run(`
      INSERT INTO lost_reports
        (ref_code, title, description, category_id, color, brand, lost_location, lost_at, student_id, status)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [ref, title, desc, await cat(catName), color, brand, where, daysAgo(days), ids[email], status]);
  }

  console.log('Creating claims…');
  // One decided claim (the eyeglasses) and one waiting for review (the bottle).
  await run(`
    INSERT INTO claims (ref_code, item_id, claimant_id, statement, detail_answer, status,
                        admin_note, reviewed_by, reviewed_at, created_at)
    VALUES (?,?,?,?,?,'approved',?,?,?,?)`,
    ['CL-2026-0001', itemIds['LF-2026-0006'], ids['rico.lim@student.school.edu'],
     'I left them on the bench at the shuttle stop after my last class on Friday.',
     'There should be a receipt from the optical shop folded inside the case.',
     'Receipt inside the case matched the claimant name.',
     ids['admin@school.edu'], daysAgo(35, 10), daysAgo(36, 15)]);

  await run(`
    INSERT INTO claims (ref_code, item_id, claimant_id, statement, detail_answer, created_at)
    VALUES (?,?,?,?,?,?)`,
    ['CL-2026-0002', itemIds['LF-2026-0002'], ids['joy.tabuena@student.school.edu'],
     'I put it down beside the bleachers during intramurals practice and forgot it.',
     'It has a red panda sticker under the lid and a dent on the bottom rim.',
     daysAgo(2, 16)]);
  await run("UPDATE items SET status = 'on_hold' WHERE ref_code = 'LF-2026-0002'");

  console.log(`
  Done.

  Admin      admin@school.edu              / ${PASSWORD}
  Students   ana.reyes@student.school.edu  / ${PASSWORD}
             mark.v@student.school.edu     / ${PASSWORD}
             joy.tabuena@student.school.edu/ ${PASSWORD}
             rico.lim@student.school.edu   / ${PASSWORD}

  Change these before you deploy anywhere real.
  `);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});