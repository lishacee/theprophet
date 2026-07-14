// End-to-end smoke test of the Worker DB flows against real SQLite (node:sqlite), via a
// thin D1-compatible shim. Exercises auth + admin + pools + bets (incl. the atomic overspend
// guard and rollback) + leaderboard — the paths the pure-logic tests can't reach.
// Run: node cf/test_worker.mjs
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import * as auth from './src/auth.js';
import * as pools from './src/pools.js';
import * as social from './src/social.js';
import * as admin from './src/admin.js';
import { apiGet } from './src/api.js';
import { settleMatches } from './src/settle.js';
import * as C from './src/core.js';

// D1 shim: prepare().bind().first()/.all()/.run() + batch() over node:sqlite.
function d1(db){
  return {
    prepare(sql){ return {
      _p: [],
      bind(...a){ this._p = a; return this; },
      async first(){ const r = db.prepare(sql).get(...this._p); return r === undefined ? null : r; },
      async all(){ return { results: db.prepare(sql).all(...this._p) }; },
      async run(){ const r = db.prepare(sql).run(...this._p); return { meta: { changes: r.changes } }; },
    }; },
    async batch(stmts){ return Promise.all(stmts.map(s => s.all())); },
  };
}
const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const env = { DB: d1(raw), ADMINS: 'boss' };

// seed a match + odds directly (avoids the OddsPapi network path)
function seedMatchOdds(poolId){
  const kickoff = new Date(Date.now() + 6 * 3600000).toISOString(); // 6h out -> open
  raw.prepare(`INSERT INTO Matches(poolId,fixtureId,tournamentId,team1,team2,kickoff,included) VALUES(?,?,?,?,?,?,?)`)
     .run(poolId, 'f1', '16', 'Spain', 'Brazil', kickoff, 'Y');
  const odds = JSON.stringify({ m1x2: { marketId: 101, home: { oid: 101, price: 2.0 }, draw: { oid: 102, price: 3.0 }, away: { oid: 103, price: 4.0 } } });
  raw.prepare(`INSERT INTO Odds(bookmaker,fixtureId,oddsJson,updatedAt,prevOddsJson,lastFetchAt) VALUES(?,?,?,?,?,?)`)
     .run('pinnacle', 'f1', odds, new Date().toISOString(), '', new Date().toISOString());
}

const boss = await auth.register(env, 'boss', 'pw12', 'Boss');
assert.ok(boss.isAdmin, 'boss is admin (ADMINS=boss)');
const alice = await auth.register(env, 'alice', 'pw12', 'Alice');
assert.strictEqual(alice.isAdmin, false, 'alice not admin');

// login + resume round-trip
const relog = await auth.login(env, 'alice', 'pw12');
const resumed = await auth.resume(env, relog.token);
assert.strictEqual(resumed.username, 'alice', 'resume returns alice');
alice.token = relog.token; // login rotates the token — the register-time one is now invalid
await assert.rejects(auth.login(env, 'alice', 'wrong'), /Sai tên đăng nhập hoặc mật khẩu/, 'bad password rejected');

// changePassword: wrong old rejected; correct old rotates token + swaps password
await assert.rejects(auth.changePassword(env, alice.token, 'nope', 'pw34'), /hiện tại không đúng/, 'wrong old password rejected');
const cp = await auth.changePassword(env, alice.token, 'pw12', 'pw34');
assert.ok(cp.token && cp.token !== alice.token, 'changePassword rotates token');
await assert.rejects(auth.login(env, 'alice', 'pw12'), /Sai tên đăng nhập hoặc mật khẩu/, 'old password no longer works');
const relog2 = await auth.login(env, 'alice', 'pw34');
assert.ok(relog2.token, 'new password works');
alice.token = relog2.token; // login rotated token again -> downstream tests reuse the current one
await assert.rejects(auth.register(env, 'ALICE', 'pw12', 'Alice2'), /đã tồn tại/, 'dup username (UNIQUE, case-insensitive) rejected');

