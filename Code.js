/**
 * Prophet 101 — Backend (Google Apps Script)
 * Stack: Apps Script web app + Google Sheets + OddsPapi
 * Đăng nhập: Username + Password (nickname hiển thị). Deploy "Execute as: Me" → Sheet riêng tư.
 *
 * SETUP (xem HUONG-DAN-DEPLOY.md):
 *  1. Script Properties: ODDSPAPI_KEY, ODDSPAPI_KEY_BACKUP
 *  2. Chạy setup() 1 lần (tạo sheet + trigger).
 *  3. Deploy as Web app (Execute as: Me, Who has access: Anyone).
 */

// ====================== CONFIG ======================
var API_BASE = 'https://api.oddspapi.io/v4';
var SPORT_ID_SOCCER = 10;
var START_MULTIPLIER = 1.1;
var POINTS_PER_MATCH = 400;
var NOSHOW_PENALTY = 200;
var FETCH_WINDOW_HOURS = 24;
var STUCK_MANUAL_HOURS = 4; // quá mốc này từ kickoff mà kèo vẫn UNDECIDED -> chốt trận, giao admin chấm tay (bao 90'+hiệp phụ+pen ~2h40 + 1h chờ SofaScore). Tăng nếu SofaScore hay trễ.
var DEFAULT_BOOKMAKER = 'pinnacle';
// Giải lớn để chọn khi tạo pool — theo tournamentId (slug/tên KHÔNG unique: "premier-league" có ở ~10 nước).
// ponytail: hardcode danh mục giải lớn; thêm/bớt id ở đây nếu cần.
var MAJOR_TOURNAMENT_IDS = [1, 16, 7, 679, 17, 8, 35, 23, 34, 357]; // Euro, WC, UCL, Europa, EPL, LaLiga, Bundesliga, Serie A, Ligue 1, Club WC
var TOURNAMENTS_CACHE_KEY = 'tournaments_major';
var TOURNAMENTS_CACHE_MS = 90 * 86400000; // 3 tháng
var MARKETS_CACHE_KEY = 'markets_index_v1';
var MARKETS_CACHE_MS = 90 * 86400000; // 3 tháng — index vạch kèo (admin bấm refresh khi API đổi)
var TOKEN_TTL_DAYS = 30;

var SHEETS = {
  Users: ['username', 'userLower', 'passHash', 'salt', 'nickname', 'token', 'tokenExp', 'createdAt'],
  Pools: ['poolId', 'name', 'tournamentIds', 'dateFrom', 'dateTo', 'status', 'bookmaker', 'pointsPerMatch', 'startMultiplier', 'noshowPenalty', 'requirePassword', 'joinPassword', 'extraMarkets'],
  // Kèo tuỳ chỉnh admin tạo riêng cho 1 trận trong 1 sảnh (odds tự đặt). result: oid thắng | 'VOID' | '' (chưa chấm).
  // locked: 'Y' khi admin bấm "Chốt hoàn toàn" -> khoá kết quả, không chấm lại được, rời hàng đợi. '' = còn sửa được.
  CustomMarkets: ['poolId', 'fixtureId', 'cid', 'name', 'outcomesJson', 'result', 'settledAt', 'createdAt', 'locked'],
  Memberships: ['poolId', 'user', 'joinAt', 'startingPoints', 'currentPoints', 'pinnedBadges', 'blocked'],
  Matches: ['poolId', 'fixtureId', 'tournamentId', 'team1', 'team2', 'kickoff', 'statusId', 'ouLine', 'ouMarketId', 'included', 'settled', 'penaltyApplied', 'lastFetchAt', 'score', 'ahMarketId'],
  Odds: ['bookmaker', 'fixtureId', 'oddsJson', 'updatedAt', 'prevOddsJson', 'lastFetchAt'], // key (bookmaker,fixtureId) -> dùng CHUNG mọi sảnh
  Bets: ['betId', 'poolId', 'user', 'fixtureId', 'marketType', 'marketId', 'outcomeId', 'stake', 'lockedOdds', 'placedAt', 'result', 'payout', 'settledAt'],
  Exemptions: ['poolId', 'user', 'fixtureId'],
  Cache: ['key', 'value', 'updatedAt']
};

// ====================== SETUP ======================
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) { sh.appendRow(SHEETS[name]); sh.setFrozenRows(1); }
    else { // migrate: thêm cột schema còn thiếu vào cuối (vd extraMarkets ở Pools) — idempotent.
      var have = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
      SHEETS[name].forEach(function (col) { if (have.indexOf(col) < 0) sh.getRange(1, sh.getLastColumn() + 1).setValue(col); });
    }
  });
  removeTriggers_();
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('settleTick').timeBased().everyMinutes(5).create(); // chấm kèo nhịp dày hơn, tách khỏi refreshOdds
  ScriptApp.newTrigger('dailyImport').timeBased().everyHours(6).create();
  ScriptApp.newTrigger('purgeClosedPoolOdds').timeBased().everyDays(2).create();
  SpreadsheetApp.getActiveSpreadsheet().toast('Setup done');
}
function removeTriggers_() { ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); }); }

// Trigger mỗi 2 ngày: dọn odds (dùng chung) không còn sảnh ĐANG MỞ nào tham chiếu.
function purgeClosedPoolOdds() {
  var poolBook = {}, openPool = {};
  readAll_('Pools').forEach(function (p) { poolBook[p.poolId] = p.bookmaker || DEFAULT_BOOKMAKER; if (p.status === 'open') openPool[p.poolId] = 1; });
  var keep = {}; // bookmaker|fixtureId còn được sảnh mở dùng
  readAll_('Matches').forEach(function (mt) {
    if (!openPool[mt.poolId] || String(mt.included).toUpperCase() !== 'Y') return;
    keep[(poolBook[mt.poolId] || DEFAULT_BOOKMAKER) + '|' + mt.fixtureId] = 1;
  });
  var sh = sheet_('Odds');
  // Xoá từ dưới lên để rowIndex không lệch.
  readAll_('Odds').filter(function (o) { return !keep[o.bookmaker + '|' + o.fixtureId]; })
    .sort(function (a, b) { return b.rowIndex - a.rowIndex; })
    .forEach(function (o) { sh.deleteRow(o.rowIndex); });
  delete _SHEET_CACHE_['Odds'];
}

/** Chạy 1 lần sau khi thêm cột mới vào SHEETS: thêm cột thiếu vào cuối sheet đang có. */
function migrateSchema() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); sh.appendRow(SHEETS[name]); sh.setFrozenRows(1); return; }
    var have = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [];
    SHEETS[name].forEach(function (col) {
      if (have.indexOf(col) < 0) sh.getRange(1, sh.getLastColumn() + 1).setValue(col);
    });
  });
  ss.toast('Migrate done');
}

/** Xoá sạch sheet Odds + ghi lại header đúng schema hiện tại (bookmaker,fixtureId,...).
 *  CHẠY SAU KHI deploy code mới khi header Odds bị lệch. Odds tự build lại ở tick kế cho sảnh đang mở trong cửa sổ 24h. */
function resetOddsSheet() {
  var sh = sheet_('Odds');
  if (sh) { sh.clear(); sh.appendRow(SHEETS.Odds); sh.setFrozenRows(1); }
  delete _SHEET_CACHE_['Odds'];
  SpreadsheetApp.getActiveSpreadsheet().toast('Odds reset -> ' + SHEETS.Odds.slice(0, 2).join(','));
}

// ====================== WEB APP ENTRY ======================
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Prophet 101')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ====================== AUTH (Username + Password, nickname hiển thị) ======================
function register(username, password, nickname) {
  username = (username || '').toString().trim();
  password = (password || '').toString();
  nickname = (nickname || '').toString().trim() || username;
  if (!/^[A-Za-z0-9._-]{3,20}$/.test(username)) throw new Error('Username 3–20 ký tự (chữ/số/._-)');
  if (password.length < 4 || password.length > 64) throw new Error('Mật khẩu 4–64 ký tự');
  if (nickname.length < 2 || nickname.length > 20) throw new Error('Nickname 2–20 ký tự');
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    if (findRow_('Users', 'userLower', username.toLowerCase())) throw new Error('Username đã tồn tại, chọn tên khác');
    var salt = Utilities.getUuid();
    var token = Utilities.getUuid();
    var exp = Date.now() + TOKEN_TTL_DAYS * 86400000;
    appendRow_('Users', [username, username.toLowerCase(), hashPass_(password, salt), salt, nickname, token, exp, new Date()]);
    return { username: username, nickname: nickname, token: token, isAdmin: isAdmin_(username) };
  } finally { lock.releaseLock(); }
}

function login(username, password) {
  username = (username || '').toString().trim();
  password = (password || '').toString();
  var r = findRow_('Users', 'userLower', username.toLowerCase());
  if (!r) throw new Error('Username không tồn tại');
  if (hashPass_(password, r.data.salt) !== r.data.passHash) throw new Error('Sai mật khẩu');
  var token = Utilities.getUuid();
  setCell_('Users', r.rowIndex, 'token', token);
  setCell_('Users', r.rowIndex, 'tokenExp', Date.now() + TOKEN_TTL_DAYS * 86400000);
  return { username: r.data.username, nickname: r.data.nickname, token: token, isAdmin: isAdmin_(r.data.username) };
}

/** Khôi phục phiên từ token đã lưu (localStorage). Throw nếu token hết hạn. */
function resume(token) {
  var u = auth_(token);
  var r = findRow_('Users', 'userLower', u.toLowerCase());
  return { username: u, nickname: r.data.nickname, token: token, isAdmin: isAdmin_(u) };
}

/** Đổi nickname hiển thị. */
function setNickname(token, nickname) {
  var username = auth_(token);
  nickname = (nickname || '').toString().trim();
  if (nickname.length < 2 || nickname.length > 20) throw new Error('Nickname 2–20 ký tự');
  var r = findRow_('Users', 'userLower', username.toLowerCase());
  setCell_('Users', r.rowIndex, 'nickname', nickname);
  return { nickname: nickname };
}

/** Trả về username (định danh) từ token, hoặc throw. */
function auth_(token) {
  if (!token) throw new Error('Chưa đăng nhập');
  var r = findRow_('Users', 'token', token);
  if (!r) throw new Error('Phiên hết hạn, đăng nhập lại');
  if (Number(r.data.tokenExp) < Date.now()) throw new Error('Phiên hết hạn, đăng nhập lại');
  return r.data.username;
}

/** Admin = username nằm trong Script Property ADMINS (phân tách bằng dấu phẩy). */
function isAdmin_(username) {
  return (prop_('ADMINS') || '').toLowerCase().split(',').map(function (s) { return s.trim(); }).indexOf(String(username).toLowerCase()) >= 0;
}
function requireAdmin_(token) {
  var u = auth_(token);
  if (!isAdmin_(u)) throw new Error('Không có quyền admin');
  return u;
}

/** Cấu hình điểm theo pool. Mọi mức cược phái sinh từ pointsPerMatch. */
function poolCfg_(p) {
  var ppm = numOr_(p.pointsPerMatch, POINTS_PER_MATCH);
  var pen = p.noshowPenalty;                                  // 0 = không phạt; để trống = mặc định ppm/2
  return {
    pointsPerMatch: ppm,
    startMultiplier: numOr_(p.startMultiplier, START_MULTIPLIER),
    minStake: ppm / 2,        // min = bội số cược
    maxStake: ppm * 2,
    noshowPenalty: (pen === '' || pen == null) ? ppm / 2 : Math.max(0, Number(pen) || 0)
  };
}
function numOr_(v, dflt) { var n = Number(v); return (isFinite(n) && n > 0) ? n : dflt; }

function nicknameOf_(username) {
  var r = findRow_('Users', 'userLower', String(username).toLowerCase());
  return r ? r.data.nickname : username;
}

function hashPass_(password, salt) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password + '|' + salt, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(raw);
}

// ====================== POOLS ======================
function getPools(token) {
  var user = auth_(token);
  var pools = readAll_('Pools').filter(function (p) { return p.status === 'open'; });
  var mems = readAll_('Memberships');
  return pools.map(function (p) {
    var m = mems.filter(function (x) { return x.poolId === p.poolId && x.user === user; })[0];
    var count = mems.filter(function (x) { return x.poolId === p.poolId; }).length;
    // Chỉ lộ "có khoá hay không" — KHÔNG bao giờ gửi joinPassword xuống client.
    return { poolId: p.poolId, name: p.name, joined: !!m, currentPoints: m ? Number(m.currentPoints) : null,
      members: count, requirePassword: poolLocked_(p) };
  });
}
// Pool có khoá = bật cờ requirePassword VÀ có đặt mật khẩu.
function poolLocked_(p) { return String(p.requirePassword).toUpperCase() === 'Y' && String(p.joinPassword || '') !== ''; }

function joinPool(token, poolId, pwd) {
  var user = auth_(token);
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var existing = readAll_('Memberships').filter(function (x) { return x.poolId === poolId && x.user === user; })[0];
    if (existing) return { ok: true, startingPoints: Number(existing.startingPoints), currentPoints: Number(existing.currentPoints) };
    var pool = findRow_('Pools', 'poolId', poolId);
    if (!pool || pool.data.status !== 'open') throw new Error('Pool không mở');
    // Cổng mật khẩu: chỉ chặn người vào MỚI; thành viên cũ đã return ở trên.
    if (poolLocked_(pool.data) && String(pwd || '') !== String(pool.data.joinPassword)) throw new Error('Mật khẩu không đúng');
    var now = new Date();
    var remaining = readAll_('Matches').filter(function (mt) {
      return mt.poolId === poolId && String(mt.included).toUpperCase() === 'Y' && new Date(mt.kickoff) > now;
    }).length;
    var cfg = poolCfg_(pool.data);
    var start = Math.round(remaining * cfg.pointsPerMatch * cfg.startMultiplier);
    appendRow_('Memberships', [poolId, user, now, start, start]);
    cacheBust_(['lb_' + poolId, 'mt_' + poolId + '_' + user]);
    return { ok: true, startingPoints: start, currentPoints: start, remaining: remaining };
  } finally { lock.releaseLock(); }
}

