// The site's list pages, after each Xbox and PlayStation run (after the game pages, which it reads).
//
//   data/<xbox|ps>_lists.json        {updatedAt, plat, year, recent, upcoming, free, meta, publishers, acclaimed, psplus}
//     recent      games released in the last RECENT_DAYS days, newest first
//     upcoming    every game with a release date still to come, soonest first (the release schedule)
//     free        popular free-to-play games, most store ratings first
//     meta        the best-reviewed games (Metascore), best first, with genres (the Top Metacritic page filters them)
//     publishers  every publisher with its number of games (editions and add-ons of a game count once), most popular
//                 first: the store ratings of all its games together
//     acclaimed   upcoming games from acclaimed studios (Xbox: developers) / publishers (PlayStation): {by, studios, games}
//     psplus      PlayStation only: {added, coming}: games new in the PS Plus catalog (first seen in it within
//                 PSPLUS_NEW_DAYS), and games the PlayStation Blog announced for PS Plus that aren't in it yet
//   data/<xbox|ps>_best_<year>.json   {year, updatedAt, games}: the year's 50 best games by Metascore (released on this
//                 store that year, one per game, as its standard edition; the other store's Metascore when this one has none). Updated through the year and in January (late reviews); then it's kept as it is.
//   data/<xbox|ps>_xref.json   {g: {game: [Metascore, first release]}}: read by the other store's lists (best of the year)
//   <xbox|ps>_home.json sections.pubsale: a row for each big publisher (PUB_ROWS) with more than PUB_MIN games on sale;
//                 sections.acclaimed: the acclaimed studios' upcoming games (the same as the lists'), for the home page's row.
//
// node jobs/lists.js xbox|ps
const fs = require("fs"), path = require("path");
const DATA = path.resolve(process.env.DATA_DIR || "data");
const plat = process.argv[2] === "ps" ? "ps" : "xbox", PS = plat === "ps";
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")); } catch (e) { return d; } };
const write = (f, d) => { fs.mkdirSync(path.dirname(path.join(DATA, f)), { recursive: true }); fs.writeFileSync(path.join(DATA, f), JSON.stringify(d)); };
const DAY = 864e5, NOW = Date.now();
const RECENT_DAYS = 14, BEST_N = 50, META_N = 1200, FREE_N = 80, UPCOMING_N = 600, PUB_MIN = 14, PSPLUS_NEW_DAYS = 45;
const SHARDS = 64;

// ---------- the games (the game pages' files) ----------
const games = {};
for (let n = 0; n < SHARDS; n++) Object.assign(games, (read(plat + "_games_" + n + ".json", { games: {} }).games) || {});
const ids = Object.keys(games);
if (ids.length < 100) { console.log("Lists: the " + plat + " game pages aren't built yet (" + ids.length + " games), nothing written"); process.exit(0); }

