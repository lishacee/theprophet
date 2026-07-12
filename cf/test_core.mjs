// Regression for the pure logic ported into core.js (mirrors Code.js _selfCheck for the
// functions that live here) + badgeEval/oddsMoves/stdOutcomes. Run: node cf/test_core.mjs
import assert from 'node:assert';
import * as C from './src/core.js';
const eq = (a, b, m) => assert.strictEqual(a, b, m);

// numOr / poolCfg
eq(C.numOr('', 7), 7, 'numOr blank');
eq(C.numOr('0', 7), 7, 'numOr zero');
eq(C.numOr('5', 7), 5, 'numOr valid');
const cfg = C.poolCfg({ pointsPerMatch: '500', startMultiplier: '' });
eq(cfg.pointsPerMatch, 500, 'ppm');
eq(cfg.startMultiplier, C.START_MULTIPLIER, 'mult fallback');
eq(cfg.minStake, 250, 'min derive');
eq(cfg.maxStake, 1000, 'max derive');
eq(cfg.noshowPenalty, 250, 'penalty derive');
eq(C.poolCfg({}).maxStake, C.POINTS_PER_MATCH * 2, 'default max');

// poolLocked / isBlocked
eq(C.poolLocked({ requirePassword: 'Y', joinPassword: '1234' }), true, 'locked yes');
eq(C.poolLocked({ requirePassword: 'Y', joinPassword: '' }), false, 'locked empty pass');
eq(C.poolLocked({ requirePassword: '', joinPassword: '1234' }), false, 'locked flag off');
eq(C.isBlocked({ blocked: 'Y' }), true, 'blocked yes');
eq(C.isBlocked({ blocked: '' }), false, 'blocked no');

// line filters
eq(C.isHalfLine(2.5), true, 'half 2.5'); eq(C.isHalfLine(2), false, 'half 2');
eq(C.isAhLine(0), true, 'ah 0'); eq(C.isAhLine(-0.25), false, 'ah -.25'); eq(C.isAhLine(0.75), false, 'ah .75');

// poolExtra
eq(C.poolExtra({ extraMarkets: '{"corner_ft":{"enabled":true},"card_ft":{"enabled":false}}' }).corner_ft, true, 'extra on');
eq(!!C.poolExtra({ extraMarkets: '{"card_ft":{"enabled":false}}' }).card_ft, false, 'extra off');
eq(!!C.poolExtra({}).corner_ft, false, 'extra none');

// oddsMoves: price up -> 1, down -> -1, unchanged -> absent
const cur  = JSON.stringify({ m1x2:{home:{oid:1,price:2.0},draw:{oid:2,price:3.0},away:{oid:3,price:4.0}} });
const prev = JSON.stringify({ m1x2:{home:{oid:1,price:1.9},draw:{oid:2,price:3.0},away:{oid:3,price:4.2}} });
const mv = C.oddsMoves(cur, prev);
eq(mv['1x2_1'], 1, 'home odds up'); eq(mv['1x2_3'], -1, 'away odds down');
eq('1x2_2' in mv, false, 'unchanged absent');

// stdOutcomes: ou labels from odds JSON
const ou = C.stdOutcomes(JSON.stringify({ mou:{ line:2.5, over:{oid:10,price:1.9}, under:{oid:11,price:1.9} } }), 'ou', 'A', 'B');
eq(ou.length, 2, 'ou 2 outcomes'); eq(ou[0].label, 'Tài bàn 2.5', 'ou over label'); eq(ou[1].label, 'Xỉu bàn 2.5', 'ou under label');

// stdOutcomes: cs node ({scores:[...]}, no over/under) must NOT throw 'oid' — regression for force-closed correct-score bets
const cs = C.stdOutcomes(JSON.stringify({ cs:{ marketId:10336, scores:[{oid:1,h:1,a:0,price:8},{oid:2,h:2,a:1,price:12}] } }), 'cs', 'A', 'B');
eq(cs.length, 2, 'cs 2 outcomes'); eq(cs[0].label, 'Tỉ số 1:0', 'cs label'); eq(cs[0].oid, 1, 'cs oid');
eq(C.stdOutcomes(JSON.stringify({ ou:{ marketId:1 } }), 'ou', 'A', 'B').length, 0, 'ou node w/o over/under -> [] not throw');

