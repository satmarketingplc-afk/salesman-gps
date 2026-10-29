# TODO — Salesman GPS

## Now (requested 2026-10-29)

- [x] **Bot confirms verification + asks for the location.** The moment a `/join` claim is
      applied (or the office links a salesman), the bot sends: "✅ Verified by the office —
      you are linked as SM-001 (SAT). Now send your location: 📎 → Location → Share Live
      Location → 8 hours." Bilingual EN/አማርኛ, sent from the poller
      (`scripts/poll_telegram.mjs`, applied-claims loop).
- [ ] **Re-confirm to the same person on every `/start`** if he is already linked and has no
      points today: repeat the share-location steps with a one-tap guide (the `app/` link),
      so a returning salesman never has to remember the menu path.

## Open

- [ ] Nudge button on a Pages-only deploy (currently needs the Render service for `/api/nudge`).
- [ ] Reports: stop detection (cluster within 40 m for 5+ min → "visited 25 min").
- [ ] CSV export of the customer board from the phone.
- [ ] Keep an eye on Actions: if GitHub ever rejects the chain dispatch (logged as
      `chain dispatch attempt 1..3`), the */5 cron re-seeds it within a few hours; a Render
      cron or Cloudflare Worker would remove that dependency.

## Done

- [x] 2026-10-29 — poller self-chaining restored (4–5 min cycle), Pages deploy workflow added,
      login bug (`exportKey` on a non-extractable key) fixed in dashboard/customers/reports.
