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
 */

import fs from "node:fs/promises";
import path from "node:path";
import { encryptJson, decryptJson } from "./crypto.mjs";
import { buildReports } from "./report.mjs";

const ROOT = process.cwd();
const ARCHIVE = path.resolve(ROOT, process.env.ARCHIVE_DIR || "archive");
const ROSTER_FILE = path.resolve(ROOT, process.env.ROSTER_FILE || "private/roster.enc.json");
const OUT_DIR = path.resolve(ROOT, process.env.OUT_DIR || "dashboard/public");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PASS = process.env.DASH_PASSPHRASE || "";

const EAT_MS = 3 * 3600 * 1000;
const ONLINE_MS = Number(process.env.ONLINE_MS || 10 * 60 * 1000);
const TRAIL_POINTS = 3000;
const MIN_MOVE_M = 8;

if (!TOKEN) fail("TELEGRAM_BOT_TOKEN is not set");
if (PASS.length < 8) fail("DASH_PASSPHRASE must be at least 8 characters");

function fail(msg) {
  console.error(`[poller] ${msg}`);
  process.exit(1);
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
  const box = await readJson(dayFile(code, day), null);
  if (!box) return [];
  try {
    return decryptJson(box, PASS);
  } catch {
    fail(`cannot decrypt ${dayFile(code, day)} — wrong DASH_PASSPHRASE?`);
  }
};

const saveDay = async (code, day, pings) => {
  await writeJson(dayFile(code, day), encryptJson(pings, PASS));
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
      return decryptJson(box, PASS);
    } catch {
      fail("cannot decrypt roster — DASH_PASSPHRASE does not match the one used to create it");
    }
  }
  const template = await readJson(path.join(ROOT, "data", "salesmen.json"), { salesmen: [] });
  console.warn("[poller] no encrypted roster yet — using the public template (no real telegram ids)");
  return template;
}

