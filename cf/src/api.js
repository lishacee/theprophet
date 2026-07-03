// External HTTP clients. Port of Code.js OddsPapi client (apiGet_) + ScraperAPI/SofaScore.
// UrlFetchApp -> fetch; Utilities.sleep -> await sleep. Keys come from env secrets.
// ponytail: ScraperAPI path kept verbatim from Code.js. Swap to a same-account service
//   binding to your SofaScore proxy Worker later (drops ScraperAPI credits) — see README.
import { cacheGet, cachePut } from './db.js';
import { parseApiTime, sofaPick } from './core.js';

const API_BASE = 'https://api.oddspapi.io/v4';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function apiKeys(env){
  const multi = String(env.ODDSPAPI_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (multi.length) return multi;
  return [env.ODDSPAPI_KEY, env.ODDSPAPI_KEY_BACKUP].filter(Boolean);
}

export async function apiGet(env, path){
  const keys = apiKeys(env);
  if (!keys.length) throw new Error('Chưa cấu hình OddsPapi key (ODDSPAPI_KEYS hoặc ODDSPAPI_KEY)');
  let lastErr;
  for (let i = 0; i < keys.length; i++) {
    const sep = path.indexOf('?') >= 0 ? '&' : '?';
    const url = API_BASE + path + sep + 'apiKey=' + keys[i];
    for (let attempt = 0; attempt < 3; attempt++) {
      const resp = await fetch(url);
      const code = resp.status;
      if (code === 200) return await resp.json();
      const body = await resp.text();
      if (code === 429 || code === 503) {
        const wait = Number(resp.headers.get('retry-after') || 1);
        if (attempt < 2 && wait <= 10) { await sleep(Math.ceil((wait + 0.3) * 1000)); continue; }
        lastErr = 'HTTP ' + code + ' (rate-limited)'; break;
      }
      if (code === 401 || code === 403) { lastErr = 'HTTP ' + code + ': ' + body.slice(0, 120); break; }
      throw new Error('OddsPapi ' + path + ' -> HTTP ' + code + ': ' + body.slice(0, 200));
    }
  }
  throw new Error('OddsPapi ' + path + ' -> hết key khả dụng (' + lastErr + ')');
}

function scraperKeys(env){
  return String(env.SCRAPERAPI_KEYS || env.SCRAPERAPI_KEY || '').split(',').map(s => s.trim()).filter(Boolean);
}
async function scraperGet(env, targetUrl){
  const keys = scraperKeys(env);
  if (!keys.length) { console.error('scraperGet: Chưa cấu hình SCRAPERAPI_KEYS'); return null; }
  const enc = encodeURIComponent(targetUrl); let lastErr;
  for (let i = 0; i < keys.length; i++) {
    const resp = await fetch('https://api.scraperapi.com/?api_key=' + keys[i] + '&url=' + enc);
    if (resp.status === 200) { try { return await resp.json(); } catch(e){ return null; } }
    lastErr = 'HTTP ' + resp.status;
  }
  console.error('scraperGet ' + targetUrl + ': ' + lastErr + ' (hết key)');
  return null;
}

// sofascoreId (cache 3 tháng; 0 = biết không map được) -> statistics. Fallback tra theo tên+giờ.
export async function sofaStats(env, fixtureId){
  const ck = 'sofa_id2_' + fixtureId;
  let sid = await cacheGet(env, ck, 90 * 86400000);
  if (sid == null) {
    let f;
    try { f = await apiGet(env, '/fixture?fixtureId=' + encodeURIComponent(fixtureId)); }
    catch (e) { console.error('sofa fixture ' + fixtureId + ': ' + e.message); return null; }
    sid = (f && f.externalProviders && f.externalProviders.sofascoreId) || 0;
    if (!sid && f) sid = (await sofaSearch(env, f.participant1Name, f.participant2Name, f.startTime)) || 0;
    await cachePut(env, ck, sid);
  }
  if (!sid) return null;
  return scraperGet(env, 'https://api.sofascore.com/api/v1/event/' + sid + '/statistics');
}
async function sofaSearch(env, t1, t2, startTime){
  const kick = parseApiTime(startTime); if (!kick || !t1 || !t2) return null;
  const res = await scraperGet(env, 'https://api.sofascore.com/api/v1/search/all?q=' + encodeURIComponent(t1 + ' ' + t2) + '&page=0');
  return sofaPick((res && res.results) || [], t1, t2, kick.getTime());
}
