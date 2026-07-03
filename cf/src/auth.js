// Auth — port of Code.js register/login/resume/setNickname + auth_/isAdmin_/hashPass_.
// Utilities.computeDigest(SHA_256)+base64 -> Web Crypto. LockService duplicate-guard ->
// the UNIQUE(userLower) DB constraint (a DB constraint beats an app lock).
import { findRow, insertRow, updateRow } from './db.js';

const TOKEN_TTL_DAYS = 30;

export function uuid(){ return crypto.randomUUID(); }

async function hashPass(password, salt){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password + '|' + salt));
  let bin = ''; new Uint8Array(buf).forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
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
  if (!r) throw new Error('Username không tồn tại');
  if (await hashPass(password, r.salt) !== r.passHash) throw new Error('Sai mật khẩu');
  const token = uuid();
  await updateRow(env, 'Users', { username: r.username },
    { token, tokenExp: Date.now() + TOKEN_TTL_DAYS * 86400000 });
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
  if (await hashPass(oldPassword, r.salt) !== r.passHash) throw new Error('Mật khẩu hiện tại không đúng');
  if (newPassword.length < 4 || newPassword.length > 64) throw new Error('Mật khẩu mới 4–64 ký tự');
  if (newPassword === oldPassword) throw new Error('Mật khẩu mới trùng mật khẩu cũ');
  const salt = uuid(), tok = uuid();
  await updateRow(env, 'Users', { username },
    { passHash: await hashPass(newPassword, salt), salt, token: tok, tokenExp: Date.now() + TOKEN_TTL_DAYS * 86400000 });
  return { token: tok };  // client thay token mới để giữ phiên
}

export async function setNickname(env, token, nickname){
  const username = await authUser(env, token);
  nickname = (nickname || '').toString().trim();
  if (nickname.length < 2 || nickname.length > 20) throw new Error('Nickname 2–20 ký tự');
  await updateRow(env, 'Users', { username }, { nickname });
  return { nickname };
}