const PSI = "https://image.api.playstation.com/vulcan/ap/rnd/";
const art = u => !u ? "" : String(u)[0] === "~" ? PSI + String(u).slice(1) : u;
const mcOf = g => Array.isArray(g.mc) ? Number(g.mc[0]) || 0 : Number(g.mc) || 0;
const relOf = g => { const t = Date.parse(g.r); return t && Number(String(g.r).slice(0, 4)) < 9000 ? t : 0; };
const ADDON = /^(add-?on|add-on pack|map|level|costume|vehicle|character|item|episode|season pass|virtual currency|weapons?|track|avatar|theme|soundtrack|expansion|durable|consumable)$/i;
const NOT_GAME = /\b(add-?ons?|upgrade|season pass|dlc|expansion pass|soundtrack|currency|points|coins|credits|v-bucks|costume|skins?|bonus|demo|trial|beta|playtest|test server|bundle|pack)\b/i;
const isGame = g => g && g.t && !g.a && !g.kd && !ADDON.test(String(g.kd || "")) && !NOT_GAME.test(g.t);
const SUBS_X = ["eaplay", "ubisoft", "gtaplus"];
// PlayStation deals: their key in the regions' price files (psDealKey_, the same edition in every store), so the site
// prices each one in the region picked instead of converting the US price
const DEAL_KEY = {};
if (plat === "ps") ((read("ps_sales.json", { games: [] }).games) || []).forEach(g => { if (g.productId && g.key) DEAL_KEY[g.productId] = g.key; });
// in the site's card shape (site.js card())
const entry = (id, g) => ({
  id, key: DEAL_KEY[id], title: g.t, publisher: g.p || "", image: art(g.i), sq: art(g.q) || null,
  price: Number(g.pr) || 0, msrp: Number(g.m) || Number(g.pr) || 0, currency: g.c || "USD",
  release: relOf(g) > NOW ? g.r : null, released: g.r || null, mc: mcOf(g) || undefined,
  ra: g.ra ? g.ra[0] : undefined, rc: g.ra ? g.ra[1] : 0, genres: (g.g || []).slice(0, 3),
  gp: (g.s || []).some(s => s === "gamepass" || s === "psplus"), xs: (g.s || []).filter(s => SUBS_X.includes(s)), tiers: g.ti || [],
  pc: g.pc ? 1 : undefined, xpa: g.xp ? 1 : undefined, ends: g.e || null, low: g.l ? 1 : undefined, ds: g.ds || undefined,
  f2p: !g.np && !(Number(g.pr) > 0) && !(Number(g.m) > 0) ? 1 : undefined, np: g.np ? 1 : undefined, url: g.u || undefined
});
const clean = e => { Object.keys(e).forEach(k => { if (e[k] === undefined || e[k] === null || (Array.isArray(e[k]) && !e[k].length)) delete e[k]; }); return e; };

