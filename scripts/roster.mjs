#!/usr/bin/env node
/**
 * Encrypted roster CLI — the only file that maps a Telegram id to a salesman.
 *
 *   node scripts/roster.mjs init
 *   node scripts/roster.mjs add SM-001 "Abebe K." "አበበ ከ." 812345678 "#e11d48"
 *   node scripts/roster.mjs tg SM-001 812345678
 *   node scripts/roster.mjs list
 *   node scripts/roster.mjs pending          # self-service /join claims awaiting approval
 *   node scripts/roster.mjs pending --apply  # write every claim into the roster now
 *   node scripts/roster.mjs unmapped
 *
 * Requires DASH_PASSPHRASE. Roster path: ROSTER_FILE (default private/roster.enc.json);
 * the pending queue lives next to it (PENDING_FILE or private/pending.enc.json).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { encryptJson, decryptJson } from "./crypto.mjs";

const FILE = path.resolve(process.env.ROSTER_FILE || "private/roster.enc.json");
const PENDING_FILE = path.resolve(process.env.PENDING_FILE || path.join(path.dirname(FILE), "pending.enc.json"));
const PASS = process.env.DASH_PASSPHRASE || "";
const [cmd, ...args] = process.argv.slice(2);

if (PASS.length < 8) {
  console.error("DASH_PASSPHRASE must be set (8+ chars) — same one as the GitHub secret");
  process.exit(1);
}

const read = async () => {
  try {
    return decryptJson(JSON.parse(await fs.readFile(FILE, "utf8")), PASS);
  } catch (err) {
    if (err.code === "ENOENT") return { updated: null, salesmen: [] };
    console.error("cannot decrypt roster:", err.message);
    process.exit(1);
  }
};

const write = async (roster) => {
  roster.updated = new Date().toISOString().slice(0, 10);
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(encryptJson(roster, PASS), null, 2) + "\n");
  console.log(`wrote ${FILE} (${roster.salesmen.length} salesman)`);
};

const roster = await read();

switch (cmd) {
  case "init":
    await write(roster);
    break;

  case "add": {
    const [code, name, nameAm, tg, color] = args;
    if (!code || !name) {
      console.error('usage: add CODE "Name" "ስም" TELEGRAM_ID "#color"');
      process.exit(1);
    }
    const entry = {
      code,
      name,
      nameAm: nameAm || name,
      tg: Number(tg) || 0,
      username: "",
      color: color || "#2563eb",
      active: true,
    };
    const i = roster.salesmen.findIndex((s) => s.code === code);
    if (i >= 0) roster.salesmen[i] = { ...roster.salesmen[i], ...entry };
    else roster.salesmen.push(entry);
    await write(roster);
    break;
  }

  case "tg": {
    const [code, tg] = args;
    const sm = roster.salesmen.find((s) => s.code === code);
    if (!sm) {
      console.error(`no salesman ${code}`);
      process.exit(1);
    }
    sm.tg = Number(tg);
    await write(roster);
    break;
  }

  case "list":
    if (!roster.salesmen.length) console.log("roster is empty");
    for (const s of roster.salesmen) {
      console.log(`${s.code}  tg=${s.tg || "-"}  ${s.name} / ${s.nameAm}  ${s.active === false ? "(inactive)" : ""}`);
    }
    if (roster.salesmen.length && !roster.salesmen.some((s) => s.active !== false && Number(s.tg))) {
      console.log("\n⚠ NOBODY is linked to a Telegram id — every ping lands in `unmapped` and the map stays empty.");
      console.log("  Fix: node scripts/roster.mjs pending   (self-service /join claims), then --apply,");
      console.log("       or add ids manually: node scripts/roster.mjs tg SM-001 <telegram id>");
    }
    break;

  case "pending": {
    // self-service /join claims written by the poller (AUTO_ASSIGN=0 mode, or
    // unknown codes that stayed in the queue). --apply links them right now.
    let list = [];
    try {
      list = decryptJson(JSON.parse(await fs.readFile(PENDING_FILE, "utf8")), PASS);
    } catch (err) {
      if (err.code !== "ENOENT") console.error("cannot decrypt pending queue:", err.message);
      console.log("no pending /join claims");
      break;
    }
    if (!Array.isArray(list)) list = [];
    if (!list.length) { console.log("no pending /join claims"); break; }
    const apply = args.includes("--apply");
    const byCode = new Map(roster.salesmen.map((s) => [s.code, s]));
    const keep = [];
    let applied = 0;
    for (const p of list) {
      const sm = byCode.get(p.code);
      if (!sm) {
        console.log(`${p.code}  tg=${p.tg}  ${p.who || "?"}  @${p.username || "-"}  ${p.ts}  (unknown code)`);
        keep.push(p);
        continue;
      }
      if (apply) {
        sm.tg = Number(p.tg);
        if (p.username && !sm.username) sm.username = p.username;
        applied++;
        console.log(`linked ${p.code} → tg=${p.tg} (${p.who || "?"})`);
      } else {
        console.log(`${p.code}  tg=${p.tg}  ${p.who || "?"}  @${p.username || "-"}  ${p.ts}  — apply with: pending --apply`);
        keep.push(p);
      }
    }
    if (apply && applied) {
      await write(roster);
      await fs.writeFile(PENDING_FILE, JSON.stringify(encryptJson(keep, PASS), null, 2) + "\n");
      console.log(`applied ${applied} claim(s); commit private/roster.enc.json + private/pending.enc.json and push`);
    }
    break;
  }

  case "unmapped": {
    const file = path.resolve(process.env.ARCHIVE_DIR || "archive", "unmapped.enc.json");
    try {
      const list = decryptJson(JSON.parse(await fs.readFile(file, "utf8")), PASS);
      const seen = new Map();
      for (const u of list) seen.set(u.tg, u);
      if (!seen.size) console.log("no unmapped pings");
      for (const u of seen.values()) console.log(`tg=${u.tg}  ${u.who || "?"}  @${u.username || "-"}  last=${u.ts}`);
    } catch {
      console.log("no unmapped pings yet");
    }
    break;
  }

  default:
    console.log(`usage:
  node scripts/roster.mjs init
  node scripts/roster.mjs add SM-001 "Abebe K." "አበበ ከ." 812345678 "#e11d48"
  node scripts/roster.mjs tg SM-001 812345678
  node scripts/roster.mjs list
  node scripts/roster.mjs pending [--apply]
  node scripts/roster.mjs unmapped`);
}
