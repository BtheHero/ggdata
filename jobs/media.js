// Screenshots, trailers, key art and genres of every game, kept in the bucket so the site doesn't ask the stores
// each time a game page or pop-up opens. Only the links are kept: the pictures and videos stay on the stores' servers.
//
//   data/media/xbox-<n>.json, data/media/ps-<n>.json: {updatedAt, games: {game id: entry}}, the games split in the
//   same 64 groups as the game pages (shardOf). entry: {s: [screenshots], v: [[trailer url, title, poster]],
//   h: key art (16:9), g: [genres], r: release date (yyyy-mm-dd), t: day looked up (yyyymmdd)}. A release date
//   that has passed is kept as it is; an upcoming one is updated (release dates can move before launch). Xbox picture names are short (the site adds
//   https://store-images.s-microsoft.com/image/), PlayStation's start with "~" (https://image.api.playstation.com/vulcan/ap/rnd/).
//
// Xbox: Microsoft's catalog answers for 20 games at once, so every game is refreshed on every run (about 800 requests).
// PlayStation: one request per game, so each run does up to PS_MAX: new games first (upcoming and released in the
// last NEW_DAYS days, refreshed every day: stores add trailers and screenshots around launch), then games without
// media (on sale, then the most popular), then the ones looked up longest ago.
const fs = require("fs"), path = require("path");
const rt = require("../runtime/appsscript");

const SHARDS = 64;
const SHOTS_MAX = 8, VIDEOS_MAX = 4;
const PS_MAX = Number(process.env.PS_MEDIA_MAX) || 3000;
const PS_STALE_DAYS = 14;
const NEW_DAYS = 30;
const XBOX_IMG = "https://store-images.s-microsoft.com/image/", PS_IMG = "https://image.api.playstation.com/vulcan/ap/rnd/";
const PS_GQL = "https://web.np.playstation.com/api/graphql/v1/op";
const PS_PRODUCT_HASH = "a128042177bd93dd831164103d53b73ef790d56f51dae647064cb8f9d9fc9d1a";   // metGetProductById, as the store uses it

// Same as GamePages.gs shardOf_ and the site's shardOf
function shardOf(id) {
  let h = 0;
  const s = String(id).toUpperCase();
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h % SHARDS;
}
const today = () => Number(new Date().toISOString().slice(0, 10).replace(/-/g, ""));
const daysAgo = n => Number(new Date(Date.now() - n * 864e5).toISOString().slice(0, 10).replace(/-/g, ""));
const uniq = (x, i, a) => x && a.indexOf(x) === i;
const abs = u => u && u.startsWith("//") ? "https:" + u : u;
const xShort = u => { u = abs(u) || ""; return u.startsWith(XBOX_IMG) ? u.slice(XBOX_IMG.length) : u; };
const psShort = u => { u = String(u || "").split("?")[0]; return u.startsWith(PS_IMG) ? "~" + u.slice(PS_IMG.length) : u; };
// a store date as yyyy-mm-dd ("" for none or the stores' "no date yet" years like 9998)
const ymd = d => { const s = String(d || "").slice(0, 10); return /^(19[7-9]\d|20\d\d)-\d\d-\d\d$/.test(s) ? s : ""; };
// the release date to keep: one that has passed doesn't change
const keepRel = (oldR, newR) => oldR && oldR <= new Date().toISOString().slice(0, 10) ? oldR : newR || oldR || "";
const isNew = r => !!r && r >= new Date(Date.now() - NEW_DAYS * 864e5).toISOString().slice(0, 10);
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return fallback; } };

function loadShards(dir, plat) {
  const all = {};
  for (let n = 0; n < SHARDS; n++) Object.assign(all, (readJson(path.join(dir, plat + "-" + n + ".json"), {}).games) || {});
  return all;
}
function saveShards(dir, plat, all) {
  fs.mkdirSync(dir, { recursive: true });
  const shards = Array.from({ length: SHARDS }, () => ({}));
  Object.keys(all).forEach(id => { shards[shardOf(id)][id] = all[id]; });
  const now = new Date().toISOString();
  shards.forEach((games, n) => fs.writeFileSync(path.join(dir, plat + "-" + n + ".json"), JSON.stringify({ updatedAt: now, games })));
}

