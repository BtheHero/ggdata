// The site's list pages, after each Xbox and PlayStation run (after the game pages, which it reads).
//
//   data/<xbox|ps>_lists.json        {updatedAt, plat, year, recent, upcoming, free, meta, publishers, wanted, psplus}
//     recent      games released in the last RECENT_DAYS days, newest first
//     upcoming    every game with a release date still to come, soonest first (the release schedule)
//     free        popular free-to-play games, most store ratings first
//     meta        the best-reviewed games (Metascore), best first, with genres (the Top Metacritic page filters them)
//     publishers  every publisher with its number of games: editions and add-ons of a game count once
//     wanted      the most wanted games: IGN's "most wanted" list (WANTED_URL, read every run) matched to this store's
//                 games, without the ones already released; when the list can't be read for WANTED_KEEP_DAYS, the
//                 unreleased games most wishlisted on the site instead
//     psplus      PlayStation only: {added, coming}: games new in the PS Plus catalog (first seen in it within
//                 PSPLUS_NEW_DAYS), and games the PlayStation Blog announced for PS Plus that aren't in it yet
//   data/<xbox|ps>_best_<year>.json   {year, updatedAt, games}: the year's 50 best games by Metascore (released that
//                 year, one per game). Updated through the year and in January (late reviews); then it's kept as it is.
//   <xbox|ps>_home.json sections.pubsale: a row for each big publisher (PUB_ROWS) with more than PUB_MIN games on sale.
//
// node jobs/lists.js xbox|ps
const fs = require("fs"), path = require("path");
const DATA = path.resolve(process.env.DATA_DIR || "data");
const plat = process.argv[2] === "ps" ? "ps" : "xbox", PS = plat === "ps";
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")); } catch (e) { return d; } };
const write = (f, d) => { fs.mkdirSync(path.dirname(path.join(DATA, f)), { recursive: true }); fs.writeFileSync(path.join(DATA, f), JSON.stringify(d)); };
const DAY = 864e5, NOW = Date.now();
const RECENT_DAYS = 14, BEST_N = 50, META_N = 1200, FREE_N = 80, UPCOMING_N = 600, PUB_MIN = 14, PSPLUS_NEW_DAYS = 45;
const WANTED_URL = "https://www.ign.com/playlist/igneditorial/lists/most-wanted-games-2024-and-beyond";
const WANTED_KEEP_DAYS = 14;   // a list read from IGN is used this long when IGN can't be read
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
// in the site's card shape (site.js card())
const entry = (id, g) => ({
  id, title: g.t, publisher: g.p || "", image: art(g.i), sq: art(g.q) || null,
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
  let s = String(t || "").replace(/[™®©]/g, "").replace(/\s*[([](pc|windows|xbox[^)\]]*|ps[45][^)\]]*)[)\]]\s*$/i, "");
  const parts = s.split(/\s*(?:[:–—|]|\s-\s)\s*/);   // only the part after the last separator can name the edition
  if (parts.length > 1 && /\b(edition|bundle|version)\b/i.test(parts[parts.length - 1])) s = parts.slice(0, -1).join(" ");
  s = s.replace(/\s*((standard|deluxe|ultimate|premium|gold|vault|complete|definitive|digital|collector'?s|anniversary|special|enhanced|legendary|launch|cross-gen|game of the year|goty|platinum|limited|super|\d+(st|nd|rd|th))\s+)+(edition|bundle)\b.*$/i, "");
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
// the best-known edition of each game: the one with the most store ratings, then the standard (cheapest) one
const byGame = {};
ids.forEach(id => {
  const g = games[id];
  if (!isGame(g)) return;
  const k = gid(id);
  if (!k) return;
  (byGame[k] = byGame[k] || []).push(id);
});
const rc = id => (games[id].ra && games[id].ra[1]) || 0;
const main = {};   // game key -> the edition that stands for it
Object.keys(byGame).forEach(k => {
  main[k] = byGame[k].slice().sort((a, b) => rc(b) - rc(a) || mcOf(games[b]) - mcOf(games[a]) || (games[a].m || 1e9) - (games[b].m || 1e9))[0];
});
const one = list => { const seen = {}; return list.filter(id => { const k = gid(id); if (seen[k]) return false; seen[k] = 1; return true; }); };
const mains = Object.keys(main).map(k => main[k]);
// a game's name (without its edition) -> its main edition: matching names from outside (IGN, the PlayStation Blog)
const byTitle = {};
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

// ---------- best of the year (kept for every year) ----------
const year = new Date(NOW).getUTCFullYear();
function bestOf(y) {
  const from = Date.UTC(y, 0, 1), to = Date.UTC(y + 1, 0, 1);
  // a game counts in the year of its first release (its earliest edition)
  const first = {};
  ids.forEach(id => { const g = games[id]; if (!isGame(g) || !relOf(g)) return; const k = gid(id); first[k] = Math.min(first[k] || Infinity, relOf(g)); });
  return mains.filter(id => { const t = first[gid(id)]; return mcOf(games[id]) > 0 && t >= from && t < to && t <= NOW; })
    .sort((a, b) => mcOf(games[b]) - mcOf(games[a]) || rc(b) - rc(a)).slice(0, BEST_N).map(id => clean(entry(id, games[id])));
}
const years = [year].concat(new Date(NOW).getUTCMonth() === 0 ? [year - 1] : []);   // last year's list until January ends
years.forEach(y => {
  const list = bestOf(y), file = plat + "_best_" + y + ".json", old = read(file, null);
  if (list.length < 5 && old && old.games && old.games.length >= list.length) return;   // never replace a list with a much shorter one
  write(file, { year: y, plat, updatedAt: new Date().toISOString(), games: list });
});
// every year with a list (the page's year picker)
const bestYears = fs.readdirSync(DATA).map(f => (f.match(new RegExp("^" + plat + "_best_(\\d{4})\\.json$")) || [])[1]).filter(Boolean).map(Number).sort((a, b) => b - a);

// ---------- publishers: unique games each (editions and add-ons once) ----------
const pubs = {};
mains.forEach(id => {
  const g = games[id], k = pk(g);
  if (!k) return;
  const p = pubs[k] = pubs[k] || { k, names: {}, n: 0, sale: 0, ratings: 0, top: [] };
  p.names[g.p] = (p.names[g.p] || 0) + 1;
  p.n++;
  if (Number(g.pr) > 0 && Number(g.m) > Number(g.pr) && !(g.e && Date.parse(g.e) <= NOW)) p.sale++;
  p.ratings += rc(id);
  p.top.push(id);
});
const publishers = Object.keys(pubs).map(k => pubs[k]).filter(p => p.n >= 2).sort((a, b) => b.n - a.n || b.ratings - a.ratings).slice(0, 1500)
  .map((p, i) => {
    const name = Object.keys(p.names).sort((a, b) => p.names[b] - p.names[a] || a.length - b.length)[0];
    const top = i < 300 ? p.top.sort((a, b) => rc(b) - rc(a)).slice(0, 4).map(id => art(games[id].q || games[id].i)).filter(Boolean) : [];
    return clean({ name, k: p.k, n: p.n, sale: p.sale, rc: p.ratings, top });
  });

// every publisher's games (all editions and add-ons), for the publisher pages: {pubs: {key: {name, ids}}, byName: {pubKey(name): key}}
const pubGames = {}, byName = {};
ids.forEach(id => {
  const g = games[id];
  if (!g || g.a || !g.t || !g.p) return;
  const k = pk(g);
  if (!k) return;
  const p = pubGames[k] = pubGames[k] || { names: {}, ids: [] };
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

// ---------- most wanted ----------
// IGN's list, in order: [{name, alt, rel, url}]. The page is built by Next.js: its data is in __NEXT_DATA__, and the
// list itself is in props.apolloState, compressed with lz-string (UTF-16). The page holds the list's first 20 games
// (IGN loads the rest as you scroll), which is the top of the list.
//   rel: the game's earliest US release date that IGN gives as a day (not an estimate), "" when it has none
function lzUTF16(input) {   // lz-string's decompressFromUTF16
  if (!input) return "";
  const len = input.length, val = i => input.charCodeAt(i) - 32, reset = 16384, dict = [0, 1, 2], f = String.fromCharCode;
  let enlargeIn = 4, dictSize = 4, numBits = 3, entry = "", result = [], w, c, bits, resb, maxpower, power;
  const data = { val: val(0), position: reset, index: 1 };
  const read = n => {
    bits = 0; maxpower = Math.pow(2, n); power = 1;
    while (power != maxpower) {
      resb = data.val & data.position; data.position >>= 1;
      if (data.position == 0) { data.position = reset; data.val = val(data.index++); }
      bits |= (resb > 0 ? 1 : 0) * power; power <<= 1;
    }
    return bits;
  };
  switch (read(2)) { case 0: c = f(read(8)); break; case 1: c = f(read(16)); break; default: return ""; }
  dict[3] = c; w = c; result.push(c);
  while (true) {
    if (data.index > len) return "";
    switch (c = read(numBits)) {
      case 0: dict[dictSize++] = f(read(8)); c = dictSize - 1; enlargeIn--; break;
      case 1: dict[dictSize++] = f(read(16)); c = dictSize - 1; enlargeIn--; break;
      case 2: return result.join("");
    }
    if (enlargeIn == 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
    if (dict[c]) entry = dict[c]; else if (c === dictSize) entry = w + w.charAt(0); else return null;
    result.push(entry);
    dict[dictSize++] = w + entry.charAt(0); enlargeIn--;
    w = entry;
    if (enlargeIn == 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
  }
}
async function ignWanted() {
  const r = await fetch(WANTED_URL, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", "Accept": "text/html" } });
  if (!r.ok) throw new Error("IGN answered " + r.status);
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no page data");
  let st = JSON.parse(m[1]).props || {};
  st = st.apolloState || (st.pageProps || {}).apolloState;
  if (typeof st === "string") st = JSON.parse(lzUTF16(st) || "null");
  if (!st || typeof st !== "object") throw new Error("no list data in the page");
  const ref = x => x && x.__ref ? st[x.__ref] : x;
  const list = Object.values(st).find(v => v && v.__typename === "UserList") || {};
  const conn = Object.keys(list).filter(k => k.startsWith("objects")).map(k => list[k])[0] || {};
  const items = Object.values(st).filter(v => v && v.__typename === "UserListObject").sort((a, b) => a.position - b.position);
  const out = [];
  items.forEach(it => {
    const o = ref(it.object) || {}, names = (o.metadata && o.metadata.names) || {};
    if (!names.name || (o.type && o.type !== "Game")) return;
    const regions = (o.objectRegions || []).map(ref).filter(Boolean), us = regions.filter(x => x.region === "US");
    const dates = [];
    (us.length ? us : regions).forEach(x => (x.releases || []).map(ref).forEach(rel => { if (rel && rel.date && !rel.estimatedDate) dates.push(rel.date); }));
    out.push({
      name: names.name.replace(/\s+/g, " ").trim(),
      alt: [].concat(names.alt || [], names.short || []).map(n => String(n).replace(/\s+/g, " ").trim()).filter(Boolean),
      rel: dates.sort()[0] || "", url: o.url ? "https://www.ign.com" + o.url : ""
    });
  });
  if (out.length < 5) throw new Error("only " + out.length + " games found on the page");
  const total = conn.pageInfo && conn.pageInfo.total;
  if (total > out.length) console.log("Most wanted: IGN's page holds the first " + out.length + " of its " + total + " games");
  return out;
}
const today = new Date(NOW).toISOString().slice(0, 10);
async function wanted() {
  const cacheFile = "ign_wanted.json";
  let ign = null, src = "ign", at = null;
  try { ign = await ignWanted(); at = new Date().toISOString(); write(cacheFile, { updatedAt: at, games: ign }); }
  catch (e) {
    const old = read(cacheFile, null);
    console.log("Most wanted: IGN's list couldn't be read (" + e.message + ")" + (old ? ", using the copy from " + old.updatedAt : ""));
    if (old && NOW - Date.parse(old.updatedAt) < WANTED_KEEP_DAYS * DAY) { ign = old.games || (old.names || []).map(name => ({ name, alt: [], rel: "" })); at = old.updatedAt; }
  }
  let list = [];
  if (ign) {
    // each game, matched to this store's game of the same name (any edition, or one of IGN's other names for it: the
    // first one that isn't out yet, so an older game of the same name isn't taken for it); a game is left out once
    // it's out: IGN gives a release date that has come, or the only store games it matches have been released
    const released = [], isOut = id => relOf(games[id]) && relOf(games[id]) <= NOW;
    ign.forEach(w => {
      const found = [w.name].concat(w.alt || []).map(n => byTitle[editionKey(n)]).filter(id => id != null);
      const id = found.find(id => !isOut(id));
      if ((w.rel && w.rel <= today) || (!id && found.length)) { released.push(w.name); return; }
      if (id && !list.includes(id)) list.push(id);
    });
    if (released.length) console.log("Most wanted: left out " + released.length + " released: " + released.join(", "));
    if (list.length < 5) { console.log("Most wanted: only " + list.length + " of IGN's " + ign.length + " games are unreleased on this store; using wishlists"); list = []; }
    else console.log("Most wanted: " + list.length + " of IGN's " + ign.length + " games (" + (ign.length - released.length - list.length) + " not on this store)");
  }
  if (!list.length) {   // the unreleased games most wishlisted on the site
    src = "wishlist"; at = new Date().toISOString();
    const wc = read("wishcounts.json", {}), n = id => Number(wc[id] || wc[String(id).toUpperCase()] || wc[String(id).toLowerCase()]) || 0;
    list = one(ids.filter(id => isGame(games[id]) && n(id) > 0 && !(relOf(games[id]) && relOf(games[id]) <= NOW) && (PS ? !/^[A-Z0-9]{12}$/i.test(id) : /^[A-Z0-9]{12}$/i.test(id))).sort((a, b) => n(b) - n(a))).slice(0, 50);
    return { src, at, games: list.map(id => Object.assign(clean(entry(id, games[id])), { wc: n(id) })) };
  }
  return { src, at, url: WANTED_URL, games: list.slice(0, 100).map(id => clean(entry(id, games[id]))) };
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
  const out = { updatedAt: new Date().toISOString(), plat, year, bestYears, recent, upcoming, free, meta, publishers, wanted: await wanted() };
  if (PS) out.psplus = await psPlus();
  write(plat + "_lists.json", out);
  console.log("Lists (" + plat + "): recent " + recent.length + ", upcoming " + upcoming.length + ", free " + free.length + ", Metacritic " + meta.length +
    ", publishers " + publishers.length + ", best of " + years.join("/") + ", most wanted " + out.wanted.games.length + " (" + out.wanted.src + ")" +
    (PS ? ", PS Plus added " + out.psplus.added.length + ", coming " + out.psplus.coming.length : "") + ", publisher rows " + pubsale.map(p => p.name + " " + p.n).join(", "));
})();
