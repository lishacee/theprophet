// Phase 7 — convert the GAS export (prophet-export.json, from exportForMigration()) into
// D1 seed SQL. Usage:  node cf/migrate.mjs prophet-export.json > seed.sql
//   then:  wrangler d1 execute prophet --remote --file=seed.sql
// Passwords carry over as-is (passHash/salt are exported) — no reset, proven by test_auth.mjs.
import { readFileSync } from 'node:fs';
import { COLS } from './src/db.js';

const path = process.argv[2];
if (!path) { console.error('usage: node cf/migrate.mjs <export.json> > seed.sql'); process.exit(1); }
const data = JSON.parse(readFileSync(path, 'utf8'));

// Sheets serialises Date cells to ISO strings and numbers to JSON numbers; D1 columns are TEXT.
function cell(v){
  if (v == null) return '';
  if (typeof v === 'object' && v.__proto__ === Object.prototype) return JSON.stringify(v); // defensive
  return String(v);
}
const sqlStr = v => "'" + cell(v).replace(/'/g, "''") + "'";

// No PRAGMA / BEGIN TRANSACTION / COMMIT: D1 rejects explicit SQL transactions (it wraps the
// file itself) and the schema has no FK constraints. Plain INSERTs only.
let out = '';
let warned = false;
for (const table of Object.keys(COLS)) {
  const rows = data[table] || [];
  if (!rows.length) continue;
  const cols = COLS[table];
  out += `-- ${table}: ${rows.length} rows\n`;
  for (const r of rows) {
    // ponytail: a 'score' cell that Sheets coerced to a Date exports as an ISO string, not "H-A".
    // Rare; flag once so it can be hand-fixed post-import rather than silently wrong.
    if (table === 'Matches' && /^\d{4}-\d{2}-\d{2}T/.test(String(r.score || '')) && !warned) {
      console.error('WARN: some Matches.score look ISO-coerced (Sheets bug) — review after import.'); warned = true;
    }
    out += `INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(c => sqlStr(r[c])).join(',')});\n`;
  }
}
process.stdout.write(out);
