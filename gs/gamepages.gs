// Game pages of both stores (data/xbox_games_<n>.json, data/ps_games_<n>.json), from the files the other jobs save.
// Run by run.js (jobs "pages" and "pspages").
// ---------- Game pages (gamedealtrack.com/game/...) ----------
// A page for every game. The site's Cloudflare function builds each page from small "shard" files written here:
// every game of a platform goes in one of GAME_SHARDS files by its id (shardOf_), so a page only needs one small file.
//
// Run exportGamePages once by hand, then createGamePagesTrigger once: it then runs after the exports, twice a day
// (Xbox, then PlayStation in a second run that starts by itself).
// It only reads files the exports already saved (full game list, deals, ratings, Metacritic, price history),
// so it uses no requests to the stores.

const GAME_SHARDS = 64;

// ---------- Add-ons ----------
// PlayStation lists add-ons with the games on sale; their kind says which is which ("Map", "Costume", "Season Pass"…).
// Xbox's are looked up separately (XboxAddOns.gs), with a kind guessed from the title.
// Each add-on is matched to its game by name (add-on titles start with the game's: "theHunter: Call of the Wild - Yukon
// Valley"), so the game's page can list its add-ons (on sale first) and the add-on's page can link to its game.
const PS_ADDON_KINDS = /^(add-?on|add-on pack|map|level|costume|vehicle|character|item|episode|season pass|virtual currency|weapons?|track|avatar|theme|soundtrack|expansion)$/i;
const ADDONS_MAX = 40;   // add-ons kept for a game's page (on sale first); adn = how many it has in all, ads = how many are on sale
const addOnName_ = t => String(t || "").toLowerCase().replace(/[™®©]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
// extra: add-ons that aren't on sale (no page of their own; their card links to the store):
// [{id, t title, a art, m regular price, kd kind, o order}]
function attachAddOns_(games, extra, ps) {
  // the name of every game (not add-on) -> its id; the better-known game wins when names repeat
  const byName = {};
  Object.keys(games).forEach(id => {
    const g = games[id];
    if (g.a || g.kd || !g.t) return;
    const n = addOnName_(cleanTitle_(g.t));
    if (n.length < 3) return;
    const old = byName[n] && games[byName[n]];
    if (!old || ((g.ra && g.ra[1]) || 0) > ((old.ra && old.ra[1]) || 0)) byName[n] = id;
  });
  // the game an add-on belongs to: the longest game name its title starts with (word by word)
  const parentOf = (id, title) => {
    const words = addOnName_(title).split(" ");
    for (let k = words.length - 1; k >= 1; k--) {
      const parent = byName[words.slice(0, k).join(" ")];
      if (parent && parent !== id) return parent;
    }
    return null;
  };
  const art = u => ps ? String(u || "").replace("https://image.api.playstation.com/vulcan/ap/rnd/", "~") : (u || "");
  const lists = {};
  let matched = 0;
  Object.keys(games).forEach(id => {
    const g = games[id];
    if (!g.kd) return;
    const parent = parentOf(id, g.t);
    if (!parent) return;
    g.ao = [parent, games[parent].t];
    (lists[parent] = lists[parent] || []).push([id, g.t, art(g.q || g.i), g.pr || 0, g.m || 0, g.kd, 1, 0]);
    matched++;
  });
  let more = 0;
  (extra || []).forEach(x => {
    if (games[x.id] && games[x.id].kd) return;   // on sale: already listed
    const parent = parentOf(x.id, x.t);
    if (!parent) return;
    (lists[parent] = lists[parent] || []).push([x.id, x.t, art(x.a), x.m || 0, x.m || 0, x.kd || "Add-on", 0, x.o || 0]);
    more++;
  });
  const off = r => r[4] > r[3] ? 1 - r[3] / r[4] : 0;
  Object.keys(lists).forEach(id => {
    // the Xbox and Windows listings of one add-on ("… - Windows 10") once
    const same = {};
    const list = lists[id].sort((a, b) => b[6] - a[6] || off(b) - off(a) || a[7] - b[7] || /windows/i.test(a[1]) - /windows/i.test(b[1]))
      .filter(r => {
        const k = addOnName_(String(r[1]).replace(/[\s\-–:(]*(windows( 10)?|pc|xbox one|xbox series x\|s)\)?\s*$/i, ""));
        return same[k] ? false : (same[k] = 1);
      });
    const g = games[id];
    g.adn = list.length;
    g.ads = list.filter(r => r[6]).length;
    g.ad = list.slice(0, ADDONS_MAX).map(r => r[6] ? r.slice(0, 6) : r.slice(0, 7));   // [id, title, art, price, regular price, kind(, 0 = no page)]
  });
  return matched + " on sale, " + more + " more not on sale";
}

// PlayStation only lists add-ons that are on sale. Every one seen on sale is remembered here
// (ps_addons_seen.json: {a: {id: [title, art, regular price, kind, last seen ms]}}), so a game's page
// still lists it, at its regular price, once its sale is over.
const PS_ADDONS_KEEP_DAYS = 365;
function psAddOnsSeen_(games) {
  const seen = psReadJson_("PS_ADDONS_SEEN_FILE_ID", { a: {} }).a || {};
  const now = Date.now();
  Object.keys(games).forEach(id => {
    const g = games[id];
    if (g.kd && g.t) seen[id] = [g.t, g.q || g.i || "", g.m || g.pr || 0, g.kd, now];
  });
  Object.keys(seen).forEach(id => { if (now - seen[id][4] > PS_ADDONS_KEEP_DAYS * 864e5) delete seen[id]; });
  try { saveJsonToDrive_({ updatedAt: new Date().toISOString(), a: seen }, "ps_addons_seen.json", "PS_ADDONS_SEEN_FILE_ID"); }
  catch (e) { console.log("Couldn't save the PlayStation add-ons seen: " + e.message); }
  return Object.keys(seen).map(id => ({ id: id, t: seen[id][0], a: seen[id][1], m: seen[id][2], kd: seen[id][3], o: 0 }));
}

// Every Xbox add-on found by exportXboxAllAddOns (XboxAddOns.gs), for the add-ons not on sale
function xAddOnsAll_() {
  const all = psReadJson_("XADDONS_ALL_FILE_ID", { a: {} }).a || {};
  return Object.keys(all).map(id => ({ id: id, t: all[id][0], a: all[id][1], m: all[id][2], kd: all[id][3], o: all[id][6] || 0 }));
}

// ---------- Related games ("Games you may also like") ----------
// Up to RELATED_MAX games for each game page, picked here once per export (so pages stay fast). A game is scored on:
// - what its store description talks about: the distinctive words two descriptions share ("tanks", "aircraft",
//   "farming", "zombies"…), weighted so words most games use count for little (tf-idf, cosine similarity);
// - its genres, weighted the same way: sharing "Simulation" means more than sharing "Action & adventure";
// - the same series (titles that start with the same 2+ words: "Assassin's Creed …"; at most 4), and the same publisher.
// A game needs a similar description, a series, or (for games without a description) closely matching genres to be
// picked at all. The number of store ratings breaks ties and keeps obscure games out. Never another edition of the same
// game, nor add-ons and bundles. Each pick: [id, title, art, price, regular price].
const RELATED_MAX = 8;
const REL_TERMS = 25;         // most distinctive words kept per description
const REL_TERM_GAMES = 80;    // best-known games kept per word, to find candidates
// words that say nothing about what a game is like
const REL_STOP = ("about above after again against also among another anyone around available based become becomes before being below best "
  + "better between beyond both bring brings brand build built cannot come comes complete content could create created day days deluxe "
  + "different digital discover each easy edition editions enjoy enter entire epic even ever every everything experience experiences "
  + "explore features feature find first follow friends from full fully game games gameplay gaming get gets give great have here high "
  + "hours include included includes including into journey just keep know last latest level levels like live make makes many more most "
  + "much must need never next only other others over own pack part play played player players playing plus power purchase ready "
  + "real really require required requires right same series several should since some something soon special standard start still "
  + "story such take takes than that their them then there these they thing things this those through time today together total true "
  + "ultimate under unique unlock unlocks upon very want ways well were what when where which while will with within without world "
  + "would year years your yours yourself xbox windows playstation console consoles online offline multiplayer single mode modes "
  + "version versions update updates access bonus bonuses item items original remastered anniversary collection free purchase "
  + "copy store download downloadable additional optional subscription sold separately internet connection account terms "
  + "rated rating esrb pegi license licence trademarks trademark rights reserved inc ltd llc").split(" ")
  .reduce((m, w) => { m[w] = 1; return m; }, {});
function relWords_(text) {
  const out = [];
  String(text || "").toLowerCase().replace(/[™®©]/g, "").replace(/[^a-z' ]+/g, " ").split(/\s+/).forEach(w => {
    w = w.replace(/'s$/, "").replace(/'/g, "");
    if (w.length < 4 || REL_STOP[w]) return;
    if (w.length > 4 && /[^s]s$/.test(w)) w = w.slice(0, -1);   // "tanks" = "tank"
    if (!REL_STOP[w]) out.push(w);
  });
  return out;
}
// One key for every edition of a game, including those named after a colon or dash:
// "Minecraft: Java & Bedrock Edition for PC" and "Disney Dreamlight Valley—Ultimate Edition" are Minecraft and Disney
// Dreamlight Valley (but "Halo 3: ODST" stays its own game)
const REL_EDITION = /\b(edition|collection|bundle|for pc|windows( 10)?|pc|xbox one|xbox series x\|s|ps4|ps5|remaster(ed)?|definitive|deluxe|ultimate|complete|goty|game of the year)\b/i;
function relBase_(t) {
  const m = String(t || "").match(/^(.+?)\s*(?:[:—–]|\s-\s)\s*(.+)$/);
  return editionKey_(m && REL_EDITION.test(m[2]) ? m[1] : t);
}
function addRelated_(games, ps) {
  const STOP = { the: 1, a: 1, an: 1, of: 1, and: 1, "&": 1 };
  const list = Object.keys(games).filter(id => !games[id].a && games[id].t).map(id => {
    const g = games[id];
    const words = String(g.t).toLowerCase().replace(/[™®©]/g, "").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
    const lead = words.filter(w => !STOP[w]);   // "God of War" and "God of Weapons" don't share "god of"
    return { id: id, g: g, ed: relBase_(g.t), ed2: editionKey_(g.t), words: lead, pre: lead.slice(0, 2).join(" "), pop: (g.ra && g.ra[1]) || 0,
             sale: g.pr > 0 && g.m > g.pr ? 1 : 0, gen: g.g || [], pub: String(g.p || "").toLowerCase() };
  });
  // add-ons, upgrades, currency and bundles aren't suggested (they're not games of their own)
  const NOT_GAME = /\b(add-?ons?|upgrade|season pass|dlc|expansion pass|soundtrack|launcher|bundle|pack|credits|currency|points|coins|virtual currency|costume|skins?|purchase bonus|pre-?order bonus)\b/i;
  list.forEach(x => { x.extra = !!x.g.kd || NOT_GAME.test(x.g.t); });
  const N = list.length || 1;
  const byPop = (a, b) => b.pop - a.pop;

  // description words: tf-idf vectors (unit length) of the REL_TERMS most distinctive words of each game
  const df = {};
  list.forEach(x => {
    x.tok = relWords_(x.g.d);
    const seen = {};
    x.tok.forEach(w => { if (!seen[w]) { seen[w] = 1; df[w] = (df[w] || 0) + 1; } });
  });
  const maxDf = Math.max(20, N * 0.06);   // words in more than 6% of descriptions aren't distinctive
  list.forEach(x => {
    if (!x.tok.length) return;
    const tf = {};
    x.tok.forEach(w => { if (df[w] >= 2 && df[w] <= maxDf) tf[w] = Math.min(3, (tf[w] || 0) + 1); });
    const terms = Object.keys(tf).map(w => [w, (1 + Math.log(tf[w])) * Math.log(N / df[w])]).sort((a, b) => b[1] - a[1]).slice(0, REL_TERMS);
    const len = Math.sqrt(terms.reduce((s, t) => s + t[1] * t[1], 0)) || 1;
    if (terms.length >= 3) x.vec = terms.map(t => [t[0], t[1] / len]);
    delete x.tok;
  });
  // genre weights: rarer genres say more
  const gdf = {};
  list.forEach(x => x.gen.forEach(gn => { gdf[gn] = (gdf[gn] || 0) + 1; }));
  const gw = gn => Math.log(N / (gdf[gn] || 1)) + 0.1;
  list.forEach(x => { x.glen = Math.sqrt(x.gen.reduce((s, gn) => s + gw(gn) * gw(gn), 0)) || 1; });
  const genreSim = (x, y) => { let s = 0; x.gen.forEach(gn => { if (y.gen.indexOf(gn) >= 0) s += gw(gn) * gw(gn); }); return s / (x.glen * y.glen); };

  // indexes: each description word (its best-known games), series (first two words), each genre, each publisher
  const idx = (key, max) => {
    const m = {};
    list.forEach(x => { if (!x.extra) key(x).forEach(k => { if (k) (m[k] = m[k] || []).push(x); }); });
    Object.keys(m).forEach(k => { m[k].sort(byPop); if (max) m[k] = m[k].slice(0, max); });
    return m;
  };
  const termIdx = idx(x => x.vec ? x.vec.map(t => t[0]) : [], REL_TERM_GAMES);
  const series = idx(x => x.words.length >= 2 ? [x.pre] : [], 0);
  const genre = idx(x => x.gen, 200);
  const pub = idx(x => [x.pub], 60);
  list.forEach(x => { if (x.vec) { x.w = {}; x.vec.forEach(t => { x.w[t[0]] = t[1]; }); } });

  const art = g => {
    const u = g.q || g.i || "";
    return ps ? u.replace("https://image.api.playstation.com/vulcan/ap/rnd/", "~") : u;   // shorter (lib/gamepage.js expands "~")
  };
  const shared = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };
  list.forEach(x => {
    // candidates, with their description similarity added up word by word
    const dot = new Map();
    const add = (y, v) => { if (y !== x && y.ed !== x.ed && y.ed2 !== x.ed2) dot.set(y, (dot.get(y) || 0) + v); };
    if (x.vec) x.vec.forEach(([w, v]) => (termIdx[w] || []).forEach(y => add(y, v * y.w[w])));
    (series[x.pre] || []).forEach(y => add(y, 0));
    (pub[x.pub] || []).forEach(y => add(y, 0));
    if (!x.vec) x.gen.forEach(gn => (genre[gn] || []).forEach(y => add(y, 0)));
    const scored = [];
    dot.forEach((dc, y) => {
      const sw = x.words.length >= 2 ? shared(x.words, y.words) : 0;
      const gc = genreSim(x, y);
      const ser = sw >= 2;
      // without a series, a game must be described alike, or (when either has no description) share its genres closely
      if (!ser && dc < 0.06 && !((!x.vec || !y.vec) && gc >= 0.6)) return;
      let s = (ser ? 100 + sw * 5 : 0) + dc * 80 + gc * 20 + (x.pub && y.pub === x.pub ? 5 : 0);
      s += Math.log10(y.pop + 1) * 2.5 + y.sale * 1.5;   // well-known games first among similar ones
      scored.push([s, y, ser]);
    });
    scored.sort((a, b) => b[0] - a[0]);
    const seen = {}, out = [];
    let fromSeries = 0;
    for (const [s, y, ser] of scored) {
      if (seen[y.ed] || seen[y.ed2]) continue;
      if (ser && ++fromSeries > 4) continue;   // at most 4 from the same series, so other similar games show too
      seen[y.ed] = seen[y.ed2] = 1;
      out.push([y.id, y.g.t, art(y.g), y.g.pr || 0, y.g.m || 0]);
      if (out.length >= RELATED_MAX) break;
    }
    if (out.length) x.g.rl = out;
  });
}