// ====================== MATCHES + ODDS ======================
function getMatches(token, poolId) {
  var user = auth_(token);
  var mem = findMembership_(poolId, user);
  if (mem && String(mem.data.blocked).toUpperCase() === 'Y') throw new Error('Bạn đã bị chặn khỏi sảnh này');
  return cached_('mt_' + poolId + '_' + user, 15, function () { return getMatches_(poolId, user); });
}
function getMatches_(poolId, user) {
  var now = new Date();
  var horizon = new Date(now.getTime() + 48 * 3600000); // chỉ hiện trận trong 48 giờ tới
  var poolRow = findRow_('Pools', 'poolId', poolId);
  var cfg = poolCfg_(poolRow ? poolRow.data : {});
  var matches = readAll_('Matches').filter(function (mt) {
    return mt.poolId === poolId && String(mt.included).toUpperCase() === 'Y'
      && new Date(mt.kickoff) > now && new Date(mt.kickoff) <= horizon;
  });
  var bk = (poolRow && poolRow.data.bookmaker) ? poolRow.data.bookmaker : DEFAULT_BOOKMAKER;
  var enabled = poolExtra_(poolRow ? poolRow.data : {}); // kèo mở rộng bật cho sảnh
  var oddsMap = {}, prevMap = {};
  readAll_('Odds').forEach(function (o) { if (o.bookmaker === bk) { oddsMap[o.fixtureId] = o.oddsJson; prevMap[o.fixtureId] = o.prevOddsJson; } });
  var myBets = readAll_('Bets').filter(function (b) { return b.poolId === poolId && b.user === user; });
  var cmByFix = {}; // kèo custom theo trận
  readAll_('CustomMarkets').forEach(function (c) {
    if (c.poolId !== poolId) return;
    var outs = []; try { outs = JSON.parse(c.outcomesJson || '[]'); } catch (e) { }
    (cmByFix[c.fixtureId] = cmByFix[c.fixtureId] || []).push({ cid: c.cid, name: c.name, result: c.result, outcomes: outs });
  });

  var list = matches.map(function (mt) {
    var kickoff = new Date(mt.kickoff);
    var odds = oddsMap[mt.fixtureId] ? JSON.parse(oddsMap[mt.fixtureId]) : null;
    if (odds) EXTRA_KEYS.forEach(function (k) { if (!enabled[k]) delete odds[k]; }); // ẩn kèo mở rộng sảnh chưa bật
    var bets = myBets.filter(function (b) { return b.fixtureId === mt.fixtureId; });
    return {
      fixtureId: mt.fixtureId, team1: mt.team1, team2: mt.team2,
      kickoff: kickoff.toISOString(), ouLine: (odds && odds.mou) ? odds.mou.line : mt.ouLine, open: now < kickoff, odds: odds,
      customMarkets: cmByFix[mt.fixtureId] || [],
      moves: oddsMoves_(oddsMap[mt.fixtureId], prevMap[mt.fixtureId]), // {mtype_oid: 1|-1} dịch chuyển từ lần cập nhật odds trước
      myBets: bets.map(function (b) { return { marketType: b.marketType, outcomeId: b.outcomeId, stake: Number(b.stake), lockedOdds: Number(b.lockedOdds), result: b.result }; })
    };
  }).sort(function (a, b) { return new Date(a.kickoff) - new Date(b.kickoff); });
  var mem = findMembership_(poolId, user);
  return { minStake: cfg.minStake, maxStake: cfg.maxStake, step: cfg.minStake,
    currentPoints: mem ? Number(mem.data.currentPoints) : null, matches: list };
}

// 1 RPC cho toàn cảnh khi vào sảnh: matches + leaderboard + history. Gộp 3 round-trip client thành 1
// -> cùng 1 execution chia sẻ _SHEET_CACHE_, mỗi sheet đọc đúng 1 lần (thay vì 3 lần × 5 sheet).
function getPoolView(token, poolId) {
  return {
    matches: getMatches(token, poolId),
    leaderboard: getLeaderboard(token, poolId),
    history: getHistory(token, poolId)
  };
}

// ====================== ĐẶT CƯỢC ======================
function placeBet(token, poolId, fixtureId, marketType, outcomeId, stake) {
  var user = auth_(token);
  stake = Number(stake);
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var poolRow = findRow_('Pools', 'poolId', poolId);
    var cfg = poolCfg_(poolRow ? poolRow.data : {});
    if (!(stake >= cfg.minStake && stake % cfg.minStake === 0))
      throw new Error('Điểm cược phải là bội số của ' + cfg.minStake + ' (tối thiểu ' + cfg.minStake + ')');
    var mem = findMembership_(poolId, user);
    if (!mem) throw new Error('Bạn chưa join pool này');
    if (String(mem.data.blocked).toUpperCase() === 'Y') throw new Error('Bạn đã bị chặn khỏi sảnh này');
    var mt = readAll_('Matches').filter(function (x) { return x.poolId === poolId && x.fixtureId === fixtureId; })[0];
    if (!mt) throw new Error('Không tìm thấy trận');
    if (new Date() >= new Date(mt.kickoff)) throw new Error('Trận đã đóng cược');

    // Cho re-bet cùng kèo (mỗi lần khóa odds riêng); tổng stake trên cùng (trận, loại kèo) ≤ max.
    var already = readAll_('Bets').filter(function (b) {
      return b.poolId === poolId && b.user === user && b.fixtureId === fixtureId && b.marketType === marketType;
    }).reduce(function (s, b) { return s + Number(b.stake); }, 0);
    if (already + stake > cfg.maxStake)
      throw new Error('Tổng cược kèo này tối đa ' + cfg.maxStake + 'đ (đã cược ' + already + 'đ, còn ' + (cfg.maxStake - already) + 'đ)');

    var lockedOdds, marketId, nOutcomes;
    if (marketType.indexOf('c_') === 0) {
      // Kèo custom: odds admin tự đặt, đọc từ CustomMarkets (không cần odds bookmaker).
      var cm = readAll_('CustomMarkets').filter(function (c) { return c.poolId === poolId && c.fixtureId === fixtureId && c.cid === marketType.slice(2); })[0];
      if (!cm) throw new Error('Kèo không tồn tại');
      if (cm.result) throw new Error('Kèo đã chấm, không thể cược');
      var couts = JSON.parse(cm.outcomesJson || '[]');
      var coc = couts.filter(function (x) { return String(x.oid) === String(outcomeId); })[0];
      if (!coc) throw new Error('Cửa cược không hợp lệ');
      lockedOdds = coc.price; marketId = cm.cid; nOutcomes = couts.length;
    } else {
      if (EXTRA_KEYS.indexOf(marketType) >= 0 && !poolExtra_(poolRow ? poolRow.data : {})[marketType]) throw new Error('Kèo này chưa được bật cho sảnh');
      var bk = (poolRow && poolRow.data.bookmaker) ? poolRow.data.bookmaker : DEFAULT_BOOKMAKER;
      var oddsRow = readAll_('Odds').filter(function (o) { return o.bookmaker === bk && o.fixtureId === fixtureId; })[0];
      if (!oddsRow) throw new Error('Chưa có odds cho trận này');
      var odds = JSON.parse(oddsRow.oddsJson);
      var okey = marketType === '1x2' ? 'm1x2' : marketType === 'ou' ? 'mou' : marketType === 'ah' ? 'mah' : marketType;
      var e = odds[okey]; if (!e) throw new Error('Chưa có kèo này');
      var sels = ['home', 'draw', 'away', 'over', 'under'].map(function (k) { return e[k]; }).filter(Boolean);
      var sel = sels.filter(function (x) { return String(x.oid) === String(outcomeId); })[0];
      if (!sel) throw new Error('Cửa cược không hợp lệ');
      lockedOdds = sel.price; marketId = e.marketId; nOutcomes = sels.length;
    }
    if (!lockedOdds || lockedOdds <= 1) throw new Error('Odds không hợp lệ');

    // Chặn cược phủ HẾT các cửa của 1 kèo (arb ăn badge). 1X2 được 2/3, cấm đủ 3. Kèo custom miễn.
    if (marketType.indexOf('c_') !== 0) {
      var covered = {};
      readAll_('Bets').forEach(function (b) { if (b.poolId === poolId && b.user === user && b.fixtureId === fixtureId && b.marketType === marketType) covered[String(b.outcomeId)] = 1; });
      covered[String(outcomeId)] = 1;
      if (Object.keys(covered).length >= nOutcomes) throw new Error('Không thể cược phủ hết các cửa của kèo này');
    }

    var cur = Number(mem.data.currentPoints);
    if (cur < stake) throw new Error('Không đủ điểm');

    appendRow_('Bets', [Utilities.getUuid(), poolId, user, fixtureId, marketType, marketId, outcomeId, stake, lockedOdds, new Date(), '', '', '']);
    setCell_('Memberships', mem.rowIndex, 'currentPoints', cur - stake);
    cacheBust_(['lb_' + poolId, 'mt_' + poolId + '_' + user]); // điểm đổi + kèo mới phải hiện ngay
    return { ok: true, lockedOdds: lockedOdds, currentPoints: cur - stake };
  } finally { lock.releaseLock(); }
}

// ====================== LEADERBOARD + BADGE ======================
var BADGE_PRIORITY = ['prophet', 'demonking', 'lonewolf', 'ximup', 'sharpshooter', 'ahdog', 'oudog', 'underdog', 'contrarian', 'onfire'];
var BADGE_BAD = ['bot', 'coldstreak']; // hiện trước, không cho gỡ

function getLeaderboard(token, poolId) {
  auth_(token);
  return cached_('lb_' + poolId, 30, function () { // giống nhau cho mọi user -> cache chung 30s
    var badges = badgesForPool_(poolId); // { user: { earned:[ids], pinned:[ids] } }
    var mems = readAll_('Memberships').filter(function (m) { return m.poolId === poolId && !isBlocked_(m); });
    return mems.map(function (m) {
      var b = badges[m.user] || { earned: [], pinned: [] };
      return { nickname: nicknameOf_(m.user), points: Number(m.currentPoints), start: Number(m.startingPoints),
        badges: b.earned, pinned: b.pinned, streakW: b.streakW || 0, streakL: b.streakL || 0 };
    }).sort(function (a, b) { return b.points - a.points; });
  });
}

// Cho phép chủ tài khoản chọn (tối đa 2) badge muốn hiển thị. Badge XẤU luôn bị ép hiện nên không cần pin.
function setPinnedBadges(token, poolId, idsCsv) {
  var user = auth_(token);
  var mem = findMembership_(poolId, user);
  if (!mem) throw new Error('Bạn chưa tham gia sảnh này');
  var earned = (badgesForPool_(poolId)[user] || { earned: [] }).earned;
  var picks = String(idsCsv || '').split(',').map(function (s) { return s.trim(); })
    .filter(function (id) { return id && BADGE_BAD.indexOf(id) < 0 && earned.indexOf(id) >= 0; }) // chỉ pin badge tốt đã đạt
    .slice(0, 2);
  setCell_('Memberships', mem.rowIndex, 'pinnedBadges', picks.join(','));
  cacheBust_(['lb_' + poolId]);
  return { pinned: picks };
}

// Quét 1 lượt -> stats mỗi user -> badgeEval_ (thuần). Trả earned (đã xếp: XẤU trước, rồi ưu tiên) + pinned.
function badgesForPool_(poolId) {
  var kick = {}, nMatches = 0;
  readAll_('Matches').forEach(function (mt) {
    if (mt.poolId !== poolId) return;
    kick[mt.fixtureId] = new Date(mt.kickoff).getTime();
    if (String(mt.included).toUpperCase() === 'Y') nMatches++;
  });
  var poolRow = findRow_('Pools', 'poolId', poolId);
  var cfg = poolCfg_(poolRow ? poolRow.data : {});
  var baseStart = Math.round(nMatches * cfg.pointsPerMatch * cfg.startMultiplier); // start gốc của pool

  var mems = readAll_('Memberships').filter(function (m) { return m.poolId === poolId && !isBlocked_(m); });
  var pinnedRaw = {};
  var stats = {};
  mems.forEach(function (m) {
    stats[m.user] = { user: m.user, points: Number(m.currentPoints), start: Number(m.startingPoints) || 0,
      nSettled: 0, nWin: 0, ouWin: 0, ahWin: 0, maxWonOdds: 0, contrarian: 0, _byFix: {}, _bigOdd: {} };
    pinnedRaw[m.user] = String(m.pinnedBadges || '').split(',').map(function (s) { return s.trim(); }).filter(String);
  });

  // Đếm số người cược mỗi cửa (mọi kèo, để xác định "phe ít người nhất")
  var mktBettors = {}; // fixture|mtype -> { oid: Set(user), _all: Set(user) }
  var allBets = readAll_('Bets').filter(function (b) { return b.poolId === poolId; });
  allBets.forEach(function (b) {
    var k = b.fixtureId + '|' + b.marketType, m = mktBettors[k] || (mktBettors[k] = { _all: {} });
    (m[b.outcomeId] || (m[b.outcomeId] = {}))[b.user] = 1; m._all[b.user] = 1;
  });
  function isMinority_(b) {
    var m = mktBettors[b.fixtureId + '|' + b.marketType]; if (!m) return false;
    var total = Object.keys(m._all).length;
    if (total < 3) return false; // kèo phải >=3 người
    var mine = Object.keys(m[b.outcomeId] || {}).length;
    return mine / total <= 0.34; // phe thắng thuộc nhóm thiểu số (<=34% số người trong kèo)
  }

  allBets.forEach(function (b) {
    var s = stats[b.user]; if (!s) return;
    if (!b.result) return; // chỉ kèo đã chấm
    var stake = Number(b.stake), payout = Number(b.payout) || 0, won = payout > stake, odds = Number(b.lockedOdds) || 0;
    s.nSettled++; if (won) { s.nWin++; if (odds > s.maxWonOdds) s.maxWonOdds = odds; if (isMinority_(b)) s.contrarian++; if (odds >= 7) s._bigOdd[b.fixtureId + '|' + b.marketType + '|' + b.outcomeId] = 1; }
    if (won && (b.marketType === 'ou' || b.marketType === 'corner_ft' || b.marketType === 'corner_1h')) s.ouWin++; // Tài/Xỉu bàn + góc (cả trận & H1)
    if (b.marketType === 'ah' && won) s.ahWin++;
    var f = s._byFix[b.fixtureId] || (s._byFix[b.fixtureId] = { net: 0, k: kick[b.fixtureId] || 0 });
    f.net += payout - stake;
  });
  // streak thắng/thua liên tiếp tính từ trận gần nhất
  Object.keys(stats).forEach(function (u) {
    var s = stats[u];
    var arr = Object.keys(s._byFix).map(function (fid) { return s._byFix[fid]; }).sort(function (a, b) { return b.k - a.k; });
    var w = 0, l = 0;
    for (var i = 0; i < arr.length; i++) { if (arr[i].net > 0) w++; else break; }
    for (var j = 0; j < arr.length; j++) { if (arr[j].net < 0) l++; else break; }
    s.streakW = w; s.streakL = l; s.bigOddWin = Object.keys(s._bigOdd).length; delete s._byFix; delete s._bigOdd;
  });

  var earnedMap = badgeEval_(Object.keys(stats).map(function (u) { return stats[u]; }), baseStart);
  var out = {};
  Object.keys(stats).forEach(function (u) {
    var earned = earnedMap[u] || [];
    out[u] = { earned: earned, pinned: pinnedRaw[u].filter(function (id) { return earned.indexOf(id) >= 0; }),
      streakW: stats[u].streakW, streakL: stats[u].streakL };
  });
  return out;
}

