// The week's best deals (the site's /best-deals pages), after each Xbox and PlayStation run.
//
//   data/weekly/<xbox|ps>-<yyyy>-w<ww>.json   {plat, week, start, end, updatedAt, games: [...]}: the week's (ISO week,
//       Monday to Sunday, UTC) 30 best deals by deal score. Each run adds today's deals to the week's list and keeps the
//       30 best, so a deal stays listed after its sale ends (the page then says so), and last week's list is kept as it was.
//   data/weekly/<xbox|ps>-index.json   {weeks: [{week, start, end, n, top}]}, newest first: the pages of past weeks.
//   <xbox|ps>_home.json sections.weekly: the 15 best still on sale, for the home page row "Best deals this week".
//
// Games only (no add-ons), one edition per game, at least 20% off, with a deal score (the exports work it out: gs/xbox.gs dealScore_).
// node jobs/weekly.js xbox|ps
const fs = require("fs"), path = require("path");
const DATA = path.resolve(process.env.DATA_DIR || "data");
const plat = process.argv[2] === "ps" ? "ps" : "xbox";
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")); } catch (e) { return d; } };
const KEEP = 30, MIN_PCT = 20;
const ADDON = /^(add-?on|add-on pack|map|level|costume|vehicle|character|item|episode|season pass|virtual currency|weapons?|track|avatar|theme|soundtrack|expansion|durable|consumable)$/i;
const ADDON_TITLE = /\b(season pass|dlc|expansion pass|soundtrack|costume|character pack|add-?on|upgrade|points|coins|currency|v-bucks|crowns)\b/i;

// ISO week: [year, week, Monday, Sunday] (dates yyyy-mm-dd)
function isoWeek(ms) {
  const d = new Date(ms), day = (d.getUTCDay() + 6) % 7;   // Monday 0
  const mon = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
  const thu = new Date(mon + 3 * 864e5), y = thu.getUTCFullYear();
  const w = 1 + Math.floor((thu - Date.UTC(y, 0, 1)) / (7 * 864e5));
  const iso = t => new Date(t).toISOString().slice(0, 10);
  return [y, w, iso(mon), iso(mon + 6 * 864e5)];
}
// one edition per game: "Forza Horizon 5 Premium Edition" and "Forza Horizon 5" are the same game here
const gameKey = t => String(t || "").toLowerCase().replace(/[™®©]/g, "")
  .replace(/\b(standard|deluxe|ultimate|premium|gold|complete|definitive|digital|special|collector'?s|game of the year|goty|enhanced|anniversary|legendary|cross-gen|ps4\s*&\s*ps5|ps4|ps5|xbox one|xbox series x\|s|for xbox series x\|s|windows|pc)\b( edition| bundle)?/g, " ")
  .replace(/\bedition\b|\bbundle\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

const [y, w, start, end] = isoWeek(Date.now());
const week = y + "-w" + String(w).padStart(2, "0"), file = "weekly/" + plat + "-" + week + ".json";
const sales = read(plat + "_sales.json", { games: [] }).games || [];
const scores = read(plat === "ps" ? "ps_scores.json" : "scores.json", {});
const mcOf = id => { const v = scores[id] || scores[String(id).toUpperCase()]; return Array.isArray(v) ? v[0] : Number(v) || null; };
const today = sales.filter(g => {
  const price = Number(g.price) || 0, msrp = Number(g.msrp) || 0;
  return g.productId && g.title && g.dealScore && price > 0 && msrp > price && (1 - price / msrp) * 100 >= MIN_PCT &&
    !ADDON.test(String(g.kind || "").trim()) && !ADDON_TITLE.test(g.title) && !(g.saleEnds && Date.parse(g.saleEnds) <= Date.now());
}).map(g => ({
  id: g.productId, title: g.title, publisher: g.publisher || "", image: g.image || "", sq: g.sq || null,
  price: Number(g.price), msrp: Number(g.msrp), currency: g.currency || "USD", ds: g.dealScore, low: !!g.atLow,
  ends: g.saleEnds || null, mc: mcOf(g.productId), genres: (g.genres || []).slice(0, 3), seen: new Date().toISOString().slice(0, 10),
  subs: g.subs || [], tiers: g.tiers || [], pc: !!g.pc
}));
if (!today.length) { console.log("Weekly: no scored deals in " + plat + "_sales.json yet, nothing written"); process.exit(0); }

// this week's list so far, then today's deals (a game's newer entry wins: its current price and score)
const was = read(file, { games: [] }).games || [];
const byId = {};
was.concat(today).forEach(g => { byId[g.id] = g; });
const picked = [], keys = new Set();
Object.values(byId).sort((a, b) => b.ds - a.ds || (b.msrp - b.price) - (a.msrp - a.price)).forEach(g => {
  const k = gameKey(g.title) || g.id;
  if (picked.length >= KEEP || keys.has(k)) return;
  keys.add(k); picked.push(g);
});
fs.mkdirSync(path.join(DATA, "weekly"), { recursive: true });
fs.writeFileSync(path.join(DATA, file), JSON.stringify({ plat, week, start, end, updatedAt: new Date().toISOString(), games: picked }));

const idxFile = "weekly/" + plat + "-index.json", idx = read(idxFile, { weeks: [] });
const entry = { week, start, end, n: picked.length, top: picked.slice(0, 3).map(g => g.title) };
idx.weeks = [entry].concat((idx.weeks || []).filter(x => x.week !== week)).sort((a, b) => b.week.localeCompare(a.week)).slice(0, 520);
idx.updatedAt = new Date().toISOString();
fs.writeFileSync(path.join(DATA, idxFile), JSON.stringify(idx));
console.log("Weekly " + plat + " " + week + " (" + start + " to " + end + "): " + picked.length + " deals, best " +
            picked.slice(0, 3).map(g => g.title + " " + g.ds).join(", ") + "; " + idx.weeks.length + " weeks in the index");

// the home page row: the week's best still on sale
const home = read(plat + "_home.json", null);
if (home && home.sections) {
  const SUB = plat === "ps" ? "psplus" : "gamepass";
  home.sections.weekly = picked.filter(g => !(g.ends && Date.parse(g.ends) <= Date.now()) && today.some(t => t.id === g.id)).slice(0, 15).map(g => ({
    id: g.id, title: g.title, publisher: g.publisher, image: g.image, sq: g.sq, price: g.price, msrp: g.msrp, currency: g.currency,
    gp: (g.subs || []).indexOf(SUB) >= 0, xs: (g.subs || []).filter(x => x !== SUB && x !== "gamepass" && x !== "psplus"), tiers: g.tiers || [],
    low: g.low, ds: g.ds, ends: g.ends, pc: !!g.pc, genres: g.genres || [], release: null, date: null
  }));
  fs.writeFileSync(path.join(DATA, plat + "_home.json"), JSON.stringify(home));
  console.log("Home page row: " + home.sections.weekly.length + " of the week's best deals");
}
