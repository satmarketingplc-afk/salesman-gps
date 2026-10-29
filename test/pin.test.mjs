#!/usr/bin/env node
/**
 * End-to-end check for the /pin check-in system across SEPARATE poller passes,
 * with MULTIPLE salesmen pinned at the same time.
 *
 *   Pass 1: SM-001 + SM-002 join and share live location      -> both on map
 *   Pass 2: SM-001 sends "/pin Client X meeting"              -> pin published
 *           (same pass also replays SM-001's old location msg -> dedupe)
 *   Pass 3: SM-002 sends "/pin Shop Y"                        -> BOTH pins visible
 *   Pass 4: unregistered stranger sends /pin                 -> told to /join first
 *   Pass 5: replay of the two /pin messages                  -> no duplicate pins
 *   Pass 6: SM-001 sends /unpin                              -> his pins gone, SM-002 kept
 *
 * Usage: node test/pin.test.mjs      # exit 0 = pass
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";

const ROOT = process.cwd(); // must run from the repo root
const TMP = path.join(ROOT, "test", ".tmp-pin");
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
    result = { message_id: 900 + sentMessages.length };
  } else result = [];
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, result }));
});

const loc = (lat, lng) => ({ location: { latitude: lat, longitude: lng, live_period: 8 * 3600 } });

const people = [
  { id: 111, first_name: "Abebe", username: "abebe_sm1" },
  { id: 222, first_name: "Selam", username: "selam_sm2" },
  { id: 999, first_name: "Stranger", username: "rando" },
];

// Pin message dates so replays are byte-identical (dedupe keys off id + ts).
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

  const readLive = async () => decryptJson(JSON.parse(await fs.readFile(path.join(TMP, "out", "live.enc.json"), "utf8")), PASS);
  const readPinArchive = async () => {
    const box = await fs.readFile(path.join(TMP, "archive", "pins.enc.json"), "utf8").catch(() => null);
    return box ? decryptJson(JSON.parse(box), PASS) : [];
  };
  const codesIn = (live) => live.salesmen.map((s) => s.code).sort().join(",");
  const pinsBy = (live) => live.pins.map((p) => p.by).sort().join(",");

  // ---------- Pass 1: two salesmen register ----------
  console.log("Pass 1: SM-001 + SM-002 join and share live location");
  updateQueue = [[
    mkUpdate(1, people[0], { text: "/join SM-001" }),
    mkUpdate(2, people[0], loc(9.01, 38.76)),
    mkUpdate(3, people[1], { text: "/join SM-002" }),
    mkUpdate(4, people[1], loc(9.02, 38.75)),
  ]];
  await mod.runOnce(overrides);
  let live = await readLive();
  check("both salesmen on the map", codesIn(live) === "SM-001,SM-002", `got ${codesIn(live)}`);
  check("no pins yet", (live.pins || []).length === 0);

  // ---------- Pass 2: SM-001 pins his current spot ----------
  console.log("\nPass 2: SM-001 sends '/pin Client X meeting'");
  sentMessages.length = 0;
  updateQueue = [[
    mkUpdate(2, people[0], loc(9.01, 38.76)),          // replayed old location — must dedupe
    mkUpdate(5, people[0], { text: "/pin Client X meeting" }),
  ]];
  await mod.runOnce(overrides);
  live = await readLive();
  check("one pin published in live payload", (live.pins || []).length === 1, `got ${JSON.stringify(live.pins)}`);
  const p1 = (live.pins || [])[0] || {};
  check("pin belongs to SM-001 (Abebe)", p1.by === "SM-001" && /Abebe/.test(p1.byName || ""), JSON.stringify(p1));
  check("pin carries the note", p1.note === "Client X meeting", `got ${p1.note}`);
  check("pin has coordinates + timestamps", Number.isFinite(p1.lat) && Number.isFinite(p1.lng) && !!p1.ts && !!p1.locTs);
  check("SM-001 confirmed via Telegram", sentMessages.some((m) => String(m.chat_id) === "111" && /Pinned/i.test(m.text || "")));
  check("replayed location did NOT create a second pin", (await readLive()).pins.length === 1);
  check("pin archive written", (await readPinArchive()).length === 1);

  // ---------- Pass 3: SM-002 pins too — BOTH must show ----------
  console.log("\nPass 3: SM-002 sends '/pin Shop Y' — both pins must be visible");
  sentMessages.length = 0;
  updateQueue = [[mkUpdate(6, people[1], { text: "/pin Shop Y" })]];
  await mod.runOnce(overrides);
  live = await readLive();
  check("two pins visible together", (live.pins || []).length === 2, `got ${JSON.stringify((live.pins || []).map(p => p.by))}`);
  check("pins from BOTH salesmen", pinsBy(live) === "SM-001,SM-002", `got ${pinsBy(live)}`);
  check("SM-002 pin uses his own last location", (live.pins || []).find(p => p.by === "SM-002")?.lat === 9.02);
  check("SM-001 pin untouched by SM-002's join", (live.pins || []).find(p => p.by === "SM-001")?.note === "Client X meeting");

  // ---------- Pass 4: stranger (not registered) tries to pin ----------
  console.log("\nPass 4: unregistered stranger sends /pin");
  sentMessages.length = 0;
  updateQueue = [[mkUpdate(7, people[2], { text: "/pin hacked" })]];
  await mod.runOnce(overrides);
  live = await readLive();
  check("stranger got NO pin", (live.pins || []).length === 2 && !pinsBy(live).includes("999"));
  check("stranger told to /join first", sentMessages.some((m) => /join/i.test(m.text || "") && String(m.chat_id) === "999"));

  // ---------- Pass 5: Telegram replays the old /pin updates ----------
  console.log("\nPass 5: replay of both /pin messages — no duplicates allowed");
  updateQueue = [[
    mkUpdate(5, people[0], { text: "/pin Client X meeting" }),
    mkUpdate(6, people[1], { text: "/pin Shop Y" }),
  ]];
  await mod.runOnce(overrides);
  live = await readLive();
  check("still exactly 2 pins after replay", (live.pins || []).length === 2, `got ${(live.pins || []).length}`);
  check("archive still 2 pins", (await readPinArchive()).length === 2);

  // ---------- Pass 6: SM-001 unpins — SM-002's pin must survive ----------
  console.log("\nPass 6: SM-001 sends /unpin");
  sentMessages.length = 0;
  updateQueue = [[mkUpdate(8, people[0], { text: "/unpin" })]];
  await mod.runOnce(overrides);
  live = await readLive();
  check("SM-001 pins removed", (live.pins || []).filter((p) => p.by === "SM-001").length === 0);
  check("SM-002 pin STILL there", (live.pins || []).some((p) => p.by === "SM-002" && p.note === "Shop Y"));
  check("SM-001 told how many were removed", sentMessages.some((m) => String(m.chat_id) === "111" && /Removed/i.test(m.text || "")));

  server.close();
  await once(server, "close");
  await fs.rm(TMP, { recursive: true, force: true });

  console.log(failures ? `\nFAILED: ${failures} check(s)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