// One key per game (every edition and platform version of it), as the game pages' "Other editions" do
const editionKey = t => {
  let s = String(t || "").replace(/[™®©]/g, "").replace(/\s*[([](pc|windows|xbox[^)\]]*|ps[45][^)\]]*|pre-?order)[)\]]\s*$/i, "").replace(/\s*[-–:]?\s*pre-?order\s*$/i, "");
  const parts = s.split(/\s*(?:[:–—|]|\s-\s)\s*/);   // only the part after the last separator can name the edition
  // (a short last part only, "Vault Edition" / "Cross-Gen Bundle": "Legacy of Atlantis Deluxe Edition" keeps its subtitle)
  if (parts.length > 1 && /\b(edition|bundle|version)\b/i.test(parts[parts.length - 1]) && parts[parts.length - 1].split(/\s+/).length <= 3) s = parts.slice(0, -1).join(" ");
  s = s.replace(/\s*((standard|deluxe|ultimate|premium|gold|vault|complete|definitive|digital|collector'?s|anniversary|special|enhanced|legendary|launch|cross-gen|game of the year|goty|platinum|limited|super|plus|\d+(st|nd|rd|th))\s+)+(edition|bundle|version)\b.*$/i, "");
  return s.toLowerCase().replace(/\b(xbox one|xbox series x\|s|xbox series x|for xbox series x\|s|windows( 10)?|for pc|pc|ps4|ps5)\b/g, " ")
    .replace(/\s*(game of the year|goty)\b.*$/, "").replace(/\s*[\(\[].*?[\)\]]/g, "").replace(/[^a-z0-9]+/g, "");
};
// The same publisher however the store spells it (site.js pubKey: the same rule)
const pubKey = p => String(p || "").toLowerCase().normalize("NFKD").replace(/[™®©]/g, "").replace(/[^a-z0-9& ]+/g, " ")
  .replace(/\b(inc|incorporated|ltd|limited|llc|l l c|co|corp|corporation|gmbh|s a|sa|sas|srl|ab|plc|pty|kk|k k|of america|america|europe|usa|us|uk|japan|holdings)\b/g, " ")
  .replace(/\s+/g, " ").trim()
  .replace(/^(.+?)(\s(entertainment|games|game|studios|studio|interactive|publishing|software|softworks|digital|media|productions))+$/, "$1");

// A game, whatever the edition: PlayStation's game id (concept: cn, from the game pages); Xbox has no id shared by a
// game's editions, so there it's the name without the edition
const gid = id => PS && games[id].cn ? "c" + games[id].cn : editionKey(games[id].t);
// A publisher: Xbox's publisher id (pb, from the store's product data); PlayStation gives none, so its name (pubKey)
const pk = g => !PS && g.pb ? "x" + g.pb : pubKey(g.p);
// (maps keyed by names have no prototype: a game called "Constructor" would otherwise find Object's own constructor)
// the best-known edition of each game: the one with the most store ratings, then the standard (cheapest) one
const byGame = Object.create(null);
ids.forEach(id => {
  const g = games[id];
  if (!isGame(g)) return;
  const k = gid(id);
  if (!k) return;
  (byGame[k] = byGame[k] || []).push(id);
});
const rc = id => (games[id].ra && games[id].ra[1]) || 0;
const main = Object.create(null);   // game key -> the edition that stands for it
Object.keys(byGame).forEach(k => {
  main[k] = byGame[k].slice().sort((a, b) => rc(b) - rc(a) || mcOf(games[b]) - mcOf(games[a]) || (games[a].m || 1e9) - (games[b].m || 1e9))[0];
});
// the standard edition of each game (released, when one is): the one without an edition in its name, else the one named
// "Standard", else the cheapest (the best of the year shows it, with its price, rather than a deluxe one)
const EDN = /\b(edition|bundle|version)\b/i;
const stdCmp = (a, b) => EDN.test(games[a].t) - EDN.test(games[b].t) || /pre-?order/i.test(games[a].t) - /pre-?order/i.test(games[b].t) ||
  /standard/i.test(games[b].t) - /standard/i.test(games[a].t) || (games[a].m || 1e9) - (games[b].m || 1e9);
const standard = Object.create(null);   // game key -> its standard edition
Object.keys(byGame).forEach(k => {
  const out = byGame[k].filter(id => relOf(games[id]) && relOf(games[id]) <= NOW);
  standard[k] = (out.length ? out : byGame[k]).slice().sort(stdCmp)[0];
});
const one = list => { const seen = Object.create(null); return list.filter(id => { const k = gid(id); if (seen[k]) return false; seen[k] = 1; return true; }); };
const mains = Object.keys(main).map(k => main[k]);
// a game's name (without its edition) -> its main edition: matching names from outside (IGN, the PlayStation Blog)
const byTitle = Object.create(null);
mains.forEach(id => { const k = editionKey(games[id].t); if (k && (!byTitle[k] || rc(id) > rc(byTitle[k]))) byTitle[k] = id; });

// ---------- recent and upcoming releases ----------
const recent = one(ids.filter(id => isGame(games[id]) && relOf(games[id]) <= NOW && relOf(games[id]) > NOW - RECENT_DAYS * DAY)
  .sort((a, b) => relOf(games[b]) - relOf(games[a]) || rc(b) - rc(a))).map(id => clean(entry(id, games[id])));
const upcoming = one(ids.filter(id => isGame(games[id]) && relOf(games[id]) > NOW && relOf(games[id]) < NOW + 3 * 365 * DAY)
  .sort((a, b) => relOf(games[a]) - relOf(games[b]) || rc(b) - rc(a))).slice(0, UPCOMING_N).map(id => clean(entry(id, games[id])));

// ---------- free-to-play games ----------
// (a store offer priced at 0: not a game that's only in a subscription, nor one without a price yet)
const free = mains.filter(id => { const g = games[id]; return !g.np && !(Number(g.pr) > 0) && !(Number(g.m) > 0) && relOf(g) <= NOW; })
  .sort((a, b) => rc(b) - rc(a)).slice(0, FREE_N).map(id => clean(entry(id, games[id])));

// ---------- the best reviewed ----------
const meta = mains.filter(id => mcOf(games[id]) > 0 && relOf(games[id]) <= NOW).sort((a, b) => mcOf(games[b]) - mcOf(games[a]) || rc(b) - rc(a))
  .slice(0, META_N).map(id => clean(entry(id, games[id])));

// ---------- the same games in the other store ----------
// The Metascore isn't always matched in both stores. So each store's lists job saves, for every game (its name without
// the edition, editionKey), its Metascore and first release date (data/<plat>_xref.json {g: {key: [Metascore, first
// release ms]}}), and the other store's job reads it: a game without a Metascore on this store takes the other store's.
// (The year a game counts in is its first release on this store: a game first out on PlayStation in 2025 that reached
// Xbox in 2026 is in Xbox's 2026 list.)
const OTHER = PS ? "xbox" : "ps";
const firstRel = Object.create(null), xmc = Object.create(null);   // game key -> first release (any edition), best Metascore
ids.forEach(id => {
  const g = games[id];
  if (!isGame(g)) return;
  const k = gid(id);
  if (relOf(g)) firstRel[k] = Math.min(firstRel[k] || Infinity, relOf(g));
  if (mcOf(g)) xmc[k] = Math.max(xmc[k] || 0, mcOf(g));
});
const xrefOut = {};
mains.forEach(id => { const k = editionKey(games[id].t), q = gid(id); if (k && (xmc[q] || firstRel[q])) xrefOut[k] = [xmc[q] || 0, firstRel[q] || 0]; });
write(plat + "_xref.json", { updatedAt: new Date().toISOString(), plat, g: xrefOut });
const other = Object.create(null);
const ox = read(OTHER + "_xref.json", null);
if (ox && ox.g) Object.keys(ox.g).forEach(k => { other[k] = ox.g[k]; });
else (read(OTHER + "_lists.json", {}).meta || []).forEach(e => { const k = editionKey(e.title); if (k) other[k] = [Number(e.mc) || 0, Date.parse(e.released) || 0]; });   // (before the other store's first xref file)
const otherOf = id => other[editionKey(games[id].t)] || null;
console.log("Lists: " + Object.keys(other).length + " games from the " + OTHER + " store to compare with");

// ---------- best of the year (kept for every year) ----------
const year = new Date(NOW).getUTCFullYear();
function bestOf(y) {
  const from = Date.UTC(y, 0, 1), to = Date.UTC(y + 1, 0, 1);
  // a game counts in the year it was first released on this store (its earliest edition here): a game out on the other
  // store years earlier still counts the year it reached this one, and one this store hasn't released yet doesn't count
  const first = id => firstRel[gid(id)];
  // its Metascore on this store, else the other store's for the same game (the game itself has to be on this store)
  const mc = id => mcOf(games[id]) || xmc[gid(id)] || (otherOf(id) || [0])[0];
  // ranked by the game's best-known edition (its ratings), shown as its standard edition
  return mains.filter(id => { const t = first(id); return mc(id) > 0 && t >= from && t < to && t <= NOW; })
    .sort((a, b) => mc(b) - mc(a) || rc(b) - rc(a)).slice(0, BEST_N)
    .map(id => { const sid = standard[gid(id)] || id; return clean(Object.assign(entry(sid, games[sid]), { mc: mc(id), rc: rc(id) || undefined })); });
}
const years = [year].concat(new Date(NOW).getUTCMonth() === 0 ? [year - 1] : []);   // last year's list until January ends
years.forEach(y => {
  const list = bestOf(y), file = plat + "_best_" + y + ".json", old = read(file, null);
  if (list.length < 5 && old && old.games && old.games.length >= list.length) return;   // never replace a list with a much shorter one
  write(file, { year: y, plat, updatedAt: new Date().toISOString(), games: list });
});
// every year with a list (the page's year picker)
const bestYears = fs.readdirSync(DATA).map(f => (f.match(new RegExp("^" + plat + "_best_(\\d{4})\\.json$")) || [])[1]).filter(Boolean).map(Number).sort((a, b) => b - a);

// ---------- publishers: unique games each (editions and add-ons once), most popular first ----------
// popularity: how many store ratings its games have in all (the stores' measure of how many people play them)
const pubs = Object.create(null);
mains.forEach(id => {
  const g = games[id], k = pk(g);
  if (!k) return;
  const p = pubs[k] = pubs[k] || { k, names: Object.create(null), n: 0, sale: 0, ratings: 0, top: [] };
  p.names[g.p] = (p.names[g.p] || 0) + 1;
  p.n++;
  if (Number(g.pr) > 0 && Number(g.m) > Number(g.pr) && !(g.e && Date.parse(g.e) <= NOW)) p.sale++;
  p.ratings += rc(id);
  p.top.push(id);
});
const publishers = Object.keys(pubs).map(k => pubs[k]).filter(p => p.n >= 2).sort((a, b) => b.ratings - a.ratings || b.n - a.n).slice(0, 1500)
  .map((p, i) => {
    const name = Object.keys(p.names).sort((a, b) => p.names[b] - p.names[a] || a.length - b.length)[0];
    const top = i < 300 ? p.top.sort((a, b) => rc(b) - rc(a)).slice(0, 4).map(id => art(games[id].q || games[id].i)).filter(Boolean) : [];
    return clean({ name, k: p.k, n: p.n, sale: p.sale, rc: p.ratings, top });
  });

// every publisher's games (all editions and add-ons), for the publisher pages: {pubs: {key: {name, ids}}, byName: {pubKey(name): key}}
const pubGames = Object.create(null), byName = Object.create(null);
ids.forEach(id => {
  const g = games[id];
  if (!g || g.a || !g.t || !g.p) return;
  const k = pk(g);
  if (!k) return;
  const p = pubGames[k] = pubGames[k] || { names: Object.create(null), ids: [] };
  p.ids.push(id);
  p.names[g.p] = (p.names[g.p] || 0) + 1;
  const nk = pubKey(g.p);
  if (nk && (!byName[nk] || pubGames[byName[nk]].ids.length < p.ids.length)) byName[nk] = k;
});
Object.keys(pubGames).forEach(k => { const p = pubGames[k]; p.name = Object.keys(p.names).sort((a, b) => p.names[b] - p.names[a])[0]; delete p.names; });
write(plat + "_pubgames.json", { updatedAt: new Date().toISOString(), pubs: pubGames, byName });

// ---------- publisher rows on the home page ----------
// The big publishers (names as the stores spell them, by pubKey); a row when more than PUB_MIN of their games are on sale,
// most store ratings first
const PUB_ROWS = [["xbox", "Xbox Game Studios", ["xbox", "microsoft", "xbox game studios publishing"]], ["activision", "Activision", ["activision", "activision blizzard"]],
  ["bethesda", "Bethesda", ["bethesda"]], ["ubisoft", "Ubisoft", ["ubisoft"]], ["ea", "EA", ["electronic arts", "ea", "ea swiss sarl"]], ["2k", "2K", ["2k"]],
  ["rockstar", "Rockstar Games", ["rockstar"]], ["capcom", "Capcom", ["capcom"]], ["squareenix", "Square Enix", ["square enix"]],
  ["bandainamco", "Bandai Namco", ["bandai namco"]], ["sony", "PlayStation Studios", ["sony", "playstation", "sony interactive", "playstation publishing", "playstation mobile"]],
  ["sega", "SEGA", ["sega", "atlus"]], ["konami", "Konami", ["konami", "konami digital"]]];
const pubsale = [];
PUB_ROWS.forEach(([key, name, keys]) => {
  const list = mains.filter(id => { const g = games[id]; return keys.includes(pubKey(g.p)) && Number(g.pr) > 0 && Number(g.m) > Number(g.pr) && !(g.e && Date.parse(g.e) <= NOW); });
  if (list.length <= PUB_MIN) return;
  pubsale.push({ key, name, pub: Object.keys(list.reduce((m, id) => { m[games[id].p] = 1; return m; }, {}))[0], n: list.length,
                 games: list.sort((a, b) => rc(b) - rc(a)).slice(0, 20).map(id => clean(entry(id, games[id]))) });
});
pubsale.sort((a, b) => b.games.reduce((s, g) => s + (g.rc || 0), 0) - a.games.reduce((s, g) => s + (g.rc || 0), 0));
const homeFile = plat + "_home.json", home = read(homeFile, null);
if (home && home.sections) { home.sections.pubsale = pubsale; write(homeFile, home); }

// ---------- upcoming games from acclaimed studios (Xbox) / publishers (PlayStation) ----------
// The studios whose released games have the most store ratings and the best review scores, and their games still to
// come. Xbox: the developer (dv, from the store's product data: xPublisherIds_), else the publisher; PlayStation's store
// names no developer, so there it's the publisher (pk).
//   acclaim of a studio = its average review score (Metascore, else stars x 20 with 50+ ratings) x log10(1 + all its
//   games' store ratings); it needs ACCLAIM_MIN_SCORED games with a score and ACCLAIM_MIN_RATINGS ratings in all.
const ACCLAIM_STUDIOS = 40, ACCLAIM_MIN_SCORED = 2, ACCLAIM_MIN_RATINGS = PS ? 20000 : 5000, ACCLAIMED_N = 80;
const reviewScore = g => mcOf(g) || (g.ra && g.ra[1] >= 50 ? Number(g.ra[0]) * 20 : 0);
const studioKey = g => !PS && g.dv ? "d" + pubKey(g.dv) : pk(g);
const studioName = g => !PS && g.dv ? g.dv : g.p || "";
function acclaimed() {
  const st = Object.create(null);
  mains.forEach(id => {
    const g = games[id];
    if (!relOf(g) || relOf(g) > NOW) return;
    const k = studioKey(g);
    if (!k || k === "d") return;
    const s = st[k] || (st[k] = { name: studioName(g), n: 0, rc: 0, scored: 0, sum: 0 });
    s.n++; s.rc += rc(id);
    const sc = reviewScore(g);
    if (sc) { s.scored++; s.sum += sc; }
  });
  const top = Object.keys(st).map(k => Object.assign({ k }, st[k], { score: st[k].scored ? st[k].sum / st[k].scored : 0 }))
    .filter(s => s.scored >= ACCLAIM_MIN_SCORED && s.rc >= ACCLAIM_MIN_RATINGS)
    .map(s => Object.assign(s, { acclaim: s.score * Math.log10(1 + s.rc) }))
    .sort((a, b) => b.acclaim - a.acclaim).slice(0, ACCLAIM_STUDIOS);
  const rank = Object.create(null);
  top.forEach((s, i) => { rank[s.k] = i; });
  // their games still to come (with a date, within 3 years), soonest first, one per game: its standard edition (the one
  // without an edition in its name, else the cheapest), dated by its earliest edition (early access)
  const coming = Object.create(null);
  ids.forEach(id => {
    const g = games[id];
    if (!isGame(g) || !(relOf(g) > NOW && relOf(g) < NOW + 3 * 365 * DAY) || rank[studioKey(g)] === undefined) return;
    const k = gid(id), c = coming[k] || (coming[k] = { ids: [], t: Infinity });
    c.ids.push(id); c.t = Math.min(c.t, relOf(g));
  });
  const list = Object.keys(coming).map(k => {
    const c = coming[k], rep = c.ids.slice().sort(stdCmp)[0];
    return { id: rep, t: c.t };
  }).sort((a, b) => a.t - b.t || rank[studioKey(games[a.id])] - rank[studioKey(games[b.id])]).slice(0, ACCLAIMED_N).map(x => x.id);
  return {
    by: PS ? "publisher" : "studio",
    studios: top.map(s => ({ name: s.name, games: s.n, ratings: s.rc, score: Math.round(s.score) })),
    games: list.map(id => Object.assign(clean(entry(id, games[id])), { studio: studioName(games[id]) }))
  };
}

// ---------- PS Plus: new in the catalog, and announced ----------
const PSPLUS_TIERS = ["psessential", "psextra", "pspremium"];
async function psPlus() {
  const seenFile = "ps_plus_seen.json", seen = read(seenFile, null), first = !seen, s = seen || {};
  const now = new Set(ids.filter(id => isGame(games[id]) && (games[id].ti || []).some(t => PSPLUS_TIERS.includes(t))));
  now.forEach(id => { if (!s[id]) s[id] = first ? 1 : NOW; });   // the first run: everything already there is "not new" (1)
  Object.keys(s).forEach(id => { if (!now.has(id)) delete s[id]; });   // left the catalog: new again if it comes back
  write(seenFile, s);
  const added = one(Object.keys(s).filter(id => s[id] > NOW - PSPLUS_NEW_DAYS * DAY).sort((a, b) => s[b] - s[a] || rc(b) - rc(a)))
    .map(id => Object.assign(clean(entry(id, games[id])), { added: new Date(s[id]).toISOString().slice(0, 10) }));
  // the PlayStation Blog's monthly announcements: "PlayStation Plus Monthly Games for December: A, B, C" and
  // "PlayStation Plus Game Catalog for December: A, B, C and more"
  let coming = [];
  try {
    const r = await fetch("https://blog.playstation.com/feed/", { headers: { "User-Agent": "Mozilla/5.0 GameDealTrack lists" } });
    const xml = r.ok ? await r.text() : "";
    const items = xml.split(/<item>/).slice(1).map(x => ({
      title: ((x.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || "").replace(/&#8217;/g, "'").replace(/&amp;/g, "&").replace(/&#8211;|&#8212;/g, "-"),
      date: Date.parse((x.match(/<pubDate>([^<]+)<\/pubDate>/) || [])[1]) || 0
    }));
    const byKey = byTitle;
    const out = [];
    items.filter(it => /playstation plus (monthly games|game catalog|games? catalog|extra|premium)/i.test(it.title) && it.date > NOW - 35 * DAY).forEach(it => {
      const tier = /monthly/i.test(it.title) ? "Essential" : /premium/i.test(it.title) ? "Premium" : "Extra & Premium";
      const list = String(it.title.split(/:\s*/).slice(1).join(": ")).replace(/,?\s*(and|&)\s*more\b.*$/i, "");
      list.split(/,\s*|\s+(?:and|&)\s+/).forEach(n => {
        const id = byKey[editionKey(n)];
        if (id && !now.has(id) && !out.some(x => x.id === id)) out.push(Object.assign(clean(entry(id, games[id])), { tier, announced: new Date(it.date).toISOString().slice(0, 10) }));
      });
    });
    coming = out;
  } catch (e) { console.log("PS Plus announcements couldn't be read: " + e.message); }
  if (!coming.length) { const old = read(plat + "_lists.json", {}); coming = ((old.psplus || {}).coming || []).filter(g => !now.has(g.id)); }   // keep the last ones found
  return { added, coming };
}

(async () => {
  const out = { updatedAt: new Date().toISOString(), plat, year, bestYears, recent, upcoming, free, meta, publishers, acclaimed: acclaimed() };
  if (PS) out.psplus = await psPlus();
  write(plat + "_lists.json", out);
  // the home page's row: the same games, soonest first (it replaces the "Most wanted" row). Xbox only: PlayStation's home
  // page has no "From acclaimed publishers" row (the list page keeps it)
  const h = read(homeFile, null);
  if (h && h.sections) {
    if (PS) { delete h.sections.acclaimed; delete h.sections.acclaimedBy; }
    else { h.sections.acclaimed = out.acclaimed.games.slice(0, 20); h.sections.acclaimedBy = out.acclaimed.by; }
    delete h.sections.wanted; delete h.sections.wantedSrc; write(homeFile, h);
  }
  console.log("Lists (" + plat + "): recent " + recent.length + ", upcoming " + upcoming.length + ", free " + free.length + ", Metacritic " + meta.length +
    ", publishers " + publishers.length + ", best of " + years.join("/") + ", acclaimed " + out.acclaimed.by + "s' upcoming games " + out.acclaimed.games.length + " (top: " + out.acclaimed.studios.slice(0, 8).map(s => s.name).join(", ") + ")" +
    (PS ? ", PS Plus added " + out.psplus.added.length + ", coming " + out.psplus.coming.length : "") + ", publisher rows " + pubsale.map(p => p.name + " " + p.n).join(", "));
})();
