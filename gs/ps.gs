// PlayStation store data, run by GitHub Actions (run.js jobs "ps", "psmorning", "psfill", "pspages"): the Apps Script
// export, unchanged except for longer time limits (no 6-minute limit here). Triggers and the region chain do nothing here.
// ===================== PlayStation Store export (US) =====================
// Lives in the same Apps Script project as exportXboxCatalog.gs and reuses its helpers (saveJsonToDrive_, cleanTitle_, norm_).
// Data comes from the PlayStation Store's own website API, which is undocumented: see PLAYSTATION_NOTES.md.
// If Sony changes it, the export logs errors and keeps the previous files, so the site keeps working with older data.
//
// Setup: run createPlayStationTrigger() once (daily run at 3 AM, after the Xbox export,
// plus psFillPublishers every 4 hours, which looks up publishers until every game has one).
// Files it saves (all read through doGet with &platform=ps):
//   ps_sales.json    games on sale        (PS_JSON_FILE_ID)      same shape as xbox_sales.json
//   ps_catalog.json  every game, for search (PS_CATALOG_FILE_ID) same row shape as xbox_catalog.json
//   ps_home.json     home page rows        (PS_HOME_FILE_ID)
//   ps_history.json  price history         (PS_HISTORY_FILE_ID)
//   ps_cache.json    publishers, release dates and sale end dates already looked up (PS_CACHE_FILE_ID)

const PS_GQL = "https://web.np.playstation.com/api/graphql/v1/op";
const PS_HASH = {
  categoryGridRetrieve: "88c0b9a1273c6d320c51cd73e390924e21ae28bf09f01cde8b84b1034b16cd03",
  productRetrieveForCtasWithPrice: "8532da7eda369efdad054ca8f885394a2d0c22d03c5259a422ae2bb3b98c5c99",
  metGetProductById: "a128042177bd93dd831164103d53b73ef790d56f51dae647064cb8f9d9fc9d1a"
};
const PS_ALL_DEALS = "3f772501-f6f8-49b7-abac-874a88ca4897";
const PS_ALL_GAMES = "28c9c2b2-cecc-415c-9a08-482a605cb104";
const PS_UBISOFT_PLUS = "db65f8d8-e606-49af-9a9a-23a05f55bd9a";   // the store's "Ubisoft+ Classics" list
const PS_STORE = "https://store.playstation.com/en-us/";
const PS_MAX_LOOKUPS = 2500;          // per-game requests per run
const PS_LOOKUP_UNTIL_MS = 15 * 60 * 1000;    // per-game lookups stop here (no 6-minute limit on GitHub)

// Run this ONCE manually: the daily PlayStation exports.
//  - 3 AM (script time zone): the full run; the other regions follow one after another (see exportPsRegionsChain).
//  - 9 AM Pacific: a lighter run for new sales, which usually go live in the morning Pacific (PlayStation
//    doesn't publish start times). US deals, home page and search list only, with fewer per-game lookups.
// Ended sales need no run: the site ends each sale at its own end time (11:59 PM Pacific on PlayStation).
function createPlayStationTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (["exportPlayStation", "exportPlayStationMorning"].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("exportPlayStation").timeBased().everyDays(1).atHour(3).create();
  ScriptApp.newTrigger("exportPlayStationMorning").timeBased().everyDays(1).atHour(9).inTimezone("America/Los_Angeles").create();
  Logger.log("Daily PlayStation triggers created for 3 AM and 9 AM Pacific.");
  createPsPublisherTrigger();
}
// Run this ONCE manually if the daily trigger already exists: psFillPublishers every 4 hours.
function createPsPublisherTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === "psFillPublishers") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("psFillPublishers").timeBased().everyHours(4).create();
  Logger.log("psFillPublishers trigger created (every 4 hours).");
}

// Store locales of the other regions (same region codes as the Xbox ones in exportXboxCatalog.gs)
const PS_REGIONS = {
  UK: "en-GB", CA: "en-CA", EU: "en-IE", BR: "pt-BR", AR: "es-AR",
  TR: "tr-TR", KR: "ko-KR", JP: "ja-JP", IN: "en-IN", AU: "en-AU",
  // every other country both stores sell in with its own currency (the euro countries are all EU). English stores
  // where there is one, as deals are matched across regions by title (psDealKey_)
  MX: "en-MX", CL: "en-CL", CO: "en-CO", PE: "en-PE", CR: "es-CR", PA: "es-PA", GT: "es-GT", EC: "es-EC", UY: "es-UY", PY: "es-PY", BO: "es-BO", SV: "es-SV", HN: "es-HN", NI: "es-NI", PL: "en-PL", CZ: "en-CZ", HU: "en-HU", RO: "en-RO", SE: "en-SE", NO: "en-NO", DK: "en-DK", CH: "de-CH", IS: "en-IS", UA: "uk-UA", IL: "en-IL", NZ: "en-NZ", SG: "en-SG", HK: "en-HK", TW: "en-TW", MY: "en-MY", TH: "en-TH", ID: "en-ID", ZA: "en-ZA", SA: "en-SA", AE: "en-AE", QA: "en-QA", KW: "en-KW", BH: "en-BH", OM: "en-OM"
};
// Key that matches the same game edition across regions. Product ids differ per region (even the title id part),
// so deals are matched on title + edition type + platforms. Concept ids are the same everywhere and are used as they are.
// Titles with no Latin letters or digits (some Japanese/Korean ones) can't be matched and keep their own id.
// The same edition in another region, by its store code: product ids differ per region in their first parts, but end
// in the same label ("UP0002-PPSA01649_00-CODMW4STANDARD01" / "EP0002-PPSA01650_00-CODMW4STANDARD01"). Labels that say
// nothing about the game ("FULLGAME00000000", all zeros) give "". The platform (PS4 CUSA / PS5 PPSA) is part of it.
function psCodeKey_(id) {
  const m = String(id || "").match(/^[A-Z]{2}\d{4}-([A-Z]{4})\d{5}_\d\d-([A-Z0-9]{6,16})$/);
  if (!m || !/[A-Z].*[A-Z].*[A-Z]/.test(m[2]) || /^(FULLGAME|FULL|GAME|MAINGAME|BASEGAME|APPLICATION|PRODUCT)\d*$/.test(m[2])) return "";
  return m[1].slice(0, 2) + ":" + m[2];
}
function psDealKey_(p) {
  const t = norm_(cleanTitle_(p.name));
  return t ? "t:" + t + "|" + (p.storeDisplayClassification || "") + "|" + (p.platforms || []).slice().sort().join("+") : String(p.id);
}

// ---------- Requests ----------

function psUrl_(operation, variables) {
  return PS_GQL + "?operationName=" + operation +
    "&variables=" + encodeURIComponent(JSON.stringify(variables)) +
    "&extensions=" + encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: PS_HASH[operation] } }));
}
function psRequest_(operation, variables, locale) {
  return {
    url: psUrl_(operation, variables), muteHttpExceptions: true,
    headers: { "x-psn-store-locale-override": locale || "en-US", "content-type": "application/json" }
  };
}
// Parsed `data` of a response, or null (logs why).
function psData_(res, what) {
  if (!res) return null;
  const code = res.getResponseCode(), text = res.getContentText();
  try {
    const j = JSON.parse(text);
    // Sony sometimes adds a warning (e.g. "Concept not available") next to usable data: keep the data
    if (code === 200 && j.data && Object.keys(j.data).some(k => j.data[k])) return j.data;
    Logger.log("PlayStation " + what + ": HTTP " + code + " " + JSON.stringify(j.errors || "").slice(0, 200));
  } catch (e) {
    Logger.log("PlayStation " + what + ": HTTP " + code + ", not JSON: " + text.slice(0, 120));
  }
  return null;
}
// One request with retries. Returns its `data` or null.
function psQuery_(operation, variables, locale) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t0 = Date.now();
    try {
      const r = psRequest_(operation, variables, locale);
      const d = psData_(UrlFetchApp.fetch(r.url, { headers: r.headers, muteHttpExceptions: true }), operation);
      const sec = Math.round((Date.now() - t0) / 1000);
      if (sec > 20) console.log("PlayStation " + operation + " answered slowly (" + sec + " s, attempt " + attempt + ")");
      if (d) return d;
    } catch (e) { console.log("PlayStation " + operation + " error after " + Math.round((Date.now() - t0) / 1000) + " s: " + e.message); }
    Utilities.sleep(2000 * attempt);
  }
  return null;
}

