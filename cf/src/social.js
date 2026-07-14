// Leaderboard + badges + history + crowd. Port of Code.js getLeaderboard/badgesForPool_/
// setPinnedBadges/getHistory/getCrowd. betLabel is async now, so bet lists use Promise.all.
import { authUser, isAdmin } from './auth.js';
import { findRow, findRows, updateRow, cached, cacheBust, batch } from './db.js';
import * as C from './core.js';

export async function getLeaderboard(env, token, poolId){
  await authUser(env, token);
  return cached(env, 'lb_' + poolId, 30, async () => {
    const [badges, [memRows, userRows]] = await Promise.all([
      badgesForPool(env, poolId),
      batch(env, [
        env.DB.prepare('SELECT * FROM Memberships WHERE poolId=?').bind(poolId),
        env.DB.prepare('SELECT * FROM Users'),
      ]),
    ]);
    const mems = memRows.filter(m => !C.isBlocked(m));
    const nicks = {};
    userRows.forEach(u => { nicks[u.userLower] = u.nickname; });
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
  const [matchRows, poolRows, memRows, allBets] = await batch(env, [
    env.DB.prepare('SELECT * FROM Matches WHERE poolId=?').bind(poolId),
    env.DB.prepare('SELECT * FROM Pools WHERE poolId=?').bind(poolId),
    env.DB.prepare('SELECT * FROM Memberships WHERE poolId=?').bind(poolId),
    env.DB.prepare('SELECT * FROM Bets WHERE poolId=?').bind(poolId),
  ]);
  const kick = {}; let nMatches = 0;
  matchRows.forEach(mt => {
    kick[mt.fixtureId] = new Date(mt.kickoff).getTime();
    if (String(mt.included).toUpperCase() === 'Y') nMatches++;
  });
  const poolRow = poolRows[0] || null;
  const cfg = C.poolCfg(poolRow || {});
  const baseStart = Math.round(nMatches * cfg.pointsPerMatch * cfg.startMultiplier);

  const mems = memRows.filter(m => !C.isBlocked(m));
  const pinnedRaw = {}, stats = {};
  mems.forEach(m => {
    stats[m.user] = { user: m.user, points: Number(m.currentPoints), start: Number(m.startingPoints) || 0,
      nSettled: 0, nWin: 0, ouWin: 0, ahWin: 0, maxWonOdds: 0, contrarian: 0, _byFix: {}, _bigOdd: {} };
    pinnedRaw[m.user] = String(m.pinnedBadges || '').split(',').map(s => s.trim()).filter(Boolean);
  });

  const mktBettors = {};
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
  const [poolRows, memRows, allBets, exAll, cmsRows, matchAll, catRows, resetRows] = await batch(env, [
    env.DB.prepare('SELECT * FROM Pools WHERE poolId=?').bind(poolId),
    env.DB.prepare('SELECT * FROM Memberships WHERE poolId=? AND user=?').bind(poolId, user),
    env.DB.prepare('SELECT * FROM Bets WHERE poolId=?').bind(poolId),
    env.DB.prepare('SELECT * FROM Exemptions WHERE poolId=?').bind(poolId),
    env.DB.prepare('SELECT * FROM CustomMarkets WHERE poolId=?').bind(poolId),
    env.DB.prepare('SELECT * FROM Matches WHERE poolId=?').bind(poolId),
    env.DB.prepare('SELECT value FROM Cache WHERE key=?').bind(C.MARKETS_CACHE_KEY),
    env.DB.prepare('SELECT value FROM Cache WHERE key=?').bind('resetAt_' + poolId),
  ]);
  const poolRow = poolRows[0] || null;
  const cfg = C.poolCfg(poolRow || {});
  const mem = memRows[0] || null;
  const joinAt = mem ? new Date(mem.joinAt) : null;
  const myBets = allBets.filter(b => b.user === user);
  const exemptions = exAll.filter(e => e.user === user);
  const betFixtures = {};
  myBets.forEach(b => betFixtures[b.fixtureId] = true);
  const cmByFix = {}, cmByCid = {};
  cmsRows.forEach(c => {
    let outs = []; try { outs = JSON.parse(c.outcomesJson || '[]'); } catch(e){}
    const entry = { cid: c.cid, name: c.name, result: c.result, outcomes: outs, locked: String(c.locked).toUpperCase() === 'Y', srcPool: c.srcPool || '', srcCid: c.srcCid || '' };
    (cmByFix[c.fixtureId] = cmByFix[c.fixtureId] || []).push(entry);
    cmByCid[c.cid] = entry;
  });
  // Prefetch 1 lần cho betLabel -> không còn N+1 DB read mỗi bet.
  let catalog = null; try { if (catRows[0]) catalog = JSON.parse(catRows[0].value); } catch(e){}
  const ctx = { catalog, cmByCid };
  const resetAt = (resetRows[0] && resetRows[0].value) ? new Date(resetRows[0].value).getTime() : 0;
  const admin = await isAdmin(env, user);
  const stuckByFix = {}, oddsByFix = {};
  if (admin) {
    const poolBk = (poolRow && poolRow.bookmaker) ? poolRow.bookmaker : C.DEFAULT_BOOKMAKER;
    (await findRows(env, 'Odds', 'bookmaker', poolBk)).forEach(o => { oddsByFix[o.fixtureId] = o.oddsJson; });
    const stuckSeen = {};
    allBets.forEach(b => {
      if (b.result || String(b.marketType).indexOf('c_') === 0) return;
      const k = b.fixtureId + '|' + b.marketType; if (stuckSeen[k]) return; stuckSeen[k] = 1;
      (stuckByFix[b.fixtureId] = stuckByFix[b.fixtureId] || []).push(b.marketType);
    });
    // Kèo clone CHƯA chấm: lấy kết quả sảnh nguồn làm gợi ý (admin xác nhận/sửa khi chấm). Query song song.
    const clones = [];
    for (const fx of Object.keys(cmByFix)) for (const cm of cmByFix[fx])
      if (cm.srcCid && (cm.result == null || cm.result === '')) clones.push({ cm, fx });
    await Promise.all(clones.map(async ({ cm, fx }) => {
      const src = await env.DB.prepare('SELECT result FROM CustomMarkets WHERE poolId=? AND fixtureId=? AND cid=?')
        .bind(cm.srcPool, fx, cm.srcCid).first();
      cm.srcResult = src ? (src.result || '') : '';
    }));
  }
  const matches = matchAll.filter(mt => {
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
      marketType: b.marketType, label: await C.betLabel(env, b, mt.team1, mt.team2, ctx),
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

// Feed điều chỉnh điểm — mọi thành viên xem được (minh bạch). Chỉ mùa hiện tại (>= resetAt),
// khớp getHistory; hàng cũ vẫn lưu trong DB. byAdmin có lưu nhưng không hiển thị.
export async function getAdjustments(env, token, poolId){
  await authUser(env, token);
  return cached(env, 'adj_' + poolId, 15, async () => {
    const [rows, userRows] = await batch(env, [
      env.DB.prepare('SELECT * FROM Adjustments WHERE poolId=?').bind(poolId),
      env.DB.prepare('SELECT userLower,nickname FROM Users'),
    ]);
    const resetRow = await env.DB.prepare('SELECT value FROM Cache WHERE key=?').bind('resetAt_' + poolId).first();
    const resetAt = resetRow && resetRow.value ? new Date(resetRow.value).getTime() : 0;
    const nicks = {}; userRows.forEach(u => { nicks[u.userLower] = u.nickname; });
    return rows
      .filter(r => new Date(r.at).getTime() > resetAt)
      .map(r => ({ nickname: nicks[String(r.user).toLowerCase()] || r.user, delta: Number(r.delta), reason: r.reason, at: r.at }))
      .sort((a, b) => new Date(b.at) - new Date(a.at));
  });
}

export async function getCrowd(env, token, poolId, fixtureId){
  const user = await authUser(env, token);
  const [mtRows, allBets, poolRows, userRows, cmsRows, catRows] = await batch(env, [
    env.DB.prepare('SELECT * FROM Matches WHERE poolId=? AND fixtureId=?').bind(poolId, String(fixtureId)),
    env.DB.prepare('SELECT * FROM Bets WHERE poolId=?').bind(poolId),
    env.DB.prepare('SELECT * FROM Pools WHERE poolId=?').bind(poolId),
    env.DB.prepare('SELECT userLower,nickname FROM Users'),
    env.DB.prepare('SELECT * FROM CustomMarkets WHERE poolId=?').bind(poolId),
    env.DB.prepare('SELECT value FROM Cache WHERE key=?').bind(C.MARKETS_CACHE_KEY),
  ]);
  const mt = mtRows[0];
  if (!mt) throw new Error('Trận không tồn tại');
  const open = new Date(mt.kickoff) > new Date();
  const bets = allBets.filter(b => String(b.fixtureId) === String(fixtureId));
  const iBet = bets.some(b => b.user === user);
  if (open && !iBet) return { locked: true };

  const poolRow = poolRows[0] || null;
  const bk = (poolRow && poolRow.bookmaker) ? poolRow.bookmaker : C.DEFAULT_BOOKMAKER;
  const oddsRow = await env.DB.prepare('SELECT * FROM Odds WHERE bookmaker=? AND fixtureId=?').bind(bk, String(fixtureId)).first();
  const labels = C.crowdLabels(oddsRow ? oddsRow.oddsJson : null, mt.team1, mt.team2);
  const nicks = {}; userRows.forEach(u => { nicks[u.userLower] = u.nickname; });
  const cmByCid = {};
  cmsRows.forEach(c => { let outs = []; try { outs = JSON.parse(c.outcomesJson || '[]'); } catch(e){} cmByCid[c.cid] = { name: c.name, outcomes: outs }; });
  let catalog = null; try { if (catRows[0]) catalog = JSON.parse(catRows[0].value); } catch(e){}
  const ctx = { catalog, cmByCid };
  const lbl = async b => (await C.betLabel(env, b, mt.team1, mt.team2, ctx)) || labels[b.marketType + '_' + b.outcomeId] || ('#' + b.outcomeId);

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
    for (const b of bets) out.bets.push({ nick: nicks[String(b.user).toLowerCase()] || b.user, me: b.user === user,
      marketType: b.marketType, label: await lbl(b), stake: Number(b.stake), lockedOdds: Number(b.lockedOdds),
      result: C.resultVi(b.result), payout: Number(b.payout) || 0 });
    out.bets.sort((a,b) => b.stake - a.stake);
  }
  return out;
}
