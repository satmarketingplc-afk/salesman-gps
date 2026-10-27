#!/usr/bin/env node
/**
 * Small hosting service for the salesman GPS.
 *
 * Why it exists: the dashboard is a static page, and a static page must never hold the
 * Telegram bot token. This process keeps the token on the server and exposes one action —
 * "ask the team for a fresh location" — behind the dashboard passphrase.
 *
 * It also serves the three static pages, so Render can host everything at one URL.
 *
 * No dependencies (node:http only), so the Render build is instant.
 *
 *   TELEGRAM_BOT_TOKEN=... DASH_PASSPHRASE=... node server/index.mjs
 *
 * Optional:
 *   GH_DISPATCH_TOKEN  fine-grained PAT with Actions: write — starts a poll run immediately
 *   TELEGRAM_API_BASE  override for tests (default https://api.telegram.org)
 *   ROSTER_FILE        read the roster from disk instead of raw.githubusercontent
 *   STATIC_DIR         serve another folder (default ./dist, falls back to the repo root)
 */

import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { decryptJson } from "../scripts/crypto.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.resolve(process.env.STATIC_DIR || path.join(ROOT, "dist"));
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const PASS = process.env.DASH_PASSPHRASE || "";
const API = (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
const GH_TOKEN = process.env.GH_DISPATCH_TOKEN || "";
const REPO = process.env.GH_REPO || "satmarketingplc-afk/salesman-gps";
const PORT = Number(process.env.PORT || 10000);

const ROSTER_FILE = process.env.ROSTER_FILE ? path.resolve(process.env.ROSTER_FILE) : "";
const ROSTER_URL = `https://raw.githubusercontent.com/${REPO}/main/private/roster.enc.json`;

const GLOBAL_COOLDOWN_MS = Number(process.env.NUDGE_GLOBAL_COOLDOWN_MS || 20_000); // button cannot hammer the bot
const PERSON_COOLDOWN_MS = Number(process.env.NUDGE_PERSON_COOLDOWN_MS || 90_000); // one message per salesman per 90 s
const ROSTER_TTL_MS = 5 * 60_000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const NUDGE_TEXT =
  "📍 <b>Map refresh</b> — tap below to send your location.\n" +
  "📍 <b>ካርታው ተዘምኗል</b> — አካባቢዎን ለመላክ ከታች ይንኩ።";

const NUDGE_KEYBOARD = {
  keyboard: [[{ text: "📍 Send location / አካባቢ ላክ", request_location: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

let rosterCache = { at: 0, roster: null, inflight: null };
let lastNudgeAt = 0;
const lastPerPerson = new Map();

// Nudge cooldowns survive a restart/sleep (Render free tier restarts often):
// small JSON next to the repo root, overridable with NUDGE_STATE_FILE.
const NUDGE_STATE_FILE = path.resolve(ROOT, process.env.NUDGE_STATE_FILE || "private/nudge-state.json");

async function loadNudgeState() {
  try {
    const s = JSON.parse(await fs.readFile(NUDGE_STATE_FILE, "utf8"));
    if (typeof s.lastNudgeAt === "number") lastNudgeAt = s.lastNudgeAt;
    if (s.lastPerPerson && typeof s.lastPerPerson === "object") {
      for (const [k, v] of Object.entries(s.lastPerPerson)) {
        if (Date.now() - v < 24 * 3600_000) lastPerPerson.set(k, v);
      }
    }
  } catch {
    /* first run — no state yet */
  }
}

async function saveNudgeState() {
  try {
    const obj = {};
    for (const [k, v] of lastPerPerson) obj[k] = v;
    await fs.mkdir(path.dirname(NUDGE_STATE_FILE), { recursive: true });
    await fs.writeFile(NUDGE_STATE_FILE, JSON.stringify({ lastNudgeAt, lastPerPerson: obj }));
  } catch (err) {
    console.warn("[server] cannot persist nudge state:", err.message);
  }
}

loadNudgeState();

function json(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(data),
    ...extraHeaders,
  });
  res.end(data);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

async function readBody(req, limit = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function loadRoster() {
  if (rosterCache.roster && Date.now() - rosterCache.at < ROSTER_TTL_MS) return rosterCache.roster;
  // share one in-flight fetch between concurrent requests (no stampede on raw.githubusercontent)
  if (rosterCache.inflight) return rosterCache.inflight;
  rosterCache.inflight = (async () => {
    try {
      const raw = ROSTER_FILE
        ? await fs.readFile(ROSTER_FILE, "utf8")
        : await (await fetch(ROSTER_URL, { cache: "no-store" })).text();
      const roster = decryptJson(JSON.parse(raw), PASS);
      rosterCache = { at: Date.now(), roster, inflight: null };
      return roster;
    } catch (err) {
      rosterCache.inflight = null;
      throw err;
    }
  })();
  return rosterCache.inflight;
}

async function telegram(method, payload) {
  const res = await fetch(`${API}/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error(body.description || `telegram http ${res.status}`);
  }
  return body.result;
}

async function dispatchPoll() {
  if (!GH_TOKEN) return false;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/poll.yml/dispatches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${GH_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "salesman-gps",
      },
      body: JSON.stringify({ ref: "main" }),
      signal: AbortSignal.timeout(12_000),
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

async function nudge(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { ok: false, error: "bad_body" });
  }

  if (!PASS) return json(res, 503, { ok: false, error: "not_configured" });
  if (!safeEqual(body.pass || "", PASS)) {
    await new Promise((r) => setTimeout(r, 400)); // slow down guessing
    console.warn(`[server] failed nudge auth from ${req.socket.remoteAddress || "?"}`);
    return json(res, 401, { ok: false, error: "wrong_pass" });
  }
  if (!TOKEN) return json(res, 503, { ok: false, error: "no_bot_token" });

  const now = Date.now();
  if (now - lastNudgeAt < GLOBAL_COOLDOWN_MS) {
    return json(res, 429, {
      ok: false,
      error: "busy",
      retryIn: Math.ceil((GLOBAL_COOLDOWN_MS - (now - lastNudgeAt)) / 1000),
    });
  }
  lastNudgeAt = now;

  let roster;
  try {
    roster = await loadRoster();
  } catch {
    return json(res, 502, { ok: false, error: "roster_unavailable" });
  }

  const sent = [];
  const skipped = [];
  const failed = [];

  for (const sm of roster.salesmen || []) {
    if (sm.active === false || !sm.tg) continue;
    if (now - (lastPerPerson.get(sm.tg) || 0) < PERSON_COOLDOWN_MS) {
      skipped.push(sm.code);
      continue;
    }
    try {
      await telegram("sendMessage", {
        chat_id: sm.tg,
        text: NUDGE_TEXT,
        parse_mode: "HTML",
        reply_markup: NUDGE_KEYBOARD,
      });
      lastPerPerson.set(sm.tg, now);
      sent.push(sm.code);
    } catch {
      failed.push(sm.code);
    }
  }

  const dispatched = await dispatchPoll();

  // persist cooldown state so a restart/sleep does not let people be re-nudged instantly
  await saveNudgeState();

  // everyone was recently asked — tell the manager instead of pretending it worked
  if (!sent.length) {
    return json(res, 429, {
      ok: false,
      error: "busy",
      retryIn: Math.ceil(PERSON_COOLDOWN_MS / 1000),
      skipped,
      failed,
    });
  }

  json(res, 200, { ok: true, sent, skipped, failed, dispatched });
}

const CSP = [
  "default-src 'self'",
  // the dashboard loads Leaflet from unpkg (script + its marker images) and draws
  // inline SVG data-URI pins, so those hosts/schemes are allow-listed explicitly
  "script-src 'self' https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://unpkg.com",
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://unpkg.com",
  "connect-src 'self' https://raw.githubusercontent.com https://api.github.com",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.includes("\0")) return json(res, 400, { ok: false, error: "bad_path" });
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(DIST, "." + rel);
  const rootWithSep = DIST.endsWith(path.sep) ? DIST : DIST + path.sep;
  if (file !== DIST && !file.startsWith(rootWithSep)) {
    return json(res, 403, { ok: false, error: "forbidden" });
  }
  // never hand out encrypted payloads or local state over HTTP — the dashboard reads
  // them straight from raw.githubusercontent.com; serving them here leaks ciphertext
  // into caches and enables passphrase-guessing offline
  const relFromDist = path.relative(DIST, file);
  if (/(^|[\\/])private[\\/]|\.enc\.json$|\.corrupt-|nudge-state\.json/.test(relFromDist)) {
    return json(res, 403, { ok: false, error: "forbidden" });
  }
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return json(res, 404, { ok: false, error: "not_found" });
  }
  if (stat.isDirectory()) {
    // only one level of index.html fallback; a directory without one is a 404, not a loop
    try {
      stat = await fs.stat(path.join(file, "index.html"));
      return serveFile(req, res, path.join(file, "index.html"), stat);
    } catch {
      return json(res, 404, { ok: false, error: "not_found" });
    }
  }
  return serveFile(req, res, file, stat);
}

async function serveFile(req, res, file, stat) {
  const ext = path.extname(file).toLowerCase();
  const etag = `W/"${stat.size}-${Number(stat.mtimeMs).toString(36)}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { etag });
    return res.end();
  }
  const headers = {
    "content-type": MIME[ext] || "application/octet-stream",
    "content-length": stat.size,
    "cache-control": ext === ".html" ? "no-cache" : "public, max-age=300",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": CSP,
    etag,
  };
  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  try {
    if (pathname === "/healthz") {
      return json(res, 200, {
        ok: true,
        service: "salesman-gps",
        ts: new Date().toISOString(),
        bot: Boolean(TOKEN),
        dispatch: Boolean(GH_TOKEN),
      });
    }
    if (pathname === "/api/nudge") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "method" }, { allow: "POST" });
      return nudge(req, res);
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json(res, 405, { ok: false, error: "method" });
    }
    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error("request failed:", pathname, err.message);
    if (!res.headersSent) json(res, 500, { ok: false, error: "server_error" });
  }
});

server.timeout = 30_000;
server.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}  static=${DIST}  bot=${Boolean(TOKEN)}  dispatch=${Boolean(GH_TOKEN)}`);
});