// Which shard a game's id belongs to (the Cloudflare function uses the same formula)
// A full game list row's square art (r[14]) as an image name or address: "~…" is on PlayStation's image server,
// "=<n>.<last>" is the poster's name with those two parts swapped (see sqShort_ in exportXboxCatalog.gs)
function catSquare_(r) {
  const s = String(r[14] || "");
  if (!s) return "";
  if (s[0] === "~") return "https://image.api.playstation.com/vulcan/ap/rnd/" + s.slice(1);
  if (s[0] !== "=") return s;
  const p = String(r[6] || "").split("."), q = s.slice(1).split(".");
  return p.length === 5 && q.length === 2 ? [p[0], q[0], p[2], p[3], q[1]].join(".") : "";
}

function shardOf_(id) {
  let h = 0;
  const s = String(id).toUpperCase();
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h % GAME_SHARDS;
}

// PlayStation's game pages. Xbox's are built by the data jobs on GitHub (ggdata) and read by the site from its R2
// bucket, so exportGamePages (the twice-daily trigger) only does PlayStation now. exportXboxGamePages still works by hand.
function exportGamePages() {
  exportPsGamePages();
}
function exportXboxGamePages() { gamePagesRun_("", "Xbox"); }
function exportPsGamePages() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === "exportPsGamePages").forEach(t => ScriptApp.deleteTrigger(t));
  gamePagesRun_("PS_", "PlayStation");
}
function gamePagesRun_(pre, name) {
  const t0 = Date.now();
  const n = gamePagesFor_(pre);
  console.log(name + " game pages: " + n + " games in " + GAME_SHARDS + " files (" + Math.round((Date.now() - t0) / 1000) + " s)");
}

function createGamePagesTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === "exportGamePages").forEach(t => ScriptApp.deleteTrigger(t));
  // after the morning and afternoon exports (Pacific time)
  ScriptApp.newTrigger("exportGamePages").timeBased().everyDays(1).atHour(6).inTimezone("America/Los_Angeles").create();
  ScriptApp.newTrigger("exportGamePages").timeBased().everyDays(1).atHour(19).inTimezone("America/Los_Angeles").create();
  Logger.log("Game pages will update every day around 6 AM and 7 PM Pacific.");
}

// Builds and saves the shard files of one platform ("" = Xbox, "PS_" = PlayStation). Returns the number of games.
// Each game: {t title, p publisher, i cover, q square art, pr price, m regular price, c currency, e sale end,
// l at lowest price, s subscriptions, ti tiers, r release date, g genres, u store url, ra [stars, ratings],
// mc [Metascore, Metacritic slug], pc PC only, h price history [[yyyymmdd, price]...], k popularity rank,
// pi a PlayStation game's main product id, d store description}.
// PlayStation product ids that belong to a whole-game page get {a: that page's id}.
function siteScores_(ps) {
  try {
    const r = UrlFetchApp.fetch("https://gamedealtrack.com/api?file=scores" + (ps ? "&platform=ps" : ""), { muteHttpExceptions: true });
    const d = r.getResponseCode() === 200 ? JSON.parse(r.getContentText()) : null;
    return d && !d.error && Object.keys(d).length > 50 ? d : null;
  } catch (e) { return null; }
}

