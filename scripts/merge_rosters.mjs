#!/usr/bin/env node
/**
 * Union-merge two encrypted rosters: node scripts/merge_rosters.mjs A B OUT
 *
 * Used by the poll workflow when a push conflicts: every pass may have
 * auto-linked different salesmen via /join, and -X ours would silently drop
 * one side's links. Rules:
 *   - entries only present on one side are kept;
 *   - for the same code, whichever side has a telegram id wins (a link made
 *     after the roster template was created is always newer information);
 *   - if both sides linked the same code to different ids, keep the entry with
 *     the later `updated` stamp and warn — a human should double-check.
 */

import fs from "node:fs/promises";
import { encryptJson, decryptJson } from "./crypto.mjs";

const PASS = process.env.DASH_PASSPHRASE || "";
if (PASS.length < 8) {
  console.error("DASH_PASSPHRASE must be set (8+ chars)");
  process.exit(1);
}
const [aFile, bFile, outFile] = process.argv.slice(2);
if (!aFile || !bFile || !outFile) {
  console.error("usage: merge_rosters.mjs ROSTER_A.enc.json ROSTER_B.enc.json OUT.enc.json");
  process.exit(1);
}

const load = async (file) => {
  try {
    return decryptJson(JSON.parse(await fs.readFile(file, "utf8")), PASS);
  } catch {
    return null; // missing or unreadable side: the other one wins outright
  }
};

const pickNewer = (stampA, stampB) => (Date.parse(stampB || 0) > Date.parse(stampA || 0) ? stampB : stampA) || null;

const [ra, rb] = await Promise.all([load(aFile), load(bFile)]);
if (!ra && !rb) {
  console.error("neither roster decrypted — leaving the file untouched");
  process.exit(1); // caller keeps its own copy and warns
}
const salesmen = [];
const index = new Map();
for (const s of [...(ra?.salesmen || []), ...(rb?.salesmen || [])]) {
  if (!s?.code) continue;
  const prev = index.get(s.code);
  if (!prev) {
    const copy = { ...s };
    index.set(s.code, copy);
    salesmen.push(copy);
    continue;
  }
  const prevLinked = Number(prev.tg) > 0;
  const curLinked = Number(s.tg) > 0;
  if (curLinked && !prevLinked) {
    Object.assign(prev, s);
  } else if (curLinked && prevLinked && String(prev.tg) !== String(s.tg)) {
    // two passes linked the same code to different people: newest update wins
    const src = Date.parse(rb?.updated || 0) > Date.parse(ra?.updated || 0) ? s : prev;
    if (src !== prev) Object.assign(prev, s);
    console.warn(`[merge_rosters] conflicting tg for ${s.code}: kept ${prev.tg} — verify`);
  }
  prev.updated = pickNewer(prev.updated, s.updated);
}

const merged = { updated: pickNewer(ra?.updated, rb?.updated), salesmen };
await fs.writeFile(outFile, JSON.stringify(encryptJson(merged, PASS), null, 2) + "\n");
console.log(`[merge_rosters] wrote ${outFile} (${salesmen.length} salesman)`);
