require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const jwt = require("jsonwebtoken");

const store = require("./store");
const ig = require("./instagram");
const importer = require("./importer");

const env = process.env;
const app = express();
app.set("trust proxy", 1); // behind Vercel: lets req.secure see the original https

// Keep the raw body so we can verify Meta's webhook signature.
// File uploads get a bigger limit, parsed only after the login check (see /api/contacts/parse).
const UPLOAD_PATH = "/api/contacts/parse";
const smallJson = express.json({ limit: "1mb", verify: (req, _res, buf) => (req.rawBody = buf) });
app.use((req, res, next) => (req.path === UPLOAD_PATH ? next() : smallJson(req, res, next)));
app.use(express.static(path.join(__dirname, "..", "public")));

// ---------------------------------------------------------------------------
// 0) Admin login: a password exchanged for a JWT in an httpOnly cookie
// ---------------------------------------------------------------------------
const SESSION_COOKIE = "session";
const SESSION_DAYS = 7;

function readCookie(req, name) {
  const pair = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(name + "="));
  return pair && decodeURIComponent(pair.slice(name.length + 1));
}

function samePassword(given, expected) {
  // Hash both so timingSafeEqual gets equal-length buffers.
  const h = (s) => crypto.createHash("sha256").update(String(s)).digest();
  return crypto.timingSafeEqual(h(given), h(expected));
}

app.post("/api/login", (req, res) => {
  if (!env.ADMIN_PASSWORD || !env.JWT_SECRET) {
    return res.status(500).json({ error: "Login isn't configured on the server (ADMIN_PASSWORD / JWT_SECRET)." });
  }
  if (!samePassword(req.body.password || "", env.ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "Wrong password." });
  }
  const token = jwt.sign({ role: "admin" }, env.JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: req.secure,
    maxAge: SESSION_DAYS * 86400 * 1000,
  });
  res.json({ ok: true });
});

app.post("/api/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

// Everything else under /api needs a valid session.
app.use("/api", (req, res, next) => {
  try {
    jwt.verify(readCookie(req, SESSION_COOKIE), env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Please log in." });
  }
});

// ---------------------------------------------------------------------------
// 1) Create invites. The admin shares the message on WhatsApp by hand.
// ---------------------------------------------------------------------------
// Numbers typed or imported without a country code get this one (DEFAULT_COUNTRY_CODE, default 91).
const COUNTRY_CODE = String(env.DEFAULT_COUNTRY_CODE || "91").replace(/\D/g, "") || "91";

function newToken() {
  // ig.me ref allows only [A-Za-z0-9_-=]; hex is safe and unguessable (48 bits)
  return "L" + crypto.randomBytes(6).toString("hex");
}

// Instagram drops the ref on a user's first-ever contact, so the invite has two links:
// the first only starts the chat, the second (with the ref) reopens the now-existing chat.
function startLink() {
  return `https://ig.me/m/${env.IG_USERNAME}`;
}

function inviteLink(token) {
  return `https://ig.me/m/${env.IG_USERNAME}?ref=${token}`;
}

// Invite links stop working this long after they're created (INVITE_TTL_HOURS, default 24).
// Each invite stores its own expiresAt, so changing the setting doesn't affect links already sent.
const TTL_HOURS = Number(env.INVITE_TTL_HOURS) > 0 ? Number(env.INVITE_TTL_HOURS) : 24;
const TTL_MS = TTL_HOURS * 3600 * 1000;
const ttlText = () =>
  TTL_HOURS < 1 ? `${Math.max(1, Math.round(TTL_HOURS * 60))} minutes`
  : TTL_HOURS % 24 === 0 && TTL_HOURS >= 48 ? `${TTL_HOURS / 24} days`
  : `${+TTL_HOURS.toFixed(1)} hours`;

// Invites created before expiry existed have no expiresAt; they count from createdAt.
const expiresAt = (invite) => invite.expiresAt || new Date(Date.parse(invite.createdAt) + TTL_MS).toISOString();
const isExpired = (invite) => Date.now() > Date.parse(expiresAt(invite));

function inviteMessage(token, name) {
  const first = String(name || "").trim().split(/[\s,;/]+/)[0];
  return (
    `Hi${first ? " " + first : ""}! Let's connect your Instagram account. It takes a few taps, no typing.\n` +
    `Please open these links on your phone; they don't work on a computer.\n\n` +
    `*Step 1:* Open our Instagram chat and tap "Start chat":\n${startLink()}\n\n` +
    `*Step 2:* Come back here and tap this link to finish:\n${inviteLink(token)}\n\n` +
    `Already chatted with us on Instagram before? Just tap the Step 2 link.\n` +
    `These links work for ${ttlText()}.`
  );
}

// Everything the admin page needs to share an invite.
function withLinks(invite) {
  return {
    ...invite,
    expiresAt: expiresAt(invite),
    startLink: startLink(),
    link: inviteLink(invite.token),
    message: inviteMessage(invite.token, invite.name),
  };
}

// Express 4 doesn't catch errors from async handlers; pass them to the error handler at the end.
const route = (fn) => (req, res, next) => fn(req, res).catch(next);

app.post("/api/invites", route(async (req, res) => {
  const { phone } = importer.normalizePhone(req.body.phone, COUNTRY_CODE);
  if (!phone) {
    return res.status(400).json({ error: "That doesn't look like a phone number. Example: +91 98765 43210" });
  }

  const contact = await store.getContact(phone);
  const now = Date.now();
  const invite = {
    token: newToken(),
    phone,
    name: contact?.name || null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TTL_MS).toISOString(),
    status: "pending",
  };
  await store.createInvite(invite);
  console.log(`INVITE  +${phone}  token=${invite.token}  ${inviteLink(invite.token)}`);
  res.json(withLinks(invite));
}));

// The admin opened the message in WhatsApp or copied it: the invite counts as sent.
app.post("/api/invites/:token/sent", route(async (req, res) => {
  const ok = await store.markSent(req.params.token, new Date().toISOString());
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "No such invite." });
}));

