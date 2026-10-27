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

---

## 4. Local preview

```powershell
cd C:\Users\Ad\.cache\salesman-gps
node scripts/mock_live.mjs            # passphrase demo1234
python -m http.server 8080
```

- Launcher <http://localhost:8080/>
- Manager map <http://localhost:8080/dashboard/> · `demo1234`
- Salesman app <http://localhost:8080/app/>

The mock only writes `dashboard/public/live.enc.json`; do not commit it over the real one
(the next poll replaces it anyway).

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
committed about 2 minutes later instead of waiting for the next run (≤ 5 min); the raw CDN
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
cannot wake itself. `.github/workflows/keepalive.yml` pings `/healthz` every 10 minutes, but
GitHub's scheduler is best-effort — also add a free monitor (cron-job.org or UptimeRobot),
URL `https://<service>.onrender.com/healthz`, every 5 minutes.

**Auto-Deploy stays OFF** (`render.yaml` sets it): the poller commits every ~2 minutes and a
rebuild is never needed for data. Deploy manually after a code change.

---

## 6. Daily routine

- Salesman taps **Share live location → 8 hours** at the start of the shift (the app reminds him).
- Manager opens the dashboard, types the passphrase once per browser session.
- Action re-triggers itself at the end of every 4.5-minute run (GitHub cron is only a backup),
  commits pings every ~2 minutes, and refreshes the encrypted live file.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Map says "No positions yet" | bot has no location yet | share live location to the bot |
| Nobody appears | telegram id not in roster | `node scripts/roster.mjs unmapped` then `add` |
| "Wrong passphrase" | typo, or secret changed | re-enter; if secret changed, wait for next run |
| Pin frozen for hours | GitHub disabled the schedule after 60 days idle | any push re-enables it; bot commits normally keep it alive |
| Refresh says "Could not reach the server" | opened the GitHub Pages copy (no `/api`), or the Render service is asleep | use the Render URL; the keep-alive ping should keep it awake |
| Refresh says "Please wait 20s" | someone just pressed it | wait for the countdown; 90 s per salesman |
| Render answers 502 after a quiet night | free service was asleep | first request wakes it (~50 s); check the keep-alive monitor |
| Action fails `Bad credentials` | bot token revoked | BotFather → `/token`, update secret |
| Telegram stops after 8 h | live-location limit | share again; the app shows a renew warning at 7h48m |