function gamePagesFor_(pre) {
  const ps = pre === "PS_";
  const cat = psReadJson_(pre + "CATALOG_FILE_ID", { games: [] }).games || [];
  const sales = psReadJson_(pre + "JSON_FILE_ID", { games: [] }).games || [];
  // Metacritic scores: looked up by the data jobs on GitHub now (ggdata), read through the site; the old copy if that fails
  const scores = psReadJson_(pre + "SCORES_FILE_ID", {});   // here the scores job saves them next to the other files
  const hist = (psReadJson_(pre + "HISTORY_FILE_ID", { h: {} }) || {}).h || {};
  const ratings = psReadJson_(ps ? "PS_RATINGS_FILE_ID" : "XRATINGS_FILE_ID", {});
  // genres: Xbox's come with the store listing (xbox_genres.json), PlayStation's from the details the export looked up
  const xGenres = ps ? {} : psReadJson_("XGENRES_FILE_ID", {});
  const psCache = ps ? psReadJson_("PS_CACHE_FILE_ID", { details: {} }) : {};
  const psDetails = psCache.details || {};
  // store descriptions: Xbox's from the store listing (xbox_desc.json), PlayStation's from the store pages (ps_desc.json)
  const descs = ps ? Object.assign({}, psCache.desc || {}, psReadJson_("PS_DESC_FILE_ID", {})) : psReadJson_("XDESC_FILE_ID", {});
  const descOf = (...ids) => {
    for (const id of ids) { const d = id && (descs[id] || descs[String(id).toUpperCase()]); if (d) return d; }
    return undefined;
  };
  // release dates: Xbox's from the store listing (xbox_release.json), PlayStation's from the per-game lookups (ps_cache.json)
  const xRel = ps ? {} : psReadJson_("XRELEASE_FILE_ID", {});
  const relOf = (...ids) => {
    for (const id of ids) {
      if (!id) continue;
      const d = ps ? (psDetails[id] && psDetails[id].rel) : xRel[String(id).toUpperCase()];
      if (d && Number(String(d).slice(0, 4)) < 9000) return d;
    }
    return undefined;
  };
  const genresOf = (...ids) => {
    for (const id of ids) {
      if (!id) continue;
      const g = ps ? (psDetails[id] && psDetails[id].gen) : xGenres[String(id).toUpperCase()];
      if (g && g.length) return g.slice(0, 4);
    }
    return undefined;
  };
  if (!cat.length && !sales.length) return 0;

  const games = {};
  const rating = id => { const r = ratings[id] || ratings[String(id).toUpperCase()]; return r && r[1] ? [r[0], r[1]] : undefined; };
  const score = id => scores[id] || undefined;
  const subsOf = s => String(s || "").split(",").filter(Boolean);
  // the full game list: [id, title, publisher, price, msrp, currency, image, rank, subs, pc, release, tiers, url, product id, square art]
  cat.forEach(r => {
    if (!r[0] || !r[1]) return;
    const pid = r[13] || null;
    games[r[0]] = {
      t: r[1], p: r[2] || "", i: r[6] || "", pr: Number(r[3]) || 0, m: Number(r[4]) || Number(r[3]) || 0, c: r[5] || "USD",
      s: subsOf(r[8]), ti: subsOf(r[11]), pc: r[9] ? 1 : undefined, r: r[10] || relOf(pid, r[0]), u: r[12] || undefined, k: r[7] || undefined,
      ra: rating(pid || r[0]), mc: score(r[0]) || (pid && score(pid)), h: hist[pid || r[0]] || hist[r[0]] || undefined,
      pi: pid && pid !== r[0] ? pid : undefined, g: genresOf(pid, r[0]), d: descOf(pid, r[0]),
      q: catSquare_(r) || undefined   // square art
    };
    if (pid && pid !== r[0]) games[pid] = { a: r[0] };
  });
  // games on sale: their deal (and art, genres, sale end) on the game's page; PlayStation editions on sale get their own
  sales.forEach(g => {
    const id = g.productId;
    if (!id) return;
    const target = games[id] && games[id].a ? games[id].a : id;
    const e = games[target] || (games[target] = { t: g.title, p: g.publisher || "", i: g.image || "", c: g.currency || "USD", s: [], ti: [] });
    Object.assign(e, {
      pr: Number(g.price) || 0, m: Number(g.msrp) || Number(g.price) || 0, e: g.saleEnds || undefined, l: g.atLow ? 1 : undefined,
      q: g.sq || e.q, g: (g.genres && g.genres.length) ? g.genres : e.g, u: g.url || e.u,
      r: e.r || g.released || g.releaseDate || relOf(id) || undefined, k: e.k || g.rank || undefined
    });
    if (!e.p && g.publisher) e.p = g.publisher;
    if (g.subs && g.subs.length) e.s = g.subs;
    if (g.tiers && g.tiers.length) e.ti = g.tiers;
    if (!e.ra) e.ra = rating(id);
    if (!e.mc) e.mc = score(id);
    if (!e.h && hist[id]) e.h = hist[id];
    if (!e.g) e.g = genresOf(id);
    if (!e.d) e.d = descOf(id);
    if (ps && PS_ADDON_KINDS.test(String(g.kind || "").trim())) e.kd = String(g.kind).trim();   // an add-on, not a game
  });
  // Xbox add-ons on sale (looked up by exportXboxAddOns, XboxAddOns.gs): a page each, like PlayStation's
  if (!ps) (psReadJson_("XADDONS_FILE_ID", { games: [] }).games || []).forEach(g => {
    const id = g.productId;
    if (!id || !g.title || (g.saleEnds && Date.parse(g.saleEnds) <= Date.now())) return;
    const e = games[id] || (games[id] = { t: g.title, p: g.publisher || "", i: g.image || "", c: g.currency || "USD", s: [], ti: [] });
    if (e.a) return;
    Object.assign(e, { pr: Number(g.price) || 0, m: Number(g.msrp) || Number(g.price) || 0, e: g.saleEnds || undefined,
                       q: g.sq || e.q, kd: g.kind || "Add-on" });
    if (!e.ra) e.ra = rating(id);
    if (!e.h && hist[id]) e.h = hist[id];
  });
  console.log((ps ? "PlayStation" : "Xbox") + " add-ons matched to their game: " + attachAddOns_(games, ps ? psAddOnsSeen_(games) : xAddOnsAll_(), ps));

  addRelated_(games, ps);

  const shards = [];
  for (let n = 0; n < GAME_SHARDS; n++) shards.push({});
  Object.keys(games).forEach(id => { shards[shardOf_(id)][id] = games[id]; });
  const now = new Date().toISOString();
  shards.forEach((s, n) => saveJsonToDrive_({ updatedAt: now, games: s }, (ps ? "ps_" : "xbox_") + "games_" + n + ".json", pre + "SHARD_" + n + "_FILE_ID"));
  return Object.keys(games).length;
}