// badgeEval: 6 players, top winner with big lead + high win-rate -> prophet + lonewolf; worst -> bot/coldstreak
const rows = [
  { user:'a', points:2000, start:1000, nSettled:10, nWin:9, ouWin:0, ahWin:0, maxWonOdds:3, contrarian:0, streakW:4, streakL:0, bigOddWin:0 },
  { user:'b', points:1100, start:1000, nSettled:8,  nWin:5, ouWin:0, ahWin:0, maxWonOdds:2, contrarian:0, streakW:0, streakL:0, bigOddWin:0 },
  { user:'c', points:1050, start:1000, nSettled:8,  nWin:4, ouWin:0, ahWin:0, maxWonOdds:2, contrarian:0, streakW:0, streakL:0, bigOddWin:0 },
  { user:'d', points:1000, start:1000, nSettled:6,  nWin:3, ouWin:0, ahWin:0, maxWonOdds:2, contrarian:0, streakW:0, streakL:0, bigOddWin:0 },
  { user:'e', points:900,  start:1000, nSettled:6,  nWin:2, ouWin:0, ahWin:0, maxWonOdds:2, contrarian:0, streakW:0, streakL:1, bigOddWin:0 },
  { user:'f', points:100,  start:1000, nSettled:8,  nWin:1, ouWin:0, ahWin:0, maxWonOdds:1, contrarian:0, streakW:0, streakL:4, bigOddWin:0 },
];
const be = C.badgeEval(rows, 1000);
assert.ok(be.a.includes('prophet'), 'a prophet (9/10 > .85)');
assert.ok(be.a.includes('lonewolf'), 'a lonewolf (lead 900 >= base/2)');
assert.ok(be.a.includes('onfire'), 'a onfire (streakW 4)');
assert.ok(be.f.includes('coldstreak'), 'f coldstreak (streakL 4)');
assert.ok(be.f.includes('bot'), 'f bot (bottom + far below avg)');
assert.strictEqual(be.f[0], 'bot', 'bad badges first, in BADGE_BAD order (bot before coldstreak)');

// demonking (odds ≥7) suppresses underdog (odds ≥5) — overlap: they must not both fire
const dk = C.badgeEval([
  { user:'x', points:1000, start:1000, nSettled:1, nWin:1, ouWin:0, ahWin:0, maxWonOdds:8, contrarian:0, streakW:0, streakL:0, bigOddWin:1 },
  { user:'y', points:1000, start:1000, nSettled:1, nWin:1, ouWin:0, ahWin:0, maxWonOdds:6, contrarian:0, streakW:0, streakL:0, bigOddWin:0 },
], 1000);
assert.ok(dk.x.includes('demonking') && !dk.x.includes('underdog'), 'odds ≥7 -> demonking only, not underdog');
assert.ok(dk.y.includes('underdog') && !dk.y.includes('demonking'), 'odds 5–7 -> underdog only');

// parseApiTime: epoch s == ms, ISO, empty
eq(C.parseApiTime(1782000000).getTime(), C.parseApiTime(1782000000000).getTime(), 'epoch s==ms');
eq(C.parseApiTime('2026-06-26T12:00:00Z').getTime(), Date.parse('2026-06-26T12:00:00Z'), 'iso parse');
eq(C.parseApiTime(''), null, 'empty time');

// buildOdds: picks most-balanced line (not nearest-2.0) for ou/ah; 1x2 straight
const cat = { '1x2|fulltime': [{ mid: 101, hcap: 0, oids: [101, 102, 103] }],
  'totals|fulltime': [{ mid: 1010, hcap: 2.5, oids: [1010, 1011] }, { mid: 1012, hcap: 3.5, oids: [1012, 1013] }],
  'totals-corners|fulltime': [{ mid: 10767, hcap: 9.5, oids: [10767, 10768] }],
  'spreads|fulltime': [{ mid: 1068, hcap: -0.5, oids: [1068, 1069] }, { mid: 1072, hcap: 0, oids: [1072, 1073] }],
  'bothteamsscore|fulltime': [{ mid: 104, hcap: 0, oids: [104, 105] }] };
