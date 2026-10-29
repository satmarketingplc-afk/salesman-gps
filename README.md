# Salesman GPS

A manager opens one page and sees where each salesman is right now. The salesman's "app" is
Telegram — no install, no training, works on Android and iPhone, keeps sending with the screen
off for up to 8 hours.

- **Capture:** Telegram live location (15 s updates)
- **Store:** a GitHub repo, encrypted, one file per salesman per day
- **Live view:** encrypted file in the repo, decrypted in the browser
- **Reports:** `/reports/` — daily km, first/last seen, points, CSV export
- **Customers:** `/app/customer/` form inside Telegram → `/customers/` team board + CSV
- **Hosting:** GitHub Pages (static, zero servers); optional Render service only for the "ask for a location" button
- **Server:** none. One GitHub Action that re-triggers itself.

## Quick start

Read `SETUP.md` (20 min, one bot + two repos + three secrets), then open the Pages URL and
type your passphrase.

## Online only

This system runs entirely online — Telegram → GitHub Actions → encrypted repo → hosted pages.
There is no local/dev server in normal operation; do not run it locally. The dashboard,
reports, and customer board always fetch their data from the hosted repo, so they show real
data only when opened at the live URLs:

- Launcher / map: `https://satmarketingplc-afk.github.io/salesman-gps/`
- Optional service (Refresh button): `https://salesman-gps.onrender.com`

## Files

| Path | What |
|---|---|
| `PLAN.md` | decisions, architecture, phases, limits |
| `SETUP.md` | step-by-step install |
| `DATA_FORMAT.md` | ping schema, encryption, retention |
| `scripts/poll_telegram.mjs` | Telegram → encrypted archive + encrypted live payload |
| `scripts/roster.mjs` | encrypted roster CLI (`add`, `tg`, `list`, `unmapped`) |
| `scripts/mock_live.mjs` | fake 3-person feed for the dashboard |
| `data/salesmen.json` | roster template (real one lives in the private repo) |
| `app/index.html` | salesman app: shift timer, 3-step share guide, EN/አማርኛ, installable |
| `app/customer/index.html` | customer card Mini App (Telegram menu button) |
| `customers/index.html` | management board: one column per salesman, CSV |
| `scripts/set_bot_menu.mjs` | points the bot's menu button at the customer form |
| `dashboard/index.html` | map, list, EN/አማርኛ, passphrase gate |
| `.github/workflows/poll.yml` | self-chaining 4-minute poll loop (5-minute cron is only the backup) |
| `.github/workflows/pages.yml` | deploys the site when page code changes (data is read from raw) |