// Every item of a store category, in the given sort order. Returns {items, complete}.
// Deal lists hold products (one per edition); the all-games list holds concepts (one per game).
function psGrid_(category, sortBy, maxItems, locale) {
  const size = Math.min(1000, maxItems);
  const vars = offset => ({ id: category, pageArgs: { size: size, offset: offset }, sortBy: sortBy || null, filterBy: [], facetOptions: [] });
  const first = psQuery_("categoryGridRetrieve", vars(0), locale);
  const g0 = first && first.categoryGridRetrieve;
  if (!g0) return { items: [], complete: false };
  const pick = g => (g.products && g.products.length ? g.products : g.concepts) || [];
  const items = pick(g0).slice();
  const total = Math.min(g0.pageInfo.totalCount, maxItems);
  let complete = g0.pageInfo.isLast || items.length >= total;
  // remaining pages, two at a time (each page is ~5 MB)
  const offsets = [];
  for (let o = size; o < total; o += size) offsets.push(o);
  for (let i = 0; i < offsets.length; i += 2) {
    const batch = offsets.slice(i, i + 2);
    let res = [];
    try { res = UrlFetchApp.fetchAll(batch.map(o => psRequest_("categoryGridRetrieve", vars(o), locale))); } catch (e) { Logger.log("PlayStation page batch error: " + e.message); }
    for (let k = 0; k < batch.length; k++) {
      let d = psData_(res[k], "page " + batch[k]);
      if (!d) d = psQuery_("categoryGridRetrieve", vars(batch[k]), locale);   // retry on its own
      const g = d && d.categoryGridRetrieve;
      if (!g) return { items: items, complete: false };
      pick(g).forEach(x => items.push(x));
      if (g.pageInfo.isLast) complete = true;
      console.log("PlayStation list " + category.slice(0, 8) + ": " + items.length + " of " + total + " read");
    }
  }
  return { items: items, complete: complete || items.length >= total };
}

// Runs one per-game request for many ids, 40 at a time, until the deadline. Returns {id: data}.
function psLookup_(operation, ids, deadline, locale) {
  const out = {};
  for (let i = 0; i < ids.length; i += 40) {
    if (Date.now() > deadline) {
      Logger.log("PlayStation " + operation + ": out of time, " + (ids.length - i) + " games left for the next run");
      break;
    }
    const chunk = ids.slice(i, i + 40);
    let res = [];
    try { res = UrlFetchApp.fetchAll(chunk.map(id => psRequest_(operation, { productId: id }, locale))); }
    catch (e) { Logger.log("PlayStation lookup batch error: " + e.message); if (quotaHit_(e)) { console.log("Google's daily request limit reached, stopping"); break; } }
    chunk.forEach((id, k) => {
      const d = psData_(res[k], operation + " " + id);
      if (d && d.productRetrieve) out[id] = d.productRetrieve;
    });
    Utilities.sleep(300);
  }
  return out;
}

// ---------- Small helpers ----------

