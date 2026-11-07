# Project context (handoff notes)

Everything a new session (or a new laptop) needs to continue this project without the original chat. Written 7 Nov 2026 from the build conversation. No secrets here: they live in `.env` locally and in Vercel's environment variables.

## 1. What this is

Capture a person's Instagram ID and @username and link it to their phone number, without them typing their handle (target: ≤3 taps, 0 keystrokes).

**Flow:** admin creates an invite for a phone number → admin sends a WhatsApp message (by hand) with two `ig.me` links → the person taps **Step 1** (opens a chat with our business account, taps the "Start chat" ice breaker, which creates the conversation) → taps **Step 2** (`https://ig.me/m/<business>?ref=<token>`, reopens the now-existing chat) → Instagram sends a `messaging_referral` webhook with the person's IGSID + the token → server maps token → phone, fetches `@username` via Graph API, saves `phone ↔ IGSID ↔ @username`, DMs "All set ✅".

Proof of number ownership: only the phone's owner receives the WhatsApp message containing the one-time token.

## 2. Key decisions and why

| Decision | Why |
|---|---|
| ig.me link with `ref` + Instagram webhook | Instagram itself reports who opened which link: exact, official, no typing. Rejected: typing the handle; phone→handle lookup (no API, scraping breaks terms); "Log in with Instagram" (business/creator accounts only); click-timing match (a guess, can mis-link). |
| **Two links** instead of one | Instagram drops the `ref` on a person's **first-ever** contact with the business (the ice-breaker postback arrives without `referral`). Seen 4/4 in our tests; also reported on Meta's forum: "ig.me 'ref' parameter missing from messaging_postbacks on a user's FIRST conversation (Icebreakers configured, app Live): referral arrives only on second contact" (Sep 2026, developers.facebook.com/community/threads/1552269896122738: 0/8 first contacts vs 23/23 returning). Once the chat exists, opening the link always carries the `ref`. |
| Tested and rejected workarounds | Second button inside the chat ("Continue"): button taps never carry the ref. "Tap the link again" auto-reply: works, but the user only learns after getting stuck. Typing "hi": never tested. |
| Server reply on Step 1 | Any `START_CHAT` postback or first message without a ref, from someone not yet linked, gets: "Thanks for starting the chat! 👋 To finish, go back to WhatsApp on your phone and tap the Step 2 link." So any tap order recovers. |
| WhatsApp sent manually | Twilio sandbox and Meta WhatsApp Cloud API were removed. Cloud API was blocked (business account locked, error 131031). The dashboard gives "Open in WhatsApp" (wa.me prefilled) and "Copy message". |
| CSV / Excel import | Re-added 7 Nov 2026 as a contact list, not bulk sending. Import (`.csv`/`.xlsx`, parsed on the server with `read-excel-file`) only saves numbers + names in `contacts`; a link is created when the admin presses **Invite** on a row (links expire, so they aren't made in advance). The admin sends by hand, then **Next →** moves to the next person. Opening WhatsApp or copying the message sets the invite's `sentAt`. Statuses: Not invited → Link ready → Sent → Connected / Expired. Export downloads the filtered rows as CSV. |
| Links expire | `INVITE_TTL_HOURS` (default 24). Each invite stores its own `expiresAt`. Expired Step 2 → DM "This link has expired. Please ask for a new one." Dashboard shows "New link". |
| Single-use links | A link already claimed by another IGSID is rejected (forwarded-link protection). Claiming is atomic (MongoDB conditional update). |
| Message requests | No need to accept new chats in the business inbox; webhooks and replies work either way. Don't block/delete before Step 2. |

## 3. Architecture

- `src/server.js`: Express app. Admin login (password → JWT in httpOnly cookie, 7 days), `/api/invites`, `/api/links`, `/api/events`, `/api/config`, `GET /webhook` (verify handshake), `POST /webhook` (signature check → process events **before** replying, because Vercel freezes functions after the response).
- `src/instagram.js`: Graph API calls (`getProfile`, `sendDM`), `X-Hub-Signature-256` check with `IG_APP_SECRET`, `extractReferral` (handles `referral.ref`, `postback.referral.ref`, `message.referral.ref`, echoes ignored), `ICEBREAKER = { question: "Start chat", payload: "START_CHAT" }`.
- `src/importer.js`: phone number normalisation (`DEFAULT_COUNTRY_CODE`, default 91) and CSV / `.xlsx` parsing for the import. Endpoints: `POST /api/contacts/parse` (file as base64 → rows), `POST /api/contacts/import` (`dryRun` for the preview), `GET /api/contacts`, `POST /api/invites/:token/sent`, `DELETE /api/people/:phone` (full erasure for data-deletion requests: contact, invites, link, and that person's webhook events; only an anonymous `{ deleted: true }` event is kept; their old link stops working).
- `src/store.js`: MongoDB when `MONGODB_URI` is set (collections `invites` keyed by token, `links` keyed by phone, `contacts` keyed by phone, `events`), else JSON file `data/db.json` (or `DB_FILE`).
- `public/index.html`: dashboard (login, create link, import list, People list with status filters / search / export, Activity tab, invite dialog with Next, How it works dialog).
- `api/index.js` + `vercel.json`: Vercel entry; rewrites `/api/*` and `/webhook` to the function, `public/` served static.
- `scripts/setup-instagram.js`: one-time token check, webhook field subscription, ice breaker. `scripts/simulate-webhooks.js`: offline test suite (35 checks).

## 4. Where things live

| Thing | Value |
|---|---|
| Live site | https://ig-handle-capture.vercel.app (Vercel project `ig-handle-capture`, team `ujjwals-projects-54e87179`, Hobby plan) |
| Webhook URL | https://ig-handle-capture.vercel.app/webhook |
| Meta app | **innoviti-assgn** (App ID 1954979475463528), Facebook-login flavour of the Instagram API (token starts `EAA`, host graph.facebook.com). Webhooks: Use cases → Instagram API → Webhooks → **Instagram** object; subscribed: messages, messaging_postbacks, messaging_referral. App is in **Development** mode. (The other app, Assgn_Innoviti, is not used.) |
| Business Instagram | @ig_280702 (IG account id in `IG_ACCOUNT_ID`) |
| Database | MongoDB Atlas free M0, database `ig_handle_capture`, Network Access 0.0.0.0/0 |
| Secrets | `.env` (local, git-ignored) and Vercel env vars: IG_USERNAME, IG_ACCOUNT_ID, IG_TOKEN, IG_APP_SECRET, IG_VERIFY_TOKEN, GRAPH_VERSION, MONGODB_URI, ADMIN_PASSWORD, JWT_SECRET, PUBLIC_URL. Get them on a new machine with `npx vercel env pull .env --environment=production`. |

## 5. How to work on it

- Local run: `npm install`, `npm start` → http://localhost:3000. With `MONGODB_URI` set this uses the **real** database.
- Offline tests: `DB_FILE=data/test-db.json MOCK_MODE=1 npm start`, then `npm run simulate` (logs in with `ADMIN_PASSWORD` from `.env`).
- Deploy: `npx vercel deploy --prod --yes`. After changing `.env`, push each changed variable with `npx vercel env add NAME production --force` (value on stdin), then redeploy.
- If the Meta app secret or verify token changes, update Vercel too, or every webhook is rejected (401).

## 6. Test record

- Real accounts linked: @i_am_uks_, @anshugoyal209, @kaamsekaambc, @rohit_yadav_mma (older flows, with manual help) and @riena.verma (final two-link flow, 12 s from "Start chat" to connected, no help).
- Live checks done: login, Meta handshake, signature rejection (401 unsigned / wrong key, 200 signed), Meta dashboard test webhook accepted, expiry rejection (local test with a 2 s TTL).

## 7. Open items / next steps

Blockers before real users:
1. Meta **business verification** (company documents), the slowest step.
2. **Privacy policy + data deletion** pages (required for App Review; DPDP Act).
3. **App Review** for messaging permissions, then switch the app to **Live** (today only role accounts are guaranteed delivery).
4. WhatsApp at scale: manual today; bulk from a normal number risks a ban; the Business Platform needs templates, opt-in, per-message cost, daily caps.

Known weaknesses: 3 taps across two apps; Step 1 can't be attributed to a phone; phone-only (ig.me fails on desktop); wrong account if several are logged in; built around Meta's first-contact bug; business inbox clutter; one shared admin password; no login rate limit; no alerts (Instagram API errors only show in Vercel logs).

Access token: `IG_TOKEN` is a **System User** token for innoviti-assgn (checked 7 Nov 2026 in the access token debugger): Expires Never, Data Access Expires Never. It breaks only if the system user or its asset access is removed in Business Settings. Its scopes include two the app doesn't use (`instagram_manage_comments`, `instagram_content_publish`); request only `instagram_basic` + `instagram_manage_messages` in App Review and regenerate the token with just those.

Parked by the user: hosting and database upgrades (Vercel Hobby is non-commercial; Atlas M0 limits; no indexes; events collection grows; dashboard polls everything every 4 s).

Deliverables: `Instagram-Handle-Capture-Full-Update.pptx` (9-slide combined deck in Innoviti branding: main update + contact list import + production challenges; use this one), plus the two decks it was merged from: `Instagram-Handle-Capture-Update.pptx` (10 slides) and `Instagram-Handle-Capture-Addon-Import.pptx` (8 slides), `DELIVERABLES.md` (older design doc; still describes the earlier one-link Twilio flow and needs a refresh).