// THUẦN (không đụng sheet) — dễ test. Nhận mảng stats, trả { user: [badgeId...] } (XẤU trước, rồi theo ưu tiên).
function badgeEval_(rows, baseStart) {
  var n = rows.length;
  var sorted = rows.slice().sort(function (a, b) { return b.points - a.points; });
  var topN = Math.max(1, Math.round(n * 0.2)), botN = Math.max(1, Math.round(n * 0.3));
  var topUsers = {}, botUsers = {};
  sorted.slice(0, topN).forEach(function (r) { topUsers[r.user] = 1; });
  sorted.slice(n - botN).forEach(function (r) { botUsers[r.user] = 1; });
  var ouMax = 0, ahMax = 0;
  rows.forEach(function (r) { if (r.ouWin > ouMax) ouMax = r.ouWin; if (r.ahWin > ahMax) ahMax = r.ahWin; });
  var lead = (n >= 2) ? (sorted[0].points - sorted[1].points) : Infinity;

  var res = {};
  rows.forEach(function (r) {
    var good = [], bad = [];
    var base = baseStart || r.start; // ngưỡng = start gốc của pool; fallback start cá nhân
    // tốt
    if (r.nSettled >= 5 && r.nWin / r.nSettled > 0.85) good.push('prophet');
    else if (r.nSettled >= 5 && r.nWin / r.nSettled > 0.65) good.push('sharpshooter');
    if (n >= 4 && sorted[0].user === r.user && lead >= base / 2) good.push('lonewolf');
    if (n >= 4 && topUsers[r.user]) {
      var avgT = avgOthers_(sorted, r.user);
      if (r.points - avgT > base) good.push('ximup'); // hơn start gốc (bỏ hệ số 1.2)
    }
    if (ahMax >= 3 && r.ahWin === ahMax) good.push('ahdog');
    if (ouMax >= 3 && r.ouWin === ouMax) good.push('oudog');
    if (r.maxWonOdds >= 5) good.push('underdog');
    if (r.bigOddWin >= 1) good.push('demonking');
    if (r.contrarian >= 1) good.push('contrarian');
    if (r.streakW >= 3) good.push('onfire');
    // xấu
    if (r.streakL >= 3) bad.push('coldstreak');
    if (n >= 4 && botUsers[r.user]) {
      var avgB = avgOthers_(sorted, r.user);
      if (avgB - r.points >= base) bad.push('bot');
    }
    good.sort(function (a, b) { return BADGE_PRIORITY.indexOf(a) - BADGE_PRIORITY.indexOf(b); });
    bad.sort(function (a, b) { return BADGE_BAD.indexOf(a) - BADGE_BAD.indexOf(b); });
    res[r.user] = bad.concat(good); // XẤU trước
  });
  return res;
}
function avgOthers_(rows, user) {
  var sum = 0, c = 0;
  rows.forEach(function (r) { if (r.user !== user) { sum += r.points; c++; } });
  return c ? sum / c : 0;
}

// ====================== LỊCH SỬ / KẾT QUẢ ======================
function getHistory(token, poolId) {
  var user = auth_(token);
  var now = new Date();
  var poolRow = findRow_('Pools', 'poolId', poolId);
  var cfg = poolCfg_(poolRow ? poolRow.data : {});
  var mem = findMembership_(poolId, user);
  var joinAt = mem ? new Date(mem.data.joinAt) : null;
  var myBets = readAll_('Bets').filter(function (b) { return b.poolId === poolId && b.user === user; });
  var exemptions = readAll_('Exemptions').filter(function (e) { return e.poolId === poolId && e.user === user; });
  var betFixtures = {};
  myBets.forEach(function (b) { betFixtures[b.fixtureId] = true; });
  // Kèo custom theo trận (admin xem hàng đợi chấm ở tab Kết quả). Kèm locked để biết đã chốt hẳn chưa.
  var cmByFix = {};
  readAll_('CustomMarkets').forEach(function (c) {
    if (c.poolId !== poolId) return;
    var outs = []; try { outs = JSON.parse(c.outcomesJson || '[]'); } catch (e) { }
    (cmByFix[c.fixtureId] = cmByFix[c.fixtureId] || []).push({ cid: c.cid, name: c.name, result: c.result, outcomes: outs, locked: String(c.locked).toUpperCase() === 'Y' });
  });
  // Admin: kèo CHUẨN bị kẹt -> chấm tay. Gom MỌI cược pool chưa có result (không chỉ của admin), của trận đã chốt.
  // Chỉ tính cho admin (khỏi tốn quét + khỏi lộ cho thành viên thường). Outcomes dựng từ Odds JSON của nhà cái sảnh.
  var stuckByFix = {}, oddsByFix = {};
  if (isAdmin_(user)) {
    var poolBk = (poolRow && poolRow.data.bookmaker) ? poolRow.data.bookmaker : DEFAULT_BOOKMAKER;
    readAll_('Odds').forEach(function (o) { if (o.bookmaker === poolBk) oddsByFix[o.fixtureId] = o.oddsJson; });
    var stuckSeen = {};
    readAll_('Bets').forEach(function (b) {
      if (b.poolId !== poolId || b.result || String(b.marketType).indexOf('c_') === 0) return;
      var k = b.fixtureId + '|' + b.marketType; if (stuckSeen[k]) return; stuckSeen[k] = 1;
      (stuckByFix[b.fixtureId] = stuckByFix[b.fixtureId] || []).push(b.marketType);
    });
  }
  // Mốc reset gần nhất: ẩn trận trước đó (mùa cũ; kèo đã xoá nên không còn ngữ cảnh).
  var rAt = prop_('resetAt_' + poolId);
  var resetAt = rAt ? new Date(rAt).getTime() : 0;
  // Hiện: trận đã đá (bất kể có cược) + trận sắp tới mà tôi đã cược.
  var matches = readAll_('Matches').filter(function (mt) {
    if (mt.poolId !== poolId || String(mt.included).toUpperCase() !== 'Y') return false;
    if (new Date(mt.kickoff).getTime() <= resetAt) return false;
    return new Date(mt.kickoff) <= now || betFixtures[mt.fixtureId];
  });

  return matches.map(function (mt) {
    var kickoff = new Date(mt.kickoff);
    var upcoming = kickoff > now;
    var bets = myBets.filter(function (b) { return b.fixtureId === mt.fixtureId; });
    var net = 0, staked = 0, pending = false; // net = lời/lỗ đã chốt; staked = stake đang treo (chưa settle)
    bets.forEach(function (b) {
      if (b.result) net += Number(b.payout) - Number(b.stake);
      else { pending = true; staked += Number(b.stake); }
    });
    var exempt = exemptions.filter(function (e) { return String(e.fixtureId) === 'all' || String(e.fixtureId) === String(mt.fixtureId); }).length > 0;
    // phạt no-show: trận đã áp phạt, user join trước kickoff, không cược, không miễn (khớp applyNoShowPenalty)
    var penalized = String(mt.penaltyApplied).toUpperCase() === 'Y' && bets.length === 0 && !exempt && joinAt && joinAt < kickoff;
    if (penalized) net -= cfg.noshowPenalty;
    var settledY = String(mt.settled).toUpperCase() === 'Y';
    // Trận đã chốt mà còn cược chưa chấm = auto-settle bó tay -> đưa lên hàng đợi admin chấm tay.
    var stuckMarkets = [];
    if (settledY && stuckByFix[mt.fixtureId]) stuckByFix[mt.fixtureId].forEach(function (mtype) {
      var outs = stdOutcomes_(oddsByFix[mt.fixtureId], mtype, mt.team1, mt.team2);
      if (outs.length) stuckMarkets.push({ marketType: mtype, outcomes: outs });
    });
    return {
      fixtureId: mt.fixtureId, team1: mt.team1, team2: mt.team2, kickoff: kickoff.toISOString(), score: scoreStr_(mt.score), upcoming: upcoming,
      settled: settledY, penalized: penalized, pending: pending, net: Math.round(net), staked: Math.round(staked),
      customMarkets: cmByFix[mt.fixtureId] || [], stuckMarkets: stuckMarkets,
      bets: bets.map(function (b) { return { marketType: b.marketType, label: betLabel_(b, mt.team1, mt.team2), stake: Number(b.stake), lockedOdds: Number(b.lockedOdds), result: resultVi_(b.result), payout: Number(b.payout) || 0 }; })
    };
  }).sort(function (a, b) { return new Date(b.kickoff) - new Date(a.kickoff); }); // mới nhất trước
}

// ====================== AI: XEM MỌI NGƯỜI CƯỢC GÌ ======================
// #1 đồng thuận: chỉ hiện sau khi BẠN đã cược trận này. #2 chi tiết cá nhân: chỉ khi trận đã đóng (kickoff qua).
function getCrowd(token, poolId, fixtureId) {
  var user = auth_(token);
  var mt = readAll_('Matches').filter(function (m) { return m.poolId === poolId && String(m.fixtureId) === String(fixtureId); })[0];
  if (!mt) throw new Error('Trận không tồn tại');
  var open = new Date(mt.kickoff) > new Date();
  var bets = readAll_('Bets').filter(function (b) { return b.poolId === poolId && String(b.fixtureId) === String(fixtureId); });
  var iBet = bets.some(function (b) { return b.user === user; });
  if (open && !iBet) return { locked: true }; // chưa cược + chưa đóng -> khoá

  var poolRow = findRow_('Pools', 'poolId', poolId);
  var bk = (poolRow && poolRow.data.bookmaker) ? poolRow.data.bookmaker : DEFAULT_BOOKMAKER;
  var oddsRow = readAll_('Odds').filter(function (o) { return o.bookmaker === bk && o.fixtureId === fixtureId; })[0];
  var labels = crowdLabels_(oddsRow ? oddsRow.oddsJson : null, mt.team1, mt.team2);
  // Ưu tiên nhãn dựng từ chính dòng cược (marketId/outcomeId của nó) -> đúng cả khi cược ở vạch khác
  // vạch odds hiện tại (vd 2 người cược 2 vạch chấp khác nhau). crowdLabels_/#id chỉ là fallback.
  var lbl = function (b) { return betLabel_(b, mt.team1, mt.team2) || labels[b.marketType + '_' + b.outcomeId] || ('#' + b.outcomeId); };

  var agg = {};
  bets.forEach(function (b) {
    var k = b.marketType + '_' + b.outcomeId;
    if (!agg[k]) agg[k] = { marketType: b.marketType, outcomeId: String(b.outcomeId), label: lbl(b), n: 0, stake: 0, _users: {} };
    if (!agg[k]._users[b.user]) { agg[k]._users[b.user] = 1; agg[k].n++; } // đếm người duy nhất, không phải số lượt
    agg[k].stake += Number(b.stake);
  });
  Object.keys(agg).forEach(function (k) { delete agg[k]._users; });
  var out = { locked: false, open: open, agg: Object.keys(agg).map(function (k) { return agg[k]; }) };
  if (!open) { // #2: lộ chi tiết cá nhân sau khi đóng
    out.bets = bets.map(function (b) {
      return { nick: nicknameOf_(b.user), me: b.user === user, marketType: b.marketType, label: lbl(b),
        stake: Number(b.stake), lockedOdds: Number(b.lockedOdds), result: resultVi_(b.result), payout: Number(b.payout) || 0 };
    }).sort(function (a, b) { return b.stake - a.stake; });
  }
  return out;
}
// Nhãn kèo dựng TỪ chính dòng bet (marketId/outcomeId) + tên đội — không cần Odds sheet,
// nên vẫn đúng kể cả khi Odds của sảnh đã bị xoá.
function betLabel_(b, t1, t2) {
  var mid = Number(b.marketId), oid = Number(b.outcomeId), mt = String(b.marketType);
  if (mt.indexOf('c_') === 0) { // kèo custom: tên + nhãn cửa từ CustomMarkets
    var cm = readAll_('CustomMarkets').filter(function (c) { return c.cid === mt.slice(2); })[0];
    if (!cm) return '';
    var oc; try { oc = JSON.parse(cm.outcomesJson || '[]').filter(function (o) { return String(o.oid) === String(b.outcomeId); })[0]; } catch (e) { }
    return oc ? (cm.name + ': ' + oc.label) : cm.name;
  }
  if (mt === '1x2') return oid === 102 ? 'Hòa' : (oid === 103 ? t2 : t1);
  if (OU_KIND_LABEL[mt]) { var ln = midLine_(mid); return (oid === mid ? 'Tài ' : 'Xỉu ') + OU_KIND_LABEL[mt] + (ln != null ? ' ' + ln : ''); }
  if (mt === 'ah') { var al = midLine_(mid); if (al == null) return oid === mid ? t1 : t2; var side = oid === mid ? t1 : t2, l2 = oid === mid ? al : -al; return side + ' ' + (l2 > 0 ? '+' : '') + l2; }
  return '';
}
function crowdLabels_(oddsJson, t1, t2) {
  var L = {}; if (!oddsJson) return L;
  try {
    var o = JSON.parse(oddsJson);
    if (o.m1x2) { L['1x2_' + o.m1x2.home.oid] = t1; L['1x2_' + o.m1x2.draw.oid] = 'Hòa'; L['1x2_' + o.m1x2.away.oid] = t2; }
    if (o.mou) { L['ou_' + o.mou.over.oid] = 'Tài bàn ' + o.mou.line; L['ou_' + o.mou.under.oid] = 'Xỉu bàn ' + o.mou.line; }
    EXTRA_KEYS.forEach(function (k) { var e = o[k]; if (e && e.over) { L[k + '_' + e.over.oid] = 'Tài ' + OU_KIND_LABEL[k] + ' ' + e.line; L[k + '_' + e.under.oid] = 'Xỉu ' + OU_KIND_LABEL[k] + ' ' + e.line; } });
    if (o.mah) {
      var hl = (o.mah.line > 0 ? '+' : '') + o.mah.line, al = ((-o.mah.line) > 0 ? '+' : '') + (-o.mah.line);
      L['ah_' + o.mah.home.oid] = t1 + ' ' + hl; L['ah_' + o.mah.away.oid] = t2 + ' ' + al;
    }
  } catch (e) { }
  return L;
}