// legacy SHA-256 password verifies AND is transparently upgraded to PBKDF2 on login
const legacyHash = btoa(String.fromCharCode(...new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode('pw12' + '|' + 'oldsalt')))));
raw.prepare(`INSERT INTO Users(username,userLower,passHash,salt,nickname,token,tokenExp,createdAt) VALUES(?,?,?,?,?,?,?,?)`)
   .run('carl', 'carl', legacyHash, 'oldsalt', 'Carl', 't-carl', String(Date.now() + 86400000), new Date().toISOString());
const carlLogin = await auth.login(env, 'carl', 'pw12');
assert.ok(carlLogin.token, 'legacy SHA-256 password still logs in');
const carlRow = raw.prepare(`SELECT passHash FROM Users WHERE userLower=?`).get('carl');
assert.ok(carlRow.passHash.startsWith('pbkdf2$'), 'legacy hash upgraded to PBKDF2 on login');
await assert.rejects(auth.login(env, 'carl', 'wrong'), /Sai tên đăng nhập hoặc mật khẩu/, 'wrong password still rejected after upgrade');

// admin reset password: admin sets carl a new password (no old pw needed); old stops working
await assert.rejects(auth.adminResetPassword(env, alice.token, 'carl', 'newpw99'), /quyền admin/, 'non-admin cannot reset');
await assert.rejects(auth.adminResetPassword(env, boss.token, 'ghost', 'newpw99'), /Không tìm thấy user/, 'reset unknown user rejected');
await assert.rejects(auth.adminResetPassword(env, boss.token, 'carl', 'x'), /4–64 ký tự/, 'short new password rejected');
await auth.adminResetPassword(env, boss.token, 'carl', 'newpw99');
await assert.rejects(auth.login(env, 'carl', 'pw12'), /Sai tên đăng nhập hoặc mật khẩu/, 'old password dead after admin reset');
assert.ok((await auth.login(env, 'carl', 'newpw99')).token, 'admin-set password works');

// admin creates + opens a pool
const { poolId } = await admin.adminCreatePool(env, boss.token, { name: 'WC2026' });
await admin.adminSetStatus(env, boss.token, poolId, 'open');
seedMatchOdds(poolId);
await assert.rejects(admin.adminCreatePool(env, alice.token, { name: 'x' }), /quyền admin/, 'non-admin blocked');

// alice joins: 1 future match -> start = round(1*400*1.1) = 440
const j = await pools.joinPool(env, alice.token, poolId, '');
assert.strictEqual(j.startingPoints, 440, 'starting points 440');

// place a valid bet: 1x2 home, stake 200 (min = 400/2)
const b1 = await pools.placeBet(env, alice.token, poolId, 'f1', '1x2', 101, 200);
assert.strictEqual(b1.currentPoints, 240, 'balance 440-200=240');
assert.strictEqual(b1.lockedOdds, 2.0, 'locked home odds');

// overspend: stake 400 (<= maxStake, within cover rules) but balance only 240 -> reject + rollback
await assert.rejects(pools.placeBet(env, alice.token, poolId, 'f1', '1x2', 103, 400), /Không đủ điểm/, 'overspend rejected');
const betCount = raw.prepare(`SELECT count(*) n FROM Bets WHERE user='alice'`).get().n;
assert.strictEqual(betCount, 1, 'failed bet rolled back (still 1 bet)');
const bal = Number(raw.prepare(`SELECT currentPoints c FROM Memberships WHERE user='alice'`).get().c);
assert.strictEqual(bal, 240, 'balance unchanged after rolled-back bet');

// stake not a multiple of minStake
await assert.rejects(pools.placeBet(env, alice.token, poolId, 'f1', 'ou', 1, 150), /bội số/, 'bad stake step rejected');

// leaderboard reflects alice
const lb = await social.getLeaderboard(env, alice.token, poolId);
assert.strictEqual(lb.length, 1, 'one member');
assert.strictEqual(lb[0].points, 240, 'lb points 240');

