// Storage. Uses MongoDB when MONGODB_URI is set (needed on Vercel, which has no persistent disk);
// otherwise a local JSON file (data/db.json, or DB_FILE). Both expose the same async API.
const fs = require("fs");
const path = require("path");

const EVENT_LIMIT = 50;

// ---------------------------------------------------------------------------
// JSON file backend (local development)
// ---------------------------------------------------------------------------
function fileStore(file) {
  let db;
  try {
    db = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    db = { invites: {}, links: {}, events: [] };
  }
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