// ====================== SCHEDULER ======================
function tick() {
  try { refreshOdds(); } catch (e) { log_('refreshOdds', e); }
  try { applyNoShowPenalty(); } catch (e) { log_('penalty', e); }
}
// Chấm kèo tách riêng, nhịp 5' để clear nhanh sau khi trận xong (refreshOdds vẫn 15', không đốt thêm quota odds).
function settleTick() {
  try { settleMatches(); } catch (e) { log_('settleMatches', e); }
}

function refreshOdds(force) {
  var now = new Date();
  var poolBook = {}, skipPool = {};
  readAll_('Pools').forEach(function (p) { poolBook[p.poolId] = p.bookmaker || DEFAULT_BOOKMAKER; if (p.status !== 'open') skipPool[p.poolId] = 1; });

  // Chỉ fetch odds cho sảnh ĐANG MỞ — draft (đang setup) & closed không tốn call/ghi odds.
  var matches = readAll_('Matches').filter(function (mt) { return String(mt.included).toUpperCase() === 'Y' && !skipPool[mt.poolId]; });

  // Odds dùng CHUNG theo (bookmaker, fixtureId): nhiều sảnh cùng trận+nhà cái chỉ 1 dòng, 1 lần ghi.
  var oddsByBkFix = {};
  readAll_('Odds').forEach(function (o) { oddsByBkFix[o.bookmaker + '|' + o.fixtureId] = { oddsJson: o.oddsJson, lastFetchAt: o.lastFetchAt }; });

  // Gom theo (bookmaker | tournament) — đúng đơn vị API; fixture BỎ TRÙNG giữa các sảnh.
  // Nhịp fetch do trận đá SỚM NHẤT trong nhóm quyết định; mốc đã-fetch lấy từ dòng Odds chung.
  var groups = {};
  matches.forEach(function (mt) {
    var kickoff = new Date(mt.kickoff);
    if (kickoff <= now) return;
    if ((kickoff - now) / 3600000 > FETCH_WINDOW_HOURS) return;
    var bk = poolBook[mt.poolId] || DEFAULT_BOOKMAKER;
    var g = groups[bk + '|' + mt.tournamentId] || (groups[bk + '|' + mt.tournamentId] = { bk: bk, tid: mt.tournamentId, earliest: null, lastFetch: null });
    if (!g.earliest || kickoff < g.earliest) g.earliest = kickoff;
    var rec = oddsByBkFix[bk + '|' + mt.fixtureId];
    var lf = (rec && rec.lastFetchAt) ? new Date(rec.lastFetchAt) : null;
    if (lf && (!g.lastFetch || lf > g.lastFetch)) g.lastFetch = lf;
  });

  // Chọn nhóm tới hạn; gom tournamentId tới hạn theo bookmaker (1 call/bookmaker).
  var dueByBook = {}, dueGroups = [];
  Object.keys(groups).forEach(function (key) {
    var g = groups[key];
    var hoursLeft = (g.earliest - now) / 3600000;
    // Bậc fetch: 24h→6h = 120', 6h→1h = 30', ≤1h = 15'.
    var minGap = hoursLeft <= 1 ? 15 : (hoursLeft <= 6 ? 30 : 120);
    if (!force && g.lastFetch && (now - g.lastFetch) / 60000 < minGap - 1) return;
    dueGroups.push(g);
    (dueByBook[g.bk] = dueByBook[g.bk] || []).push(g.tid);
  });
  if (!dueGroups.length) return;

  // 1 call odds-by-tournament trả MỌI fixture của giải -> cập nhật cả trận ngoài cửa sổ 24h (0 tốn thêm).
  // Gom fixture DUY NHẤT theo (bk|tid) — 1 đại diện/fixture là đủ vì odds dùng chung.
  var fixByBkTid = {};
  matches.forEach(function (mt) {
    if (new Date(mt.kickoff) <= now) return;
    var bk = poolBook[mt.poolId] || DEFAULT_BOOKMAKER;
    var k = bk + '|' + mt.tournamentId;
    (fixByBkTid[k] = fixByBkTid[k] || {})[mt.fixtureId] = 1;
  });

  // Đã có ai cược kèo AH cho trận này chưa (BẤT KỲ sảnh nào) -> chưa thì vạch AH re-pick tới sát giờ.
  var ahBetFix = {};
  readAll_('Bets').forEach(function (b) { if (b.marketType === 'ah') ahBetFix[b.fixtureId] = 1; });

  if (!Object.keys(dueByBook).length) return;
  var catalog = marketsIndex_(); // index vạch (cache 3 tháng)

  Object.keys(dueByBook).forEach(function (bk) {
    var tids = dueByBook[bk];
    var data = apiGet_('/odds-by-tournaments?bookmaker=' + bk + '&oddsFormat=decimal&tournamentIds=' + tids.join(','));
    if (!Array.isArray(data)) return;
    var fixById = {};
    data.forEach(function (f) { fixById[f.fixtureId] = f; });
    tids.forEach(function (tid) {
      Object.keys(fixByBkTid[bk + '|' + tid] || {}).forEach(function (fixtureId) {
        var f = fixById[fixtureId];
        if (!f || !f.bookmakerOdds || !f.bookmakerOdds[bk]) return;
        var rec = oddsByBkFix[bk + '|' + fixtureId];
        var prev = null; try { prev = (rec && rec.oddsJson) ? JSON.parse(rec.oddsJson) : null; } catch (e) { }
        // Vạch KHOÁ từ lần build trước để không nhảy vạch. lock:'always' giữ ngay; 'onBet' (AH) chỉ giữ khi đã có người cược.
        var forced = {};
        MKT_FAMILIES.forEach(function (fam) {
          if (fam.kind === '1x2' || !prev || !prev[fam.key]) return;
          if (fam.lock === 'onBet') { if (fam.key === 'mah' && ahBetFix[fixtureId]) forced[fam.key] = prev[fam.key].marketId; }
          else if (fam.lock === 'always') forced[fam.key] = prev[fam.key].marketId;
        });
        var built = buildOdds_(f.bookmakerOdds[bk].markets, catalog, forced);
        if (!built) return;
        upsertOdds_(bk, fixtureId, JSON.stringify(built));
      });
    });
  });
}

// Cấu hình các "họ kèo" build vào oddsJson. Vạch (marketId->handicap->oid) suy ra ĐỘNG từ /markets catalog.
//   kind: '1x2' (3 cửa) | 'ou' (Tài/Xỉu, cửa cân nhất) | 'ah' (Chấp, odds gần 2.0 nhất)
//   lineFilter: 'half' = chỉ vạch .5 (né hoà/push) | 'ah' = chỉ .0/.5 (bỏ .25/.75, né thắng/thua nửa) | null = mọi vạch
//   lock: 'always' = chốt vạch 1 lần rồi giữ | 'onBet' = re-pick tới khi có người cược
// key = key trong oddsJson (frontend đọc m.odds[key]). EXTRA_KEYS = các kèo admin bật/tắt theo sảnh.
// AH chỉ lấy .0/.5 (pinnacle luôn có). Nhà cái chỉ treo ¼/¾ (vd bet365) sẽ không hiện kèo chấp -> đổi sang pinnacle.
var MKT_FAMILIES = [
  { key: 'm1x2',      type: '1x2',             period: 'fulltime', kind: '1x2' },
  { key: 'mou',       type: 'totals',          period: 'fulltime', kind: 'ou', lineFilter: 'half', lock: 'always' },
  { key: 'mah',       type: 'spreads',         period: 'fulltime', kind: 'ah', lineFilter: 'ah',   lock: 'onBet' },
  { key: 'corner_ft', type: 'totals-corners',  period: 'fulltime', kind: 'ou', lineFilter: 'half', lock: 'always' },
  { key: 'corner_1h', type: 'totals-corners',  period: 'p1',       kind: 'ou', lineFilter: 'half', lock: 'always' },
  { key: 'card_ft',   type: 'totals-bookings', period: 'fulltime', kind: 'ou', lineFilter: 'half', lock: 'always' }
];
var EXTRA_KEYS = ['corner_ft', 'corner_1h', 'card_ft']; // kèo mở rộng — admin bật/tắt theo sảnh (pool.extraMarkets)
// Nhãn "loại Tài/Xỉu" cho từng marketType O/U (làm rõ trên UI + history): Tài bàn / Tài góc / Tài thẻ.
var OU_KIND_LABEL = { ou: 'bàn', corner_ft: 'góc', corner_1h: 'góc H1', card_ft: 'thẻ' };

function isHalfLine_(h) { return Math.abs((Math.abs(h) * 2) % 2 - 1) < 1e-9; }        // .5, 1.5, 2.5…
function isAhLine_(h) { return Math.abs((Math.abs(h) * 2) % 1) < 1e-9; }               // bội số 0.5 (bỏ .25/.75)

// Index vạch theo (marketType|period) từ /markets — chỉ giữ các family cần, cache 3 tháng (nhỏ, vài KB).
function marketsIndex_() {
  var c = cacheGet_(MARKETS_CACHE_KEY, MARKETS_CACHE_MS); if (c) return c;
  var data = apiGet_('/markets?sportId=' + SPORT_ID_SOCCER);
  var want = {}; MKT_FAMILIES.forEach(function (f) { want[f.type + '|' + f.period] = 1; });
  var idx = {};
  (Array.isArray(data) ? data : []).forEach(function (m) {
    var k = m.marketType + '|' + m.period; if (!want[k]) return;
    (idx[k] = idx[k] || []).push({ mid: m.marketId, hcap: m.handicap, oids: (m.outcomes || []).map(function (o) { return o.outcomeId; }) });
  });
  cachePut_(MARKETS_CACHE_KEY, idx);
  return idx;
}

// Reverse map marketId -> vạch (hcap), dựng 1 lần/execution từ catalog. Dùng để dựng nhãn kèo khi Odds đã xoá.
var _MID_LINE_ = null;
function midLine_(mid) {
  if (!_MID_LINE_) {
    _MID_LINE_ = {};
    try { var idx = marketsIndex_(); Object.keys(idx).forEach(function (k) { idx[k].forEach(function (l) { _MID_LINE_[String(l.mid)] = l.hcap; }); }); } catch (e) { }
  }
  return _MID_LINE_[String(mid)];
}

/**
 * Trích các họ kèo từ markets của bookmaker, dựa trên catalog vạch (marketsIndex_).
 * forced: {key: marketId} — vạch đã khoá từ lần build trước (giữ ổn định, không nhảy vạch).
 */
function buildOdds_(markets, catalog, forced) {
  if (!markets) return null;
  forced = forced || {};
  function price(mid, oid) { try { return markets[String(mid)].outcomes[String(oid)].players['0'].price; } catch (e) { return null; } }
  var out = {};

  MKT_FAMILIES.forEach(function (fam) {
    var lines = catalog[fam.type + '|' + fam.period]; if (!lines || !lines.length) return;

    if (fam.kind === '1x2') {
      var L = lines[0], o = L.oids; // [home, draw, away]
      var h = price(L.mid, o[0]), d = price(L.mid, o[1]), a = price(L.mid, o[2]);
      if (h && d && a) out[fam.key] = { marketId: L.mid, home: { oid: o[0], price: h }, draw: { oid: o[1], price: d }, away: { oid: o[2], price: a } };
      return;
    }

    // ou / ah: chọn vạch (khoá nếu forced), oids = [over/home, under/away]
    var chosen = null;
    var fmid = forced[fam.key];
    if (fmid) chosen = lines.filter(function (l) { return String(l.mid) === String(fmid); })[0] || null;
    if (!chosen) {
      var best = Infinity;
      lines.forEach(function (l) {
        if (fam.lineFilter === 'half' && !isHalfLine_(l.hcap)) return;
        if (fam.lineFilter === 'ah' && !isAhLine_(l.hcap)) return;
        var p1 = price(l.mid, l.oids[0]), p2 = price(l.mid, l.oids[1]); if (!(p1 && p2)) return;
        var imb = Math.abs(p1 - p2); // vạch cân nhất = odds 2 cửa sát nhau nhất (áp cho cả Tài/Xỉu & Chấp)
        if (imb < best) { best = imb; chosen = l; }
      });
    }
    if (!chosen) return;
    var a1 = price(chosen.mid, chosen.oids[0]), a2 = price(chosen.mid, chosen.oids[1]); if (!(a1 && a2)) return;
    if (fam.kind === 'ah') out[fam.key] = { marketId: chosen.mid, line: chosen.hcap, home: { oid: chosen.oids[0], price: a1 }, away: { oid: chosen.oids[1], price: a2 } };
    else out[fam.key] = { marketId: chosen.mid, line: chosen.hcap, over: { oid: chosen.oids[0], price: a1 }, under: { oid: chosen.oids[1], price: a2 } };
  });

  return Object.keys(out).length ? out : null;
}

// Kèo mở rộng bật cho sảnh: parse pool.extraMarkets (JSON) -> {key:true}.
function poolExtra_(poolData) {
  var em = {}; try { var j = JSON.parse(poolData.extraMarkets || '{}'); EXTRA_KEYS.forEach(function (k) { if (j[k] && j[k].enabled) em[k] = true; }); } catch (e) { }
  return em;
}
// Dạng đầy đủ cho form admin: {key:{enabled:bool}} cho mọi EXTRA_KEYS.
function poolExtraObj_(poolData) {
  var en = poolExtra_(poolData), o = {}; EXTRA_KEYS.forEach(function (k) { o[k] = { enabled: !!en[k] }; }); return o;
}

// ====================== ADMIN: KÈO CUSTOM (tự đặt tên & tỷ lệ, chấm tay) ======================
// Tạo kèo riêng cho 1 trận trong 1 sảnh. outcomes: [{label, price}] (2-6 cửa). oid = chỉ số 0..n.
function adminAddMarket(token, poolId, fixtureId, name, outcomes) {
  var u = requireAdmin_(token);
  name = (name || '').toString().trim();
  if (!name) throw new Error('Cần tên kèo');
  if (!Array.isArray(outcomes) || outcomes.length < 2) throw new Error('Cần ít nhất 2 cửa cược');
  if (outcomes.length > 6) throw new Error('Tối đa 6 cửa');
  var outs = outcomes.map(function (o, i) {
    var lbl = (o.label || '').toString().trim(), p = Number(o.price);
    if (!lbl) throw new Error('Cửa thiếu tên');
    if (!(p > 1)) throw new Error('Tỷ lệ phải là số > 1');
    return { oid: i, label: lbl, price: Math.round(p * 100) / 100 };
  });
  var cid = Utilities.getUuid().slice(0, 8);
  appendRow_('CustomMarkets', [poolId, fixtureId, cid, name, JSON.stringify(outs), '', '', new Date()]);
  cacheBust_(mtKeys_(poolId, u));
  return { ok: true, cid: cid };
}

