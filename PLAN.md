# Salesman GPS — Plan v2 (approved direction)

**Decisions locked**

| Question | Answer |
|---|---|
| Storage | 100 % GitHub (no Firebase, no relay server) |
| Capture | Telegram live location (native, background, 15 s, Android + iPhone) |
| Live freshness | 1–2 min typical, 1–5 min worst case (accepted) |
| Trail accuracy | full 15 s — nothing is dropped |
| Dashboard v1 | live map + last seen |
| Language | English + Amharic |
| Cost | $0 |

---

## 1. How it works

```
Salesman phone (Telegram, already installed)
   "Share live location" 8 h  ──15 s──►  Telegram servers
                                              │ updates kept 24 h
                                              ▼
                        GitHub Action (public repo, cron */5, 4.5 min loop)
                                  │                    │
                     private data repo          encrypted live file
                   daily/SM-001/*.jsonl        dashboard/public/live.enc.json
                   (plaintext, private)        (AES-GCM, passphrase)
                                                          │
                                                GitHub Pages dashboard
                                                (decrypts in browser)
```

Why the split:
- **Public repo** for code + Pages + Actions → unlimited free Actions minutes (a private
  repo only gets 2,000 min/month; a 5-minute cron alone would burn 43,000).
- **Private repo** for the raw location archive → nobody sees where your staff lives.
- **Encrypted live file** in the public repo → the dashboard can read it without a token,
  but only someone with the passphrase can see pins.

Nothing is lost when GitHub is late: Telegram holds unconfirmed updates for 24 h, so a
delayed run simply picks everything up on the next pass. The pin on screen may age a
minute; the trail never has holes.

---

## 2. Why not the alternatives

| Option | Verdict |
|---|---|
| PWA background tracking | iPhone Safari suspends it in ~30 s → dead on half the team |
| Native APK | Two builds, install on every phone, Apple account for iPhone |
| Firebase / Worker relay | Fastest, but you chose 100 % GitHub — not needed at 15 s trail |
| Direct commits per ping | 15 s × 10 men ≈ 57,600 commits/day → repo destroyed |

---

## 3. One repo

```
salesman-gps   PUBLIC   code, dashboard, Actions, Pages, encrypted archive
```

```
index.html                  launcher (manager / salesman)
app/index.html              field app: shift timer, share steps, PWA
dashboard/index.html        manager map (EN / አማርኛ)
dashboard/public/live.enc.json   encrypted live pins + 4h trail
archive/daily/…/SM-001.enc.json encrypted pings, one file per man per day
archive/unmapped.enc.json       pings from ids not yet in the roster
archive/state/offset.json       telegram cursor (not sensitive)
private/roster.enc.json         code → name/colour/telegram id (encrypted)
scripts/poll_telegram.mjs       telegram → encrypted archive + live payload
scripts/roster.mjs              encrypted roster CLI
scripts/mock_live.mjs           demo feed
.github/workflows/poll.yml      5-minute cron, 4.5-minute loop
```

The repo is public so Actions minutes are unlimited (a private repo only gets 2,000 min/month,
and this cron needs ~43,000). Everything sensitive inside it is AES-256-GCM encrypted, so the
history is unreadable without the passphrase.

---

## 4. Data model

One ping per line:

```json
{"ts":"2026-10-27T05:31:12.000Z","lat":9.010812,"lng":38.761344,
 "acc":12,"hdg":187,"live":true,"src":"telegram","tg":"123456789"}
```

- `ts` UTC, rendered in EAT (UTC+3)
- `acc` horizontal accuracy in metres
- `live` true while the salesman's Telegram live-location session is active
- duplicate points (same position, < 15 s) are dropped before writing

Dashboard payload (encrypted, last 400 points per salesman for the trail):

```json
{"generated":"...","salesmen":[{"code":"SM-001","name":"Abebe K.","nameAm":"አበበ ከ.",
  "color":"#e11d48","lat":9.01,"lng":38.76,"acc":12,"ts":"...","online":true,"live":true,
  "trail":[[9.01,38.76],...]}]}
```

---

## 5. Phases

| Phase | Deliverable | Time | Status |
|---|---|---|---|
| **0 · Scaffold** | repo tree, data format, roster, poller, workflow, dashboard shell, mock data | ½ day | **in progress** |
| **1 · Live** | bot + secrets + repos connected, your phone visible on the Pages map | 1 day | next |
| **2 · Dashboard** | trail, stops > 5 min, distance, CSV, bilingual polish | 1–2 days | |
| **3 · Housekeeping** | monthly rollup, 90-day retention, repo-size compaction, uptime badge | ½ day | |
| **4 · Pilot** | 5 salesmen × 1 week, tune interval, battery + dead-zone check | 2 days + watch | |

---

## 6. Limits we accept

- Live pin can be 1–5 min old; the UI always prints `last seen 2 min ago` — it never fakes "live".
- Telegram live location stops after 8 h → the salesman taps it again each morning (one tap), or we
  send him a reminder at 08:00 via the bot.
- Repo grows ~1 commit per 5-minute run (≈288/day). Phase 3 adds monthly compaction.
- GPS accuracy in Addis alleys is 10–30 m; the map draws the accuracy circle honestly.
- Telegram mock-location is not detectable → add "phone battery %" later as a weak tell.

---

## 7. Security

- One public repo, but every ping, the roster and the live payload are AES-256-GCM inside it.
- The passphrase exists only in GitHub Secrets and in your head — never in code, never committed.
- A leaked repository tarball reveals file names and sizes, not positions or names.
- The field app needs no password and contains no data, so it is safe to send to any phone.