// getPools: GROUP BY count + per-user (indexed) lookup
const pl = (await pools.getPools(env, alice.token)).find(p => p.poolId === poolId);
assert.ok(pl && pl.joined && pl.members === 1 && pl.currentPoints === 240, 'getPools: joined, 1 member, 240pts');
// getMatches: odds scoped to horizon fixtures via IN-list
const mv = await pools.getMatches(env, alice.token, poolId);
assert.ok(mv.matches.length === 1 && mv.matches[0].odds.m1x2.home.price === 2.0, 'getMatches: f1 odds via IN-list');
assert.strictEqual(mv.matches[0].myBets.length, 1, 'getMatches: my 1x2 bet present');
// getCrowd: per-fixture PK odds lookup; alice bet -> unlocked, open
const cr = await social.getCrowd(env, alice.token, poolId, 'f1');
assert.ok(!cr.locked && cr.open && cr.agg.some(a => a.marketType === '1x2'), 'getCrowd: unlocked, 1x2 aggregate');

// admin manual-settle the 1x2 market: home wins -> alice WIN, payout 200*2=400
await admin.adminSettleStdMarket(env, boss.token, poolId, 'f1', '1x2', 101);
const afterBal = Number(raw.prepare(`SELECT currentPoints c FROM Memberships WHERE user='alice'`).get().c);
assert.strictEqual(afterBal, 240 + 400, 'settle credited payout 400 -> 640');
// re-settle to away (delta): reverse old 400, alice now LOSS -> 640-400=240
await admin.adminSettleStdMarket(env, boss.token, poolId, 'f1', '1x2', 103);
const reBal = Number(raw.prepare(`SELECT currentPoints c FROM Memberships WHERE user='alice'`).get().c);
assert.strictEqual(reBal, 240, 're-settle uses delta (no double-credit) -> back to 240');

// ---- Custom market MULTI-WINNER settle (overlapping props: A/B/C, A & C both win) ----
const { cid } = await admin.adminAddMarket(env, boss.token, poolId, 'f1', 'Ronaldo hôm nay?',
  [{ label:'Ghi bàn', price:2.0 }, { label:'Kiến tạo', price:2.0 }, { label:'Ghi bàn & kiến tạo', price:2.0 }]);
const mt = 'c_' + cid;
// 3 bets 100@2.0 on oids 0/1/2 (insert directly — isolates settle math from stake/cover rules)
[['bA','0'],['bB','1'],['bC','2']].forEach(([id, oid]) =>
  raw.prepare(`INSERT INTO Bets(betId,poolId,user,fixtureId,marketType,outcomeId,stake,lockedOdds,placedAt) VALUES(?,?,?,?,?,?,?,?,?)`)
     .run(id, poolId, 'alice', 'f1', mt, oid, '100', '2.0', new Date().toISOString()));
const base = Number(raw.prepare(`SELECT currentPoints c FROM Memberships WHERE user='alice'`).get().c);

// settle winners [0,2] -> A & C win (+200 each), B loses
await admin.adminSettleMarket(env, boss.token, poolId, 'f1', cid, ['0', '2']);
assert.strictEqual(raw.prepare(`SELECT result r FROM CustomMarkets WHERE cid=?`).get(cid).r, '0,2', 'result stores winner set "0,2"');
assert.strictEqual(raw.prepare(`SELECT result r FROM Bets WHERE betId='bA'`).get().r, 'WIN', 'A wins');
assert.strictEqual(raw.prepare(`SELECT result r FROM Bets WHERE betId='bB'`).get().r, 'LOSS', 'B loses');
assert.strictEqual(raw.prepare(`SELECT result r FROM Bets WHERE betId='bC'`).get().r, 'WIN', 'C wins');
assert.strictEqual(Number(raw.prepare(`SELECT currentPoints c FROM Memberships WHERE user='alice'`).get().c), base + 400, 'A+C paid 200 each -> +400');

// re-settle to [2] only (delta): A reverses -200, C stays
await admin.adminSettleMarket(env, boss.token, poolId, 'f1', cid, ['2']);
assert.strictEqual(Number(raw.prepare(`SELECT currentPoints c FROM Memberships WHERE user='alice'`).get().c), base + 200, 're-settle drops A -> +200');

// deselect all -> NONE (settled, everyone loses); C reverses -200
await admin.adminSettleMarket(env, boss.token, poolId, 'f1', cid, []);
assert.strictEqual(raw.prepare(`SELECT result r FROM CustomMarkets WHERE cid=?`).get(cid).r, 'NONE', 'empty winners -> NONE (still settled)');
assert.strictEqual(Number(raw.prepare(`SELECT currentPoints c FROM Memberships WHERE user='alice'`).get().c), base, 'all-lose -> back to base');

