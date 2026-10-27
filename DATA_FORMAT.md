# Data format

Everything in the repo is encrypted with AES-256-GCM (PBKDF2-SHA256, 210,000 iterations).
The repository is public so Actions minutes stay free; the contents are not readable without
the passphrase.

## Encrypted file shape

```json
{"v":1,"kdf":"PBKDF2-SHA256","iter":210000,
 "salt":"<b64 16B>","iv":"<b64 12B>","tag":"<b64 16B>","ct":"<b64>"}
```

Browser decryption needs `ct || tag` concatenated (see `dashboard/index.html`).

## Archive

```
archive/daily/YYYY-MM-DD/SM-001.enc.json   encrypted array of pings, one file per salesman per day
archive/unmapped.enc.json                  last 500 pings from telegram ids not yet in the roster
archive/state/offset.json                  telegram update cursor (not sensitive)
private/roster.enc.json                    code → name, colour, telegram id (encrypted)
```

### Ping

```json
{"ts":"2026-10-27T05:31:12.000Z","lat":9.010812,"lng":38.761344,
 "acc":12,"hdg":187,"live":true,"src":"telegram"}
```

| field | meaning |
|---|---|
| `ts` | UTC ISO time of the Telegram update (shown in EAT) |
| `lat`,`lng` | WGS-84, 6 decimals |
| `acc` | horizontal accuracy in metres, may be null |
| `hdg` | heading in degrees, may be null |
| `live` | true while the 8-hour live session is active |
| `src` | `telegram` (future: `manual`, `import`) |

The telegram id is not stored in the archive — it only lives in the encrypted roster, so a
leaked day file cannot be tied to a phone number.

**Dedupe:** a ping is dropped when it is older than the last one, or when the phone moved
less than 8 m. Telegram re-sends the same coordinates while a person stands still.

## Live payload

`dashboard/public/live.enc.json` decrypts to:

```json
{"generated":"2026-10-27T06:02:11.000Z",
 "salesmen":[{"code":"SM-001","name":"Abebe K.","nameAm":"አበበ ከ.","color":"#e11d48",
   "lat":9.010812,"lng":38.761344,"acc":12,"ts":"2026-10-27T06:02:00.000Z",
   "online":true,"live":true,"trail":[[9.0108,38.7613],[9.0111,38.7619]]}]}
```

- `online` = last ping within 3 minutes
- `trail` = last 4 hours, up to 400 points
- names never appear in plaintext in the repo

## Retention

- Daily files: 90 days, then rolled into `archive/routes/` + `archive/summary/` (phase 3)
- Monthly GeoJSON: kept indefinitely
- `unmapped.enc.json`: trimmed to the last 500 entries automatically
