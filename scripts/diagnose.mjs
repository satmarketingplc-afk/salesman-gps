#!/usr/bin/env node
/**
 * Salesman GPS — online self-diagnosis. Zero AI, zero manual digging.
 *
 * Reads the ENCRYPTED files that GitHub Actions publishes (roster, live payload,
 * unmapped archive) straight from the hosted repo over HTTPS, decrypts them with
 * your dashboard passphrase, and tells you exactly why a salesman is or is not
 * on the map. Works from any computer — it only needs internet access, and it
 * never writes anything to the repo.
 *
 * Usage:
 *   DASH_PASSPHRASE=<your dashboard passphrase> \
 *   GH_OWNER=<owner> GH_REPO=<repo> \
 *   node scripts/diagnose.mjs [CODE]
 *
 *   CODE (optional) limits the report to one salesman, e.g. SM-003.
 *
 * Exit codes: 0 = everyone linked looks healthy / explained; 1 = something the
 * office must act on was found (missing link, no location, wrong passphrase).
 */

import { decryptJson } from "./crypto.mjs";

const OWNER = process.env.GH_OWNER || "satmarketingplc-afk";
const REPO = process.env.GH_REPO || "salesman-gps";
const PASS = process.env.DASH_PASSPHRASE || "";
const ONLY = (process.argv[2] || "").toUpperCase();
const BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main`;

async function fetchJson(url) {
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) return { __http: res.status };
  return res.json();
}

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

let problems = 0;
function bad(msg) { console.log(`  ✗ ${msg}`); problems++; }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function note(msg) { console.log(`  · ${msg}`); }

async function main() {
  if (PASS.length < 8) {
    console.error("Set DASH_PASSPHRASE first (the same passphrase you type into the dashboard).");
    process.exit(2);
  }
  console.log(`Salesman GPS diagnosis — ${OWNER}/${REPO} (read-only, online)\n`);

  const rosterBox = await fetchJson(`${BASE}/private/roster.enc.json`);
  if (rosterBox.__http === 404) {
    bad("private/roster.enc.json not found in the repo — has the poller workflow ever run? Check Settings → Secrets and Actions → poll-telegram logs.");
    process.exit(1);
  }
  let roster;
  try {
    roster = decryptJson(rosterBox, PASS);
  } catch {
    bad("Cannot decrypt the roster — DASH_PASSPHRASE here does NOT match the secret used by GitHub Actions. Use the exact dashboard passphrase.");
    process.exit(1);
  }
  const salesmen = roster.salesmen || [];
  console.log(`Roster: ${salesmen.length} salesmen\n`);
  if (salesmen.length && !salesmen.some((s) => s.active !== false && Number(s.tg))) {
    bad("NOBODY in the roster is linked to a Telegram id (all tg=0). Every ping falls into `unmapped` and the map stays empty — this is why no salesman is visible.");
  }

  // self-service /join claims waiting for approval (AUTO_ASSIGN=0 mode leaves them here)
  const pendingBox = await fetchJson(`${BASE}/private/pending.enc.json`);
  if (!pendingBox.__http) {
    try {
      const pend = decryptJson(pendingBox, PASS);
      if (Array.isArray(pend) && pend.length) {
        note(`Pending /join claims (${pend.length}): ${pend.map((p) => `${p.code}→tg=${p.tg}${p.who ? ` (${p.who})` : ""}`).join(", ")}`);
        note("Approve with: node scripts/roster.mjs pending --apply   (then commit + push private/roster.enc.json)");
      }
    } catch { /* unreadable pending file is not fatal */ }
  }

  const liveBox = await fetchJson(`${BASE}/dashboard/public/live.enc.json`);
  let live = [];
  if (liveBox.__http === 404) {
    note("No live.enc.json yet — the poller has never completed a pass. First check the Actions tab for 'poll-telegram'.");
  } else {
    try {
      live = decryptJson(liveBox, PASS).salesmen || [];
      note(`Live payload generated ${ago(liveBox.generated ? new Date().toISOString() : "")} — last poll produced ${live.length} pin(s).`);
    } catch {
      bad("live.enc.json cannot be decrypted with this passphrase.");
    }
  }
  const liveByCode = new Map(live.map((p) => [p.code, p]));

  // who is sitting in the unmapped pile (GPS sent before /join)
  const unmappedBox = await fetchJson(`${BASE}/archive/unmapped.enc.json`);
  const tgSeenInUnmapped = new Set();
  if (!unmappedBox.__http) {
    try {
      const un = decryptJson(unmappedBox, PASS);
      const list = Array.isArray(un) ? un : Object.values(un).flat();
      for (const r of list) if (r?.tg) tgSeenInUnmapped.add(String(r.tg));
      if (list.length) note(`Unmapped archive holds ${list.length} point(s) from ${tgSeenInUnmapped.size} unknown Telegram id(s): ${[...tgSeenInUnmapped].join(", ")}`);
    } catch { note("Unmapped file unreadable (not fatal)."); }
  }

  const now = Date.now();
  let shown = 0;
  for (const sm of salesmen) {
    if (ONLY && sm.code !== ONLY) continue;
    shown++;
    console.log(`── ${sm.code} · ${sm.name}${sm.active === false ? " (INACTIVE)" : ""}`);
    if (sm.active === false) { ok("marked inactive — intentionally hidden from the map."); continue; }
    if (!sm.tg || Number(sm.tg) === 0) {
      bad(`NO Telegram link. Tell them to open the bot and send:  /join ${sm.code}   (then Share live location)`);
      continue;
    }
    ok(`Linked to Telegram id ${sm.tg}.`);
    if (tgSeenInUnmapped.has(String(sm.tg))) {
      note("Their earlier locations are still in the unmapped pile — they will be recovered automatically on the next poll pass (≤5 min). Re-run this script after that.");
    }
    const p = liveByCode.get(sm.code);
    if (!p) {
      bad("Linked, but has NO location points today → not on the map until they share: 📎 → Location → Share Live Location → 8 hours.");
      continue;
    }
    const ageMin = (now - Date.parse(p.ts)) / 60000;
    if (ageMin > 10) bad(`Last point is ${ago(p.ts)} — pin shows as offline/stale. Ask them to re-share live location (it expires!).`);
    else ok(`On the map: live at (${p.lat}, ${p.lng}), last point ${ago(p.ts)}, trail ${(p.trail || []).length} pts, ${p.distKm ?? "?"} km today.`);
  }
  if (ONLY && !shown) {
    bad(`Code ${ONLY} is not in the roster. Add it first: node scripts/roster.mjs add ${ONLY} "Name"`);
  }

  console.log(`\n${problems ? `→ ${problems} action item(s) above.` : "→ Everything checked out. If the map still looks empty, hard-refresh (Ctrl+Shift+R)."}`);
  process.exit(problems ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
