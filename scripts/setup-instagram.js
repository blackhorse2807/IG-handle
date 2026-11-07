require("dotenv").config();
const { host, ACCOUNT, ICEBREAKER, igFetch } = require("../src/instagram");

async function step(name, fn) {
  try {
    const out = await fn();
    console.log(`OK  ${name}:`, JSON.stringify(out));
    return out;
  } catch (e) {
    console.log(`ERR ${name}: ${e.message}`);
  }
}

(async () => {
  const id = ACCOUNT();
  console.log(`Using host ${host()} and account ${id}\n`);
  const me = await step("Account check", () => igFetch(`/${id}?fields=id,username`));
  await step("Subscribe webhook fields", () =>
    igFetch(`/${id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,messaging_referral`, { method: "POST" })
  );
  await step("Set ice breaker", () =>
    igFetch(`/${id}/messenger_profile`, {
      method: "POST",
      body: JSON.stringify({
        platform: "instagram",
        ice_breakers: [{ locale: "default", call_to_actions: [ICEBREAKER] }],
      }),
    })
  );
  await step("Read ice breakers", () => igFetch(`/${id}/messenger_profile?fields=ice_breakers&platform=instagram`));
  console.log(`\nInvite links look like: https://ig.me/m/${me?.username || process.env.IG_USERNAME}?ref=<token>`);
})();