// "$44.99" -> 44.99, "2.999,00 TL" -> 2999, "¥9,790" -> 9790, "Free" -> 0. null when there's no number.
function psPrice_(text) {
  if (text === null || text === undefined) return null;
  const s = String(text);
  const digits = s.replace(/[^0-9.,]/g, "");
  if (!/[0-9]/.test(digits)) return /free|gratuit|kostenlos|gratis|無料|무료|ücretsiz/i.test(s) ? 0 : null;
  const m = digits.match(/^(.*?)[.,](\d{1,2})$/);   // a separator followed by 1-2 digits at the end = decimals
  const whole = (m ? m[1] : digits).replace(/[.,]/g, "");
  return Number(whole + (m ? "." + m[2] : ""));
}
// Square cover (the store's MASTER image) and 16:9 key art without text (GAMEHUB_COVER_ART), for the home page
const PS_IMG_ROOT = "https://image.api.playstation.com/vulcan/ap/rnd/";   // shortened to "~" in the full game list
function psSquare_(media) {
  const pick = (media || []).find(m => m.role === "MASTER");
  return pick ? String(pick.url).split("?")[0] : null;
}
function psWide_(media) {
  const list = media || [];
  const pick = list.find(m => m.role === "GAMEHUB_COVER_ART") || list.find(m => m.role === "BACKGROUND_LAYER_ART") ||
               list.find(m => m.role === "SIXTEEN_BY_NINE_BANNER");
  return pick ? String(pick.url).split("?")[0] : null;
}
let PS_ART = {};   // product id -> {sq, wide} of the games on sale (sq is also in ps_sales.json, for the square cards)
// Franchise pages (PlayStation's "Call of Duty" page shows Modern Warfare 4 with its name and price, see
// psConceptPrice_): the listed game's own art instead of the page's. pids: product ids. Returns {pid: {image, sq}},
// remembered for the run.
const PS_FRANCHISE_ART = {};
function psFranchiseArt_(pids) {
  const need = pids.filter(p => p && !(p in PS_FRANCHISE_ART));
  if (need.length) {
    const found = psLookup_("metGetProductById", need, Date.now() + 60000);
    need.forEach(p => { const m = found[p] && found[p].media; PS_FRANCHISE_ART[p] = m && m.length ? { image: psImage_(m), sq: psSquare_(m) } : null; });
  }
  const out = {};
  pids.forEach(p => { if (PS_FRANCHISE_ART[p]) out[p] = PS_FRANCHISE_ART[p]; });
  return out;
}
// Portrait cover (same 2:3 shape as the Xbox posters), else the square one
function psImage_(media) {
  const list = media || [];
  const pick = list.find(m => m.role === "PORTRAIT_BANNER") || list.find(m => m.role === "MASTER") ||
               list.find(m => m.role === "GAMEHUB_COVER_ART") || list.find(m => m.type === "IMAGE");
  return pick ? String(pick.url).split("?")[0] : null;
}
// " (at 42 s)" for the logs, so a slow step is easy to spot
function psAt_(startTime) { return " (at " + Math.round((Date.now() - startTime) / 1000) + " s)"; }
function psDay_(ms) {
  return Number(Utilities.formatDate(new Date(ms), "UTC", "yyyyMMdd"));
}
// Subscription tags from a store price: PS Plus catalog tier ("psessential" / "psextra" / "pspremium"), EA Play and GTA+.
// The store marks these with upsellServiceBranding and upsellText ("Extra", "Premium", "Included" ...).
// Ubisoft+ has no mark of its own, so games in the store's Ubisoft+ list (by product id) get "ubisoft".
function psTiers_(price, productIds) {
  const out = [];
  const up = (price && price.upsellServiceBranding) || [], text = String((price && price.upsellText) || "").trim();
  if (up.indexOf("PS_PLUS") >= 0 && /^(essential|extra|premium)$/i.test(text)) out.push("ps" + text.toLowerCase());
  if (up.indexOf("EA_ACCESS") >= 0 && /^included$/i.test(text)) out.push("eaplay");
  if (up.indexOf("GTA_PLUS") >= 0 && /^included$/i.test(text)) out.push("gtaplus");
  const ubi = psUbisoftIds_();
  if ((productIds || []).some(id => ubi[psIdKey_(id)])) out.push("ubisoft");
  return out;
}
// Product ids differ per region only in their first part (UP0001-… in the US, EP0001-… in Europe)
function psIdKey_(id) {
  return String(id || "").replace(/^[A-Z]{2}\d{4}-/, "");
}
let PS_UBI = null;
// Products in the Ubisoft+ list, read once per run. {} if it can't be read.
function psUbisoftIds_() {
  if (PS_UBI) return PS_UBI;
  PS_UBI = {};
  try {
    psGrid_(PS_UBISOFT_PLUS, null, 1000).items.forEach(p => { if (p && p.id) PS_UBI[psIdKey_(p.id)] = true; });
  } catch (e) { Logger.log("Ubisoft+ list failed: " + e.message); }
  Logger.log("Ubisoft+ games on PlayStation: " + Object.keys(PS_UBI).length);
  return PS_UBI;
}
// Product ids of a concept (one game, all its editions)
function psConceptIds_(c) {
  return ((c && c.products) || []).map(x => x && x.id).filter(Boolean);
}
// The store also marks Premium *game trials* as "Premium". Those are listed on the PS Plus games page,
// so a "pspremium" game found there becomes "pstrial". Without a game (concept) id we can't tell, so the tag is dropped.
function psFixTrial_(tiers, conceptId, trials) {
  if (tiers.indexOf("pspremium") < 0) return tiers;
  if (!conceptId) return tiers.filter(t => t !== "pspremium");
  return trials[String(conceptId)] ? tiers.map(t => t === "pspremium" ? "pstrial" : t) : tiers;
}
// Game (concept) ids of the PS Plus Premium game trials, from the PS Plus games page. {} if the page can't be read.
function psTrialIds_() {
  const out = {};
  try {
    const res = UrlFetchApp.fetch("https://www.playstation.com/en-us/ps-plus/games/", { muteHttpExceptions: true,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" } });
    const html = res.getContentText(), start = html.indexOf("Game trials");
    const re = /store\.playstation\.com\/[a-z-]+\/concept\/(\d+)/g;
    let m;
    re.lastIndex = start > 0 ? start : 0;
    while ((m = re.exec(html))) out[m[1]] = true;
    Logger.log("PS Plus game trials found: " + Object.keys(out).length + (res.getResponseCode() === 200 ? "" : " (HTTP " + res.getResponseCode() + ")"));
  } catch (e) { Logger.log("PS Plus trials page failed: " + e.message); }
  return out;
}
function psSubs_(tiers) {
  const plus = tiers.some(t => t === "psessential" || t === "psextra" || t === "pspremium");
  return (plus ? ["psplus"] : []).concat(tiers.filter(t => t === "eaplay" || t === "ubisoft" || t === "gtaplus"));
}

// The regular price offer of a game, from productRetrieveForCtasWithPrice. The PS Plus member price is a
// separate button (type UPSELL_PS_PLUS_DISCOUNT, branding PS_PLUS) that isn't always flagged as members-only.
const PS_OFFER_VERSION = 2;   // saved offers from older versions are looked up again
function psOffer_(prod) {
  const ctas = ((prod && prod.webctas) || []).filter(c => c.price && c.price.basePriceValue !== undefined);
  const member = c => /UPSELL|PS_PLUS/.test(c.type || "") || (c.price.serviceBranding || []).indexOf("PS_PLUS") >= 0 ||
                      c.price.isTiedToSubscription || c.price.isExclusive;
  const regular = ctas.filter(c => !member(c)).map(c => c.price);
  const p = regular.find(x => x.discountedValue < x.basePriceValue) || regular[0] || (ctas[0] && ctas[0].price);
  if (!p) return null;
  return { end: Number(p.endTime) || 0, price: p.discountedValue / 100, base: p.basePriceValue / 100, campaign: p.campaignId || "" };
}
// The same offer in another region's store: from the price as written ("¥9,790", "1 899,00 Kč"), since the values
// in cents don't hold for currencies without cents
function psOfferText_(prod) {
  const ctas = ((prod && prod.webctas) || []).filter(c => c.price && (c.price.basePrice || c.price.discountedPrice));
  const member = c => /UPSELL|PS_PLUS/.test(c.type || "") || (c.price.serviceBranding || []).indexOf("PS_PLUS") >= 0 ||
                      c.price.isTiedToSubscription || c.price.isExclusive;
  const regular = ctas.filter(c => !member(c)).map(c => c.price);
  const p = regular[0] || (ctas[0] && ctas[0].price);
  if (!p) return null;
  const price = psPrice_(p.discountedPrice), base = psPrice_(p.basePrice);
  return price === null && base === null ? null : { price: price === null ? base : price, base: base === null ? price : base };
}

// Games sold in several editions: the store gives the game (concept) the price of its first edition,
// which can be the most expensive one (GTA VI showed the Ultimate Edition's price). Each edition's price is
// looked up once a day into cache.eprice {productId: [price, base, day]}, and the game shows its cheapest edition.
function psEditionPrices_(concepts, cache, deadline, max) {
  cache.eprice = cache.eprice || {};
  const today = psDay_(Date.now()), stale = psDay_(Date.now() - 3 * 864e5);
  Object.keys(cache.eprice).forEach(id => { if (cache.eprice[id][2] < stale) delete cache.eprice[id]; });
  const ids = [];
  concepts.forEach(c => {
    const p = psConceptIds_(c);
    if (p.length > 1) p.forEach(id => { const e = cache.eprice[id]; if (!e || e[2] !== today || e[3] === undefined) ids.push(id); });
  });
  const need = Array.from(new Set(ids)).slice(0, max);
  if (!need.length) return 0;
  const found = psLookup_("productRetrieveForCtasWithPrice", need, deadline);
  // [price, regular price, day, edition name] (the name tells editions of one game from a franchise page's different games)
  Object.keys(found).forEach(id => { const o = psOffer_(found[id]), nm = String(found[id].name || "");
    cache.eprice[id] = o ? [o.price, o.base, today, nm] : [null, null, today, nm]; });
  console.log("PlayStation edition prices looked up: " + Object.keys(found).length + " of " + need.length);
  return Object.keys(found).length;
}
// A game's price: its cheapest edition when the editions' prices are known, else the store's price for it
// The standard edition is the one with the lowest regular price; its current price is shown, on sale or not.
// (Picking the cheapest current price showed a discounted Ultimate Edition as if the standard game were on sale.)
// Some entries are franchise pages holding several different games (PlayStation's "Call of Duty" has Modern Warfare 4,
// Black Ops 7, Modern Warfare II…). Those show the game the store lists first, with its own name and price: `title`.
function psGameKey_(name) {
  return norm_(String(name || "").replace(/[™®©]/g, "").split(/\s+[-–]\s+|\s*\(/)[0]
    .replace(/\b(standard|deluxe|ultimate|premium|gold|vault|complete|definitive|digital|cross-gen|bundle|trial|edition)\b.*$/i, ""));
}
// Games whose US price is an edition other than the store's own price for the game (GTA VI: Standard, not the
// Ultimate the store shows): the regions look their editions up too (exportPsRegion_), so they compare the same edition
let PS_EPICK = {};
function psConceptPrice_(c, cache) {
  let price = psPrice_(c.price && c.price.discountedPrice), base = psPrice_(c.price && c.price.basePrice);
  const ids = psConceptIds_(c), ep = (cache && cache.eprice) || {};
  const games = new Set(ids.map(id => ep[id] && ep[id][3] ? psGameKey_(ep[id][3]) : "").filter(Boolean));
  const first = ep[ids[0]];
  if (games.size >= 3 && first && first[0] !== null && first[3]) {
    return { price: first[0], base: first[1], title: String(first[3]).replace(/\s+[-–]\s+(standard edition|cross-gen bundle)$/i, "") };
  }
  if (ids.length > 1) {
    let std = null;
    const free = !!(c.price && c.price.isFree);   // $0 editions only count for free games
    // upgrades and add-ons sold on the game's page ("Digital Deluxe Upgrade", $10) aren't an edition of the game
    const notEdition = e => /\b(upgrade|add-?ons?|season pass|expansion|dlc|soundtrack|currency|points|coins)\b/i.test(String(e[3] || ""));
    ids.forEach(id => {
      const e = ep[id];
      if (e && e[0] !== null && e[1] !== null && (e[1] > 0 || free) && !notEdition(e) && (!std || e[1] < std[1] || (e[1] === std[1] && e[0] < std[0]))) std = e;
    });
    // the store's "from" price for the page can itself be the upgrade's: then the standard edition's price replaces it
    const fromAddOn = base !== null && ids.some(id => ep[id] && notEdition(ep[id]) && ep[id][1] === base);
    if (std && (base === null || std[1] <= base || fromAddOn)) {
      if (c && c.id && (std[1] !== base || std[0] !== price)) PS_EPICK[String(c.id)] = 1;
      price = std[0]; base = std[1];
    }
  }
  return { price: price, base: base };
}

// ---------- The daily run ----------

function exportPlayStation() {
  // after this run: the full catalog (search), then each region, one after another (exportPsRegionsChain)
  psRun_(["CATALOG"].concat(Object.keys(PS_REGIONS)), {});
}
// The 9 AM Pacific run for new sales: the catalog follows, the regions wait for the 3 AM run
function exportPlayStationMorning() {
  psRun_(["CATALOG"], { maxLookups: 800 });
}
function psRun_(queue, opts) {
  psScheduleChain_(10 * 60 * 1000);   // safety net: the next steps still run if this run is cut off
  const props = PropertiesService.getScriptProperties();
  props.setProperty("PS_REGION_QUEUE", JSON.stringify(queue));
  props.setProperty("PS_BUSY", String(Date.now()));   // psFillPublishers waits while this runs
  try {
    exportPlayStation_(opts);
  } finally {
    props.deleteProperty("PS_BUSY");
    psScheduleChain_(1000);           // the next steps start right after this run
  }
}

// opts (for testing): maxLookups, catalogMax
function exportPlayStation_(opts) {
  opts = opts || {};
  const startTime = Date.now(), now = startTime;
  const maxLookups = opts.maxLookups === undefined ? PS_MAX_LOOKUPS : opts.maxLookups;

  // 1. Every game on sale, best sellers first
  console.log("PlayStation export started, reading the deals list…");
  const deals = psGrid_(PS_ALL_DEALS, { name: "sales30", isAscending: false }, 20000);
  console.log("PlayStation deals list: " + deals.items.length + " products" + (deals.complete ? "" : " (INCOMPLETE)"));
  if (!deals.complete || !deals.items.length) {
    Logger.log("PlayStation run incomplete, keeping the previous files untouched.");
    return;
  }

  const games = [], seen = {};
  let skipped = 0;
  deals.items.forEach((p, i) => {
    if (!p || !p.id || seen[p.id] || !p.price) return;
    seen[p.id] = true;
    const base = psPrice_(p.price.basePrice), price = psPrice_(p.price.discountedPrice), tiers = psTiers_(p.price, [p.id]);
    // Only real discounts open to everyone: no PS Plus-only prices, no "same price" entries
    if (base === null || price === null || !(price < base) || p.price.isTiedToSubscription || p.price.isExclusive) { skipped++; return; }
    games.push({
      productId: p.id, key: psDealKey_(p), rank: i + 1, pc: false,
      title: p.name || "", publisher: null, kind: p.localizedStoreDisplayClassification || "",
      platforms: p.platforms || [],
      msrp: base, price: price, discountPercent: Math.round((1 - price / base) * 100),
      currency: "USD", image: psImage_(p.media), sq: psSquare_(p.media), url: PS_STORE + "product/" + p.id,
      subs: psSubs_(tiers), tiers: tiers, genres: []
    });
    PS_ART[p.id] = { sq: psSquare_(p.media), wide: psWide_(p.media) };
  });
  console.log("PlayStation games on sale: " + games.length + " (" + skipped + " skipped: PS Plus-only or no real discount)" + psAt_(startTime));

  // 2. Store rankings and newest releases (concepts = one entry per game)
  const top = (s, n) => psGrid_(PS_ALL_GAMES, { name: s, isAscending: false }, n || 40).items;
  const bestselling = top("sales30"), trending = top("downloads30", 80), trendMore = top("downloads30", 250), byRelease = psGrid_(PS_ALL_GAMES, { name: "conceptReleaseDate", isAscending: false }, 300).items;

  // 3. Sale end dates, publishers and release dates: looked up once, then kept in ps_cache.json
  const cache = psReadJson_("PS_CACHE_FILE_ID", { details: {}, offers: {} });
  const firstProduct = c => c && c.products && c.products[0] && c.products[0].id;
  // Order of priority: details for the home rows (about 380 games),
  // then sale end dates, then publishers of the games on sale
  // (the Trending and Best selling rows go first too, so their cards get a publisher)
  const needRelease = bestselling.concat(trending, byRelease).map(firstProduct).filter((id, i, a) => id && !cache.details[id] && a.indexOf(id) === i)
    .slice(0, maxLookups);
  const deadline = startTime + PS_LOOKUP_UNTIL_MS;
  const saveDetails = found => Object.keys(found).forEach(id => {
    const d = found[id];
    cache.details[id] = {
      pub: d.publisherName || "", rel: d.releaseDate || "", con: (d.concept && d.concept.id) || "",
      gen: (d.combinedLocalizedGenres || (d.concept && d.concept.combinedLocalizedGenres) || []).map(x => x.value).filter((x, i, a) => x && a.indexOf(x) === i)
    };
  });
  console.log("PlayStation store rankings read" + psAt_(startTime));
  if (maxLookups > 0) psEditionPrices_(trending.concat(bestselling, byRelease), cache, startTime + PS_LOOKUP_UNTIL_MS, 300);
  const relFound = psLookup_("metGetProductById", needRelease, deadline);
  saveDetails(relFound);

  const needOffer = games.filter(g => {
    const o = cache.offers[g.productId];
    // look up again only when the list price changed since the last lookup, or the sale it found has ended
    return !o || o.v !== PS_OFFER_VERSION || o.seen !== g.price || (o.end && o.end < now);
  }).map(g => g.productId).slice(0, maxLookups - needRelease.length);
  const offers = psLookup_("productRetrieveForCtasWithPrice", needOffer, deadline);
  const listPrice = {};
  games.forEach(g => { listPrice[g.productId] = g.price; });
  Object.keys(offers).forEach(id => {
    // `seen` is the list price at lookup time; a game with no usable offer is remembered too, so it isn't asked again daily
    cache.offers[id] = Object.assign(psOffer_(offers[id]) || { end: 0, price: null }, { seen: listPrice[id], v: PS_OFFER_VERSION });
  });

  const needDetails = games.map(g => g.productId).filter(id => !cache.details[id])
    .slice(0, Math.max(0, maxLookups - needRelease.length - needOffer.length));
  const details = psLookup_("metGetProductById", needDetails, deadline);
  saveDetails(details);
  // forget sale details of games no longer on sale
  Object.keys(cache.offers).forEach(id => { if (!seen[id]) delete cache.offers[id]; });
  const missingOffers = games.filter(g => !cache.offers[g.productId]).length;
  const missingDetails = games.filter(g => !cache.details[g.productId]).length;
  Logger.log("PlayStation lookups this run: " + Object.keys(relFound).length + " home-row details, " +
             Object.keys(offers).length + " sale end dates, " + Object.keys(details).length + " publishers. " +
             "Still to look up: " + missingOffers + " sale end dates, " + missingDetails + " publishers");

  games.forEach(g => {
    const d = cache.details[g.productId], o = cache.offers[g.productId];
    if (d) { g.publisher = d.pub; g.released = d.rel || null; g.releaseDate = d.rel || null; g.genres = Array.from(new Set(d.gen || [])); }
    if (o && o.end > now && o.price === g.price) g.saleEnds = new Date(o.end).toISOString();
  });

  console.log("PlayStation lookups done" + psAt_(startTime));
  // PS Plus Premium trials are tagged "pstrial", not as included with PS Plus
  const trials = psTrialIds_();
  games.forEach(g => {
    const d = cache.details[g.productId];
    g.tiers = psFixTrial_(g.tiers, d && d.con, trials);
    g.subs = psSubs_(g.tiers);
  });

  // 4. Price history: all-time lows and newest discounts
  try { psUpdateHistory_(games, seen); } catch (e) { Logger.log("PlayStation history failed: " + e.message); }

  saveJsonToDrive_({ updatedAt: new Date().toISOString(), platform: "ps", count: games.length, games: games },
                   "ps_sales.json", "PS_JSON_FILE_ID");
  psSaveCache_(cache);
  console.log("PlayStation history and files saved" + psAt_(startTime));

  // 5. Home page rows
  try { psBuildHome_(games, bestselling, trending, byRelease, cache, trials, trendMore); } catch (e) { Logger.log("PlayStation home failed: " + e.message); }

  // 6. The full catalog for search is the biggest step, so it runs separately right after this one
  // (first in the exportPsRegionsChain queue). Tests can still run it here with opts.catalogMax.
  if (opts.catalogMax) {
    try { psBuildCatalog_(games, opts.catalogMax, trials, cache); } catch (e) { Logger.log("PlayStation catalog failed: " + e.message); }
  }
  console.log("PlayStation export done in " + Math.round((Date.now() - startTime) / 1000) + " s. The catalog and the regions run next.");
}

// ---------- Publishers, filled in between daily runs ----------
// The store lists don't include publishers, so each game is looked up once (metGetProductById) and kept in
// ps_cache.json. The daily run only has time for part of them, so this runs every 4 hours (createPsPublisherTrigger):
// games on sale first, then the rest of the catalog by popularity. It also writes the publishers into
// ps_sales.json and ps_catalog.json right away. Once every game has one, a run makes no requests at all.
const PS_FILL_MAX = 3000;  // publisher lookups per run
// ps_cache.json without the descriptions, which go in ps_desc.json ({product id: text}): they'd make the cache file,
// read by every PlayStation run, several times bigger. A cache read with only some descriptions (an older file) adds
// them to the saved ones.
function psSaveCache_(cache) {
  const desc = cache.desc;
  delete cache.desc;
  if (desc && Object.keys(desc).length) saveJsonToDrive_(cache.descFull ? desc : Object.assign(psReadJson_("PS_DESC_FILE_ID", {}), desc), "ps_desc.json", "PS_DESC_FILE_ID");
  saveJsonToDrive_(cache, "ps_cache.json", "PS_CACHE_FILE_ID");
  if (desc) cache.desc = desc;
}

function psFillPublishers() {
  const startTime = Date.now(), props = PropertiesService.getScriptProperties();
  const busy = Number(props.getProperty("PS_BUSY")) || 0;
  if (busy && startTime - busy < 15 * 60 * 1000) { Logger.log("The daily PlayStation export is running, trying next time."); return; }

  const cache = psReadJson_("PS_CACHE_FILE_ID", null);
  const sales = psReadJson_("PS_JSON_FILE_ID", null);
  const cat = psReadJson_("PS_CATALOG_FILE_ID", null);
  if (!cache || !sales) { Logger.log("Run exportPlayStation first."); return; }
  cache.details = cache.details || {};
  // the descriptions found so far (their own file, see psSaveCache_), to add to
  cache.desc = Object.assign(psReadJson_("PS_DESC_FILE_ID", {}), cache.desc || {});
  Object.defineProperty(cache, "descFull", { value: true });

  // 1. Store ratings of the home page's games, written straight into ps_home.json
  const home = psReadJson_("PS_HOME_FILE_ID", null);
  if (home && home.sections) {
    const rows = ["popular", "bestselling", "newest", "ending"].map(k => home.sections[k] || []);
    const key = e => e.pid || e.id;   // product id (rows of whole games carry it as pid)
    // the home rows first, then the games on sale from most to least popular (the spotlight and
    // big-discounts pools come from these; well-known games are near the top)
    // then the rest of the full game list by popularity, for their descriptions (game pages)
    const ids = [].concat.apply([], rows.map(r => r.map(key)))
      .concat((sales.games || []).slice().sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9)).slice(0, 1500).map(g => g.productId))
      .concat(((cat && cat.games) || []).filter(r => r[13]).sort((a, b) => (Number(a[7]) || 1e9) - (Number(b[7]) || 1e9)).map(r => r[13]));
    const allow = Math.min(PS_STAR_MAX, fetchBudget_(0));
    const got = allow ? psStarRatings_(ids, cache, startTime + 15 * 60 * 1000, allow) : false;
    if (!allow) console.log("Store ratings: today's request budget is used up, trying again next run");
    let n = 0;
    Object.keys(home.sections).forEach(k => Array.isArray(home.sections[k]) && home.sections[k].forEach(e => {
      const st = cache.stars && cache.stars[key(e)];
      if (st && (e.rc !== st[1] || e.ra !== st[0])) { e.ra = st[0]; e.rc = st[1]; n++; }
    }));
    if (n && !(Number(props.getProperty("PS_BUSY")) > startTime)) saveJsonToDrive_(home, "ps_home.json", "PS_HOME_FILE_ID");
    Logger.log("Store ratings: " + n + " home page games updated" + (got ? "" : " (nothing new to look up)"));
    // every rating found so far, for the site: {product id: [average, count]} (doGet &file=ratings&platform=ps)
    const ratings = {};
    Object.keys(cache.stars || {}).forEach(id => { const st = cache.stars[id]; if (st[1] > 0) ratings[id] = [st[0], st[1]]; });
    saveJsonToDrive_(ratings, "ps_ratings.json", "PS_RATINGS_FILE_ID");
    console.log("Ratings file: " + Object.keys(ratings).length + " games");
  }

  // 2. Publishers
  const saleIds = (sales.games || []).slice().sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9)).map(g => g.productId);
  const catIds = ((cat && cat.games) || []).map(r => r[13]);
  const need = Array.from(new Set(saleIds.concat(catIds))).filter(id => id && !cache.details[id]);
  Logger.log("Games without a publisher yet: " + need.length);
  if (!need.length) { psSaveCache_(cache); return; }

  const allow = Math.min(PS_FILL_MAX, fetchBudget_(0));
  if (!allow) { console.log("Publishers: today's request budget is used up, trying again next run"); psSaveCache_(cache); return; }
  fetchBudget_(Math.min(allow, need.length));
  // stops at 3¼ minutes: saving the files afterwards takes a while, and Apps Script ends a run at 6 minutes
  const found = psLookup_("metGetProductById", need.slice(0, allow), startTime + 30 * 60 * 1000);
  Object.keys(found).forEach(id => {
    const d = found[id];
    cache.details[id] = {
      pub: d.publisherName || "", rel: d.releaseDate || "", con: (d.concept && d.concept.id) || "",
      gen: (d.combinedLocalizedGenres || (d.concept && d.concept.combinedLocalizedGenres) || []).map(x => x.value).filter((x, i, a) => x && a.indexOf(x) === i)
    };
  });
  // the daily export may have started meanwhile: it would overwrite these files anyway
  const b = Number(props.getProperty("PS_BUSY")) || 0;
  if (b > startTime) { Logger.log("The daily export started meanwhile, not saving."); return; }
  psSaveCache_(cache);

  let nSale = 0, nCat = 0;
  (sales.games || []).forEach(g => {
    const d = cache.details[g.productId];
    if (!d || g.publisher) return;
    g.publisher = d.pub; g.released = d.rel || null; g.releaseDate = d.rel || null; g.genres = Array.from(new Set(d.gen || []));
    nSale++;
  });
  if (nSale) saveJsonToDrive_(sales, "ps_sales.json", "PS_JSON_FILE_ID");
  if (cat) {
    (cat.games || []).forEach(r => { const d = cache.details[r[13]]; if (d && d.pub && !r[2]) { r[2] = d.pub; nCat++; } });
    if (nCat) saveJsonToDrive_(cat, "ps_catalog.json", "PS_CATALOG_FILE_ID");
  }
  Logger.log("Looked up " + Object.keys(found).length + " games. Publishers added: " + nSale + " on sale, " + nCat + " in the catalog. " +
             Math.max(0, need.length - Object.keys(found).length) + " still to go.");
}

