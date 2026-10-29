#!/usr/bin/env node
/**
 * End-to-end check for the REAL production flow: salesmen register at different
 * times, in separate poller passes (each pass = one workflow run), exactly like
 * live devices trickling in during a workday.
 *
 *   Pass 1: SM-001 sends /join + shares live location        -> visible on map
 *   Pass 2: SM-002 sends /join + shares live location        -> BOTH visible
 *   Pass 3: SM-003 sends /join only                          -> linked, no pin yet
 *   Pass 4: SM-003 shares live location                      -> ALL THREE visible
 *   Pass 5: replay of old updates (offset lag)               -> no duplicates, no damage
 *
 * The committed private/roster.enc.json and private/pending.enc.json are used as
 * the starting state (bootstrap: all tg=0), then a throwaway copy is mutated —
 * the repo files are never touched.
 *
 * Usage: node test/join-staged.test.mjs      # exit 0 = pass
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";

const ROOT = process.cwd(); // must run from the repo root
const TMP = path.join(ROOT, "test", ".tmp-staged");
const PASS = "testpass1234";

let updateQueue = []; // array of getUpdates batches (one per pass)
const sentMessages = [];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const method = url.pathname.split("/").pop();
  let body = {};
  if (req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  }
  let result;
  if (method === "getUpdates") result = updateQueue.shift() || [];
  else if (method === "sendMessage") {
    sentMessages.push(body);
    result = { message_id: sentMessages.length };
  } else result = [];
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, result }));
});

const loc = (lat, lng) => ({ location: { latitude: lat, longitude: lng, live_period: 8 * 3600 } });

const people = [
  { id: 111, first_name: "Abebe", username: "abebe_sm1" },
  { id: 222, first_name: "Selam", username: "selam_sm2" },
  { id: 333, first_name: "Dawit", username: "dawit_sm3" },
];

// Telegram stamps each message with a fixed date; replays carry the SAME ts.
// Pin the dates so pass 5 can replay byte-identical updates.
const MSG_DATE = {}; // update_id -> unix seconds
const mkUpdate = (id, from, extraMsg = {}) => {
  if (!(id in MSG_DATE)) MSG_DATE[id] = Math.floor(Date.now() / 1000);
  return {
    update_id: id,
    message: { message_id: id, date: MSG_DATE[id], from, chat: { id: from.id }, ...extraMsg },
  };
};
let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
};

async function main() {
  // Rebuild the exact production starting state: the committed public template
  // (all tg=0) encrypted with THIS test passphrase. The repo's own
  // private/roster.enc.json is encrypted with the deployment passphrase and is
  // never touched here.
  const { encryptJson } = await import(path.join(ROOT, "scripts", "crypto.mjs"));
  const template = JSON.parse(await fs.readFile(path.join(ROOT, "data", "salesmen.json"), "utf8"));
  const startBox = encryptJson(template, PASS);

  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP, "archive", "state"), { recursive: true });
  await fs.mkdir(path.join(TMP, "out"), { recursive: true });
  await fs.writeFile(path.join(TMP, "roster.enc.json"), JSON.stringify(startBox));

  await server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  process.env.DASH_PASSPHRASE = PASS;

  const mod = await import(path.join(ROOT, "scripts", "poll_telegram.mjs"));
  const { decryptJson } = await import(path.join(ROOT, "scripts", "crypto.mjs"));

  const rosterFile = path.join(TMP, "roster.enc.json");
  const overrides = { rosterFile, archiveDir: path.join(TMP, "archive"), outDir: path.join(TMP, "out"), token: "faketoken", passphrase: PASS, apiBase };

  const readRoster = async () => decryptJson(JSON.parse(await fs.readFile(rosterFile, "utf8")), PASS);
  const readLive = async () => decryptJson(JSON.parse(await fs.readFile(path.join(TMP, "out", "live.enc.json"), "utf8")), PASS);
  const tgOf = (r, code) => Number(r.salesmen.find((s) => s.code === code)?.tg || 0);
  const codesIn = (live) => live.salesmen.map((s) => s.code).sort().join(",");

  // Starting state must be the broken one the office reported: nobody linked.
  const r0 = await readRoster();
  check("start state: zero salesman linked (all tg=0)", r0.salesmen.every((s) => !Number(s.tg)));

  // ---------- Pass 1: first device registers ----------
  console.log("\nPass 1: SM-001 joins and shares live location");
  updateQueue = [[mkUpdate(1, people[0], { text: "/join SM-001" }), mkUpdate(2, people[0], loc(9.01, 38.76))]];
  await mod.runOnce(overrides);
  let r = await readRoster();
  check("SM-001 linked to 111", tgOf(r, "SM-001") === 111, `got ${tgOf(r, "SM-001")}`);
  check("map shows SM-001", (await readLive()).salesmen.length === 1);

  // ---------- Pass 2: second device registers (separate run!) ----------
  console.log("\nPass 2: SM-002 joins later — must NOT erase SM-001");
  updateQueue = [[mkUpdate(3, people[1], { text: "/join SM-002" }), mkUpdate(4, people[1], loc(9.02, 38.75))]];
  await mod.runOnce(overrides);
  r = await readRoster();
  check("SM-001 STILL linked to 111", tgOf(r, "SM-001") === 111);
  check("SM-002 linked to 222", tgOf(r, "SM-002") === 222);
  check("map shows BOTH salesmen", codesIn(await readLive()) === "SM-001,SM-002", `got ${codesIn(await readLive())}`);

  // ---------- Pass 3: third device joins but does not share location yet ----------
  console.log("\nPass 3: SM-003 joins, no location shared yet");
  updateQueue = [[mkUpdate(5, people[2], { text: "/join SM-003" })]];
  await mod.runOnce(overrides);
  r = await readRoster();
  check("SM-003 linked to 333", tgOf(r, "SM-003") === 333);
  check("first two unaffected by the new join", tgOf(r, "SM-001") === 111 && tgOf(r, "SM-002") === 222);

  // ---------- Pass 4: SM-003 finally shares live location ----------
  console.log("\nPass 4: SM-003 shares live location");
  updateQueue = [[mkUpdate(6, people[2], loc(9.00, 38.77))]];
  await mod.runOnce(overrides);
  check("map shows ALL THREE salesmen", codesIn(await readLive()) === "SM-001,SM-002,SM-003", `got ${codesIn(await readLive())}`);

  // ---------- Pass 5: Telegram replays old updates (offset lags behind) ----------
  // Replay EXACTLY the same messages: mkUpdate stamps date=now at call time, so
  // building these objects now gives them the same ts as in passes 1–4. A real
  // replay carries identical timestamps; dedupe must drop every one of them.
  console.log("\nPass 5: replay of already-processed updates — nothing may break");
  sentMessages.length = 0;
  updateQueue = [[
    mkUpdate(1, people[0], { text: "/join SM-001" }),   // same update_id AND same ts
    mkUpdate(2, people[0], loc(9.01, 38.76)),
    mkUpdate(3, people[1], { text: "/join SM-002" }),
    mkUpdate(4, people[1], loc(9.02, 38.75)),
    mkUpdate(6, people[2], loc(9.00, 38.77)),
  ]];
  const liveBefore = await readLive();
  const pointsBefore = Object.fromEntries(liveBefore.salesmen.map((s) => [s.code, s.points]));
  await mod.runOnce(overrides);
  r = await readRoster();
  const live5 = await readLive();
  check("links unchanged after replay", tgOf(r, "SM-001") === 111 && tgOf(r, "SM-002") === 222 && tgOf(r, "SM-003") === 333);
  check("no duplicate points after replay",
    live5.salesmen.every((s) => s.points === pointsBefore[s.code]),
    `before=${JSON.stringify(pointsBefore)} after=${live5.salesmen.map((s) => `${s.code}:${s.points}`).join(",")}`);
  check("still three on the map", codesIn(live5) === "SM-001,SM-002,SM-003");
  check("replayed joins answered 'Already linked'",
    sentMessages.filter((m) => /Already linked/i.test(m.text || "")).length >= 2);

  // ---------- Pending queue must be drained ----------
  const pendBox = await fs.readFile(path.join(TMP, "pending.enc.json"), "utf8").catch(() => null);
  check("pending queue empty at the end", !pendBox || decryptJson(JSON.parse(pendBox), PASS).length === 0);

  server.close();
  await once(server, "close");
  await fs.rm(TMP, { recursive: true, force: true });

  console.log(failures ? `\nFAILED: ${failures} check(s)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