const leaf = p => ({ players: { '0': { price: p } } });
const mk = { '101': { outcomes: { '101': leaf(2), '102': leaf(3), '103': leaf(4) } },
  '1010': { outcomes: { '1010': leaf(1.9), '1011': leaf(1.9) } },
  '1012': { outcomes: { '1012': leaf(1.4), '1013': leaf(2.9) } },
  '10767': { outcomes: { '10767': leaf(1.85), '10768': leaf(1.95) } },
  '1068': { outcomes: { '1068': leaf(1.85), '1069': leaf(1.96) } },
  '1072': { outcomes: { '1072': leaf(1.90), '1073': leaf(1.90) } },
  '104': { outcomes: { '104': leaf(1.72), '105': leaf(2.05) } } };
const bo = C.buildOdds(mk, cat, {});
eq(bo.m1x2.home.price, 2, 'bo 1x2 home'); eq(bo.mou.line, 2.5, 'bo mou balanced'); eq(bo.mou.under.oid, 1011, 'bo mou under oid');
eq(bo.corner_ft.line, 9.5, 'bo corner line'); eq(bo.mah.line, 0, 'bo mah most-balanced'); eq(bo.mah.away.oid, 1073, 'bo mah away oid');
eq(bo.btts.yes.oid, 104, 'bo btts yes oid'); eq(bo.btts.yes.price, 1.72, 'bo btts yes price'); eq(bo.btts.no.oid, 105, 'bo btts no oid');

// gradeBtts: từ tỉ số 2 hiệp chính. yes.oid==marketId(104)
eq(C.gradeBtts({ marketId: 104, outcomeId: 104 }, '1-1'), 'WIN', 'Có: 1-1 cả hai ghi bàn -> thắng');
eq(C.gradeBtts({ marketId: 104, outcomeId: 104 }, '2-0'), 'LOSE', 'Có: 2-0 một đội không ghi -> thua');
eq(C.gradeBtts({ marketId: 104, outcomeId: 105 }, '2-0'), 'WIN', 'Không: 2-0 -> thắng');
eq(C.gradeBtts({ marketId: 104, outcomeId: 105 }, '3-2'), 'LOSE', 'Không: 3-2 cả hai ghi -> thua');
eq(C.gradeBtts({ marketId: 104, outcomeId: 104 }, ''), 'UNDECIDED', 'chưa có tỉ số -> UNDECIDED');

// gradeCS: tỉ số chính xác. betLabel "h-a" (từ catalog) vs tỉ số thật "a-b".
eq(C.gradeCS('2-0', '2-0'), 'WIN', 'cs: đoán đúng 2-0');
eq(C.gradeCS('2-0', '2-1'), 'LOSE', 'cs: đoán 2-0 nhưng 2-1');
eq(C.gradeCS('2-0', '9-0'), 'LOSE', 'cs: tỉ số thật ngoài lưới -> thua');
eq(C.gradeCS('2-0', ''), 'UNDECIDED', 'cs: chưa có tỉ số -> UNDECIDED');
eq(C.gradeCS(null, '2-0'), 'LOSE', 'cs: cửa không map được label -> thua');
assert.deepStrictEqual(C.parseScore('3:1'), { h: 3, a: 1 }, 'parseScore "h:a"');
assert.strictEqual(C.parseScore('x'), null, 'parseScore rác -> null');
// buildOdds kind:cs -> chỉ cửa có giá, label "h-a"
{
  const cat = { 'correctscore|fulltime': [{ mid: 10336, oids: [1, 2, 3], names: { 1: '0:0', 2: '1:0', 3: '2:1' } }] };
  const mk = { 10336: { outcomes: { 1: { players: { 0: { price: 8.5 } } }, 3: { players: { 0: { price: 12 } } } } } };
  const o = C.buildOdds(mk, cat, {});
  assert.deepStrictEqual(o.cs.scores, [{ oid: 1, label: '0-0', h: 0, a: 0, price: 8.5 }, { oid: 3, label: '2-1', h: 2, a: 1, price: 12 }], 'cs: bỏ cửa không giá (oid 2)');
}

