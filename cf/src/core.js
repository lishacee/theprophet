// Shared config + helpers ported from Code.js. Pure functions (poolCfg/badgeEval/oddsMoves/
// line filters/scoreStr/resultVi) are exported for the Node self-check; DB-backed helpers
// (findMembership/nicknameOf/midLine/betLabel) take env and are async.
import { readAll, findRow, findRows, updateRow, cacheGet } from './db.js';

export const START_MULTIPLIER = 1.1;
export const POINTS_PER_MATCH = 400;
export const NOSHOW_PENALTY = 200;
export const DEFAULT_BOOKMAKER = 'pinnacle';
export const MARKETS_CACHE_KEY = 'markets_index_v2';   // v2: thêm family bothteamsscore -> buộc dựng lại catalog

export const EXTRA_KEYS = ['corner_ft', 'corner_1h', 'card_ft'];    // over/under, chấm từ SofaScore
export const OU_KIND_LABEL = { ou: 'bàn', corner_ft: 'góc', corner_1h: 'góc H1', card_ft: 'thẻ' };
// Kèo admin bật/tắt cho sảnh. btts (2 đội ghi bàn) là yes/no, chấm từ tỉ số -> tách khỏi EXTRA_KEYS.
export const TOGGLE_KEYS = EXTRA_KEYS.concat(['btts']);
export const BADGE_PRIORITY = ['prophet','demonking','lonewolf','ximup','sharpshooter','ahdog','oudog','underdog','contrarian','onfire'];
export const BADGE_BAD = ['bot','coldstreak'];

// ---- pure ----
export function numOr(v, dflt){ const n = Number(v); return (isFinite(n) && n > 0) ? n : dflt; }
export function poolCfg(p){
  const ppm = numOr(p.pointsPerMatch, POINTS_PER_MATCH);
  const pen = p.noshowPenalty;
  return {
    pointsPerMatch: ppm,
    startMultiplier: numOr(p.startMultiplier, START_MULTIPLIER),
    minStake: ppm / 2, maxStake: ppm * 2,
    noshowPenalty: (pen === '' || pen == null) ? ppm / 2 : Math.max(0, Number(pen) || 0),
  };
}
export function poolLocked(p){ return String(p.requirePassword).toUpperCase() === 'Y' && String(p.joinPassword || '') !== ''; }
export function poolExtra(poolData){
  const em = {};
  try { const j = JSON.parse(poolData.extraMarkets || '{}'); TOGGLE_KEYS.forEach(k => { if (j[k] && j[k].enabled) em[k] = true; }); } catch(e){}
  return em;
}
export function poolExtraObj(poolData){ const en = poolExtra(poolData), o = {}; TOGGLE_KEYS.forEach(k => o[k] = { enabled: !!en[k] }); return o; }
export function isBlocked(m){ return String(m.blocked).toUpperCase() === 'Y'; }
export function isHalfLine(h){ return Math.abs((Math.abs(h) * 2) % 2 - 1) < 1e-9; }
export function isAhLine(h){ return Math.abs((Math.abs(h) * 2) % 1) < 1e-9; }
export function scoreStr(v){ return String(v || ''); } // D1 stores TEXT — no Sheets Date coercion
export function resultVi(r){ return { WIN:'Thắng', LOSE:'Thua', PUSH:'Hòa kèo', HALFWIN:'Thắng nửa', HALFLOSS:'Thua nửa', CANCELLED:'Hủy kèo' }[r] || String(r || ''); }

function oddsFlat(json){
  const f = {}; if (!json) return f;
  try {
    const o = JSON.parse(json);
    if (o.m1x2) ['home','draw','away'].forEach(k => { const x = o.m1x2[k]; if (x) f['1x2_' + x.oid] = x.price; });
    if (o.mou) ['over','under'].forEach(k => { const x = o.mou[k]; if (x) f['ou_' + x.oid] = x.price; });
    if (o.mah) ['home','away'].forEach(k => { const x = o.mah[k]; if (x) f['ah_' + x.oid] = x.price; });
  } catch(e){}
  return f;
}
export function oddsMoves(curJson, prevJson){
  const c = oddsFlat(curJson), p = oddsFlat(prevJson), m = {};
  Object.keys(c).forEach(k => { if (p[k] != null && c[k] !== p[k]) m[k] = (c[k] > p[k]) ? 1 : -1; });
  return m;
}

