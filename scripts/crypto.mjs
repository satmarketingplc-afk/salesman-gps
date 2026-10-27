/**
 * AES-256-GCM helpers shared by the poller, the roster CLI and the test harness.
 * Format (also read by the browser via WebCrypto):
 *   { v, kdf, iter, salt, iv, tag, ct }  — all binary values base64
 */

import crypto from "node:crypto";

export const ITER = 210000;

export function encryptJson(value, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(passphrase, salt, ITER, 32, "sha256");
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
  const key = crypto.pbkdf2Sync(
    passphrase,
    Buffer.from(box.salt, "base64"),
    box.iter || ITER,
    32,
    "sha256"
  );
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(box.ct, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString("utf8"));
}