// Star ratings (average out of 5 and number of ratings) from the games' store pages, which include them.
// Kept in ps_cache.json under "stars" ({id: [average, count, day looked up]}) and looked up again after 14 days.
// The page's description is kept too, under "desc" ({id: text}), for the game pages.
// At most PS_STAR_MAX pages per run (each is about 1 MB), until `until`. Returns true if anything new was found.
// Kept gentle: many full store pages in a short time can get Apps Script's requests to Sony slowed down or
// stalled for a while (an export started right after a big batch hung on its first request).
const PS_STAR_MAX = 1000;
const PS_STAR_HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" };
const PS_DESC_RE = /"__typename":"Description","type":"LONG","value":("(?:[^"\\]|\\.)*")/;   // the store page's long description
const PS_STAR_RE = /"starRating":\{"__typename":"StarRating","averageRating":([\d.]+),"totalRatingsCount":(\d+)\}/;
// One game's store rating [average, count] for the pop-up (null if the page can't be read)
function psStarRating_(productId) {
  try {
    const r = UrlFetchApp.fetch(PS_STORE + (/^\d+$/.test(productId) ? "concept/" : "product/") + productId, { headers: PS_STAR_HEADERS, muteHttpExceptions: true });
    const m = r.getResponseCode() === 200 && PS_STAR_RE.exec(r.getContentText());
    return m ? [Number(m[1]), Number(m[2])] : null;
  } catch (e) { return null; }
}
function psStarRatings_(ids, cache, until, max) {
  cache.stars = cache.stars || {};
  const today = psDay_(Date.now()), old = psDay_(Date.now() - 14 * 864e5);
  cache.desc = cache.desc || {};
  // not looked up in 14 days, or never with its description (pages read before descriptions were kept)
  const need = Array.from(new Set(ids)).filter(id => id && (!cache.stars[id] || cache.stars[id][2] < old || !(id in cache.desc))).slice(0, max || PS_STAR_MAX);
  if (!need.length) return false;
  if (max) fetchBudget_(need.length);   // background run: counts toward the daily budget
  const headers = PS_STAR_HEADERS, re = PS_STAR_RE;
  let found = 0;
  for (let i = 0; i < need.length && Date.now() < until; i += 8) {
    if (i) Utilities.sleep(1000);
    const chunk = need.slice(i, i + 8);
    let res = [];
    try { res = UrlFetchApp.fetchAll(chunk.map(id => ({ url: PS_STORE + "product/" + id, headers: headers, muteHttpExceptions: true }))); }
    catch (e) { Logger.log("PlayStation ratings batch error: " + e.message); if (quotaHit_(e)) { console.log("Google's daily request limit reached, stopping"); break; } }
    chunk.forEach((id, k) => {
      const r = res[k];
      if (!r || r.getResponseCode() !== 200) return;
      const page = r.getContentText(), m = re.exec(page);
      cache.stars[id] = m ? [Number(m[1]), Number(m[2]), today] : [0, 0, today];   // no rating yet counts as 0
      // the game's description from the same page, for its game page (descText_ in exportXboxCatalog.gs)
      const dm = PS_DESC_RE.exec(page);
      let d = "";   // "" = the page has none (not asked again until the rating is)
      if (dm) { try { d = descText_(null, JSON.parse(dm[1])) || ""; } catch (e) {} }
      cache.desc[id] = d;
      found++;
    });
  }
  Logger.log("PlayStation star ratings looked up: " + found + " of " + need.length + " needed");
  return found > 0;
}

