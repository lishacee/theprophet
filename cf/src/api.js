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

// Che key trong log: giữ 3 ký tự đầu + 4 cuối để nhận diện mà không lộ toàn bộ.
const maskKey = k => (k.length <= 8 ? '••••' : k.slice(0, 3) + '…' + k.slice(-4));
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Gọi 1 URL OddsPapi (path đã kèm apiKey). Nếu ODDSPAPI_PROXY được set -> đi qua GAS proxy
// (egress IP Google; OddsPapi chặn IP datacenter Cloudflare). Proxy trả bao {status,body} nên
// ta vẫn thấy đúng mã HTTP thật của OddsPapi. Không set proxy -> gọi thẳng (fallback). Trả {code,text,retryAfter}.
async function fetchOne(env, path, key){
  const sep = path.indexOf('?') >= 0 ? '&' : '?';
  const full = path + sep + 'apiKey=' + key;   // tương đối so với API_BASE
  if (env.ODDSPAPI_PROXY) {
    let url = env.ODDSPAPI_PROXY + '?path=' + encodeURIComponent(full);
    if (env.ODDSPAPI_PROXY_TOKEN) url += '&t=' + encodeURIComponent(env.ODDSPAPI_PROXY_TOKEN);
    const r = await fetch(url);
    if (r.status !== 200) return { code: r.status, text: 'proxy HTTP ' + r.status, retryAfter: null };
    let j; try { j = await r.json(); } catch { return { code: 502, text: 'proxy trả về non-JSON', retryAfter: null }; }
    return { code: Number(j.status) || 502, text: String(j.body == null ? '' : j.body), retryAfter: null };
  }
  const r = await fetch(API_BASE + full, { headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' } });
  return { code: r.status, text: await r.text(), retryAfter: Number(r.headers.get('retry-after')) || null };
}

export async function apiGet(env, path){
  const keys = apiKeys(env);
  if (!keys.length) throw new Error('Chưa cấu hình OddsPapi key (ODDSPAPI_KEYS hoặc ODDSPAPI_KEY)');
  const errs = [];
  for (let i = 0; i < keys.length; i++) {
    const label = `key #${i + 1} (${maskKey(keys[i])})`;
    let keyErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { code, text, retryAfter } = await fetchOne(env, path, keys[i]);
      if (code === 200) {
        if (i > 0) console.log(`OddsPapi ${path}: ${label} OK (bỏ qua ${i} key hỏng phía trước)`);
        return JSON.parse(text);
      }
      if (code === 429 || code === 503) {
        const wait = retryAfter || 1;
        if (attempt < 2 && wait <= 10) { await sleep(Math.ceil((wait + 0.3) * 1000)); continue; }
        keyErr = `HTTP ${code} (rate-limited)`; break;
      }
      if (code === 401 || code === 403) { keyErr = `HTTP ${code} (key hết hạn/không hợp lệ)`; break; }
      throw new Error('OddsPapi ' + path + ' -> HTTP ' + code + ': ' + text.slice(0, 200));
    }
    console.error(`OddsPapi ${path}: ${label} -> ${keyErr} — chuyển key kế`);
    errs.push(`${label}: ${keyErr}`);
  }
  throw new Error(`OddsPapi ${path} -> hết ${keys.length} key khả dụng [${errs.join(' | ')}]`);
}

function scraperKeys(env){
  return String(env.SCRAPERAPI_KEYS || env.SCRAPERAPI_KEY || '').split(',').map(s => s.trim()).filter(Boolean);
}
async function scraperGet(env, targetUrl){
  const keys = scraperKeys(env);
  if (!keys.length) { console.error('scraperGet: Chưa cấu hình SCRAPERAPI_KEYS'); return null; }
  const enc = encodeURIComponent(targetUrl); const errs = [];
  for (let i = 0; i < keys.length; i++) {
    const label = `key #${i + 1} (${maskKey(keys[i])})`;
    const resp = await fetch('https://api.scraperapi.com/?api_key=' + keys[i] + '&url=' + enc);
    if (resp.status === 200) {
      if (i > 0) console.log(`ScraperAPI: ${label} OK (bỏ qua ${i} key hỏng phía trước)`);
      try { return await resp.json(); } catch(e){ return null; }
    }
    const keyErr = (resp.status === 401 || resp.status === 403) ? `HTTP ${resp.status} (key hết hạn/hết credit/không hợp lệ)` : `HTTP ${resp.status}`;
    console.error(`ScraperAPI ${label} -> ${keyErr} — chuyển key kế`);
    errs.push(`${label}: ${keyErr}`);
  }
  console.error(`ScraperAPI ${targetUrl}: hết ${keys.length} key khả dụng [${errs.join(' | ')}]`);
  return null;
}

// sofascoreId (cache 3 tháng; 0 = biết không map được) -> statistics. Fallback tra theo tên+giờ.
export async function sofaStats(env, fixtureId){
  const ck = 'sofa_id2_' + fixtureId;
  let sid = await cacheGet(env, ck, 90 * 86400000);
  if (sid === 0) sid = await cacheGet(env, ck, 3600000);  // 0 = "chưa map được": chỉ giữ 1h rồi thử lại (đủ để auto-retry map vài lần trong cửa sổ STUCK_MANUAL_HOURS=3h; OddsPapi hay backfill sofascoreId sau, hoặc key/search hết lỗi) -> tự lành, khỏi xoá cache tay
  if (sid == null) {
    let f;
    try { f = await apiGet(env, '/fixture?fixtureId=' + encodeURIComponent(fixtureId)); }
    catch (e) { console.error('sofa fixture ' + fixtureId + ': ' + e.message); return null; }
    sid = (f && f.externalProviders && f.externalProviders.sofascoreId) || 0;
    if (!sid && f) {
      const found = await sofaSearch(env, f.participant1Name, f.participant2Name, f.startTime);
      if (found === undefined) return null;   // search fail vì scraper tạm thời (key/infra) -> ĐỪNG cache 0 (khỏi đầu độc 1h), retry lượt sau khi key hồi
      sid = found || 0;                        // null = search chạy nhưng không khớp -> map thất bại thật -> cache 0
    }
    await cachePut(env, ck, sid);
  }
  if (!sid) { console.warn('sofaStats ' + fixtureId + ': không map được sofascoreId (sid=0) -> góc/thẻ UNDECIDED. Tra id tay hoặc chờ auto-retry 1h'); return null; }
  return scraperGet(env, 'https://api.sofascore.com/api/v1/event/' + sid + '/statistics');
}
async function sofaSearch(env, t1, t2, startTime){
  const kick = parseApiTime(startTime); if (!kick || !t1 || !t2) return null;
  const res = await scraperGet(env, 'https://api.sofascore.com/api/v1/search/all?q=' + encodeURIComponent(t1 + ' ' + t2) + '&page=0');
  if (res == null) return undefined;   // scrape lỗi (key chết/infra) -> tín hiệu TẠM THỜI, khác "search chạy nhưng không khớp"
  return sofaPick(res.results || [], t1, t2, kick.getTime());
}
