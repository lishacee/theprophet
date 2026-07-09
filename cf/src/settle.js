// Auto-settlement + no-show penalty. 1x2/ou/ah graded locally from the fulltime score
// (C.gradeStd — replaces the slow OddsPapi /settlements call); btts from score; corner/card
// from SofaScore stats. Membership point changes use atomic +=/-= so concurrent placeBet can't clobber them.
import { readAll, updateRow, cacheGet } from './db.js';
import { apiGet, sofaStats } from './api.js';
import * as C from './core.js';

async function addPoints(env, poolId, user, delta){
  if (!delta) return;
  await env.DB.prepare(`UPDATE Memberships SET currentPoints = CAST(currentPoints AS REAL) + ? WHERE poolId=? AND user=?`)
    .bind(delta, poolId, user).run();
}

export async function settleMatches(env){
  const now = new Date();
  const matches = (await readAll(env, 'Matches')).filter(mt =>
    String(mt.settled).toUpperCase() !== 'Y' && new Date(mt.kickoff) < new Date(now - 100 * 60000));
  if (!matches.length) return;

  // Prefetch một lần: bets group theo pool|fixture (xài index thay full-scan/match), + catalog cho midLine/csLabel.
  const betsByPF = {};
  for (const b of await readAll(env, 'Bets')) {
    if (b.result || String(b.marketType).indexOf('c_') === 0) continue;
    const k = b.poolId + '|' + b.fixtureId;
    (betsByPF[k] = betsByPF[k] || []).push(b);
  }
  const catalog = await cacheGet(env, C.MARKETS_CACHE_KEY, 90 * 86400000);
  // Score + SofaScore là fact THEO fixture, không theo pool: fetch/scrape 1 lần/fixtureId rồi chia mọi sảnh
  // -> hết fetch đôi + 2 sảnh cùng trận chấm cùng nguồn, cùng lúc (không lệch nhau). Memo hóa cả kết quả rỗng.
  const scoreByFix = {}, sofaByFix = {};
  const scoreFor = async (fixtureId) => {
    if (fixtureId in scoreByFix) return scoreByFix[fixtureId];
    let ft = null;
    try {
      const sc = await apiGet(env, '/scores?fixtureId=' + encodeURIComponent(fixtureId));
      ft = sc && sc.scores && sc.scores.periods && sc.scores.periods.fulltime;
    } catch (e) { console.error('scores ' + fixtureId + ': ' + e.message); }
    return scoreByFix[fixtureId] = (ft && ft.participant1Score != null) ? ft.participant1Score + '-' + ft.participant2Score : '';
  };
  const sofaFor = async (fixtureId) =>
    (fixtureId in sofaByFix) ? sofaByFix[fixtureId] : (sofaByFix[fixtureId] = await sofaStats(env, fixtureId));

  for (const mt of matches) {
    // CHỈ chấm khi đã hết 2 hiệp chính (periods.fulltime). score đã lưu = từng thấy fulltime.
    if (!mt.score) {
      const sco = await scoreFor(mt.fixtureId);
      if (sco) {
        mt.score = sco;   // giữ local để chấm btts ngay lượt này
        await updateRow(env, 'Matches', { poolId: mt.poolId, fixtureId: mt.fixtureId }, { score: sco });
      } else if (new Date(mt.kickoff) >= new Date(now - C.STUCK_MANUAL_HOURS * 3600000)) {
        continue; // chưa hết 2 hiệp -> chờ tick sau (an toàn tới STUCK_MANUAL_HOURS)
      }
    }
    // score rỗng (>4h vẫn chưa có tỉ số) -> std/btts sẽ UNDECIDED; corner/card vẫn chấm từ SofaScore.
    const bets = betsByPF[mt.poolId + '|' + mt.fixtureId] || [];
    let anyUndecided = false;
    const stuck = [];
    let sofa, sofaTried = false;
    for (const b of bets) {
      let res;
      if (String(b.marketType) === 'btts') {
        res = C.gradeBtts(b, mt.score);   // 2 đội ghi bàn: từ tỉ số
      } else if (String(b.marketType) === 'cs') {
        res = C.gradeCS(await C.csLabel(env, Number(b.outcomeId), catalog), mt.score);   // tỉ số chính xác: từ tỉ số
      } else if (C.EXTRA_KEYS.indexOf(String(b.marketType)) >= 0) {
        if (!sofaTried) { sofa = await sofaFor(mt.fixtureId); sofaTried = true; }
        res = C.gradeExtra(b, sofa, await C.midLine(env, Number(b.marketId), catalog));
      } else {
        res = C.gradeStd(b, mt.score, await C.midLine(env, Number(b.marketId), catalog));  // 1x2/ou/ah: tự tính từ tỉ số (thay /settlements)
      }
      if (!res || res === 'UNDECIDED') { anyUndecided = true; stuck.push(String(b.marketType)); continue; }
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
    else {
      const forced = new Date(mt.kickoff) < new Date(now - C.STUCK_MANUAL_HOURS * 3600000); // quá lâu -> chốt, giao admin chấm tay
      const why = !mt.score ? 'chưa có tỉ số' : (stuck.some(m => C.EXTRA_KEYS.indexOf(m) >= 0) && !sofa) ? 'sofaStats null (map/scrape fail)' : 'line/stats thiếu';
      console.warn(`[settle] ${mt.poolId}/${mt.fixtureId} ${forced ? 'HẾT ' + C.STUCK_MANUAL_HOURS + 'h -> đóng, bet còn UNDECIDED cần admin chấm tay' : 'chưa chốt'} | markets: ${[...new Set(stuck)].join(',')} | ${why}`);
      if (forced) await updateRow(env, 'Matches', { poolId: mt.poolId, fixtureId: mt.fixtureId }, { settled: 'Y' });
    }
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
