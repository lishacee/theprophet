# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**The Prophet** — a private, mobile-first football-prediction game where a group of friends
bet **virtual points** (no real money, WC2026-style pools). Players place bets before kickoff
across markets (1X2, O/U, Asian handicap, corners, cards, BTTS, custom); the system auto-settles
(or an admin settles by hand) and updates leaderboard, badges, streaks, and per-season standings.
UI copy and business-error messages are **Vietnamese** and shown to users verbatim. See `PRODUCT.md`
(product/tone) and `DESIGN.md` (design tokens/themes: Neon Pitch dark + Candy Pop light).

## Architecture

Migrated off Google Apps Script (Safari iframe session bug) to all-free-tier Cloudflare:

```
index.html (GitHub Pages, single-file SPA)
   → srun(fn, ...args)  POST {fn, args:[]} as text/plain (no CORS preflight)
      → CloudFront reverse-proxy (bypasses corporate SWG block)
         → Cloudflare Worker  cf/src/index.js  (RPC router + cron)
            → D1 (SQLite)  via cf/src/db.js
```

- **RPC, not REST.** The client calls one endpoint with `{fn, args}`. `cf/src/index.js`'s `REGISTRY`
  maps each `fn` name to a handler. To add a backend call: add the handler in the right module,
  register it in `REGISTRY`, then call it via `srun('fn', ...)` from `index.html`. Response is
  always `{ok:true,data}` or `{ok:false,error}` — `error` is a Vietnamese message the UI displays as-is.
- **Auth is token-in-body**, stored in first-party `localStorage` (not cookies) — this is what
  survives Safari. Every non-auth handler takes `token` as its first arg and resolves it via
  `authUser`/`requireAdmin` in `auth.js`. Password hash is bit-identical to the old GAS hash
  (SHA-256+base64), with PBKDF2 auto-rehash on login for legacy accounts.
- **db.js mirrors the old Google Sheets helpers** (`readAll`/`findRow`/`findRows`/`appendRow`/
  `updateRow`/`cached`). `COLS` defines column order per table so `appendRow(table, [positional])`
  stays a verbatim port. Everything is stored as **TEXT** (Sheets legacy) — coerce when reading.
  9 tables + `Cache` (backs both script-properties and TTL caching). Schema in `cf/schema.sql`.
- **core.js holds the pure business logic** (`poolCfg`, `badgeEval`, `buildOdds`, `gradeExtra`,
  `gradeBtts`, odds/line math, label maps). Pure functions are exported so `test_core.mjs` can
  check them against the original GAS `_selfCheck` on Node.

### Backend modules (`cf/src/`)
`index.js` router+cron · `auth.js` · `core.js` (config + pure logic + labels) · `db.js` (D1 access) ·
`pools.js` (getPools/join/matches/**placeBet**/getPoolView) · `social.js` (leaderboard/badges/history/crowd/seasons) ·
`odds.js` (catalog refresh + import) · `settle.js` (auto-settle + no-show penalty) ·
`admin.js` (custom/clone markets, manual settle, pool CRUD, members, import) ·
`api.js` (OddsPapi odds + SofaScore corner/card stats, via `SOFASCORE_PROXY`/ScraperAPI).

### Cron (in `index.js` `scheduled()`, branched by cron expression)
`*/5` settle matches · `*/15` refresh odds + apply no-show penalty · `0 */6` daily fixture import.

### Points integrity (invariant — do not break)
Points are adjusted by **delta only** (`addPoints`), never recomputed by re-summing, so settle/edit/
re-settle never double-counts. `placeBet` deducts stake atomically with an overspend guard/rollback
(covered by `test_worker.mjs`). Settlement is idempotent. When touching settle/edit/refund paths,
preserve this: one settlement = one delta, refund before re-settle.

## Commands

All backend commands run from `cf/`.

```sh
bash test.sh          # run all 3 test suites — ALWAYS before a backend deploy
wrangler deploy       # ship the Worker (backend changes are instant)
bash verify.sh        # non-destructive live check (Worker+D1+CORS+auth-gate)
wrangler tail         # live logs (the GAS "Executions" replacement; watch cron/settlement)

node --test test_worker.mjs   # run a single suite (also test_auth.mjs / test_core.mjs)

# Local dev
wrangler d1 execute prophet --local --file=./schema.sql   # seed local SQLite
wrangler dev                                              # Worker+D1 on :8787
WORKER=http://localhost:8787 ORIGIN=http://localhost bash verify.sh
```

Tests use Node's built-in `node:sqlite` + `node:test` (no framework). `test_worker.mjs` runs
auth→join→bet→overspend-rollback→settle end-to-end against real SQLite.

| Change | Command | Effect |
|---|---|---|
| Backend `cf/src/*.js` | `wrangler deploy` | instant |
| Frontend `index.html` | `git push` → hard reload | ~1 min (Pages build) |
| Schema `cf/schema.sql` | `wrangler d1 execute prophet --remote --file=schema.sql` | instant |
| Secret / var | `wrangler secret put NAME` / edit `wrangler.toml` + deploy | instant |

Secrets (never in `wrangler.toml`): `ODDSPAPI_KEY`, `ODDSPAPI_KEY_BACKUP`, `SOFASCORE_PROXY`,
`SCRAPERAPI_KEY`. `ADMINS` (comma-separated usernames) and `ALLOW_ORIGIN` are plain vars.

## Frontend

`index.html` is a **single-file vanilla-JS SPA** (~2200 lines, no build step, no framework).
`WORKER_URL` near the top points at the CloudFront proxy. A `MOCK` layer (`?mock=1`, or auto-on
inside Claude Artifacts/sandboxes where CSP blocks fetch) returns canned data so every screen
renders offline — keep `mockRun` shapes in sync with real Worker responses when adding calls.

## Gotchas / project knowledge

- **OddsPapi `/settlements` gaps:** it never grades corner/card markets (would hang match settlement)
  or BTTS (mid 104) — we self-compute those from the score/SofaScore stats. See `gradeExtra`/`gradeBtts`.
- **Custom-market outcome cap is 12** (frontend grid + `admin.js`); keep both in sync if changed.
- **`DEFAULT_BOOKMAKER='pinnacle'`** for WC coverage (has AH .0/.5, corners, cards).
- **`SELECT *` is intentional** in `db.js` and the query helpers — rows map to `COLS`-shaped
  objects and `appendRow` relies on column order. Don't "optimize" to explicit column lists.
- **D1 is the perf floor** (~200ms/query cross-region; every `await env.DB.*` = one serial round-trip).
  Levers, in order: (1) `db.batch([...])` independent reads into one round-trip (`getMatches_`/
  `getHistory_`/`getCrowd`/`badgesForPool`); dependent reads (Odds needs Matches' `fixtureId`) go to a
  2nd phase. (2) Prefetch once, pass as context — `betLabel(…, ctx={catalog,cmByCid})`, nick-map from
  one `Users` read — never `findRow`/`midLine` in a per-bet loop. (3) `IN (...)` for one-table fan-out.
  New read path → batch its independent reads from the start.
- Perf triage: `console.log('[timing]', Date.now()-t)` + `wrangler tail` splits server vs proxy time;
  `wrangler d1 insights` for slow queries.
- Never commit secrets: `api-key.txt`, `.dev.vars`, `prophet-export.json`, `seed.sql` are gitignored
  (the last two contain user passHash/salt/token dumps).