// Pure — port of badgeEval_. Given stats rows + baseStart, returns { user: [badgeId...] } (bad first).
export function badgeEval(rows, baseStart){
  const n = rows.length;
  const sorted = rows.slice().sort((a,b) => b.points - a.points);
  const topN = Math.max(1, Math.round(n * 0.2)), botN = Math.max(1, Math.round(n * 0.3));
  const topUsers = {}, botUsers = {};
  sorted.slice(0, topN).forEach(r => topUsers[r.user] = 1);
  sorted.slice(n - botN).forEach(r => botUsers[r.user] = 1);
  let ouMax = 0, ahMax = 0;
  rows.forEach(r => { if (r.ouWin > ouMax) ouMax = r.ouWin; if (r.ahWin > ahMax) ahMax = r.ahWin; });
  const lead = (n >= 2) ? (sorted[0].points - sorted[1].points) : Infinity;
  const res = {};
  rows.forEach(r => {
    const good = [], bad = [];
    const base = baseStart || r.start;
    if (r.nSettled >= 5 && r.nWin / r.nSettled > 0.85) good.push('prophet');
    else if (r.nSettled >= 5 && r.nWin / r.nSettled > 0.65) good.push('sharpshooter');
    if (n >= 4 && sorted[0].user === r.user && lead >= base / 2) good.push('lonewolf');
    if (n >= 4 && topUsers[r.user]) { if (r.points - avgOthers(sorted, r.user) > base) good.push('ximup'); }
    if (ahMax >= 3 && r.ahWin === ahMax) good.push('ahdog');
    if (ouMax >= 3 && r.ouWin === ouMax) good.push('oudog');
    if (r.maxWonOdds >= 5) good.push('underdog');
    if (r.bigOddWin >= 1) good.push('demonking');
    if (r.contrarian >= 1) good.push('contrarian');
    if (r.streakW >= 3) good.push('onfire');
    if (r.streakL >= 3) bad.push('coldstreak');
    if (n >= 4 && botUsers[r.user]) { if (avgOthers(sorted, r.user) - r.points >= base) bad.push('bot'); }
    good.sort((a,b) => BADGE_PRIORITY.indexOf(a) - BADGE_PRIORITY.indexOf(b));
    bad.sort((a,b) => BADGE_BAD.indexOf(a) - BADGE_BAD.indexOf(b));
    res[r.user] = bad.concat(good);
  });
  return res;
}
export function avgOthers(rows, user){
  let sum = 0, c = 0;
  rows.forEach(r => { if (r.user !== user) { sum += r.points; c++; } });
  return c ? sum / c : 0;
}

// Cửa cược của 1 kèo CHUẨN cho admin chấm tay — pure, dựng từ Odds JSON. Port of stdOutcomes_.
export function stdOutcomes(oddsJson, marketType, t1, t2){
  if (!oddsJson) return [];
  let o; try { o = JSON.parse(oddsJson); } catch(e){ return []; }
  const n = o[{ '1x2':'m1x2', 'ou':'mou', 'ah':'mah' }[marketType] || marketType];
  if (!n) return [];
  if (marketType === '1x2') return [
    { oid: n.home.oid, label: t1, price: n.home.price },
    { oid: n.draw.oid, label: 'Hòa', price: n.draw.price },
    { oid: n.away.oid, label: t2, price: n.away.price }];
  if (marketType === 'ah') {
    const hl = (n.line > 0 ? '+' : '') + n.line, al = ((-n.line) > 0 ? '+' : '') + (-n.line);
    return [{ oid: n.home.oid, label: t1 + ' ' + hl, price: n.home.price },
            { oid: n.away.oid, label: t2 + ' ' + al, price: n.away.price }];
  }
  if (marketType === 'btts') return [
    { oid: n.yes.oid, label: '2 đội ghi bàn: Có', price: n.yes.price },
    { oid: n.no.oid, label: '2 đội ghi bàn: Không', price: n.no.price }];
  const kind = marketType === 'ou' ? 'bàn' : OU_KIND_LABEL[marketType];
  return [{ oid: n.over.oid, label: 'Tài ' + kind + ' ' + n.line, price: n.over.price },
          { oid: n.under.oid, label: 'Xỉu ' + kind + ' ' + n.line, price: n.under.price }];
}

// ---- odds/settlement pure logic (ported from Code.js; unit-tested in test_core.mjs) ----
export const SPORT_ID_SOCCER = 10;
export const FETCH_WINDOW_HOURS = 24;
export const STUCK_MANUAL_HOURS = 4;

