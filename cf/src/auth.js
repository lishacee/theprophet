// Auth — port of Code.js register/login/resume/setNickname + auth_/isAdmin_/hashPass_.
// Passwords: PBKDF2-SHA256 (Web Crypto). Legacy GAS/CF rows are single-round SHA-256+base64;
// verifyPass() falls back to that format and login() transparently re-hashes them to PBKDF2 on
// the next successful sign-in (no reset needed). LockService duplicate-guard ->
// the UNIQUE(userLower) DB constraint (a DB constraint beats an app lock).
import { findRow, insertRow, updateRow } from './db.js';

const TOKEN_TTL_DAYS = 30;
// ponytail: 100k iters keeps login CPU comfortably under the Workers budget; raise toward
//   OWASP's 600k (PBKDF2-SHA256) if the plan's CPU limit allows — new hashes carry their own
//   iteration count, so bumping this doesn't invalidate anything already stored.
const PBKDF2_ITERS = 100000;

export function uuid(){ return crypto.randomUUID(); }

function b64(buf){ let bin = ''; new Uint8Array(buf).forEach(b => bin += String.fromCharCode(b)); return btoa(bin); }

// Legacy format — single-round SHA-256+base64 (GAS Utilities.computeDigest equivalent).
async function sha256Hash(password, salt){
  return b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password + '|' + salt)));
}

// Canonical format used for all new/changed passwords: "pbkdf2$<iters>$<b64>".
async function hashPass(password, salt){
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name:'PBKDF2', salt: new TextEncoder().encode(salt), iterations: PBKDF2_ITERS, hash:'SHA-256' }, key, 256);
  return 'pbkdf2$' + PBKDF2_ITERS + '$' + b64(bits);
}

// Verify against either format. needsRehash flags a legacy hash so login can upgrade it.
async function verifyPass(password, salt, stored){
  if (String(stored).startsWith('pbkdf2$')){
    const iters = Number(stored.split('$')[1]) || PBKDF2_ITERS;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name:'PBKDF2', salt: new TextEncoder().encode(salt), iterations: iters, hash:'SHA-256' }, key, 256);
    return { ok: 'pbkdf2$' + iters + '$' + b64(bits) === stored, needsRehash: false };
  }
  return { ok: (await sha256Hash(password, salt)) === stored, needsRehash: true };
}

export async function isAdmin(env, username){
  return String(env.ADMINS || '').toLowerCase().split(',').map(x=>x.trim())
    .indexOf(String(username).toLowerCase()) >= 0;
}

// Returns username or throws — mirrors auth_(token).
export async function authUser(env, token){
  if (!token) throw new Error('Chưa đăng nhập');
  const r = await findRow(env, 'Users', 'token', token);
  if (!r) throw new Error('Phiên hết hạn, đăng nhập lại');
  if (Number(r.tokenExp) < Date.now()) throw new Error('Phiên hết hạn, đăng nhập lại');
  return r.username;
}
export async function requireAdmin(env, token){
  const u = await authUser(env, token);
  if (!(await isAdmin(env, u))) throw new Error('Không có quyền admin');
  return u;
}

export async function register(env, username, password, nickname){
  username = (username || '').toString().trim();
  password = (password || '').toString();
  nickname = (nickname || '').toString().trim() || username;
  if (!/^[A-Za-z0-9._-]{3,20}$/.test(username)) throw new Error('Username 3–20 ký tự (chữ/số/._-)');
  if (password.length < 4 || password.length > 64) throw new Error('Mật khẩu 4–64 ký tự');
  if (nickname.length < 2 || nickname.length > 20) throw new Error('Nickname 2–20 ký tự');
  const salt = uuid(), token = uuid();
  const exp = Date.now() + TOKEN_TTL_DAYS * 86400000;
  try {
    await insertRow(env, 'Users', {
      username, userLower: username.toLowerCase(), passHash: await hashPass(password, salt),
      salt, nickname, token, tokenExp: exp, createdAt: new Date().toISOString(),
    });
  } catch (e) {
    if (String(e).indexOf('UNIQUE') >= 0) throw new Error('Username đã tồn tại, chọn tên khác');
    throw e;
  }
  return { username, nickname, token, isAdmin: await isAdmin(env, username) };
}