// ---- Clone custom market across pools (snapshot + provenance + settle suggestion) ----
const B = await admin.adminCreatePool(env, boss.token, { name: 'Pool B' });
// same fixture f1 in pool B, PAST kickoff so it shows in history; odds are shared by fixtureId (already seeded)
raw.prepare(`INSERT INTO Matches(poolId,fixtureId,tournamentId,team1,team2,kickoff,included) VALUES(?,?,?,?,?,?,?)`)
   .run(B.poolId, 'f1', '16', 'Spain', 'Brazil', new Date(Date.now() - 3600000).toISOString(), 'Y');

const clonable = await admin.adminListClonableMarkets(env, boss.token, B.poolId, 'f1');
const srcMkt = clonable.filter(c => c.srcCid === cid)[0];
assert.ok(srcMkt, 'source market from pool A is clonable into B');
assert.strictEqual(srcMkt.already, false, 'not yet cloned');
assert.strictEqual(srcMkt.outcomes.length, 3, 'source outcomes carried for preview');

const cloned = await admin.adminCloneMarkets(env, boss.token, B.poolId, 'f1', [{ srcPool: poolId, srcCid: cid }]);
assert.strictEqual(cloned.n, 1, 'cloned 1 market');
const bRow = raw.prepare(`SELECT * FROM CustomMarkets WHERE poolId=? AND srcCid=?`).get(B.poolId, cid);
assert.ok(bRow && bRow.cid !== cid, 'clone has a fresh cid');
assert.strictEqual(bRow.srcPool, poolId, 'provenance srcPool recorded');
assert.strictEqual(JSON.parse(bRow.outcomesJson).map(o => o.oid).join(','), '0,1,2', 'oids preserved verbatim for result mapping');
assert.strictEqual(bRow.result || '', '', 'clone starts unsettled');

const clonable2 = await admin.adminListClonableMarkets(env, boss.token, B.poolId, 'f1');
assert.strictEqual(clonable2.filter(c => c.srcCid === cid)[0].already, true, 'soft guard: source now flagged already-cloned');

// settle suggestion: set source result -> getHistory(B) surfaces srcResult on the unsettled clone
await admin.adminSettleMarket(env, boss.token, poolId, 'f1', cid, ['0', '2']);
const histB = await social.getHistory(env, boss.token, B.poolId);
const cmB = histB.filter(r => r.fixtureId === 'f1')[0].customMarkets.filter(c => c.cid === bRow.cid)[0];
assert.strictEqual(cmB.srcResult, '0,2', 'clone carries source result as settle suggestion');

// soft guard is UI-only: backend still allows an override re-clone (fresh copy)
const again = await admin.adminCloneMarkets(env, boss.token, B.poolId, 'f1', [{ srcPool: poolId, srcCid: cid }]);
assert.strictEqual(again.n, 1, 'backend allows override re-clone (soft guard)');
assert.strictEqual(raw.prepare(`SELECT count(*) n FROM CustomMarkets WHERE poolId=? AND srcCid=?`).get(B.poolId, cid).n, 2, 'two copies after override');

// ---- Admin manual point adjustment + transparency feed ----
const adjPre = Number(raw.prepare(`SELECT currentPoints c FROM Memberships WHERE poolId=? AND user='alice'`).get(poolId).c);
await assert.rejects(admin.adminAdjustPoints(env, alice.token, poolId, 'alice', 100, 'x'), /quyền admin/, 'non-admin cannot adjust');
await assert.rejects(admin.adminAdjustPoints(env, boss.token, poolId, 'alice', 0, 'x'), /không hợp lệ/, 'zero delta rejected');
await assert.rejects(admin.adminAdjustPoints(env, boss.token, poolId, 'alice', 100, '  '), /Cần lý do/, 'empty reason rejected');
await assert.rejects(admin.adminAdjustPoints(env, boss.token, poolId, 'ghost', 100, 'x'), /Không tìm thấy thành viên/, 'unknown member rejected');
await admin.adminAdjustPoints(env, boss.token, poolId, 'alice', 500, 'thắng minigame');
await admin.adminAdjustPoints(env, boss.token, poolId, 'alice', -200, 'sửa nhầm khi chấm');
assert.strictEqual(Number(raw.prepare(`SELECT currentPoints c FROM Memberships WHERE poolId=? AND user='alice'`).get(poolId).c), adjPre + 300, 'adjust applies signed deltas as net +300 (delta-only, no re-sum)');
const feed = await social.getAdjustments(env, alice.token, poolId);
assert.strictEqual(feed.length, 2, 'feed shows both adjustments (member-visible)');
assert.deepStrictEqual(feed.map(f => f.delta).sort((a, b) => a - b), [-200, 500], 'feed carries both signed deltas');
assert.strictEqual(feed[0].nickname, 'Alice', 'feed nick-maps recipient');
assert.ok(!('byAdmin' in feed[0]), 'feed hides admin identity');

