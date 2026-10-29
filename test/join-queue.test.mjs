#!/usr/bin/env node
/**
 * Regression test for "it only accepts SM-001, the rest don't get in".
 *
 * Reproduces the REAL production shape of the bug:
 *   - private/roster.enc.json exists with SM-001 already linked (bootstrap over)
 *   - AUTO_ASSIGN=0 on Render (manual approval mode)
 *   - SM-002 and SM-003 send /join with their own codes
 *
 * Old behaviour (two compounding bugs):
 *   1. recordJoin never checked the ROSTER for taken codes, so a person re-sending
 *      an already-linked code clobbered the pending slot of a legitimate earlier
 *      claimer (pending keeps one row per code).
 *   2. The apply loop skipped joins recorded in THIS pass whenever AUTO_ASSIGN=0,
 *      and the pending-file write condition said "nothing changed" — so claims were
 *      computed but NEVER persisted. Telegram users saw "Request saved", the office
 *      ran `roster.mjs pending --apply`, and found an EMPTY queue: exactly one
 *      salesman ever got in.
 *
 * Expected now: both new claims land in the pending file, survive the next pass,
 * and link when approved; hijack attempts are rejected at message time without
 * disturbing queued claims.
 *
 * Usage: AUTO_ASSIGN=0 node test/join-queue.test.mjs     # exit 0 = pass
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";

const ROOT = process.cwd(); // must run from the repo root
const TMP = path.join(ROOT, "test", ".tmp-queue");
const PASSPHRASE = "testpass1234";

let updateQueue = [];
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

const mkUpdate = (id, from, extraMsg = {}) => ({
  update_id: id,
  message: { message_id: id, date: Math.floor(Date.now() / 1000), from, chat: { id: from.id }, ...extraMsg },
});

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

async function main() {
  if (process.env.AUTO_ASSIGN !== "0") {
    console.error("This test simulates the manual-approval deployment: run it as AUTO_ASSIGN=0 node test/join-queue.test.mjs");
    process.exit(2);
  }

  const { encryptJson, decryptJson } = await import(path.join(ROOT, "scripts", "crypto.mjs"));

  // Production-like starting state: roster EXISTS, SM-001 already linked, others free.
  const roster = {
    salesmen: [
      { code: "SM-001", name: "Abebe K.", nameAm: "አበበ ከ.", tg: 111, username: "abebe_sm1", color: "#e11d48", active: true },
      { code: "SM-002", name: "Selam T.", nameAm: "ሰላም ተ.", tg: 0, username: "", color: "#2563eb", active: true },
      { code: "SM-003", name: "Dawit M.", nameAm: "ዳዊት ም.", tg: 0, username: "", color: "#059669", active: true },
    ],
  };

  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP, "archive"), { recursive: true });
  await fs.mkdir(path.join(TMP, "out"), { recursive: true });
  const rosterFile = path.join(TMP, "roster.enc.json");
  const pendingFile = path.join(TMP, "pending.enc.json");
  await fs.writeFile(rosterFile, JSON.stringify(encryptJson(roster, PASSPHRASE)));

  await server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  process.env.DASH_PASSPHRASE = PASSPHRASE;

  const mod = await import(path.join(ROOT, "scripts", "poll_telegram.mjs"));
  const overrides = { rosterFile, archiveDir: path.join(TMP, "archive"), outDir: path.join(TMP, "out"), token: "faketoken", passphrase: PASSPHRASE, apiBase };

  const readRoster = async () => decryptJson(JSON.parse(await fs.readFile(rosterFile, "utf8")), PASSPHRASE);
  const readPending = async () => {
    const box = await fs.readFile(pendingFile, "utf8").catch(() => null);
    return box ? decryptJson(JSON.parse(box), PASSPHRASE) : [];
  };

  // ---------- Pass 1: two new devices /join while SM-001 is already linked ----------
  console.log("\nPass 1: SM-002 and SM-003 send /join (queue mode, SM-001 already linked)");
  updateQueue = [[
    mkUpdate(1, people[0], { text: "/start" }),          // existing user pings the bot
    mkUpdate(2, people[1], { text: "/join SM-002" }),
    mkUpdate(3, people[2], { text: "/join SM-003" }),
  ]];
  await mod.runOnce(overrides);

  const pend1 = await readPending();
  const codes1 = pend1.map((p) => p.code).sort().join(",");
  check("BOTH claims persisted to the pending queue", codes1 === "SM-002,SM-003", `got "${codes1}"`);
  const r1 = await readRoster();
  check("queue mode: nothing auto-linked yet", Number(r1.salesmen.find((s) => s.code === "SM-002").tg) === 0);
  check("SM-001 untouched", Number(r1.salesmen.find((s) => s.code === "SM-001").tg) === 111);

  // ---------- Pass 2: replay of the same joins — must not duplicate or vanish ----------
  console.log("\nPass 2: replays arrive again (offset lag) — queue must stay exactly 2 claims");
  updateQueue = [[
    mkUpdate(2, people[1], { text: "/join SM-002" }),
    mkUpdate(3, people[2], { text: "/join SM-003" }),
  ]];
  await mod.runOnce(overrides);
  const pend2 = await readPending();
  check("still exactly 2 pending claims", pend2.length === 2, `got ${pend2.length}`);

  // ---------- Pass 3: office approves by linking SM-002 manually in the roster ----------
  // (mirrors `roster.mjs pending --apply`; we emulate the resulting roster edit)
  console.log("\nPass 3: office links SM-002 directly; SM-003's claim must survive");
  const r3 = await readRoster();
  r3.salesmen.find((s) => s.code === "SM-002").tg = 222;
  await fs.writeFile(rosterFile, JSON.stringify(encryptJson(r3, PASSPHRASE)));
  updateQueue = [[mkUpdate(10, people[2], { text: "/ping-nonsense" })]];
  await mod.runOnce(overrides);
  const pend3 = await readPending();
  check("SM-003 still waiting in the queue", pend3.some((p) => p.code === "SM-003" && String(p.tg) === "333"),
    `queue=${JSON.stringify(pend3)}`);

  // ---------- Pass 4: stranger tries to steal the linked SM-001 code ----------
  console.log("\nPass 4: stranger sends /join SM-001 — rejected WITHOUT touching SM-003's claim");
  sentMessages.length = 0;
  const stranger = { id: 999, first_name: "Stranger" };
  updateQueue = [[mkUpdate(20, stranger, { text: "/join SM-001" })]];
  await mod.runOnce(overrides);
  check("stranger told the code is claimed",
    sentMessages.some((m) => String(m.chat_id) === "999" && /already claimed/i.test(m.text || "")));
  const pend4 = await readPending();
  check("SM-003's queued claim NOT clobbered by the stranger",
    pend4.some((p) => p.code === "SM-003" && String(p.tg) === "333"), `queue=${JSON.stringify(pend4)}`);
  check("stranger did not sneak into the queue under any code",
    !pend4.some((p) => String(p.tg) === "999"));
  const r4 = await readRoster();
  check("SM-001 link unchanged", Number(r4.salesmen.find((s) => s.code === "SM-001").tg) === 111);

  server.close();
  await once(server, "close");
  await fs.rm(TMP, { recursive: true, force: true });

  console.log(failures ? `\nFAILED: ${failures} check(s)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
