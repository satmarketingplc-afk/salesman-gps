#!/usr/bin/env node
/**
 * Salesman GPS — Telegram live-location poller.
 * 100 % GitHub: no server, no database. The archive lives in the repo, encrypted.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN   bot token from BotFather                 (required)
 *   DASH_PASSPHRASE      passphrase for archive + dashboard       (required, 8+ chars)
 *   ARCHIVE_DIR          encrypted archive dir    (default ./archive)
 *   ROSTER_FILE          encrypted roster         (default ./private/roster.enc.json)
 *   OUT_DIR              dashboard payload dir    (default ./dashboard/public)
 *   BUILD_REPORTS        set to 1 to rebuild the daily activity report on that pass
 *   AUTO_ASSIGN          1 (default): self-service Telegram id pairing — a person sends
 *                        /join CODE and is mapped automatically, no CLI needed.
 *                        Set to 0 to keep the roster strictly manual.
 *   JOIN_SECRET          optional extra word required in /join CODE SECRET
 */

import fs from "node:fs/promises";
import path from "node:path";
import { encryptJson, decryptJson } from "./crypto.mjs";
import { buildReports } from "./report.mjs";

const ROOT = process.cwd();
let ARCHIVE = path.resolve(ROOT, process.env.ARCHIVE_DIR || "archive");
let ROSTER_FILE = path.resolve(ROOT, process.env.ROSTER_FILE || "private/roster.enc.json");
let OUT_DIR = path.resolve(ROOT, process.env.OUT_DIR || "dashboard/public");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PASS = () => process.env.DASH_PASSPHRASE || "";

const EAT_MS = 3 * 3600 * 1000;
const ONLINE_MS = Number(process.env.ONLINE_MS || 10 * 60 * 1000);
const TRAIL_POINTS = 3000;
// Dedupe is by EXACT timestamp (see the day-file write below): replayed updates carry the
// same ts and are dropped, while every distinct point — including out-of-order replays of
// older pings — lands in the archive. The old distance-based rule froze stationary trails;
// the intermediate time-window rule then silently dropped legitimate out-of-order points.
const API = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
const AUTO_ASSIGN = process.env.AUTO_ASSIGN !== "0";
const JOIN_SECRET = (process.env.JOIN_SECRET || "").trim();
const CUSTOMER_URL =
  process.env.CUSTOMER_URL || "https://satmarketingplc-afk.github.io/salesman-gps/app/customer/";

let errorCount = 0; // corrupt day files etc. — surfaced in the summary line
let rosterByTg = new Map(); // set by main(): tg id -> salesman, used by /join replies

// CLI guard: importing this module for tests/diagnostics must never kill the process.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  if (!TOKEN) fail("TELEGRAM_BOT_TOKEN is not set");
  if (PASS().length < 8) fail("DASH_PASSPHRASE must be at least 8 characters");
}

function fail(msg) {
  console.error(`[poller] ${msg}`);
  process.exit(1);
}

async function tg(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN || TOKEN;
  const apiBase = process.env.TELEGRAM_API_BASE || API;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${apiBase}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.json().catch(() => ({}));
      if (body.ok) return true;
      // 429 too-many-requests: wait out retry_after, then retry once
      const ra = body.parameters?.retry_after;
      if (res.status === 429 && Number.isFinite(ra) && attempt === 0) {
        console.warn(`[poller] ${method}: 429, backing off ${ra}s`);
        await new Promise((r) => setTimeout(r, Math.min(Number(ra), 30) * 1000));
        continue;
      }
      console.warn(`[poller] ${method}: ${body.description || res.status}`);
      return false;
    } catch (err) {
      console.warn(`[poller] ${method}: ${err.message}`);
      return false;
    }
  }
  return false;
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));

const STAGE_LABEL = {
  lead: "New lead · አዲስ",
  quote: "Quoted · ዋጋ ተሰጥቷል",
  won: "Won · ተሸጠ",
  lost: "Lost · አልተሸጠም",
};

function welcomeText() {
  return [
    "👋 <b>Salesman GPS</b>",
    "1 · Share live location: 📎 → Location → <b>Share Live Location</b> → 8 hours.",
    "2 · New customer: tap the button below (or the menu button).",
    "────────",
    "1 · ቀጥታ አካባቢ ያጋሩ: 📎 → አካባቢ → <b>ቀጥታ አካባቢ</b> → 8 ሰዓት።",
    "2 · አዲስ ደንበኛ: ከታች ያለውን ቁልፍ ይጫኑ።",
  ].join("\n");
}

const welcomeKeyboard = {
  inline_keyboard: [
    [{ text: "🧾 New customer · አዲስ ደንበኛ", web_app: { url: CUSTOMER_URL } }],
  ],
};