// gradeStd: chấm 1x2/ou/ah từ tỉ số (thay /settlements). score "a-b" (chủ-khách).
// 1x2: oid 102=hòa, 103=khách, khác=chủ
eq(C.gradeStd({ marketType:'1x2', outcomeId:101, marketId:101 }, '2-0'), 'WIN', '1x2 chủ thắng');
eq(C.gradeStd({ marketType:'1x2', outcomeId:101, marketId:101 }, '0-2'), 'LOSE', '1x2 chủ thua');
eq(C.gradeStd({ marketType:'1x2', outcomeId:102, marketId:101 }, '1-1'), 'WIN', '1x2 hòa thắng');
eq(C.gradeStd({ marketType:'1x2', outcomeId:103, marketId:101 }, '0-2'), 'WIN', '1x2 khách thắng');
eq(C.gradeStd({ marketType:'1x2', outcomeId:101, marketId:101 }, ''), 'UNDECIDED', '1x2 chưa có tỉ số');
// ou: over.oid==marketId. vạch nửa -> WIN/LOSE; vạch nguyên -> có PUSH
eq(C.gradeStd({ marketType:'ou', outcomeId:10, marketId:10 }, '2-1', 2.5), 'WIN', 'ou Tài 2.5: 3>2.5');
eq(C.gradeStd({ marketType:'ou', outcomeId:11, marketId:10 }, '2-1', 2.5), 'LOSE', 'ou Xỉu 2.5: thua');
eq(C.gradeStd({ marketType:'ou', outcomeId:10, marketId:10 }, '1-1', 2), 'PUSH', 'ou Tài 2.0: tổng 2 == vạch -> hòa vốn');
eq(C.gradeStd({ marketType:'ou', outcomeId:10, marketId:10 }, '1-1', null), 'UNDECIDED', 'ou thiếu vạch (null)');
eq(C.gradeStd({ marketType:'ou', outcomeId:10, marketId:10 }, '1-1', undefined), 'UNDECIDED', 'ou thiếu vạch (undefined — midLine trả undefined khi catalog thiếu)');
eq(C.gradeStd({ marketType:'ah', outcomeId:20, marketId:20 }, '2-0', undefined), 'UNDECIDED', 'ah thiếu vạch (undefined)');
// ah: home.oid==marketId. line = chấp ĐỘI CHỦ
eq(C.gradeStd({ marketType:'ah', outcomeId:20, marketId:20 }, '2-0', -1), 'WIN', 'ah chủ -1: thắng 2 > 1');
eq(C.gradeStd({ marketType:'ah', outcomeId:21, marketId:20 }, '2-0', -1), 'LOSE', 'ah khách +1: thua');
eq(C.gradeStd({ marketType:'ah', outcomeId:20, marketId:20 }, '2-0', -2), 'PUSH', 'ah chủ -2 (vạch nguyên): thắng đúng 2 -> hòa vốn');
eq(C.gradeStd({ marketType:'ah', outcomeId:20, marketId:20 }, '2-0', -1.5), 'WIN', 'ah chủ -1.5 (vạch nửa): thắng');
// vạch tư 0.25/0.75 (hiện chưa dùng nhưng phải đúng) -> HALFWIN/HALFLOSS
eq(C.gradeStd({ marketType:'ah', outcomeId:20, marketId:20 }, '1-1', 0.25), 'HALFWIN', 'ah chủ +0.25: hòa -> nửa thắng');
eq(C.gradeStd({ marketType:'ah', outcomeId:20, marketId:20 }, '1-1', -0.25), 'HALFLOSS', 'ah chủ -0.25: hòa -> nửa thua');
eq(C.gradeStd({ marketType:'ah', outcomeId:20, marketId:20 }, '1-2', -0.75), 'LOSE', 'ah chủ -0.75: thua 1 -> thua hẳn');
eq(C.gradeStd({ marketType:'ah', outcomeId:20, marketId:20 }, '2-1', 0.75), 'WIN', 'ah chủ +0.75: thắng 1 -> thắng hẳn');
eq(C.gradeStd({ marketType:'ah', outcomeId:21, marketId:20 }, '1-1', 0.25), 'HALFLOSS', 'ah khách (chấp -0.25): hòa -> nửa thua');
// gradeAsian trực tiếp: các mốc biên
eq(C.gradeAsian(0.25), 'HALFWIN', 'asian +0.25'); eq(C.gradeAsian(-0.25), 'HALFLOSS', 'asian -0.25');
eq(C.gradeAsian(0), 'PUSH', 'asian 0'); eq(C.gradeAsian(0.5), 'WIN', 'asian +0.5'); eq(C.gradeAsian(-1), 'LOSE', 'asian -1');

