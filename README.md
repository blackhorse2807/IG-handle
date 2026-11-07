# Instagram handle capture

Capture and associate a user's Instagram ID and username with their phone number, without the user typing their handle.

**How it works:** the admin page creates a WhatsApp message for a phone number with a unique link (`https://ig.me/m/<your_account>?ref=<token>`), which you send to the user yourself. Tapping it opens a DM with your Instagram account. Instagram sends a webhook containing the user's Instagram-scoped ID and the `ref` token, the server looks up which phone number that token belongs to, fetches the username from the Instagram API, and saves `phone ↔ Instagram ID ↔ @username`.

See `DELIVERABLES.md` for the design, verification strategy and test-run record.

## Project layout

| Path | Purpose |
|---|---|
| `src/server.js` | Express server: admin login (JWT cookie), create invites, receive Instagram webhooks, link accounts |
| `src/instagram.js` | Instagram API calls: profile lookup, DM reply, signature check, webhook parsing |
| `src/store.js` | Storage: MongoDB when `MONGODB_URI` is set, otherwise the JSON file `data/db.json` |
| `src/importer.js` | Contact import: reads CSV / Excel (.xlsx) files and normalises phone numbers |
| `public/index.html` | Admin page: log in, create invite messages, track who has connected, read webhook activity in plain words |
| `api/index.js`, `vercel.json` | Vercel deployment: runs the Express app as one serverless function, serves `public/` as static files |
| `scripts/setup-instagram.js` | One-time: checks token, subscribes webhooks, sets the "Start chat" ice breaker |
| `scripts/simulate-webhooks.js` | Offline verification of all webhook scenarios |

## What you need

1. Node.js 18 or newer.
2. **Two Instagram accounts.** One is the *business* account (receives DMs). The other plays the *user* (taps the link). You can't DM yourself, so they must be different. Both can be logged in on the same phone using Instagram's account switcher.
3. Free Vercel and MongoDB Atlas accounts, to host the server at a public HTTPS URL that Instagram can send webhooks to.

## Setup

### 1. Install

```bash
npm install
cp .env.example .env
```

### 2. Instagram business account

In the Instagram app, on the business account:

1. **Settings → Account type and tools → Switch to professional account** (Creator or Business).
2. **Settings → Messages and story replies → Message controls → Connected tools → Allow access to messages:** turn on.

Put its handle (without `@`) in `.env` as `IG_USERNAME`.

### 3. Public URL

Instagram needs a public HTTPS address for webhooks, so the server runs on Vercel (see **Deploying to Vercel** below). Put the Vercel URL (e.g. `https://ig-handle-capture.vercel.app`) into `.env` as `PUBLIC_URL`.

### 4. Meta app: Instagram use case

At developers.facebook.com → your app (or a new app) → **Add use cases → Manage messaging & content on Instagram**, then open **API setup with Instagram login**:

1. Copy the app secret into `.env` as `IG_APP_SECRET`. Meta signs every webhook with it (`X-Hub-Signature-256`) and the server rejects any request whose signature doesn't match. With the Facebook-login setup it's the app's own secret (**App settings → Basic → App secret**); with Instagram login it's the **Instagram app secret** on that page.
2. **Generate access tokens → Add account**, log in with the business Instagram account, and copy the token (starts with `IG...`) into `.env` as `IG_TOKEN`.
3. **Configure webhooks:**
   * Callback URL: `<PUBLIC_URL>/webhook`
   * Verify token: the same value as `IG_VERIFY_TOKEN` in `.env`
   * Start the server first (`npm start`), then click **Verify and save**.
   * Subscribe to the fields **messages**, **messaging_postbacks** and **messaging_referral**.
4. **App roles → Roles → add the second ("user") Instagram account as an Instagram tester**, and accept the invite from that account. While the app is unpublished, Instagram only delivers `ref` webhooks for accounts with a role on the app.

### 5. One-time Instagram setup

```bash
npm run setup:instagram
```

This confirms the token, subscribes the account to the webhook fields, and creates the **"Start chat"** ice breaker. Tapping it is what turns a brand-new, empty chat into a real conversation.

## Run

```bash
npm start
```

