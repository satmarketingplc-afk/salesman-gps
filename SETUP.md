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

## 5. Hosting on Render (alongside Pages)

The page is pure static files, and it reads positions from `raw.githubusercontent.com`, so
GitHub Pages and Render can both serve it — neither one holds the data.

1. Render → **New → Blueprint** → pick `satmarketingplc-afk/salesman-gps`. `render.yaml`
   already defines the build (`_site` with `index.html`, `app/`, `dashboard/`).
2. Or **New → Static Site** manually:
   - Build command: `rm -rf _site && mkdir -p _site && cp index.html _site/ && cp -r app dashboard _site/`
   - Publish directory: `_site`
3. Open `https://<your-service>.onrender.com/` — same three doors:
   - `/` launcher · `/dashboard/` manager map · `/app/` salesman app

Optional: keep only Render and turn Pages off (Repo → Settings → Pages → Source: None).
The Action keeps writing to GitHub either way.

**Turn Render's Auto-Deploy OFF** (Settings → Build & Deploy → Auto-Deploy: No). Every poll
commits to the repo; with auto-deploy on, Render would rebuild the static site hundreds of
times a day and burn the free build minutes. The site does not need rebuilding for data —
it fetches the encrypted payload from GitHub on every page load.

---

## 6. Daily routine

- Salesman taps **Share live location → 8 hours** at the start of the shift (the app reminds him).
- Manager opens the dashboard, types the passphrase once per browser session.
- Action runs every 5 minutes, keeps a 4.5-minute loop open, commits pings, refreshes the map.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Map says "No positions yet" | bot has no location yet | share live location to the bot |
| Nobody appears | telegram id not in roster | `node scripts/roster.mjs unmapped` then `add` |
| "Wrong passphrase" | typo, or secret changed | re-enter; if secret changed, wait for next run |
| Pin frozen for hours | GitHub disabled the schedule after 60 days idle | any push re-enables it; bot commits normally keep it alive |
| Action fails `Bad credentials` | bot token revoked | BotFather → `/token`, update secret |
| Telegram stops after 8 h | live-location limit | share again; the app shows a renew warning at 7h48m |
