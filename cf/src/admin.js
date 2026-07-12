// Admin API. Port of Code.js admin* functions + refundBets_/purgeClosedPoolOdds.
// LockService gone; membership deltas use atomic +=. Bulk deletes use DELETE ... WHERE
// (no rowIndex bookkeeping). requireAdmin gates every entry point.
import { requireAdmin, uuid } from './auth.js';
import { readAll, findRow, findRows, appendRow, updateRow, deleteRow, cacheBust, setProp, cacheGet } from './db.js';
import { refreshOdds, importPoolFixtures } from './odds.js';
import { settleMatches } from './settle.js';
import { apiGet } from './api.js';
import * as C from './core.js';

const MAJOR_TOURNAMENT_IDS = [1, 16, 7, 679, 17, 8, 35, 23, 34, 357];
const TOURNAMENTS_CACHE_KEY = 'tournaments_major';

async function addPoints(env, poolId, user, delta){
  if (!delta) return;
  await env.DB.prepare(`UPDATE Memberships SET currentPoints = CAST(currentPoints AS REAL) + ? WHERE poolId=? AND user=?`).bind(delta, poolId, user).run();
}
function fmtDate(v){ return v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : (v || ''); }
function fmtDateTime(v){ try { return v ? new Date(v).toISOString() : ''; } catch(e){ return ''; } }

// ---- Custom markets ----
export async function adminAddMarket(env, token, poolId, fixtureId, name, outcomes){
  await requireAdmin(env, token);
  name = (name || '').toString().trim();
  if (!name) throw new Error('Cần tên kèo');
  if (!Array.isArray(outcomes) || outcomes.length < 2) throw new Error('Cần ít nhất 2 cửa cược');
  if (outcomes.length > 12) throw new Error('Tối đa 12 cửa');
  const outs = outcomes.map((o, i) => {
    const lbl = (o.label || '').toString().trim(), p = Number(o.price);
    if (!lbl) throw new Error('Cửa thiếu tên');
    if (!(p > 1)) throw new Error('Tỷ lệ phải là số > 1');
    return { oid: i, label: lbl, price: Math.round(p * 100) / 100 };
  });
  const cid = uuid().slice(0, 8);
  await appendRow(env, 'CustomMarkets', [poolId, fixtureId, cid, name, JSON.stringify(outs), '', '', new Date().toISOString()]);
  await cacheBust(env, await C.mtKeys(env, poolId, null));
  return { ok: true, cid };
}

export async function adminEditMarket(env, token, poolId, fixtureId, cid, name, outcomes){
  const u = await requireAdmin(env, token);
  const cm = await env.DB.prepare('SELECT * FROM CustomMarkets WHERE poolId=? AND fixtureId=? AND cid=?').bind(poolId, fixtureId, cid).first();
  if (!cm) throw new Error('Kèo không tồn tại');
  if (cm.result) throw new Error('Kèo đã chấm, không sửa được');
  name = (name || '').toString().trim();
  if (!name) throw new Error('Cần tên kèo');
  if (!Array.isArray(outcomes)) throw new Error('Thiếu cửa cược');
  if (outcomes.length > 12) throw new Error('Tối đa 12 cửa');
  const existing = JSON.parse(cm.outcomesJson || '[]');
  const byOid = {}; existing.forEach(o => byOid[String(o.oid)] = o);
  let maxOid = existing.reduce((m, o) => Math.max(m, Number(o.oid)), -1);
  const seen = {};
  const outs = outcomes.map(o => {
    const lbl = (o.label || '').toString().trim(), p = Number(o.price);
    if (!lbl) throw new Error('Cửa thiếu tên');
    if (!(p > 1)) throw new Error('Tỷ lệ phải là số > 1');
    let oid;
    if (o.oid === '' || o.oid == null) { oid = ++maxOid; }
    else {
      const key = String(o.oid);
      if (!(key in byOid) || seen[key]) throw new Error('Cửa cược không hợp lệ');
      seen[key] = 1; oid = byOid[key].oid;
    }
    return { oid, label: lbl, price: Math.round(p * 100) / 100 };
  });
  existing.forEach(o => { if (!seen[String(o.oid)]) throw new Error('Không được xoá cửa cược đã có'); });
  await updateRow(env, 'CustomMarkets', { poolId, fixtureId, cid }, { name, outcomesJson: JSON.stringify(outs) });
  await cacheBust(env, await C.mtKeys(env, poolId, u));
  return { ok: true };
}