// Sửa kèo custom: đổi tên + nhãn/tỷ lệ, và ĐƯỢC thêm cửa mới. KHÔNG cho xoá cửa cũ (đã có thể có người cược).
// Cửa mới (oid rỗng) được cấp oid = max(oid cũ)+1 -> không tái dùng oid -> cược cũ vẫn khớp.
// Odds sửa chỉ áp cho cược MỚI; cược đã đặt giữ lockedOdds cũ. Kèo đã chấm thì không sửa.
function adminEditMarket(token, poolId, fixtureId, cid, name, outcomes) {
  var u = requireAdmin_(token);
  var cm = readAll_('CustomMarkets').filter(function (c) { return c.poolId === poolId && c.fixtureId === fixtureId && c.cid === cid; })[0];
  if (!cm) throw new Error('Kèo không tồn tại');
  if (cm.result) throw new Error('Kèo đã chấm, không sửa được');
  name = (name || '').toString().trim();
  if (!name) throw new Error('Cần tên kèo');
  if (!Array.isArray(outcomes)) throw new Error('Thiếu cửa cược');
  if (outcomes.length > 6) throw new Error('Tối đa 6 cửa');
  var existing = JSON.parse(cm.outcomesJson || '[]');
  var byOid = {}; existing.forEach(function (o) { byOid[String(o.oid)] = o; });
  var maxOid = existing.reduce(function (m, o) { return Math.max(m, Number(o.oid)); }, -1);
  var seen = {};
  var outs = outcomes.map(function (o) {
    var lbl = (o.label || '').toString().trim(), p = Number(o.price);
    if (!lbl) throw new Error('Cửa thiếu tên');
    if (!(p > 1)) throw new Error('Tỷ lệ phải là số > 1');
    var oid;
    if (o.oid === '' || o.oid == null) { oid = ++maxOid; }                 // cửa mới
    else {
      var key = String(o.oid);
      if (!(key in byOid) || seen[key]) throw new Error('Cửa cược không hợp lệ');
      seen[key] = 1; oid = byOid[key].oid;
    }
    return { oid: oid, label: lbl, price: Math.round(p * 100) / 100 };
  });
  existing.forEach(function (o) { if (!seen[String(o.oid)]) throw new Error('Không được xoá cửa cược đã có'); }); // giữ đủ cửa cũ
  setCell_('CustomMarkets', cm.rowIndex, 'name', name);
  setCell_('CustomMarkets', cm.rowIndex, 'outcomesJson', JSON.stringify(outs));
  cacheBust_(mtKeys_(poolId, u));
  return { ok: true };
}

// Xoá kèo custom + hoàn toàn bộ điểm đã cược (dùng khi tạo nhầm hoặc huỷ hẳn).
function adminDeleteMarket(token, poolId, fixtureId, cid) {
  var u = requireAdmin_(token);
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var mt = 'c_' + cid;
    refundBets_(poolId, fixtureId, mt); // trả điểm mọi cược chưa chấm
    // Xoá dòng kèo custom.
    var sh = sheet_('CustomMarkets');
    readAll_('CustomMarkets').filter(function (c) { return c.poolId === poolId && c.fixtureId === fixtureId && c.cid === cid; })
      .sort(function (a, b) { return b.rowIndex - a.rowIndex; })
      .forEach(function (c) { sh.deleteRow(c.rowIndex); });
    delete _SHEET_CACHE_['CustomMarkets'];
    cacheBust_(mtKeys_(poolId, u));
    return { ok: true };
  } finally { lock.releaseLock(); }
}

// Chấm kèo custom: winningOid = oid cửa thắng, hoặc 'VOID' (hoàn cả kèo). Cửa thắng payout stake×odds, còn lại thua.
function adminSettleMarket(token, poolId, fixtureId, cid, winningOid) {
  var u = requireAdmin_(token);
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var cm = readAll_('CustomMarkets').filter(function (c) { return c.poolId === poolId && c.fixtureId === fixtureId && c.cid === cid; })[0];
    if (!cm) throw new Error('Kèo không tồn tại');
    if (String(cm.locked).toUpperCase() === 'Y') throw new Error('Kèo đã chốt hoàn toàn, không chấm lại được');
    var isVoid = (String(winningOid) === 'VOID');
    var bets = readAll_('Bets').filter(function (b) { return b.poolId === poolId && b.fixtureId === fixtureId && b.marketType === ('c_' + cid); });
    // Chấm LẠI được: đảo payout đã cộng lần trước rồi áp payout mới (delta) -> không double-credit.
    bets.forEach(function (b) {
      var stake = Number(b.stake), odds = Number(b.lockedOdds), payout, res;
      if (isVoid) { res = 'CANCELLED'; payout = stake; }
      else if (String(b.outcomeId) === String(winningOid)) { res = 'WIN'; payout = stake * odds; }
      else { res = 'LOSS'; payout = 0; }
      var oldPayout = b.result ? Number(b.payout) : 0; // đã chấm trước đó -> điểm đã cộng khoản này rồi
      setCell_('Bets', b.rowIndex, 'result', res);
      setCell_('Bets', b.rowIndex, 'payout', payout);
      setCell_('Bets', b.rowIndex, 'settledAt', new Date());
      var delta = payout - oldPayout;
      if (delta !== 0) { var mem = findMembership_(poolId, b.user); if (mem) setCell_('Memberships', mem.rowIndex, 'currentPoints', Number(mem.data.currentPoints) + delta); }
    });
    setCell_('CustomMarkets', cm.rowIndex, 'result', isVoid ? 'VOID' : String(winningOid));
    setCell_('CustomMarkets', cm.rowIndex, 'settledAt', new Date());
    cacheBust_(mtKeys_(poolId, u).concat(['lb_' + poolId]));
    return { ok: true };
  } finally { lock.releaseLock(); }
}

// Chốt hoàn toàn kèo custom: khoá kết quả (không chấm lại được), rời khỏi hàng đợi chấm. Chỉ chốt khi đã có kết quả.
function adminFinalizeMarket(token, poolId, fixtureId, cid) {
  var u = requireAdmin_(token);
  var cm = readAll_('CustomMarkets').filter(function (c) { return c.poolId === poolId && c.fixtureId === fixtureId && c.cid === cid; })[0];
  if (!cm) throw new Error('Kèo không tồn tại');
  if (cm.result == null || cm.result === '') throw new Error('Kèo chưa chấm, chưa thể chốt');
  setCell_('CustomMarkets', cm.rowIndex, 'locked', 'Y');
  cacheBust_(mtKeys_(poolId, u).concat(['lb_' + poolId]));
  return { ok: true };
}

// Admin chấm tay kèo CHUẨN bị kẹt (auto-settle bó tay). Giống adminSettleMarket nhưng cho bet marketType chuẩn
// (1x2/ou/ah/corner_*/card_ft) — không có dòng CustomMarkets. winningOid = oid thắng | 'VOID' (hoàn cược).
// Chấm lại được: đảo payout cũ rồi áp mới (delta) -> không double-credit.
function adminSettleStdMarket(token, poolId, fixtureId, marketType, winningOid) {
  var u = requireAdmin_(token);
  if (String(marketType).indexOf('c_') === 0) throw new Error('Kèo custom dùng chức năng chấm riêng');
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var isVoid = (String(winningOid) === 'VOID');
    var bets = readAll_('Bets').filter(function (b) { return b.poolId === poolId && b.fixtureId === fixtureId && b.marketType === marketType; });
    if (!bets.length) throw new Error('Không có cược nào cho kèo này');
    bets.forEach(function (b) {
      var stake = Number(b.stake), odds = Number(b.lockedOdds), payout, res;
      if (isVoid) { res = 'CANCELLED'; payout = stake; }
      else if (String(b.outcomeId) === String(winningOid)) { res = 'WIN'; payout = stake * odds; }
      else { res = 'LOSS'; payout = 0; }
      var oldPayout = b.result ? Number(b.payout) : 0;
      setCell_('Bets', b.rowIndex, 'result', res);
      setCell_('Bets', b.rowIndex, 'payout', payout);
      setCell_('Bets', b.rowIndex, 'settledAt', new Date());
      var delta = payout - oldPayout;
      if (delta !== 0) { var mem = findMembership_(poolId, b.user); if (mem) setCell_('Memberships', mem.rowIndex, 'currentPoints', Number(mem.data.currentPoints) + delta); }
    });
    cacheBust_(mtKeys_(poolId, u).concat(['lb_' + poolId]));
    return { ok: true };
  } finally { lock.releaseLock(); }
}

// Cửa cược của 1 kèo CHUẨN để admin chấm tay — dựng từ Odds JSON của trận. [] nếu Odds đã bị xoá.
function stdOutcomes_(oddsJson, marketType, t1, t2) {
  if (!oddsJson) return [];
  var o; try { o = JSON.parse(oddsJson); } catch (e) { return []; }
  var n = o[{ '1x2': 'm1x2', 'ou': 'mou', 'ah': 'mah' }[marketType] || marketType]; // extras giữ nguyên key
  if (!n) return [];
  if (marketType === '1x2') return [
    { oid: n.home.oid, label: t1, price: n.home.price },
    { oid: n.draw.oid, label: 'Hòa', price: n.draw.price },
    { oid: n.away.oid, label: t2, price: n.away.price }];
  if (marketType === 'ah') {
    var hl = (n.line > 0 ? '+' : '') + n.line, al = ((-n.line) > 0 ? '+' : '') + (-n.line);
    return [{ oid: n.home.oid, label: t1 + ' ' + hl, price: n.home.price },
            { oid: n.away.oid, label: t2 + ' ' + al, price: n.away.price }];
  }
  var kind = marketType === 'ou' ? 'bàn' : OU_KIND_LABEL[marketType];
  return [{ oid: n.over.oid, label: 'Tài ' + kind + ' ' + n.line, price: n.over.price },
          { oid: n.under.oid, label: 'Xỉu ' + kind + ' ' + n.line, price: n.under.price }];
}

// Hoàn điểm mọi cược CHƯA chấm của 1 kèo (poolId,fixtureId,marketType) rồi xoá cược đó.
function refundBets_(poolId, fixtureId, marketType) {
  var betSh = sheet_('Bets');
  var toRefund = readAll_('Bets').filter(function (b) { return b.poolId === poolId && b.fixtureId === fixtureId && b.marketType === marketType && !b.result; });
  toRefund.forEach(function (b) { var mem = findMembership_(poolId, b.user); if (mem) setCell_('Memberships', mem.rowIndex, 'currentPoints', Number(mem.data.currentPoints) + Number(b.stake)); });
  toRefund.sort(function (a, b) { return b.rowIndex - a.rowIndex; }).forEach(function (b) { betSh.deleteRow(b.rowIndex); });
  delete _SHEET_CACHE_['Bets'];
}

// Bust cache getMatches của mọi thành viên sảnh (kèo custom đổi -> ai cũng phải thấy ngay).
// actor: admin thao tác — thường KHÔNG phải thành viên sảnh, phải bust key của họ để thấy thay đổi ngay (không kẹt 15s cache).
function mtKeys_(poolId, actor) {
  var keys = readAll_('Memberships').filter(function (m) { return m.poolId === poolId; }).map(function (m) { return 'mt_' + poolId + '_' + m.user; });
  if (actor) keys.push('mt_' + poolId + '_' + actor);
  return keys;
}

function settleMatches() {
  var now = new Date();
  // Pre-filter rẻ: chỉ xét trận đã đá > 100' (2 hiệp chính sớm nhất mới xong ~105'), tránh gọi API cho trận vừa lăn bóng.
  var matches = readAll_('Matches').filter(function (mt) {
    return String(mt.settled).toUpperCase() !== 'Y' && new Date(mt.kickoff) < new Date(now - 100 * 60000);
  });
  matches.forEach(function (mt) {
    // CHỈ chấm khi ĐÃ HẾT 2 HIỆP CHÍNH: /scores có periods.fulltime = xong 90'+bù giờ (trận đang đá chỉ có periods.result).
    // Chấm sớm lúc trận chưa xong -> góc/thẻ SofaScore còn dở -> SAI. score đã lưu = từng thấy fulltime -> coi như xong.
    if (!mt.score) {
      var ft = null;
      try {
        var sc = apiGet_('/scores?fixtureId=' + encodeURIComponent(mt.fixtureId));
        ft = sc && sc.scores && sc.scores.periods && sc.scores.periods.fulltime;
      } catch (e) { log_('scores ' + mt.fixtureId, e); }
      if (ft && ft.participant1Score != null) setScore_(mt.rowIndex, ft.participant1Score + '-' + ft.participant2Score);
      // Chưa hết 2 hiệp chính -> chờ tick sau. An toàn: >4h vẫn chưa có fulltime (data gap) -> chấm luôn (SofaScore đã final).
      else if (new Date(mt.kickoff) >= new Date(now - 4 * 3600000)) return;
    }
    var data = apiGet_('/settlements?fixtureId=' + encodeURIComponent(mt.fixtureId));
    if (!data || !data.markets) return;
    // Kèo custom (c_*) chấm tay bởi admin -> bỏ qua ở auto-settle, không để chặn settled='Y'.
    var bets = readAll_('Bets').filter(function (b) { return b.poolId === mt.poolId && b.fixtureId === mt.fixtureId && !b.result && String(b.marketType).indexOf('c_') !== 0; });
    var anyUndecided = false;
    // OddsPapi KHÔNG chấm góc/thẻ (luôn UNDECIDED) -> kèo góc/thẻ tự chấm từ SofaScore (số góc/thẻ theo hiệp). Fetch 1 lần/trận.
    var sofa, sofaTried = false;
    bets.forEach(function (b) {
      var res;
      if (EXTRA_KEYS.indexOf(String(b.marketType)) >= 0) {
        if (!sofaTried) { sofa = sofaStats_(mt.fixtureId); sofaTried = true; }
        res = gradeExtra_(b, sofa);
      } else {
        res = lookupResult_(data.markets, b.marketId, b.outcomeId);
      }
      if (!res || res === 'UNDECIDED') { anyUndecided = true; return; }
      var stake = Number(b.stake), odds = Number(b.lockedOdds), payout = 0;
      if (res === 'WIN') payout = stake * odds;
      else if (res === 'HALFWIN') payout = stake * (1 + (odds - 1) / 2);
      else if (res === 'PUSH' || res === 'CANCELLED') payout = stake;
      else if (res === 'HALFLOSS') payout = stake / 2;
      else payout = 0;
      setCell_('Bets', b.rowIndex, 'result', res);
      setCell_('Bets', b.rowIndex, 'payout', payout);
      setCell_('Bets', b.rowIndex, 'settledAt', new Date());
      var mem = findMembership_(mt.poolId, b.user);
      if (mem) setCell_('Memberships', mem.rowIndex, 'currentPoints', Number(mem.data.currentPoints) + payout);
    });
    if (!anyUndecided) setCell_('Matches', mt.rowIndex, 'settled', 'Y');
    // Quá lâu vẫn còn kèo UNDECIDED (SofaScore gap...) -> chốt trận để rời vòng lặp (khỏi đốt quota),
    // kèo chưa chấm được nổi lên hàng đợi admin (getHistory.stuckMarkets) để chấm tay.
    else if (new Date(mt.kickoff) < new Date(now - STUCK_MANUAL_HOURS * 3600000)) setCell_('Matches', mt.rowIndex, 'settled', 'Y');
  });
}

