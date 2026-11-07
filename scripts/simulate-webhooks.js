// Offline verification: fires realistic Instagram webhook payloads at a local server and checks
// the phone <-> Instagram mapping. Start the server with MOCK_MODE=1 first, ideally on a scratch
// data file so test invites don't mix with real ones:
//   DB_FILE=data/test-db.json MOCK_MODE=1 npm start     (in one terminal)
//   npm run simulate                                      (in another)
// Each run uses fresh random phone numbers and IDs, so it doesn't need an empty database.
require("dotenv").config();
const crypto = require("crypto");

const BASE = `http://localhost:${process.env.PORT || 3000}`;
const OWN_ID = "17841400000000000"; // our business account id (recipient)
const RUN = crypto.randomInt(100000, 999999); // makes this run's phones and IDs unique
const phone = (n) => `+91 9${RUN}${String(n).padStart(3, "0")}`; // 10 digits after +91
const digits = (n) => `919${RUN}${String(n).padStart(3, "0")}`;
const user = (n) => `77${RUN}${String(n).padStart(4, "0")}`;
let passed = 0, failed = 0, cookie = "";

const post = (path, body) => {
  const raw = JSON.stringify(body);
  const headers = { "Content-Type": "application/json", Cookie: cookie };
  if (process.env.IG_APP_SECRET) {
    headers["X-Hub-Signature-256"] =
      "sha256=" + crypto.createHmac("sha256", process.env.IG_APP_SECRET).update(raw).digest("hex");
  }
  return fetch(BASE + path, { method: "POST", headers, body: raw });
};
const get = (path) => fetch(BASE + path, { headers: { Cookie: cookie } }).then((r) => r.json());
const wrap = (ev) => ({ object: "instagram", entry: [{ id: OWN_ID, time: Date.now(), messaging: [ev] }] });
const base = (igsid) => ({ sender: { id: igsid }, recipient: { id: OWN_ID }, timestamp: Date.now() });
const refObj = (ref) => ({ ref, source: "SHORTLINK", type: "OPEN_THREAD" });
const hook = (ev) => post("/webhook", wrap(ev));
const startChat = (igsid) => hook({ ...base(igsid), postback: { title: "Start chat", payload: "START_CHAT" } });

function check(name, cond) {
  cond ? passed++ : failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
}

async function invite(p) {
  return (await post("/api/invites", { phone: p })).json();
}

