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
 *   LOOKBACK_MS          trail window for the map (default 4h)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { encryptJson, decryptJson } from "./crypto.mjs";

const ROOT = process.cwd();
const ARCHIVE = path.resolve(ROOT, process.env.ARCHIVE_DIR || "archive");
const ROSTER_FILE = path.resolve(ROOT, process.env.ROSTER_FILE || "private/roster.enc.json");
const OUT_DIR = path.resolve(ROOT, process.env.OUT_DIR || "dashboard/public");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PASS = process.env.DASH_PASSPHRASE || "";
const LOOKBACK_MS = Number(process.env.LOOKBACK_MS || 4 * 3600 * 1000);

const EAT_MS = 3 * 3600 * 1000;
const ONLINE_MS = Number(process.env.ONLINE_MS || 10 * 60 * 1000);
const TRAIL_POINTS = 400;
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

  const url = new URL(`${process.env.TELEGRAM_API_BASE || "https://api.telegram.org"}/bot${TOKEN}/getUpdates`);
  url.searchParams.set("timeout", "0");
  url.searchParams.set("allowed_updates", JSON.stringify(["message", "edited_message"]));
  if (state.offset) url.searchParams.set("offset", String(state.offset));

  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) fail(`telegram: ${body.description || res.status}`);

  const updates = body.result || [];
  let nextOffset = state.offset;
  let stored = 0;
  let skipped = 0;
  const dirty = new Set();
  const unmapped = (await readJson(path.join(ARCHIVE, "unmapped.enc.json"), null)) || [];

  for (const u of updates) {
    nextOffset = Math.max(nextOffset, u.update_id + 1);
    const msg = u.edited_message || u.message;
    const loc = msg && msg.location;
    if (!loc) continue;

    const from = msg.from || {};
    const sm =
      byTg.get(String(from.id)) ||
      (from.username ? byUser.get(String(from.username).toLowerCase()) : undefined);

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
    const recent = pings.filter((p) => Date.parse(p.ts) >= now - LOOKBACK_MS).slice(-TRAIL_POINTS);
    const last = pings[pings.length - 1];
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
      trail: (recent.length ? recent : pings.slice(-TRAIL_POINTS)).map((p) => [p.lat, p.lng]),
    });
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await writeJson(path.join(OUT_DIR, "live.enc.json"), encryptJson({ generated: new Date().toISOString(), salesmen: live }, PASS));
  await writeJson(stateFile, { offset: nextOffset, lastRun: new Date().toISOString() });

  console.log(
    `[poller] updates=${updates.length} stored=${stored} skipped=${skipped} ` +
      `people=${live.length} dirty=${[...dirty].join(",") || "-"} offset=${nextOffset}`
  );
}

main().catch((err) => fail(err.stack || String(err)));
