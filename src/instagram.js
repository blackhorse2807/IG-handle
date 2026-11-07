// Instagram API with Instagram Login helpers.
const crypto = require("crypto");
const env = process.env;

function host() {
  if (env.IG_GRAPH_HOST) return env.IG_GRAPH_HOST;
  return (env.IG_TOKEN || "").startsWith("IG")
    ? "graph.instagram.com"
    : "graph.facebook.com";
}
const GRAPH = () => `https://${host()}/${env.GRAPH_VERSION || "v25.0"}`;
const ACCOUNT = () => env.IG_ACCOUNT_ID || "me";
// The one ice breaker shown in a brand-new chat (set by scripts/setup-instagram.js).
const ICEBREAKER = { question: "Start chat", payload: "START_CHAT" };

async function igFetch(path, options = {}) {
  const res = await fetch(`${GRAPH()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.IG_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok || data.error)
    throw new Error(
      `Instagram API error: ${JSON.stringify(data.error || data)}`,
    );
  return data;
}

// IGSID (Instagram-scoped user id from the webhook) -> { username, name }
async function getProfile(igsid) {
  if (env.MOCK_MODE === "1")
    return {
      id: igsid,
      username: `mock_user_${igsid.slice(-4)}`,
      name: "Mock User",
    };
  return igFetch(`/${igsid}?fields=username,name`);
}

async function sendDM(igsid, text) {
  if (env.MOCK_MODE === "1") {
    console.log(`[mock instagram dm] -> ${igsid}: ${text}`);
    return { mocked: true };
  }
  return igFetch(`/${ACCOUNT()}/messages`, {
    method: "POST",
    body: JSON.stringify({ recipient: { id: igsid }, message: { text } }),
  });
}

// Verifies X-Hub-Signature-256 = sha256(HMAC(app_secret, raw_body))
function verifySignature(rawBody, header) {
  if (!env.IG_APP_SECRET) return true; // not configured -> skip (dev only)
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = crypto
    .createHmac("sha256", env.IG_APP_SECRET)
    .update(rawBody)
    .digest("hex");
  const given = header.slice(7);
  return (
    given.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))
  );
}

// Pulls { igsid, ref, kind } out of one webhook messaging event, covering all 3 ig.me scenarios.
function extractReferral(ev, ownAccountId) {
  const igsid = ev.sender?.id;
  if (!igsid || igsid === ownAccountId) return null; // ignore our own echoes
  if (ev.message?.is_echo) return null;

  if (ev.referral?.ref)
    return {
      igsid,
      ref: ev.referral.ref,
      kind: "existing_thread (messaging_referral)",
    };
  if (ev.postback?.referral?.ref)
    return {
      igsid,
      ref: ev.postback.referral.ref,
      kind: "new_thread_icebreaker (messaging_postbacks)",
    };
  if (ev.message?.referral?.ref)
    return {
      igsid,
      ref: ev.message.referral.ref,
      kind: "new_thread_message (messages)",
    };
  return {
    igsid,
    ref: null,
    kind: ev.postback
      ? "postback_without_ref"
      : ev.message
        ? "message_without_ref"
        : "other",
  };
}

module.exports = {
  host,
  ACCOUNT,
  ICEBREAKER,
  igFetch,
  getProfile,
  sendDM,
  verifySignature,
  extractReferral,
};