// Same idea as the Xbox history: price changes per game. Games that left the sale list go back to full price.
function psUpdateHistory_(games, onSale) {
  const today = psDay_(Date.now());
  const data = psReadJson_("PS_HISTORY_FILE_ID", null) || { since: today, h: {}, b: {} };
  data.b = data.b || {};
  const firstRun = data.since === today && !Object.keys(data.h).length;
  games.forEach(g => {
    const list = data.h[g.productId] || (data.h[g.productId] = []);
    // a game seen on sale for the first time (after the first run) was at full price until now
    if (!list.length && !firstRun) list.push([today, g.msrp]);
    const last = list[list.length - 1];
    if (!last || !samePrice_(last[1], g.price)) list.push([today, g.price]);   // samePrice_: exportXboxCatalog.gs
    data.b[g.productId] = g.msrp;
  });
  data.c = data.c || {};
  Object.keys(data.h).forEach(id => {
    if (onSale[id] || data.c[id]) return;   // (whole games from the full list: psConceptHistory_ keeps their price)
    const list = data.h[id], last = list[list.length - 1], base = data.b[id];
    if (base && last && last[1] < base - 0.02) list.push([today, base]);   // sale over: back to full price
  });
  data.updated = today;
  games.forEach(g => {
    const list = data.h[g.productId] || [], n = list.length;
    const earlierSale = list.slice(0, -1).some(x => x[1] < g.msrp);   // compare with at least one earlier sale
    g.atLow = earlierSale && g.price <= Math.min.apply(null, list.map(x => x[1])) + 0.02;
    g.newSale = n >= 2 && list[n - 1][1] < list[n - 2][1] - 0.02 ? list[n - 1][0] : 0;
  });
  saveJsonToDrive_(data, "ps_history.json", "PS_HISTORY_FILE_ID");
  Logger.log("PlayStation history: " + Object.keys(data.h).length + " games tracked since " + data.since +
             ", " + games.filter(g => g.atLow).length + " at their lowest tracked price");
}