Open `http://localhost:3000` and log in with `ADMIN_PASSWORD` from `.env`. Enter the user's WhatsApp number and click **Create link**. Then either click **Open in WhatsApp** (opens a chat with that number with the message pre-typed) or **Copy message** and paste it into WhatsApp yourself. Either one marks the invite as **Sent**.

### Importing a list

**Import list** takes a `.csv` or `.xlsx` file (up to 3 MB / 5,000 rows) with one person per row. Pick the phone number column and, optionally, a name column; both are guessed from the column titles. Numbers without a country code get `DEFAULT_COUNTRY_CODE` (91 unless set). Before anything is saved, the dialog shows how many numbers are new, already listed or already connected, which ones repeat, and which rows can't be read (for example `9.19877E+11`, which Excel produces when a long number isn't formatted as text). Old `.xls` files must be saved again as `.xlsx` or CSV.

Importing doesn't message anyone, and no links are created yet: links expire, so each one is made when you press **Invite** on a row. The invite then greets the person by first name. After sending, **Next →** in the invite dialog moves on to the next person in the list who still needs a message.

**Delete** on any row erases that person completely: their number and name, invites, Instagram link and their activity records. Use it for data-deletion requests. Any link already sent to them stops working, and the Activity tab keeps only an anonymous "A person's data was deleted." note.

The **People** list has one row per phone number, with status **Not invited → Link ready → Sent → Connected** (or **Expired**), filters for each status, search by number, name or @username, and **Export** to download the rows shown as CSV (phone, name, status, Instagram handle and ID, and when each step happened).

Each invite link works for one Instagram account and expires after `INVITE_TTL_HOURS` (24 hours by default; set in `.env` / Vercel). Someone opening an expired Step 2 link gets "This link has expired. Please ask for a new one." and nothing is saved; use **New link** on that row in the dashboard. Each invite keeps the expiry it was created with, so changing the setting only affects new invites.

The message has two links, because Instagram drops the `ref` on a person's first-ever contact with the business account:

1. **Step 1 link** (no `ref`) opens the chat; the user taps **Start chat**. This creates the conversation. The server replies pointing them to Step 2. Typing a message instead of tapping the button works the same way.
2. **Step 2 link** (with the `ref`) reopens the now-existing chat. Instagram sends `messaging_referral` with the `ref`, and the server links the account.

Make sure Instagram is on the *user* account before tapping. Within a second or two the admin page shows `+91… → @handle`, and the user gets an "All set ✅" DM. Users who have chatted with the business before only need the Step 2 link.

Note: ig.me links don't work on Instagram Web; open the link on the phone.

## Offline verification (no accounts needed)

```bash
# terminal 1: mock mode, on a scratch data file so test invites stay out of the real data
DB_FILE=data/test-db.json MOCK_MODE=1 npm start
# terminal 2 (reads ADMIN_PASSWORD from .env to log in)
npm run simulate
```

On Windows PowerShell, use `$env:DB_FILE="data/test-db.json"; $env:MOCK_MODE=1; npm start` in terminal 1.

## Deploying to Vercel (free Hobby plan) with MongoDB Atlas (free M0)

Vercel has no permanent disk, so on Vercel the data lives in MongoDB.

1. **MongoDB Atlas:** create a free M0 cluster, a database user, and allow access from anywhere (`0.0.0.0/0`, since Vercel has no fixed IPs). Copy the connection string into `MONGODB_URI`.
2. **Vercel:** `npx vercel` from this folder links and deploys it. `api/index.js` runs the Express app; `public/` is served as static files (see `vercel.json`).
3. **Environment variables** (Vercel project → Settings → Environment Variables): `IG_USERNAME`, `IG_ACCOUNT_ID`, `IG_TOKEN`, `IG_APP_SECRET`, `IG_VERIFY_TOKEN`, `GRAPH_VERSION`, `MONGODB_URI`, `ADMIN_PASSWORD`, `JWT_SECRET`, and `PUBLIC_URL` (the Vercel URL). Redeploy after changing them.
4. **Meta webhook:** set the callback URL to `<vercel url>/webhook` with the same verify token, and click **Verify and save**.

The webhook handler finishes linking before it replies to Meta, because Vercel may freeze a function once its response is sent.