// ---------- Xbox ----------
function xboxEntry(p) {
  const lp = (p.LocalizedProperties || [])[0] || {};
  const imgs = lp.Images || [];
  const e = { t: today() };
  e.s = imgs.filter(x => x.ImagePurpose === "Screenshot" && x.Uri).map(x => xShort(x.Uri)).filter(uniq).slice(0, SHOTS_MAX);
  e.v = (lp.CMSVideos || []).filter(v => v && /^https:/.test(v.HLS || "")).slice(0, VIDEOS_MAX)
    .map((v, i) => [v.HLS, i ? "Trailer " + (i + 1) : "Trailer", xShort(v.PreviewImage && v.PreviewImage.Uri)]);
  const hero = imgs.find(x => x.ImagePurpose === "SuperHeroArt") || imgs.find(x => x.ImagePurpose === "TitledHeroArt");
  if (hero && hero.Uri) e.h = xShort(hero.Uri);
  const props = p.Properties || {};
  e.g = (props.Categories || (props.Category ? [props.Category] : [])).filter(uniq);
  const r = ymd(((p.MarketProperties || [])[0] || {}).OriginalReleaseDate);
  if (r) e.r = r;
  return e;
}
function xboxMedia(dataDir) {
  const cat = readJson(path.join(dataDir, "xbox_catalog.json"), { games: [] }).games || [];
  const sales = readJson(path.join(dataDir, "xbox_sales.json"), { games: [] }).games || [];
  const ids = cat.map(r => String(r[0] || "").toUpperCase()).concat(sales.map(g => String(g.productId || "").toUpperCase()))
    .filter(id => /^[A-Z0-9]{12}$/.test(id)).filter(uniq);
  if (!ids.length) { console.log("Xbox: no game list yet (run the Xbox job first)"); return; }
  const dir = path.join(dataDir, "media"), old = loadShards(dir, "xbox"), out = {};
  const batches = [];
  for (let i = 0; i < ids.length; i += 20) batches.push(ids.slice(i, i + 20));
  let found = 0, failed = 0;
  for (let i = 0; i < batches.length; i += 10) {
    const group = batches.slice(i, i + 10);
    const res = UrlFetchApp.fetchAll(group.map(b => ({
      url: "https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=" + b.join(",") + "&market=US&languages=en-US&MS-CV=DGU1mcuYo0WMMp%2BF.1",
      muteHttpExceptions: true
    })));
    group.forEach((b, k) => {
      let d = null;
      try { if (res[k].getResponseCode() === 200) d = JSON.parse(res[k].getContentText()); } catch (e) {}
      if (!d) { failed += b.length; return; }
      (d.Products || []).forEach(p => {
        if (!p.ProductId) return;
        const id = String(p.ProductId).toUpperCase(), e = xboxEntry(p), r = keepRel(old[id] && old[id].r, e.r);
        if (r) e.r = r;
        out[id] = e;
        found++;
      });
    });
  }
  // a game the store didn't answer for keeps what it had
  let kept = 0;
  ids.forEach(id => { if (!out[id] && old[id]) { out[id] = old[id]; kept++; } });
  if (!found) { console.log("Xbox: the store didn't answer, keeping the previous files"); return; }
  saveShards(dir, "xbox", out);
  const n = Object.keys(out).length, w = k => Object.values(out).filter(e => e[k] && e[k].length).length;
  console.log("Xbox media: " + n + " of " + ids.length + " games (" + found + " looked up, " + kept + " kept from before, " + failed +
              " not answered). With screenshots " + w("s") + ", with trailers " + w("v") + ". " + batches.length + " requests.");
}