function lookupResult_(markets, marketId, outcomeId) {
  try { return markets[String(marketId)].outcomes[String(outcomeId)].players['0'].result; } catch (e) { return null; }
}

// ====================== CHẤM GÓC/THẺ TỪ SOFASCORE (OddsPapi không chấm được) ======================
// SofaScore trả số góc/thẻ theo period ALL/1ST/2ND. Map thẳng fixture qua externalProviders.sofascoreId.
// Truy cập qua ScraperAPI (SofaScore chặn IP datacenter bằng Cloudflare). key ở prop SCRAPERAPI_KEYS (phẩy ngăn, xoay khi cạn credit).
// Kèo "fulltime" chỉ tính 2 hiệp CHÍNH -> cộng 1ST+2ND (KHÔNG dùng ALL, vì SofaScore ALL gộp cả hiệp phụ ET1/ET2).
var EXTRA_STAT = { corner_ft: [['1ST', '2ND'], 'corner'], corner_1h: [['1ST'], 'corner'], card_ft: [['1ST', '2ND'], 'card'] };

function scraperKeys_() {
  return (prop_('SCRAPERAPI_KEYS') || prop_('SCRAPERAPI_KEY') || '').split(',').map(function (s) { return s.trim(); }).filter(String);
}
// Kéo 1 URL qua ScraperAPI, xoay key khi lỗi (403 = cạn credit/sai key). Trả null nếu hỏng -> caller coi như chưa có data (UNDECIDED, thử lại sau).
function scraperGet_(targetUrl) {
  var keys = scraperKeys_();
  if (!keys.length) { log_('scraperGet', 'Chưa cấu hình SCRAPERAPI_KEYS'); return null; }
  var enc = encodeURIComponent(targetUrl), lastErr;
  for (var i = 0; i < keys.length; i++) {
    var resp = UrlFetchApp.fetch('https://api.scraperapi.com/?api_key=' + keys[i] + '&url=' + enc, { muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) { try { return JSON.parse(resp.getContentText()); } catch (e) { return null; } }
    lastErr = 'HTTP ' + resp.getResponseCode(); // đổi key
  }
  log_('scraperGet ' + targetUrl, lastErr + ' (hết key)');
  return null;
}
// sofascoreId của fixture (cache 3 tháng; 0 = đã biết không map được -> khỏi gọi lại) rồi lấy statistics.
// OddsPapi thiếu externalProviders.sofascoreId cho MỘT SỐ trận -> fallback tra SofaScore theo tên đội + giờ.
function sofaStats_(fixtureId) {
  var ck = 'sofa_id2_' + fixtureId, sid = cacheGet_(ck, 90 * 86400000); // v2: bỏ entry '0' cache lúc chưa có fallback
  if (sid == null) {
    var f;
    try { f = apiGet_('/fixture?fixtureId=' + encodeURIComponent(fixtureId)); }
    catch (e) { log_('sofa fixture ' + fixtureId, e); return null; }
    sid = (f && f.externalProviders && f.externalProviders.sofascoreId) || 0;
    if (!sid && f) sid = sofaSearch_(f.participant1Name, f.participant2Name, f.startTime) || 0;
    cachePut_(ck, sid);
  }
  if (!sid) return null;
  return scraperGet_('https://api.sofascore.com/api/v1/event/' + sid + '/statistics');
}
// Chuẩn hoá tên đội để so khớp: bỏ dấu &/and, ký tự không alnum. (Alias hiếm như Korea Republic/South Korea không khớp -> để admin chấm.)
function norm_(s) { return String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, ''); }
// Tra SofaScore eventId theo "t1 t2" (search) rồi chọn đúng trận.
function sofaSearch_(t1, t2, startTime) {
  var kick = parseApiTime_(startTime); if (!kick || !t1 || !t2) return null;
  var res = scraperGet_('https://api.sofascore.com/api/v1/search/all?q=' + encodeURIComponent(t1 + ' ' + t2) + '&page=0');
  return sofaPick_((res && res.results) || [], t1, t2, kick.getTime());
}
// Chọn từ kết quả search: type=event, khớp cặp đội (bất kể sân) + startTimestamp gần kickoff nhất trong ±12h.
// (Search trả cùng cặp đội của nhiều năm/giải -> timestamp phân biệt trận đúng.)
function sofaPick_(items, t1, t2, kickMs) {
  var want = [norm_(t1), norm_(t2)].sort().join('|');
  var best = null, bestDiff = 12 * 3600000;
  (items || []).forEach(function (r) {
    var e = r.entity;
    if (r.type !== 'event' || !e || !e.homeTeam || !e.awayTeam || !e.startTimestamp) return;
    if ([norm_(e.homeTeam.name), norm_(e.awayTeam.name)].sort().join('|') !== want) return;
    var diff = Math.abs(e.startTimestamp * 1000 - kickMs);
    if (diff < bestDiff) { bestDiff = diff; best = e.id; }
  });
  return best;
}
// Tổng (home+away) 1 loại stat qua các period cho trước. null = có period chưa về (trận chưa đủ dữ liệu) -> UNDECIDED.
// Period đã có mà thiếu dòng -> tính 0 (vd trận 0 thẻ = Xỉu thắng), không treo mãi.
function sofaSum_(json, periods, kind) {
  var total = 0;
  for (var i = 0; i < periods.length; i++) {
    var block = ((json && json.statistics) || []).filter(function (g) { return g.period === periods[i]; })[0];
    if (!block || !block.groups) return null;
    block.groups.forEach(function (g) {
      (g.statisticsItems || []).forEach(function (it) {
        var n = String(it.name || '').toLowerCase();
        var hit = kind === 'corner' ? n.indexOf('corner') >= 0 : (n.indexOf('yellow card') >= 0 || n.indexOf('red card') >= 0);
        if (hit) total += (parseInt(it.home, 10) || 0) + (parseInt(it.away, 10) || 0);
      });
    });
  }
  return total;
}
// Chấm 1 kèo góc/thẻ. Vạch góc/thẻ đều .5 (lineFilter 'half') -> không có push.
function gradeExtra_(b, statsJson) {
  var spec = EXTRA_STAT[String(b.marketType)]; if (!spec || !statsJson) return 'UNDECIDED';
  var total = sofaSum_(statsJson, spec[0], spec[1]); if (total == null) return 'UNDECIDED';
  var line = midLine_(Number(b.marketId)); if (line == null) return 'UNDECIDED';
  var isOver = String(b.outcomeId) === String(b.marketId); // ponytail: over.oid==marketId (quy ước OddsPapi, xem betLabel_)
  return (isOver ? total > line : total < line) ? 'WIN' : 'LOSE';
}

function applyNoShowPenalty() {
  var now = new Date();
  var matches = readAll_('Matches').filter(function (mt) {
    return String(mt.included).toUpperCase() === 'Y' && String(mt.penaltyApplied).toUpperCase() !== 'Y' && new Date(mt.kickoff) < now;
  });
  if (!matches.length) return;
  var allBets = readAll_('Bets');
  var allMem = readAll_('Memberships');
  var exemptions = readAll_('Exemptions');
  var penaltyByPool = {};
  readAll_('Pools').forEach(function (p) { penaltyByPool[p.poolId] = poolCfg_(p).noshowPenalty; });
  matches.forEach(function (mt) {
    var penalty = penaltyByPool[mt.poolId];
    if (penalty == null) penalty = NOSHOW_PENALTY;
    var kickoff = new Date(mt.kickoff);
    if (penalty > 0) allMem.filter(function (m) { return m.poolId === mt.poolId && !isBlocked_(m) && new Date(m.joinAt) < kickoff; }).forEach(function (m) {
      var exempt = exemptions.filter(function (e) {
        return e.poolId === mt.poolId && e.user === m.user && (String(e.fixtureId) === 'all' || String(e.fixtureId) === String(mt.fixtureId));
      }).length > 0;
      if (exempt) return;
      var betted = allBets.filter(function (b) { return b.poolId === mt.poolId && b.user === m.user && b.fixtureId === mt.fixtureId; }).length > 0;
      if (betted) return;
      var mem = findMembership_(mt.poolId, m.user);
      if (mem) setCell_('Memberships', mem.rowIndex, 'currentPoints', Number(mem.data.currentPoints) - penalty);
    });
    setCell_('Matches', mt.rowIndex, 'penaltyApplied', 'Y');
  });
}

// ====================== ADMIN: IMPORT TRẬN ======================
function dailyImport() {
  // Chỉ auto-import cho sảnh ĐANG MỞ. Draft import thủ công qua nút "Import trận" -> draft bị quên không đốt quota.
  readAll_('Pools').forEach(function (p) {
    if (p.status === 'open') {
      try { importPoolFixtures(p.poolId); } catch (e) { log_('import ' + p.poolId, e); }
    }
  });
}

function importPoolFixtures(poolId) {
  var p = findRow_('Pools', 'poolId', poolId);
  if (!p) throw new Error('Pool không tồn tại: ' + poolId);
  var tids = String(p.data.tournamentIds).split(',').map(function (s) { return s.trim(); }).filter(String);
  // Lấy từ hiện tại đến chân trời rộng để bắt trọn giải (kể cả vòng knockout công bố muộn). dateTo = trận cuối, tự tính bên dưới.
  var from = new Date().toISOString();
  var toD = new Date(); toD.setMonth(toD.getMonth() + 18); var to = toD.toISOString();
  var maxKick = null;

  var existing = {};
  readAll_('Matches').forEach(function (mt) { if (mt.poolId === poolId) existing[mt.fixtureId] = mt; });

  tids.forEach(function (tid) {
    var data = apiGet_('/fixtures?tournamentId=' + tid + '&from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to));
    if (!Array.isArray(data)) return;
    data.forEach(function (f) {
      if (f.sportId !== SPORT_ID_SOCCER) return;
      var kickoff = parseApiTime_(f.startTime);
      if (kickoff && (!maxKick || kickoff > maxKick)) maxKick = kickoff;
      var cur = existing[f.fixtureId];
      if (cur) {
        // Trận đã có: cập nhật tên đội + giờ (vòng knockout xác định đội muộn). Bỏ qua nếu đã settle.
        if (cur.rowIndex > 0 && String(cur.settled).toUpperCase() !== 'Y') {
          if (cur.team1 !== f.participant1Name) setCell_('Matches', cur.rowIndex, 'team1', f.participant1Name);
          if (cur.team2 !== f.participant2Name) setCell_('Matches', cur.rowIndex, 'team2', f.participant2Name);
          if (kickoff && new Date(cur.kickoff).getTime() !== kickoff.getTime()) setCell_('Matches', cur.rowIndex, 'kickoff', kickoff);
        }
        return;
      }
      // ouLine & ouMarketId để TRỐNG -> tự lấy vạch chính nhà cái từ API mỗi lần fetch odds.
      appendRow_('Matches', [poolId, f.fixtureId, f.tournamentId, f.participant1Name, f.participant2Name, kickoff, f.statusId, '', '', 'Y', '', '', '']);
      existing[f.fixtureId] = { rowIndex: -1 };
    });
  });
  if (maxKick) setCell_('Pools', p.rowIndex, 'dateTo', maxKick); // "đến ngày" = kickoff trận cuối
  return maxKick;
}

// ====================== ADMIN DASHBOARD API (gọi từ client, cần quyền admin) ======================
function adminListPools(token) {
  requireAdmin_(token);
  var mems = readAll_('Memberships');
  var matches = readAll_('Matches');
  return readAll_('Pools').map(function (p) {
    var cfg = poolCfg_(p);
    return {
      poolId: p.poolId, name: p.name, tournamentIds: p.tournamentIds,
      dateFrom: fmtDate_(p.dateFrom), dateTo: fmtDate_(p.dateTo),
      status: p.status, bookmaker: p.bookmaker || DEFAULT_BOOKMAKER,
      maxStake: cfg.maxStake, pointsPerMatch: cfg.pointsPerMatch, startMultiplier: cfg.startMultiplier, noshowPenalty: cfg.noshowPenalty,
      requirePassword: poolLocked_(p), joinPassword: String(p.joinPassword || ''), // admin-only -> được phép trả mật khẩu để prefill form
      extraMarkets: poolExtraObj_(p), // {corner_ft:{enabled},...} cho toggle ở form
      members: mems.filter(function (m) { return m.poolId === p.poolId; }).length,
      matchCount: matches.filter(function (m) { return m.poolId === p.poolId; }).length
    };
  });
}

// ---- Cache sheet (key, value, updatedAt) ----
function cacheGet_(key, maxAgeMs) {
  var r = readAll_('Cache').filter(function (c) { return c.key === key; })[0];
  if (!r || !r.value) return null;
  if (maxAgeMs && (Date.now() - new Date(r.updatedAt).getTime()) > maxAgeMs) return null;
  try { return JSON.parse(r.value); } catch (e) { return null; }
}
function cachePut_(key, obj) {
  var r = findRow_('Cache', 'key', key);
  var json = JSON.stringify(obj);
  if (r) { setCell_('Cache', r.rowIndex, 'value', json); setCell_('Cache', r.rowIndex, 'updatedAt', new Date()); }
  else appendRow_('Cache', [key, json, new Date()]);
}

// Danh sách giải lớn (allowlist) đang có trận sắp/đang diễn ra. Cache 3 tháng -> tránh kéo 1700+ giải mỗi lần.
// ponytail: trạng thái "có trận" đóng băng theo cache; admin bấm refresh (force=true) khi vào mùa giải mới.
function adminTournaments(token, force) {
  requireAdmin_(token);
  if (!force) { var c = cacheGet_(TOURNAMENTS_CACHE_KEY, TOURNAMENTS_CACHE_MS); if (c) return c; }
  var data = apiGet_('/tournaments?sportId=' + SPORT_ID_SOCCER);
  var allow = {}; MAJOR_TOURNAMENT_IDS.forEach(function (id) { allow[id] = 1; });
  var list = (Array.isArray(data) ? data : [])
    .filter(function (t) { return allow[t.tournamentId] && (t.futureFixtures + t.upcomingFixtures + t.liveFixtures) > 0; })
    .map(function (t) { return { id: t.tournamentId, name: t.tournamentName, category: t.categoryName, fixtures: t.futureFixtures + t.upcomingFixtures + t.liveFixtures }; })
    .sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  cachePut_(TOURNAMENTS_CACHE_KEY, list);
  return list;
}

function adminCreatePool(token, obj) {
  requireAdmin_(token);
  obj = obj || {};
  var name = (obj.name || '').toString().trim();
  if (!name) throw new Error('Cần tên pool');
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var poolId = 'p_' + Utilities.getUuid().slice(0, 8);
    appendRow_('Pools', [
      poolId, name,
      (obj.tournamentIds || '').toString().trim(),
      (obj.dateFrom || '').toString().trim(),
      (obj.dateTo || '').toString().trim(),
      'draft',
      (obj.bookmaker || DEFAULT_BOOKMAKER),
      numOr_(obj.pointsPerMatch, POINTS_PER_MATCH),
      numOr_(obj.startMultiplier, START_MULTIPLIER),
      numOr_(obj.noshowPenalty, NOSHOW_PENALTY)
    ]);
    return { poolId: poolId };
  } finally { lock.releaseLock(); }
}

