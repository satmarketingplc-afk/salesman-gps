#!/usr/bin/env node
/**
 * Mock feed for one-time crypto testing ONLY. The production system is online-only
 * (Telegram → GitHub Actions → hosted pages); never run this as part of the live
 * pipeline and never commit its output over the real live.enc.json.
 * Generates three salesmen walking around Addis, encrypts the payload with
 * the same AES-GCM scheme the real poller uses.
 *
 *   node scripts/mock_live.mjs            (passphrase: demo1234)
 *   DASH_PASSPHRASE=secret123 node scripts/mock_live.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const OUT = path.resolve("dashboard/public/live.enc.json");
const PASS = process.env.DASH_PASSPHRASE || "demo1234";

const people = [
  { code: "SM-001", name: "Abebe K.", nameAm: "አበበ ከ.", color: "#e11d48", lat: 9.0108, lng: 38.7613 },
  { code: "SM-002", name: "Selam T.", nameAm: "ሰላም ተ.", color: "#2563eb", lat: 9.0192, lng: 38.7521 },
  { code: "SM-003", name: "Dawit M.", nameAm: "ዳዊት ም.", color: "#059669", lat: 9.0044, lng: 38.7735 },
];

const now = Date.now();
const salesmen = people.map((p, idx) => {
  const trail = [];
  let lat = p.lat;
  let lng = p.lng;
  for (let i = 40; i >= 0; i--) {
    lat += Math.sin((i + idx) / 3) * 0.00035;
    lng += Math.cos((i + idx) / 4) * 0.00035;
    trail.push([Number(lat.toFixed(6)), Number(lng.toFixed(6))]);
  }
  const stale = idx === 2;
  // same rule as the poller: full-day distance, GPS jumps over 500 m ignored
  let meters = 0;
  for (let i = 1; i < trail.length; i++) {
    const [a1, o1] = trail[i - 1], [a2, o2] = trail[i];
    const rad = (d) => (d * Math.PI) / 180;
    const dA = rad(a2 - a1), dO = rad(o2 - o1);
    const h = Math.sin(dA / 2) ** 2 + Math.cos(rad(a1)) * Math.cos(rad(a2)) * Math.sin(dO / 2) ** 2;
    const step = 2 * 6371 * Math.asin(Math.sqrt(h));
    if (step < 0.5) meters += step;
  }
  return {
    ...p,
    lat: trail[trail.length - 1][0],
    lng: trail[trail.length - 1][1],
    acc: 10 + idx * 6,
    ts: new Date(now - (stale ? 9 * 60 * 1000 : idx * 12000)).toISOString(),
    online: !stale,
    live: !stale,
    battery: 88 - idx * 17,
    distKm: Math.round(meters * 10) / 10,
    points: trail.length,
    trail,
  };
});

const payload = { generated: new Date().toISOString(), salesmen };

const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(PASS, salt, 210000, 32, "sha256");
const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(
  OUT,
  JSON.stringify(
    {
      v: 1,
      kdf: "PBKDF2-SHA256",
      iter: 210000,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ct: ct.toString("base64"),
    },
    null,
    2
  ) + "\n"
);

console.log(`[mock] wrote ${OUT}  passphrase=${PASS}  people=${salesmen.length}`);