// ---- self-service id pairing ---------------------------------------------
// The roster is encrypted, so the bot cannot write it from Telegram directly.
// Instead /join CODE records a pending claim in private/pending.enc.json; the
// office approves it by committing (or applying) that file — no manual typing
// of numeric ids, and the passphrase never leaves the server/workflow.
const PENDING_FILE = path.join(path.dirname(ROSTER_FILE), "pending.enc.json");
const joinText = () =>
  [
    "🔗 <b>Link your account · ታገናኙ</b>",
    "Send the office manager your name, then type:",
    "<code>/join SM-001</code>",
    "(the code looks like <code>SM-001</code> and comes from the office)",
    "────────",
    "ስምዎን ለሥራ አስኪያጁ ይላኩ፣ ከዚያ ይጻፉ፦ <code>/join SM-001</code>",
  ].join("\n");

async function recordJoin(pending, from, codeRaw) {
  const code = String(codeRaw || "").trim().toUpperCase().replace(/^#/, "");
  const tgId = String(from.id);
  if (!/^[A-Z0-9][A-Z0-9_-]{0,15}$/.test(code)) {
    await tg("sendMessage", {
      chat_id: from.id,
      text: `❌ Unknown code. Use e.g. <code>/join SM-001</code>\n❌ የተሳሳተ ኮድ። ለምሳሌ <code>/join SM-001</code> ይጠቀሙ`,
      parse_mode: "HTML",
    });
    return false;
  }
  if (rosterByTg.has(tgId)) {
    const mine = rosterByTg.get(tgId);
    await tg("sendMessage", {
      chat_id: from.id,
      text: `✅ Already linked as <b>${esc(mine?.code || "")} ${esc(mine?.name || "")}</b>. Just share your live location.\n✅ ተያይዘዋል። ቀጥታ አካባቢዎን ያጋሩ።`,
      parse_mode: "HTML",
    });
    return false;
  }
  const dup = pending.find((p) => p.code === code && String(p.tg) !== tgId);
  if (dup) {
    await tg("sendMessage", {
      chat_id: from.id,
      text: `⚠️ Code <b>${esc(code)}</b> is already claimed by someone else. Ask the office for your own code.\n⚠️ ይህ ኮድ ለላ ሰው ተይዟል። ለቢሮው ይጠይቁ።`,
      parse_mode: "HTML",
    });
    return false;
  }
  const entry = {
    code,
    tg: tgId,
    who: [from.first_name, from.last_name].filter(Boolean).join(" ") || null,
    username: from.username || null,
    ts: new Date().toISOString(),
  };
  const i = pending.findIndex((p) => p.code === code || String(p.tg) === tgId);
  if (i >= 0) pending[i] = entry;
  else pending.push(entry);
  await tg("sendMessage", {
    chat_id: from.id,
    text:
      `📝 Request saved: <b>${esc(entry.who || "?")}</b> → <b>${esc(code)}</b>\n` +
      `The office approves it on the next sync — after that, share your live location.\n` +
      `────────\n📝 ጥያቄው ተቀምጧል፦ <b>${esc(entry.who || "?")}</b> → <b>${esc(code)}</b>\n` +
      `ቢሮው በሚቀጥለው ማመሳሰል ያጸድቀዋል፤ ከዚያ ቀጥታ አካባቢዎን ያጋሩ።`,
    parse_mode: "HTML",
  });
  return true;
}

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
};

const dayKey = (iso) => new Date(Date.parse(iso) + EAT_MS).toISOString().slice(0, 10);

const haversine = (a, b) => {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

const dayFile = (code, day) => path.join(ARCHIVE, "daily", day, `${code}.enc.json`);

const loadDay = async (code, day) => {
  const ck = `${code}|${day}`;
  if (dayCacheEnabled && dayCache.has(ck)) return dayCache.get(ck);
  const file = dayFile(code, day);
  const box = await readJson(file, null);
  let pings = [];
  if (box) {
    try {
      const dec = decryptJson(box, PASS());
      pings = Array.isArray(dec) ? dec : [];
    } catch (err) {
      // Quarantine the corrupt file instead of killing the whole pass: one bad day
      // (wrong passphrase rotation, truncated commit) must not freeze every pin.
      errorCount++;
      try {
        await fs.rename(file, file + ".corrupt-" + new Date().toISOString().slice(0, 10));
        console.error(`[poller] quarantined ${file}: ${err.message}`);
      } catch {
        console.error(`[poller] cannot decrypt ${file}: ${err.message}`);
      }
      // a corrupt file is NOT cached — the quarantine rename must be re-attempted cleanly
      return [];
    }
  }
  if (dayCacheEnabled) dayCache.set(ck, pings);
  return pings;
};

const saveDay = async (code, day, pings) => {
  await writeJson(dayFile(code, day), encryptJson(pings, PASS()));
  if (dayCacheEnabled) dayCache.set(`${code}|${day}`, pings);
};

// ---- customer cards -------------------------------------------------------
// Salesmen file these from the Telegram Mini App (or the #CUST text fallback).
// One encrypted file per month is the archive; customers.enc.json is the rolling
// view the passphrase-gated Customers page reads.
const custFile = (month) => path.join(ARCHIVE, "customers", `${month}.enc.json`);
const monthKey = (iso) => new Date(Date.parse(iso) + EAT_MS).toISOString().slice(0, 7);
const CUSTOMER_STAGES = ["lead", "quote", "won", "lost"];

const clip = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);

