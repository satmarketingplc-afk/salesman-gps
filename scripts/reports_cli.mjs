#!/usr/bin/env node
/**
 * Rebuild dashboard/public/reports.enc.json from the local archive.
 *
 *   $env:DASH_PASSPHRASE="..." ; node scripts/reports_cli.mjs
 *
 * The poller does the same thing on its commit passes (BUILD_REPORTS=1); this CLI is for
 * running it by hand after importing old days.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decryptJson, encryptJson } from "./crypto.mjs";
import { buildReports } from "./report.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PASS = process.env.DASH_PASSPHRASE || "";
if (PASS.length < 8) {
  console.error("[reports] DASH_PASSPHRASE is required");
  process.exit(1);
}

async function loadRoster() {
  const file = process.env.ROSTER_FILE || path.join(ROOT, "private", "roster.enc.json");
  try {
    return decryptJson(JSON.parse(await fs.readFile(file, "utf8")), PASS);
  } catch {
    console.warn("[reports] encrypted roster not readable — using the public template for names");
    return JSON.parse(await fs.readFile(path.join(ROOT, "data", "salesmen.json"), "utf8"));
  }
}

const days = Number(process.env.REPORT_DAYS || 7);
const payload = await buildReports({
  archiveDir: path.join(ROOT, "archive"),
  roster: await loadRoster(),
  passphrase: PASS,
  days,
});

const out = path.join(ROOT, "dashboard", "public", "reports.enc.json");
await fs.writeFile(out, JSON.stringify(encryptJson(payload, PASS), null, 2) + "\n");

const rows = payload.days.reduce((n, d) => n + d.rows.length, 0);
console.log(`[reports] ${payload.days.length} days · ${rows} rows -> ${out}`);
