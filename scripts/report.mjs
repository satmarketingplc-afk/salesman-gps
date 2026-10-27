/**
 * Daily activity rollup for the Reports page.
 *
 * Reads the encrypted per-day archive, never writes to it. The result is encrypted with the
 * same passphrase and published as dashboard/public/reports.enc.json, so the page can show
 * first seen / last seen / pings / km without touching the raw files.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { decryptJson } from "./crypto.mjs";

const EAT_MS = 3 * 60 * 60 * 1000;

export const dayKey = (iso) => new Date(Date.parse(iso) + EAT_MS).toISOString().slice(0, 10);

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

/** Pings of one salesman for one day: first/last seen, count, live count, distance. */
export function dayStats(pings) {
  if (!pings || !pings.length) return null;
  let meters = 0;
  let live = 0;
  for (let i = 0; i < pings.length; i++) {
    if (pings[i].live) live++;
    if (!i) continue;
    const step = haversine(
      [pings[i - 1].lat, pings[i - 1].lng],
      [pings[i].lat, pings[i].lng]
    );
    if (step < 500) meters += step; // ignore GPS jumps
  }
  return {
    first: pings[0].ts,
    last: pings[pings.length - 1].ts,
    pings: pings.length,
    live,
    km: Math.round(meters / 100) / 10,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.archiveDir  e.g. <repo>/archive
 * @param {{salesmen:Array}} opts.roster
 * @param {string} opts.passphrase
 * @param {number} [opts.days]      how many days back to include (default 7)
 * @param {number} [opts.now]
 */
export async function buildReports({ archiveDir, roster, passphrase, days = 7, now = Date.now() }) {
  const people = new Map((roster.salesmen || []).map((s) => [s.code, s]));
  const out = [];

  for (let d = 0; d < days; d++) {
    const day = dayKey(new Date(now - d * 86_400_000).toISOString());
    const dir = path.join(archiveDir, "daily", day);

    let files = [];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith(".enc.json"));
    } catch {
      continue; // no folder for that day
    }

    const rows = [];
    for (const file of files.sort()) {
      const code = file.replace(/\.enc\.json$/, "");
      let pings;
      try {
        const box = JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
        pings = decryptJson(box, passphrase);
      } catch {
        continue; // encrypted with another passphrase or unreadable — skip, never fail the run
      }
      const stats = dayStats(pings);
      if (!stats) continue;

      const sm = people.get(code) || {};
      rows.push({
        code,
        name: sm.name || code,
        nameAm: sm.nameAm || sm.name || code,
        color: sm.color || "#64748b",
        ...stats,
      });
    }

    if (!rows.length) continue;
    rows.sort((a, b) => b.km - a.km);
    out.push({
      day,
      rows,
      totals: {
        people: rows.length,
        pings: rows.reduce((n, r) => n + r.pings, 0),
        km: Math.round(rows.reduce((n, r) => n + r.km, 0) * 10) / 10,
      },
    });
  }

  return { generated: new Date().toISOString(), windowDays: days, days: out };
}
