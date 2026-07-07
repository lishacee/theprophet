// Leaderboard + badges + history + crowd. Port of Code.js getLeaderboard/badgesForPool_/
// setPinnedBadges/getHistory/getCrowd. betLabel is async now, so bet lists use Promise.all.
import { authUser, isAdmin } from './auth.js';
import { readAll, findRow, findRows, updateRow, cached, cacheBust, prop } from './db.js';
import * as C from './core.js';

export async function getLeaderboard(env, token, poolId){
  await authUser(env, token);
  return cached(env, 'lb_' + poolId, 30, async () => {
    const badges = await badgesForPool(env, poolId);
    const mems = (await findRows(env, 'Memberships', 'poolId', poolId)).filter(m => !C.isBlocked(m));
    const nicks = {};
    (await readAll(env, 'Users')).forEach(u => { nicks[u.userLower] = u.nickname; });
    const out = [];
    for (const m of mems) {
      const b = badges[m.user] || { earned: [], pinned: [] };
      out.push({ nickname: nicks[String(m.user).toLowerCase()] || m.user, points: Number(m.currentPoints), start: Number(m.startingPoints),
        badges: b.earned, pinned: b.pinned, streakW: b.streakW || 0, streakL: b.streakL || 0 });
    }
    return out.sort((a,b) => b.points - a.points);
  });
}

export async function setPinnedBadges(env, token, poolId, idsCsv){
  const user = await authUser(env, token);
  const mem = await C.findMembership(env, poolId, user);
  if (!mem) throw new Error('Bạn chưa tham gia sảnh này');
  const earned = ((await badgesForPool(env, poolId))[user] || { earned: [] }).earned;
  const picks = String(idsCsv || '').split(',').map(s => s.trim())
    .filter(id => id && C.BADGE_BAD.indexOf(id) < 0 && earned.indexOf(id) >= 0).slice(0, 2);
  await updateRow(env, 'Memberships', { poolId, user }, { pinnedBadges: picks.join(',') });
  await cacheBust(env, ['lb_' + poolId]);
  return { pinned: picks };
}

async function badgesForPool(env, poolId){
  const kick = {}; let nMatches = 0;
  (await findRows(env, 'Matches', 'poolId', poolId)).forEach(mt => {
    kick[mt.fixtureId] = new Date(mt.kickoff).getTime();
    if (String(mt.included).toUpperCase() === 'Y') nMatches++;
  });
  const poolRow = await findRow(env, 'Pools', 'poolId', poolId);
  const cfg = C.poolCfg(poolRow || {});
  const baseStart = Math.round(nMatches * cfg.pointsPerMatch * cfg.startMultiplier);

  const mems = (await findRows(env, 'Memberships', 'poolId', poolId)).filter(m => !C.isBlocked(m));
  const pinnedRaw = {}, stats = {};
  mems.forEach(m => {
    stats[m.user] = { user: m.user, points: Number(m.currentPoints), start: Number(m.startingPoints) || 0,
      nSettled: 0, nWin: 0, ouWin: 0, ahWin: 0, maxWonOdds: 0, contrarian: 0, _byFix: {}, _bigOdd: {} };
    pinnedRaw[m.user] = String(m.pinnedBadges || '').split(',').map(s => s.trim()).filter(Boolean);
  });

  const mktBettors = {};
  const allBets = await findRows(env, 'Bets', 'poolId', poolId);
  allBets.forEach(b => {
    const k = b.fixtureId + '|' + b.marketType, m = mktBettors[k] || (mktBettors[k] = { _all: {} });
    (m[b.outcomeId] || (m[b.outcomeId] = {}))[b.user] = 1; m._all[b.user] = 1;
  });
  function isMinority(b){
    const m = mktBettors[b.fixtureId + '|' + b.marketType]; if (!m) return false;
    const total = Object.keys(m._all).length; if (total < 3) return false;
    const mine = Object.keys(m[b.outcomeId] || {}).length;
    return mine / total <= 0.34;
  }
  allBets.forEach(b => {
    const s = stats[b.user]; if (!s) return;
    if (!b.result) return;
    const stake = Number(b.stake), payout = Number(b.payout) || 0, won = payout > stake, odds = Number(b.lockedOdds) || 0;
    s.nSettled++;
    if (won) { s.nWin++; if (odds > s.maxWonOdds) s.maxWonOdds = odds; if (isMinority(b)) s.contrarian++; if (odds >= 7) s._bigOdd[b.fixtureId + '|' + b.marketType + '|' + b.outcomeId] = 1; }
    if (won && (b.marketType === 'ou' || b.marketType === 'corner_ft' || b.marketType === 'corner_1h')) s.ouWin++;
    if (b.marketType === 'ah' && won) s.ahWin++;
    const f = s._byFix[b.fixtureId] || (s._byFix[b.fixtureId] = { net: 0, k: kick[b.fixtureId] || 0 });
    f.net += payout - stake;
  });
  Object.keys(stats).forEach(u => {
    const s = stats[u];
    const arr = Object.keys(s._byFix).map(fid => s._byFix[fid]).sort((a,b) => b.k - a.k);
    let w = 0, l = 0;
    for (let i = 0; i < arr.length; i++) { if (arr[i].net > 0) w++; else break; }
    for (let j = 0; j < arr.length; j++) { if (arr[j].net < 0) l++; else break; }
    s.streakW = w; s.streakL = l; s.bigOddWin = Object.keys(s._bigOdd).length; delete s._byFix; delete s._bigOdd;
  });

  const earnedMap = C.badgeEval(Object.keys(stats).map(u => stats[u]), baseStart);
  const out = {};
  Object.keys(stats).forEach(u => {
    const earned = earnedMap[u] || [];
    out[u] = { earned, pinned: pinnedRaw[u].filter(id => earned.indexOf(id) >= 0),
      streakW: stats[u].streakW, streakL: stats[u].streakL };
  });
  return out;
}

