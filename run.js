// Runs one job: node run.js <job>
//   xbox   the Xbox US export, then every other region
//   media  screenshots, trailers, key art and genres of every game
//   desc   every game's description in the site's other languages (stores first, then machine translation)
//   scores Metacritic scores (both stores)
//   pages  Xbox add-ons on sale, then the Xbox game pages
//   alladdons  every Xbox add-on (part of the games each day)
//   ps, psmorning, psfill, pspages  PlayStation: full export with regions, morning run, publishers/ratings, game pages
//   psregions  PlayStation: every region's editions, a part at a time, then their prices (jobs/ps-editions.js)
//   psregion <region> [lookups]  one region's editions and prices, for testing
// The files it reads and writes are in data/ (the workflow downloads them from the bucket first and uploads them after).
const rt = require("./runtime/appsscript");
const job = process.argv[2];
const t0 = Date.now();
const secs = () => Math.round((Date.now() - t0) / 1000) + " s";

rt.load(["gs/common.gs", "gs/xbox.gs", "gs/addons.gs", "gs/gamepages.gs", "gs/ps.gs"], "global.__XBOX = { REGIONS: REGIONS, PS_REGIONS: PS_REGIONS, PS_LOOSE: PS_LOOSE, psIsGame_: psIsGame_, PS_DEMO: PS_DEMO, psRegionLists: () => [PS_NAMES, PS_GRIDCON] };");
const fs = require("fs"), path = require("path");

// Each game's price in every region, for the game pages' regional price table: data/compare/xbox-<n>.json,
// {rates: {currency: per US dollar}, games: {id: {region: [price, regular price]}}} in the game pages' 64 groups,
// so the site reads one small file per game page. Currencies: US from the full list, the others from their price files.
function buildCompare() {
  const dir = rt.DATA_DIR, read = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) { return null; } };
  const cat = read("xbox_catalog.json");
  if (!cat || !cat.games) { console.log("Compare: no full game list"); return; }
  const games = {}, currency = { US: "USD" };
  cat.games.forEach(r => { if (r[0] && Number(r[3]) >= 0) (games[String(r[0]).toUpperCase()] = {}).US = [Number(r[3]) || 0, Number(r[4]) || Number(r[3]) || 0]; });
  // add-ons (not in the full game list): on sale, then every other one at its regular price
  const allAo = (read("xbox_addons_all.json") || {}).a || {};
  ((read("xbox_addons.json") || {}).games || []).forEach(g => { const id = String(g.productId || "").toUpperCase(); if (id && !games[id]) games[id] = { US: [Number(g.price) || 0, Number(g.msrp) || Number(g.price) || 0] }; });
  Object.keys(allAo).forEach(k => { const id = k.toUpperCase(); if (!games[id] && Number(allAo[k][2]) >= 0) games[id] = { US: [Number(allAo[k][2]) || 0, Number(allAo[k][2]) || 0] }; });
  Object.keys(__XBOX.REGIONS).filter(c => c !== "US").forEach(code => {
    const f = read("xbox_prices_" + code + ".json");
    if (!f || !f.prices) return;
    currency[code] = f.currency;
    Object.keys(f.prices).forEach(id => { const g = games[id.toUpperCase()]; if (g) g[code] = [f.prices[id][0], f.prices[id][1]]; });
  });
  let rates = null;
  try { const r = JSON.parse(UrlFetchApp.fetch("https://open.er-api.com/v6/latest/USD", { muteHttpExceptions: true }).getContentText()); rates = r.rates; } catch (e) {}
  if (!rates) { const old = read("compare/xbox-0.json"); rates = old && old.rates; }
  if (!rates) { console.log("Compare: no exchange rates"); return; }
  const shards = Array.from({ length: 64 }, () => ({}));
  Object.keys(games).forEach(id => { shards[shardOf_(id)][id] = games[id]; });
  fs.mkdirSync(path.join(dir, "compare"), { recursive: true });
  const now = new Date().toISOString();
  shards.forEach((g, n) => fs.writeFileSync(path.join(dir, "compare", "xbox-" + n + ".json"), JSON.stringify({ updatedAt: now, currency, rates, games: g })));
  console.log("Compare: " + Object.keys(games).length + " games in " + Object.keys(currency).length + " regions");
  try { updateRegionHistory("xbox", games, currency); } catch (e) { console.log("Regional history failed: " + e.message); }
}

