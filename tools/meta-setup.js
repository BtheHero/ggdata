// Connects the Facebook Page and Instagram account to the posting job (jobs/social.js), once: run it on your own computer.
//
//   node tools/meta-setup.js
//
// It asks for the Meta app's id and secret and a short-lived user token from the Graph API Explorer (see SOCIAL.md),
// swaps the token for a long-lived one, and prints, for each Page you manage: FB_PAGE_ID, FB_PAGE_TOKEN (a Page token
// made from a long-lived user token doesn't expire) and IG_USER_ID (the Instagram professional account linked to the
// Page). It can then post a test photo to the Page and to Instagram (public posts: you can delete them afterwards).
// Nothing is saved. Needs Node 18 or newer.
const readline = require("readline");
const GRAPH = "https://graph.facebook.com/" + (process.env.FB_GRAPH_VERSION || "v23.0");
const rl = readline.createInterface({ input: process.stdin });
const lines = [], waiting = [];
rl.on("line", l => { const w = waiting.shift(); if (w) w(l.trim()); else lines.push(l.trim()); });
rl.on("close", () => waiting.splice(0).forEach(w => w("")));
const ask = q => { process.stdout.write(q); return lines.length ? Promise.resolve(lines.shift()) : new Promise(r => waiting.push(r)); };

async function get(p, params) {
  const r = await fetch(GRAPH + p + "?" + new URLSearchParams(params));
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("GET " + p + " → " + (j.error ? j.error.message : r.status));
  return j;
}
async function post(p, params) {
  const r = await fetch(GRAPH + p, { method: "POST", body: new URLSearchParams(params) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("POST " + p + " → " + (j.error ? j.error.message : r.status));
  return j;
}

(async () => {
  console.log("Facebook & Instagram setup for GameDealTrack\n");
  const appId = await ask("Meta app ID: "), secret = await ask("Meta app secret: "), short = await ask("User token from the Graph API Explorer: ");

  console.log("\n1. Making the token long-lived…");
  const long = (await get("/oauth/access_token", { grant_type: "fb_exchange_token", client_id: appId, client_secret: secret, fb_exchange_token: short })).access_token;
  const scopes = ((await get("/debug_token", { input_token: long, access_token: appId + "|" + secret })).data || {}).scopes || [];
  console.log("   Permissions: " + scopes.join(", "));
  const need = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish"].filter(s => !scopes.includes(s));
  if (need.length) console.log("   Missing: " + need.join(", ") + " (add them in the Graph API Explorer and get a new token)");

  console.log("\n2. Your Pages:");
  const pages = (await get("/me/accounts", { fields: "id,name,access_token,instagram_business_account{id,username}", access_token: long })).data || [];
  if (!pages.length) { console.log("   None found. Is the Page ticked when you allowed access in the Graph API Explorer?"); rl.close(); return; }
  for (const p of pages) {
    const exp = ((await get("/debug_token", { input_token: p.access_token, access_token: appId + "|" + secret })).data || {}).expires_at;
    const ig = p.instagram_business_account;
    console.log("\n   " + p.name);
    console.log("   FB_PAGE_ID     " + p.id);
    console.log("   FB_PAGE_TOKEN  (" + (exp ? "expires " + new Date(exp * 1000).toISOString().slice(0, 10) : "never expires") + "), the whole next line:\n\n" + p.access_token + "\n");
    console.log("   IG_USER_ID     " + (ig ? ig.id + "   (@" + ig.username + ")" : "none: link a professional Instagram account to this Page first"));
  }

  const page = pages.length === 1 ? pages[0] : pages[Number(await ask("\nWhich Page is GameDealTrack? Number 1-" + pages.length + ": ")) - 1];
  if (!page) { rl.close(); return; }
  const img = "https://gamedealtrack.com/og.png", caption = "Every Xbox & PlayStation deal, the moment it drops 🎮\n\ngamedealtrack.com";
  if (/^y/i.test(await ask("\nPost a test photo to the Facebook Page \"" + page.name + "\" (public)? y/n: "))) {
    const r = await post("/" + page.id + "/photos", { url: img, caption, access_token: page.access_token });
    console.log("   Posted: https://www.facebook.com/" + (r.post_id || r.id));
  }
  const ig = page.instagram_business_account;
  if (ig && /^y/i.test(await ask("Post a test photo to Instagram @" + ig.username + " (public)? y/n: "))) {
    // Instagram takes JPEGs only: the same converter the job uses
    const jpg = "https://wsrv.nl/?url=" + encodeURIComponent(img) + "&w=1080&output=jpg&q=90";
    const c = await post("/" + ig.id + "/media", { image_url: jpg, caption, access_token: page.access_token });
    for (let i = 0; i < 12; i++) {
      const st = await get("/" + c.id, { fields: "status_code", access_token: page.access_token });
      if (st.status_code === "FINISHED") break;
      if (st.status_code === "ERROR") throw new Error("Instagram couldn't process the image");
      await new Promise(r => setTimeout(r, 5000));
    }
    const r = await post("/" + ig.id + "/media_publish", { creation_id: c.id, access_token: page.access_token });
    console.log("   Posted to Instagram (media " + r.id + ")");
  }
  console.log("\nAdd these as GitHub secrets in the ggdata repo: FB_PAGE_ID, FB_PAGE_TOKEN" + (ig ? ", IG_USER_ID" : "") + ".");
  rl.close();
})().catch(e => { console.log("\nFailed: " + e.message); rl.close(); });