async function main() {
  const roster = await loadRoster();
  const byTg = new Map();
  const byUser = new Map();
  for (const sm of roster.salesmen || []) {
    if (sm.tg) byTg.set(String(sm.tg), sm);
    if (sm.username) byUser.set(String(sm.username).toLowerCase().replace(/^@/, ""), sm);
  }

  const stateFile = path.join(ARCHIVE, "state", "offset.json");
  const state = await readJson(stateFile, { offset: 0 });

  // Drain up to 5 batches of 100 per pass. The offset is only committed together with the
  // archive (once an hour), so a fresh run must be able to catch up on an hour of updates
  // without falling behind.
  const updates = [];
  let cursor = state.offset;
  for (let batch = 0; batch < 5; batch++) {
    const url = new URL(`${process.env.TELEGRAM_API_BASE || "https://api.telegram.org"}/bot${TOKEN}/getUpdates`);
    url.searchParams.set("timeout", "0");
    url.searchParams.set("allowed_updates", JSON.stringify(["message", "edited_message"]));
    if (cursor) url.searchParams.set("offset", String(cursor));

    const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
    const body = await res.json().catch(() => ({}));
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
  const unmapped = (await readJson(path.join(ARCHIVE, "unmapped.enc.json"), null)) || [];

  const custMonths = new Map(); // month -> decrypted entries, loaded lazily
  const newCustomers = [];

  for (const u of updates) {
    nextOffset = Math.max(nextOffset, u.update_id + 1);
    const msg = u.edited_message || u.message;
    const from = msg?.from || {};
    const sm =
      byTg.get(String(from.id)) ||
      (from.username ? byUser.get(String(from.username).toLowerCase()) : undefined);

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
            list = decryptJson(box, PASS);
          } catch {
            fail(`cannot decrypt ${file} — wrong DASH_PASSPHRASE?`);
          }
        }
        custMonths.set(month, list);
      }
      const list = custMonths.get(month);
      if (list.some((c) => c.id === entry.id)) {
        skipped++;
        continue;
      }
      list.push(entry);
      newCustomers.push(entry);
      stored++;
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
      unmapped.push({
        ...ping,
        tg: String(from.id),
        who: from.first_name || null,
        username: from.username || null,
      });
      skipped++;
      continue;
    }

    const day = dayKey(ts);
    const pings = await loadDay(sm.code, day);
    const last = pings[pings.length - 1];
    const duplicate =
      last &&
      (Date.parse(ping.ts) <= Date.parse(last.ts) ||
        haversine([last.lat, last.lng], [ping.lat, ping.lng]) < MIN_MOVE_M);
    if (duplicate) {
      skipped++;
      continue;
    }

    pings.push(ping);
    await saveDay(sm.code, day, pings);
    dirty.add(sm.code);
    stored++;
  }

  // persist the month files once per pass, then refresh the rolling view the page reads
  for (const [month, list] of custMonths) {
    list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    await writeJson(custFile(month), encryptJson(list, PASS));
  }

  if (newCustomers.length) {
    const file = path.join(OUT_DIR, "customers.enc.json");
    const box = await readJson(file, null);
    let view = { generated: null, entries: [] };
    if (box) {
      try {
        view = decryptJson(box, PASS);
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
    await writeJson(file, encryptJson(view, PASS));
  }

  if (unmapped.length) {
    await writeJson(path.join(ARCHIVE, "unmapped.enc.json"), encryptJson(unmapped.slice(-500), PASS));
  }

  // ---- encrypted live payload for the public dashboard ----
  const now = Date.now();
  const live = [];
  for (const sm of roster.salesmen || []) {
    if (sm.active === false) continue;
    const day = dayKey(new Date(now).toISOString());
    const pings = await loadDay(sm.code, day);
    if (!pings.length) continue;
    // whole day, so the line on the map matches the distance the card reports;
    // decimated to ~400 points: enough for the shape, small enough to commit every 2 min
    const raw = pings.slice(-TRAIL_POINTS);
    const step = Math.ceil(raw.length / 400);
    const trail = step > 1 ? raw.filter((_, i) => i % step === 0 || i === raw.length - 1) : raw;
    const last = pings[pings.length - 1];

    // full-day distance, ignoring GPS jumps over 500 m between two pings
    let meters = 0;
    for (let i = 1; i < pings.length; i++) {
      const step = haversine([pings[i - 1].lat, pings[i - 1].lng], [pings[i].lat, pings[i].lng]);
      if (step < 500) meters += step;
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
  await writeJson(path.join(OUT_DIR, "live.enc.json"), encryptJson({ generated: new Date().toISOString(), salesmen: live }, PASS));

  // Daily activity rollup for the Reports page. Only built on the passes that commit the
  // archive (once an hour), so the extra PBKDF2 work is rare.
  let builtReports = false;
  if (process.env.BUILD_REPORTS === "1") {
    const reports = await buildReports({
      archiveDir: ARCHIVE,
      roster,
      passphrase: PASS,
      days: Number(process.env.REPORT_DAYS || 7),
      now,
    });
    await writeJson(path.join(OUT_DIR, "reports.enc.json"), encryptJson(reports, PASS));
    builtReports = true;
  }

  // offset only lands in git together with the archive (see the workflow): if a run dies
  // before that, the next run re-reads those updates and the dedupe drops the repeats.
  const nextState = { ...state, offset: nextOffset, lastRun: new Date().toISOString() };
  if (builtReports) nextState.lastArchive = new Date().toISOString();
  await writeJson(stateFile, nextState);

  console.log(
    `[poller] updates=${updates.length} stored=${stored} skipped=${skipped} ` +
      `cards=${newCustomers.length} people=${live.length} ` +
      `dirty=${[...dirty].join(",") || "-"} offset=${nextOffset}`
  );
}

main().catch((err) => fail(err.stack || String(err)));