// ---------- Xbox: prices the regional crawls miss ----------
// A region's price file comes from that store's browse list, which leaves out some games the US list has (and every
// add-on). The site then showed the US price converted, as if the game weren't sold there. So the games of the US
// lists that a region's file doesn't have are looked up in that market's product data (displaycatalog), a part at a
// time (GAP_MAX a region per run): the US deals and add-ons on sale first, then games never checked, then the oldest.
// Kept in data/xbox_gaps_<code>.json {p: {id: [price, msrp, checked ms] or [null, null, checked ms] when not sold there}};
// merged into the region's file (prices, and na: ids not sold there).
const GAP_MAX = 2400, GAP_SALE_HOURS = 10, GAP_RECHECK_DAYS = 6;
const MARKET = { UK: "GB", EU: "IE" };
function dcPrice(p) {
  const now = Date.now();
  let best = null;
  (p.DisplaySkuAvailabilities || []).forEach(sa => {
    const sp = (sa.Sku && sa.Sku.Properties) || {};
    if (sp.IsTrial) return;
    (sa.Availabilities || []).forEach(a => {
      if (!(a.Actions || []).includes("Purchase")) return;
      const c = a.Conditions || {}, st = Date.parse(c.StartDate), en = Date.parse(c.EndDate);
      if (st > now || en <= now) return;
      const pr = a.OrderManagementData && a.OrderManagementData.Price;
      if (!pr || !(Number(pr.MSRP) >= 0) || !(Number(pr.ListPrice) >= 0)) return;
      if (!best || pr.ListPrice < best[0]) best = [Number(pr.ListPrice), Number(pr.MSRP) || Number(pr.ListPrice), pr.CurrencyCode, en < Date.UTC(3000, 0, 1) ? en : 0];
    });
  });
  return best;
}
function fillRegionGaps(code) {
  const dir = rt.DATA_DIR, read = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) { return null; } };
  const file = "xbox_prices_" + code + ".json", rf = read(file);
  if (!rf || !rf.prices || !rf.currency) return;
  // (a file the crawl didn't replace this run still has the last run's looked-up prices: rf.gap)
  const have = {}, merged = new Set(rf.gap || []);
  Object.keys(rf.prices).forEach(id => { if (!merged.has(id)) have[id.toUpperCase()] = 1; });
  const sale = [], rest = [];
  ((read("xbox_sales.json") || {}).games || []).forEach(g => g.productId && sale.push(String(g.productId).toUpperCase()));
  ((read("xbox_addons.json") || {}).games || []).forEach(g => g.productId && sale.push(String(g.productId).toUpperCase()));
  ((read("xbox_catalog.json") || {}).games || []).forEach(r => r[0] && rest.push(String(r[0]).toUpperCase()));
  Object.keys((read("xbox_addons_all.json") || {}).a || {}).forEach(id => rest.push(id.toUpperCase()));
  const gf = "xbox_gaps_" + code + ".json", gaps = (read(gf) || {}).p || {}, now = Date.now();
  const saleSet = new Set(sale);
  const due = id => { const g = gaps[id]; return !g ? 0 : saleSet.has(id) ? (now - g[2] > GAP_SALE_HOURS * 36e5 ? 1 : 9) : now - g[2] > GAP_RECHECK_DAYS * 864e5 ? 2 : 9; };
  const want = Array.from(new Set(sale.concat(rest))).filter(id => !have[id]);
  // the US sales and add-ons on sale whose check is old, then games never checked, then the oldest checks
  const order = want.map(id => [id, saleSet.has(id) && (!gaps[id] || due(id) === 1) ? 0 : !gaps[id] ? 1 : due(id)]).filter(x => x[1] < 9)
    .sort((a, b) => a[1] - b[1] || ((gaps[a[0]] || [0, 0, 0])[2] - (gaps[b[0]] || [0, 0, 0])[2])).slice(0, GAP_MAX).map(x => x[0]);
  const market = MARKET[code] || code;
  let found = 0, none = 0;
  for (let i = 0; i < order.length; i += 160) {
    const chunks = [];
    for (let k = i; k < Math.min(i + 160, order.length); k += 20) chunks.push(order.slice(k, k + 20));
    let res = [];
    try {
      res = UrlFetchApp.fetchAll(chunks.map(c => ({ url: "https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=" + c.join(",") +
        "&market=" + market + "&languages=en-US&MS-CV=DGU1mcuYo0WMMp%2BF.1", muteHttpExceptions: true })));
    } catch (e) { console.log(code + " gap lookup failed: " + e.message); break; }
    res.forEach((r, n) => {
      let d = null;
      try { if (r && r.getResponseCode() === 200) d = JSON.parse(r.getContentText()); } catch (e) {}
      if (!d) return;   // no answer: asked again next run
      const seen = {};
      (d.Products || []).forEach(p => {
        const id = String(p.ProductId || "").toUpperCase(), pr = dcPrice(p);
        seen[id] = 1;
        if (pr && pr[2] === rf.currency) { gaps[id] = [pr[0], pr[1], now, pr[1] > pr[0] && pr[3] ? pr[3] : 0]; found++; }
        else { gaps[id] = [null, null, now]; none++; }
      });
      chunks[n].forEach(id => { if (!seen[id]) { gaps[id] = [null, null, now]; none++; } });   // not sold in that market
    });
  }
  // the region's file: its own prices first, then the looked-up ones; na = not sold there
  const na = [], gap = [];
  // sale end times: the crawl's (exportRegion_), then the looked-up ones; past ones go
  rf.ends = rf.ends || {};
  (rf.gap || []).forEach(id => { delete rf.ends[id]; });
  Object.keys(gaps).forEach(id => {
    const g = gaps[id];
    if (have[id]) { delete gaps[id]; return; }   // the region's own list has it now
    if (now - g[2] > 30 * 864e5) { delete gaps[id]; return; }
    if (g[0] === null) { na.push(id); delete rf.prices[id]; }
    else if (g[3] && g[3] <= now) { rf.prices[id] = [g[1], g[1], 1e6, 0]; gap.push(id); }   // its sale has ended since
    else { rf.prices[id] = [g[0], g[1], 1e6, g[1] > g[0] ? Math.round((1 - g[0] / g[1]) * 100) : 0]; gap.push(id); if (g[3]) rf.ends[id] = g[3]; }
  });
  Object.keys(rf.ends).forEach(id => { if (!rf.prices[id] || rf.ends[id] <= now) delete rf.ends[id]; });
  rf.na = na;
  rf.gap = gap;
  // the home page's count of deals in this store: games only (the looked-up prices include the add-ons)
  const addon = new Set(Object.keys((read("xbox_addons_all.json") || {}).a || {}).map(id => id.toUpperCase()));
  ((read("xbox_addons.json") || {}).games || []).forEach(g => g.productId && addon.add(String(g.productId).toUpperCase()));
  rf.dealsCount = Object.keys(rf.prices).filter(id => { const p = rf.prices[id]; return (p[1] > p[0] || p[3] > 0) && !addon.has(id.toUpperCase()); }).length;
  fs.writeFileSync(path.join(dir, gf), JSON.stringify({ updatedAt: new Date().toISOString(), p: gaps }));
  fs.writeFileSync(path.join(dir, file), JSON.stringify(rf));
  console.log(code + " prices the crawl missed: looked up " + order.length + " of " + want.length + " (" + found + " sold there, " + none + " not); " + na.length + " known not sold there");
}