// Every game of the full list (concepts, on sale or not): its price whenever it changes, like the deals above.
// rows: ps_catalog.json rows [id, title, publisher, price, regular price, …]. Marked in data.c.
function psConceptHistory_(rows) {
  const today = psDay_(Date.now());
  const data = psReadJson_("PS_HISTORY_FILE_ID", null);
  if (!data || !data.h) return;
  data.b = data.b || {}; data.c = data.c || {};
  let n = 0;
  rows.forEach(r => {
    const id = String(r[0]), price = Number(r[3]), base = Number(r[4]) || price;
    if (!id || !(price >= 0)) return;
    const list = data.h[id] || (data.h[id] = []), last = list[list.length - 1];
    if (!last || !samePrice_(last[1], price)) { list.push([today, price]); n++; }
    data.b[id] = base; data.c[id] = 1;
  });
  saveJsonToDrive_(data, "ps_history.json", "PS_HISTORY_FILE_ID");
  Logger.log("PlayStation history: " + rows.length + " whole games tracked (" + n + " price changes today)");
}

// Home rows in the same shape as xbox_home.json. Cards carry their own store `url`.
function psBuildHome_(games, bestselling, trending, byRelease, cache, trials, trendMore) {
  const now = Date.now(), N = 15;
  const byId = {};
  games.forEach(g => { byId[g.productId] = g; });

  // Store ratings, looked up by psFillPublishers (it has the time; this run doesn't)
  const star = id => (cache.stars && cache.stars[id]) || null;

  const fromGame = g => ({
    id: g.productId, key: g.key, title: g.title, publisher: g.publisher || "", image: g.image, sq: (PS_ART[g.productId] || {}).sq || null, wide: (PS_ART[g.productId] || {}).wide || null,
    price: g.price, msrp: g.msrp, currency: g.currency, date: g.saleEnds || null,
    ra: star(g.productId) ? star(g.productId)[0] : null, rc: star(g.productId) ? star(g.productId)[1] : 0,
    gp: g.subs.indexOf("psplus") >= 0, xs: g.subs.filter(s => s !== "psplus"), low: !!g.atLow, ends: g.saleEnds || null, pc: false, tiers: g.tiers, release: null,
    genres: g.genres || [], f2p: false, url: g.url, platforms: g.platforms
  });
  const fromConcept = c => {
    const pid = c.products && c.products[0] && c.products[0].id;
    const d = (pid && cache.details[pid]) || {};
    const cp = psConceptPrice_(c, cache), price = cp.price, base = cp.base;
    const rel = d.rel || null, tiers = psFixTrial_(psTiers_(c.price, psConceptIds_(c)), c.id, trials || {}), subs = psSubs_(tiers);
    const fa = cp.title && pid ? psFranchiseArt_([pid])[pid] : null;   // a franchise page: its game's own art
    return {
      id: String(c.id), pid: pid || "", title: cp.title || c.name || "", publisher: d.pub || "",
      image: (fa && fa.image) || psImage_(c.media), sq: (fa && fa.sq) || psSquare_(c.media), wide: fa ? null : psWide_(c.media),
      price: price || 0, msrp: base || price || 0, currency: "USD", date: rel,
      ra: star(pid) ? star(pid)[0] : null, rc: star(pid) ? star(pid)[1] : 0,
      gp: subs.indexOf("psplus") >= 0, xs: subs.filter(s => s !== "psplus"), low: false, ends: null, pc: false, tiers: tiers,
      release: rel && Date.parse(rel) > now ? rel : null, genres: Array.from(new Set(d.gen || [])),
      f2p: !!(c.price && c.price.isFree), url: PS_STORE + "concept/" + c.id, time: Date.parse(rel) || 0
    };
  };
  const ok = e => e.title && e.image;
  const clean = e => { delete e.time; return e; };

  // Well-known games on sale, by number of store ratings, one per game (the home page picks 7 at random
  // each day from spotPool and hotPool; the rules are in exportXboxCatalog.gs: SPOT_TOP, hotPool_ and SEE_ALL_RATINGS)
  const rated = [], seenTitle = {};
  games.filter(g => star(g.productId) && star(g.productId)[1] > 0 && g.image)
    .sort((a, b) => star(b.productId)[1] - star(a.productId)[1]).forEach(g => {
      // editions with different names ("… Messi Edition" / "… Lamine Yamal Edition") share the game's ratings:
      // the same large number of ratings is the same game
      const t = editionKey_(g.title), r = star(g.productId)[1] >= 1000 ? "rc:" + star(g.productId)[1] : null;
      if (seenTitle[t] || (r && seenTitle[r])) return;
      seenTitle[t] = true; if (r) seenTitle[r] = true; rated.push(g);
    });
  const spotPool = rated.map(fromGame).filter(ok).slice(0, SPOT_TOP);   // see SPOT_TOP in exportXboxCatalog.gs
  const hotPool = hotPool_(rated.map(fromGame).filter(ok), bigOff_, "ps");   // see hotPool_ in exportXboxCatalog.gs
  const popIds = rated.filter(g => star(g.productId)[1] >= SEE_ALL_RATINGS).map(g => g.productId);

  // Most wishlisted: how many of this site's accounts wishlisted each PlayStation game
  const wc = wishCounts_(), cat = psReadJson_("PS_CATALOG_FILE_ID", { games: [] }), catBy = {};
  (cat.games || []).forEach(r => { catBy[r[0]] = r; });
  const fromRow = r => ({ id: r[0], pid: r[13] || "", title: r[1], publisher: r[2] || "", image: r[6], price: r[3], msrp: r[4], currency: "USD",
    date: null, gp: /psplus/.test(r[8] || ""), xs: String(r[8] || "").split(",").filter(x => x && x !== "psplus"), low: false, ends: null, pc: false,
    tiers: r[11] ? String(r[11]).split(",") : [], release: null, genres: [], f2p: false, url: r[12] });
  const wished = Object.keys(wc).filter(id => !/^[A-Z0-9]{12}$/i.test(id)).sort((a, b) => wc[b] - wc[a])
    .map(id => { const e = byId[id] ? fromGame(byId[id]) : catBy[id] ? fromRow(catBy[id]) : null; return e && Object.assign(e, { wc: wc[id] }); })
    .filter(e => e && ok(e)).slice(0, N);

  const weekAgo = psDay_(now - 7 * 864e5);
  const released = byRelease.map(fromConcept).filter(ok);
  // Trending deals: the most downloaded games (past 30 days) that are on sale, one per game
  const trendSeen = {}, trendsale = [];
  (trendMore || trending).forEach(c => {
    const g = (c.products || []).map(p => byId[p.id]).find(g => g && g.msrp > g.price);
    if (!g || trendsale.length >= N) return;
    const t = editionKey_(g.title);
    if (trendSeen[t]) return;
    trendSeen[t] = true;
    const e = fromGame(g);
    if (ok(e)) trendsale.push(e);
  });
  // Top Metacritic deals (topMetaSale_ in xbox.gs)
  const metasale = topMetaSale_(games, psReadJson_("PS_SCORES_FILE_ID", {}), g => g.productId, g => (star(g.productId) || [0, 0])[1], fromGame, ok, N);
  const sections = {
    spotPool: spotPool, spotV: 2,   // spotV 2: the SPOT_TOP most-rated games on sale
    hotPool: hotPool, hotV: 3,   // hotV 3: hotPool_ (most rated, 60%+ off, HOT_MIN_RATINGS)
    popIds: popIds,
    wished: wished,
    trendsale: trendsale, metasale: metasale,
    popular: trending.map(fromConcept).filter(ok).filter(e => e.price > 0 && !e.f2p).slice(0, N).map(clean),   // paid games only
    bestselling: bestselling.map(fromConcept).filter(ok).filter(e => e.price > 0).slice(0, N).map(clean),
    under1: bargains_(games, 1, fromGame, ok), under5: bargains_(games, 5, fromGame, ok), under10: bargains_(games, 10, fromGame, ok),
    // Newest discounts (NEWEST_MIN_RATINGS in exportXboxCatalog.gs)
    newest: games.filter(g => g.newSale && star(g.productId) && star(g.productId)[1] >= NEWEST_MIN_RATINGS)
      .sort((a, b) => b.newSale - a.newSale || star(b.productId)[1] - star(a.productId)[1]).slice(0, 60).map(fromGame).filter(ok),
    ending: games.filter(g => g.saleEnds && Date.parse(g.saleEnds) < now + 7 * 864e5)
      .sort((a, b) => Date.parse(a.saleEnds) - Date.parse(b.saleEnds)).map(fromGame).filter(ok),
    upcoming: released.filter(e => e.time > now && e.time < now + 31 * 864e5).sort((a, b) => a.time - b.time).map(clean),
    recent: released.filter(e => e.time && e.time <= now && e.time > now - 7 * 864e5).sort((a, b) => b.time - a.time).map(clean)
  };

  // Posters of the best-selling games on sale, one per game, for the deals bar
  const seenName = {}, bar = [];
  games.forEach(g => {
    const name = norm_(cleanTitle_(g.title).replace(/\b(ps4|ps5)\b/gi, ""));
    if (!g.image || seenName[name] || bar.length >= 14) return;
    seenName[name] = true;
    bar.push(g.image);
  });

  const file = saveJsonToDrive_(
    { updatedAt: new Date().toISOString(), platform: "ps", dealsCount: games.length, bar: bar, gp: null, sections: sections },
    "ps_home.json", "PS_HOME_FILE_ID");
  console.log("PlayStation home saved: " + Object.keys(sections).filter(k => Array.isArray(sections[k])).map(k => k + "=" + sections[k].length).join(", ") + " " + file.getUrl());
}

