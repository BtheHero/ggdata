// Themed store sales (Black Friday, the Holiday sale, Days of Play...) while they're live, for the site's home page,
// after each Xbox and PlayStation run (after jobs/weekly.js).
//
//   <xbox|ps>_home.json sections.event   {key, name, from, to, ends, count, games: [...]}, or no "event" when none is live
//
// The stores don't name their sales in the data, so a sale counts as live when it's the time of year for it and a big
// share of the store's deals end inside its window: at least MIN_DEALS deals and MIN_SHARE of every deal still on.
// (A store's usual weekly deals are a few hundred; a themed sale puts thousands on at once with the same end dates.)
// node jobs/events.js xbox|ps
const fs = require("fs"), path = require("path");
const DATA = path.resolve(process.env.DATA_DIR || "data");
const plat = process.argv[2] === "ps" ? "ps" : "xbox";
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")); } catch (e) { return d; } };
const MIN_DEALS = 800, MIN_SHARE = 0.4, KEEP = 15;

// key, name, when the sale can be on (month-day, from-to) and when its deals end; only: the one store that has it
const EVENTS = [
  { key: "lunar", name: "Lunar New Year Sale", on: ["01-20", "03-05"], ends: ["01-30", "03-05"] },
  { key: "spring", name: "Spring Sale", on: ["03-05", "04-30"], ends: ["03-15", "04-30"] },
  { key: "daysofplay", name: "Days of Play", only: "ps", on: ["05-20", "06-25"], ends: ["05-30", "06-25"] },
  { key: "summer", name: "Summer Sale", on: ["06-15", "08-10"], ends: ["06-25", "08-10"] },
  { key: "halloween", name: "Halloween Sale", on: ["10-08", "11-08"], ends: ["10-20", "11-08"] },
  { key: "blackfriday", name: "Black Friday Sale", on: ["11-01", "12-08"], ends: ["11-15", "12-08"] },
  { key: "holiday", name: "Holiday Sale", on: ["12-08", "01-20"], ends: ["12-20", "01-20"] }
];
const ADDON = /^(add-?on|add-on pack|map|level|costume|vehicle|character|item|episode|season pass|virtual currency|weapons?|track|avatar|theme|soundtrack|expansion|durable|consumable)$/i;
const ADDON_TITLE = /\b(season pass|dlc|expansion pass|soundtrack|costume|character pack|add-?on|upgrade|points|coins|currency|v-bucks|crowns)\b/i;
const gameKey = t => String(t || "").toLowerCase().replace(/[™®©]/g, "")
  .replace(/\b(standard|deluxe|ultimate|premium|gold|complete|definitive|digital|special|collector'?s|game of the year|goty|enhanced|anniversary|legendary|cross-gen|ps4\s*&\s*ps5|ps4|ps5|xbox one|xbox series x\|s|for xbox series x\|s|windows|pc)\b( edition| bundle)?/g, " ")
  .replace(/\bedition\b|\bbundle\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

// a month-day window as dates (yyyy-mm-dd) around today: one that runs over New Year starts the year before or ends the year after
const today = new Date().toISOString().slice(0, 10), year = +today.slice(0, 4);
function windowOf(md) {
  for (const y of [year - 1, year]) {
    const a = y + "-" + md[0], b = (md[1] < md[0] ? y + 1 : y) + "-" + md[1];
    if (today >= a && today <= b) return [a, b];
  }
  return null;
}

const sales = read(plat + "_sales.json", { games: [] }).games || [];
const live = sales.filter(g => g.productId && Number(g.price) > 0 && Number(g.msrp) > Number(g.price) && !(g.saleEnds && Date.parse(g.saleEnds) <= Date.now()));
let event = null;
for (const e of EVENTS) {
  if (e.only && e.only !== plat) continue;
  const on = windowOf(e.on);
  if (!on) continue;
  const fromYear = +on[0].slice(0, 4) + (e.ends[0] < e.on[0] ? 1 : 0);
  const from = fromYear + "-" + e.ends[0], to = (e.ends[1] < e.ends[0] ? fromYear + 1 : fromYear) + "-" + e.ends[1];
  const inSale = live.filter(g => { const d = String(g.saleEnds || "").slice(0, 10); return d >= from && d <= to; });
  console.log(e.name + " (" + plat + "): " + inSale.length + " of " + live.length + " deals end " + from + " to " + to);
  if (inSale.length < MIN_DEALS || inSale.length < live.length * MIN_SHARE) continue;
  // when it ends: the day most of its deals end
  const byDay = {};
  inSale.forEach(g => { const d = String(g.saleEnds).slice(0, 10); byDay[d] = (byDay[d] || 0) + 1; });
  const ends = Object.keys(byDay).sort((a, b) => byDay[b] - byDay[a] || a.localeCompare(b))[0];
  const endsAt = (inSale.find(g => String(g.saleEnds).slice(0, 10) === ends) || {}).saleEnds || ends;
  // the row: its best deals, games only, one edition per game
  const keys = new Set(), games = [];
  inSale.filter(g => !ADDON.test(String(g.kind || "").trim()) && !ADDON_TITLE.test(g.title || "") && g.image)
    .sort((a, b) => (b.dealScore || 0) - (a.dealScore || 0) || (a.rank || 1e9) - (b.rank || 1e9))
    .forEach(g => {
      const k = gameKey(g.title) || g.productId;
      if (games.length >= KEEP || keys.has(k)) return;
      keys.add(k);
      games.push({ id: g.productId, title: g.title, publisher: g.publisher || "", image: g.image || "", sq: g.sq || null,
        price: Number(g.price), msrp: Number(g.msrp), currency: g.currency || "USD", low: !!g.atLow, ds: g.dealScore || null,
        ends: g.saleEnds || null, pc: !!g.pc, genres: (g.genres || []).slice(0, 3), subs: g.subs || [], tiers: g.tiers || [], release: null, date: null });
    });
  event = { key: e.key, name: e.name, from, to, ends: endsAt, count: inSale.length, games };
  break;
}

const home = read(plat + "_home.json", null);
if (!home || !home.sections) { console.log("No " + plat + "_home.json yet"); process.exit(0); }
if (event) home.sections.event = event; else delete home.sections.event;
fs.writeFileSync(path.join(DATA, plat + "_home.json"), JSON.stringify(home));
console.log(event ? "Live: " + event.name + ", " + event.count + " deals, most end " + event.ends.slice(0, 10) + "; " + event.games.length + " in the home page row"
  : "No themed sale live on " + plat);