// ---------- PlayStation: each region's prices, edition by edition ----------
// Every US game and deal gets the price of the same edition in each region's store, or is listed as not sold there
// (jobs/ps-editions.js). The editions are looked up a part at a time: PS_ED_RUN games a region in the daily run (new
// games and deals first), the most in the "psregions" job, which goes through every game of every region in turn.
const pse = require("./jobs/ps-editions");
const PS_ED_RUN = Number(process.env.PS_ED_RUN) || 1500;
// one region: its editions looked up (fresh: its lists were read this run, PS_NAMES and PS_GRIDCON are its), then its prices
function psRegionEditions(code, max, until, fresh) {
  let left = 0;
  const [names, grid] = fresh ? __XBOX.psRegionLists() : [null, null];
  try { left = pse.psEditionLookups(code, { max, until, names, grid }); }
  catch (e) { console.log("PlayStation " + code + " edition lookups failed: " + e.message); }
  if (code !== "US") {
    try { pse.psResolveRegion_(code); } catch (e) { console.log("PlayStation " + code + " prices by edition failed: " + e.message); process.exitCode = 1; }
  }
  return left;
}

// ---------- each region's price history ----------
// The game pages' price chart is the US store's (g.h, in dollars); in another region the page shows that region's own
// history, kept here from each run's regional prices (the compare files): data/rhist/<xbox|ps>-<code>.json
// {currency, h: {id: [[yyyymmdd, price], ...]}}, one entry per change. (Started with this file: older changes aren't known.)
function updateRegionHistory(plat, games, currency) {
  const dir = rt.DATA_DIR, today = Number(new Date().toISOString().slice(0, 10).replace(/-/g, ""));
  fs.mkdirSync(path.join(dir, "rhist"), { recursive: true });
  Object.keys(currency).filter(c => c !== "US").forEach(code => {
    const f = path.join(dir, "rhist", plat + "-" + code + ".json");
    let d = null;
    try { d = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) {}
    if (!d || d.currency !== currency[code]) d = { currency: currency[code], h: {} };   // a new currency: a new history
    let changed = 0;
    Object.keys(games).forEach(id => {
      const p = games[id][code];
      if (!p || !(p[0] >= 0)) return;
      const h = d.h[id] || (d.h[id] = []), last = h[h.length - 1];
      if (last && Math.abs(last[1] - p[0]) <= 0.02 * Math.max(1, p[0] / 100)) return;
      if (last && last[0] === today) last[1] = p[0]; else h.push([today, p[0]]);
      changed++;
    });
    d.updatedAt = new Date().toISOString();
    fs.writeFileSync(f, JSON.stringify(d));
    if (changed) console.log("History " + plat + " " + code + ": " + changed + " price changes");
  });
}

