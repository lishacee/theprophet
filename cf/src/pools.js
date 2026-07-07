// Pools + matches + betting. Port of Code.js getPools/joinPool/getMatches/getPoolView/placeBet.
// LockService is gone (D1 = no app locks): the money path uses an ATOMIC conditional UPDATE
// so two concurrent bets can't overspend. Read-based checks (per-market max, cover-all) stay
// best-effort — a lost race there only affects badge-arb, never the balance. // ponytail: balance is the invariant that must be atomic; the rest can be eventually-consistent.
import { authUser, isAdmin, uuid } from './auth.js';
import { findRow, findRows, appendRow, deleteRow, cached, cacheBust } from './db.js';
import * as C from './core.js';
import { getLeaderboard, getHistory } from './social.js';

export async function getPools(env, token){
  const user = await authUser(env, token);
  const pools = await findRows(env, 'Pools', 'status', 'open');
  const counts = {};
  (await env.DB.prepare('SELECT poolId, COUNT(*) n FROM Memberships GROUP BY poolId').all()).results
    .forEach(r => counts[r.poolId] = r.n);
  const mine = {};
  (await findRows(env, 'Memberships', 'user', user)).forEach(m => mine[m.poolId] = m);
  return pools.map(p => {
    const m = mine[p.poolId];
    return { poolId: p.poolId, name: p.name, joined: !!m,
      currentPoints: m ? Number(m.currentPoints) : null, members: counts[p.poolId] || 0, requirePassword: C.poolLocked(p) };
  });
}

export async function joinPool(env, token, poolId, pwd){
  const user = await authUser(env, token);
  const existing = await C.findMembership(env, poolId, user);
  if (existing) return { ok: true, startingPoints: Number(existing.startingPoints), currentPoints: Number(existing.currentPoints) };
  const pool = await findRow(env, 'Pools', 'poolId', poolId);
  if (!pool || pool.status !== 'open') throw new Error('Pool không mở');
  if (C.poolLocked(pool) && String(pwd || '') !== String(pool.joinPassword)) throw new Error('Mật khẩu không đúng');
  const now = new Date();
  const remaining = (await findRows(env, 'Matches', 'poolId', poolId)).filter(mt =>
    String(mt.included).toUpperCase() === 'Y' && new Date(mt.kickoff) > now).length;
  const cfg = C.poolCfg(pool);
  const start = Math.round(remaining * cfg.pointsPerMatch * cfg.startMultiplier);
  await appendRow(env, 'Memberships', [poolId, user, now.toISOString(), start, start]); // pinnedBadges,blocked default ''
  await cacheBust(env, ['lb_' + poolId, 'mt_' + poolId + '_' + user]);
  return { ok: true, startingPoints: start, currentPoints: start, remaining };
}

