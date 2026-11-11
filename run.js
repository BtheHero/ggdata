// Runs one job: node run.js <job>
//   xbox   the Xbox US export, then every other region
//   media  screenshots, trailers, key art and genres of every game
//   scores Metacritic scores (both stores)
//   pages  Xbox add-ons on sale, then the Xbox game pages
//   alladdons  every Xbox add-on (part of the games each day)
// The files it reads and writes are in data/ (the workflow downloads them from the bucket first and uploads them after).
const rt = require("./runtime/appsscript");
const job = process.argv[2];
const t0 = Date.now();
const secs = () => Math.round((Date.now() - t0) / 1000) + " s";

rt.load(["gs/common.gs", "gs/xbox.gs", "gs/addons.gs", "gs/gamepages.gs"], "global.__XBOX = { REGIONS: REGIONS };");
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
}

const jobs = {
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
    console.log("== add-ons done (" + secs() + ")");
    const n = gamePagesFor_("");
    console.log("== Xbox game pages: " + n + " games (" + secs() + ")");
    if (!n) process.exitCode = 1;
  },
  // every Xbox add-on, on sale or not (a part of the games each day)
  alladdons() { exportXboxAllAddOns(); },
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
      console.log("== " + code + (ok ? " done" : " NOT updated") + " (" + secs() + ")");
    });
    try { buildCompare(); } catch (e) { console.log("Compare failed: " + e.message); }
    if (failed) process.exitCode = 1;
  }
};

if (!jobs[job]) { console.log("Unknown job: " + job + ". Jobs: " + Object.keys(jobs).join(", ")); process.exit(2); }
jobs[job]();
console.log("Finished " + job + ": " + rt.stats.requests + " requests, " + secs());