// ---- Configurable maxStake: guard >= minStake, empty reverts to default ----
await assert.rejects(admin.adminUpdatePool(env, boss.token, poolId, { maxStake: 10 }), /Max cược phải ≥/, 'maxStake below minStake rejected');
const poolRowNow = () => raw.prepare(`SELECT * FROM Pools WHERE poolId=?`).get(poolId);
await admin.adminUpdatePool(env, boss.token, poolId, { maxStake: 5000 });
assert.strictEqual(C.poolCfg(poolRowNow()).maxStake, 5000, 'configured maxStake wins over derived ppm*2');
await admin.adminUpdatePool(env, boss.token, poolId, { maxStake: '' });
assert.strictEqual(C.poolCfg(poolRowNow()).maxStake, 400 * 2, 'blank maxStake reverts to ppm*2 default');

// ---- Seasons: end-season snapshots the leaderboard into the hall of fame, then resets ----
assert.deepStrictEqual(await social.getSeasons(env, alice.token, poolId), [], 'no seasons yet');
const es = await admin.adminEndSeason(env, boss.token, poolId, 'Mùa test');
assert.strictEqual(es.champion.nickname, 'Alice', 'champion snapshot = top member');
const seasons = await social.getSeasons(env, alice.token, poolId);
assert.strictEqual(seasons.length, 1, 'one season stored');
assert.strictEqual(seasons[0].name, 'Mùa test', 'season name kept');
assert.strictEqual(seasons[0].champion.nickname, 'Alice', 'hall-of-fame champion');
assert.strictEqual(Number(raw.prepare(`SELECT currentPoints c FROM Memberships WHERE user='alice'`).get().c), es.startingPoints, 'points reset to new-season start');
assert.strictEqual(raw.prepare(`SELECT count(*) n FROM Bets WHERE poolId=?`).get(poolId).n, 0, 'bets cleared on new season');
await assert.rejects(admin.adminEndSeason(env, alice.token, poolId, 'x'), /quyền admin/, 'non-admin cannot end season');
await assert.rejects(admin.adminEndSeason(env, boss.token, poolId, ''), /Cần tên mùa/, 'season needs a name');