// "Họ kèo" build vào oddsJson. Vạch suy ra động từ /markets catalog.
export const MKT_FAMILIES = [
  { key: 'm1x2',      type: '1x2',             period: 'fulltime', kind: '1x2' },
  { key: 'mou',       type: 'totals',          period: 'fulltime', kind: 'ou', lineFilter: 'half', lock: 'always' },
  { key: 'mah',       type: 'spreads',         period: 'fulltime', kind: 'ah', lineFilter: 'ah',   lock: 'onBet' },
  { key: 'corner_ft', type: 'totals-corners',  period: 'fulltime', kind: 'ou', lineFilter: 'half', lock: 'always' },
  { key: 'corner_1h', type: 'totals-corners',  period: 'p1',       kind: 'ou', lineFilter: 'half', lock: 'always' },
  { key: 'card_ft',   type: 'totals-bookings', period: 'fulltime', kind: 'ou', lineFilter: 'half', lock: 'always' },
  { key: 'btts',      type: 'bothteamsscore',  period: 'fulltime', kind: 'yn' },   // 2 đội ghi bàn (mid 104, yes/no), chấm từ tỉ số 2 hiệp chính
];
// fulltime góc/thẻ = 1ST+2ND (KHÔNG dùng ALL — ALL gộp cả hiệp phụ ET1/ET2).
export const EXTRA_STAT = { corner_ft: [['1ST','2ND'], 'corner'], corner_1h: [['1ST'], 'corner'], card_ft: [['1ST','2ND'], 'card'] };

export function parseApiTime(v){
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) { const n = Number(v); return new Date(n < 1e12 ? n * 1000 : n); }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// Port of buildOdds_ — pure. forced: {key: marketId} vạch đã khoá lần trước.
export function buildOdds(markets, catalog, forced){
  if (!markets) return null;
  forced = forced || {};
  const price = (mid, oid) => { try { return markets[String(mid)].outcomes[String(oid)].players['0'].price; } catch(e){ return null; } };
  const out = {};
  MKT_FAMILIES.forEach(fam => {
    const lines = catalog[fam.type + '|' + fam.period]; if (!lines || !lines.length) return;
    if (fam.kind === '1x2') {
      const L = lines[0], o = L.oids;
      const h = price(L.mid, o[0]), d = price(L.mid, o[1]), a = price(L.mid, o[2]);
      if (h && d && a) out[fam.key] = { marketId: L.mid, home: { oid: o[0], price: h }, draw: { oid: o[1], price: d }, away: { oid: o[2], price: a } };
      return;
    }
    let chosen = null;
    const fmid = forced[fam.key];
    if (fmid) chosen = lines.filter(l => String(l.mid) === String(fmid))[0] || null;
    if (!chosen) {
      let best = Infinity;
      lines.forEach(l => {
        if (fam.lineFilter === 'half' && !isHalfLine(l.hcap)) return;
        if (fam.lineFilter === 'ah' && !isAhLine(l.hcap)) return;
        const p1 = price(l.mid, l.oids[0]), p2 = price(l.mid, l.oids[1]); if (!(p1 && p2)) return;
        const imb = Math.abs(p1 - p2);
        if (imb < best) { best = imb; chosen = l; }
      });
    }
    if (!chosen) return;
    const a1 = price(chosen.mid, chosen.oids[0]), a2 = price(chosen.mid, chosen.oids[1]); if (!(a1 && a2)) return;
    if (fam.kind === 'ah') out[fam.key] = { marketId: chosen.mid, line: chosen.hcap, home: { oid: chosen.oids[0], price: a1 }, away: { oid: chosen.oids[1], price: a2 } };
    else if (fam.kind === 'yn') out[fam.key] = { marketId: chosen.mid, yes: { oid: chosen.oids[0], price: a1 }, no: { oid: chosen.oids[1], price: a2 } };
    else out[fam.key] = { marketId: chosen.mid, line: chosen.hcap, over: { oid: chosen.oids[0], price: a1 }, under: { oid: chosen.oids[1], price: a2 } };
  });
  return Object.keys(out).length ? out : null;
}

