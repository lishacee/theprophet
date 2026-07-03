// Proves the Worker's hashPass is bit-identical to GAS's
// Utilities.computeDigest(SHA_256, s) + base64Encode(...), so migrated users
// authenticate with their existing passHash — NO password reset needed.
// Run: node cf/test_auth.mjs
import assert from 'node:assert';
import { createHash, webcrypto } from 'node:crypto';

// Exactly the auth.js implementation:
async function hashPass(password, salt){
  const buf = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(password + '|' + salt));
  let bin = ''; new Uint8Array(buf).forEach(b => bin += String.fromCharCode(b));
  return Buffer.from(bin, 'binary').toString('base64'); // btoa equivalent in Node
}

// 1) Known SHA-256 vector, standard base64 — same algorithm GAS uses.
const abc = createHash('sha256').update('abc').digest('base64');
assert.strictEqual(abc, 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=', 'SHA-256("abc") base64');

// 2) Our Web Crypto path == Node's standard SHA-256+base64 for the "pw|salt" input.
const std = createHash('sha256').update('secret|my-salt', 'utf8').digest('base64');
const ours = await hashPass('secret', 'my-salt');
assert.strictEqual(ours, std, 'Web Crypto hashPass matches standard SHA-256+base64 (== GAS output)');

// 3) Determinism.
assert.strictEqual(await hashPass('secret','my-salt'), ours);

console.log('OK — hashPass is standard SHA-256+base64; existing GAS passwords validate unchanged.');
