# Capturing a user's Instagram handle from their mobile number

## 1. Design strategy

### Problem

We know a user's mobile number. We want their Instagram ID and username, associated with that number, without the user typing their handle, and with no more than 3 clicks and 3 keystrokes.

### Key idea

Don't ask for the handle. Get the user to open a DM with our Instagram account; Instagram then tells us who they are. To know *which phone number* that person belongs to, the link they tap carries a one-time token that only we can map back to the number.

Two platform features make this possible:

* **WhatsApp** reaches the user by phone number, and only the owner of that number receives the message.
* **ig.me links with a `ref` parameter** (`https://ig.me/m/<account>?ref=<token>`) open a DM with our account and make Instagram send our webhook the user's Instagram-scoped ID (IGSID) together with the `ref` value.

### Flow

```
Backend                     WhatsApp (user's phone)        Instagram                    Backend
───────                     ───────────────────────        ─────────                    ───────
1. token ← random
   store token → phone
2. send link ─────────────► "Tap to link your Instagram"
                            3. user taps link ───────────► opens DM with our account
                                                           4. user taps "Link my account"
                                                              (only for a new chat)
                                                           5. webhook ────────────────► {IGSID, ref=token}
                                                                                        6. token → phone
                                                                                        7. GET /{IGSID}?fields=username,name
                                                                                        8. save phone ↔ IGSID ↔ @username
                                                           9. "Done ✅" DM ◄──────────── reply
```

### Instagram webhook cases handled

| Situation | Webhook event | Where the `ref` arrives |
|---|---|---|
| New conversation, user taps the ice breaker | `messaging_postbacks` | `postback.referral.ref` |
| Existing conversation (opening the link is enough) | `messaging_referral` | `referral.ref` |
| New conversation, user types a message instead | `messages` | `message.referral.ref` |

### User effort

| Step | Clicks | Keystrokes |
|---|---|---|
| Tap the link in WhatsApp | 1 | 0 |
| Confirm "Open in Instagram" (only on some phones) | 0–1 | 0 |
| Tap "Link my account" (only for a first-time chat) | 0–1 | 0 |
| **Total** | **1–3** | **0** |

### Data captured

`phone` (E.164 digits), `igsid` (Instagram-scoped user ID, stable for our account), `username`, `name`, how it was captured, timestamp, and the token used.

### Security and correctness decisions

* **Random, unguessable tokens** (48 bits) instead of the phone number in the link, so the URL leaks nothing. The `ref` format only allows letters, digits, `-`, `_` and `=`.
* **Single-use tokens.** If a different Instagram account uses an already-used token (for example, a forwarded link), it's rejected and the original mapping is kept. The same user tapping again is harmless.
* **24-hour expiry** limits the window for misuse.
* **Webhook signature check** (`X-Hub-Signature-256` with the app secret) rejects forged webhooks.
* **Echo filtering:** our own outgoing DMs aren't treated as user events.
* **Trust model:** possession of the WhatsApp message is treated as proof of owning the number. The remaining weakness is a user deliberately forwarding their link before using it; short expiry and single use limit this.

### Production notes

* WhatsApp: send through the Cloud API from a verified business, using an approved utility template with the link as a parameter. That allows messaging any opted-in user with no prior action. Cost in India is roughly ₹0.12 per message.
* Instagram: publish the Meta app (App Review for `instagram_business_manage_messages`) so the `ref` works for all users, not only app testers.
* Storage: replace the JSON file with a database.

### Constraints met during the build

* Meta WhatsApp Cloud API: the new business account was restricted pending business verification (error **131031 "Business Account locked"**). The Cloud API sender was therefore removed for now, and the test run used the **Twilio WhatsApp sandbox**, which requires a one-time `join` message from the test phone. That join is a sandbox-only step, not part of the production user flow.
* ig.me links don't work on Instagram Web, so the flow is mobile-only. This fits naturally, since the link arrives on the phone via WhatsApp.

## 2. Code

| File | Responsibility |
|---|---|
| `src/server.js` | `POST /api/invites` creates the token and sends WhatsApp; `GET/POST /webhook` handles Instagram verification and events; linking logic with single-use and expiry checks |
| `src/whatsapp.js` | Twilio sandbox sender |
| `src/instagram.js` | Profile lookup, DM reply, signature verification, extracting `ref` from all three event shapes |
| `src/store.js` | Invites, links and a raw webhook log |
| `scripts/setup-instagram.js` | Token check, webhook subscription, ice breaker |
| `scripts/simulate-webhooks.js` | Automated offline tests |
| `public/index.html` | Admin page |

## 3. Verification strategy

### A. Automated offline tests (`npm run simulate`, with `MOCK_MODE=1`)

Realistic webhook payloads are posted to the running server and the resulting mappings are asserted.

| # | Scenario | Expected |
|---|---|---|
| S1 | New thread, ice breaker tapped | Phone 1 linked to its IGSID |
| S2 | Existing thread, link opened | Phone 2 linked |
| S3 | New thread, user typed a message | Phone 3 linked |
| S4 | Forwarded link used by another account | Rejected; phone 1 mapping unchanged |
| S5 | Same user taps the same link again | No change |
| S6 | Unknown or tampered token | Ignored |
| S7 | Our own echo message | Ignored |
| S8 | Invalid phone number | HTTP 400 |
| Extra | Webhook with bad signature | HTTP 401 |
| Extra | Meta verification handshake | Returns `hub.challenge` |

Result at build time: **9 of 9 checks passed**, plus 401 on a bad signature and a correct handshake.

### B. Live end-to-end tests (real WhatsApp and Instagram)

| # | Test | How to check |
|---|---|---|
| L1 | First-time conversation | Fresh tester account: tap link, then ice breaker. Admin page shows the correct `@username`; "Done ✅" DM arrives. |
| L2 | Existing conversation | Same account, new invite: tap link only (1 click). Event type is `messaging_referral`. |
| L3 | Correctness | Username and name on the admin page match the account's profile. IGSID appears in the raw webhook log (`/api/events`). |
| L4 | Effort count | Screen recording: count taps and keystrokes from WhatsApp message to "Done ✅". |
| L5 | Two users, two numbers | Each number maps to its own account. |
| L6 | Reuse | Tap an already-used link from a different account: rejection DM, mapping unchanged. |

## 4. Test run

*Fill this in after the live run and attach screenshots or a screen recording.*

| Item | Value |
|---|---|
| Date | |
| Business Instagram account | @ |
| User Instagram account | @ |
| User phone | +91 |
| Invite token | |
| Webhook event received | |
| Captured IGSID | |
| Captured username | @ |
| Clicks / keystrokes by the user | / 0 |
| Result | |

**Evidence to attach**

1. Screen recording on the phone: WhatsApp message → tap → Instagram DM → "Link my account" → "Done ✅".
2. Server console showing the `INVITE`, `WEBHOOK` and `LINKED` lines.
3. Admin page showing the linked row.
4. `/api/events` output (raw webhook payload).
5. Output of `npm run simulate`.
6. Screenshots of the Meta WhatsApp restriction (error 131031) explaining the use of the Twilio sandbox.
