// Data-access layer — replaces the Google Sheets helpers (readAll_/findRow_/appendRow_/
// setCell_/prop_/cached_) with D1 SQL. Same function shapes so the business-logic port
// stays close to the original; the one unavoidable change is everything is now async.

// Column order per table — lets appendRow(table, [..]) stay a verbatim port of the
// old appendRow_('Sheet', [positional array in sheet-column order]).
export const COLS = {
  Users: ['username','userLower','passHash','salt','nickname','token','tokenExp','createdAt'],
  Pools: ['poolId','name','tournamentIds','dateFrom','dateTo','status','bookmaker','pointsPerMatch','startMultiplier','noshowPenalty','requirePassword','joinPassword','extraMarkets'],
  CustomMarkets: ['poolId','fixtureId','cid','name','outcomesJson','result','settledAt','createdAt','locked'],
  Memberships: ['poolId','user','joinAt','startingPoints','currentPoints','pinnedBadges','blocked'],
  Matches: ['poolId','fixtureId','tournamentId','team1','team2','kickoff','statusId','ouLine','ouMarketId','included','settled','penaltyApplied','lastFetchAt','score','ahMarketId'],
  Odds: ['bookmaker','fixtureId','oddsJson','updatedAt','prevOddsJson','lastFetchAt'],
  Bets: ['betId','poolId','user','fixtureId','marketType','marketId','outcomeId','stake','lockedOdds','placedAt','result','payout','settledAt'],
  Exemptions: ['poolId','user','fixtureId'],
  Cache: ['key','value','updatedAt'],
};

// Sheets stored Dates/numbers as strings; keep that — store everything as TEXT.
function s(v){ return v == null ? '' : (v instanceof Date ? v.toISOString() : String(v)); }

export async function readAll(env, table){
  const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
  return results || [];
}
export async function findRow(env, table, col, val){
  return await env.DB.prepare(`SELECT * FROM ${table} WHERE ${col}=?`).bind(s(val)).first() || null;
}
export async function findRows(env, table, col, val){
  const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${col}=?`).bind(s(val)).all();
  return results || [];
}

// Positional append (verbatim-port form): appendRow(env,'Users',[v0,v1,...]) in COLS order.
export async function appendRow(env, table, arr){
  const cols = COLS[table];
  const obj = {}; cols.forEach((c,i)=> obj[c] = arr[i]);
  return insertRow(env, table, obj);
}
export async function insertRow(env, table, obj){
  const cols = Object.keys(obj);
  const sql = `INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`;
  await env.DB.prepare(sql).bind(...cols.map(c=> s(obj[c]))).run();
}
// keyObj = the row's primary-key columns, e.g. {poolId, user}. patch = {col:val,...}.
export async function updateRow(env, table, keyObj, patch){
  const set = Object.keys(patch).map(c=> `${c}=?`).join(',');
  const where = Object.keys(keyObj).map(c=> `${c}=?`).join(' AND ');
  const sql = `UPDATE ${table} SET ${set} WHERE ${where}`;
  await env.DB.prepare(sql)
    .bind(...Object.values(patch).map(s), ...Object.values(keyObj).map(s)).run();
}
export async function deleteRow(env, table, keyObj){
  const where = Object.keys(keyObj).map(c=> `${c}=?`).join(' AND ');
  await env.DB.prepare(`DELETE FROM ${table} WHERE ${where}`).bind(...Object.values(keyObj).map(s)).run();
}

// ---- Script-properties + cached_ , both backed by the Cache table ----
export async function prop(env, key){
  const r = await env.DB.prepare(`SELECT value FROM Cache WHERE key=?`).bind(key).first();
  return r ? r.value : null;
}
export async function setProp(env, key, value){
  await env.DB.prepare(
    `INSERT INTO Cache(key,value,updatedAt) VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt`
  ).bind(key, s(value), new Date().toISOString()).run();
}
// cached_(key, seconds, fn): serve fresh value within TTL else recompute+store. fn is async.
export async function cached(env, key, seconds, fn){
  const now = Date.now();
  const r = await env.DB.prepare(`SELECT value,updatedAt FROM Cache WHERE key=?`).bind('c:'+key).first();
  if (r && r.updatedAt && (now - new Date(r.updatedAt).getTime()) < seconds*1000){
    try { return JSON.parse(r.value); } catch(e){}
  }
  const v = await fn();
  await setProp(env, 'c:'+key, JSON.stringify(v));
  return v;
}
export async function cacheBust(env, keys){
  for (const k of keys) await env.DB.prepare(`DELETE FROM Cache WHERE key=?`).bind('c:'+k).run();
}

// Persistent cache (port of the old Cache-SHEET cacheGet_/cachePut_): catalog, tournaments,
// sofascoreId, resetAt. Distinct keyspace from cached()'s 'c:' prefix — no collisions.
export async function cacheGet(env, key, maxAgeMs){
  const r = await env.DB.prepare(`SELECT value,updatedAt FROM Cache WHERE key=?`).bind(key).first();
  if (!r || !r.value) return null;
  if (maxAgeMs && (Date.now() - new Date(r.updatedAt).getTime()) > maxAgeMs) return null;
  try { return JSON.parse(r.value); } catch(e){ return null; }
}
export async function cachePut(env, key, obj){
  await setProp(env, key, JSON.stringify(obj));
}
