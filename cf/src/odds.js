// Odds catalog + refresh + fixture import. Port of Code.js marketsIndex_/buildOdds_ glue,
// refreshOdds/upsertOdds_, importPoolFixtures/dailyImport. All async against D1 + OddsPapi.
import { readAll, findRow, appendRow, updateRow, cacheGet, cachePut } from './db.js';
import { apiGet } from './api.js';
import * as C from './core.js';

// Index vạch theo (marketType|period) từ /markets — chỉ giữ family cần, cache 3 tháng.
async function marketsIndex(env){
  const c = await cacheGet(env, C.MARKETS_CACHE_KEY, 90 * 86400000); if (c) return c;
  const data = await apiGet(env, '/markets?sportId=' + C.SPORT_ID_SOCCER);
  const want = {}; C.MKT_FAMILIES.forEach(f => want[f.type + '|' + f.period] = 1);
  const idx = {};
  (Array.isArray(data) ? data : []).forEach(m => {
    const k = m.marketType + '|' + m.period; if (!want[k]) return;
    (idx[k] = idx[k] || []).push({ mid: m.marketId, hcap: m.handicap, oids: (m.outcomes || []).map(o => o.outcomeId) });
  });
  await cachePut(env, C.MARKETS_CACHE_KEY, idx);
  return idx;
}

async function upsertOdds(env, bookmaker, fixtureId, json){
  const r = await env.DB.prepare(`SELECT * FROM Odds WHERE bookmaker=? AND fixtureId=?`).bind(bookmaker, String(fixtureId)).first();
  const now = new Date().toISOString();
  if (r) {
    if (json !== r.oddsJson) {
      await updateRow(env, 'Odds', { bookmaker, fixtureId }, { prevOddsJson: r.oddsJson || '', oddsJson: json, updatedAt: now });
    }
    await updateRow(env, 'Odds', { bookmaker, fixtureId }, { lastFetchAt: now }); // luôn đánh dấu đã fetch -> throttle đúng
  } else {
    await appendRow(env, 'Odds', [bookmaker, fixtureId, json, now, '', now]);
  }
}

export async function refreshOdds(env, force){
  const now = new Date();
  const poolBook = {}, skipPool = {};
  (await readAll(env, 'Pools')).forEach(p => { poolBook[p.poolId] = p.bookmaker || C.DEFAULT_BOOKMAKER; if (p.status !== 'open') skipPool[p.poolId] = 1; });

  const matches = (await readAll(env, 'Matches')).filter(mt => String(mt.included).toUpperCase() === 'Y' && !skipPool[mt.poolId]);

  const oddsByBkFix = {};
  (await readAll(env, 'Odds')).forEach(o => { oddsByBkFix[o.bookmaker + '|' + o.fixtureId] = { oddsJson: o.oddsJson, lastFetchAt: o.lastFetchAt }; });

  const groups = {};
  matches.forEach(mt => {
    const kickoff = new Date(mt.kickoff);
    if (kickoff <= now) return;
    if ((kickoff - now) / 3600000 > C.FETCH_WINDOW_HOURS) return;
    const bk = poolBook[mt.poolId] || C.DEFAULT_BOOKMAKER;
    const g = groups[bk + '|' + mt.tournamentId] || (groups[bk + '|' + mt.tournamentId] = { bk, tid: mt.tournamentId, earliest: null, lastFetch: null });
    if (!g.earliest || kickoff < g.earliest) g.earliest = kickoff;
    const rec = oddsByBkFix[bk + '|' + mt.fixtureId];
    const lf = (rec && rec.lastFetchAt) ? new Date(rec.lastFetchAt) : null;
    if (lf && (!g.lastFetch || lf > g.lastFetch)) g.lastFetch = lf;
  });

  const dueByBook = {}, dueGroups = [];
  Object.keys(groups).forEach(key => {
    const g = groups[key];
    const hoursLeft = (g.earliest - now) / 3600000;
    const minGap = hoursLeft <= 1 ? 15 : (hoursLeft <= 6 ? 30 : 120);
    if (!force && g.lastFetch && (now - g.lastFetch) / 60000 < minGap - 1) return;
    dueGroups.push(g);
    (dueByBook[g.bk] = dueByBook[g.bk] || []).push(g.tid);
  });
  if (!dueGroups.length) return;

  const fixByBkTid = {};
  matches.forEach(mt => {
    if (new Date(mt.kickoff) <= now) return;
    const bk = poolBook[mt.poolId] || C.DEFAULT_BOOKMAKER;
    const k = bk + '|' + mt.tournamentId;
    (fixByBkTid[k] = fixByBkTid[k] || {})[mt.fixtureId] = 1;
  });

  const ahBetFix = {};
  (await readAll(env, 'Bets')).forEach(b => { if (b.marketType === 'ah') ahBetFix[b.fixtureId] = 1; });

  if (!Object.keys(dueByBook).length) return;
  const catalog = await marketsIndex(env);

  for (const bk of Object.keys(dueByBook)) {
    const tids = dueByBook[bk];
    const data = await apiGet(env, '/odds-by-tournaments?bookmaker=' + bk + '&oddsFormat=decimal&tournamentIds=' + tids.join(','));
    if (!Array.isArray(data)) continue;
    const fixById = {};
    data.forEach(f => fixById[f.fixtureId] = f);
    for (const tid of tids) {
      for (const fixtureId of Object.keys(fixByBkTid[bk + '|' + tid] || {})) {
        const f = fixById[fixtureId];
        if (!f || !f.bookmakerOdds || !f.bookmakerOdds[bk]) continue;
        const rec = oddsByBkFix[bk + '|' + fixtureId];
        let prev = null; try { prev = (rec && rec.oddsJson) ? JSON.parse(rec.oddsJson) : null; } catch(e){}
        const forced = {};
        C.MKT_FAMILIES.forEach(fam => {
          if (fam.kind === '1x2' || !prev || !prev[fam.key]) return;
          if (fam.lock === 'onBet') { if (fam.key === 'mah' && ahBetFix[fixtureId]) forced[fam.key] = prev[fam.key].marketId; }
          else if (fam.lock === 'always') forced[fam.key] = prev[fam.key].marketId;
        });
        const built = C.buildOdds(f.bookmakerOdds[bk].markets, catalog, forced);
        if (!built) continue;
        await upsertOdds(env, bk, fixtureId, JSON.stringify(built));
      }
    }
  }
}