// Every game (concept) in the store, same row shape as xbox_catalog.json:
// [id, title, publisher, price, msrp, currency, image, rank, subs, pc, upcoming release, tiers, url, product id (for the gallery),
//  square art ("~" = PS_IMG_ROOT)]
function psBuildCatalog_(games, max, trials, cache, t0) {
  const details = (cache && cache.details) || {};
  const all = psGrid_(PS_ALL_GAMES, { name: "sales30", isAscending: false }, max);
  if (!all.complete || !all.items.length) {
    Logger.log("PlayStation catalog incomplete (" + all.items.length + " games), keeping the previous one");
    return;
  }
  // cheapest edition for the most popular multi-edition games (the rest keep the store's price)
  if (cache) psEditionPrices_(all.items.slice(0, 400), cache, (t0 || Date.now()) + 3 * 60 * 1000, 500);
  const rows = [], franchise = [];   // [row index, product id] of franchise pages (psFranchiseArt_)
  all.items.forEach((c, i) => {
    if (!c || !c.id || !c.price) return;
    const cp = psConceptPrice_(c, cache), price = cp.price, base = cp.base;
    if (price === null) return;   // not sold on its own (e.g. only in a bundle)
    const tiers = psFixTrial_(psTiers_(c.price, psConceptIds_(c)), c.id, trials || {});
    const pid = (c.products && c.products[0] && c.products[0].id) || "";
    if (cp.title && pid) franchise.push([rows.length, pid]);
    rows.push([String(c.id), cp.title || c.name || "", (details[pid] && details[pid].pub) || "", price, base === null ? price : base, "USD",
               psImage_(c.media), i + 1, psSubs_(tiers).join(","), 0, "", tiers.join(","), PS_STORE + "concept/" + c.id, pid,
               String(psSquare_(c.media) || "").replace(PS_IMG_ROOT, "~"), 0,
               psConceptIds_(c).length > 1 ? psConceptIds_(c).join(",") : ""]);   // 16: the game's editions (product ids)
  });
  if (franchise.length) {
    const art = psFranchiseArt_(franchise.map(x => x[1]));
    franchise.forEach(([i, pid]) => { const a = art[pid]; if (!a) return; if (a.image) rows[i][6] = a.image; if (a.sq) rows[i][14] = String(a.sq).replace(PS_IMG_ROOT, "~"); });
    Logger.log("PlayStation franchise pages with their game's own art: " + Object.keys(art).length + " of " + franchise.length);
  }
  const file = saveJsonToDrive_({ updatedAt: new Date().toISOString(), platform: "ps", count: rows.length, games: rows },
                                "ps_catalog.json", "PS_CATALOG_FILE_ID");
  try { psConceptHistory_(rows); } catch (e) { Logger.log("PlayStation whole-game history failed: " + e.message); }
  Logger.log("PlayStation catalog saved: " + rows.length + " games " + file.getUrl());
}

// ---------- Quick check (run by hand) ----------
// Reads one page of deals and one game's details and logs the results. Saves nothing.
function testPlayStation() {
  const d = psQuery_("categoryGridRetrieve", { id: PS_ALL_DEALS, pageArgs: { size: 5, offset: 0 }, sortBy: null, filterBy: [], facetOptions: [] });
  const g = d && d.categoryGridRetrieve;
  if (!g || !g.products || !g.products.length) { Logger.log("FAIL  deals list: nothing returned (see errors above)"); return; }
  const p = g.products[0];
  Logger.log("OK    deals list: " + g.pageInfo.totalCount + " on sale. First: " + p.name + " " + p.price.basePrice + " -> " + p.price.discountedPrice);
  const o = psOffer_((psQuery_("productRetrieveForCtasWithPrice", { productId: p.id }) || {}).productRetrieve);
  Logger.log((o ? "OK    " : "FAIL  ") + "sale details: " + JSON.stringify(o));
  const m = (psQuery_("metGetProductById", { productId: p.id }) || {}).productRetrieve;
  Logger.log((m && m.publisherName ? "OK    " : "FAIL  ") + "game details: " + (m ? m.publisherName + ", released " + m.releaseDate : "none"));
}