(async () => {
  // Auth
  check("A1 API refuses requests without login (401)", (await post("/api/invites", { phone: phone(0) })).status === 401);
  check("A2 wrong password refused (401)", (await post("/api/login", { password: "wrong-" + RUN })).status === 401);
  const login = await post("/api/login", { password: process.env.ADMIN_PASSWORD });
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  check("A3 correct password logs in", login.status === 200 && cookie.startsWith("session="));
  check("A4 /api/reset no longer exists", (await post("/api/reset", {})).status === 404);

  // Scenario 1: new conversation, ice breaker postback that does carry the ref (the documented case)
  const a = await invite(phone(1));
  await hook({ ...base(user(1)), postback: { title: "Start chat", payload: "START_CHAT", referral: refObj(a.token) } });

  // Scenario 2: existing conversation, only a referral (messaging_referral)
  const b = await invite(phone(2));
  await hook({ ...base(user(2)), referral: refObj(b.token) });

  // Scenario 3: new conversation, typed message that carries the ref
  const c = await invite(phone(3));
  await hook({ ...base(user(3)), message: { mid: "m1", text: "hi", referral: refObj(c.token) } });

  // Scenario 4: forwarded link: a different Instagram user uses token A
  await hook({ ...base(user(9)), referral: refObj(a.token) });

  // Scenario 5: same user taps the same link again (idempotent)
  await hook({ ...base(user(1)), referral: refObj(a.token) });

  // Scenario 6: unknown / tampered token
  await hook({ ...base(user(6)), referral: refObj("Ldeadbeef0000") });

  // Scenario 7: our own echo message must be ignored
  await hook({ sender: { id: OWN_ID }, recipient: { id: user(1) }, message: { mid: "m2", text: "Done", is_echo: true } });

  // Scenario 8: bad phone number rejected
  const bad = await post("/api/invites", { phone: "123" });

  // Scenario 9: two-link flow as Instagram really behaves: Step 1 without ref, then Step 2 with ref
  const d = await invite(phone(4));
  await startChat(user(4));
  const afterStep1 = await get("/api/links");
  await hook({ ...base(user(4)), referral: refObj(d.token) });

  // Scenario 10: person types a message instead of tapping "Start chat" (no ref), then Step 2
  const e = await invite(phone(5));
  await hook({ ...base(user(5)), message: { mid: "m3", text: "hello" } });
  const afterTyped = await get("/api/links");
  await hook({ ...base(user(5)), referral: refObj(e.token) });

  // Scenario 11: two different accounts open the same link at the same moment: only one may win
  const f = await invite(phone(7));
  await Promise.all([hook({ ...base(user(71)), referral: refObj(f.token) }), hook({ ...base(user(72)), referral: refObj(f.token) })]);

  // Scenario 12: import a list. CSV with a header, a local number (no country code), a duplicate,
  // an Excel-mangled number and junk; then invite one of them and mark the invite sent.
  const local = `9${RUN}021`; // 10 digits, no country code
  const csv = `Name,Mobile\n"Riya, Verma",${phone(20)}\nAmit,${local}\nAmit again,+${digits(21)}\nBad,9.19877E+11\nJunk,hello\n`;
  const parsed = await (await post("/api/contacts/parse", { filename: "list.csv", data: Buffer.from(csv).toString("base64") })).json();
  const rows = (parsed.rows || []).slice(1).map((r, i) => ({ row: i + 2, name: r[0], phone: r[1] }));
  const dry = await (await post("/api/contacts/import", { rows, source: "list.csv", countryCode: "91", dryRun: true })).json();
  const contactsBefore = await get("/api/contacts");
  const imp = await (await post("/api/contacts/import", { rows, source: "list.csv", countryCode: "91" })).json();
  const again = await (await post("/api/contacts/import", { rows, source: "list.csv", countryCode: "91" })).json();
  const contacts = await get("/api/contacts");
  const xls = await post("/api/contacts/parse", { filename: "old.xls", data: Buffer.from("x").toString("base64") });
  const named = await invite(digits(20));
  const sent = await post(`/api/invites/${named.token}/sent`, {});
  const sentInvite = (await get("/api/invites")).find((i) => i.token === named.token);

  // Scenario 13: a fresh invite carries an expiry in the future and links normally
  const g = await invite(phone(8));
  await hook({ ...base(user(8)), referral: refObj(g.token) });

  // Scenario 14: data-deletion request for a connected person erases everything about them
  const delPhone = digits(30), delUser = user(30);
  await post("/api/contacts/import", { rows: [{ row: 2, phone: delPhone, name: "Delete Me" }], source: "del.csv" });
  const h = await invite(delPhone);
  await startChat(delUser);
  await hook({ ...base(delUser), referral: refObj(h.token) });
  const linkedBefore = (await get("/api/links")).some((l) => l.phone === delPhone);
  const delRes = await fetch(BASE + `/api/people/${delPhone}`, { method: "DELETE", headers: { Cookie: cookie } });
  const delBody = await delRes.json();
  const [dLinks, dInvites, dContacts, dEvents] = await Promise.all(["/api/links", "/api/invites", "/api/contacts", "/api/events"].map(get));
  await hook({ ...base(delUser), referral: refObj(h.token) }); // old link tapped again after deletion
  const relinked = (await get("/api/links")).some((l) => l.phone === delPhone || l.igsid === delUser);
  const del404 = (await fetch(BASE + `/api/people/${delPhone}`, { method: "DELETE", headers: { Cookie: cookie } })).status;

  const links = await get("/api/links");
  const byPhone = Object.fromEntries(links.map((l) => [l.phone, l]));
  const mine = links.filter((l) => l.phone.startsWith(`919${RUN}`));

  console.log("\n--- Results ---");
  check("S1 icebreaker postback with ref links phone 1", byPhone[digits(1)]?.igsid === user(1));
  check("S2 existing-thread referral links phone 2", byPhone[digits(2)]?.igsid === user(2));
  check("S3 message+referral links phone 3", byPhone[digits(3)]?.igsid === user(3));
  check("S4 forwarded link did NOT re-map phone 1", byPhone[digits(1)]?.igsid === user(1));
  check("S4 forwarded user not linked anywhere", !links.some((l) => l.igsid === user(9)));
  check("S6 unknown token created no link", !links.some((l) => l.igsid === user(6)));
  check("S7 echo created no link", !links.some((l) => l.igsid === OWN_ID));
  check("S8 invalid phone rejected with 400", bad.status === 400);
  check("S9 Step 1 alone links nothing", !afterStep1.some((l) => l.phone === digits(4)));
  check("S9 Step 2 after Step 1 links phone 4", byPhone[digits(4)]?.igsid === user(4));
  check("S10 typed message alone links nothing", !afterTyped.some((l) => l.phone === digits(5)));
  check("S10 Step 2 after typed message links phone 5", byPhone[digits(5)]?.igsid === user(5));
  check("S11 simultaneous claims: exactly one account linked", [user(71), user(72)].includes(byPhone[digits(7)]?.igsid));
  check("S12 CSV parsed (quoted comma kept in one cell)", parsed.rows?.[1]?.[0] === "Riya, Verma" && parsed.rows.length === 6);
  check("S12 dry run counts 2 valid, 1 duplicate, 2 unreadable", dry.valid === 2 && dry.duplicates === 1 && dry.invalidCount === 2);
  check("S12 dry run saves nothing", !contactsBefore.some((c) => c.phone === digits(20)));
  check("S12 import adds 2 contacts", imp.added === 2 && contacts.some((c) => c.phone === digits(20) && c.name === "Riya, Verma"));
  check("S12 number without country code gets +91", contacts.some((c) => c.phone === digits(21)));
  check("S12 importing again adds nothing", again.added === 0 && again.updated === 2);
  check("S12 .xls refused with a clear error", xls.status === 400);
  check("S12 invite for an imported contact greets by first name", named.message?.startsWith("Hi Riya!"));
  check("S12 invite marked as sent", sent.status === 200 && !!sentInvite?.sentAt);
  check("S13 new invite has a future expiresAt", Date.parse(g.expiresAt) > Date.now());
  check("S13 invite within its expiry links phone 8", byPhone[digits(8)]?.igsid === user(8));
  check("S14 person was connected before deletion", linkedBefore);
  check("S14 delete reports contact, invite and link removed", delRes.status === 200 && delBody.deleted?.contact === 1 && delBody.deleted?.invites === 1 && delBody.deleted?.link === 1);
  check("S14 nothing left in links, invites or contacts", !dLinks.some((l) => l.phone === delPhone) && !dInvites.some((i) => i.phone === delPhone) && !dContacts.some((c) => c.phone === delPhone));
  check("S14 their activity is erased, only an anonymous note remains", !dEvents.some((e) => JSON.stringify(e).includes(delUser) || JSON.stringify(e).includes(h.token)) && dEvents.some((e) => e.deleted));
  check("S14 their old link no longer works", !relinked);
  check("S14 deleting again returns 404", del404 === 404);
  check("Usernames resolved for every link", mine.every((l) => !!l.username));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("Simulation error (is the server running with MOCK_MODE=1?)", e.message);
  process.exit(1);
});