export async function getHistory(env, token, poolId){
  const user = await authUser(env, token);
  return cached(env, 'hist_' + poolId + '_' + user, 15, () => getHistory_(env, poolId, user));
}
async function getHistory_(env, poolId, user){
  const now = new Date();
  const poolRow = await findRow(env, 'Pools', 'poolId', poolId);
  const cfg = C.poolCfg(poolRow || {});
  const mem = await C.findMembership(env, poolId, user);
  const joinAt = mem ? new Date(mem.joinAt) : null;
  const myBets = (await findRows(env, 'Bets', 'poolId', poolId)).filter(b => b.user === user);
  const exemptions = (await findRows(env, 'Exemptions', 'poolId', poolId)).filter(e => e.user === user);
  const betFixtures = {};
  myBets.forEach(b => betFixtures[b.fixtureId] = true);
  const cmByFix = {};
  (await findRows(env, 'CustomMarkets', 'poolId', poolId)).forEach(c => {
    let outs = []; try { outs = JSON.parse(c.outcomesJson || '[]'); } catch(e){}
    (cmByFix[c.fixtureId] = cmByFix[c.fixtureId] || []).push({ cid: c.cid, name: c.name, result: c.result, outcomes: outs, locked: String(c.locked).toUpperCase() === 'Y', srcPool: c.srcPool || '', srcCid: c.srcCid || '' });
  });
  const admin = await isAdmin(env, user);
  const stuckByFix = {}, oddsByFix = {};
  if (admin) {
    const poolBk = (poolRow && poolRow.bookmaker) ? poolRow.bookmaker : C.DEFAULT_BOOKMAKER;
    (await findRows(env, 'Odds', 'bookmaker', poolBk)).forEach(o => { oddsByFix[o.fixtureId] = o.oddsJson; });
    const stuckSeen = {};
    (await findRows(env, 'Bets', 'poolId', poolId)).forEach(b => {
      if (b.result || String(b.marketType).indexOf('c_') === 0) return;
      const k = b.fixtureId + '|' + b.marketType; if (stuckSeen[k]) return; stuckSeen[k] = 1;
      (stuckByFix[b.fixtureId] = stuckByFix[b.fixtureId] || []).push(b.marketType);
    });
    // Kèo clone CHƯA chấm: lấy kết quả sảnh nguồn làm gợi ý (admin xác nhận/sửa khi chấm).
    for (const fx of Object.keys(cmByFix)) for (const cm of cmByFix[fx]) {
      if (!cm.srcCid || (cm.result != null && cm.result !== '')) continue;
      const src = await env.DB.prepare('SELECT result FROM CustomMarkets WHERE poolId=? AND fixtureId=? AND cid=?')
        .bind(cm.srcPool, fx, cm.srcCid).first();
      cm.srcResult = src ? (src.result || '') : '';
    }
  }
  const rAt = await prop(env, 'resetAt_' + poolId);
  const resetAt = rAt ? new Date(rAt).getTime() : 0;
  const matches = (await findRows(env, 'Matches', 'poolId', poolId)).filter(mt => {
    if (String(mt.included).toUpperCase() !== 'Y') return false;
    if (new Date(mt.kickoff).getTime() <= resetAt) return false;
    return new Date(mt.kickoff) <= now || betFixtures[mt.fixtureId];
  });

  const rows = [];
  for (const mt of matches) {
    const kickoff = new Date(mt.kickoff);
    const upcoming = kickoff > now;
    const bets = myBets.filter(b => b.fixtureId === mt.fixtureId);
    let net = 0, staked = 0, pending = false;
    bets.forEach(b => {
      if (b.result) net += Number(b.payout) - Number(b.stake);
      else { pending = true; staked += Number(b.stake); }
    });
    const exempt = exemptions.filter(e => String(e.fixtureId) === 'all' || String(e.fixtureId) === String(mt.fixtureId)).length > 0;
    const penalized = String(mt.penaltyApplied).toUpperCase() === 'Y' && bets.length === 0 && !exempt && joinAt && joinAt < kickoff;
    if (penalized) net -= cfg.noshowPenalty;
    const settledY = String(mt.settled).toUpperCase() === 'Y';
    const stuckMarkets = [];
    if (settledY && stuckByFix[mt.fixtureId]) stuckByFix[mt.fixtureId].forEach(mtype => {
      const outs = C.stdOutcomes(oddsByFix[mt.fixtureId], mtype, mt.team1, mt.team2);
      if (outs.length) stuckMarkets.push({ marketType: mtype, outcomes: outs });
    });
    const betList = await Promise.all(bets.map(async b => ({
      marketType: b.marketType, label: await C.betLabel(env, b, mt.team1, mt.team2),
      stake: Number(b.stake), lockedOdds: Number(b.lockedOdds), result: C.resultVi(b.result), payout: Number(b.payout) || 0 })));
    rows.push({
      fixtureId: mt.fixtureId, team1: mt.team1, team2: mt.team2, kickoff: kickoff.toISOString(),
      score: C.scoreStr(mt.score), upcoming, settled: settledY, penalized, pending,
      net: Math.round(net), staked: Math.round(staked),
      customMarkets: cmByFix[mt.fixtureId] || [], stuckMarkets, bets: betList });
  }
  return rows.sort((a,b) => new Date(b.kickoff) - new Date(a.kickoff));
}