// AH 0.75 boundary — đặc biệt kiểm phía KHÁCH (đổi dấu: chủ +0.75 <-> khách -0.75)
eq(C.gradeStd({ marketType:'ah', outcomeId:20, marketId:20 }, '2-1', -0.75), 'HALFWIN', 'ah chủ -0.75: thắng đúng 1 -> thắng nửa');
eq(C.gradeStd({ marketType:'ah', outcomeId:20, marketId:20 }, '1-2', 0.75), 'HALFLOSS', 'ah chủ +0.75: thua đúng 1 -> thua nửa');
eq(C.gradeStd({ marketType:'ah', outcomeId:21, marketId:20 }, '1-2', 0.75), 'HALFWIN', 'ah khách -0.75 (chủ +0.75): thắng đúng 1 -> thắng nửa');
eq(C.gradeStd({ marketType:'ah', outcomeId:21, marketId:20 }, '2-1', -0.75), 'HALFLOSS', 'ah khách +0.75 (chủ -0.75): thua đúng 1 -> thua nửa');

// OU vạch tư
eq(C.gradeStd({ marketType:'ou', outcomeId:10, marketId:10 }, '1-1', 2.25), 'HALFLOSS', 'ou Tài 2.25: tổng 2 -> thua nửa');
eq(C.gradeStd({ marketType:'ou', outcomeId:10, marketId:10 }, '2-1', 2.75), 'HALFWIN', 'ou Tài 2.75: tổng 3 -> thắng nửa');
eq(C.gradeStd({ marketType:'ou', outcomeId:11, marketId:10 }, '1-1', 2.25), 'HALFWIN', 'ou Xỉu 2.25: tổng 2 -> thắng nửa');
eq(C.gradeStd({ marketType:'ou', outcomeId:11, marketId:10 }, '2-1', 2.75), 'HALFLOSS', 'ou Xỉu 2.75: tổng 3 -> thua nửa');
eq(C.gradeStd({ marketType:'ou', outcomeId:11, marketId:10 }, '1-1', 2), 'PUSH', 'ou Xỉu 2.0: tổng 2 == vạch -> hòa vốn');

// score không hợp lệ -> UNDECIDED (regex loại trước khi Number)
eq(C.gradeStd({ marketType:'1x2', outcomeId:101, marketId:101 }, 'abc'), 'UNDECIDED', 'score không hợp lệ');
eq(C.gradeStd({ marketType:'1x2', outcomeId:101, marketId:101 }, '2'), 'UNDECIDED', 'score thiếu vế');
eq(C.gradeStd({ marketType:'1x2', outcomeId:101, marketId:101 }, '2-a'), 'UNDECIDED', 'score vế sau không phải số');

// sofaSum: fulltime góc = 1ST+2ND (KHÔNG gồm ET); thiếu period -> null
const sj = { statistics: [
  { period: 'ALL', groups: [{ statisticsItems: [{ name: 'Corner kicks', home: '4', away: '2' }, { name: 'Yellow cards', home: '1', away: '1' }] }] },
  { period: '1ST', groups: [{ statisticsItems: [{ name: 'Corner kicks', home: '2', away: '1' }, { name: 'Yellow cards', home: '1', away: '0' }] }] },
  { period: '2ND', groups: [{ statisticsItems: [{ name: 'Corner kicks', home: '2', away: '0' }] }] },
  { period: 'ET1', groups: [{ statisticsItems: [{ name: 'Corner kicks', home: '0', away: '0' }] }] },
  { period: 'ET2', groups: [{ statisticsItems: [{ name: 'Corner kicks', home: '0', away: '1' }] }] }] };