export async function login(env, username, password){
  username = (username || '').toString().trim();
  password = (password || '').toString();
  const r = await findRow(env, 'Users', 'userLower', username.toLowerCase());
  // One generic message for both cases — don't leak whether a username exists.
  const fail = 'Sai tên đăng nhập hoặc mật khẩu';
  if (!r) throw new Error(fail);
  const v = await verifyPass(password, r.salt, r.passHash);
  if (!v.ok) throw new Error(fail);
  const token = uuid();
  const patch = { token, tokenExp: Date.now() + TOKEN_TTL_DAYS * 86400000 };
  if (v.needsRehash) patch.passHash = await hashPass(password, r.salt); // upgrade legacy SHA-256 -> PBKDF2
  await updateRow(env, 'Users', { username: r.username }, patch);
  return { username: r.username, nickname: r.nickname, token, isAdmin: await isAdmin(env, r.username) };
}

export async function resume(env, token){
  const u = await authUser(env, token);
  const r = await findRow(env, 'Users', 'userLower', u.toLowerCase());
  return { username: u, nickname: r.nickname, token, isAdmin: await isAdmin(env, u) };
}

// Đổi mật khẩu: xác thực pass cũ -> đặt pass mới (salt mới) -> xoay token (đá mọi phiên khác).
export async function changePassword(env, token, oldPassword, newPassword){
  const username = await authUser(env, token);
  oldPassword = (oldPassword || '').toString();
  newPassword = (newPassword || '').toString();
  const r = await findRow(env, 'Users', 'userLower', username.toLowerCase());
  if (!r) throw new Error('Phiên hết hạn, đăng nhập lại');
  if (!(await verifyPass(oldPassword, r.salt, r.passHash)).ok) throw new Error('Mật khẩu hiện tại không đúng');
  if (newPassword.length < 4 || newPassword.length > 64) throw new Error('Mật khẩu mới 4–64 ký tự');
  if (newPassword === oldPassword) throw new Error('Mật khẩu mới trùng mật khẩu cũ');
  const salt = uuid(), tok = uuid();
  await updateRow(env, 'Users', { username },
    { passHash: await hashPass(newPassword, salt), salt, token: tok, tokenExp: Date.now() + TOKEN_TTL_DAYS * 86400000 });
  return { token: tok };  // client thay token mới để giữ phiên
}

// Admin đặt lại mật khẩu cho 1 user (user quên mật khẩu). Salt + hash mới + xoay token của
// user đó (đá mọi phiên cũ). Không cần biết mật khẩu cũ — đã gated bằng requireAdmin.
export async function adminResetPassword(env, token, targetUsername, newPassword){
  await requireAdmin(env, token);
  targetUsername = (targetUsername || '').toString().trim();
  newPassword = (newPassword || '').toString();
  if (newPassword.length < 4 || newPassword.length > 64) throw new Error('Mật khẩu mới 4–64 ký tự');
  const r = await findRow(env, 'Users', 'userLower', targetUsername.toLowerCase());
  if (!r) throw new Error('Không tìm thấy user');
  const salt = uuid(), tok = uuid();
  await updateRow(env, 'Users', { username: r.username },
    { passHash: await hashPass(newPassword, salt), salt, token: tok, tokenExp: Date.now() + TOKEN_TTL_DAYS * 86400000 });
  return { ok: true, username: r.username };
}

export async function setNickname(env, token, nickname){
  const username = await authUser(env, token);
  nickname = (nickname || '').toString().trim();
  if (nickname.length < 2 || nickname.length > 20) throw new Error('Nickname 2–20 ký tự');
  await updateRow(env, 'Users', { username }, { nickname });
  return { nickname };
}