// Hoàn điểm mọi cược CHƯA chấm của (pool,fixture,marketType) rồi xoá.
async function refundBets(env, poolId, fixtureId, marketType){
  const { results: toRefund } = await env.DB.prepare(
    `SELECT * FROM Bets WHERE poolId=? AND fixtureId=? AND marketType=? AND (result IS NULL OR result='')`
  ).bind(poolId, fixtureId, marketType).all();
  for (const b of toRefund) { await addPoints(env, poolId, b.user, Number(b.stake)); await deleteRow(env, 'Bets', { betId: b.betId }); }
}

export async function adminDeleteMarket(env, token, poolId, fixtureId, cid){
  const u = await requireAdmin(env, token);
  await refundBets(env, poolId, fixtureId, 'c_' + cid);
  await env.DB.prepare(`DELETE FROM CustomMarkets WHERE poolId=? AND fixtureId=? AND cid=?`).bind(poolId, fixtureId, cid).run();
  await cacheBust(env, await C.mtKeys(env, poolId, u));
  return { ok: true };
}

// Liệt kê kèo custom ở SẢNH KHÁC cho cùng trận, để clone sang sảnh này. Mỗi kèo kèm cờ
// `already` = sảnh này đã clone đúng nguồn đó (UI làm mờ, nhưng vẫn cho override — guard mềm).
export async function adminListClonableMarkets(env, token, poolId, fixtureId){
  await requireAdmin(env, token);
  const rows = await findRows(env, 'CustomMarkets', 'fixtureId', fixtureId);
  const clonedSrc = new Set(rows.filter(c => c.poolId === poolId && c.srcPool && c.srcCid).map(c => c.srcPool + '|' + c.srcCid));
  const names = {}; (await readAll(env, 'Pools')).forEach(p => names[p.poolId] = p.name);
  return rows.filter(c => c.poolId !== poolId).map(c => {
    let outcomes = []; try { outcomes = JSON.parse(c.outcomesJson || '[]'); } catch(e){}
    return { srcPool: c.poolId, srcPoolName: names[c.poolId] || c.poolId, srcCid: c.cid,
      name: c.name, outcomes, result: c.result || '', already: clonedSrc.has(c.poolId + '|' + c.cid) };
  });
}

// Clone (snapshot) các kèo đã chọn vào sảnh này. Copy name+outcomes NGUYÊN XI (giữ oid để sau
// map kết quả chấm), cid mới, reset result/locked, ghi con trỏ nguồn. Không hard-reject nguồn
// đã clone — guard mềm nằm ở UI. sources: [{srcPool, srcCid}].
export async function adminCloneMarkets(env, token, poolId, fixtureId, sources){
  await requireAdmin(env, token);
  if (!Array.isArray(sources) || !sources.length) throw new Error('Chưa chọn kèo nào');
  const mt = await env.DB.prepare('SELECT * FROM Matches WHERE poolId=? AND fixtureId=?').bind(poolId, String(fixtureId)).first();
  if (!mt) throw new Error('Sảnh này chưa có trận đó');
  let n = 0;
  for (const s of sources) {
    const src = await env.DB.prepare('SELECT * FROM CustomMarkets WHERE poolId=? AND fixtureId=? AND cid=?')
      .bind(s.srcPool, fixtureId, s.srcCid).first();
    if (!src) continue;
    const cid = uuid().slice(0, 8);
    await appendRow(env, 'CustomMarkets', [poolId, fixtureId, cid, src.name, src.outcomesJson, '', '', new Date().toISOString(), '', s.srcPool, s.srcCid]);
    n++;
  }
  if (!n) throw new Error('Không tìm thấy kèo nguồn nào');
  await cacheBust(env, await C.mtKeys(env, poolId, null));
  return { ok: true, n };
}