export async function importPoolFixtures(env, poolId){
  const p = await findRow(env, 'Pools', 'poolId', poolId);
  if (!p) throw new Error('Pool không tồn tại: ' + poolId);
  const tids = String(p.tournamentIds).split(',').map(s => s.trim()).filter(Boolean);
  const from = new Date().toISOString();
  const toD = new Date(); toD.setMonth(toD.getMonth() + 18); const to = toD.toISOString();
  let maxKick = null;

  const existing = {};
  (await readAll(env, 'Matches')).forEach(mt => { if (mt.poolId === poolId) existing[mt.fixtureId] = mt; });

  for (const tid of tids) {
    const data = await apiGet(env, '/fixtures?tournamentId=' + tid + '&from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to));
    if (!Array.isArray(data)) continue;
    for (const f of data) {
      if (f.sportId !== C.SPORT_ID_SOCCER) continue;
      const kickoff = C.parseApiTime(f.startTime);
      if (kickoff && (!maxKick || kickoff > maxKick)) maxKick = kickoff;
      const cur = existing[f.fixtureId];
      if (cur) {
        if (cur._new !== true && String(cur.settled).toUpperCase() !== 'Y') {
          const patch = {};
          if (cur.team1 !== f.participant1Name) patch.team1 = f.participant1Name;
          if (cur.team2 !== f.participant2Name) patch.team2 = f.participant2Name;
          if (kickoff && new Date(cur.kickoff).getTime() !== kickoff.getTime()) patch.kickoff = kickoff.toISOString();
          if (Object.keys(patch).length) await updateRow(env, 'Matches', { poolId, fixtureId: cur.fixtureId }, patch);
        }
        continue;
      }
      // ouLine & ouMarketId để TRỐNG -> tự lấy vạch chính khi fetch odds.
      await appendRow(env, 'Matches', [poolId, f.fixtureId, f.tournamentId, f.participant1Name, f.participant2Name, kickoff ? kickoff.toISOString() : '', f.statusId, '', '', 'Y', '', '', '']);
      existing[f.fixtureId] = { _new: true };
    }
  }
  if (maxKick) await updateRow(env, 'Pools', { poolId }, { dateTo: maxKick.toISOString() });
  return maxKick;
}

export async function dailyImport(env){
  for (const p of await readAll(env, 'Pools')) {
    if (p.status === 'open') { try { await importPoolFixtures(env, p.poolId); } catch (e) { console.error('import ' + p.poolId + ': ' + e.message); } }
  }
}