// SofaScore helpers — pure. norm/sofaPick for the fallback id search; sofaSum for stat totals.
// OddsPapi vs SofaScore đặt tên khác nhau cho vài đội -> map trước khi norm.
const SOFA_ALIAS = { 'cape verde': 'cabo verde', 'korea republic': 'south korea', 'turkiye': 'turkey' };
export function norm(s){ const k = String(s || '').toLowerCase().trim(); const a = SOFA_ALIAS[k] || s; return String(a).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, ''); }
export function sofaPick(items, t1, t2, kickMs){
  const want = [norm(t1), norm(t2)].sort().join('|');
  let best = null, bestDiff = 12 * 3600000;
  (items || []).forEach(r => {
    const e = r.entity;
    if (r.type !== 'event' || !e || !e.homeTeam || !e.awayTeam || !e.startTimestamp) return;
    if ([norm(e.homeTeam.name), norm(e.awayTeam.name)].sort().join('|') !== want) return;
    const diff = Math.abs(e.startTimestamp * 1000 - kickMs);
    if (diff < bestDiff) { bestDiff = diff; best = e.id; }
  });
  return best;
}
export function sofaSum(json, periods, kind){
  let total = 0;
  for (let i = 0; i < periods.length; i++) {
    const block = ((json && json.statistics) || []).filter(g => g.period === periods[i])[0];
    if (!block || !block.groups) return null;
    block.groups.forEach(g => {
      (g.statisticsItems || []).forEach(it => {
        const n = String(it.name || '').toLowerCase();
        const hit = kind === 'corner' ? n.indexOf('corner') >= 0 : (n.indexOf('yellow card') >= 0 || n.indexOf('red card') >= 0);
        if (hit) total += (parseInt(it.home, 10) || 0) + (parseInt(it.away, 10) || 0);
      });
    });
  }
  return total;
}
// Chấm 1 kèo góc/thẻ. line phải do caller resolve (await midLine) rồi truyền vào -> pure & testable.
export function gradeExtra(b, statsJson, line){
  const spec = EXTRA_STAT[String(b.marketType)]; if (!spec || !statsJson) return 'UNDECIDED';
  const total = sofaSum(statsJson, spec[0], spec[1]); if (total == null) return 'UNDECIDED';
  if (line == null) return 'UNDECIDED';
  const isOver = String(b.outcomeId) === String(b.marketId); // over.oid == marketId (quy ước OddsPapi)
  return (isOver ? total > line : total < line) ? 'WIN' : 'LOSE';
}

// Chấm kèo 2 đội ghi bàn từ tỉ số 2 hiệp chính (mt.score = periods.fulltime, không tính hiệp phụ).
// yes.oid == marketId (quy ước như over ở gradeExtra). score dạng "a-b".
export function gradeBtts(b, score){
  const m = /^\s*(\d+)\D+(\d+)\s*$/.exec(String(score || ''));
  if (!m) return 'UNDECIDED';
  const both = Number(m[1]) > 0 && Number(m[2]) > 0;
  const isYes = String(b.outcomeId) === String(b.marketId);
  return (isYes === both) ? 'WIN' : 'LOSE';
}

// Chấm 1 phía kèo Á (AH/OU) từ BIÊN g = (bàn có lợi) - (bàn cần), theo bước 0.25.
// g là bội của 0.25 (bàn thắng nguyên ± vạch .0/.5/.25/.75). Vạch nguyên -> có PUSH;
// vạch nửa -> chỉ WIN/LOSE; vạch tư (0.25/0.75) -> tách đôi -> HALFWIN/HALFLOSS.
export function gradeAsian(g){
  if (g >  0.499) return 'WIN';
  if (g < -0.499) return 'LOSE';
  if (g >  0.001) return 'HALFWIN';   // g == +0.25 (nửa thắng, nửa hòa)
  if (g < -0.001) return 'HALFLOSS';  // g == -0.25 (nửa thua, nửa hòa)
  return 'PUSH';                       // g == 0 (chỉ xảy ra ở vạch nguyên)
}

// Chấm kèo CHUẨN (1x2/ou/ah) TỪ TỈ SỐ 2 hiệp chính — thay cho OddsPapi /settlements (thuần & test được).
// score "a-b" (a=chủ,b=khách). line=midLine(marketId): ah=chấp ĐỘI CHỦ, ou=vạch tổng bàn (1x2 không cần).
// Quy ước oid: 1x2 102=hòa,103=khách,khác=chủ; ou over.oid==marketId; ah home.oid==marketId.
export function gradeStd(b, score, line){
  const m = /^\s*(\d+)\D+(\d+)\s*$/.exec(String(score || ''));
  if (!m) return 'UNDECIDED';
  const a = Number(m[1]), c = Number(m[2]), d = a - c;
  const mt = String(b.marketType), oid = Number(b.outcomeId), mid = Number(b.marketId);
  if (mt === '1x2') {
    const win = oid === 102 ? d === 0 : (oid === 103 ? d < 0 : d > 0);
    return win ? 'WIN' : 'LOSE';
  }
  if (line == null) return 'UNDECIDED';
  if (mt === 'ou') { const total = a + c; return gradeAsian(oid === mid ? total - line : line - total); }
  if (mt === 'ah') { return gradeAsian(oid === mid ? d + line : -d - line); }
  return 'UNDECIDED';
}

