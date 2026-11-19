// Posts deals to social media: Bluesky, Facebook, Instagram, Pinterest and X (Twitter).
//
//   node jobs/social.js deals xbox|ps   after each store run: the big deals on well-known, well-reviewed games (a deep
//                                       discount, a high Metascore, many store ratings), each game once every REPOST_DAYS,
//                                       at most SOCIAL_MAX_DEALS a run
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
//   Pinterest  BUFFER_API_KEY, BUFFER_PINTEREST_CHANNEL_ID (through Buffer; PINTEREST_BOARD_ID picks the board), or else
//              PINTEREST_BOARD_ID, PINTEREST_APP_ID, PINTEREST_APP_SECRET, PINTEREST_REFRESH_TOKEN (or PINTEREST_ACCESS_TOKEN: ~30 days)
//   X          BUFFER_API_KEY, BUFFER_X_CHANNEL_ID (through Buffer), or else X's own API: X_API_KEY, X_API_SECRET,
//              X_ACCESS_TOKEN, X_ACCESS_SECRET (paid per post). Either way at most X_DAILY_CAP posts a day
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const DATA = path.resolve(process.env.DATA_DIR || "data");
const env = Object.assign({}, process.env), DRY = env.SOCIAL_DRY_RUN === "1";
// secrets pasted from a terminal can carry line breaks (a wrapped line), spaces or a note after them: keep just the value
["FB_PAGE_ID", "FB_PAGE_TOKEN", "IG_USER_ID", "BSKY_HANDLE", "PINTEREST_BOARD_ID", "PINTEREST_APP_ID", "PINTEREST_REFRESH_TOKEN",
 "PINTEREST_ACCESS_TOKEN", "BUFFER_API_KEY", "BUFFER_X_CHANNEL_ID", "BUFFER_PINTEREST_CHANNEL_ID", "X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"].forEach(k => {
  if (env[k]) env[k] = env[k].replace(/\([^)]*\)/g, "").replace(/[\s"']+/g, "");
});
// a Meta Page token starts with "EAA": drop anything pasted before it (like the "FB_PAGE_TOKEN" label)
if (env.FB_PAGE_TOKEN && env.FB_PAGE_TOKEN.indexOf("EAA") > 0) env.FB_PAGE_TOKEN = env.FB_PAGE_TOKEN.slice(env.FB_PAGE_TOKEN.indexOf("EAA"));
const shape = v => v ? v.length + " characters, " + (/^EAA/.test(v) ? "starts with EAA (good)" : "does NOT start with EAA") : "empty";
const SITE = "https://gamedealtrack.com";
const GRAPH = "https://graph.facebook.com/" + (env.FB_GRAPH_VERSION || "v23.0");
const MIN_PCT = Number(env.SOCIAL_MIN_PCT || 75);       // a deal is posted with at least this discount…
const MIN_MC = Number(env.SOCIAL_MIN_METASCORE || 83);  // …a Metascore of at least this…
const MIN_RATINGS = Number(env.SOCIAL_MIN_RATINGS || 2000);   // …and at least this many ratings in the store
const MAX_DEALS = Number(env.SOCIAL_MAX_DEALS || 3);    // per run (two runs a day per store)
const REPOST_DAYS = 7;    // a game is posted at most once a week
const PIN_API = env.PINTEREST_API || "https://api.pinterest.com";   // Trial apps can be pointed at https://api-sandbox.pinterest.com
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
// a data file: from data/ when this workflow downloaded it, else fetched on its own (outside data/, so it isn't uploaded again)
function load(f) {
  let m = read(f, null);
  if (!m && env.R2) {
    const tmp = path.join(require("os").tmpdir(), "social-" + f.replace(/\//g, "-"));
    try { require("child_process").execFileSync("aws", ["s3", "cp", "s3://ggdata/data/" + f, tmp, "--endpoint-url", env.R2, "--only-show-errors"]);
      m = JSON.parse(fs.readFileSync(tmp, "utf8")); } catch (e) { m = null; }
  }
  return m;
}
// PlayStation media is kept by the game's catalog id (ps_catalog.json row [0]), deals carry the product id (row [13])
let psIds = null;
const psGameId = pid => {
  if (!psIds) { psIds = {}; ((load("ps_catalog.json") || {}).games || []).forEach(r => { if (r[0] && r[13]) psIds[r[13]] = String(r[0]); }); }
  return psIds[pid] || pid;
};
function heroOf(plat, id) {
  const ids = plat === "ps" ? [psGameId(id), id] : [id];
  for (const k of ids) {
    const f = "media/" + plat + "-" + shardOf(k) + ".json";
    if (!(f in mediaCache)) mediaCache[f] = (load(f) || {}).games || {};
    const e = mediaCache[f][k] || mediaCache[f][String(k).toUpperCase()];
    if (e && e.h) return fullImg(e.h);
  }
  return "";
}
const wide = (u, w) => u ? "https://wsrv.nl/?url=" + encodeURIComponent(u) + "&w=" + w + "&h=" + Math.round(w * 9 / 16) + "&fit=cover&output=jpg&q=85" : "";
// the picture a network shows: the hero art when the game has one (16:9), else the cover (square)
// the weekly roundup's own pictures (jobs/social-card.js): a tall one (Instagram, Pinterest) and a wide one (Bluesky, Facebook)
const cardOf = (plat, week) => {
  const c = {};
  ["tall", "wide"].forEach(shape => { const name = plat + "-" + week + "-" + shape + ".jpg", file = path.join(DATA, "social", "img", name);
    if (fs.existsSync(file)) c[shape] = { file, url: SITE + "/social-img/" + name }; });
  return c.tall || c.wide ? c : null;
};
const pic = (p, w, shape) => {
  const c = p.card && (p.card[shape] || p.card.wide || p.card.tall);
  return c ? c.url : p.hero ? wide(p.hero, w) : jpeg(p.image, w);
};
const withUtm = (u, src) => u + (u.includes("?") ? "&" : "?") + "utm_source=" + src + "&utm_medium=social";
const endsLine = e => e ? "⏰ Sale ends " + new Date(e).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }) : "";
// the game's Metascore and number of store ratings, from its game page (data/<plat>_games_<n>.json, gs/gamepages.gs:
// mc, ra = [stars, count]), else the Metascore from <plat>_scores.json. A page that only points to another (a) is followed.
const pageCache = {};
let scoreFile = null;
function reviewsOf(plat, id) {
  let mc = 0, rc = 0;
  const page = k => {
    const f = plat + "_games_" + shardOf(k) + ".json";
    if (!(f in pageCache)) pageCache[f] = (load(f) || {}).games || {};
    return pageCache[f][k] || pageCache[f][String(k).toUpperCase()] || null;
  };
  for (const k of plat === "ps" ? [id, psGameId(id)] : [id]) {
    let g = page(k);
    if (g && g.a && !g.ra && !g.mc) g = page(g.a) || g;
    if (!g) continue;
    mc = mc || (Array.isArray(g.mc) ? Number(g.mc[0]) : Number(g.mc)) || 0;
    rc = Math.max(rc, (g.ra && Number(g.ra[1])) || 0);
  }
  if (!mc) {
    if (!scoreFile) scoreFile = load(plat === "ps" ? "ps_scores.json" : "scores.json") || {};
    const v = scoreFile[id] || scoreFile[String(id).toUpperCase()];
    mc = (Array.isArray(v) ? Number(v[0]) : Number(v)) || 0;
  }
  return { mc, rc };
}

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
    if ((1 - price / msrp) * 100 < MIN_PCT) return false;
    g.rev = reviewsOf(plat, g.productId);
    return g.rev.mc >= MIN_MC && g.rev.rc >= MIN_RATINGS;
  }).sort((a, b) => b.rev.mc - a.rev.mc || b.rev.rc - a.rev.rc);
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
      const line = [money(p.price, p.currency) + " (was " + money(p.msrp, p.currency) + ")" + (g.atLow ? " · lowest price ever" : ""), endsLine(g.saleEnds)].filter(Boolean).join("\n");
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
      head: "🎮 This week's best " + PLAT[plat].name + " deals\n",   // a blank line before the list
      line: top.map((g, i) => (i + 1) + ". " + g.title + " " + money(g.price, g.currency) + " (-" + pctOff(g) + "%)").join("\n"),
      url: SITE + "/best-deals/" + plat, image: fullImg(top[0].sq || top[0].image), hero: heroOf(plat, top[0].id), card: cardOf(plat, wk.week), tags: PLAT[plat].tags });
  }
  return { posts, remember: keys => { posts.filter(p => keys.includes(p.key)).forEach(p => { posted[p.key] = p.week; }); write("social/weekly-posted.json", posted); } };
}