// ---- OddsPapi key rotation + GAS proxy envelope ----
{
  const realFetch = globalThis.fetch;
  // status + a JSON string body (mirrors a real HTTP response: .text() is a string, .json() parses it)
  const httpResp = (status, jsonStr) => ({ status, headers: { get: () => null },
    text: async () => jsonStr, json: async () => JSON.parse(jsonStr) });

  // DIRECT path: dead key #1 (403) -> auto-fall to working key #2
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(url);
    if (url.includes('apiKey=DEADKEY')) return httpResp(403, '"Forbidden"');
    if (url.includes('apiKey=GOODKEY')) return httpResp(200, '{"ok":1}');
    return httpResp(500, '"unexpected"');
  };
  assert.deepStrictEqual(await apiGet({ ODDSPAPI_KEYS: 'DEADKEY,GOODKEY' }, '/x'), { ok: 1 }, 'direct: rotation returns data from 2nd key');
  assert.ok(seen.some(u => u.includes('DEADKEY')) && seen.some(u => u.includes('GOODKEY')), 'direct: tried dead then good key');
  await assert.rejects(apiGet({ ODDSPAPI_KEYS: 'DEADKEY,DEADKEY' }, '/x'), /hết 2 key khả dụng/, 'direct: all-dead lists both keys');

  // PROXY path: proxy always HTTP 200 but wraps OddsPapi's real status in {status,body};
  // apiGet must unwrap it (so a wrapped 403 still rotates to the good key).
  const proxied = [];
  globalThis.fetch = async (url) => {
    if (!url.startsWith('https://proxy.local/exec')) throw new Error('proxy path must not hit OddsPapi directly: ' + url);
    proxied.push(url);
    const inner = decodeURIComponent((url.match(/[?&]path=([^&]+)/) || [])[1] || '');
    assert.ok((url.match(/[?&]t=SEKRET(&|$)/)), 'proxy call carries the shared token');
    if (inner.includes('apiKey=DEADKEY')) return httpResp(200, JSON.stringify({ status: 403, body: '"Forbidden"' }));
    return httpResp(200, JSON.stringify({ status: 200, body: '{"ok":9}' }));
  };
  const env = { ODDSPAPI_KEYS: 'DEADKEY,GOODKEY', ODDSPAPI_PROXY: 'https://proxy.local/exec', ODDSPAPI_PROXY_TOKEN: 'SEKRET' };
  assert.deepStrictEqual(await apiGet(env, '/x'), { ok: 9 }, 'proxy: unwraps envelope + rotates past wrapped 403');
  assert.ok(proxied.length >= 2, 'proxy: routed both keys through the proxy');

  globalThis.fetch = realFetch;
}

// ---- Cron settleMatches: same fixture in 2 pools settles from ONE shared score fetch (no divergence) ----
{
  const realFetch = globalThis.fetch;
  const raw2 = new DatabaseSync(':memory:');
  raw2.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const env2 = { DB: d1(raw2), ODDSPAPI_KEYS: 'GOODKEY' };

  const past = new Date(Date.now() - 3 * 3600000).toISOString(); // 3h ago -> past the 100-min settle gate
  for (const pid of ['pA', 'pB']) {
    raw2.prepare(`INSERT INTO Matches(poolId,fixtureId,tournamentId,team1,team2,kickoff,included,settled) VALUES(?,?,?,?,?,?,?,?)`)
       .run(pid, 'fx', '16', 'France', 'Morocco', past, 'Y', '');
    raw2.prepare(`INSERT INTO Memberships(poolId,user,joinAt,startingPoints,currentPoints) VALUES(?,?,?,?,?)`)
       .run(pid, 'alice', past, '1000', '900'); // 100 already staked below
    raw2.prepare(`INSERT INTO Bets(betId,poolId,user,fixtureId,marketType,marketId,outcomeId,stake,lockedOdds) VALUES(?,?,?,?,?,?,?,?,?)`)
       .run(pid + '_b', pid, 'alice', 'fx', '1x2', '101', '101', '100', '2.0'); // home win @2.0
  }

  let scoreFetches = 0;
  globalThis.fetch = async (url) => {
    if (!String(url).includes('/scores')) throw new Error('unexpected fetch: ' + url);
    scoreFetches++;
    return { status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ scores: { periods: { fulltime: { participant1Score: 2, participant2Score: 0 } } } }) };
  };
  await settleMatches(env2);
  globalThis.fetch = realFetch;

  assert.strictEqual(scoreFetches, 1, 'score fetched ONCE for the fixture despite 2 pools (no duplicate /scores)');
  for (const pid of ['pA', 'pB']) {
    assert.strictEqual(raw2.prepare(`SELECT settled s FROM Matches WHERE poolId=?`).get(pid).s, 'Y', pid + ' settled');
    assert.strictEqual(raw2.prepare(`SELECT result r FROM Bets WHERE poolId=?`).get(pid).r, 'WIN', pid + ' bet WIN (2-0 home)');
    assert.strictEqual(Number(raw2.prepare(`SELECT currentPoints c FROM Memberships WHERE poolId=?`).get(pid).c), 1100, pid + ' credited 200 payout -> 1100');
  }
}

console.log('OK — Worker DB flows: auth, admin gate, join, bet, overspend rollback, leaderboard, delta re-settle, multi-winner custom settle, oddspapi key rotation.');
