# Prophet 101 — Cloudflare migration

Moves the app off Google Apps Script (iframe → Safari session bug) onto:
**GitHub Pages (frontend) → Cloudflare Worker (API) → D1 (SQLite DB) → Cron (settlement)**.
All free tier, commercial-use allowed, minute-level cron. Auth stays token-in-body
(first-party localStorage on `*.github.io`), so Safari keeps the session.

## Status — all phases ported ✅
- [x] **Phase 1** — scaffold, D1 schema (9 tables), data-access layer, auth, router+CORS
- [x] **Phase 2** — pools + bets (`placeBet` atomic-guarded deduct) + join + matches
- [x] **Phase 3** — leaderboard + badges + history + crowd
- [x] **Phase 4** — odds catalog + refresh + settlement + corner/card SofaScore + cron wired
- [x] **Phase 5** — admin (custom markets, manual settle, pool CRUD, members, import)
- [x] **Phase 6** — frontend `srun` → `fetch` (single-point swap in `../Index.html`, backward-compatible)
- [x] **Phase 7** — data migration (`exportForMigration()` in GAS → `migrate.mjs` → seed SQL)

Modules: `db.js` (D1 access) · `auth.js` · `core.js` (config + pure logic + labels) ·
`pools.js` · `social.js` · `odds.js` · `settle.js` · `admin.js` · `api.js` (OddsPapi/SofaScore) ·
`index.js` (router + cron).

Tests (all green): `test_auth.mjs` (hash == GAS), `test_core.mjs` (pure logic vs `_selfCheck`),
`test_worker.mjs` (auth→join→bet→overspend-rollback→settle end-to-end on real SQLite via node:sqlite).

## First-time setup
```sh
npm i -g wrangler
wrangler login
wrangler d1 create prophet           # paste database_id into wrangler.toml
wrangler d1 execute prophet --file=./schema.sql --remote
wrangler secret put ODDSPAPI_KEY
wrangler secret put ODDSPAPI_KEY_BACKUP
# ADMINS as a plain var is fine; set as secret if you prefer:
wrangler secret put ADMINS           # e.g. "thang,someadmin"
# edit wrangler.toml -> ALLOW_ORIGIN = "https://<you>.github.io"
wrangler deploy
```

## Everyday workflow

| Change | Command | Effect |
|---|---|---|
| Backend `src/*.js` | `wrangler deploy` | instant |
| Frontend `../index.html` | `git push` → hard reload | ~1 min (Pages build) |
| Schema `schema.sql` | `wrangler d1 execute prophet --remote --file=schema.sql` | instant |
| Secret (API key) | `wrangler secret put NAME` | instant |
| Var (`ALLOW_ORIGIN`/`ADMINS`) | edit `wrangler.toml` → `wrangler deploy` | instant |

```sh
bash test.sh          # run all tests (do this before every backend deploy)
wrangler deploy       # ship the Worker
bash verify.sh        # non-destructive live check (Worker+D1+CORS+auth-gate)
wrangler tail         # live logs — the GAS "Executions" replacement (watch cron/settlement)
```

## Local dev
```sh
wrangler d1 execute prophet --local --file=./schema.sql   # seed local SQLite
wrangler dev                          # Worker + D1 on localhost:8787
WORKER=http://localhost:8787 ORIGIN=http://localhost bash verify.sh
```

## Frontend (GitHub Pages)
Publish `../Index.html` to GitHub Pages, then set `WORKER_URL` near the top of its script to
your deployed Worker URL (e.g. `https://the-prophet.<sub>.workers.dev`). Leaving it `''` keeps
the file working on the old Apps Script deploy, so you can cut over without a flag day. Set
`ALLOW_ORIGIN` in `wrangler.toml` to your Pages origin so CORS matches.

## Smoke-test Phases 2–3 (against `wrangler dev`)
```sh
B=http://localhost:8787
post(){ curl -sX POST $B -d "$1"; echo; }
post '{"fn":"register","args":["admin1","pw12","Admin"]}'         # copy token -> T
post '{"fn":"getPools","args":["<T>"]}'                            # [] until an open pool exists
# after an admin creates+opens a pool (Phase 5) and imports matches (Phase 4/5):
post '{"fn":"joinPool","args":["<T>","<poolId>",""]}'
post '{"fn":"getPoolView","args":["<T>","<poolId>"]}'              # matches+leaderboard+history in one call
post '{"fn":"placeBet","args":["<T>","<poolId>","<fixtureId>","1x2","<oid>",200]}'
```
Note: `placeBet`/`getMatches` need odds + matches rows, which land in Phase 4/5 (or via
Phase 7 data import). Until then, seed a row manually with `wrangler d1 execute` to exercise them.

## Verify Phase 1 (auth round-trips, session survives Safari)
```sh
curl -sX POST http://localhost:8787 -d '{"fn":"register","args":["alice","pw12","Alice"]}'
# -> {"ok":true,"data":{"username":"alice","token":"...","isAdmin":false}}
curl -sX POST http://localhost:8787 -d '{"fn":"login","args":["alice","pw12"]}'
curl -sX POST http://localhost:8787 -d '{"fn":"resume","args":["<token>"]}'
```

## Data migration (Phase 7, preview)
Existing passwords need **no reset** — the Worker hash is bit-identical to GAS's
(SHA-256 + base64), proven by `test_auth.mjs`. Migration = dump each sheet to JSON
(`google.script.run` export or File→Download→CSV) → generate `INSERT`s → `wrangler d1 execute`.
Script lands in Phase 7.