// ---------- the networks ----------

const graphemes = s => [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].length;
function fit(parts, max) {   // head, line and hashtags; when too long, without the hashtags, then shortening the line
  let [head, line, tail] = parts;
  const text = () => [head, line, tail].filter(Boolean).join("\n");
  if (graphemes(text()) > max) tail = "";   // the hashtags go first, then the line's last parts
  while (graphemes(text()) > max && line.includes("\n")) line = line.split("\n").slice(0, -1).join("\n");
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
      if (p.card || p.image) {
        try {
          const card = p.card && (p.card.wide || p.card.tall);   // the roundup's picture: from the file, it's made in this run
          const img = card ? null : await fetch(pic(p, 1200, "wide"));
          const bytes = card ? fs.readFileSync(card.file) : img.ok ? Buffer.from(await img.arrayBuffer()) : null;
          if (bytes) {
            const blob = await ok(await fetch(host + "/xrpc/com.atproto.repo.uploadBlob", { method: "POST",
              headers: Object.assign({ "content-type": "image/jpeg" }, auth), body: bytes }), "Bluesky image");
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
      if (p.card || p.image) { body.set("url", pic(p, 1200, "wide")); body.set("caption", message); }
      else { body.set("message", message); body.set("link", withUtm(p.url, "facebook")); }
      const r = await ok(await fetch(GRAPH + "/" + env.FB_PAGE_ID + (p.card || p.image ? "/photos" : "/feed"), { method: "POST", body }), "Facebook");
      return r.post_id || r.id;
    }
  },

  instagram: {
    ready: () => env.IG_USER_ID && env.FB_PAGE_TOKEN,
    async post(p) {
      if (!p.card && !p.image) throw new Error("Instagram needs an image");
      // links in captions aren't clickable on Instagram: point to the link in the bio
      const caption = [p.head, p.line, "", "Link in bio: gamedealtrack.com", "", p.tags.concat(["VideoGames", "Gaming"]).map(t => "#" + t).join(" ")].join("\n");
      const c = await ok(await fetch(GRAPH + "/" + env.IG_USER_ID + "/media", { method: "POST",
        body: new URLSearchParams({ image_url: pic(p, 1080, "tall"), caption, access_token: env.FB_PAGE_TOKEN }) }), "Instagram upload");
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
    // a refresh token (with the app's id and secret) lasts a year; PINTEREST_ACCESS_TOKEN alone works until it expires (about 30 days)
    // or through Buffer: BUFFER_API_KEY and BUFFER_PINTEREST_CHANNEL_ID (the board: PINTEREST_BOARD_ID, else the channel's first board)
    ready: () => (env.BUFFER_API_KEY && env.BUFFER_PINTEREST_CHANNEL_ID) || env.PINTEREST_BOARD_ID && ((env.PINTEREST_APP_ID && env.PINTEREST_APP_SECRET && env.PINTEREST_REFRESH_TOKEN) || env.PINTEREST_ACCESS_TOKEN),
    token: env.PINTEREST_REFRESH_TOKEN ? null : env.PINTEREST_ACCESS_TOKEN || null,
    async post(p) {
      if (!p.card && !p.image) throw new Error("Pinterest needs an image");
      const link = withUtm(p.url, "pinterest"), description = (p.line + "\n" + p.tags.map(t => "#" + t).join(" ")).slice(0, 500);
      const image = p.card ? pic(p, 1000, "tall") : jpeg(p.image, 1000);
      if (env.BUFFER_API_KEY && env.BUFFER_PINTEREST_CHANNEL_ID) {
        if (!this.board) this.board = env.PINTEREST_BOARD_ID || await bufferBoard(env.BUFFER_PINTEREST_CHANNEL_ID);
        return viaBuffer(env.BUFFER_PINTEREST_CHANNEL_ID, description, image, p.title,
          { pinterest: { boardServiceId: this.board, title: p.title.slice(0, 100), url: link } });
      }
      if (!this.token) {   // access tokens last 30 days, the refresh token a year: get a fresh one each run
        const t = await ok(await fetch(PIN_API + "/v5/oauth/token", { method: "POST",
          headers: { authorization: "Basic " + Buffer.from(env.PINTEREST_APP_ID + ":" + env.PINTEREST_APP_SECRET).toString("base64"),
            "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: env.PINTEREST_REFRESH_TOKEN }) }), "Pinterest token");
        this.token = t.access_token;
      }
      const r = await ok(await fetch(PIN_API + "/v5/pins", { method: "POST",
        headers: { authorization: "Bearer " + this.token, "content-type": "application/json" },
        body: JSON.stringify({ board_id: env.PINTEREST_BOARD_ID, title: p.title.slice(0, 100), link, description, alt_text: p.title.slice(0, 500),
          media_source: { source_type: "image_url", url: image } }) }), "Pinterest");
      return r.id;
    }
  },

  x: {
    ready: () => (env.BUFFER_API_KEY && env.BUFFER_X_CHANNEL_ID) || (env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET),
    async post(p) {
      const log = read("social/x-log.json", {}), day = today();
      if ((log[day] || 0) >= X_DAILY_CAP) return "skipped (" + X_DAILY_CAP + " posts today, X_DAILY_CAP)";
      // links count as 23 characters on X
      const url = withUtm(p.url, "x"), tags = p.tags.slice(0, 2).map(t => "#" + t).join(" ");
      let text = fit([p.head, p.line, tags], 280 - 24) + "\n" + url;
      let id;
      if (env.BUFFER_API_KEY && env.BUFFER_X_CHANNEL_ID) id = await viaBuffer(env.BUFFER_X_CHANNEL_ID, text, p.card || p.image || p.hero ? pic(p, 1200, "wide") : "", p.title);
      else id = await viaX(text);
      log[day] = (log[day] || 0) + 1;
      Object.keys(log).forEach(d => { if (d < new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)) delete log[d]; });
      write("social/x-log.json", log);
      return id;
    }
  }
};

// Buffer's API (api.buffer.com, GraphQL), for X and Pinterest: Buffer posts right away, with the picture. On X, X's own
// per-post fees don't apply; on Pinterest, no Pinterest app (or its Standard access review) is needed.
async function buffer(query, variables) {
  const r = await ok(await fetch("https://api.buffer.com", { method: "POST", headers: { authorization: "Bearer " + env.BUFFER_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }) }), "Buffer");
  if (r.errors) throw new Error("Buffer: " + r.errors.map(e => e.message).join("; "));
  return r.data;
}
async function viaBuffer(channelId, text, image, alt, metadata) {
  const input = { channelId, text, mode: "shareNow", schedulingType: "automatic", needsApproval: false, source: "gamedealtrack",
    assets: image ? [{ image: { url: image, metadata: { altText: String(alt || "").slice(0, 400) } } }] : [] };
  if (metadata) input.metadata = metadata;
  const d = await buffer("mutation($input: CreatePostInput!) { createPost(input: $input) { __typename ... on PostActionSuccess { post { id } } ... on MutationError { message } } }", { input });
  const c = d && d.createPost;
  if (!c || c.__typename !== "PostActionSuccess") throw new Error("Buffer " + (c ? c.__typename + ": " + c.message : "no answer"));
  return "Buffer post " + c.post.id;
}
async function bufferBoard(channelId) {   // the Pinterest channel's first board
  const d = await buffer("query($id: ChannelId!) { channel(input: { id: $id }) { metadata { ... on PinterestMetadata { boards { serviceId name } } } } }", { id: channelId });
  const b = d.channel && d.channel.metadata && d.channel.metadata.boards && d.channel.metadata.boards[0];
  if (!b) throw new Error("Buffer: the Pinterest channel has no board");
  return b.serviceId;
}

// X's own API (paid per post), signed with OAuth 1.0a
async function viaX(text) {
      const api = "https://api.x.com/2/tweets";
      const o = { oauth_consumer_key: env.X_API_KEY, oauth_nonce: crypto.randomBytes(16).toString("hex"), oauth_signature_method: "HMAC-SHA1",
        oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_token: env.X_ACCESS_TOKEN, oauth_version: "1.0" };
      const pe = s => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
      const base = "POST&" + pe(api) + "&" + pe(Object.keys(o).sort().map(k => pe(k) + "=" + pe(o[k])).join("&"));
      o.oauth_signature = crypto.createHmac("sha1", pe(env.X_API_SECRET) + "&" + pe(env.X_ACCESS_SECRET)).update(base).digest("base64");
      const header = "OAuth " + Object.keys(o).sort().map(k => pe(k) + '="' + pe(o[k]) + '"').join(", ");
      const r = await ok(await fetch(api, { method: "POST", headers: { authorization: header, "content-type": "application/json" }, body: JSON.stringify({ text }) }), "X");
      return r.data && r.data.id;
}

// ---------- run ----------

(async () => {
  const [mode, plat] = process.argv.slice(2);
  if (!(mode === "weekly" || (mode === "deals" && PLAT[plat]))) { console.log("usage: node jobs/social.js deals xbox|ps | weekly"); process.exit(1); }
  const job = mode === "weekly" ? weeklyPosts() : dealPosts(plat);
  const only = (env.SOCIAL_ONLY || "").toLowerCase().split(/[\s,]+/).filter(Boolean);   // a manual test on some networks only
  const nets = Object.keys(NETWORKS).filter(n => NETWORKS[n].ready() && (!only.length || only.includes(n)));
  console.log("Social " + mode + (plat ? " " + plat : "") + ": " + job.posts.length + " to post" +
              (DRY ? " (dry run)" : "") + "; networks: " + (nets.join(", ") || "none set up"));
  if (!job.posts.length) return;
  if (DRY || !nets.length) {
    job.posts.forEach(p => console.log("\n" + p.head + "\n" + p.line + "\n" + p.url + "\n  image: " + (p.card || p.image || p.hero ? pic(p, 1200, "wide") + (p.card && p.card.tall ? "  and  " + p.card.tall.url : "") : "none")));
    return;
  }
  if (nets.includes("facebook") || nets.includes("instagram"))   // what the Meta secrets look like, without showing them
    console.log("FB_PAGE_TOKEN: " + shape(env.FB_PAGE_TOKEN) + "; FB_PAGE_ID: " + (/^\d+$/.test(env.FB_PAGE_ID || "") ? "a number (good)" : "not a number") +
                "; IG_USER_ID: " + (!env.IG_USER_ID ? "not set" : /^\d+$/.test(env.IG_USER_ID) ? "a number (good)" : "not a number"));
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