// Chấm/chấm lại kèo custom (delta payout -> không double-credit). winningOids: mảng/chuỗi các cửa
// thắng (nhiều cửa được), 'VOID' để hoàn, hoặc rỗng = 'NONE' (mọi cửa thua nhưng vẫn là đã chấm).
export async function adminSettleMarket(env, token, poolId, fixtureId, cid, winningOids){
  const u = await requireAdmin(env, token);
  const cm = await env.DB.prepare('SELECT * FROM CustomMarkets WHERE poolId=? AND fixtureId=? AND cid=?').bind(poolId, fixtureId, cid).first();
  if (!cm) throw new Error('Kèo không tồn tại');
  if (String(cm.locked).toUpperCase() === 'Y') throw new Error('Kèo đã chốt hoàn toàn, không chấm lại được');
  const w = winnerList(winningOids);
  await settleBets_(env, poolId, fixtureId, 'c_' + cid, winningOids);
  const result = w.void ? 'VOID' : (w.arr.length ? w.arr.join(',') : 'NONE');
  await updateRow(env, 'CustomMarkets', { poolId, fixtureId, cid }, { result, settledAt: new Date().toISOString() });
  await cacheBust(env, (await C.mtKeys(env, poolId, u)).concat(['lb_' + poolId]));
  return { ok: true };
}

export async function adminFinalizeMarket(env, token, poolId, fixtureId, cid){
  const u = await requireAdmin(env, token);
  const cm = await env.DB.prepare('SELECT * FROM CustomMarkets WHERE poolId=? AND fixtureId=? AND cid=?').bind(poolId, fixtureId, cid).first();
  if (!cm) throw new Error('Kèo không tồn tại');
  if (cm.result == null || cm.result === '') throw new Error('Kèo chưa chấm, chưa thể chốt');
  await updateRow(env, 'CustomMarkets', { poolId, fixtureId, cid }, { locked: 'Y' });
  await cacheBust(env, (await C.mtKeys(env, poolId, u)).concat(['lb_' + poolId]));
  return { ok: true };
}