function customerCard(msg) {
  if (!msg) return null;
  if (msg.web_app_data?.data) {
    try {
      return JSON.parse(msg.web_app_data.data);
    } catch {
      return null;
    }
  }
  const text = msg.text || msg.caption || "";
  if (!text.startsWith("#CUST ")) return null;
  try {
    return JSON.parse(text.slice(6));
  } catch {
    return null;
  }
}

function normalizeCustomer(c, msg, sm, from) {
  const name = clip(c.name, 80);
  if (!name) return null;
  const lat = Number(c.lat);
  const lng = Number(c.lng);
  const qty = Number(c.qty);
  return {
    id: clip(c.id, 40) || `${from.id}-${msg.message_id}`,
    ts: new Date((msg.edit_date || msg.date) * 1000).toISOString(),
    by: sm.code,
    byName: sm.name,
    byColor: sm.color || "",
    name,
    phone: clip(c.phone, 32),
    biz: clip(c.biz, 60),
    product: clip(c.product, 40),
    qty: Number.isFinite(qty) && qty > 0 ? qty : null,
    stage: CUSTOMER_STAGES.includes(c.stage) ? c.stage : "lead",
    lat: Number.isFinite(lat) ? Number(lat.toFixed(6)) : null,
    lng: Number.isFinite(lng) ? Number(lng.toFixed(6)) : null,
    note: clip(c.note, 300),
    tg: String(from.id),
  };
}

async function loadRoster() {
  const box = await readJson(ROSTER_FILE, null);
  if (box) {
    try {
      return decryptJson(box, PASS());
    } catch {
      fail("cannot decrypt roster — DASH_PASSPHRASE does not match the one used to create it");
    }
  }
  const template = await readJson(path.join(ROOT, "data", "salesmen.json"), { salesmen: [] });
  console.warn("[poller] no encrypted roster yet — using the public template (no real telegram ids)");
  return template;
}

// Exported for tests and the self-diagnosis script (scripts/diagnose.mjs) so the
// whole pipeline can be exercised with a mocked Telegram API — no real bot needed.
export { encryptJson, decryptJson };
// Exposed for diagnose.mjs: read-only tooling must never let the pass cache outlive a call.
export function setDayCache(enabled) {
  dayCacheEnabled = !!enabled;
  if (!dayCacheEnabled) dayCache.clear();
}
export async function runOnce(overrides = {}) {
  if (overrides.rosterFile) ROSTER_FILE = overrides.rosterFile;
  if (overrides.archiveDir) ARCHIVE = path.resolve(ROOT, overrides.archiveDir);
  if (overrides.outDir) OUT_DIR = path.resolve(ROOT, overrides.outDir);
  if (overrides.token !== undefined) process.env.TELEGRAM_BOT_TOKEN = overrides.token;
  if (overrides.passphrase) process.env.DASH_PASSPHRASE = overrides.passphrase;
  if (overrides.apiBase) process.env.TELEGRAM_API_BASE = overrides.apiBase;
  await main();
}

// ---- day-file read cache ---------------------------------------------------
// One pass touches the same day files many times: every incoming ping of a salesman
// re-reads their day file, and the live-payload build at the end reads today+yesterday
// for every person again. Each read is a file open + JSON parse + AES-GCM decrypt (the
// PBKDF2 key itself is cached in crypto.mjs). Cache decrypted pings per pass; saveDay
// refreshes the entry so writes never go stale. The process exits after each pass, so
// the cache can never serve data across a concurrent git merge.
let dayCacheEnabled = true;
const dayCache = new Map(); // "code|day" -> Array<ping>