// ---------- Other regions ----------
// Each region gets a price file in the same shape as the Xbox ones (ps_prices_UK.json ... read with &platform=ps&file=prices&region=UK):
//   prices: { key: [price, msrp, rank, discount %, region product id or concept id] }   key = psDealKey_ or concept id
//   extra:  games on sale in that region but not in the US sale list
// Concepts from the region's top lists are included too, so the home page rows can be re-priced.
function exportPsRegion_(code, startTime) {
  const locale = PS_REGIONS[code];
  const deals = psGrid_(PS_ALL_DEALS, { name: "sales30", isAscending: false }, 20000, locale);
  if (!deals.complete || !deals.items.length) {
    Logger.log("PlayStation " + code + ": deals list incomplete, keeping the previous file");
    return false;
  }
  // a deal here is filed under the US deal's key when they're the same edition: by store code, else by title
  // (titles fail in stores without English names: Spanish, German, Ukrainian…)
  const usByCode = {};
  (psReadJson_("PS_JSON_FILE_ID", { games: [] }).games || []).forEach(g => { const c = psCodeKey_(g.productId); if (c && g.key && !usByCode[c]) usByCode[c] = g.key; });
  const keyOf = p => usByCode[psCodeKey_(p.id)] || psDealKey_(p);
  const prices = {}, sale = [];
  let rank = 0;
  deals.items.forEach(p => {
    if (!p || !p.id || !p.price) return;
    const key = keyOf(p);
    if (prices[key]) return;
    const base = psPrice_(p.price.basePrice), price = psPrice_(p.price.discountedPrice);
    if (base === null || price === null || !(price < base) || p.price.isTiedToSubscription || p.price.isExclusive) return;
    prices[key] = [price, base, ++rank, Math.round((1 - price / base) * 100), p.id];
    sale.push(p);
  });
  // every game (concept) of the region's store, with its price: game pages, the full game list and the comparisons.
  // Concept ids are the same in every region.
  const picks = [];   // games priced by an edition in the US (PS_EPICK): their editions here, looked up below
  [["sales30", 15000]].forEach(([sort, n]) => {
    psGrid_(PS_ALL_GAMES, { name: sort, isAscending: false }, n, locale).items.forEach(c => {
      if (!c || !c.id || !c.price || prices[String(c.id)]) return;
      const price = psPrice_(c.price.discountedPrice), base = psPrice_(c.price.basePrice);
      if (price === null) return;
      prices[String(c.id)] = [price, base === null ? price : base, 1e6, 0, String(c.id)];
      if (PS_EPICK[String(c.id)] && psConceptIds_(c).length > 1) picks.push(c);
    });
  });
  if (picks.length) {
    // each edition's price in this store, then the same pick as the US (psConceptPrice_: the lowest regular price)
    const ids = Array.from(new Set([].concat(...picks.map(psConceptIds_)))).slice(0, 900);
    const found = psLookup_("productRetrieveForCtasWithPrice", ids, Date.now() + 120000, locale), today = psDay_(Date.now()), ep = {};
    Object.keys(found).forEach(id => { const o = psOfferText_(found[id]); ep[id] = o ? [o.price, o.base, today, String(found[id].name || "")] : [null, null, today, String(found[id].name || "")]; });
    let fixed = 0;
    picks.forEach(c => {
      const cp = psConceptPrice_(c, { eprice: ep }), k = String(c.id);
      if (cp.price === null || cp.price === undefined) return;
      if (cp.price !== prices[k][0] || cp.base !== prices[k][1]) fixed++;
      prices[k] = [cp.price, cp.base === null ? cp.price : cp.base, 1e6, 0, k];
    });
    Logger.log("PlayStation " + code + ": " + picks.length + " games priced by edition (" + fixed + " changed, " + Object.keys(found).length + " editions looked up)");
  }

  // currency: asked once from the first game's price details
  let currency = "";
  const first = sale[0] || deals.items[0];
  const o = first && psQuery_("productRetrieveForCtasWithPrice", { productId: first.id }, locale);
  const w = (o && o.productRetrieve && o.productRetrieve.webctas) || [];
  const pr = (w.find(x => x.price && x.price.currencyCode) || {}).price;
  currency = (pr && pr.currencyCode) || "";

  // games on sale here but not in the US sale list keep their own card details
  const us = {};
  (psReadJson_("PS_JSON_FILE_ID", { games: [] }).games || []).forEach(g => { if (g.key) us[g.key] = true; });
  const storeBase = "https://store.playstation.com/" + locale.toLowerCase() + "/product/";
  const extra = sale.filter(p => !us[keyOf(p)]).map(p => {
    const tiers = psTiers_(p.price, [p.id]).filter(t => t !== "pspremium");   // can't tell Premium catalog from a trial here
    return { productId: p.id, key: keyOf(p), title: p.name || "", publisher: "", image: psImage_(p.media), pc: false,
             platforms: p.platforms || [], url: storeBase + p.id, subs: psSubs_(tiers), tiers: tiers, genres: [] };
  });

  const file = saveJsonToDrive_({ updatedAt: new Date().toISOString(), platform: "ps", region: code, locale: locale,
                                  currency: currency, prices: prices, extra: extra },
                                "ps_prices_" + code + ".json", "PS_PRICES_" + code + "_FILE_ID");
  Logger.log("PlayStation " + code + ": " + sale.length + " on sale (" + extra.length + " not on sale in the US), currency " +
             currency + ", " + Math.round((Date.now() - startTime) / 1000) + " s " + file.getUrl());
  return true;
}
function exportPsUK() { exportPsRegion_("UK", Date.now()); }   // for running one region by hand

// Updates the regions one after another, as many per run as fit, then schedules itself to continue.
function exportPsRegionsChain() {
  const start = Date.now();
  const props = PropertiesService.getScriptProperties();
  const queue = JSON.parse(props.getProperty("PS_REGION_QUEUE") || "[]");
  if (!queue.length) { psClearChain_(); return; }
  psScheduleChain_(8 * 60 * 1000);   // safety net in case this run is cut off
  let lastMs = Number(props.getProperty("PS_REGION_LAST_MS")) || 60000;
  while (queue.length) {
    const used = Date.now() - start;
    if (used > 5000 && used + lastMs * 1.3 > 330000) break;   // not enough time left for another region
    const code = queue[0], t0 = Date.now();
    let ok = false;
    try { ok = code === "CATALOG" ? psExportCatalog_() : exportPsRegion_(code, t0); } catch (e) { Logger.log("PlayStation " + code + " failed: " + e.message); }
    lastMs = Date.now() - t0;
    props.setProperty("PS_REGION_LAST_MS", String(lastMs));
    if (ok || used <= 5000) { queue.shift(); props.setProperty("PS_REGION_QUEUE", JSON.stringify(queue)); }
    else break;
  }
  if (queue.length) psScheduleChain_(1000);
  else { psClearChain_(); Logger.log("All PlayStation regions updated"); }
}
// The full US catalog (every game, for search), run by the chain right after the daily export
function psExportCatalog_() {
  const t0 = Date.now(), props = PropertiesService.getScriptProperties();
  props.setProperty("PS_BUSY", String(t0));   // psFillPublishers waits, so the two don't both save ps_cache.json
  try {
    const cache = psReadJson_("PS_CACHE_FILE_ID", { details: {} });
    psBuildCatalog_(null, 20000, psTrialIds_(), cache, t0);
    psSaveCache_(cache);
  } finally { props.deleteProperty("PS_BUSY"); }
  Logger.log("PlayStation catalog step took " + Math.round((Date.now() - t0) / 1000) + " s");
  return true;
}
function psScheduleChain_(ms) {
  psClearChain_();
  ScriptApp.newTrigger("exportPsRegionsChain").timeBased().after(ms).create();
}
function psClearChain_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === "exportPsRegionsChain") ScriptApp.deleteTrigger(t);
  });
}

// Price of one PlayStation game in every region, in local currency and USD (the pop-up's "Compare regions").
// Regions only know the games on sale there and their top lists, so a game at full price elsewhere may be missing.
function psCompareJson_(id) {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) return json_({ error: "bad id" });
  const usGames = psReadJson_("PS_JSON_FILE_ID", { games: [] }).games || [];
  const usSale = usGames.find(g => g.productId === id);
  const key = usSale ? (usSale.key || id) : id;   // a US deal's key, or a concept id
  const cache = CacheService.getScriptCache();
  const hit = cache.get("pc:" + key);
  if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
  const rates = getRates_(), rows = [];
  const add = (region, currency, price, msrp) => rows.push({
    region: region, currency: currency, price: price, msrp: msrp,
    usd: rates[currency] ? Math.round(price / rates[currency] * 100) / 100 : null
  });
  // US: the sale list, else the full catalog (concepts)
  if (usSale) add("US", "USD", Number(usSale.price), Number(usSale.msrp));
  else {
    const r = (psReadJson_("PS_CATALOG_FILE_ID", { games: [] }).games || []).find(x => String(x[0]) === id);
    if (r) add("US", "USD", Number(r[3]), Number(r[4]));
  }
  Object.keys(PS_REGIONS).forEach(code => {
    const d = psReadJson_("PS_PRICES_" + code + "_FILE_ID", null);
    const p = d && d.prices && d.prices[key];
    if (p) add(code, d.currency || "", p[0], p[1]);
  });
  const text = JSON.stringify({ rows: rows });
  cache.put("pc:" + key, text, 3600);
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}