// Fetch & chấm lại 1 trận bị kẹt qua API (thay vì chấm tay): mở lại trận rồi cho settle chạy lại
// (fetch tỉ số + SofaScore mới nhất). Fixture-level -> mở mọi sảnh của trận, chấm 1 lượt/1 lần fetch.
// Nếu dữ liệu vẫn thiếu, settle tự đóng lại (>3h) và admin vẫn chấm tay được. Trả số cửa còn kẹt.
export async function adminRefetchMatch(env, token, poolId, fixtureId){
  const u = await requireAdmin(env, token);
  const rows = await findRows(env, 'Matches', 'fixtureId', fixtureId);
  if (!rows.length) throw new Error('Trận không tồn tại');
  await env.DB.prepare(`UPDATE Matches SET settled='N' WHERE fixtureId=?`).bind(fixtureId).run();
  await settleMatches(env, fixtureId);
  const stuck = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM Bets WHERE fixtureId=? AND (result IS NULL OR result='') AND marketType NOT LIKE 'c\\_%' ESCAPE '\\'`
  ).bind(fixtureId).first();
  const keys = ['lb_' + poolId];
  for (const p of [...new Set(rows.map(r => r.poolId))]) keys.push(...await C.mtKeys(env, p, u));
  await cacheBust(env, keys);
  return { remaining: stuck ? Number(stuck.n) : 0 };
}

// Chấm tay kèo CHUẨN bị kẹt (auto-settle bó tay).
export async function adminSettleStdMarket(env, token, poolId, fixtureId, marketType, winningOid){
  const u = await requireAdmin(env, token);
  if (String(marketType).indexOf('c_') === 0) throw new Error('Kèo custom dùng chức năng chấm riêng');
  const n = await settleBets_(env, poolId, fixtureId, marketType, winningOid);
  if (!n) throw new Error('Không có cược nào cho kèo này');
  await cacheBust(env, (await C.mtKeys(env, poolId, u)).concat(['lb_' + poolId]));
  return { ok: true };
}

// Normalize the winning arg into a set of oids. Accepts: 'VOID', a single oid, an array of oids,
// or a comma-joined string. Custom markets can have MANY winning cửa (overlapping props, vd
// Ronaldo "ghi bàn" + "ghi bàn & kiến tạo" cùng ăn); std markets pass a single oid — same path.
function winnerList(winning){
  if (String(winning) === 'VOID') return { void: true, set: new Set(), arr: [] };
  const arr = (Array.isArray(winning) ? winning : String(winning).split(','))
    .map(x => String(x).trim()).filter(x => x !== '' && x !== 'NONE');
  return { void: false, set: new Set(arr), arr };
}

// Shared delta-resettle for custom + std manual settle. Returns #bets touched.
// A bet WINS if its outcomeId is in the winning set (a set, not a single cửa).
async function settleBets_(env, poolId, fixtureId, marketType, winning){
  const w = winnerList(winning);
  const { results: bets } = await env.DB.prepare(
    `SELECT * FROM Bets WHERE poolId=? AND fixtureId=? AND marketType=?`
  ).bind(poolId, fixtureId, marketType).all();
  for (const b of bets) {
    const stake = Number(b.stake), odds = Number(b.lockedOdds); let payout, res;
    if (w.void) { res = 'CANCELLED'; payout = stake; }
    else if (w.set.has(String(b.outcomeId))) { res = 'WIN'; payout = stake * odds; }
    else { res = 'LOSS'; payout = 0; }
    const oldPayout = b.result ? Number(b.payout) : 0;
    await updateRow(env, 'Bets', { betId: b.betId }, { result: res, payout, settledAt: new Date().toISOString() });
    await addPoints(env, poolId, b.user, payout - oldPayout);
  }
  return bets.length;
}

// ---- Pools ----
export async function adminListPools(env, token){
  await requireAdmin(env, token);
  const memCount = {}, matchCount = {};
  (await env.DB.prepare('SELECT poolId, COUNT(*) n FROM Memberships GROUP BY poolId').all()).results.forEach(r => memCount[r.poolId] = r.n);
  (await env.DB.prepare('SELECT poolId, COUNT(*) n FROM Matches GROUP BY poolId').all()).results.forEach(r => matchCount[r.poolId] = r.n);
  return (await readAll(env, 'Pools')).map(p => {
    const cfg = C.poolCfg(p);
    return {
      poolId: p.poolId, name: p.name, tournamentIds: p.tournamentIds,
      dateFrom: fmtDate(p.dateFrom), dateTo: fmtDate(p.dateTo),
      status: p.status, bookmaker: p.bookmaker || C.DEFAULT_BOOKMAKER,
      maxStake: cfg.maxStake, pointsPerMatch: cfg.pointsPerMatch, startMultiplier: cfg.startMultiplier, noshowPenalty: cfg.noshowPenalty,
      requirePassword: C.poolLocked(p), joinPassword: String(p.joinPassword || ''),
      extraMarkets: C.poolExtraObj(p),
      members: memCount[p.poolId] || 0,
      matchCount: matchCount[p.poolId] || 0,
    };
  });
}

export async function adminTournaments(env, token, force){
  await requireAdmin(env, token);
  if (!force) { const c = await cacheGet(env, TOURNAMENTS_CACHE_KEY, 90 * 86400000); if (c) return c; }
  const data = await apiGet(env, '/tournaments?sportId=' + C.SPORT_ID_SOCCER);
  const allow = {}; MAJOR_TOURNAMENT_IDS.forEach(id => allow[id] = 1);
  const list = (Array.isArray(data) ? data : [])
    .filter(t => allow[t.tournamentId] && (t.futureFixtures + t.upcomingFixtures + t.liveFixtures) > 0)
    .map(t => ({ id: t.tournamentId, name: t.tournamentName, category: t.categoryName, fixtures: t.futureFixtures + t.upcomingFixtures + t.liveFixtures }))
    .sort((a, b) => a.name < b.name ? -1 : 1);
  await setProp(env, TOURNAMENTS_CACHE_KEY, JSON.stringify(list));
  return list;
}

export async function adminCreatePool(env, token, obj){
  await requireAdmin(env, token);
  obj = obj || {};
  const name = (obj.name || '').toString().trim();
  if (!name) throw new Error('Cần tên pool');
  const poolId = 'p_' + uuid().slice(0, 8);
  await appendRow(env, 'Pools', [
    poolId, name, (obj.tournamentIds || '').toString().trim(),
    (obj.dateFrom || '').toString().trim(), (obj.dateTo || '').toString().trim(), 'draft',
    (obj.bookmaker || C.DEFAULT_BOOKMAKER),
    C.numOr(obj.pointsPerMatch, C.POINTS_PER_MATCH), C.numOr(obj.startMultiplier, C.START_MULTIPLIER), C.numOr(obj.noshowPenalty, C.NOSHOW_PENALTY),
  ]);
  return { poolId };
}

export async function adminUpdatePool(env, token, poolId, obj){
  await requireAdmin(env, token);
  const r = await findRow(env, 'Pools', 'poolId', poolId);
  if (!r) throw new Error('Pool không tồn tại');
  obj = obj || {};
  const fields = { name: 'str', tournamentIds: 'str', dateFrom: 'str', dateTo: 'str', bookmaker: 'str', pointsPerMatch: 'num', startMultiplier: 'num', noshowPenalty: 'num0' };
  const patch = {};
  Object.keys(fields).forEach(k => {
    if (!(k in obj)) return;
    let v = obj[k];
    if (fields[k] === 'num') { v = Number(v); if (!(isFinite(v) && v > 0)) throw new Error(k + ' phải là số > 0'); }
    else if (fields[k] === 'num0') { v = Number(v); if (!(isFinite(v) && v >= 0)) throw new Error(k + ' phải là số ≥ 0'); }
    else { v = (v || '').toString().trim(); }
    patch[k] = v;
  });
  if ('requirePassword' in obj) patch.requirePassword = obj.requirePassword ? 'Y' : '';
  if ('joinPassword' in obj) patch.joinPassword = String(obj.joinPassword == null ? '' : obj.joinPassword);
  if ('extraMarkets' in obj) {
    const em = {}; C.TOGGLE_KEYS.forEach(k => em[k] = { enabled: !!(obj.extraMarkets && obj.extraMarkets[k] && obj.extraMarkets[k].enabled) });
    patch.extraMarkets = JSON.stringify(em);
  }
  if (Object.keys(patch).length) await updateRow(env, 'Pools', { poolId }, patch);
  return { ok: true };
}

export async function adminSetStatus(env, token, poolId, status){
  await requireAdmin(env, token);
  if (['draft', 'open', 'closed'].indexOf(status) < 0) throw new Error('Status không hợp lệ');
  if (!(await findRow(env, 'Pools', 'poolId', poolId))) throw new Error('Pool không tồn tại');
  await updateRow(env, 'Pools', { poolId }, { status });
  return { ok: true };
}

// Xoá mọi cược + đưa mọi thành viên về điểm khởi đầu mùa mới. Dùng chung cho reset + kết thúc mùa.
async function resetPoolPoints_(env, poolId, pool){
  const cfg = C.poolCfg(pool);
  const now = new Date();
  const remaining = (await findRows(env, 'Matches', 'poolId', poolId)).filter(mt => String(mt.included).toUpperCase() === 'Y' && new Date(mt.kickoff) > now).length;
  const newStart = Math.round(remaining * cfg.pointsPerMatch * cfg.startMultiplier);
  await env.DB.prepare(`DELETE FROM Bets WHERE poolId=?`).bind(poolId).run();
  await env.DB.prepare(`UPDATE Memberships SET startingPoints=?, currentPoints=? WHERE poolId=?`).bind(String(newStart), String(newStart), poolId).run();
  await setProp(env, 'resetAt_' + poolId, now.toISOString());
  await cacheBust(env, ['lb_' + poolId]);
  return { newStart, matchCount: remaining };
}

export async function adminResetPool(env, token, poolId){
  await requireAdmin(env, token);
  const pool = await findRow(env, 'Pools', 'poolId', poolId);
  if (!pool) throw new Error('Pool không tồn tại');
  const { newStart, matchCount } = await resetPoolPoints_(env, poolId, pool);
  const n = (await env.DB.prepare('SELECT COUNT(*) c FROM Memberships WHERE poolId=?').bind(poolId).first()).c;
  return { ok: true, updated: n, startingPoints: newStart, matchCount };
}

// Kết thúc mùa: chụp bảng xếp hạng hiện tại vào Bảng vàng (Seasons) rồi reset điểm cho mùa mới.
export async function adminEndSeason(env, token, poolId, name){
  await requireAdmin(env, token);
  name = (name || '').toString().trim();
  if (!name) throw new Error('Cần tên mùa');
  const pool = await findRow(env, 'Pools', 'poolId', poolId);
  if (!pool) throw new Error('Pool không tồn tại');
  const mems = (await findRows(env, 'Memberships', 'poolId', poolId)).filter(m => !C.isBlocked(m));
  const standings = [];
  for (const m of mems) standings.push({ nickname: await C.nicknameOf(env, m.user), points: Number(m.currentPoints) });
  standings.sort((a, b) => b.points - a.points);
  await appendRow(env, 'Seasons', [poolId, name, new Date().toISOString(), JSON.stringify(standings)]);
  const { newStart } = await resetPoolPoints_(env, poolId, pool);
  return { ok: true, champion: standings[0] || null, startingPoints: newStart };
}

export async function adminDeletePool(env, token, poolId){
  await requireAdmin(env, token);
  if (!(await findRow(env, 'Pools', 'poolId', poolId))) throw new Error('Pool không tồn tại');
  // Odds dùng chung -> KHÔNG xoá theo pool; purgeClosedPoolOdds dọn mồ côi.
  for (const t of ['Bets', 'Memberships', 'Exemptions', 'CustomMarkets', 'Matches', 'Pools'])
    await env.DB.prepare(`DELETE FROM ${t} WHERE poolId=?`).bind(poolId).run();
  await cacheBust(env, ['lb_' + poolId]);
  return { ok: true };
}

export async function adminRefreshOdds(env, token){ await requireAdmin(env, token); await refreshOdds(env, true); return { ok: true }; }

// Đồng bộ giờ/tên trận từ OddsPapi cho mọi pool đang mở. Lookback 48h để bắt cả trận vừa dời qua giờ cũ.
export async function adminReloadMatches(env, token){
  await requireAdmin(env, token);
  const pools = await findRows(env, 'Pools', 'status', 'open');
  for (const p of pools) {
    try { await importPoolFixtures(env, p.poolId, 48); } catch (e) { console.error('reload matches ' + p.poolId + ': ' + e.message); }
    await cacheBust(env, await C.mtKeys(env, p.poolId, null));
  }
  return { ok: true, pools: pools.length };
}

export async function adminImport(env, token, poolId){
  await requireAdmin(env, token);
  const countMatches = async () => (await env.DB.prepare('SELECT COUNT(*) c FROM Matches WHERE poolId=?').bind(poolId).first()).c;
  const before = await countMatches();
  const maxKick = await importPoolFixtures(env, poolId);
  const after = await countMatches();
  return { added: after - before, total: after, dateTo: fmtDate(maxKick ? maxKick.toISOString() : '') };
}

export async function adminListMatches(env, token, poolId){
  await requireAdmin(env, token);
  return (await findRows(env, 'Matches', 'poolId', poolId)).map(m => ({
    fixtureId: m.fixtureId, team1: m.team1, team2: m.team2, kickoff: fmtDateTime(m.kickoff),
    included: String(m.included).toUpperCase() === 'Y', settled: String(m.settled).toUpperCase() === 'Y',
  })).sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
}

export async function adminToggleMatch(env, token, poolId, fixtureId, included){
  await requireAdmin(env, token);
  const r = await env.DB.prepare('SELECT * FROM Matches WHERE poolId=? AND fixtureId=?').bind(poolId, String(fixtureId)).first();
  if (!r) throw new Error('Không tìm thấy trận');
  await updateRow(env, 'Matches', { poolId, fixtureId: r.fixtureId }, { included: included ? 'Y' : 'N' });
  return { ok: true };
}

// ---- Members ----
export async function adminListMembers(env, token, poolId){
  await requireAdmin(env, token);
  const mems = await findRows(env, 'Memberships', 'poolId', poolId);
  const out = [];
  for (const m of mems) out.push({ userId: m.user, nickname: await C.nicknameOf(env, m.user), points: Number(m.currentPoints), blocked: C.isBlocked(m) });
  return out.sort((a, b) => b.points - a.points);
}

export async function adminBlockMember(env, token, poolId, userId, block){
  await requireAdmin(env, token);
  const mem = await C.findMembership(env, poolId, userId);
  if (!mem) throw new Error('Không tìm thấy thành viên');
  await updateRow(env, 'Memberships', { poolId, user: userId }, { blocked: block ? 'Y' : '' });
  await cacheBust(env, ['lb_' + poolId, 'mt_' + poolId + '_' + userId]);
  return { ok: true, blocked: !!block };
}
