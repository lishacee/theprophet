// Auto-settlement + no-show penalty. Port of Code.js settleMatches/lookupResult_/
// applyNoShowPenalty. Corner/card graded from SofaScore (OddsPapi returns UNDECIDED).
// Membership point changes use atomic +=/-= so concurrent placeBet can't clobber them.
import { readAll, updateRow } from './db.js';
import { apiGet, sofaStats } from './api.js';
import * as C from './core.js';

function lookupResult(markets, marketId, outcomeId){
  try { return markets[String(marketId)].outcomes[String(outcomeId)].players['0'].result; } catch(e){ return null; }
}
async function addPoints(env, poolId, user, delta){
  if (!delta) return;
  await env.DB.prepare(`UPDATE Memberships SET currentPoints = CAST(currentPoints AS REAL) + ? WHERE poolId=? AND user=?`)
    .bind(delta, poolId, user).run();
}

export async function settleMatches(env){
  const now = new Date();
  const matches = (await readAll(env, 'Matches')).filter(mt =>
    String(mt.settled).toUpperCase() !== 'Y' && new Date(mt.kickoff) < new Date(now - 100 * 60000));

  for (const mt of matches) {
    // CHỈ chấm khi đã hết 2 hiệp chính (periods.fulltime). score đã lưu = từng thấy fulltime.
    if (!mt.score) {
      let ft = null;
      try {
        const sc = await apiGet(env, '/scores?fixtureId=' + encodeURIComponent(mt.fixtureId));
        ft = sc && sc.scores && sc.scores.periods && sc.scores.periods.fulltime;
      } catch (e) { console.error('scores ' + mt.fixtureId + ': ' + e.message); }
      if (ft && ft.participant1Score != null) {
        mt.score = ft.participant1Score + '-' + ft.participant2Score;   // giữ local để chấm btts ngay lượt này
        await updateRow(env, 'Matches', { poolId: mt.poolId, fixtureId: mt.fixtureId }, { score: mt.score });
      } else if (new Date(mt.kickoff) >= new Date(now - 4 * 3600000)) {
        continue; // chưa hết 2 hiệp -> chờ tick sau (an toàn tới 4h)
      }
    }
    const data = await apiGet(env, '/settlements?fixtureId=' + encodeURIComponent(mt.fixtureId));
    if (!data || !data.markets) continue;
    const bets = (await readAll(env, 'Bets')).filter(b => b.poolId === mt.poolId && b.fixtureId === mt.fixtureId && !b.result && String(b.marketType).indexOf('c_') !== 0);
    let anyUndecided = false;
    let sofa, sofaTried = false;
    for (const b of bets) {
      let res;
      if (String(b.marketType) === 'btts') {
        res = C.gradeBtts(b, mt.score);   // 2 đội ghi bàn: từ tỉ số (OddsPapi /settlements không chấm kèo này)
      } else if (C.EXTRA_KEYS.indexOf(String(b.marketType)) >= 0) {
        if (!sofaTried) { sofa = await sofaStats(env, mt.fixtureId); sofaTried = true; }
        res = C.gradeExtra(b, sofa, await C.midLine(env, Number(b.marketId)));
      } else {
        res = lookupResult(data.markets, b.marketId, b.outcomeId);
      }
      if (!res || res === 'UNDECIDED') { anyUndecided = true; continue; }
      const stake = Number(b.stake), odds = Number(b.lockedOdds); let payout = 0;
      if (res === 'WIN') payout = stake * odds;
      else if (res === 'HALFWIN') payout = stake * (1 + (odds - 1) / 2);
      else if (res === 'PUSH' || res === 'CANCELLED') payout = stake;
      else if (res === 'HALFLOSS') payout = stake / 2;
      else payout = 0;
      await updateRow(env, 'Bets', { betId: b.betId }, { result: res, payout, settledAt: new Date().toISOString() });
      await addPoints(env, mt.poolId, b.user, payout);
    }
    if (!anyUndecided) await updateRow(env, 'Matches', { poolId: mt.poolId, fixtureId: mt.fixtureId }, { settled: 'Y' });
    else if (new Date(mt.kickoff) < new Date(now - C.STUCK_MANUAL_HOURS * 3600000)) // quá lâu -> chốt, giao admin chấm tay
      await updateRow(env, 'Matches', { poolId: mt.poolId, fixtureId: mt.fixtureId }, { settled: 'Y' });
  }
}

export async function applyNoShowPenalty(env){
  const now = new Date();
  const matches = (await readAll(env, 'Matches')).filter(mt =>
    String(mt.included).toUpperCase() === 'Y' && String(mt.penaltyApplied).toUpperCase() !== 'Y' && new Date(mt.kickoff) < now);
  if (!matches.length) return;
  const allBets = await readAll(env, 'Bets');
  const allMem = await readAll(env, 'Memberships');
  const exemptions = await readAll(env, 'Exemptions');
  const penaltyByPool = {};
  (await readAll(env, 'Pools')).forEach(p => penaltyByPool[p.poolId] = C.poolCfg(p).noshowPenalty);
  for (const mt of matches) {
    let penalty = penaltyByPool[mt.poolId];
    if (penalty == null) penalty = C.NOSHOW_PENALTY;
    const kickoff = new Date(mt.kickoff);
    if (penalty > 0) {
      const members = allMem.filter(m => m.poolId === mt.poolId && !C.isBlocked(m) && new Date(m.joinAt) < kickoff);
      for (const m of members) {
        const exempt = exemptions.filter(e => e.poolId === mt.poolId && e.user === m.user && (String(e.fixtureId) === 'all' || String(e.fixtureId) === String(mt.fixtureId))).length > 0;
        if (exempt) continue;
        const betted = allBets.filter(b => b.poolId === mt.poolId && b.user === m.user && b.fixtureId === mt.fixtureId).length > 0;
        if (betted) continue;
        await addPoints(env, mt.poolId, m.user, -penalty);
      }
    }
    await updateRow(env, 'Matches', { poolId: mt.poolId, fixtureId: mt.fixtureId }, { penaltyApplied: 'Y' });
  }
}
