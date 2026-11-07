// Storage. Uses MongoDB when MONGODB_URI is set (needed on Vercel, which has no persistent disk);
// otherwise a local JSON file (data/db.json, or DB_FILE). Both expose the same async API.
const fs = require("fs");
const path = require("path");

const EVENT_LIMIT = 50;

function eventIsAbout(e, igsid, tokens) {
  const ids = [e.parsed?.igsid, e.raw?.sender?.id, e.raw?.recipient?.id];
  return (igsid && ids.includes(igsid)) || tokens.includes(e.parsed?.ref);
}

// ---------------------------------------------------------------------------
// JSON file backend (local development)
// ---------------------------------------------------------------------------
function fileStore(file) {
  let db;
  try {
    db = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    db = {};
  }
  db = { invites: {}, links: {}, events: [], contacts: {}, ...db };
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(db, null, 2));
  };

  return {
    async createInvite({ token, ...inv }) {
      db.invites[token] = inv;
      save();
    },
    async getInvite(token) {
      const inv = db.invites[token];
      return inv && { token, ...inv };
    },
    // Marks the invite linked to this igsid unless it's already linked. Returns true if this call claimed it.
    async claimInvite(token, igsid, usedAt) {
      const inv = db.invites[token];
      if (!inv || inv.status === "linked") return false;
      db.invites[token] = { ...inv, status: "linked", igsid, usedAt };
      save();
      return true;
    },
    async markSent(token, sentAt) {
      const inv = db.invites[token];
      if (!inv) return false;
      if (!inv.sentAt) db.invites[token] = { ...inv, sentAt };
      save();
      return true;
    },
    async listInvites() {
      return Object.entries(db.invites)
        .map(([token, v]) => ({ token, ...v }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async saveLink(phone, data) {
      db.links[phone] = data;
      save();
    },
    async listLinks() {
      return Object.entries(db.links).map(([phone, v]) => ({ phone, ...v }));
    },
    async findLinkByIgsid(igsid) {
      return (await this.listLinks()).find((l) => l.igsid === igsid);
    },
    // contacts: [{ phone, name, seq }]. New phones are added; existing ones get a new name only if one is given.
    async upsertContacts(contacts, { source, importedAt }) {
      let added = 0, updated = 0;
      for (const { phone, name, seq } of contacts) {
        const old = db.contacts[phone];
        if (old) {
          updated++;
          if (name) db.contacts[phone] = { ...old, name };
        } else {
          added++;
          db.contacts[phone] = { name: name || null, source, importedAt, seq };
        }
      }
      save();
      return { added, updated };
    },
    async getContact(phone) {
      const c = db.contacts[phone];
      return c && { phone, ...c };
    },
    async listContacts() {
      return Object.entries(db.contacts).map(([phone, v]) => ({ phone, ...v }));
    },
    // Erases everything about one phone number: contact, invites, Instagram link, and webhook
    // events from that Instagram account or carrying one of its invite codes.
    async deletePerson(phone) {
      const igsid = db.links[phone]?.igsid;
      const tokens = Object.keys(db.invites).filter((t) => db.invites[t].phone === phone);
      const counts = {
        contact: phone in db.contacts ? 1 : 0,
        invites: tokens.length,
        link: phone in db.links ? 1 : 0,
      };
      delete db.contacts[phone];
      delete db.links[phone];
      tokens.forEach((t) => delete db.invites[t]);
      const before = db.events.length;
      db.events = db.events.filter((e) => !eventIsAbout(e, igsid, tokens));
      counts.events = before - db.events.length;
      save();
      return counts;
    },
    async logEvent(evt) {
      db.events.unshift(evt);
      db.events = db.events.slice(0, EVENT_LIMIT);
      save();
    },
    async listEvents() {
      return db.events;
    },
  };
}

// ---------------------------------------------------------------------------
// MongoDB backend (Vercel). The client is cached across invocations of a warm function.
// ---------------------------------------------------------------------------
function mongoStore(uri) {
  const { MongoClient } = require("mongodb");
  // A failed connection is forgotten so the next request retries instead of reusing the error.
  const client = () =>
    (global._mongo ??= new MongoClient(uri, { serverSelectionTimeoutMS: 8000 }).connect().catch((err) => {
      global._mongo = null;
      throw err;
    }));
  const col = async (name) => (await client()).db(process.env.MONGODB_DB || "ig_handle_capture").collection(name);
  const fromDoc = (key) => ({ _id, ...rest }) => ({ [key]: _id, ...rest });

  return {
    async createInvite({ token, ...inv }) {
      await (await col("invites")).insertOne({ _id: token, ...inv });
    },
    async getInvite(token) {
      const doc = await (await col("invites")).findOne({ _id: token });
      return doc && fromDoc("token")(doc);
    },
    async claimInvite(token, igsid, usedAt) {
      const res = await (await col("invites")).updateOne(
        { _id: token, status: { $ne: "linked" } },
        { $set: { status: "linked", igsid, usedAt } }
      );
      return res.modifiedCount === 1;
    },
    async markSent(token, sentAt) {
      const c = await col("invites");
      const res = await c.updateOne({ _id: token, sentAt: { $exists: false } }, { $set: { sentAt } });
      return res.matchedCount === 1 || !!(await c.findOne({ _id: token }, { projection: { _id: 1 } }));
    },
    async listInvites() {
      return (await (await col("invites")).find().sort({ createdAt: -1 }).toArray()).map(fromDoc("token"));
    },
    async saveLink(phone, data) {
      await (await col("links")).replaceOne({ _id: phone }, data, { upsert: true });
    },
    async listLinks() {
      return (await (await col("links")).find().toArray()).map(fromDoc("phone"));
    },
    async findLinkByIgsid(igsid) {
      const doc = await (await col("links")).findOne({ igsid });
      return doc && fromDoc("phone")(doc);
    },
    async upsertContacts(contacts, { source, importedAt }) {
      if (!contacts.length) return { added: 0, updated: 0 };
      const res = await (await col("contacts")).bulkWrite(
        contacts.map(({ phone, name, seq }) => ({
          updateOne: {
            filter: { _id: phone },
            update: {
              $setOnInsert: { source, importedAt, seq, ...(name ? {} : { name: null }) },
              ...(name ? { $set: { name } } : {}),
            },
            upsert: true,
          },
        })),
        { ordered: false }
      );
      return { added: res.upsertedCount, updated: res.matchedCount };
    },
    async getContact(phone) {
      const doc = await (await col("contacts")).findOne({ _id: phone });
      return doc && fromDoc("phone")(doc);
    },
    async listContacts() {
      return (await (await col("contacts")).find().toArray()).map(fromDoc("phone"));
    },
    async deletePerson(phone) {
      const [contacts, invites, links, events] = await Promise.all(["contacts", "invites", "links", "events"].map(col));
      const igsid = (await links.findOne({ _id: phone }))?.igsid;
      const tokens = (await invites.find({ phone }, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
      const about = [{ "parsed.ref": { $in: tokens } }];
      if (igsid) about.push({ "parsed.igsid": igsid }, { "raw.sender.id": igsid }, { "raw.recipient.id": igsid });
      const [c, i, l, e] = await Promise.all([
        contacts.deleteOne({ _id: phone }),
        invites.deleteMany({ phone }),
        links.deleteOne({ _id: phone }),
        events.deleteMany({ $or: about }),
      ]);
      return { contact: c.deletedCount, invites: i.deletedCount, link: l.deletedCount, events: e.deletedCount };
    },
    async logEvent(evt) {
      await (await col("events")).insertOne(evt);
    },
    async listEvents() {
      return (await (await col("events")).find({}, { projection: { _id: 0 } }).sort({ at: -1 }).limit(EVENT_LIMIT).toArray());
    },
  };
}

module.exports = process.env.MONGODB_URI
  ? mongoStore(process.env.MONGODB_URI)
  : fileStore(process.env.DB_FILE || path.join(__dirname, "..", "data", "db.json"));
