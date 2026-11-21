// PlayStation posters (run.js jobs "ps" and "psmorning", after the deals and the full game list are saved).
//
// The site shows covers in a 2:3 poster frame. A PlayStation game's cover is the store's PORTRAIT_BANNER (psImage_),
// but the store has none for about a third of the games (Red Dead Redemption 2, Minecraft, Street Fighter 6…): their
// cover is then the square art, cropped by the frame. For those, a real portrait cover, in this order:
//   1. the PlayStation Store's own, on the product rather than on the game's page (Street Fighter 6's is on its
//      Standard Edition): the deal's own product; for a game, its main product, else another edition with the game's
//      own name (not another game sold on the page: Red Dead Online on Red Dead Redemption 2's)
//   2. the same game's Xbox cover, when it is portrait (jobs/media.js checks the sizes: data/xbox_posters.json), by name
// Otherwise the square art stays. Every file's covers are swapped by their square art (ps_sales.json, ps_catalog.json,
// ps_home.json), so the game pages, lists and home rows built from them get the poster too.
//
// The products' art is looked up a part at a time (POSTER_MAX a run, the most popular first) and kept in
// data/ps_posters.json {p: {product id: [portrait url or "", checked ms, name]}}; a product without one is asked again
// after POSTER_RECHECK_DAYS (publishers add art).
const fs = require("fs"), path = require("path");
const POSTER_MAX = Number(process.env.PS_POSTER_MAX) || 3000, POSTER_RECHECK_DAYS = 30;
const PS_ROOT = "https://image.api.playstation.com/vulcan/ap/rnd/", XBOX_IMG = "https://store-images.s-microsoft.com/image/";
const full = u => String(u || "").replace(/^~/, PS_ROOT).split("?")[0];
const norm = s => String(s || "").replace(/[™®©℠]/g, "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "");
// a name as a key across the two stores: without the platforms ("for Xbox One", "PS4 & PS5", "(PS4)")
const PLATFORMS = /\b(?:for\s+)?(?:xbox\s+series\s+x\s*\|\s*s|xbox\s+series\s+x|xbox\s+one|xbox|windows\s+10|windows|pc|ps4|ps5)\b/gi;
const nameKey = t => norm(psName_(String(t || "").replace(/\s*\((?:PS4|PS5)\)\s*$/i, "")).replace(PLATFORMS, " "));
const gameKey = t => norm(cleanTitle_(psName_(String(t || "").replace(/\s*\((?:PS4|PS5)\)\s*$/i, ""))).replace(PLATFORMS, " "));

function portraitOf_(res) {
  let j = null;
  try { if (res && res.getResponseCode() === 200) j = JSON.parse(res.getContentText()); } catch (e) {}
  if (!j || !j.data) return undefined;
  const p = j.data.productRetrieve;
  if (!p) return /not available|data_not_found/i.test(JSON.stringify(j.errors || "")) ? ["", ""] : undefined;
  const m = (p.media || []).find(x => x && x.role === "PORTRAIT_BANNER" && x.url);
  return [m ? String(m.url).split("?")[0] : "", String(p.name || "")];
}

function psPosters(dataDir) {
  const t0 = Date.now(), file = f => path.join(dataDir, f);
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(file(f), "utf8")); } catch (e) { return d; } };
  const sales = read("ps_sales.json", null), cat = read("ps_catalog.json", null), home = read("ps_home.json", null);
  if (!sales || !cat) { console.log("PlayStation posters: no deals or full game list yet"); return; }
  const cache = read("ps_posters.json", { p: {} }), seen = cache.p || {}, now = Date.now();

  // what has no portrait cover: [square art, title, publisher, products to ask (own first), rank, a game (several editions)]
  const items = [];
  (sales.games || []).forEach(g => {
    if (g.image && g.sq && full(g.image) === full(g.sq)) items.push({ sq: full(g.sq), t: g.title, pub: g.publisher, pids: [g.productId], rank: g.rank || 1e9 });
  });
  (cat.games || []).forEach(r => {
    if (!r[6] || !r[14] || full(r[6]) !== full(r[14])) return;
    const pids = [r[13]].concat(r[16] ? String(r[16]).split(",") : []).filter((x, i, a) => x && a.indexOf(x) === i).slice(0, 5);
    items.push({ sq: full(r[14]), t: r[1], pub: r[2], pids, rank: Number(r[7]) || 1e9, game: true });
  });
  items.sort((a, b) => a.rank - b.rank);

  // 1. the products' own art: the ones never asked (or asked long ago), the most popular games first
  const due = id => !seen[id] || (!seen[id][0] && now - seen[id][1] > POSTER_RECHECK_DAYS * 864e5);
  const ask = Array.from(new Set([].concat(...items.map(x => x.pids)).filter(due))).slice(0, POSTER_MAX);
  let asked = 0;
  for (let i = 0; i < ask.length && Date.now() - t0 < 10 * 60000; i += 40) {
    const chunk = ask.slice(i, i + 40);
    let res = [];
    try { res = UrlFetchApp.fetchAll(chunk.map(id => psRequest_("metGetProductById", { productId: id }, "en-US"))); }
    catch (e) { console.log("PlayStation posters: lookup failed: " + e.message); break; }
    chunk.forEach((id, k) => { const p = portraitOf_(res[k]); if (p) { seen[id] = [p[0], now, p[1]]; asked++; } });
  }
  // (products no longer listed go)
  const live = new Set([].concat(...items.map(x => x.pids)));
  Object.keys(seen).forEach(id => { if (!live.has(id) && now - seen[id][1] > 7 * 864e5) delete seen[id]; });

  // 2. the Xbox covers that are portrait, by name (the exact name first, then the game's without its edition)
  const xcat = (read("xbox_catalog.json", { games: [] }).games || []), xpost = read("xbox_posters.json", {});
  const xByName = new Map(), xByGame = new Map();
  xcat.forEach(r => {
    const id = String(r[0] || "").toUpperCase(), short = xpost[id];
    if (!short) return;
    const e = { url: /^https?:/.test(short) ? short : XBOX_IMG + short, pub: norm(r[2]), rank: Number(r[7]) || 1e9 };
    [[xByName, nameKey(r[1])], [xByGame, gameKey(r[1])]].forEach(([m, k]) => { if (k.length >= 4) { if (!m.has(k)) m.set(k, []); m.get(k).push(e); } });
  });
  const xbox = it => {
    if (/\bupgrade\b/i.test(it.t)) return "";   // (an upgrade isn't the edition it upgrades to)
    for (const [m, k] of [[xByName, nameKey(it.t)], [xByGame, gameKey(it.t)]]) {
      const list = k.length >= 4 && m.get(k);
      if (!list) continue;
      const pub = norm(it.pub), same = pub ? list.filter(e => e.pub && (e.pub.indexOf(pub.slice(0, 6)) === 0 || pub.indexOf(e.pub.slice(0, 6)) === 0)) : [];
      return (same.length ? same : list).slice().sort((a, b) => a.rank - b.rank)[0].url;
    }
    return "";
  };

  // each square art's poster
  const poster = new Map();
  let fromPs = 0, fromXbox = 0, none = 0;
  items.forEach(it => {
    if (poster.has(it.sq)) return;
    let url = "";
    const own = seen[it.pids[0]];
    if (own && own[0]) url = own[0];
    else if (it.game) {
      // another edition of the game with its own name (and not a demo)
      const k = psGameKey_(it.t);
      const ed = it.pids.slice(1).find(id => seen[id] && seen[id][0] && k.length >= 3 && psGameKey_(seen[id][2]) === k && !global.__XBOX.PS_DEMO.test(seen[id][2]));
      if (ed) url = seen[ed][0];
    }
    if (url) fromPs++;
    else if ((url = xbox(it))) fromXbox++;
    else none++;
    if (url) poster.set(it.sq, url);
  });

  // the files: every cover that is its square art
  let n = 0;
  const swap = o => {
    if (Array.isArray(o)) { o.forEach(swap); return; }
    if (!o || typeof o !== "object") return;
    if (typeof o.image === "string" && o.image) { const p = poster.get(full(o.image)); if (p && (!o.sq || full(o.sq) === full(o.image))) { o.image = p; n++; } }
    Object.keys(o).forEach(k => { const v = o[k]; if (v && typeof v === "object") swap(v); });
  };
  swap(sales.games);
  (cat.games || []).forEach(r => { if (r[6] && r[14] && full(r[6]) === full(r[14]) && poster.has(full(r[14]))) { r[6] = poster.get(full(r[14])); n++; } });
  if (home) swap(home.sections || {}), swap(home.bar || []);
  fs.writeFileSync(file("ps_sales.json"), JSON.stringify(sales));
  fs.writeFileSync(file("ps_catalog.json"), JSON.stringify(cat));
  if (home) fs.writeFileSync(file("ps_home.json"), JSON.stringify(home));
  cache.p = seen;
  cache.updatedAt = new Date().toISOString();
  fs.writeFileSync(file("ps_posters.json"), JSON.stringify(cache));
  console.log("PlayStation posters: " + items.length + " covers without portrait art, " + fromPs + " found in the PlayStation Store (" + asked + " products looked up, " +
              ask.length + " due), " + fromXbox + " from Xbox, " + none + " still square; " + n + " covers replaced (" + Math.round((Date.now() - t0) / 1000) + " s)");
}

module.exports = { psPosters, nameKey, gameKey };
