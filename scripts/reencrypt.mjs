#!/usr/bin/env node
/**
 * Re-encrypt every encrypted file in the repo from an OLD passphrase to a NEW one.
 *
 * This is the fix for the #1 cause of a "still wrong" dashboard passphrase: the
 * DASH_PASSPHRASE secret was changed (or drifted) AFTER the files were created, so
 * no phrase typed into the dashboard can open them. It also handles a lost phrase:
 * try candidate old phrases until one decrypts the roster, then re-encrypt
 * everything with the surviving/new phrase and push.
 *
 *   OLD_PASSPHRASE='<current/old phrase>' NEW_PASSPHRASE='<new phrase>' \
 *   node scripts/reencrypt.mjs [--dry-run]
 *
 *   - NEW_PASSPHRASE defaults to OLD_PASSPHRASE (pure repair: rewrite every file
 *     under one consistent phrase — useful after partial rotations left the repo
 *     with files encrypted under DIFFERENT phrases).
 *   - Files that cannot be decrypted with OLD are reported and skipped; nothing
 *     destructive happens to them.
 *   - After running: `git add -A && git commit && git push`, THEN set the SAME new
 *     value in GitHub Actions secrets AND Render env vars (see SETUP.md §3), and
 *     trigger one poll run so live.enc.json is refreshed too.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encryptJson, decryptJson } from "./crypto.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OLD = process.env.OLD_PASSPHRASE || process.env.DASH_PASSPHRASE || "";
const NEW = process.env.NEW_PASSPHRASE || OLD;
const DRY = process.argv.includes("--dry-run");

if (OLD.length < 8) {
  console.error("Set OLD_PASSPHRASE (the phrase the files were encrypted with, 8+ chars).");
  process.exit(2);
}
if (NEW.length < 8) {
  console.error("NEW_PASSPHRASE must be at least 8 characters.");
  process.exit(2);
}

async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".enc.json")) yield p;
  }
}

let ok = 0, skipped = 0;
for (const dir of ["private", "archive", path.join("dashboard", "public")]) {
  for await (const file of walk(path.join(ROOT, dir))) {
    const rel = path.relative(ROOT, file);
    let box;
    try {
      box = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      console.log(`· skip ${rel}: not readable JSON`);
      skipped++;
      continue;
    }
    if (!box || !box.ct || !box.salt) {
      console.log(`· skip ${rel}: not an encrypted envelope`);
      skipped++;
      continue;
    }
    let plain;
    try {
      plain = decryptJson(box, OLD);
    } catch {
      // Already encrypted with NEW? Treat as done (idempotent re-runs).
      try {
        decryptJson(box, NEW);
        console.log(`✓ ${rel}: already uses the new phrase`);
        ok++;
      } catch {
        console.log(`✗ ${rel}: cannot decrypt with OLD_PASSPHRASE — left untouched`);
        skipped++;
      }
      continue;
    }
    if (DRY) {
      console.log(`• ${rel}: decryptable with OLD (${JSON.stringify(plain).length} bytes) — would re-encrypt`);
      ok++;
      continue;
    }
    await fs.writeFile(file, JSON.stringify(encryptJson(plain, NEW), null, 2) + "\n");
    console.log(`✓ ${rel}: re-encrypted`);
    ok++;
  }
}

console.log(`\n[reencrypt] ${ok} file(s) ${DRY ? "verified" : "re-encrypted"}, ${skipped} skipped.`);
if (!DRY && ok) {
  console.log("Next steps:");
  console.log("  1. gh secret set DASH_PASSPHRASE --repo <owner>/<repo>   (enter the NEW phrase, no trailing newline/space)");
  console.log("  2. Render → Environment Variables → DASH_PASSPHRASE = same NEW phrase");
  console.log("  3. git add -A && git commit -m 're-encrypt: rotate passphrase' && git push");
  console.log("  4. run one poll (Actions → poll-telegram → Run workflow) so live/customers/reports refresh");
}
process.exit(skipped && !ok ? 1 : 0);
