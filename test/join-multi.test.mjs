#!/usr/bin/env node
/**
 * Regression test for the "only ONE salesman gets registered" bug.
 *
 * Scenario (fresh install, bootstrap mode): three salesmen each send /join with
 * their OWN code (SM-001, SM-002, SM-003) inside one sync pass, then share live
 * location. ALL THREE must end up linked in the roster and visible on the map.
 *
 * Also covers:
 *  - duplicate /join by the same person → "already linked", no extra claim
 *  - two people claiming the SAME code → first wins, second rejected, both rows survive
 *  - a new device trying to steal an already-linked code → rejected, link untouched
 *
 * Runs the real poller (scripts/poll_telegram.mjs via runOnce) against a fake
 * Telegram API — no network, no bot token. Usage:
 *   node test/join-multi.test.mjs          # exit 0 = pass
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";

const ROOT = process.cwd(); // must run from the repo root
const TMP = path.join(ROOT, "test", ".tmp-join");
const PASS = "testpass1234";

// ---- fake Telegram API -----------------------------------------------------
let updateQueue = []; // array of getUpdates batches
const sentMessages = []; // every sendMessage payload, for assertions

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
  if (method === "getUpdates") {
    result = updateQueue.shift() || [];
  } else if (method === "sendMessage") {
    sentMessages.push(body);
    result = { message_id: sentMessages.length };
  } else {
    result = [];
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, result }));
});

// ---- helpers ----------------------------------------------------------------
const mkUpdate = (id, from, extraMsg = {}) => ({
  update_id: id,
  message: {
    message_id: id,
    date: Math.floor(Date.now() / 1000),
    from,
    chat: { id: from.id },
    ...extraMsg,
  },
});

const loc = (lat, lng) => ({ location: { latitude: lat, longitude: lng, live_period: 8 * 3600 } });

const people = [
  { id: 111, first_name: "Abebe", username: "abebe_sm1" },
  { id: 222, first_name: "Selam", username: "selam_sm2" },
  { id: 333, first_name: "Dawit", username: "dawit_sm3" },
];

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
};

const decryptRoster = async () => {
  const { decryptJson } = await import(path.join(ROOT, "scripts", "crypto.mjs"));
  const box = JSON.parse(await fs.readFile(path.join(TMP, "roster.enc.json"), "utf8"));
  return decryptJson(box, PASS);
};

const freshTmp = async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP, "archive"), { recursive: true });
  await fs.mkdir(path.join(TMP, "out"), { recursive: true });
};

// ---- run --------------------------------------------------------------------
async function main() {
  await freshTmp();
  await server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  process.env.DASH_PASSPHRASE = PASS;

  const mod = await import(path.join(ROOT, "scripts", "poll_telegram.mjs"));

  // ---------- Case 1: bootstrap — three DIFFERENT codes in one pass ----------
  console.log("\nCase 1: three salesmen /join their own codes during bootstrap (one pass)");
  updateQueue = [
    [
      mkUpdate(1, people[0], { text: "/join SM-001" }),
      mkUpdate(2, people[1], { text: "/join SM-002" }),
      mkUpdate(3, people[2], { text: "/join SM-003" }),
      mkUpdate(4, people[0], loc(9.01, 38.76)),
      mkUpdate(5, people[1], loc(9.02, 38.75)),
      mkUpdate(6, people[2], loc(9.00, 38.77)),
    ],
  ];
  await mod.runOnce({
    rosterFile: path.join(TMP, "roster.enc.json"),
    archiveDir: path.join(TMP, "archive"),
    outDir: path.join(TMP, "out"),
    token: "faketoken",
    passphrase: PASS,
    apiBase,
  });
  const r1 = await decryptRoster();
  const tgOf = (code) => Number(r1.salesmen.find((s) => s.code === code)?.tg || 0);
  check("SM-001 linked to 111", tgOf("SM-001") === 111, `got ${tgOf("SM-001")}`);
  check("SM-002 linked to 222", tgOf("SM-002") === 222, `got ${tgOf("SM-002")}`);
  check("SM-003 linked to 333", tgOf("SM-003") === 333, `got ${tgOf("SM-003")}`);

  const { decryptJson } = await import(path.join(ROOT, "scripts", "crypto.mjs"));
  const live1 = decryptJson(
    JSON.parse(await fs.readFile(path.join(TMP, "out", "live.enc.json"), "utf8")), PASS);
  check("live payload shows all 3 salesmen", live1.salesmen.length === 3,
    `got ${live1.salesmen.map((s) => s.code).join(",")}`);

  // pending queue must be empty after auto-assign
  const pendBox = JSON.parse(await fs.readFile(path.join(TMP, "pending.enc.json"), "utf8"));
  check("pending queue drained", decryptJson(pendBox, PASS).length === 0);

  // ---------- Case 2: duplicate /join by the same person ----------
  console.log("\nCase 2: same person re-sends /join (already linked) — must not disturb others");
  sentMessages.length = 0;
  updateQueue = [[mkUpdate(10, people[1], { text: "/join SM-002" })]];
  await mod.runOnce({
    rosterFile: path.join(TMP, "roster.enc.json"),
    archiveDir: path.join(TMP, "archive"),
    outDir: path.join(TMP, "out"),
    token: "faketoken",
    passphrase: PASS,
    apiBase,
  });
  const r2 = await decryptRoster();
  check("roster unchanged (still 3 links)",
    [111, 222, 333].every((id) => r2.salesmen.some((s) => Number(s.tg) === id)));
  check("person told 'Already linked'",
    sentMessages.some((m) => /Already linked/i.test(m.text || "")));

  // ---------- Case 3: two devices fight over one free code ----------
  // Reset to bootstrap state: delete roster so codes are unclaimed again.
  console.log("\nCase 3: two unknown devices claim the SAME code in one pass");
  await freshTmp();
  sentMessages.length = 0;
  updateQueue = [
    [
      mkUpdate(20, people[0], { text: "/join SM-001" }),
      mkUpdate(21, people[1], { text: "/join SM-001" }), // steals nothing: FIFO wins
      mkUpdate(22, people[2], { text: "/join SM-003" }), // different code: must still register
    ],
  ];
  await mod.runOnce({
    rosterFile: path.join(TMP, "roster.enc.json"),
    archiveDir: path.join(TMP, "archive"),
    outDir: path.join(TMP, "out"),
    token: "faketoken",
    passphrase: PASS,
    apiBase,
  });
  const r3 = await decryptRoster();
  check("first claimer won SM-001", Number(r3.salesmen.find((s) => s.code === "SM-001")?.tg) === 111);
  check("second claimer got rejected, not linked",
    !r3.salesmen.some((s) => Number(s.tg) === 222));
  check("rejected claimer sees 'already claimed' message",
    sentMessages.some((m) => String(m.chat_id) === "222" && /already claimed/i.test(m.text || "")));
  check("unrelated SM-003 STILL registered despite the clash",
    Number(r3.salesmen.find((s) => s.code === "SM-003")?.tg) === 333);

  // ---------- Case 4: new device tries to steal an ALREADY-LINKED code ----------
  console.log("\nCase 4: after links exist, a stranger sends /join SM-001");
  sentMessages.length = 0;
  const stranger = { id: 999, first_name: "Stranger" };
  updateQueue = [[mkUpdate(30, stranger, { text: "/join SM-001" })]];
  await mod.runOnce({
    rosterFile: path.join(TMP, "roster.enc.json"),
    archiveDir: path.join(TMP, "archive"),
    outDir: path.join(TMP, "out"),
    token: "faketoken",
    passphrase: PASS,
    apiBase,
  });
  const r4 = await decryptRoster();
  check("SM-001 still belongs to 111 (no hijack)",
    Number(r4.salesmen.find((s) => s.code === "SM-001")?.tg) === 111);
  check("stranger not linked anywhere", !r4.salesmen.some((s) => Number(s.tg) === 999));
  check("stranger told the code is registered elsewhere",
    sentMessages.some((m) => String(m.chat_id) === "999" && /another phone/i.test(m.text || "")));

  server.close();
  await once(server, "close");

  console.log(failures ? `\nFAILED: ${failures} check(s)` : "\nALL CHECKS PASSED");
  await fs.rm(TMP, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
