/**
 * AES-256-GCM helpers shared by the poller, the roster CLI and the test harness.
 * Format (also read by the browser via WebCrypto):
 *   { v, kdf, iter, salt, iv, tag, ct }  — all binary values base64
 */

import crypto from "node:crypto";

export const ITER = 210000;

// PBKDF2 with 210k iterations costs ~100 ms per call on server CPUs. The poller
// decrypts + re-encrypts every salesman's day file on every pass, so deriving the
// key each time froze whole passes. Cache the derived key by (passphrase, salt,
// iter): salts are random per encryption, so a hit means the box was produced by
// this process (or decrypted before) — the same salt under a different passphrase
// can never collide because the cache key includes the passphrase.
const KEY_CACHE_MAX = 64;
const keyCache = new Map(); // "pass|saltB64|iter" -> Buffer(32), LRU

function deriveKey(passphrase, saltBuf, iter) {
  const ck = `${passphrase}|${saltBuf.toString("base64")}|${iter}`;
  const hit = keyCache.get(ck);
  if (hit) {
    keyCache.delete(ck); // refresh recency
    keyCache.set(ck, hit);
    return hit;
  }
  const key = crypto.pbkdf2Sync(passphrase, saltBuf, iter, 32, "sha256");
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.delete(keyCache.keys().next().value);
  keyCache.set(ck, key);
  return key;
}

export function encryptJson(value, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt, ITER);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    v: 1,
    kdf: "PBKDF2-SHA256",
    iter: ITER,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

export function decryptJson(box, passphrase) {
  const key = deriveKey(passphrase, Buffer.from(box.salt, "base64"), box.iter || ITER);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(box.ct, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString("utf8"));
}