// ---------- PlayStation ----------
function psRequest(productId) {
  return {
    url: PS_GQL + "?operationName=metGetProductById&variables=" + encodeURIComponent(JSON.stringify({ productId })) +
      "&extensions=" + encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: PS_PRODUCT_HASH } })),
    headers: { "x-psn-store-locale-override": "en-US", "content-type": "application/json" }, muteHttpExceptions: true
  };
}
function psEntry(prod) {
  const concept = prod.concept || {};
  const media = (prod.media || []).concat(concept.media || []);   // the edition's first, then the whole game's
  const e = { t: today() };
  e.s = media.filter(m => m.role === "SCREENSHOT" && m.type === "IMAGE" && m.url).map(m => psShort(m.url)).filter(uniq).slice(0, SHOTS_MAX);
  e.v = media.filter(m => m.type === "VIDEO" && /^https:/.test(m.url || "")).map(m => m.url).filter(uniq).slice(0, VIDEOS_MAX)
    .map((u, i) => [u, i ? "Trailer " + (i + 1) : "Trailer", e.s[i] || ""]);
  const wide = list => { list = list || []; const m = list.find(x => x.role === "GAMEHUB_COVER_ART") || list.find(x => x.role === "BACKGROUND_LAYER_ART"); return m && m.url; };
  const h = wide(concept.media) || wide(prod.media);
  if (h) e.h = psShort(h);
  e.g = (prod.combinedLocalizedGenres || concept.combinedLocalizedGenres || []).map(x => x.value).filter(uniq);
  const r = ymd(prod.releaseDate || concept.releaseDate);
  if (r) e.r = r;
  return e;
}
function psMedia(dataDir, srcDir) {
  // the game pages' PlayStation games: the full game list (whole games, looked up by their main product) and the
  // games on sale that aren't one of those
  const cat = readJson(path.join(srcDir, "ps_catalog.json"), { games: [] }).games || [];
  const sales = readJson(path.join(srcDir, "ps_sales.json"), { games: [] }).games || [];
  if (!cat.length && !sales.length) { console.log("PlayStation: no game list (SOURCE_API not set?)"); return; }
  const games = [], inCat = {};
  cat.forEach(r => { if (r[0] && r[13]) { games.push({ id: String(r[0]), pid: String(r[13]), rank: Number(r[7]) || 1e9, sale: 0 }); inCat[r[13]] = 1; } });
  sales.forEach(g => { if (g.productId && !inCat[g.productId]) games.push({ id: String(g.productId), pid: String(g.productId), rank: Number(g.rank) || 1e9, sale: 1 }); });
  const ids = {};
  games.forEach(g => { ids[g.id] = 1; });
  const dir = path.join(dataDir, "media"), out = loadShards(dir, "ps");
  Object.keys(out).forEach(id => { if (!ids[id]) delete out[id]; });   // games that left the store
  // new games: the home page's upcoming and recently released rows, and games whose saved release date is recent
  const home = readJson(path.join(srcDir, "ps_home.json"), { sections: {} }).sections || {};
  const fresh = {};
  ["upcoming", "recent", "newest"].forEach(k => (home[k] || []).forEach(e => { if (e.id) fresh[e.id] = 1; if (e.pid) fresh[e.pid] = 1; }));
  games.forEach(g => { g.fresh = !!(fresh[g.id] || fresh[g.pid] || (out[g.id] && isNew(out[g.id].r))); });
  const stale = daysAgo(PS_STALE_DAYS), now = today();
  // looked up before release dates were kept (no "r" at all; "" = the store has none): once more, after the games without media
  const noRel = g => out[g.id] && !("r" in out[g.id]);
  const due = g => !out[g.id] || noRel(g) || out[g.id].t < (g.fresh ? now : stale);   // new games: once a day
  const order = g => g.fresh ? 0 : !out[g.id] ? 1 : noRel(g) ? 2 : 3;
  const need = games.filter(due)
    .sort((a, b) => (order(a) - order(b)) || (out[a.id] ? out[a.id].t - out[b.id].t : 0) || (b.sale - a.sale) || (a.rank - b.rank))
    .slice(0, PS_MAX);
  console.log("PlayStation: " + games.filter(g => g.fresh).length + " new games (looked up first, every day)");
  let found = 0, failed = 0;
  for (let i = 0; i < need.length; i += 10) {
    const group = need.slice(i, i + 10);
    const res = UrlFetchApp.fetchAll(group.map(g => psRequest(g.pid)));
    group.forEach((g, k) => {
      let prod = null;
      try { const j = JSON.parse(res[k].getContentText()); prod = j && j.data && j.data.productRetrieve; } catch (e) {}
      if (!prod) { failed++; return; }
      const e = psEntry(prod);
      e.r = keepRel(out[g.id] && out[g.id].r, e.r);   // "" when the store has none
      out[g.id] = e;
      found++;
    });
    if (failed > 200 && failed > found) { console.log("PlayStation: too many failures, stopping for this run"); break; }
    Utilities.sleep(300);
  }
  saveShards(dir, "ps", out);
  const n = Object.keys(out).length, w = k => Object.values(out).filter(e => e[k] && e[k].length).length;
  console.log("PlayStation media: " + n + " of " + games.length + " games (" + found + " looked up this run, " + failed + " failed). " +
              "With screenshots " + w("s") + ", with trailers " + w("v") + ". Still to look up: " + games.filter(g => !out[g.id]).length);
}

module.exports = { xboxMedia, psMedia, shardOf };
