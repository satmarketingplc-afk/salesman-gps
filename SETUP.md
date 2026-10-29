# Setup

One repo. One bot. Two secrets. About 10 minutes — and I already did the repo part.

---

## 1. What exists

| Thing | Value |
|---|---|
| Bot | [@salesmaplocationbot](https://t.me/salesmaplocationbot) |
| Code + dashboard + archive | `satmarketingplc-afk/salesman-gps` (public) |
| Archive | `archive/daily/YYYY-MM-DD/SM-001.enc.json` — AES-256-GCM inside the repo |
| Live payload | `dashboard/public/live.enc.json` — encrypted, read by the browser |
| Launcher | `https://satmarketingplc-afk.github.io/salesman-gps/` |
| Manager map | `.../dashboard/` |
| Salesman app | `.../app/` |
| Customer form | `.../app/customer/` (Telegram menu button) |
| Customer archive | `archive/customers/YYYY-MM.enc.json` |
| Customers page | `.../customers/` (passphrase) |
| Registered | `SM-001 SAT` · tg `8973058282` · red |

> The dashboard passphrase is **not** stored in this repository (it is public). It lives only in
> GitHub Secrets and in your head.

---

## 2. Add a salesman

1. Salesman opens the bot, presses **Start**, sends `/start`.
2. He taps 📎 → **Location** → **Share Live Location** → `8 hours`.
3. On your PC:

```powershell
cd C:\Users\Ad\.cache\salesman-gps
$env:DASH_PASSPHRASE="<the passphrase>"
node scripts/roster.mjs unmapped        # shows tg id + first name
node scripts/roster.mjs add SM-001 "Abebe K." "አበበ ከ." 812345678 "#e11d48"
git add private/roster.enc.json
git commit -m "roster: SM-001"
git push
```

The next poll (≤5 min) picks him up and his pin appears.

---

## 3. Secrets (already set, for reference)

```powershell
gh secret set TELEGRAM_BOT_TOKEN --repo satmarketingplc-afk/salesman-gps
gh secret set DASH_PASSPHRASE    --repo satmarketingplc-afk/salesman-gps
```

**Changing the passphrase later** re-encrypts nothing by itself — the old archive files stay
readable only with the old phrase. Do it at the start of a month, or ask for the re-encrypt script.

**"Wrong passphrase" on the dashboard? Check secret drift first.** The poller (GitHub Actions)
*encrypts* with `secrets.DASH_PASSPHRASE`; you *decrypt* with whatever you type. If either the
Actions secret or the Render env var was changed, rotated, or contains trailing whitespace/newline
that differs from what people type, every correct-looking passphrase fails. Verify:

```powershell
# 1. Does the GitHub Actions secret decrypt the live repo files?
$env:DASH_PASSPHRASE="<what you type into the dashboard>"
node scripts/diagnose.mjs        # "Cannot decrypt the roster" => secret mismatch

# 2. Compare the stored secret byte-for-byte (trailing spaces are invisible!)
gh secret view DASH_PASSPHRASE --repo satmarketingplc-afk/salesman-gps | cat -A
```

Fix by setting the exact same value in BOTH places (`gh secret set` + Render → Environment
Variables), entered without copy-paste whitespace. The dashboard now shows a distinct
"live file is stale / re-encrypted" message when the poller stopped or drifted, instead of
falsely blaming your typing.

---

## 4. Online only — no local preview

This system is designed to run **only online**: Telegram → GitHub Actions → encrypted repo →
hosted pages. Never run it on a laptop as your day-to-day system — nothing you do locally
affects production, and the pages deliberately fetch real data from the hosted repo so a
half-set-up local copy can never show stale or fake points.

Open the live URLs instead:

- Launcher <https://satmarketingplc-afk.github.io/salesman-gps/>
- Manager map <https://satmarketingplc-afk.github.io/salesman-gps/dashboard/> (your passphrase)
- Salesman app <https://satmarketingplc-afk.github.io/salesman-gps/app/>

If the map shows "waiting for data", that means the pipeline (not your machine) needs a fix:
check the Actions run log and `roster.mjs unmapped`.

---

## 5. Hosting

### Default: GitHub Pages — no server, nothing to keep alive

Repo → Settings → Pages → Source: **GitHub Actions** (already set). Every push publishes
`/`, `/dashboard/` and `/app/`. The dashboard reads the encrypted payload straight from
`raw.githubusercontent.com`, so Pages only serves HTML/CSS/JS.

On Pages the **Refresh** button is a plain reload. A new point appears with the next poll
(≤ 5 min) after the salesman shares his location — the delay you already accepted.

### Optional: Render, only to make Refresh ask the team

Everything below is optional. A static page must never hold the bot token, so the one-tap
"where are you now" needs a small server (`server/index.mjs`, no dependencies):

- serves the launcher, the dashboard and the salesman app,
- answers `POST /api/nudge` by asking the team on Telegram for a fresh point,
- answers `/healthz` for the keep-alive pings.

Data still lives in GitHub: the page reads positions from `raw.githubusercontent.com`, and
the Action keeps writing there. GitHub Pages keeps working as a read-only mirror — on Pages
the Refresh button simply reloads (no `/api`), everything else is identical.

**Deploy:** Render → **New → Blueprint** → pick `satmarketingplc-afk/salesman-gps`.
`render.yaml` sets the build (copies `index.html`, `app/`, `dashboard/` into `dist/`), the
start command and the health check.

**Environment variables** (Render → Environment):

| Key | Value | Needed |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | bot token from BotFather | yes |
| `DASH_PASSPHRASE` | `SalesMap-2026-Addis` (same as GitHub secret) | yes |
| `GH_DISPATCH_TOKEN` | fine-grained PAT, **Actions: write**, this repo | optional |

With `GH_DISPATCH_TOKEN` set, Refresh also starts a poll run immediately, so the new point is
committed about 1 minute later instead of waiting for the next pass (≤ 4 min); the raw CDN
can add a few more minutes before every browser sees it.

### What Refresh does

1. Sends every active salesman a Telegram message with a one-tap **📍 Send location** button.
2. Telegram returns one fresh point when he taps it.
3. The poller stores it, the dashboard reloads itself for the next 5 minutes.

Telegram limit worth knowing: a bot cannot force a **live** location. The button gives one
point; continuous tracking still starts with Telegram → Attach → Location → Share live
location → 8 hours. Cooldowns: 20 s globally, 90 s per salesman.

### Keep it awake

Render's free web service sleeps after ~15 minutes without traffic, and a sleeping service
cannot wake itself. Add a free external monitor (cron-job.org or UptimeRobot) on
`https://<service>.onrender.com/healthz`, every 5 minutes — the in-repo keepalive workflow
was removed because GitHub's scheduler fired it hours apart and it only burned runs.

**Auto-Deploy stays OFF** (`render.yaml` sets it): the poller commits every ~4 minutes and a
rebuild is never needed for data. Deploy manually after a code change.

---

## 6. Daily routine

- Salesman taps **Share live location → 8 hours** at the start of the shift (the app reminds him).
- Manager opens the dashboard, types the passphrase once per browser session.
- Action re-triggers itself at the end of every 4.5-minute run (GitHub cron is only a backup).
  It commits the live map every ~4 minutes and the encrypted archive once an hour.

---

## 7. Activity reports

`/reports/` — same passphrase as the map (if you already unlocked the map, it opens directly).

- one row per salesman per day: first seen, last seen, points, live points, km
- summary cards for the newest day, plus up to 7 days of history
- search by name or code, **CSV** button for Excel / Google Sheets
- Amharic / English toggle; names switch too

The poller rebuilds `dashboard/public/reports.enc.json` on the hourly archive pass, from the
same encrypted archive — nothing leaves the repo. To rebuild by hand (e.g. after importing
old days):

```powershell
$env:DASH_PASSPHRASE="..."
node scripts/reports_cli.mjs            # REPORT_DAYS=14 to widen the window
```

The map now draws the **whole day's trace** (decimated to ~400 points) and marks where the
day started, so the line and the `km` figure describe the same walk.

---

## 8. Customer cards

Salesmen save customers from inside Telegram — no extra app, no token on the phone.

1. The salesman opens the bot and taps the **menu button** ("New customer", bottom of the chat).
   A form opens inside Telegram: name, phone, shop, product, quantity, status, note.
2. **Save** → the card goes back to the bot, the form closes.
3. The poller writes it within ~4 minutes to:
   - `archive/customers/YYYY-MM.enc.json` — the encrypted archive, one file per month;
   - `dashboard/public/customers.enc.json` — the rolling view the management page reads.

Management page: `/customers/` — same passphrase as the map.

- **Board** (default on desktop): one column per salesman, the whole team on screen at once,
  including salesmen with no cards yet. Click a name to focus him, click again for the team.
- **List**: day-by-day timeline.
- Search (name, phone, shop, note), status filter (lead / quoted / won / lost), **CSV** export.
- Phone numbers are tap-to-call; cards saved with GPS have a **map** link.

The Telegram menu button is set once with:

```powershell
$env:TELEGRAM_BOT_TOKEN="..."
node scripts/set_bot_menu.mjs
```

### What the bot says

- **/start** or **/help** → a bilingual welcome with the two steps and a **New customer**
  button. Someone who is not in the roster gets his own Telegram id to send to the office.
- **Every saved card** → `✅ Abebe Trading — Quoted · ዋጋ ተሰጥቷል` plus whether the location
  was attached, so the salesman knows it landed. Replies arrive with the next poll pass
  (0–4 min), not instantly.
- The command list, short description and description are set by the same script. One
  welcome per person per hour, and replayed updates never double-send.

The bot is a capture channel, not a chatbot: it does not answer questions, and it cannot
force a live location (Telegram does not allow that).

If the form is opened in a plain browser (outside Telegram), Save copies the card text and
opens the bot — the salesman pastes and sends. The poller accepts that `#CUST {...}` message
too, so the form is never a dead end.

Privacy: the card travels through the salesman's private bot chat, then lives encrypted in the
repo. The page is public but unreadable without the passphrase.

---

## 9. Keeping it free

GitHub is free for this repo **because it is public**: Actions minutes are unlimited for
public repos and Pages costs nothing. A private repo would burn the 2,000 free minutes in
under two days at this polling rate.

Storage is the part that needs discipline. Git keeps a full copy of every version of every
file, and an encrypted archive does not delta-compress. So:

- the **live payload** (`dashboard/public/live.enc.json`, a few KB) is committed every ~4 min;
- the **archive** (the day file that keeps growing) is committed **at most once an hour**,
  together with the Telegram offset and the report.

The offset rides with the archive on purpose: if a run dies before the hourly commit, the
next run re-reads those updates and the dedupe drops the repeats. A catch-up loop drains up
to 500 updates per pass, so an hour of backlog clears without falling behind.

One salesman's full day is about 300 KB, so the hourly pattern adds roughly 2 MB/day
instead of ~1 GB/day. Three or four active salesmen ≈ 200 MB/month.

If the repo passes ~800 MB (check the repo page), squash the history. This rewrites history,
so anyone with a clone must re-clone:

```powershell
git checkout --orphan clean
git add -A
git commit -m "snapshot"
git branch -M clean main
git push -f origin main
```

Beyond ~5 active salesmen, move the archive out of git history (hourly chunk files or GitHub
Releases). The free plan is not the limit — the whole-file rewrite pattern is.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Map says "No positions yet" | bot has no location yet | share live location to the bot |
| Nobody appears | telegram id not in roster | `node scripts/roster.mjs unmapped` then `add` |
| "Wrong passphrase" | typo, leading/trailing space from copy-paste, Caps Lock, or the secret was changed/rotated | re-enter carefully (spaces are now trimmed automatically); verify with `node scripts/diagnose.mjs` using the same value; if Render and GitHub Actions hold different values, sync them (`gh secret set DASH_PASSPHRASE` + Render env) |
| "Wrong passphrase" but the phrase IS correct | a network hiccup or a half-written/corrupt `live.enc.json` used to be misreported as a wrong passphrase | fixed: pages now show "Could not reach GitHub — check your connection" for load errors and only show "Wrong passphrase" when decryption itself fails. If you still see it after a hard refresh, run the definitive test below |
| Pin frozen for hours | GitHub disabled the schedule after 60 days idle | any push re-enables it; bot commits normally keep it alive |
| Pin frozen although live location is shared | salesman's Telegram id is not in the roster — his pings land in `unmapped`, not on the map | `node scripts/roster.mjs unmapped` then `node scripts/roster.mjs tg SM-001 <id>`; commit + push `private/roster.enc.json`; pin appears within one poll pass |
| "Wrong passphrase" on every page even though it is correct | files were encrypted with an older passphrase (after rotation) | re-encrypt archive + roster + live payload with the new phrase, or restore the old secret |
| Refresh says "Could not reach the server" | opened the GitHub Pages copy (no `/api`), or the Render service is asleep | use the Render URL; the keep-alive ping should keep it awake |
| Refresh says "Please wait 20s" | someone just pressed it | wait for the countdown; 90 s per salesman |
| Render answers 502 after a quiet night | free service was asleep | first request wakes it (~50 s); check the keep-alive monitor |
| Action fails `Bad credentials` | bot token revoked | BotFather → `/token`, update secret |
| Telegram stops after 8 h | live-location limit | share again; the app shows a renew warning at 7h48m |

### Definitive passphrase test (30 seconds, no browser involved)

Run this on any machine with Node. It checks whether your passphrase can decrypt the
exact files the dashboard loads. One of the two lines will tell you precisely what is wrong:

```bash
DASH_PASSPHRASE='the phrase you type into the dashboard' node --input-type=module -e '
import fs from "node:fs/promises";
import { decryptJson } from "./scripts/crypto.mjs";
const box = JSON.parse(await fs.readFile("private/roster.enc.json", "utf8"));
try {
  decryptJson(box, process.env.DASH_PASSPHRASE.trim());
  console.log("PASSPHRASE OK — matches the files in this repo.");
} catch {
  console.log("MISMATCH — this phrase cannot decrypt roster.enc.json.");
  console.log("(a) it differs from the DASH_PASSPHRASE secret in GitHub Actions, or");
  console.log("(b) the files were re-encrypted after a rotation. Check Settings → Secrets and Actions,");
  console.log("    compare with Render environment variables, and re-run scripts/roster.mjs init/add");
  console.log("    with the surviving phrase if the old one is lost.");
}
'
```

If this prints MISMATCH, the dashboard will never accept the phrase either — the problem
is the secret/files, not your typing. If it prints OK but the browser still complains,
hard-refresh (Ctrl+Shift+R): an old service-worker cache may be serving a stale encrypted file.