// ---------------------------------------------------------------------------
// 1b) Contacts imported from a CSV / Excel file, to invite one by one from the list
// ---------------------------------------------------------------------------
// Step 1: the browser sends the file (base64); we return its rows so the admin can pick the columns.
app.post(UPLOAD_PATH, express.json({ limit: "6mb" }), route(async (req, res) => {
  const { filename, data } = req.body || {};
  if (!data) return res.status(400).json({ error: "No file received." });
  try {
    res.json(await importer.parseUpload(filename, Buffer.from(String(data), "base64")));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Step 2: the chosen columns as [{ phone, name, row }]. With dryRun it only reports what would happen.
app.post("/api/contacts/import", route(async (req, res) => {
  const { rows, source, countryCode, dryRun } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: "Nothing to import." });
  if (rows.length > importer.MAX_ROWS) return res.status(400).json({ error: `Import at most ${importer.MAX_ROWS} rows at a time.` });

  const cc = String(countryCode ?? COUNTRY_CODE).replace(/\D/g, "");
  const seen = new Set(), valid = [], invalid = [];
  let duplicates = 0;
  rows.forEach((r, i) => {
    const n = importer.normalizePhone(r?.phone, cc);
    if (!n.phone) return invalid.push({ row: r?.row ?? i + 1, value: String(r?.phone ?? "").slice(0, 40), reason: n.error });
    if (seen.has(n.phone)) return duplicates++;
    seen.add(n.phone);
    valid.push({ phone: n.phone, name: String(r?.name ?? "").trim().slice(0, 80) || null, seq: valid.length });
  });

  const [contacts, links] = await Promise.all([store.listContacts(), store.listLinks()]);
  const known = new Set(contacts.map((c) => c.phone));
  const connected = new Set(links.map((l) => l.phone));
  const summary = {
    valid: valid.length,
    new: valid.filter((c) => !known.has(c.phone)).length,
    existing: valid.filter((c) => known.has(c.phone)).length,
    connected: valid.filter((c) => connected.has(c.phone)).length,
    duplicates,
    invalid: invalid.slice(0, 50),
    invalidCount: invalid.length,
  };
  if (dryRun) return res.json(summary);

  const result = await store.upsertContacts(valid, {
    source: String(source || "import").slice(0, 120),
    importedAt: new Date().toISOString(),
  });
  console.log(`IMPORT  ${result.added} added, ${result.updated} already listed, ${invalid.length} unreadable  (${source})`);
  res.json({ ...summary, ...result });
}));

app.get("/api/contacts", route(async (_req, res) => res.json(await store.listContacts())));
// Erase a person completely (data-deletion requests): contact, invites, Instagram link and their
// webhook events. Their old invite link stops working. Only an anonymous "deleted" note is kept.
app.delete("/api/people/:phone", route(async (req, res) => {
  const phone = String(req.params.phone).replace(/\D/g, "");
  const counts = await store.deletePerson(phone);
  if (!counts.contact && !counts.invites && !counts.link) return res.status(404).json({ error: "No one with that number." });
  await store.logEvent({ at: new Date().toISOString(), deleted: true });
  console.log(`DELETED a person: ${JSON.stringify(counts)}`);
  res.json({ ok: true, deleted: counts });
}));

app.get("/api/config", (_req, res) =>
  res.json({
    igUsername: env.IG_USERNAME,
    countryCode: COUNTRY_CODE,
    webhookUrl: `${env.PUBLIC_URL || ""}/webhook`,
    ttlText: ttlText(),
    mock: env.MOCK_MODE === "1",
  })
);
app.get("/api/invites", route(async (_req, res) => res.json((await store.listInvites()).map(withLinks))));
app.get("/api/links", route(async (_req, res) => res.json(await store.listLinks())));
app.get("/api/events", route(async (_req, res) => res.json(await store.listEvents())));

// ---------------------------------------------------------------------------
// 2) Webhook verification handshake (Meta calls this once when you save the URL)
// ---------------------------------------------------------------------------
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === env.IG_VERIFY_TOKEN) {
    console.log("Webhook verified by Meta");
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

// ---------------------------------------------------------------------------
// 3) Webhook events from Instagram
// ---------------------------------------------------------------------------
app.post("/webhook", async (req, res) => {
  if (!ig.verifySignature(req.rawBody, req.get("x-hub-signature-256"))) {
    console.warn("Rejected webhook: bad signature");
    return res.sendStatus(401);
  }

  // Process before replying: on Vercel the function can be frozen as soon as the response is sent.
  // Linking takes about a second, well within Meta's timeout.
  if (req.body.object === "instagram") {
    for (const entry of req.body.entry || []) {
      for (const ev of entry.messaging || []) {
        await handleEvent(ev, entry.id).catch((e) => console.error("Handling failed:", e.message));
      }
    }
  }
  res.sendStatus(200);
});

async function handleEvent(ev, ownAccountId) {
  const found = ig.extractReferral(ev, ownAccountId);
  await store.logEvent({ at: new Date().toISOString(), raw: ev, parsed: found });
  if (!found) return;
  console.log(`WEBHOOK ${found.kind}  igsid=${found.igsid}  ref=${found.ref ?? "-"}`);

  if (found.ref) return linkAccount(found);

  // No ref: Step 1, either "Start chat" tapped or a typed first message (Instagram drops the ref
  // on first contact). Point people who aren't linked yet to the Step 2 link.
  if (ev.postback?.payload === ig.ICEBREAKER.payload || ev.message) {
    if (await store.findLinkByIgsid(found.igsid)) return;
    console.log(`  chat started -> pointing user to the Step 2 link`);
    return ig.sendDM(found.igsid, "Thanks for starting the chat! 👋 To finish, go back to WhatsApp on your phone and tap the Step 2 link.");
  }
}

async function linkAccount({ igsid, ref, kind }) {
  let invite = await store.getInvite(ref);
  if (!invite) return console.log(`  ignored: unknown token ${ref}`);

  if (invite.status !== "linked") {
    if (isExpired(invite)) {
      console.log(`  REJECTED: token ${ref} expired at ${expiresAt(invite)}`);
      return ig.sendDM(igsid, "This link has expired. Please ask for a new one.");
    }
    const profile = await ig.getProfile(igsid);
    // Claiming is atomic, so two accounts racing for the same link can't both win.
    if (await store.claimInvite(ref, igsid, new Date().toISOString())) {
      await store.saveLink(invite.phone, {
        igsid,
        username: profile.username,
        name: profile.name || null,
        via: kind,
        token: ref,
        linkedAt: new Date().toISOString(),
      });
      console.log(`  LINKED  +${invite.phone}  ->  @${profile.username}  (IGSID ${igsid})`);
      return ig.sendDM(igsid, `All set ✅ Your Instagram @${profile.username} is now connected. You can close this chat.`);
    }
    invite = await store.getInvite(ref);
  }

  // Single use: the same person re-tapping is fine (idempotent); someone else is rejected.
  if (invite.igsid === igsid) return console.log(`  already linked (repeat tap)`);
  console.log(`  REJECTED: token ${ref} already used by another Instagram account (forwarded link?)`);
  return ig.sendDM(igsid, "This link has already been used. Please ask for a new one.");
}

// Last: turn unexpected errors (e.g. the database being unreachable) into a JSON 500 instead of a hung request.
app.use((err, _req, res, _next) => {
  console.error("Request failed:", err.message);
  res.status(500).json({ error: "Server error: " + err.message });
});

if (require.main === module) {
  const port = Number(env.PORT || 3000);
  app.listen(port, () => {
    console.log(`Server on http://localhost:${port}`);
    console.log(`Webhook URL: ${env.PUBLIC_URL || "<PUBLIC_URL>"}/webhook`);
    if (env.MOCK_MODE === "1") console.log("MOCK_MODE=1: no real Instagram calls");
  });
}

module.exports = app;