// ---- DB-backed shared helpers ----
export async function findMembership(env, poolId, user){
  return await env.DB.prepare(`SELECT * FROM Memberships WHERE poolId=? AND user=?`).bind(poolId, user).first() || null;
}
export async function nicknameOf(env, username){
  const r = await findRow(env, 'Users', 'userLower', String(username).toLowerCase());
  return r ? r.nickname : username;
}
// Bust getMatches cache for every member of a pool (+ the actor, often a non-member admin).
export async function mtKeys(env, poolId, actor){
  const mems = await findRows(env, 'Memberships', 'poolId', poolId);
  const keys = [];
  mems.forEach(m => keys.push('mt_' + poolId + '_' + m.user, 'hist_' + poolId + '_' + m.user));
  if (actor) keys.push('mt_' + poolId + '_' + actor, 'hist_' + poolId + '_' + actor);
  return keys;
}

// marketId -> handicap, from the /markets catalog cached in D1 (built by refreshOdds, Phase 4).
export async function midLine(env, mid, catalog){
  const idx = catalog || await cacheGet(env, MARKETS_CACHE_KEY, 90 * 86400000);
  if (!idx) return undefined;
  for (const k of Object.keys(idx)) for (const l of idx[k]) if (String(l.mid) === String(mid)) return l.hcap;
  return undefined;
}

// Nhãn kèo dựng TỪ dòng bet + tên đội. ctx (tùy chọn) = { catalog, cmByCid } đã prefetch để
// tránh N+1 DB read khi gọi hàng loạt (getHistory); không có ctx thì tự đọc DB như cũ.
export async function betLabel(env, b, t1, t2, ctx){
  const mid = Number(b.marketId), oid = Number(b.outcomeId), mt = String(b.marketType);
  if (mt.indexOf('c_') === 0) {
    const cm = (ctx && ctx.cmByCid) ? ctx.cmByCid[mt.slice(2)] : await findRow(env, 'CustomMarkets', 'cid', mt.slice(2));
    if (!cm) return '';
    let outs = cm.outcomes; if (!outs) { try { outs = JSON.parse(cm.outcomesJson || '[]'); } catch(e){ outs = []; } }
    const oc = outs.filter(o => String(o.oid) === String(b.outcomeId))[0];
    return oc ? (cm.name + ': ' + oc.label) : cm.name;
  }
  if (mt === '1x2') return oid === 102 ? 'Hòa' : (oid === 103 ? t2 : t1);
  if (mt === 'btts') return '2 đội ghi bàn: ' + (oid === mid ? 'Có' : 'Không');
  const cat = ctx && ctx.catalog;
  if (OU_KIND_LABEL[mt]) { const ln = await midLine(env, mid, cat); return (oid === mid ? 'Tài ' : 'Xỉu ') + OU_KIND_LABEL[mt] + (ln != null ? ' ' + ln : ''); }
  if (mt === 'ah') {
    const al = await midLine(env, mid, cat);
    if (al == null) return oid === mid ? t1 : t2;
    const side = oid === mid ? t1 : t2, l2 = oid === mid ? al : -al;
    return side + ' ' + (l2 > 0 ? '+' : '') + l2;
  }
  return '';
}
export function crowdLabels(oddsJson, t1, t2){
  const L = {}; if (!oddsJson) return L;
  try {
    const o = JSON.parse(oddsJson);
    if (o.m1x2) { L['1x2_' + o.m1x2.home.oid] = t1; L['1x2_' + o.m1x2.draw.oid] = 'Hòa'; L['1x2_' + o.m1x2.away.oid] = t2; }
    if (o.mou) { L['ou_' + o.mou.over.oid] = 'Tài bàn ' + o.mou.line; L['ou_' + o.mou.under.oid] = 'Xỉu bàn ' + o.mou.line; }
    EXTRA_KEYS.forEach(k => { const e = o[k]; if (e && e.over) { L[k + '_' + e.over.oid] = 'Tài ' + OU_KIND_LABEL[k] + ' ' + e.line; L[k + '_' + e.under.oid] = 'Xỉu ' + OU_KIND_LABEL[k] + ' ' + e.line; } });
    if (o.btts) { L['btts_' + o.btts.yes.oid] = '2 đội ghi bàn: Có'; L['btts_' + o.btts.no.oid] = '2 đội ghi bàn: Không'; }
    if (o.mah) {
      const hl = (o.mah.line > 0 ? '+' : '') + o.mah.line, al = ((-o.mah.line) > 0 ? '+' : '') + (-o.mah.line);
      L['ah_' + o.mah.home.oid] = t1 + ' ' + hl; L['ah_' + o.mah.away.oid] = t2 + ' ' + al;
    }
  } catch(e){}
  return L;
}