export async function getMatches(env, token, poolId){
  const user = await authUser(env, token);
  const mem = await C.findMembership(env, poolId, user);
  if (mem && C.isBlocked(mem)) throw new Error('Bạn đã bị chặn khỏi sảnh này');
  return cached(env, 'mt_' + poolId + '_' + user, 15, () => getMatches_(env, poolId, user));
}
async function getMatches_(env, poolId, user){
  const now = new Date();
  const horizon = new Date(now.getTime() + 48 * 3600000);
  const poolRow = await findRow(env, 'Pools', 'poolId', poolId);
  const cfg = C.poolCfg(poolRow || {});
  const matches = (await findRows(env, 'Matches', 'poolId', poolId)).filter(mt =>
    String(mt.included).toUpperCase() === 'Y'
    && new Date(mt.kickoff) > now && new Date(mt.kickoff) <= horizon);
  const bk = (poolRow && poolRow.bookmaker) ? poolRow.bookmaker : C.DEFAULT_BOOKMAKER;
  const enabled = C.poolExtra(poolRow || {});
  const oddsMap = {}, prevMap = {};
  const fids = matches.map(mt => mt.fixtureId);   // ponytail: horizon is 48h so this IN-list stays tiny, well under D1's param cap
  if (fids.length) {
    const { results } = await env.DB.prepare(
      `SELECT fixtureId,oddsJson,prevOddsJson FROM Odds WHERE bookmaker=? AND fixtureId IN (${fids.map(() => '?').join(',')})`
    ).bind(bk, ...fids).all();
    (results || []).forEach(o => { oddsMap[o.fixtureId] = o.oddsJson; prevMap[o.fixtureId] = o.prevOddsJson; });
  }
  const myBets = (await findRows(env, 'Bets', 'poolId', poolId)).filter(b => b.user === user);
  const cmByFix = {};
  (await findRows(env, 'CustomMarkets', 'poolId', poolId)).forEach(c => {
    let outs = []; try { outs = JSON.parse(c.outcomesJson || '[]'); } catch(e){}
    (cmByFix[c.fixtureId] = cmByFix[c.fixtureId] || []).push({ cid: c.cid, name: c.name, result: c.result, outcomes: outs });
  });
  const list = matches.map(mt => {
    const kickoff = new Date(mt.kickoff);
    let odds = oddsMap[mt.fixtureId] ? JSON.parse(oddsMap[mt.fixtureId]) : null;
    if (odds) C.TOGGLE_KEYS.forEach(k => { if (!enabled[k]) delete odds[k]; });
    const bets = myBets.filter(b => b.fixtureId === mt.fixtureId);
    return {
      fixtureId: mt.fixtureId, team1: mt.team1, team2: mt.team2,
      kickoff: kickoff.toISOString(), ouLine: (odds && odds.mou) ? odds.mou.line : mt.ouLine,
      open: now < kickoff, odds,
      customMarkets: cmByFix[mt.fixtureId] || [],
      moves: C.oddsMoves(oddsMap[mt.fixtureId], prevMap[mt.fixtureId]),
      myBets: bets.map(b => ({ marketType: b.marketType, outcomeId: b.outcomeId, stake: Number(b.stake), lockedOdds: Number(b.lockedOdds), result: b.result })),
    };
  }).sort((a,b) => new Date(a.kickoff) - new Date(b.kickoff));
  const mem = await C.findMembership(env, poolId, user);
  return { minStake: cfg.minStake, maxStake: cfg.maxStake, step: cfg.minStake,
    currentPoints: mem ? Number(mem.currentPoints) : null, matches: list };
}

// 1 RPC for the whole pool view — matches + leaderboard + history.
export async function getPoolView(env, token, poolId){
  const [matches, leaderboard, history] = await Promise.all([
    getMatches(env, token, poolId),
    getLeaderboard(env, token, poolId),
    getHistory(env, token, poolId),
  ]);
  return { matches, leaderboard, history };
}

