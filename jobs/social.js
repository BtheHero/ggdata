// Posts deals to social media: Bluesky, Facebook, Instagram, Pinterest and X (Twitter).
//
//   node jobs/social.js deals xbox|ps   after each store run: the big new deals (high deal score, a deep discount or a new
//                                       lowest price), each game once every REPOST_DAYS, at most SOCIAL_MAX_DEALS a run
//   node jobs/social.js weekly          once a week: the week's 5 best deals on Xbox and on PlayStation (data/weekly/…)
//
// What was posted is kept in data/social/<xbox|ps|weekly>-posted.json (uploaded with the other files), so a deal isn't
// posted again on the next run. One file per job, so the Xbox and PlayStation runs can't overwrite each other's.
//
// Each network posts only when its secrets are set; the others are skipped. SOCIAL_DRY_RUN=1 prints the posts and sends
// nothing (and remembers nothing). Secrets (GitHub repository secrets), see SOCIAL.md:
//   Bluesky    BSKY_HANDLE, BSKY_APP_PASSWORD
//   Facebook   FB_PAGE_ID, FB_PAGE_TOKEN (a never-expiring Page token)
//   Instagram  IG_USER_ID (the Instagram business account linked to the Facebook page; uses FB_PAGE_TOKEN)
//   Pinterest  PINTEREST_BOARD_ID, PINTEREST_APP_ID, PINTEREST_APP_SECRET, PINTEREST_REFRESH_TOKEN
//   X          X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET (paid per post: capped by X_DAILY_CAP)
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const DATA = path.resolve(process.env.DATA_DIR || "data");
const env = process.env, DRY = env.SOCIAL_DRY_RUN === "1";
const SITE = "https://gamedealtrack.com";
const GRAPH = "https://graph.facebook.com/" + (env.FB_GRAPH_VERSION || "v23.0");
const MIN_SCORE = Number(env.SOCIAL_MIN_SCORE || 85);   // deal score (0-100, gs/xbox.gs dealScore_) for a deal to be posted…
const MIN_PCT = Number(env.SOCIAL_MIN_PCT || 50);       // …and the discount it needs (a new lowest price needs 30%)
const MAX_DEALS = Number(env.SOCIAL_MAX_DEALS || 3);    // per run (two runs a day per store)
const REPOST_DAYS = 30;
const X_DAILY_CAP = Number(env.X_DAILY_CAP || 15);      // X bills every post: a cap on the spend
const PLAT = { xbox: { name: "Xbox", tags: ["Xbox", "XboxDeals", "GameDeals"] }, ps: { name: "PlayStation", tags: ["PlayStation", "PSDeals", "GameDeals"] } };

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")); } catch (e) { return d; } };
const write = (f, v) => { fs.mkdirSync(path.dirname(path.join(DATA, f)), { recursive: true }); fs.writeFileSync(path.join(DATA, f), JSON.stringify(v)); };
const today = () => new Date().toISOString().slice(0, 10);
const slug = t => String(t || "game").toLowerCase().normalize("NFKD").replace(/[™®©]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "game";
const pageUrl = (plat, id, title) => SITE + "/game/" + plat + "/" + encodeURIComponent(id) + "/" + slug(title);
const money = (n, cur) => (cur && cur !== "USD" ? cur + " " : "$") + Number(n).toFixed(2);
const pctOff = g => Math.round((1 - g.price / g.msrp) * 100);
const fullImg = u => !u ? "" : /^https?:/.test(u) ? u : u[0] === "~" ? "https://image.api.playstation.com/vulcan/ap/rnd/" + u.slice(1)
  : "https://store-images.s-microsoft.com/image/" + u;
// a JPEG of the game's art at a size every network takes (Instagram needs a JPEG; Bluesky needs it under 1 MB)
const jpeg = (u, w) => u ? "https://wsrv.nl/?url=" + encodeURIComponent(u) + "&w=" + w + "&h=" + w + "&fit=contain&cbg=000000&output=jpg&q=85" : "";
// the game's 16:9 hero art (the game page's banner), from the media files (jobs/media.js); "" when it has none
const SHARDS = 64, mediaCache = {};
const shardOf = id => { let h = 0; const s = String(id).toUpperCase(); for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0; return h % SHARDS; };
function heroOf(plat, id) {
  const f = "media/" + plat + "-" + shardOf(id) + ".json";
  if (!(f in mediaCache)) {
    let m = read(f, null);
    if (!m && env.R2) {   // not downloaded by this workflow: fetch just this file (outside data/, so it isn't uploaded again)
      const tmp = path.join(require("os").tmpdir(), "social-" + f.replace("/", "-"));
      try { require("child_process").execFileSync("aws", ["s3", "cp", "s3://ggdata/data/" + f, tmp, "--endpoint-url", env.R2, "--only-show-errors"]);
        m = JSON.parse(fs.readFileSync(tmp, "utf8")); } catch (e) { m = null; }
    }
    mediaCache[f] = (m && m.games) || {};
  }
  const e = mediaCache[f][id] || mediaCache[f][String(id).toUpperCase()];
  return e && e.h ? fullImg(e.h) : "";
}
const wide = (u, w) => u ? "https://wsrv.nl/?url=" + encodeURIComponent(u) + "&w=" + w + "&h=" + Math.round(w * 9 / 16) + "&fit=cover&output=jpg&q=85" : "";
// the picture a network shows: the hero art when the game has one (16:9), else the cover (square)
const pic = (p, w) => p.hero ? wide(p.hero, w) : jpeg(p.image, w);
const withUtm = (u, src) => u + (u.includes("?") ? "&" : "?") + "utm_source=" + src + "&utm_medium=social";
const endsText = e => e ? " · ends " + new Date(e).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";

// ---------- what to post ----------

const gameKey = t => String(t).toLowerCase().replace(/[™®©]/g, "").replace(/\b(standard|deluxe|ultimate|premium|gold|complete|definitive|digital|special|game of the year|goty|enhanced|anniversary|cross-gen)\b( edition| bundle)?/g, " ")
  .replace(/\bedition\b|\bbundle\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const ADDON_TITLE = /\b(season pass|dlc|expansion pass|soundtrack|costume|character pack|add-?on|upgrade|points|coins|currency|v-bucks|crowns)\b/i;
function dealPosts(plat) {
  const posted = read("social/" + plat + "-posted.json", {});
  const cutoff = new Date(Date.now() - REPOST_DAYS * 864e5).toISOString().slice(0, 10);
  const games = (read(plat + "_sales.json", { games: [] }).games || []).filter(g => {
    const price = Number(g.price) || 0, msrp = Number(g.msrp) || 0;
    if (!g.productId || !g.title || !(price > 0) || !(msrp > price) || ADDON_TITLE.test(g.title)) return false;
    if (g.saleEnds && Date.parse(g.saleEnds) <= Date.now() + 6 * 3600e3) return false;   // not one about to end
    if ((posted[g.productId] || "") > cutoff || (posted["t:" + gameKey(g.title)] || "") > cutoff) return false;
    const pct = (1 - price / msrp) * 100, ds = Number(g.dealScore) || 0;
    return ds >= MIN_SCORE && (pct >= MIN_PCT || (g.atLow && pct >= 30));
  }).sort((a, b) => b.dealScore - a.dealScore || (b.msrp - b.price) - (a.msrp - a.price));
  const seen = new Set(), picked = [];
  for (const g of games) {   // one edition per game
    const k = gameKey(g.title);
    if (seen.has(k)) continue;
    seen.add(k); picked.push(g);
    if (picked.length >= MAX_DEALS) break;
  }
  return {
    posts: picked.map(g => {
      const p = { price: Number(g.price), msrp: Number(g.msrp), currency: g.currency || "USD" }, pct = pctOff(p);
      const head = "🔥 " + g.title + ": " + pct + "% off on " + PLAT[plat].name;
      const line = money(p.price, p.currency) + " (was " + money(p.msrp, p.currency) + ")" + (g.atLow ? " · lowest price ever" : "") + endsText(g.saleEnds);
      return { key: g.productId, title: g.title + " – " + pct + "% off (" + PLAT[plat].name + ")", head, line,
        url: pageUrl(plat, g.productId, g.title), image: fullImg(g.sq || g.image), hero: heroOf(plat, g.productId), tags: PLAT[plat].tags };
    }),
    remember: keys => { picked.filter(g => keys.includes(g.productId)).forEach(g => { posted[g.productId] = posted["t:" + gameKey(g.title)] = today(); });
      Object.keys(posted).forEach(k => { if (posted[k] < cutoff) delete posted[k]; });
      write("social/" + plat + "-posted.json", posted); }
  };
}

function weeklyPosts() {
  const posted = read("social/weekly-posted.json", {}), posts = [];
  for (const plat of ["xbox", "ps"]) {
    const idx = read("weekly/" + plat + "-index.json", { weeks: [] }), wk = (idx.weeks || [])[0];
    if (!wk || (posted[plat] === wk.week && env.SOCIAL_FORCE !== "1")) continue;   // SOCIAL_FORCE=1: post again (a manual test)
    const week = read("weekly/" + plat + "-" + wk.week + ".json", { games: [] });
    const top = (week.games || []).filter(g => !(g.ends && Date.parse(g.ends) <= Date.now())).slice(0, 5);
    if (top.length < 3) continue;
    posts.push({ key: plat, week: wk.week, title: "This week's best " + PLAT[plat].name + " deals",
      head: "🎮 This week's best " + PLAT[plat].name + " deals",
      line: top.map((g, i) => (i + 1) + ". " + g.title + " " + money(g.price, g.currency) + " (-" + pctOff(g) + "%)").join("\n"),
      url: SITE + "/best-deals/" + plat, image: fullImg(top[0].sq || top[0].image), hero: heroOf(plat, top[0].id), tags: PLAT[plat].tags });
  }
  return { posts, remember: keys => { posts.filter(p => keys.includes(p.key)).forEach(p => { posted[p.key] = p.week; }); write("social/weekly-posted.json", posted); } };
}

// ---------- the networks ----------

const graphemes = s => [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].length;
function fit(parts, max) {   // head, line and hashtags, shortening the line when it's too long
  let [head, line, tail] = parts;
  const text = () => [head, line, tail].filter(Boolean).join("\n");
  while (graphemes(text()) > max && line.includes("\n")) line = line.split("\n").slice(0, -1).join("\n");
  if (graphemes(text()) > max) tail = "";
  return text();
}
async function ok(res, what) {
  const body = await res.text();
  if (!res.ok) throw new Error(what + " " + res.status + ": " + body.slice(0, 300));
  try { return JSON.parse(body); } catch (e) { return body; }
}

const NETWORKS = {
  bluesky: {
    ready: () => env.BSKY_HANDLE && env.BSKY_APP_PASSWORD,
    async post(p) {
      const host = env.BSKY_PDS || "https://bsky.social";
      const s = await ok(await fetch(host + "/xrpc/com.atproto.server.createSession", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: env.BSKY_HANDLE, password: env.BSKY_APP_PASSWORD }) }), "Bluesky login");
      const auth = { authorization: "Bearer " + s.accessJwt };
      const text = fit([p.head, p.line, p.tags.map(t => "#" + t).join(" ")], 300);
      // hashtags as facets (byte offsets), so they're clickable
      const facets = [], enc = new TextEncoder();
      for (const m of text.matchAll(/#(\w+)/g)) {
        const start = enc.encode(text.slice(0, m.index)).length;
        facets.push({ index: { byteStart: start, byteEnd: start + enc.encode(m[0]).length }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: m[1] }] });
      }
      const external = { uri: withUtm(p.url, "bluesky"), title: p.title, description: "Price history, deal score and where to play on GameDealTrack" };
      if (p.image) {
        try {
          const img = await fetch(pic(p, 1200));
          if (img.ok) {
            const blob = await ok(await fetch(host + "/xrpc/com.atproto.repo.uploadBlob", { method: "POST",
              headers: Object.assign({ "content-type": "image/jpeg" }, auth), body: Buffer.from(await img.arrayBuffer()) }), "Bluesky image");
            external.thumb = blob.blob;
          }
        } catch (e) { console.log("  Bluesky: no image (" + e.message + ")"); }
      }
      const r = await ok(await fetch(host + "/xrpc/com.atproto.repo.createRecord", { method: "POST", headers: Object.assign({ "content-type": "application/json" }, auth),
        body: JSON.stringify({ repo: s.did, collection: "app.bsky.feed.post", record: { $type: "app.bsky.feed.post", text, facets, createdAt: new Date().toISOString(),
          langs: ["en"], embed: { $type: "app.bsky.embed.external", external } } }) }), "Bluesky post");
      return r.uri;
    }
  },

  facebook: {
    ready: () => env.FB_PAGE_ID && env.FB_PAGE_TOKEN,
    async post(p) {
      const message = [p.head, p.line, "", withUtm(p.url, "facebook"), "", p.tags.map(t => "#" + t).join(" ")].join("\n");
      const body = new URLSearchParams({ access_token: env.FB_PAGE_TOKEN });
      if (p.image) { body.set("url", pic(p, 1200)); body.set("caption", message); }
      else { body.set("message", message); body.set("link", withUtm(p.url, "facebook")); }
      const r = await ok(await fetch(GRAPH + "/" + env.FB_PAGE_ID + (p.image ? "/photos" : "/feed"), { method: "POST", body }), "Facebook");
      return r.post_id || r.id;
    }
  },

  instagram: {
    ready: () => env.IG_USER_ID && env.FB_PAGE_TOKEN,
    async post(p) {
      if (!p.image) throw new Error("Instagram needs an image");
      // links in captions aren't clickable on Instagram: point to the link in the bio
      const caption = [p.head, p.line, "", "Link in bio: gamedealtrack.com", "", p.tags.concat(["VideoGames", "Gaming"]).map(t => "#" + t).join(" ")].join("\n");
      const c = await ok(await fetch(GRAPH + "/" + env.IG_USER_ID + "/media", { method: "POST",
        body: new URLSearchParams({ image_url: pic(p, 1080), caption, access_token: env.FB_PAGE_TOKEN }) }), "Instagram upload");
      for (let i = 0; i < 12; i++) {   // the image is fetched and processed by Instagram first
        const st = await ok(await fetch(GRAPH + "/" + c.id + "?fields=status_code&access_token=" + encodeURIComponent(env.FB_PAGE_TOKEN)), "Instagram status");
        if (st.status_code === "FINISHED") break;
        if (st.status_code === "ERROR" || st.status_code === "EXPIRED") throw new Error("Instagram couldn't process the image (" + st.status_code + ")");
        await new Promise(r => setTimeout(r, 5000));
      }
      const r = await ok(await fetch(GRAPH + "/" + env.IG_USER_ID + "/media_publish", { method: "POST",
        body: new URLSearchParams({ creation_id: c.id, access_token: env.FB_PAGE_TOKEN }) }), "Instagram publish");
      return r.id;
    }
  },

  pinterest: {
    ready: () => env.PINTEREST_BOARD_ID && env.PINTEREST_APP_ID && env.PINTEREST_APP_SECRET && env.PINTEREST_REFRESH_TOKEN,
    token: null,
    async post(p) {
      if (!p.image) throw new Error("Pinterest needs an image");
      if (!this.token) {   // access tokens last 30 days, the refresh token a year: get a fresh one each run
        const t = await ok(await fetch("https://api.pinterest.com/v5/oauth/token", { method: "POST",
          headers: { authorization: "Basic " + Buffer.from(env.PINTEREST_APP_ID + ":" + env.PINTEREST_APP_SECRET).toString("base64"),
            "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: env.PINTEREST_REFRESH_TOKEN }) }), "Pinterest token");
        this.token = t.access_token;
      }
      const r = await ok(await fetch("https://api.pinterest.com/v5/pins", { method: "POST",
        headers: { authorization: "Bearer " + this.token, "content-type": "application/json" },
        body: JSON.stringify({ board_id: env.PINTEREST_BOARD_ID, title: p.title.slice(0, 100), link: withUtm(p.url, "pinterest"),
          description: (p.line + "\n" + p.tags.map(t => "#" + t).join(" ")).slice(0, 500), alt_text: p.title.slice(0, 500),
          media_source: { source_type: "image_url", url: jpeg(p.image, 1000) } }) }), "Pinterest");
      return r.id;
    }
  },

  x: {
    ready: () => env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET,
    async post(p) {
      const log = read("social/x-log.json", {}), day = today();
      if ((log[day] || 0) >= X_DAILY_CAP) return "skipped (" + X_DAILY_CAP + " posts today, X_DAILY_CAP)";
      // links count as 23 characters on X
      const url = withUtm(p.url, "x"), tags = p.tags.slice(0, 2).map(t => "#" + t).join(" ");
      let text = fit([p.head, p.line, tags], 280 - 24) + "\n" + url;
      const api = "https://api.x.com/2/tweets";
      const o = { oauth_consumer_key: env.X_API_KEY, oauth_nonce: crypto.randomBytes(16).toString("hex"), oauth_signature_method: "HMAC-SHA1",
        oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_token: env.X_ACCESS_TOKEN, oauth_version: "1.0" };
      const pe = s => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
      const base = "POST&" + pe(api) + "&" + pe(Object.keys(o).sort().map(k => pe(k) + "=" + pe(o[k])).join("&"));
      o.oauth_signature = crypto.createHmac("sha1", pe(env.X_API_SECRET) + "&" + pe(env.X_ACCESS_SECRET)).update(base).digest("base64");
      const header = "OAuth " + Object.keys(o).sort().map(k => pe(k) + '="' + pe(o[k]) + '"').join(", ");
      const r = await ok(await fetch(api, { method: "POST", headers: { authorization: header, "content-type": "application/json" }, body: JSON.stringify({ text }) }), "X");
      log[day] = (log[day] || 0) + 1;
      Object.keys(log).forEach(d => { if (d < new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)) delete log[d]; });
      write("social/x-log.json", log);
      return r.data && r.data.id;
    }
  }
};

// ---------- run ----------

(async () => {
  const [mode, plat] = process.argv.slice(2);
  if (!(mode === "weekly" || (mode === "deals" && PLAT[plat]))) { console.log("usage: node jobs/social.js deals xbox|ps | weekly"); process.exit(1); }
  const job = mode === "weekly" ? weeklyPosts() : dealPosts(plat);
  const nets = Object.keys(NETWORKS).filter(n => NETWORKS[n].ready());
  console.log("Social " + mode + (plat ? " " + plat : "") + ": " + job.posts.length + " to post" +
              (DRY ? " (dry run)" : "") + "; networks: " + (nets.join(", ") || "none set up"));
  if (!job.posts.length) return;
  if (DRY || !nets.length) {
    job.posts.forEach(p => console.log("\n" + p.head + "\n" + p.line + "\n" + p.url + "\n  image: " + (p.image || p.hero ? pic(p, 1200) : "none")));
    return;
  }
  const done = [];
  for (const p of job.posts) {
    let any = false;
    for (const n of nets) {
      try { console.log("  " + n + ": " + p.title + " → " + await NETWORKS[n].post(p)); any = true; }
      catch (e) { console.log("  " + n + " failed: " + p.title + ": " + e.message); }
    }
    if (any) done.push(p.key);   // posted somewhere: don't post it again (a failed network just misses it)
  }
  job.remember(done);
  console.log("Posted " + done.length + " of " + job.posts.length);
})().catch(e => { console.error(e); process.exit(0); });   // never fail the store run over a post