// PlayStation's price in every region for each game page (concepts, and deals by their own id):
// data/compare/ps-<n>.json, same shape as Xbox's. A deal is matched across regions by its key (psDealKey_).
function buildPsCompare() {
  const dir = rt.DATA_DIR, read = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) { return null; } };
  const sales = read("ps_sales.json"), cat = read("ps_catalog.json");
  if (!sales || !cat) { console.log("PlayStation compare: no deals or full game list yet"); return; }
  const regions = {}, currency = { US: "USD" };
  Object.keys(__XBOX.PS_REGIONS).forEach(code => { const f = read("ps_prices_" + code + ".json"); if (f && f.prices) { regions[code] = f.prices; currency[code] = f.currency; } });
  const games = {};
  const add = (id, key, price, msrp) => {
    const g = { US: [Number(price) || 0, Number(msrp) || Number(price) || 0] };
    Object.keys(regions).forEach(code => { const p = regions[code][key]; if (p) g[code] = [p[0], p[1]]; });
    games[id] = g;
  };
  (cat.games || []).forEach(r => { if (r[0]) add(String(r[0]), String(r[0]), r[3], r[4]); });
  (sales.games || []).forEach(g => { if (g.productId) add(g.productId, g.key || g.productId, g.price, g.msrp); });
  // every edition of every game (jobs/ps-editions.js: the US editions, each region's prices under the US product id),
  // so an edition's own page shows that edition's prices, not an old sale's
  const usEd = (read("psed/US.json") || {}).c || {};
  let eds = 0;
  Object.keys(usEd).forEach(con => ((usEd[con] && usEd[con][1]) || []).forEach(e => {
    if (!e[0] || games[e[0]] || !/^(FULL_GAME|GAME_BUNDLE|PREMIUM_EDITION|BUNDLE)$/.test(e[2]) || !(e[4] > 0)) return;
    add(e[0], e[0], e[5], e[4]);
    eds++;
  }));
  let rates = null;
  try { rates = JSON.parse(UrlFetchApp.fetch("https://open.er-api.com/v6/latest/USD", { muteHttpExceptions: true }).getContentText()).rates; } catch (e) {}
  if (!rates) { const old = read("compare/ps-0.json"); rates = old && old.rates; }
  if (!rates) { console.log("PlayStation compare: no exchange rates"); return; }
  const shards = Array.from({ length: 64 }, () => ({}));
  Object.keys(games).forEach(id => { shards[shardOf_(id)][id] = games[id]; });
  fs.mkdirSync(path.join(dir, "compare"), { recursive: true });
  const now = new Date().toISOString();
  shards.forEach((g, n) => fs.writeFileSync(path.join(dir, "compare", "ps-" + n + ".json"), JSON.stringify({ updatedAt: now, currency, rates, games: g })));
  console.log("PlayStation compare: " + Object.keys(games).length + " games (" + eds + " more editions) in " + Object.keys(currency).length + " regions");
  try { updateRegionHistory("ps", games, currency); } catch (e) { console.log("Regional history failed: " + e.message); }
}