// Bảng vàng: các mùa đã kết thúc, mới nhất trước. champion = hạng 1, top = 3 hạng đầu.
export async function getSeasons(env, token, poolId){
  await authUser(env, token);
  return (await findRows(env, 'Seasons', 'poolId', poolId)).map(s => {
    let st = []; try { st = JSON.parse(s.standings || '[]'); } catch(e){}
    return { name: s.name, endedAt: s.endedAt, champion: st[0] || null, top: st.slice(0, 3) };
  }).sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt));
}

export async function getCrowd(env, token, poolId, fixtureId){
  const user = await authUser(env, token);
  const mt = await env.DB.prepare('SELECT * FROM Matches WHERE poolId=? AND fixtureId=?').bind(poolId, String(fixtureId)).first();
  if (!mt) throw new Error('Trận không tồn tại');
  const open = new Date(mt.kickoff) > new Date();
  const bets = (await findRows(env, 'Bets', 'poolId', poolId)).filter(b => String(b.fixtureId) === String(fixtureId));
  const iBet = bets.some(b => b.user === user);
  if (open && !iBet) return { locked: true };

  const poolRow = await findRow(env, 'Pools', 'poolId', poolId);
  const bk = (poolRow && poolRow.bookmaker) ? poolRow.bookmaker : C.DEFAULT_BOOKMAKER;
  const oddsRow = await env.DB.prepare('SELECT * FROM Odds WHERE bookmaker=? AND fixtureId=?').bind(bk, String(fixtureId)).first();
  const labels = C.crowdLabels(oddsRow ? oddsRow.oddsJson : null, mt.team1, mt.team2);
  const lbl = async b => (await C.betLabel(env, b, mt.team1, mt.team2)) || labels[b.marketType + '_' + b.outcomeId] || ('#' + b.outcomeId);

  const agg = {};
  for (const b of bets) {
    const k = b.marketType + '_' + b.outcomeId;
    if (!agg[k]) agg[k] = { marketType: b.marketType, outcomeId: String(b.outcomeId), label: await lbl(b), n: 0, stake: 0, _users: {} };
    if (!agg[k]._users[b.user]) { agg[k]._users[b.user] = 1; agg[k].n++; }
    agg[k].stake += Number(b.stake);
  }
  Object.keys(agg).forEach(k => delete agg[k]._users);
  const out = { locked: false, open, agg: Object.keys(agg).map(k => agg[k]) };
  if (!open) {
    out.bets = [];
    for (const b of bets) out.bets.push({ nick: await C.nicknameOf(env, b.user), me: b.user === user,
      marketType: b.marketType, label: await lbl(b), stake: Number(b.stake), lockedOdds: Number(b.lockedOdds),
      result: C.resultVi(b.result), payout: Number(b.payout) || 0 });
    out.bets.sort((a,b) => b.stake - a.stake);
  }
  return out;
}