// ponytail: ghi từng ô trên field whitelist — không nhận key tuỳ ý từ client.
function adminUpdatePool(token, poolId, obj) {
  requireAdmin_(token);
  var r = findRow_('Pools', 'poolId', poolId);
  if (!r) throw new Error('Pool không tồn tại');
  obj = obj || {};
  var fields = { name: 'str', tournamentIds: 'str', dateFrom: 'str', dateTo: 'str', bookmaker: 'str',
                 pointsPerMatch: 'num', startMultiplier: 'num', noshowPenalty: 'num0' };
  Object.keys(fields).forEach(function (k) {
    if (!(k in obj)) return;
    var v = obj[k];
    if (fields[k] === 'num') { v = Number(v); if (!(isFinite(v) && v > 0)) throw new Error(k + ' phải là số > 0'); }
    else if (fields[k] === 'num0') { v = Number(v); if (!(isFinite(v) && v >= 0)) throw new Error(k + ' phải là số ≥ 0'); }
    else if (fields[k] === 'str') { v = (v || '').toString().trim(); }
    setCell_('Pools', r.rowIndex, k, v);
  });
  // Mật khẩu sảnh (plaintext, sheet riêng tư). joinPassword KHÔNG trim — cho phép khoảng trắng có chủ đích.
  if ('requirePassword' in obj) setCell_('Pools', r.rowIndex, 'requirePassword', obj.requirePassword ? 'Y' : '');
  if ('joinPassword' in obj) setCell_('Pools', r.rowIndex, 'joinPassword', String(obj.joinPassword == null ? '' : obj.joinPassword));
  if ('extraMarkets' in obj) {
    var em = {}; EXTRA_KEYS.forEach(function (k) { em[k] = { enabled: !!(obj.extraMarkets && obj.extraMarkets[k] && obj.extraMarkets[k].enabled) }; });
    setCell_('Pools', r.rowIndex, 'extraMarkets', JSON.stringify(em));
  }
  return { ok: true };
}

// ====================== ADMIN: THÀNH VIÊN (chặn / bỏ chặn) ======================
function adminListMembers(token, poolId) {
  requireAdmin_(token);
  return readAll_('Memberships').filter(function (m) { return m.poolId === poolId; })
    .map(function (m) {
      return { userId: m.user, nickname: nicknameOf_(m.user), points: Number(m.currentPoints), blocked: isBlocked_(m) };
    })
    .sort(function (a, b) { return b.points - a.points; });
}

function adminBlockMember(token, poolId, userId, block) {
  requireAdmin_(token);
  var mem = findMembership_(poolId, userId);
  if (!mem) throw new Error('Không tìm thấy thành viên');
  setCell_('Memberships', mem.rowIndex, 'blocked', block ? 'Y' : '');
  cacheBust_(['lb_' + poolId, 'mt_' + poolId + '_' + userId]); // ẩn/hiện khỏi BXH + mở/đóng tường getMatches ngay
  return { ok: true, blocked: !!block };
}

// Reset sảnh về điểm khởi đầu (theo SỐ TRẬN CÒN LẠI tại thời điểm reset) + xoá sạch kèo của sảnh.
// Giữ thành viên (kể cả người đang bị chặn) và mọi dữ liệu trận (score/settled/penaltyApplied). Không hoàn tác được.
function adminResetPool(token, poolId) {
  requireAdmin_(token);
  var pool = findRow_('Pools', 'poolId', poolId);
  if (!pool) throw new Error('Pool không tồn tại');
  var cfg = poolCfg_(pool.data);
  var now = new Date();
  var remaining = readAll_('Matches').filter(function (mt) {
    return mt.poolId === poolId && String(mt.included).toUpperCase() === 'Y' && new Date(mt.kickoff) > now;
  }).length;
  var newStart = Math.round(remaining * cfg.pointsPerMatch * cfg.startMultiplier);
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    // Xoá kèo của sảnh: xoá từ dưới lên để rowIndex không lệch.
    var betSh = sheet_('Bets');
    readAll_('Bets').filter(function (b) { return b.poolId === poolId; })
      .sort(function (a, b) { return b.rowIndex - a.rowIndex; })
      .forEach(function (b) { betSh.deleteRow(b.rowIndex); });
    delete _SHEET_CACHE_['Bets'];
    // Cấp lại điểm khởi đầu cho mọi thành viên.
    var n = 0;
    readAll_('Memberships').filter(function (m) { return m.poolId === poolId; }).forEach(function (m) {
      setCell_('Memberships', m.rowIndex, 'startingPoints', newStart);
      setCell_('Memberships', m.rowIndex, 'currentPoints', newStart);
      n++;
    });
    // Mốc reset: lịch sử/phạt no-show bỏ qua trận trước mốc này (thuộc mùa cũ).
    PropertiesService.getScriptProperties().setProperty('resetAt_' + poolId, now.toISOString());
    cacheBust_(['lb_' + poolId]);
    return { ok: true, updated: n, startingPoints: newStart, matchCount: remaining };
  } finally { lock.releaseLock(); }
}

// Xoá hẳn sảnh: pool + mọi dữ liệu phụ thuộc (Matches, Odds, Bets, Memberships, Exemptions). Không hoàn tác được.
function adminDeletePool(token, poolId) {
  requireAdmin_(token);
  if (!findRow_('Pools', 'poolId', poolId)) throw new Error('Pool không tồn tại');
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    // Odds dùng chung (key bookmaker,fixture) -> KHÔNG xoá theo pool; purgeClosedPoolOdds dọn phần mồ côi.
    ['Bets', 'Memberships', 'Exemptions', 'Matches', 'Pools'].forEach(function (name) {
      var sh = sheet_(name);
      readAll_(name).filter(function (r) { return r.poolId === poolId; })
        .sort(function (a, b) { return b.rowIndex - a.rowIndex; }) // xoá từ dưới lên để rowIndex không lệch
        .forEach(function (r) { sh.deleteRow(r.rowIndex); });
      delete _SHEET_CACHE_[name];
    });
    cacheBust_(['lb_' + poolId]);
    return { ok: true };
  } finally { lock.releaseLock(); }
}

function adminSetStatus(token, poolId, status) {
  requireAdmin_(token);
  if (['draft', 'open', 'closed'].indexOf(status) < 0) throw new Error('Status không hợp lệ');
  var r = findRow_('Pools', 'poolId', poolId);
  if (!r) throw new Error('Pool không tồn tại');
  setCell_('Pools', r.rowIndex, 'status', status);
  return { ok: true };
}

// Admin bấm reload odds ngay (bỏ qua throttle). Dùng để rebuild odds (vd thêm kèo mới) không phải chờ tick.
function adminRefreshOdds(token) {
  requireAdmin_(token);
  refreshOdds(true);
  return { ok: true };
}

function adminImport(token, poolId) {
  requireAdmin_(token);
  var before = readAll_('Matches').filter(function (m) { return m.poolId === poolId; }).length;
  var maxKick = importPoolFixtures(poolId);
  var after = readAll_('Matches').filter(function (m) { return m.poolId === poolId; }).length;
  return { added: after - before, total: after, dateTo: fmtDate_(maxKick) };
}

function adminListMatches(token, poolId) {
  requireAdmin_(token);
  return readAll_('Matches').filter(function (m) { return m.poolId === poolId; }).map(function (m) {
    return {
      fixtureId: m.fixtureId, team1: m.team1, team2: m.team2, kickoff: fmtDateTime_(m.kickoff),
      included: String(m.included).toUpperCase() === 'Y', settled: String(m.settled).toUpperCase() === 'Y'
    };
  }).sort(function (a, b) { return new Date(a.kickoff) - new Date(b.kickoff); });
}

function adminToggleMatch(token, poolId, fixtureId, included) {
  requireAdmin_(token);
  var r = readAll_('Matches').filter(function (m) { return m.poolId === poolId && String(m.fixtureId) === String(fixtureId); })[0];
  if (!r) throw new Error('Không tìm thấy trận');
  setCell_('Matches', r.rowIndex, 'included', included ? 'Y' : 'N');
  return { ok: true };
}

function fmtDate_(v) { return (v instanceof Date) ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : (v || ''); }
// Parse startTime từ API thành instant đúng: hỗ trợ epoch giây/ms và ISO 8601 (kèm Z/offset).
function parseApiTime_(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) { var n = Number(v); return new Date(n < 1e12 ? n * 1000 : n); }
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function fmtDateTime_(v) { try { return new Date(v).toISOString(); } catch (e) { return ''; } }

/** Self-check pure logic. Chạy tay trong editor; throw nếu sai. */
function _selfCheck() {
  function eq(a, b, m) { if (a !== b) throw new Error('FAIL ' + m + ': ' + a + ' !== ' + b); }
  eq(numOr_('', 7), 7, 'numOr blank');
  eq(numOr_('0', 7), 7, 'numOr zero');
  eq(numOr_('5', 7), 5, 'numOr valid');
  var c = poolCfg_({ pointsPerMatch: '500', startMultiplier: '' });
  eq(c.pointsPerMatch, 500, 'ppm');
  eq(c.startMultiplier, START_MULTIPLIER, 'mult fallback');
  eq(c.minStake, 250, 'min derive');
  eq(c.maxStake, 1000, 'max derive');
  eq(c.noshowPenalty, 250, 'penalty derive');
  eq(poolCfg_({}).maxStake, POINTS_PER_MATCH * 2, 'default max');
  eq(parseApiTime_(1782000000).getTime(), parseApiTime_(1782000000000).getTime(), 'epoch s==ms');
  eq(parseApiTime_('2026-06-26T12:00:00Z').getTime(), Date.parse('2026-06-26T12:00:00Z'), 'iso parse');
  eq(parseApiTime_(''), null, 'empty time');
  // pool khoá = cờ bật VÀ có mật khẩu (bật cờ nhưng để trống pass -> coi như không khoá)
  eq(poolLocked_({ requirePassword: 'Y', joinPassword: '1234' }), true, 'locked yes');
  eq(poolLocked_({ requirePassword: 'Y', joinPassword: '' }), false, 'locked empty pass');
  eq(poolLocked_({ requirePassword: '', joinPassword: '1234' }), false, 'locked flag off');
  eq(isBlocked_({ blocked: 'Y' }), true, 'blocked yes');
  eq(isBlocked_({ blocked: '' }), false, 'blocked no');
  // Bộ lọc vạch
  eq(isHalfLine_(2.5), true, 'half 2.5'); eq(isHalfLine_(2), false, 'half 2'); eq(isHalfLine_(0.5), true, 'half .5');
  eq(isAhLine_(0), true, 'ah 0'); eq(isAhLine_(-0.5), true, 'ah -.5'); eq(isAhLine_(-0.25), false, 'ah -.25'); eq(isAhLine_(0.75), false, 'ah .75');
  eq(poolExtra_({ extraMarkets: '{"corner_ft":{"enabled":true},"card_ft":{"enabled":false}}' }).corner_ft, true, 'extra on');
  eq(!!poolExtra_({ extraMarkets: '{"card_ft":{"enabled":false}}' }).card_ft, false, 'extra off');
  eq(!!poolExtra_({}).corner_ft, false, 'extra none');
  // buildOdds_ generic: 1x2 + tài/xỉu bàn (chọn vạch cân nhất) + góc; catalog giả lập.
  var cat = { '1x2|fulltime': [{ mid: 101, hcap: 0, oids: [101, 102, 103] }],
    'totals|fulltime': [{ mid: 1010, hcap: 2.5, oids: [1010, 1011] }, { mid: 1012, hcap: 3.5, oids: [1012, 1013] }],
    'totals-corners|fulltime': [{ mid: 10767, hcap: 9.5, oids: [10767, 10768] }],
    // 2 vạch AH .0/.5: 1068 gần 2.0 hơn nhưng lệch (gap .11); 1072 cân nhất (gap 0) -> phải chọn 1072.
    'spreads|fulltime': [{ mid: 1068, hcap: -0.5, oids: [1068, 1069] }, { mid: 1072, hcap: 0, oids: [1072, 1073] }] };
  function leaf(p) { return { players: { '0': { price: p } } }; }
  var mk = { '101': { outcomes: { '101': leaf(2), '102': leaf(3), '103': leaf(4) } },
    '1010': { outcomes: { '1010': leaf(1.9), '1011': leaf(1.9) } },   // cân -> nên chọn vạch này
    '1012': { outcomes: { '1012': leaf(1.4), '1013': leaf(2.9) } },
    '10767': { outcomes: { '10767': leaf(1.85), '10768': leaf(1.95) } },
    '1068': { outcomes: { '1068': leaf(1.85), '1069': leaf(1.96) } },  // gần 2.0 hơn nhưng gap .11
    '1072': { outcomes: { '1072': leaf(1.90), '1073': leaf(1.90) } } };  // gap 0 -> cân nhất
  var bo = buildOdds_(mk, cat, {});
  eq(bo.m1x2.home.price, 2, 'bo 1x2 home'); eq(bo.mou.line, 2.5, 'bo mou pick balanced'); eq(bo.mou.under.oid, 1011, 'bo mou under oid');
  eq(bo.corner_ft.line, 9.5, 'bo corner line'); eq(bo.corner_ft.over.oid, 10767, 'bo corner over oid');
  eq(bo.mah.line, 0, 'bo mah pick most-balanced (gap, không phải gần-2.0)'); eq(bo.mah.away.oid, 1073, 'bo mah away oid');
  // Chấm góc/thẻ từ SofaScore. Trận có hiệp phụ: fulltime = 1ST+2ND, KHÔNG gồm ET (kiểm ALL bị gộp ET).
  var sj = { statistics: [
    { period: 'ALL', groups: [{ statisticsItems: [{ name: 'Corner kicks', home: '4', away: '2' }, { name: 'Yellow cards', home: '1', away: '1' }] }] },
    { period: '1ST', groups: [{ statisticsItems: [{ name: 'Corner kicks', home: '2', away: '1' }, { name: 'Yellow cards', home: '1', away: '0' }] }] },
    { period: '2ND', groups: [{ statisticsItems: [{ name: 'Corner kicks', home: '2', away: '0' }] }] },
    { period: 'ET1', groups: [{ statisticsItems: [{ name: 'Corner kicks', home: '0', away: '0' }] }] },
    { period: 'ET2', groups: [{ statisticsItems: [{ name: 'Corner kicks', home: '0', away: '1' }] }] }] };
  eq(sofaSum_(sj, ['1ST', '2ND'], 'corner'), 5, 'góc fulltime = 1ST+2ND = 5 (KHÔNG gồm ET)');
  eq(sofaSum_(sj, ['ALL'], 'corner'), 6, 'ALL = 6 (gồm ET) — minh hoạ vì sao không dùng ALL');
  eq(sofaSum_(sj, ['1ST'], 'corner'), 3, 'góc H1 = 3');
  eq(sofaSum_(sj, ['1ST', '2ND'], 'card'), 1, 'thẻ fulltime = 1 (2ND không có dòng thẻ -> 0)');
  eq(sofaSum_(sj, ['1ST', '2ND', 'OT'], 'corner'), null, 'thiếu period -> null');
  _MID_LINE_ = { '10767': 5.5, '101535': 2.5, '555': 3.5 }; // giả lập vạch (thật build từ /markets)
  eq(gradeExtra_({ marketType: 'corner_ft', marketId: 10767, outcomeId: 10767 }, sj), 'LOSE', 'corner_ft Tài 5.5: 5<5.5 -> thua (đúng; nếu tính ALL=6 sẽ SAI thành thắng)');
  eq(gradeExtra_({ marketType: 'corner_ft', marketId: 10767, outcomeId: 10768 }, sj), 'WIN', 'corner_ft Xỉu 5.5 thắng');
  eq(gradeExtra_({ marketType: 'corner_1h', marketId: 101535, outcomeId: 101535 }, sj), 'WIN', 'corner_1h Tài 2.5: 3>2.5 thắng');
  eq(gradeExtra_({ marketType: 'card_ft', marketId: 555, outcomeId: 556 }, sj), 'WIN', 'card_ft Xỉu 3.5: 1<3.5 thắng');
  eq(gradeExtra_({ marketType: 'corner_ft', marketId: 10767, outcomeId: 10767 }, null), 'UNDECIDED', 'chưa có stats -> UNDECIDED');
  _MID_LINE_ = null;
  // norm_ + sofaPick_ (fallback tra SofaScore khi thiếu sofascoreId)
  eq(norm_('Bosnia & Herzegovina'), norm_('Bosnia and Herzegovina'), 'norm & == and');
  var kick = Date.parse('2026-07-02T19:00:00Z');
  var sres = [
    { type: 'team', entity: { id: 1, name: 'Spain' } },
    { type: 'event', entity: { id: 8537058, homeTeam: { name: 'Spain' }, awayTeam: { name: 'Austria' }, startTimestamp: Date.parse('2020-01-18T17:15:00Z') / 1000 } },
    { type: 'event', entity: { id: 12813004, homeTeam: { name: 'Spain' }, awayTeam: { name: 'Austria' }, startTimestamp: kick / 1000 } },
    { type: 'event', entity: { id: 99, homeTeam: { name: 'Spain' }, awayTeam: { name: 'Italy' }, startTimestamp: kick / 1000 } }];
  eq(sofaPick_(sres, 'Spain', 'Austria', kick), 12813004, 'pick đúng trận theo timestamp');
  eq(sofaPick_(sres, 'Austria', 'Spain', kick), 12813004, 'khớp cặp đội bất kể sân');
  eq(sofaPick_(sres, 'Spain', 'Austria', Date.parse('2030-01-01T00:00:00Z')), null, 'không có trận gần kickoff -> null');
  Logger.log('selfCheck OK');
  return 'OK';
}