export async function placeBet(env, token, poolId, fixtureId, marketType, outcomeId, stake){
  const user = await authUser(env, token);
  stake = Number(stake);
  const poolRow = await findRow(env, 'Pools', 'poolId', poolId);
  const cfg = C.poolCfg(poolRow || {});
  if (!(stake >= cfg.minStake && stake % cfg.minStake === 0))
    throw new Error('Điểm cược phải là bội số của ' + cfg.minStake + ' (tối thiểu ' + cfg.minStake + ')');
  const mem = await C.findMembership(env, poolId, user);
  if (!mem) throw new Error('Bạn chưa join pool này');
  if (C.isBlocked(mem)) throw new Error('Bạn đã bị chặn khỏi sảnh này');
  const mt = await env.DB.prepare('SELECT * FROM Matches WHERE poolId=? AND fixtureId=?').bind(poolId, String(fixtureId)).first();
  if (!mt) throw new Error('Không tìm thấy trận');
  if (new Date() >= new Date(mt.kickoff)) throw new Error('Trận đã đóng cược');

  const allBets = await findRows(env, 'Bets', 'poolId', poolId);
  const already = allBets.filter(b => b.user === user && b.fixtureId === fixtureId && b.marketType === marketType)
    .reduce((s,b) => s + Number(b.stake), 0);
  if (already + stake > cfg.maxStake)
    throw new Error('Tổng cược kèo này tối đa ' + cfg.maxStake + 'đ (đã cược ' + already + 'đ, còn ' + (cfg.maxStake - already) + 'đ)');

  let lockedOdds, marketId, nOutcomes;
  if (marketType.indexOf('c_') === 0) {
    const cm = await env.DB.prepare('SELECT * FROM CustomMarkets WHERE poolId=? AND fixtureId=? AND cid=?').bind(poolId, String(fixtureId), marketType.slice(2)).first();
    if (!cm) throw new Error('Kèo không tồn tại');
    if (cm.result) throw new Error('Kèo đã chấm, không thể cược');
    const couts = JSON.parse(cm.outcomesJson || '[]');
    const coc = couts.filter(x => String(x.oid) === String(outcomeId))[0];
    if (!coc) throw new Error('Cửa cược không hợp lệ');
    lockedOdds = coc.price; marketId = cm.cid; nOutcomes = couts.length;
  } else {
    if (C.TOGGLE_KEYS.indexOf(marketType) >= 0 && !C.poolExtra(poolRow || {})[marketType]) throw new Error('Kèo này chưa được bật cho sảnh');
    const bk = (poolRow && poolRow.bookmaker) ? poolRow.bookmaker : C.DEFAULT_BOOKMAKER;
    const oddsRow = await env.DB.prepare('SELECT * FROM Odds WHERE bookmaker=? AND fixtureId=?').bind(bk, String(fixtureId)).first();
    if (!oddsRow) throw new Error('Chưa có odds cho trận này');
    const odds = JSON.parse(oddsRow.oddsJson);
    const okey = marketType === '1x2' ? 'm1x2' : marketType === 'ou' ? 'mou' : marketType === 'ah' ? 'mah' : marketType;
    const e = odds[okey]; if (!e) throw new Error('Chưa có kèo này');
    const sels = ['home','draw','away','over','under','yes','no'].map(k => e[k]).filter(Boolean);
    const sel = sels.filter(x => String(x.oid) === String(outcomeId))[0];
    if (!sel) throw new Error('Cửa cược không hợp lệ');
    lockedOdds = sel.price; marketId = e.marketId; nOutcomes = sels.length;
  }
  if (!lockedOdds || lockedOdds <= 1) throw new Error('Odds không hợp lệ');

  if (marketType.indexOf('c_') !== 0) {
    const covered = {};
    allBets.forEach(b => { if (b.user === user && b.fixtureId === fixtureId && b.marketType === marketType) covered[String(b.outcomeId)] = 1; });
    covered[String(outcomeId)] = 1;
    if (Object.keys(covered).length >= nOutcomes) throw new Error('Không thể cược phủ hết các cửa của kèo này');
  }

  const cur = Number(mem.currentPoints);
  // Insert bet first, then atomic guarded deduct; roll back the bet if funds are short.
  const betId = uuid();
  await appendRow(env, 'Bets', [betId, poolId, user, fixtureId, marketType, marketId, outcomeId, stake, lockedOdds, new Date().toISOString(), '', '', '']);
  const upd = await env.DB.prepare(
    `UPDATE Memberships SET currentPoints = CAST(currentPoints AS REAL) - ?
     WHERE poolId=? AND user=? AND CAST(currentPoints AS REAL) >= ?`
  ).bind(stake, poolId, user, stake).run();
  if (!upd.meta.changes) { await deleteRow(env, 'Bets', { betId }); throw new Error('Không đủ điểm'); }
  await cacheBust(env, ['lb_' + poolId, 'mt_' + poolId + '_' + user, 'hist_' + poolId + '_' + user]);
  return { ok: true, lockedOdds, currentPoints: cur - stake };
}