eq(C.sofaSum(sj, ['1ST', '2ND'], 'corner'), 5, 'góc fulltime = 5 (không gồm ET)');
eq(C.sofaSum(sj, ['ALL'], 'corner'), 6, 'ALL = 6 (gồm ET) — vì sao không dùng ALL');
eq(C.sofaSum(sj, ['1ST'], 'corner'), 3, 'góc H1 = 3');
eq(C.sofaSum(sj, ['1ST', '2ND'], 'card'), 1, 'thẻ fulltime = 1');
eq(C.sofaSum(sj, ['1ST', '2ND', 'OT'], 'corner'), null, 'thiếu period -> null');

// gradeExtra (line passed in by caller): the ALL-vs-1ST+2ND correctness case
eq(C.gradeExtra({ marketType: 'corner_ft', marketId: 10767, outcomeId: 10767 }, sj, 5.5), 'LOSE', 'Tài 5.5: 5<5.5 thua (ALL=6 would wrongly WIN)');
eq(C.gradeExtra({ marketType: 'corner_ft', marketId: 10767, outcomeId: 10768 }, sj, 5.5), 'WIN', 'Xỉu 5.5 thắng');
eq(C.gradeExtra({ marketType: 'corner_1h', marketId: 101535, outcomeId: 101535 }, sj, 2.5), 'WIN', 'H1 Tài 2.5: 3>2.5 thắng');
eq(C.gradeExtra({ marketType: 'card_ft', marketId: 555, outcomeId: 556 }, sj, 3.5), 'WIN', 'card Xỉu 3.5 thắng');
eq(C.gradeExtra({ marketType: 'corner_ft', marketId: 10767, outcomeId: 10767 }, null, 5.5), 'UNDECIDED', 'no stats -> UNDECIDED');

// norm + sofaPick (fallback id search)
eq(C.norm('Bosnia & Herzegovina'), C.norm('Bosnia and Herzegovina'), 'norm & == and');
const kick = Date.parse('2026-07-02T19:00:00Z');
const sres = [
  { type: 'team', entity: { id: 1, name: 'Spain' } },
  { type: 'event', entity: { id: 8537058, homeTeam: { name: 'Spain' }, awayTeam: { name: 'Austria' }, startTimestamp: Date.parse('2020-01-18T17:15:00Z') / 1000 } },
  { type: 'event', entity: { id: 12813004, homeTeam: { name: 'Spain' }, awayTeam: { name: 'Austria' }, startTimestamp: kick / 1000 } },
  { type: 'event', entity: { id: 99, homeTeam: { name: 'Spain' }, awayTeam: { name: 'Italy' }, startTimestamp: kick / 1000 } }];
eq(C.sofaPick(sres, 'Spain', 'Austria', kick), 12813004, 'pick đúng trận theo timestamp');
eq(C.sofaPick(sres, 'Austria', 'Spain', kick), 12813004, 'khớp cặp bất kể sân');
eq(C.sofaPick(sres, 'Spain', 'Austria', Date.parse('2030-01-01T00:00:00Z')), null, 'không có trận gần kickoff -> null');
// alias: OddsPapi "Cape Verde" phải khớp SofaScore "Cabo Verde" (bug Argentina-Cape Verde)
eq(C.norm('Cape Verde'), C.norm('Cabo Verde'), 'norm alias Cape==Cabo Verde');
const cvres = [{ type: 'event', entity: { id: 12812999, homeTeam: { name: 'Argentina' }, awayTeam: { name: 'Cabo Verde' }, startTimestamp: kick / 1000 } }];
eq(C.sofaPick(cvres, 'Argentina', 'Cape Verde', kick), 12812999, 'alias khớp Cape/Cabo Verde');

console.log('OK — core pure logic (poolCfg, filters, oddsMoves, stdOutcomes, badgeEval, buildOdds, sofaSum, gradeExtra, sofaPick, parseApiTime) matches Code.js.');