const jobs = {
  // PlayStation: deals, home page, history (exportPlayStation_), the full game list, then every other region
  ps() {
    exportPlayStation_({});
    console.log("== PlayStation US done (" + secs() + ")");
    try { psExportCatalog_(); } catch (e) { console.log("Full game list failed: " + e.message); process.exitCode = 1; }
    console.log("== full game list done (" + secs() + ")");
    try { require("./jobs/ps-posters").psPosters(rt.DATA_DIR); } catch (e) { console.log("Posters failed: " + e.message); }
    psRegionEditions("US", PS_ED_RUN, Date.now() + 10 * 60000, false);   // the US editions of new games and deals
    Object.keys(__XBOX.PS_REGIONS).forEach(code => {
      let ok = false;
      try { ok = exportPsRegion_(code, Date.now()); } catch (e) { console.log(code + " failed: " + e.message); }
      psRegionEditions(code, PS_ED_RUN, Date.now() + 5 * 60000, ok);
      console.log("== " + code + (ok ? " done" : " NOT updated") + " (" + secs() + ")");
    });
    try { buildPsCompare(); } catch (e) { console.log("Compare failed: " + e.message); }
  },
  // every region's editions, a part at a time (PS_ED_MINUTES in all, shared by the regions still to go), then their
  // prices and the game pages' price tables
  psregions() {
    const until = t0 + (Number(process.env.PS_ED_MINUTES) || 80) * 60000;
    psRegionEditions("US", 1e9, Math.min(until, Date.now() + 20 * 60000), false);
    console.log("== US editions (" + secs() + ")");
    const codes = Object.keys(__XBOX.PS_REGIONS);
    codes.forEach((code, i) => {
      const left = psRegionEditions(code, 1e9, Date.now() + (until - Date.now()) / (codes.length - i), false);
      console.log("== " + code + (left ? ", " + left + " games still to look up" : "") + " (" + secs() + ")");
    });
    try { buildPsCompare(); } catch (e) { console.log("Compare failed: " + e.message); }
  },
  psregion() {
    const code = process.argv[3] || "UK", max = Number(process.argv[4]) || 1e9;
    if (code !== "US") psRegionEditions("US", max, Date.now() + 20 * 60000, false);
    psRegionEditions(code, max, Date.now() + 60 * 60000, false);
  },
  // the lighter morning run for new sales: US deals, home page and full game list
  psmorning() {
    exportPlayStation_({ maxLookups: 800 });
    try { psExportCatalog_(); } catch (e) { console.log("Full game list failed: " + e.message); process.exitCode = 1; }
    try { require("./jobs/ps-posters").psPosters(rt.DATA_DIR); } catch (e) { console.log("Posters failed: " + e.message); }
    try { buildPsCompare(); } catch (e) { console.log("Compare failed: " + e.message); }
  },
  // publishers, store ratings and descriptions, looked up a part at a time
  psfill() {
    psFillPublishers();
    // posters (jobs/ps-posters.js), with the Steam lookups, which need the time this run has
    try { require("./jobs/ps-posters").psPosters(rt.DATA_DIR, { steam: true }); } catch (e) { console.log("Posters failed: " + e.message); }
  },
  // PlayStation posters only (jobs/ps-posters.js), for testing
  psposters() { require("./jobs/ps-posters").psPosters(rt.DATA_DIR, { steam: true }); },
  // PlayStation game pages
  pspages() {
    const n = gamePagesFor_("PS_");
    console.log("== PlayStation game pages: " + n + " games (" + secs() + ")");
    if (!n) process.exitCode = 1;
  },
  // Metacritic scores of both stores' visible games (fillScores in gs/xbox.gs): scores.json and ps_scores.json.
  // PlayStation's game lists come from the site's data service (seed.js copies them to SRC_DIR).
  scores() {
    const src = path.resolve(process.env.SRC_DIR || "src"), dataDir = rt.DATA_DIR;
    const read = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };
    const psFiles = { PS_HOME_FILE_ID: "ps_home.json", PS_JSON_FILE_ID: "ps_sales.json", PS_CATALOG_FILE_ID: "ps_catalog.json" };
    const own = global.psReadJson_;
    global.psReadJson_ = (key, fallback) => psFiles[key] ? (read(path.join(src, psFiles[key])) || fallback) : own(key, fallback);
    // first run: start from the scores the site's data service already found (titles from the game lists)
    if (!fs.existsSync(path.join(dataDir, "metacritic.json"))) {
      const store = {}, today = Number(new Date().toISOString().slice(0, 10).replace(/-/g, ""));
      const titles = {};
      [[read(path.join(dataDir, "xbox_catalog.json")), read(path.join(dataDir, "xbox_sales.json"))],
       [read(path.join(src, "ps_catalog.json")), read(path.join(src, "ps_sales.json"))]].forEach(([cat, sales]) => {
        ((cat && cat.games) || []).forEach(r => { titles[r[0]] = r[1]; if (r[13]) titles[r[13]] = r[1]; });
        ((sales && sales.games) || []).forEach(g => { titles[g.productId] = g.title; });
      });
      [read(path.join(dataDir, "scores.json")), read(path.join(dataDir, "ps_scores.json"))].forEach(m => Object.keys(m || {}).forEach(id => {
        const k = titles[id] && scoreKey_(titles[id]);
        if (k && !store[k]) store[k] = [m[id][0], m[id][1], today];
      }));
      fs.writeFileSync(path.join(dataDir, "metacritic.json"), JSON.stringify(store));
      PropertiesService.getScriptProperties().setProperty("METACRITIC_FILE_ID", "metacritic.json");
      console.log("Metacritic: started from " + Object.keys(store).length + " known scores");
    }
    fillScores();
  },

  // Xbox add-ons on sale (gs/addons.gs), then the Xbox game pages (gs/gamepages.gs)
  pages() {
    try { exportXboxAddOns(); } catch (e) { console.log("Add-ons failed: " + e.message); }
    try { xAddOnRelations_(); } catch (e) { console.log("Add-on relations failed: " + e.message); }
    try { xPublisherIds_(); } catch (e) { console.log("Publisher ids failed: " + e.message); }
    try { xBundleContents_(); } catch (e) { console.log("Bundle contents failed: " + e.message); }
    console.log("== add-ons done (" + secs() + ")");
    const n = gamePagesFor_("");
    console.log("== Xbox game pages: " + n + " games (" + secs() + ")");
    if (!n) process.exitCode = 1;
  },
  // every Xbox add-on, on sale or not (a part of the games each day)
  alladdons() { exportXboxAllAddOns(); },
  // every game's store description in the site's other languages, machine-translated where the store has none
  // (jobs/descriptions.js)
  desc() {
    require("./jobs/descriptions").descriptions(rt.DATA_DIR)
      .then(() => console.log("== descriptions done (" + secs() + ")"))
      .catch(e => { console.log("Descriptions failed: " + e.message); process.exitCode = 1; });
  },
  // screenshots, trailers, key art and genres of every game (jobs/media.js); PlayStation's game list comes from the
  // site's data service (seed.js copies it to SRC_DIR)
  media() {
    const media = require("./jobs/media");
    media.xboxMedia(rt.DATA_DIR);
    console.log("== Xbox done (" + secs() + ")");
    media.psMedia(rt.DATA_DIR, process.env.SRC_DIR || "src");
  },
  xbox() {
    exportUS_();
    console.log("== US done (" + secs() + ")");
    let failed = 0;
    Object.keys(__XBOX.REGIONS).filter(r => r !== "US").forEach(code => {
      let ok = false;
      try { ok = exportRegion_(code); } catch (e) { console.log(code + " failed: " + e.message); }
      if (!ok) failed++;
      try { fillRegionGaps(code); } catch (e) { console.log(code + " gaps failed: " + e.message); }
      console.log("== " + code + (ok ? " done" : " NOT updated") + " (" + secs() + ")");
    });
    try { buildCompare(); } catch (e) { console.log("Compare failed: " + e.message); }
    if (failed) process.exitCode = 1;
  }
};

if (!jobs[job]) { console.log("Unknown job: " + job + ". Jobs: " + Object.keys(jobs).join(", ")); process.exit(2); }
jobs[job]();
console.log("Finished " + job + ": " + rt.stats.requests + " requests, " + secs());