async function main() {
  dayCacheEnabled = true;
  dayCache.clear();
  const roster = await loadRoster();
  const byTg = new Map();
  const byUser = new Map();
  for (const sm of roster.salesmen || []) {
    if (sm.tg) byTg.set(String(sm.tg), sm);
    if (sm.username) byUser.set(String(sm.username).toLowerCase().replace(/^@/, ""), sm);
  }
  // exposed to recordJoin so /join can answer "already linked" instantly
  rosterByTg = byTg;

  // pending self-service claims: applied automatically when AUTO_ASSIGN=1,
  // otherwise kept as a queue the office reviews with `roster.mjs pending`
  let pending = [];
  {
    const box = await readJson(PENDING_FILE, null);
    if (box) {
      try {
        pending = decryptJson(box, PASS());
        if (!Array.isArray(pending)) pending = [];
      } catch {
        errorCount++;
        console.error(`[poller] cannot decrypt ${PENDING_FILE} — ignoring pending claims`);
      }
    }
  }
  let pendingDirty = false;
  const stateFile = path.join(ARCHIVE, "state", "offset.json");
  const state = await readJson(stateFile, { offset: 0 });

  // one welcome per person per hour: the offset is committed hourly, so a fresh run
  // replays the same updates and must not answer them again
  const repliesFile = path.join(ARCHIVE, "state", "replies.json");
  const replies = await readJson(repliesFile, {});
  let repliesDirty = false;
  let replied = 0;
  const canReply = (id) => Date.now() - Date.parse(replies[id] || 0) > 60 * 60 * 1000;

  // Drain up to 5 batches of 100 per pass. The offset is only committed together with the
  // archive (once an hour), so a fresh run must be able to catch up on an hour of updates
  // without falling behind.
  const updates = [];
  let cursor = state.offset;
  for (let batch = 0; batch < 5; batch++) {
    const url = new URL(`${process.env.TELEGRAM_API_BASE || "https://api.telegram.org"}/bot${process.env.TELEGRAM_BOT_TOKEN || TOKEN}/getUpdates`);
    url.searchParams.set("timeout", "0");
    url.searchParams.set("allowed_updates", JSON.stringify(["message", "edited_message"]));
    if (cursor) url.searchParams.set("offset", String(cursor));

    const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
    const body = await res.json().catch(() => ({}));
    // A webhook was set once (or a second poller is running): getUpdates answers 409 and
    // will do so forever — every pass would die before storing anything. Delete the hook
    // and retry this batch instead of failing the whole run.
    if (!body.ok && /conflicted|terminated by new webhook/i.test(body.description || "")) {
      console.warn("[poller] telegram conflict — deleting webhook and retrying");
      await tg("deleteWebhook", { drop_pending_updates: false });
      continue;
    }
    if (!body.ok) fail(`telegram: ${body.description || res.status}`);

    const chunk = body.result || [];
    updates.push(...chunk);
    if (chunk.length) cursor = chunk[chunk.length - 1].update_id + 1;
    if (chunk.length < 100) break;
  }

  let nextOffset = cursor;
  let stored = 0;
  let skipped = 0;
  const dirty = new Set();
  // quarantined corrupt entries are kept so a bad file never crashes the pass
  const unmappedRaw = (await readJson(path.join(ARCHIVE, "unmapped.enc.json"), null)) || [];
  const unmapped = Array.isArray(unmappedRaw) ? unmappedRaw : [];
  if (!Array.isArray(unmappedRaw) && Object.keys(unmappedRaw).length) {
    for (const [k, v] of Object.entries(unmappedRaw)) {
      if (Array.isArray(v)) unmapped.push(...v.map((x) => ({ ...x, _from: k })));
      else if (v && typeof v === "object") unmapped.push({ ...v, _from: k });
    }
  }

  const custMonths = new Map(); // month -> { list, ids:Set }, loaded lazily
  const newCustomers = [];

  for (const u of updates) {
    nextOffset = Math.max(nextOffset, u.update_id + 1);
    const msg = u.edited_message || u.message;
    const from = msg?.from || {};
    const sm =
      byTg.get(String(from.id)) ||
      (from.username ? byUser.get(String(from.username).toLowerCase()) : undefined);

    // ---- /start and /help: tell people what the bot is for ----
    const cmd = (msg?.text || "").trim();
    if (/^\/(start|help)(@\w+)?(\s|$)/.test(cmd)) {
      const id = String(from.id);
      if (canReply(id)) {
        replies[id] = new Date().toISOString();
        repliesDirty = true;
        replied++;
        if (sm) {
          await tg("sendMessage", {
            chat_id: from.id,
            text: welcomeText(),
            parse_mode: "HTML",
            reply_markup: welcomeKeyboard,
          });
        } else {
          await tg("sendMessage", {
            chat_id: from.id,
            text:
              `You are not registered yet.\n` +
              `${AUTO_ASSIGN ? "Type <code>/join SM-001</code> with the code from the office — it links you automatically." : `Send this number to the office: <code>${id}</code>`}\n` +
              joinText().split("\n").slice(4).join("\n") +
              `\n────────\nእስካሁን አልተመዘገቡም።\n` +
              (AUTO_ASSIGN
                ? "የቢሮውን ኮድ ይላኩ፦ <code>/join SM-001</code> — በራስ-ሰር ይያያዛሉ።"
                : `ይህን ቁጥር ለቢሮው ይላኩ፡ <code>${id}</code>`),
            parse_mode: "HTML",
          });
        }
      }
      skipped++;
      continue;
    }

    // ---- /join CODE: self-service telegram-id pairing (no CLI, no AI) ----
    const joinMatch = /^\/join(?:@\w+)?\s+(\S+)/i.exec(cmd);
    if (joinMatch) {
      if (!AUTO_ASSIGN) {
        await tg("sendMessage", {
          chat_id: from.id,
          text: "Self-registration is disabled here — send the office your id: " + String(from.id),
        });
      } else if (JOIN_SECRET) {
        const secret = /^\/join(?:@\w+)?\s+\S+\s+(\S+)/i.exec(cmd)?.[1] || "";
        if (secret.trim() !== JOIN_SECRET) {
          await tg("sendMessage", {
            chat_id: from.id,
            text: "❌ Wrong join secret · ❌ የተሳሳተ ሚስጥራዊ ቃል",
          });
        } else if (await recordJoin(pending, from, joinMatch[1])) pendingDirty = true;
      } else if (await recordJoin(pending, from, joinMatch[1])) pendingDirty = true;
      skipped++;
      continue;
    }

    // ---- customer card: Telegram Mini App payload or the #CUST text fallback ----
    const card = customerCard(msg);
    if (card) {
      if (!sm) {
        skipped++;
        continue;
      }
      const entry = normalizeCustomer(card, msg, sm, from);
      if (!entry) {
        skipped++;
        continue;
      }
      const month = monthKey(entry.ts);
      if (!custMonths.has(month)) {
        const file = custFile(month);
        const box = await readJson(file, null);
        let list = [];
        if (box) {
          try {
            list = decryptJson(box, PASS());
          } catch {
            fail(`cannot decrypt ${file} — wrong DASH_PASSPHRASE?`);
          }
        }
        // id Set for O(1) duplicate checks (edit replays arrive every pass)
        custMonths.set(month, { list, ids: new Set(list.map((c) => c.id)) });
      }
      const bucket = custMonths.get(month);
      if (bucket.ids.has(entry.id)) {
        skipped++;
        continue;
      }
      bucket.list.push(entry);
      bucket.ids.add(entry.id);
      newCustomers.push(entry);
      stored++;
      replied++;
      await tg("sendMessage", {
        chat_id: from.id,
        text:
          `✅ <b>${esc(entry.name)}</b> — ${STAGE_LABEL[entry.stage]}\n` +
          (entry.lat != null ? "📍 location attached · አካባቢ ተያዘ" : "no GPS · አካባቢ የለም") +
          `\nSaved to the office archive · ተቀምጧል`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "🧾 Another · ሌላ", web_app: { url: CUSTOMER_URL } }]] },
      });
      continue;
    }

    const loc = msg && msg.location;
    if (!loc) continue;

    const ts = new Date((msg.edit_date || msg.date) * 1000).toISOString();
    const ping = {
      ts,
      lat: Number(loc.latitude.toFixed(6)),
      lng: Number(loc.longitude.toFixed(6)),
      acc: loc.horizontal_accuracy ?? null,
      hdg: loc.heading ?? null,
      live: !!loc.live_period,
      src: "telegram",
    };

    if (!sm) {
      // stable key tg+ts: replayed updates (offset committed only hourly) must not
      // pile up duplicates in the unmapped file
      const key = `${from.id}|${ping.ts}`;
      if (!unmapped.some((x) => `${x.tg}|${x.ts}` === key)) {
        unmapped.push({
          ...ping,
          tg: String(from.id),
          who: from.first_name || null,
          username: from.username || null,
        });
      }
      skipped++;
      continue;
    }

    const day = dayKey(ts);
    const pings = await loadDay(sm.code, day);
    // Exact-timestamp dedupe: Telegram re-sends the same live-session update until the
    // offset advances (the offset only lands in git hourly), and every replay carries the
    // SAME ts. Anything whose exact ts is already archived is a duplicate — drop it.
    // The old "newer than the LAST point by MIN_INTERVAL_S" rule silently discarded
    // legitimate out-of-order replays older than the newest point (e.g. a burst of missed
    // updates arriving after a connectivity gap), permanently losing archive data.
    // Day files are kept sorted, so a Set gives O(1) dedupe instead of scanning every
    // stored ping for each incoming update.
    if (!pings.tsSet) {
      Object.defineProperty(pings, "tsSet", {
        value: new Set(pings.map((x) => x.ts)),
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
    if (pings.tsSet.has(ping.ts)) {
      skipped++;
      continue;
    }

    // keep the day file sorted by ts: out-of-order arrivals are inserted in place, so
    // `last` (the newest point) and the trail/distance walks below stay correct
    let at = pings.length;
    while (at > 0 && Date.parse(pings[at - 1].ts) > Date.parse(ping.ts)) at--;
    pings.splice(at, 0, ping);
    pings.tsSet.add(ping.ts);
    await saveDay(sm.code, day, pings);
    dirty.add(sm.code);
    stored++;
  }

  // persist the month files once per pass, then refresh the rolling view the page reads
  for (const { list } of custMonths.values()) {
    list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  }
  for (const [month, { list }] of custMonths) {
    await writeJson(custFile(month), encryptJson(list, PASS()));
  }

  if (newCustomers.length) {
    const file = path.join(OUT_DIR, "customers.enc.json");
    const box = await readJson(file, null);
    let view = { generated: null, entries: [] };
    if (box) {
      try {
        view = decryptJson(box, PASS());
      } catch {
        // unreadable payload: the month files stay the source of truth, rebuild from this batch
      }
    }
    const known = new Set((view.entries || []).map((c) => c.id));
    const fresh = newCustomers.filter((c) => !known.has(c.id)).reverse();
    view = {
      generated: new Date().toISOString(),
      // the whole team rides along so the management board can show everyone at once,
      // including salesmen with zero cards
      team: (roster.salesmen || [])
        .filter((s) => s.active !== false)
        .map((s) => ({ code: s.code, name: s.name, nameAm: s.nameAm || s.name, color: s.color || "" })),
      entries: [...fresh, ...(view.entries || [])].slice(0, 1000),
    };
    await writeJson(file, encryptJson(view, PASS()));
  }

  if (unmapped.length) {
    await writeJson(path.join(ARCHIVE, "unmapped.enc.json"), encryptJson(unmapped.slice(-500), PASS()));
  }

  // ---- apply self-service /join claims ------------------------------------
  // AUTO_ASSIGN=1 (default): a pending claim is written straight into the roster
  // and takes effect immediately — no CLI step, no AI. The roster file lands in
  // git together with the archive, so the encrypted mapping stays the source of
  // truth. With AUTO_ASSIGN=0 the queue waits for `roster.mjs pending --apply`.
  let joined = 0;
  const stillPending = [];
  const appliedClaims = [];
  // O(1) code lookup instead of scanning the roster once per pending claim
  const byCode = new Map((roster.salesmen || []).map((s) => [s.code, s]));
  for (const p of pending || []) {
    if (!p?.code || !p?.tg) continue;
    if (byTg.has(String(p.tg))) continue; // already linked meanwhile
    const sm = byCode.get(p.code);
    if (!sm || !AUTO_ASSIGN) {
      // keep unknown codes in the queue (typo can be fixed by re-sending /join),
      // drop claims older than 30 days so the file cannot grow forever
      if (!p.ts || Date.now() - Date.parse(p.ts) < 30 * 86400000) stillPending.push(p);
      continue;
    }
    sm.tg = Number(p.tg);
    if (p.username && !sm.username) sm.username = p.username;
    byTg.set(String(sm.tg), sm);
    dirty.add(sm.code);
    joined++;
    appliedClaims.push(p);
    // Tell the salesman the office verified him and ask for the location NOW —
    // otherwise a newly linked person has no idea that the map is waiting for him.
    await tg("sendMessage", {
      chat_id: Number(p.tg),
      text:
        `✅ <b>Verified by the office</b> — you are linked as <b>${esc(sm.code)} ${esc(sm.name || "")}</b>.\n` +
        `Now send your location: 📎 → <b>Location</b> → <b>Share Live Location</b> → <b>8 hours</b>.\n` +
        `Your pin appears on the manager's map within ~4 minutes.\n` +
        `────────\n` +
        `✅ <b>በቢሮው ተረጋግጠዋል</b> — <b>${esc(sm.code)} ${esc(sm.nameAm || sm.name || "")}</b> ተያይዘዋል።\n` +
        `አሁን አካባቢዎን ይላኩ፦ 📎 → <b>Location</b> → <b>Share Live Location</b> → <b>8 ሰዓት</b>።\n` +
        `በካርታው ላይ በ~4 ደቂቃ ውስጥ ይታያሉ።`,
      parse_mode: "HTML",
    });
  }

  // ---- recover locations sent BEFORE the link ------------------------------
  // The classic "I added them but they are not on the map" case: a salesman shared
  // live location while still unmapped, so every point went to unmapped.enc.json.
  // After /join links them, those points used to stay invisible until the NEXT share.
  // Now we move matching unmapped points into their day files immediately, so the
  // pin and trail appear on this very pass — zero manual steps.
  // Recovery also runs for salesmen linked EARLIER passes (roster ids, manual edits):
  // the poller only sees updates newer than its committed offset, so pre-link pings
  // that arrived before someone was mapped would otherwise sit in the unmapped pile
  // forever even though the person is now visible-worthy.
  const recoveryTgIds = new Map(appliedClaims.map((p) => [String(p.tg), p.code]));
  for (const sm of roster.salesmen || []) {
    if (sm.tg) recoveryTgIds.set(String(sm.tg), sm.code);
  }
  if (!appliedClaims.length && recoveryTgIds.size && unmapped.length) {
    // no fresh claims this pass, but old unmapped records may match existing links
    for (const rec of unmapped) {
      const code = recoveryTgIds.get(String(rec.tg)); // O(1): was a full roster scan per record
      if (code) appliedClaims.push({ tg: String(rec.tg), code });
    }
  }
  if (appliedClaims.length && unmapped.length) {
    const recoveredByCode = new Map(); // code -> [ping,...]
    const keptUnmapped = [];
    // one claim lookup per unmapped tg id instead of a linear find() per record
    const claimByTg = new Map(appliedClaims.map((p) => [String(p.tg), p]));
    for (const rec of unmapped) {
      const claim = claimByTg.get(String(rec.tg));
      if (!claim) {
        keptUnmapped.push(rec);
        continue;
      }
      const ping = {
        ts: rec.ts, lat: rec.lat, lng: rec.lng,
        acc: rec.acc ?? null, hdg: rec.hdg ?? null,
        live: !!rec.live, src: "telegram",
      };
      if (!Number.isFinite(ping.lat) || !Number.isFinite(ping.lng) || !ping.ts) {
        keptUnmapped.push(rec); // malformed record: leave it for the office to inspect
        continue;
      }
      const list = recoveredByCode.get(claim.code) || [];
      list.push(ping);
      recoveredByCode.set(claim.code, list);
    }
    if (recoveredByCode.size) {
      for (const [code, pts] of recoveredByCode) {
        pts.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
        const days = new Set(pts.map((p) => dayKey(p.ts)));
        for (const day of days) {
          const existing = await loadDay(code, day);
          const have = new Set(existing.map((p) => p.ts));
          const add = pts.filter((p) => dayKey(p.ts) === day && !have.has(p.ts));
          if (!add.length) continue;
          await saveDay(code, day, [...existing, ...add]);
        }
        dirty.add(code);
        stored += pts.length;
      }
      unmapped.length = 0;
      unmapped.push(...keptUnmapped);
      console.log(`[poller] recovered ${[...recoveredByCode.values()].flat().length} pre-link location(s) for ${recoveredByCode.size} newly linked salesman — visible on the map now`);
    }
  }
  if (joined || stillPending.length !== (pending || []).length) {
    await writeJson(PENDING_FILE, encryptJson(stillPending, PASS()));
    if (joined) {
      await writeJson(ROSTER_FILE, encryptJson(roster, PASS()));
      console.log(`[poller] auto-linked ${joined} salesman via /join`);
    }
  } else if (pendingDirty) {
    await writeJson(PENDING_FILE, encryptJson(pending, PASS()));
  }

  // ---- encrypted live payload for the public dashboard ----
  // From here on the pass only reads day files — it never writes them again. Reads are
  // served from the per-pass cache (see loadDay), and the cache must not be mutated any
  // more, so disable it: any hypothetical later write falls back to a clean disk read.
  dayCacheEnabled = false;
  const now = Date.now();
  const live = [];
  let noTg = 0, noPoints = 0;
  // dayKey(now) is UTC-based: in EAT (UTC+3) early morning hours roll over to the
  // previous UTC day, so also check that file — otherwise a salesman who joined at
  // 08:00 EAT would not appear on the map until 03:00 UTC.
  const todayKeys = [dayKey(new Date(now).toISOString())];
  const yest = new Date(now - 86400000);
  if (!todayKeys.includes(dayKey(yest.toISOString()))) todayKeys.push(dayKey(yest.toISOString()));
  for (const sm of roster.salesmen || []) {
    if (sm.active === false) continue;
    if (!sm.tg) { noTg++; console.warn(`[poller] ${sm.code} (${sm.name}) has NO telegram id linked — send /join ${sm.code} to the bot`); continue; }
    let pings = [];
    for (const day of todayKeys) {
      const part = await loadDay(sm.code, day);
      if (part.length) { pings = [...pings, ...part]; }
    }
    // todayKeys is 1–2 sorted days: concatenating them is already ordered, so skip the
    // full sort unless the payload actually arrives out of order (rare, but harmless)
    if (pings.length > 1 && Date.parse(pings[0].ts) > Date.parse(pings[pings.length - 1].ts)) {
      pings.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    }
    if (!pings.length) { noPoints++; console.warn(`[poller] ${sm.code} (${sm.name}) has no location points today — not on the map until they Share live location`); continue; }
    // whole day, so the line on the map matches the distance the card reports;
    // decimated to ~400 points: enough for the shape, small enough to commit every 2 min
    const raw = pings.slice(-TRAIL_POINTS);
    const step = Math.ceil(raw.length / 400);
    const trail = step > 1 ? raw.filter((_, i) => i % step === 0 || i === raw.length - 1) : raw;
    const last = pings[pings.length - 1];

    // full-day distance, ignoring GPS jumps over 500 m between two pings.
    // No trig when the bounding box proves the points are ~metres apart — the common
    // case for stationary or slow pings (GPS jitter sits well inside this fast path).
    const DEG = Math.PI / 180;
    const cosLat = (lat) => 0.99985 + 0.00015 * Math.cos(lat * DEG); // fast, ±0.02 % vs exact haversine
    let meters = 0;
    let prev = pings[0];
    for (let i = 1; i < pings.length; i++) {
      const cur = pings[i];
      const dLat = (cur.lat - prev.lat) * 111195;               // metres per degree latitude
      const dLng = (cur.lng - prev.lng) * 111320 * cosLat(prev.lat);
      let step;
      if (dLat * dLat + dLng * dLng < 250000) {                 // within ~500 m: flat-earth is exact enough
        step = Math.hypot(dLat, dLng);
      } else {
        step = haversine([prev.lat, prev.lng], [cur.lat, cur.lng]);
      }
      if (step < 500) meters += step;
      prev = cur;
    }

    live.push({
      code: sm.code,
      name: sm.name,
      nameAm: sm.nameAm || sm.name,
      color: sm.color || "#2563eb",
      lat: last.lat,
      lng: last.lng,
      acc: last.acc,
      ts: last.ts,
      online: now - Date.parse(last.ts) <= ONLINE_MS,
      live: !!last.live,
      distKm: Math.round((meters / 1000) * 10) / 10,
      points: pings.length,
      trail: trail.map((p) => [p.lat, p.lng]),
    });
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await writeJson(path.join(OUT_DIR, "live.enc.json"), encryptJson({ generated: new Date().toISOString(), salesmen: live }, PASS()));

  // Daily activity rollup for the Reports page. Only built on the passes that commit the
  // archive (once an hour), so the extra PBKDF2 work is rare.
  let builtReports = false;
  if (process.env.BUILD_REPORTS === "1") {
    const reports = await buildReports({
      archiveDir: ARCHIVE,
      roster,
      passphrase: PASS(),
      days: Number(process.env.REPORT_DAYS || 7),
      now,
    });
    await writeJson(path.join(OUT_DIR, "reports.enc.json"), encryptJson(reports, PASS()));
    builtReports = true;
  }

  // offset only lands in git together with the archive (see the workflow): if a run dies
  // before that, the next run re-reads those updates and the dedupe drops the repeats.
  const nextState = { ...state, offset: nextOffset, lastRun: new Date().toISOString() };
  if (builtReports) nextState.lastArchive = new Date().toISOString();
  await writeJson(stateFile, nextState);

  if (repliesDirty) {
    const cutoff = Date.now() - 7 * 86400000;
    for (const [k, v] of Object.entries(replies)) if (Date.parse(v) < cutoff) delete replies[k];
    await writeJson(repliesFile, replies);
  }

  console.log(
    `[poller] updates=${updates.length} stored=${stored} skipped=${skipped} ` +
      `cards=${newCustomers.length} replied=${replied} people=${live.length} ` +
      `joined=${joined} errors=${errorCount} dirty=${[...dirty].join(",") || "-"} offset=${nextOffset}`
  );
  if (noTg || noPoints) {
    console.log(`[poller] not on map: ${noTg} salesman without telegram id (/join CODE), ${noPoints} linked but no location today`);
  }
}

// run only when executed as a CLI (scripts/poll_telegram.mjs), not when imported
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => fail(err.stack || String(err)));
}