// ====================== ODDSPAPI CLIENT (xoay key) ======================
// Ưu tiên ODDSPAPI_KEYS (phẩy ngăn cách, 2-4 key); fallback 2 prop cũ.
function apiKeys_() {
  var multi = (prop_('ODDSPAPI_KEYS') || '').split(',').map(function (s) { return s.trim(); }).filter(String);
  if (multi.length) return multi;
  return [prop_('ODDSPAPI_KEY'), prop_('ODDSPAPI_KEY_BACKUP')].filter(String);
}

function apiGet_(path) {
  var keys = apiKeys_();
  if (!keys.length) throw new Error('Chưa cấu hình OddsPapi key (ODDSPAPI_KEYS hoặc ODDSPAPI_KEY)');
  var lastErr;
  for (var i = 0; i < keys.length; i++) {
    var sep = path.indexOf('?') >= 0 ? '&' : '?';
    var url = API_BASE + path + sep + 'apiKey=' + keys[i];
    for (var attempt = 0; attempt < 3; attempt++) {
      var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      var code = resp.getResponseCode();
      if (code === 200) return JSON.parse(resp.getContentText());
      var body = resp.getContentText();
      // 429/503: rate-limit tạm thời -> chờ Retry-After rồi thử lại CÙNG key; cạn lượt mới sang key sau.
      if (code === 429 || code === 503) {
        var h = resp.getAllHeaders();
        var wait = Number(h['Retry-After'] || h['retry-after'] || 1);
        if (attempt < 2 && wait <= 10) { Utilities.sleep(Math.ceil((wait + 0.3) * 1000)); continue; }
        lastErr = 'HTTP ' + code + ' (rate-limited)';
        break;
      }
      // 401/403: key hỏng/không quyền -> chờ vô ích, sang key sau.
      if (code === 401 || code === 403) { lastErr = 'HTTP ' + code + ': ' + body.slice(0, 120); break; }
      // 400/422/...: lỗi request, đổi key vô nghĩa -> throw ngay.
      throw new Error('OddsPapi ' + path + ' -> HTTP ' + code + ': ' + body.slice(0, 200));
    }
  }
  throw new Error('OddsPapi ' + path + ' -> hết key khả dụng (' + lastErr + ')');
}

// ====================== SHEET HELPERS ======================
function sheet_(name) { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name); }
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }

// Memo trong 1 request (web app = 1 execution, globals reset giữa các request).
// Gộp các lần đọc lặp cùng 1 sheet thành 1 round-trip. Writes phải invalidate (xem appendRow_/setCell_).
var _SHEET_CACHE_ = {};
function readAll_(name) {
  if (_SHEET_CACHE_[name]) return _SHEET_CACHE_[name];
  var sh = sheet_(name);
  var values = sh.getDataRange().getValues();
  var headers = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var obj = { rowIndex: i + 1 };
    for (var j = 0; j < headers.length; j++) obj[headers[j]] = values[i][j];
    rows.push(obj);
  }
  _SHEET_CACHE_[name] = rows;
  return rows;
}
function appendRow_(name, row) { sheet_(name).appendRow(row); delete _SHEET_CACHE_[name]; }

// CacheService = in-memory, dùng chung mọi user, ~5ms. Gộp các round-trip sheet giống nhau giữa các request.
// ponytail: TTL ngắn là backstop tự lành nếu lỡ quên bust; chỉ bust tay nơi user cần thấy hành động của mình ngay.
//           Giá trị >100KB thì put() lặng lẽ trượt -> miss cache, vẫn đúng. Nâng cấp: nén/đọc theo pool khi pool to.
function cached_(key, ttlSec, fn) {
  var c = CacheService.getScriptCache(), hit = c.get(key);
  if (hit != null) return JSON.parse(hit);
  var val = fn();
  c.put(key, JSON.stringify(val), ttlSec);
  return val;
}
function cacheBust_(keys) { CacheService.getScriptCache().removeAll(keys); }

function findRow_(name, col, val) {
  var rows = readAll_(name);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][col]) === String(val)) return { rowIndex: rows[i].rowIndex, data: rows[i] };
  }
  return null;
}

function setCell_(name, rowIndex, col, val) {
  var sh = sheet_(name);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var c = headers.indexOf(col) + 1;
  if (c > 0) sh.getRange(rowIndex, c).setValue(val);
  delete _SHEET_CACHE_[name]; // invalidate memo sau khi ghi
}

// Score "1-4" bị Sheets ép thành ngày (tháng 1 ngày 4) -> ghi dạng TEXT để giữ nguyên chuỗi.
function setScore_(rowIndex, val) {
  var sh = sheet_('Matches');
  var c = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].indexOf('score') + 1;
  if (c > 0) { var cell = sh.getRange(rowIndex, c); cell.setNumberFormat('@'); cell.setValue(val); delete _SHEET_CACHE_['Matches']; }
}
// Đọc score: ô đã lỡ thành Date (locale month-day) -> khôi phục "p1-p2"; còn lại giữ nguyên.
function scoreStr_(v) {
  if (v instanceof Date) return (v.getMonth() + 1) + '-' + v.getDate();
  return String(v || '');
}

// Kết quả kèo (API trả tiếng Anh) -> hiển thị tiếng Việt.
function resultVi_(r) { return { WIN: 'Thắng', LOSE: 'Thua', PUSH: 'Hòa kèo', HALFWIN: 'Thắng nửa', HALFLOSS: 'Thua nửa', CANCELLED: 'Hủy kèo' }[r] || String(r || ''); }

function upsertOdds_(bookmaker, fixtureId, json) {
  var r = readAll_('Odds').filter(function (o) { return o.bookmaker === bookmaker && o.fixtureId === fixtureId; })[0];
  if (r) {
    if (json !== r.oddsJson) { // chỉ lưu mốc cũ khi odds thật sự đổi -> mũi tên = lần dịch gần nhất, ổn định qua reload
      setCell_('Odds', r.rowIndex, 'prevOddsJson', r.oddsJson || '');
      setCell_('Odds', r.rowIndex, 'oddsJson', json);
      setCell_('Odds', r.rowIndex, 'updatedAt', new Date());
    }
    setCell_('Odds', r.rowIndex, 'lastFetchAt', new Date()); // luôn đánh dấu đã fetch (kể cả odds không đổi) -> throttle đúng
  } else { appendRow_('Odds', [bookmaker, fixtureId, json, new Date(), '', new Date()]); }
}
// {mtype_oid: price} từ oddsJson; chỉ các cửa hiện có.
function oddsFlat_(json) {
  var f = {}; if (!json) return f;
  try {
    var o = JSON.parse(json);
    if (o.m1x2) ['home', 'draw', 'away'].forEach(function (k) { var x = o.m1x2[k]; if (x) f['1x2_' + x.oid] = x.price; });
    if (o.mou) ['over', 'under'].forEach(function (k) { var x = o.mou[k]; if (x) f['ou_' + x.oid] = x.price; });
    if (o.mah) ['home', 'away'].forEach(function (k) { var x = o.mah[k]; if (x) f['ah_' + x.oid] = x.price; });
  } catch (e) { }
  return f;
}
// So odds hiện tại với mốc trước -> {mtype_oid: 1 (tăng) | -1 (giảm)}.
function oddsMoves_(curJson, prevJson) {
  var c = oddsFlat_(curJson), p = oddsFlat_(prevJson), m = {};
  Object.keys(c).forEach(function (k) { if (p[k] != null && c[k] !== p[k]) m[k] = (c[k] > p[k]) ? 1 : -1; });
  return m;
}

function isBlocked_(m) { return String(m.blocked).toUpperCase() === 'Y'; }

function findMembership_(poolId, user) {
  var rows = readAll_('Memberships');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].poolId === poolId && rows[i].user === user) return { rowIndex: rows[i].rowIndex, data: rows[i] };
  }
  return null;
}

function log_(ctx, e) { console.error(ctx + ': ' + (e && e.message ? e.message : e)); }

// ====================== MIGRATION: XUẤT TOÀN BỘ SHEET -> D1 (chạy tay 1 lần) ======================
/**
 * Xuất FULL mọi sheet ra JSON (KHÔNG ẩn passHash/salt/token — cần để migrate user không phải reset mật khẩu).
 * Chạy trong editor: tạo file 'prophet-export.json' trên Drive của bạn. Tải về -> node cf/migrate.mjs.
 * NHẠY CẢM: file chứa hash mật khẩu + token. Xoá khỏi Drive sau khi migrate xong.
 */
function exportForMigration() {
  var out = {};
  Object.keys(SHEETS).forEach(function (name) {
    var sh = sheet_(name); if (!sh) { out[name] = []; return; }
    var values = sh.getDataRange().getValues();
    var headers = values[0] || [];
    var rows = [];
    for (var i = 1; i < values.length; i++) {
      var o = {}; headers.forEach(function (h, j) { o[h] = values[i][j]; }); rows.push(o);
    }
    out[name] = rows;
  });
  var json = JSON.stringify(out);
  DriveApp.createFile('prophet-export.json', json, 'application/json');
  return 'Đã tạo prophet-export.json (' + json.length + ' bytes) trên Drive. Tải về rồi chạy cf/migrate.mjs.';
}

// ====================== ADMIN HELPERS (chạy tay trong editor) ======================
/**
 * Xuất trạng thái các sheet ra log để gửi cho Claude debug.
 * Chạy hàm này rồi mở Executions (hoặc View > Logs), copy toàn bộ JSON dán lại cho mình.
 * Lưu ý: ẨN cột nhạy cảm (passHash, salt, token) trong sheet Users.
 */
function debugDump() {
  var hide = { passHash: 1, salt: 1, token: 1 };
  var dump = {};
  Object.keys(SHEETS).forEach(function (name) {
    var sh = sheet_(name);
    if (!sh) { dump[name] = 'MISSING'; return; }
    var values = sh.getDataRange().getValues();
    var headers = values[0] || [];
    var sample = [];
    for (var i = 1; i < Math.min(values.length, 6); i++) {
      var row = {};
      headers.forEach(function (h, j) { row[h] = hide[h] ? '***' : values[i][j]; });
      sample.push(row);
    }
    dump[name] = { headers: headers, rowCount: Math.max(0, values.length - 1), sample: sample };
  });
  var json = JSON.stringify(dump, null, 2);
  Logger.log(json);
  return json;
}
