// Xbox store data: the US export (sales, full game list, home page, price history, Game Pass) and the regions.
// Run by GitHub Actions (see .github/workflows/xbox.yml and run.js).
const RUN_LIMIT_MS = 40 * 60 * 1000;   // a run stops looking up more after this long

const JSON_FILE_NAME = "xbox_sales.json";
// Optional extra query params for the browse request (e.g. a sort order), like "&orderby=..."
const EXTRA_QUERY = "";

// ---------- Never replace good data with worse ----------
// A failed or partial lookup (a store, Metacritic, a page that didn't answer) must not wipe what the site shows.
// Every save goes through keepGoodData_ first:
//  - lists (deals, full game lists): a new list less than half the size of the saved one isn't saved
//  - lookup files (descriptions, release dates, ratings, genres, Metacritic scores): the new results are added to
//    the saved ones, so nothing is lost because a lookup failed this time
//  - game pages: a game keeps its saved description, scores, rating, genres, release date, art and price history
//    when the new data lacks them; a much smaller set of pages isn't saved
//  - home pages: a row that comes back empty keeps its saved games
// Returns the data to save (possibly completed), or null to keep the saved file as it is.
const KEEP_LISTS = /^(PS_)?(JSON|CATALOG)_FILE_ID$/;
const KEEP_MERGE = /^(XDESC|XRELEASE|XRATINGS|XGENRES|SCORES|PS_SCORES|PS_DESC|PS_RATINGS)_FILE_ID$/;
const KEEP_SHARDS = /^(PS_)?SHARD_\d+_FILE_ID$/;
const KEEP_HOME = /^(PS_)?HOME_FILE_ID$/;
const KEEP_GAME_FIELDS = ["d", "mc", "ra", "g", "r", "q", "i", "h", "p", "u"];
function keepGoodData_(data, propKey) {
  if (!data || typeof data !== "object") return data;
  const kind = KEEP_LISTS.test(propKey) ? "list" : KEEP_MERGE.test(propKey) ? "merge" : KEEP_SHARDS.test(propKey) ? "shard" : KEEP_HOME.test(propKey) ? "home" : "";
  if (!kind) return data;
  const old = psReadJson_(propKey, null);
  if (!old || typeof old !== "object") return data;
  const empty = v => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
  if (kind === "list") {
    const n = (data.games || []).length, o = (old.games || []).length;
    if (o > 100 && n < o * 0.5) { Logger.log(propKey + ": " + n + " games instead of " + o + ", keeping the saved file"); return null; }
    return data;
  }
  if (kind === "merge") return Object.assign({}, old, data);
  if (kind === "home") {
    const os = old.sections || {}, ds = data.sections = data.sections || {};
    Object.keys(os).forEach(k => { if (Array.isArray(os[k]) && os[k].length && empty(ds[k])) ds[k] = os[k]; });
    return data;
  }
  // game pages
  const og = old.games || {}, ng = data.games || {}, on = Object.keys(og).length, nn = Object.keys(ng).length;
  if (on > 50 && nn < on * 0.7) { Logger.log(propKey + ": " + nn + " games instead of " + on + ", keeping the saved file"); return null; }
  Object.keys(ng).forEach(id => {
    const o = og[id], g = ng[id];
    if (!o || !g || g.a) return;
    KEEP_GAME_FIELDS.forEach(f => { if (empty(g[f]) && !empty(o[f])) g[f] = o[f]; });
  });
  return data;
}

// Overwrites the same Drive file every time (no duplicates).
function saveJsonToDrive_(data, name, propKey) {
  name = name || JSON_FILE_NAME;
  propKey = propKey || "JSON_FILE_ID";
  data = keepGoodData_(data, propKey);
  if (data === null) {   // keep the saved file
    const kept = PropertiesService.getScriptProperties().getProperty(propKey);
    return DriveApp.getFileById(kept);
  }
  if ((propKey === "JSON_FILE_ID" || propKey === "PS_JSON_FILE_ID") && data && data.games) saveOnSale_(data.games, propKey === "PS_JSON_FILE_ID");
  const props = PropertiesService.getScriptProperties();
  const content = JSON.stringify(data);
  const id = props.getProperty(propKey);

  if (id) {
    try {
      const existing = DriveApp.getFileById(id);
      if (!existing.isTrashed()) {
        existing.setContent(content);
        return existing;
      }
    } catch (e) {
      Logger.log("Saved file not found, creating a new one: " + e.message);
    }
  }

  const file = DriveApp.createFile(name, content, "application/json");
  props.setProperty(propKey, file.getId());
  return file;
}

// A small file with every game on sale and when its sale ends ({id: end time in ms, 0 when unknown}),
// saved with each deals file. Every page loads it for the wishlist button's on-sale count.
function saveOnSale_(games, ps) {
  const sale = {};
  games.forEach(g => { if (g.productId && Number(g.price) < Number(g.msrp)) sale[g.productId] = Date.parse(g.saleEnds) || 0; });
  saveJsonToDrive_({ updatedAt: new Date().toISOString(), sale: sale }, ps ? "ps_onsale.json" : "xbox_onsale.json", (ps ? "PS_" : "") + "ONSALE_FILE_ID");
}

// Fetches one page with retries. Returns parsed JSON, or null if all attempts fail.
function fetchPage_(url, headers) {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = UrlFetchApp.fetch(url, {
        headers: headers,
        muteHttpExceptions: true
      });
      const code = response.getResponseCode();
      const text = response.getContentText();

      if (code === 200 && text) {
        return JSON.parse(text);
      }
      Logger.log(
        "Attempt " + attempt + " failed: HTTP " + code +
        ", body length " + text.length
      );
    } catch (e) {
      Logger.log("Attempt " + attempt + " error: " + e.message);
    }
    Utilities.sleep(2000 * attempt); // back off: 2s, 4s, 6s...
  }
  return null;
}

function exportUS_() {
  const startTime = Date.now();
  const maxRuntimeMs = RUN_LIMIT_MS;
  const batchSize = 8;                // pages fetched in parallel

  const baseUrl =
    "https://emerald.xboxservices.com/xboxcomfd/browse?locale=en-US" + EXTRA_QUERY;
  const headers = {
    "MS-CV": "test",
    "Accept": "application/json"
  };
  const pageSize = 500; // the server actually returns ~50 per page
  const games = [];
  const seen = new Set(); // skip products repeated across pages
  const dated = [];       // [id, release time] for recent and upcoming games
  const pcIds = new Set(); // games that are PC only
  const upc = {};          // id -> release date, for games that are not out yet
  let rankCounter = 0;    // position in the store's own listing order
  const catalog = []; // every game: [id, title, publisher, price, msrp, currency, image, subs]
  const failedPages = [];
  let page = 1;
  let totalScanned = 0;
  let consecutiveFailures = 0;
  let done = false;
  let reachedEnd = false;

  while (!done) {
    if (Date.now() - startTime > maxRuntimeMs) {
      Logger.log(
        "WARNING: time limit reached before the end of the catalog " +
        "(next page would have been " + page + ")."
      );
      break;
    }

    const pageNumbers = [];
    const requests = [];
    for (let i = 0; i < batchSize; i++) {
      pageNumbers.push(page + i);
      requests.push({
        url:
          baseUrl +
          "&pageNumber=" + (page + i) +
          "&resultsPerPage=" + pageSize,
        headers: headers,
        muteHttpExceptions: true
      });
    }

    Logger.log(
      "Fetching pages " + pageNumbers[0] + "-" + pageNumbers[batchSize - 1]
    );

    let responses = [];
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      Logger.log("Batch error: " + e.message);
    }

    for (let i = 0; i < batchSize; i++) {
      let json = null;
      const res = responses[i];

      if (res) {
        const text = res.getContentText();
        if (res.getResponseCode() === 200 && text) {
          try {
            json = JSON.parse(text);
          } catch (e) {}
        }
      }

      // Retry a failed page on its own, with backoff
      if (json === null) {
        json = fetchPage_(requests[i].url, headers);
      }

      if (json === null) {
        failedPages.push(pageNumbers[i]);
        consecutiveFailures++;
        Logger.log("Giving up on page " + pageNumbers[i]);

        if (consecutiveFailures >= 3) {
          Logger.log("3 failed pages in a row, stopping early");
          done = true;
          break;
        }
        continue;
      }
      consecutiveFailures = 0;

      const products = json.productSummaries || [];

      // Empty page = end of the catalog
      if (products.length === 0) {
        reachedEnd = true;
        done = true;
        break;
      }

      products.forEach(product => {
        if (product.productId) {
          if (seen.has(product.productId)) return;
          seen.add(product.productId);
        }
        const rank = ++rankCounter;
        const rel = Date.parse(realDate_(product.releaseDate));
        if (product.productId && rel > Date.now() - 7 * 864e5 && rel < Date.now() + 32 * 864e5) dated.push([product.productId, rel]);
        if (product.productId && rel > Date.now() - 14 * 864e5) upc[product.productId] = new Date(rel).toISOString().slice(0, 10);
        const purchase = product.specificPrices?.purchaseable?.[0];
        const msrp = Number(purchase?.msrp) || 0;
        const price = Number(purchase?.listPrice) || 0;
        const discount = Number(purchase?.discountPercentage) || 0;

        if (product.productId && pcOnly_(product)) pcIds.add(product.productId);
        if (product.productId && product.ratingCount) RATINGS[String(product.productId).toUpperCase()] = [product.averageRating || 0, product.ratingCount];
        if (product.productId && product.categories && product.categories.length) GENRES[String(product.productId).toUpperCase()] = product.categories.slice(0, 4);
        if (product.productId) { const sq = shortImg_(pickSquare_(product)); if (sq) SQUARE[product.productId] = sq; }
        if (product.productId) { const rd = String(realDate_(product.releaseDate) || "").slice(0, 10); if (/^(19[7-9]|20)\d\d-/.test(rd)) RELEASES[String(product.productId).toUpperCase()] = rd; }
        if (product.productId && product.hasAddOns) ADDON_GAMES.push([product.productId, product.title || "", product.ratingCount || 0]);
        if (product.productId) { const d = descText_(product.shortDescription, product.description); if (d) DESCS[String(product.productId).toUpperCase()] = d; }
        notePasses_(product);
        // No purchase offer = bundle component or Game Pass-only listing, so skip it
        if (purchase) catalog.push([
          product.productId || "", product.title || "", product.publisherName || "",
          price, msrp, purchase?.currency || "", shortImg_(pickImage_(product)), rank
        ]);

        // Keep only games that are on sale
        const onSale = discount > 0 || (msrp > 0 && price < msrp);
        if (!onSale) return;

        games.push({
          productId: product.productId ?? null,
          rank: rank,
          pc: pcOnly_(product),
          title: product.title ?? null,
          publisher: product.publisherName ?? null,
          kind: product.productKind ?? null,
          releaseDate: realDate_(product.releaseDate),
          rating: product.averageRating ?? null,
          msrp: purchase?.msrp ?? null,
          price: purchase?.listPrice ?? null,
          discountPercent: purchase?.discountPercentage ?? null,
          currency: purchase?.currency ?? null,
          image: pickImage_(product),
          sq: shortImg_(pickSquare_(product))
        });
        SALE_ART[String(product.productId).toUpperCase()] = { sq: pickSquare_(product), wide: pickWide_(product) };
      });

      totalScanned += products.length;
    }

    Logger.log(
      "Scanned: " + totalScanned + " | On sale so far: " + games.length
    );

    page += batchSize;
    Utilities.sleep(500);
  }

  Logger.log("Final count on sale: " + games.length);
  Logger.log("PC-only games flagged: " + pcIds.size);
  if (failedPages.length > 0) {
    Logger.log(
      "WARNING: these pages failed and were skipped: " + failedPages.join(", ")
    );
  }

  // Don't replace a good file with a partial or empty result
  if (!reachedEnd || totalScanned === 0) {
    Logger.log("Run incomplete, keeping the previous JSON file untouched.");
    return;
  }

  rerankByRatings_(catalog, games);
  // every game's store rating, for the game pages (GamePages.gs)
  try { saveJsonToDrive_(RATINGS, "xbox_ratings.json", "XRATINGS_FILE_ID"); } catch (e) { Logger.log("Ratings file failed: " + e.message); }
  // every game's genres, for the game pages (GamePages.gs)
  try { saveJsonToDrive_(GENRES, "xbox_genres.json", "XGENRES_FILE_ID"); } catch (e) { Logger.log("Genres file failed: " + e.message); }
  // every game's release date, for the game pages (GamePages.gs)
  try { saveJsonToDrive_(RELEASES, "xbox_release.json", "XRELEASE_FILE_ID"); } catch (e) { Logger.log("Release dates file failed: " + e.message); }
  // every game's store description, for the game pages (GamePages.gs)
  try { saveJsonToDrive_(DESCS, "xbox_desc.json", "XDESC_FILE_ID"); } catch (e) { Logger.log("Descriptions file failed: " + e.message); }
  // the games that have add-ons, for the add-on lookups (exportXboxAddOns in XboxAddOns.gs)
  try { saveJsonToDrive_({ updatedAt: new Date().toISOString(), games: ADDON_GAMES }, "xbox_addon_games.json", "XADDONGAMES_FILE_ID"); } catch (e) { Logger.log("Add-on games file failed: " + e.message); }
  const gamePass = enrichGames_(games, startTime);
  try { updateHistory_(catalog, games); } catch (e) { Logger.log("History update failed: " + e.message); }

  const file = saveJsonToDrive_({
    updatedAt: new Date().toISOString(),
    count: games.length,
    skippedPages: failedPages,
    games: games
  });

  Logger.log("JSON saved: " + file.getUrl());

  // Slim list of ALL games, used by the site's search
  // [.., subs, pc, upcoming release, tiers, (store url and product id: PlayStation only), square art]
  catalog.forEach(r => r.push(subsFor_(r[0], r[2], r[1], gamePass).join(","), pcIds.has(r[0]) ? 1 : 0, upc[r[0]] || "", tiersFor_(r[0]).join(","),
                              "", "", sqShort_(SQUARE[r[0]], r[6])));
  const catFile = saveJsonToDrive_(
    { updatedAt: new Date().toISOString(), count: catalog.length, games: catalog },
    "xbox_catalog.json", "CATALOG_FILE_ID"
  );
  Logger.log("Catalog saved: " + catalog.length + " games, " + catFile.getUrl());

  try {
    buildHome_(catalog, dated, gamePass, games);
  } catch (e) {
    Logger.log("Home page data failed: " + e.message);
  }
}

// Picks one cover image URL from the product, whatever the key names are.
// Square cover (box art) and 16:9 hero art of the games on sale, for the home page only
// (kept out of xbox_sales.json so the deals page stays light)
let SALE_ART = {};
// Store ratings of every game, [average out of 5, number of ratings], read while crawling.
// The home page uses the number to tell well-known games from obscure ones.
let RATINGS = {};
let DESCS = {};         // product id -> the start of its store description
// A store description as plain text, at most DESC_MAX characters (cut at a sentence or word). Editions often start
// with a list of what they include ("The Deluxe Edition includes: • …"): that list is left out when the description
// goes on to describe the game.
const DESC_MAX = 700;
const EDITION_LIST = /^[^.\n]{0,80}\b(edition|bundle|pack|collection|version|purchase)\b[^.\n]{0,60}\b(includes?|contains?|comes with|you get)\b[^\n]*$/i;
function descText_(short, long) {
  const clean = x => String(x || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  // without a leading "this edition includes" list (its heading line and the bulleted lines after it)
  const body = x => {
    const lines = x.split("\n");
    if (!EDITION_LIST.test(lines[0])) return x;
    let i = 1;
    while (i < lines.length && (/^\s*([•·*\-–]|\d+[.)])\s*/.test(lines[i]) || !lines[i].trim())) i++;
    return lines.slice(i).join("\n").trim();
  };
  const l = clean(long), s = clean(short), lb = body(l), sb = body(s);
  let t = lb.length >= 80 ? lb : sb.length >= 80 ? sb : l || s;
  if (t.length > DESC_MAX) {
    const cut = t.slice(0, DESC_MAX), end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    t = end > DESC_MAX * 0.5 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + "…";
  }
  return t;
}
let RELEASES = {};      // product id -> its release date ("yyyy-mm-dd"), for the game pages
let SQUARE = {};        // product id -> its square box art (short form, see shortImg_), for the full game list
let ADDON_GAMES = [];   // [id, title, number of ratings] of every game the store says has add-ons
let GENRES = {};   // product id -> its genres ("categories" in the store listing), for the game pages' related games
function pickWide_(product) {
  const imgs = product.images || {}, a = imgs.superHeroArt || imgs.titledHeroImage;
  const url = a && a.url;
  return url ? (url.startsWith("//") ? "https:" + url : url) : null;
}
function pickSquare_(product) {
  const imgs = product.images || {}, a = imgs.boxArt || imgs.featurePromotionalSquareArt;
  const url = a && a.url;
  return url ? (url.startsWith("//") ? "https:" + url : url) : null;
}
function pickImage_(product) {
  const imgs = product.images || {};
  const keys = ["poster", "boxArt", "featurePromotionalSquareArt", "titledHeroImage", "superHeroArt"];
  let url = null;
  for (const k of keys) {
    if (imgs[k] && imgs[k].url) { url = imgs[k].url; break; }
  }
  if (!url) {
    const first = Object.values(imgs).find(v => v && v.url);
    url = first ? first.url : (product.imageUrl || null);
  }
  return url ? (url.startsWith("//") ? "https:" + url : url) : null;
}

// Web app endpoint: the website reads the JSON file through this.
// Deploy > New deployment > Web app > Execute as: Me, Access: Anyone.

// Logs the first product so you can see which fields the API returns.
function debugSample() {
  const url = "https://emerald.xboxservices.com/xboxcomfd/browse?locale=en-US&pageNumber=1";
  const res = UrlFetchApp.fetch(url, { headers: { "MS-CV": "test", "Accept": "application/json" } });
  Logger.log(JSON.stringify(JSON.parse(res.getContentText()).productSummaries[0], null, 2));
}

// Older console and PC Game Pass lists, kept as extra coverage
const GAME_PASS_LISTS = [
  "f6f1f99f-9b49-4ccd-b3bf-4d9767a77f5e",
  "fdd9e2a7-0fee-49f6-ad69-4354098401ff"
];

let GP_TIERS = { ultimate: new Set(), premium: new Set(), essential: new Set(), pc: new Set() };

// Every product id that is in ANY Game Pass tier, and which tier(s) each one is in.
// The log prints how many games each list returned.
function fetchGamePassIds_() {
  const tiers = [
    ["ultimate", "97c6c862-d28a-4907-a3d5-c401f2296a53", "cfq7ttc0khs0"],
    ["premium", "09a72c0d-c466-426a-9580-b78955d8173a", "cfq7ttc0p85b"],
    ["essential", "34031711-5a70-4196-bab7-45757dc2294e", "cfq7ttc0k5dj"]
  ];
  const platforms = [["", ""], ["&platformContext=ConsoleGen8;ConsoleGen9", ""], ["&platformContext=pc", "pc"]];
  const base = "https://catalog.gamepass.com/sigls/v2?language=en-US&market=US";
  const base3 = "https://catalog.gamepass.com/sigls/v3?language=en-US&market=US";
  const urls = [], label = [];
  tiers.forEach(t => platforms.forEach(p => {
    urls.push(base3 + "&id=" + t[1] + p[0] + "&subscriptionContext=" + t[2]);
    label.push(p[1] || t[0]);   // PC lists count as PC Game Pass, the rest as the tier itself
  }));
  GAME_PASS_LISTS.forEach((id, i) => { urls.push(base + "&id=" + id); label.push(i === 1 ? "pc" : ""); });

  let responses = [];
  try {
    responses = UrlFetchApp.fetchAll(urls.map(u => ({ url: u, muteHttpExceptions: true })));
  } catch (e) {
    Logger.log("Game Pass lists failed: " + e.message);
  }
  const ids = new Set();
  GP_TIERS = { ultimate: new Set(), premium: new Set(), essential: new Set(), pc: new Set() };
  responses.forEach((res, i) => {
    let n = 0;
    try {
      JSON.parse(res.getContentText()).forEach(x => {
        if (!x.id) return;
        const id = String(x.id).toUpperCase();
        ids.add(id);
        if (label[i]) GP_TIERS[label[i]].add(id);
        n++;
      });
    } catch (e) {}
    Logger.log("Game Pass list " + (i + 1) + ": " + n + " games");
  });
  Logger.log("Game Pass games in total: " + ids.size + " (Ultimate " + GP_TIERS.ultimate.size + ", Premium " + GP_TIERS.premium.size +
             ", Essential " + GP_TIERS.essential.size + ", PC " + GP_TIERS.pc.size + ")" + (ids.size ? "" : " WARNING: no lists loaded"));
  return ids;
}

function tiersFor_(id) {
  const k = String(id).toUpperCase();
  return ["ultimate", "premium", "essential", "pc"].filter(t => GP_TIERS[t].has(k));
}

// Adds genres, poster art, original release date and subscription tags to each game.
function enrichGames_(games, startTime) {
  const gamePass = fetchGamePassIds_();

  const byId = {};
  games.forEach(g => { byId[String(g.productId).toUpperCase()] = g; });
  const ids = Object.keys(byId);
  const chunks = [];
  for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));

  for (let i = 0; i < chunks.length; i += 8) {
    if (Date.now() - startTime > RUN_LIMIT_MS) {
      Logger.log("WARNING: out of time, skipped catalog lookup for the remaining games");
      break;
    }
    const requests = chunks.slice(i, i + 8).map(c => ({
      url: "https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=" + c.join(",") +
           "&market=US&languages=en-US&MS-CV=DGU1mcuYo0WMMp%2BF.1",
      muteHttpExceptions: true
    }));
    let responses = [];
    try { responses = UrlFetchApp.fetchAll(requests); } catch (e) { Logger.log("Catalog batch error: " + e.message); }
    responses.forEach(res => {
      try {
        (JSON.parse(res.getContentText()).Products || []).forEach(p => {
          const g = byId[String(p.ProductId).toUpperCase()];
          if (!g) return;
          const props = p.Properties || {};
          g.genres = (props.Categories || [props.Category]).filter((x, i, a) => x && a.indexOf(x) === i);   // no repeats
          const imgs = (p.LocalizedProperties && p.LocalizedProperties[0] && p.LocalizedProperties[0].Images) || [];
          const art = imgs.find(x => x.ImagePurpose === "Poster") || imgs.find(x => x.ImagePurpose === "BoxArt");
          if (art && art.Uri) g.image = art.Uri.startsWith("//") ? "https:" + art.Uri : art.Uri;
          g.released = relDate_(p);
          let ends = Infinity;
          (p.DisplaySkuAvailabilities || []).forEach(sku => (sku.Availabilities || []).forEach(a => {
            const t = Date.parse(a.Conditions && a.Conditions.EndDate);
            const pr = a.OrderManagementData && a.OrderManagementData.Price;
            if (t > Date.now() && t < Date.UTC(3000, 0, 1) && pr && pr.ListPrice < pr.MSRP) ends = Math.min(ends, t);
          }));
          if (ends < Infinity) g.saleEnds = new Date(ends).toISOString();
        });
      } catch (e) { Logger.log("Catalog parse error: " + e.message); }
    });
    Utilities.sleep(300);
  }

  games.forEach(g => {
    g.subs = subsFor_(g.productId, g.publisher, g.title, gamePass);
    g.tiers = tiersFor_(g.productId);
    g.genres = g.genres || [];
  });
  return gamePass;
}

// Other subscriptions a game is included with, read from the store listing (includedWithPassesProductIds)
const OTHER_PASSES = {
  CFQ7TTC0K5DH: "eaplay",    // EA Play
  CFQ7TTBZT8K1: "ubisoft",   // Ubisoft+ Classics
  CFQ7TTC0QH5H: "ubisoft",   // Ubisoft+ Premium
  CFQ7TTC0HX8W: "gtaplus"    // GTA+
};
let PASS_SUBS = {};   // product id -> ["eaplay", "ubisoft", "gtaplus"], filled while crawling
function notePasses_(product) {
  if (!product.productId) return;
  const out = [];
  (product.includedWithPassesProductIds || []).forEach(p => {
    const s = OTHER_PASSES[String(p).toUpperCase()];
    if (s && out.indexOf(s) < 0) out.push(s);
  });
  if (out.length) PASS_SUBS[String(product.productId).toUpperCase()] = out;
}
// Extra subscription tags (not Game Pass) of a game
function otherSubs_(productId) {
  return PASS_SUBS[String(productId).toUpperCase()] || [];
}

// Game Pass (any tier), then EA Play, Ubisoft+ and GTA+.
function subsFor_(productId, publisher, title, gamePass) {
  return (gamePass.has(String(productId).toUpperCase()) ? ["gamepass"] : []).concat(otherSubs_(productId));
}

const IMG_PREFIX = "https://store-images.s-microsoft.com/image/";
// The square art in the full game list, shorter: the store's image names are "apps.<n>.<id>.<id>.<id>" and a game's poster
// and square art usually share the middle parts, so only "=<n>.<last part>" is kept then (site: common.js sqOf; GamePages.gs)
function sqShort_(sq, poster) {
  const a = String(sq || "").split("."), b = String(poster || "").split(".");
  return !sq ? "" : a.length === 5 && b.length === 5 && a[0] === b[0] && a[2] === b[2] && a[3] === b[3] ? "=" + a[1] + "." + a[4] : sq;
}
function shortImg_(u) {
  return u && u.startsWith(IMG_PREFIX) ? u.slice(IMG_PREFIX.length) : u;
}

// ---------- Other regions ----------
// US is handled by exportXboxCatalog. EU uses Ireland (English titles, euro prices).
const REGIONS = {
  US: "en-US", UK: "en-GB", CA: "en-CA", EU: "en-IE", BR: "pt-BR", AR: "es-AR",
  TR: "tr-TR", KR: "ko-KR", JP: "ja-JP", IN: "en-IN", AU: "en-AU"
};
function exportUK() { exportRegion_("UK"); }
function exportCA() { exportRegion_("CA"); }
function exportEU() { exportRegion_("EU"); }
function exportBR() { exportRegion_("BR"); }
function exportAR() { exportRegion_("AR"); }
function exportTR() { exportRegion_("TR"); }
function exportKR() { exportRegion_("KR"); }
function exportJP() { exportRegion_("JP"); }
function exportIN() { exportRegion_("IN"); }
function exportAU() { exportRegion_("AU"); }

// Crawls the whole browse listing for a locale. Returns true if it reached the end.
function crawl_(locale, startTime, onProduct) {
  const headers = { "MS-CV": "test", "Accept": "application/json" };
  const batchSize = 8;
  let page = 1, fails = 0;

  while (Date.now() - startTime < RUN_LIMIT_MS) {
    const requests = [];
    for (let i = 0; i < batchSize; i++) {
      requests.push({
        url: "https://emerald.xboxservices.com/xboxcomfd/browse?locale=" + locale +
             "&pageNumber=" + (page + i) + "&resultsPerPage=500" + EXTRA_QUERY,
        headers: headers,
        muteHttpExceptions: true
      });
    }
    let responses = [];
    try { responses = UrlFetchApp.fetchAll(requests); } catch (e) { Logger.log("Batch error: " + e.message); }

    for (let i = 0; i < batchSize; i++) {
      let json = null;
      try {
        const r = responses[i];
        if (r && r.getResponseCode() === 200 && r.getContentText()) json = JSON.parse(r.getContentText());
      } catch (e) {}
      if (json === null) json = fetchPage_(requests[i].url, headers);
      if (json === null) {
        if (++fails >= 3) return false;
        continue;
      }
      fails = 0;
      const products = json.productSummaries || [];
      if (products.length === 0) return true;
      products.forEach(onProduct);
    }
    page += batchSize;
    Utilities.sleep(500);
  }
  return false;
}

// Saves prices for every game in one region, plus details for games that are
// on sale there but not in the US sale list.
function exportRegion_(code, chainStart) {
  const startTime = chainStart || Date.now();
  const prices = {};
  const sale = [];
  let currency = "", rank = 0;

  const reachedEnd = crawl_(REGIONS[code], startTime, p => {
    const offer = p.specificPrices?.purchaseable?.[0];
    if (!offer || !p.productId || prices[p.productId]) return;
    const price = Number(offer.listPrice) || 0;
    const msrp = Number(offer.msrp) || 0;
    const disc = Number(offer.discountPercentage) || 0;
    prices[p.productId] = [price, msrp, ++rank, disc];
    currency = currency || offer.currency || "";
    if ((Number(offer.discountPercentage) || 0) > 0 || (msrp > 0 && price < msrp)) {
      sale.push({
        productId: p.productId,
        title: p.title || "",
        publisher: p.publisherName || "",
        image: pickImage_(p),
        pc: pcOnly_(p)
      });
    }
  });

  Logger.log(code + ": " + rank + " priced games, " + sale.length + " on sale, currency " + currency);
  if (!reachedEnd || rank === 0) {
    Logger.log(code + ": run incomplete, keeping the previous file.");
    return false;
  }

  // Games on sale here but not in the US sale list need genres, posters and tags
  const usSale = new Set();
  try {
    const usId = PropertiesService.getScriptProperties().getProperty("JSON_FILE_ID");
    JSON.parse(DriveApp.getFileById(usId).getBlob().getDataAsString())
      .games.forEach(g => usSale.add(String(g.productId)));
  } catch (e) { Logger.log("Couldn't read the US sale list: " + e.message); }

  const extra = sale.filter(g => !usSale.has(String(g.productId)));
  try { enrichGames_(extra, startTime); } catch (e) { Logger.log("Enrich error: " + e.message); }

  const file = saveJsonToDrive_(
    { updatedAt: new Date().toISOString(), region: code, currency: currency, prices: prices, extra: extra },
    "xbox_prices_" + code + ".json", "PRICES_" + code + "_FILE_ID"
  );
  Logger.log(code + " saved: " + file.getUrl());
  return true;
}

// ---------- Home page sections ----------
const GAME_PASS_COMING_LIST = "095bda36-f5cd-43f2-9ee1-0a72f371fb96"; // "Coming to Game Pass" list (Fable, Persona 4 Revival, ...)

// A release date, or null when the store has none (it uses the year 9998 as "no date yet")
const realDate_ = d => d && Number(String(d).slice(0, 4)) < 9000 ? d : null;
function relDate_(p) {
  return realDate_((p && p.MarketProperties && p.MarketProperties[0] && p.MarketProperties[0].OriginalReleaseDate) || null);
}
const GAME_PASS_RECENT_LIST = "f13cf6b4-57e6-4459-89df-6aec18cf0538"; // "Recently added" list

function fetchSiglList_(id) {
  try {
    const res = UrlFetchApp.fetch(
      "https://catalog.gamepass.com/sigls/v2?id=" + id + "&language=en-US&market=US",
      { muteHttpExceptions: true }
    );
    return JSON.parse(res.getContentText()).filter(x => x.id).map(x => String(x.id).toUpperCase());
  } catch (e) {
    Logger.log("List " + id + " failed: " + e.message);
    return [];
  }
}

// Title, publisher, poster, original release date and type for a list of product ids.
// A game the store lists without a date (often the Game Pass version) gets the earliest date of its editions,
// the products it is bundled with: that's the date its store page shows (e.g. STRANGER THAN HEAVEN).
function lookupProducts_(ids, noEditions) {
  const out = {};
  const chunks = [];
  for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));
  for (let i = 0; i < chunks.length; i += 8) {
    const reqs = chunks.slice(i, i + 8).map(c => ({
      url: "https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=" + c.join(",") +
           "&market=US&languages=en-US&MS-CV=DGU1mcuYo0WMMp%2BF.1",
      muteHttpExceptions: true
    }));
    let res = [];
    try { res = UrlFetchApp.fetchAll(reqs); } catch (e) { Logger.log("Lookup error: " + e.message); }
    res.forEach(r => {
      try {
        (JSON.parse(r.getContentText()).Products || []).forEach(p => {
          const lp = (p.LocalizedProperties && p.LocalizedProperties[0]) || {};
          const imgs = lp.Images || [];
          const art = imgs.find(x => x.ImagePurpose === "Poster") || imgs.find(x => x.ImagePurpose === "BoxArt");
          const box = imgs.find(x => x.ImagePurpose === "BoxArt");
          const hero = imgs.find(x => x.ImagePurpose === "SuperHeroArt") || imgs.find(x => x.ImagePurpose === "TitledHeroArt");
          out[String(p.ProductId).toUpperCase()] = {
            title: lp.ProductTitle,
            publisher: lp.PublisherName,
            type: p.ProductType,
            genres: ((p.Properties && (p.Properties.Categories || [p.Properties.Category])) || []).filter((x, i, a) => x && a.indexOf(x) === i),
            image: art && art.Uri ? (art.Uri.startsWith("//") ? "https:" + art.Uri : art.Uri) : null,
            square: box && box.Uri ? (box.Uri.startsWith("//") ? "https:" + box.Uri : box.Uri) : null,
            wide: hero && hero.Uri ? (hero.Uri.startsWith("//") ? "https:" + hero.Uri : hero.Uri) : null,
            released: relDate_(p),
            editions: ((p.MarketProperties && p.MarketProperties[0] && p.MarketProperties[0].RelatedProducts) || [])
              .filter(r => r.RelationshipType === "Bundle").map(r => String(r.RelatedProductId).toUpperCase())
          };
        });
      } catch (e) {}
    });
    Utilities.sleep(200);
  }
  if (!noEditions) {
    const missing = Object.keys(out).filter(id => !out[id].released && out[id].editions.length);
    const ed = missing.length ? lookupProducts_(Array.from(new Set([].concat(...missing.map(id => out[id].editions)))), true) : {};
    missing.forEach(id => {
      const d = out[id].editions.map(e => ed[e] && ed[e].released).filter(Boolean).sort()[0];
      if (d) out[id].released = d;
    });
  }
  return out;
}

// Builds xbox_home.json: popular, upcoming, recently released, Game Pass coming / added.
function buildHome_(catalog, dated, gamePass, sales) {
  const now = Date.now(), N = 15;
  const row = {};
  catalog.forEach(r => { row[String(r[0]).toUpperCase()] = r; });
  const saleBy = {};
  sales.forEach(g => { saleBy[String(g.productId).toUpperCase()] = g; });

  // Games already in Game Pass have already "come", so they are dropped from this list
  // The "Coming to Game Pass" list (games with a date first, soonest first, then the ones without a date yet)
  const comingAll = fetchSiglList_(GAME_PASS_COMING_LIST);
  const coming = comingAll.filter(id => !gamePass.has(id));   // games already in Game Pass have already "come"
  const added = fetchSiglList_(GAME_PASS_RECENT_LIST).slice(0, 15);
  Logger.log("Game Pass coming soon: " + coming.length + " kept of " + comingAll.length + ", recently added: " + added.length);

  const near = dated
    .sort((a, b) => Math.abs(a[1] - now) - Math.abs(b[1] - now))
    .slice(0, 600)
    .map(d => String(d[0]).toUpperCase());
  // Rankings from the Microsoft Store charts pages (first page = top 50)
  const topPaid = fetchChartIds_("https://www.microsoft.com/en-us/store/top-paid/games/xbox").slice(0, 30);
  const mostPlayed = fetchChartIds_("https://www.microsoft.com/en-us/store/most-popular/games/xbox").slice(0, 40);
  Logger.log("Microsoft Store charts: top paid " + topPaid.length + ", most played " + mostPlayed.length);
  const gpIds = Array.from(gamePass);
  // Most wishlisted: how many of this site's accounts wishlisted each Xbox game
  const wc = wishCounts_(), wished = Object.keys(wc).filter(id => /^[A-Z0-9]{12}$/i.test(id)).map(id => id.toUpperCase())
    .sort((a, b) => wc[b] - wc[a]).slice(0, 40);
  const info = lookupProducts_(Array.from(new Set(coming.concat(added, near, topPaid, mostPlayed, gpIds, wished))));

  const entry = id => {
    const r = row[id] || [], i = info[id] || {};
    return {
      id: id,
      title: i.title || r[1] || "",
      publisher: i.publisher || r[2] || "",
      image: shortImg_(i.image) || r[6] || null,
      sq: shortImg_(i.square) || (SALE_ART[id] && shortImg_(SALE_ART[id].sq)) || SQUARE[id] || null,
      wide: shortImg_(i.wide) || (SALE_ART[id] && shortImg_(SALE_ART[id].wide)) || null,
      ra: RATINGS[id] ? RATINGS[id][0] : null,
      rc: RATINGS[id] ? RATINGS[id][1] : 0,
      price: Number(r[3]) || 0,
      msrp: Number(r[4]) || 0,
      currency: r[5] || "USD",
      date: i.released || null,
      gp: gamePass.has(id),
      xs: otherSubs_(id),
      low: !!(saleBy[id] && saleBy[id].atLow),
      ends: (saleBy[id] && saleBy[id].saleEnds) || null,
      pc: !!((row[id] || [])[9]) || !!(saleBy[id] && saleBy[id].pc),
      tiers: tiersFor_(id),
      release: (i.released && Date.parse(i.released) > Date.now() ? i.released : null) || r[10] || null,
      genres: i.genres || [],
      f2p: !!(r.length && Number(r[3]) === 0 && Number(r[4]) === 0)   // free-to-play: has a store offer priced at 0
    };
  };
  const ok = g => g.title && g.image;
  const fromSale = g => {
    const e = entry(String(g.productId).toUpperCase());
    e.title = g.title || e.title; e.publisher = g.publisher || e.publisher;
    e.image = shortImg_(g.image) || e.image; e.date = g.saleEnds;
    return e;
  };
  const isGame = id => (info[id] || {}).type === "Game";
  const time = id => Date.parse((info[id] || {}).released) || 0;

  // Posters of the most popular games that are on sale, for the home page's deals bar
  // Posters of the most popular games on sale, one per game (different platform versions often share art)
  const seenArt = {}, seenName = {}, bar = [];
  sales.slice().sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9)).forEach(g => {
    const im = shortImg_(g.image) || (row[String(g.productId).toUpperCase()] || [])[6];
    const key = String(im || "").split("?")[0];
    const name = norm_(cleanTitle_(g.title).replace(/xbox one|xbox series x\|s|windows|\bpc\b/gi, ""));
    if (!im || seenArt[key] || seenName[name] || bar.length >= 14) return;
    seenArt[key] = seenName[name] = true;
    bar.push(im);
  });

  // Well-known games on sale, by number of store ratings (one per game: editions often share a title).
  // spotPool: the SPOT_TOP most-rated games on sale.
  // hotPool: see hotPool_. The home page picks 7 at random a day from each. popIds: SEE_ALL_RATINGS or more,
  // for the big-discounts "See all" list.
  const rated = [], seenTitle = {};
  sales.map(g => String(g.productId).toUpperCase()).filter(id => RATINGS[id] && saleBy[id].image)
    .sort((a, b) => RATINGS[b][1] - RATINGS[a][1]).forEach(id => {
      const t = editionKey_(saleBy[id].title);
      if (seenTitle[t]) return;
      seenTitle[t] = true; rated.push(id);
    });
  const spotPool = rated.map(id => fromSale(saleBy[id])).filter(ok).slice(0, SPOT_TOP);
  const hotPool = hotPool_(rated.map(id => fromSale(saleBy[id])).filter(ok), bigOff_, "xbox");
  const popIds = rated.filter(id => RATINGS[id][1] >= SEE_ALL_RATINGS);

  const weekAgo = Number(Utilities.formatDate(new Date(Date.now() - 7 * 864e5), "UTC", "yyyyMMdd"));
  const nRatings = g => (RATINGS[String(g.productId).toUpperCase()] || [0, 0])[1];
  const sections = {
    spotPool: spotPool, spotV: 2,   // spotV 2: the SPOT_TOP most-rated games on sale
    hotPool: hotPool, hotV: 3,   // hotV 3: hotPool_ (most rated, 60%+ off, HOT_MIN_RATINGS)
    popIds: popIds,
    // Trending: the store's own order, paid games only
    popular: catalog.filter(r => r[6] && Number(r[3]) > 0).slice(0, N).map(r => entry(String(r[0]).toUpperCase())).filter(ok),
    // Upcoming: the next month (the home page shows 2 weeks, or the month when that's fewer than 6 games)
    upcoming: near.filter(id => isGame(id) && time(id) > now && time(id) < now + 31 * 864e5).sort((a, b) => time(a) - time(b)).map(entry).filter(ok),
    wished: wished.map(id => Object.assign(entry(id), { wc: wc[id] || wc[id.toLowerCase()] || 0 })).filter(ok).slice(0, N),
    recent: near.filter(id => isGame(id) && time(id) <= now && time(id) > now - 7 * 864e5).sort((a, b) => time(b) - time(a)).map(entry).filter(ok),
    bestselling: topPaid.slice(0, N).map(entry).filter(ok),
    played: mostPlayed.map(entry).filter(ok).filter(e => e.price > 0).slice(0, N),   // paid games only
    ending: sales.filter(g => g.saleEnds && Date.parse(g.saleEnds) < now + 7 * 864e5)
      .sort((a, b) => Date.parse(a.saleEnds) - Date.parse(b.saleEnds)).map(fromSale).filter(ok),
    // Bargains: discounted games under $1 / $5 / $10, most popular first (store order), one per game
    // Xbox's popularity order isn't reliable for cheap games: most store ratings first
    under1: bargains_(sales, 1, fromSale, ok, nRatings), under5: bargains_(sales, 5, fromSale, ok, nRatings), under10: bargains_(sales, 10, fromSale, ok, nRatings),
    // Newest discounts: the latest games whose price dropped, with NEWEST_MIN_RATINGS+ store ratings, most recent first
    // (the home page shows the 15 most recent, ranked by number of ratings)
    newest: sales.filter(g => g.newSale && nRatings(g) >= NEWEST_MIN_RATINGS).sort((a, b) => b.newSale - a.newSale || nRatings(b) - nRatings(a)).slice(0, 60).map(fromSale).filter(ok)
  };

  // Game Pass tab: every Game Pass game, the 15 newest additions, and everything announced as coming
  const gpAll = gpIds.filter(id => row[id] || info[id]).sort((a, b) => (row[a] ? row[a][7] || 1e9 : 2e9) - (row[b] ? row[b][7] || 1e9 : 2e9)).map(entry).filter(ok);
  const gpComing = coming.slice().sort((a, b) => (time(b) > now) - (time(a) > now) || (time(a) > now ? time(a) - time(b) : time(b) - time(a))).map(entry).filter(ok);
  const gpData = { updatedAt: new Date().toISOString(), all: gpAll, added: added.map(entry).filter(ok), coming: gpComing };
  saveJsonToDrive_(gpData, "xbox_gamepass.json", "GAMEPASS_FILE_ID");
  Logger.log("Game Pass lists: all " + gpAll.length + ", added " + gpData.added.length + ", coming " + gpComing.length);

  const file = saveJsonToDrive_(
    { updatedAt: new Date().toISOString(), dealsCount: sales.length, bar: bar,
      gp: { all: gpAll.length, added: gpData.added.length, coming: gpComing.length }, sections: sections },
    "xbox_home.json", "HOME_FILE_ID"
  );
  Logger.log("Home saved: " + Object.keys(sections).filter(k => Array.isArray(sections[k])).map(k => k + "=" + sections[k].length).join(", ") + " " + file.getUrl());
}

// Discounted games under `max` (US price), most popular first (the store's own order), one per game, up to 30.
// Used by both exports: toEntry turns a sale into a home entry.
// rated(g): the game's number of store ratings when sorting by that (Xbox); without it, by the store's popularity rank
function bargains_(sales, max, toEntry, ok, rated) {
  const seen = {};
  return sales.filter(g => g.image && Number(g.price) < max && Number(g.price) < Number(g.msrp))
    .sort((a, b) => (rated ? rated(b) - rated(a) : 0) || (a.rank || 1e9) - (b.rank || 1e9))
    .filter(g => { const t = scoreKey_(g.title); if (!t || seen[t]) return false; return (seen[t] = true); })
    .slice(0, 30).map(toEntry).filter(ok);
}

// How many of this site's accounts wishlisted each game: {id: count}. Neither store publishes wishlist rankings.
function wishCounts_() {
  return psReadJson_("WISHCOUNTS_FILE_ID", {});
}

// ---------- Price history ----------
// Records each game's price whenever it changes (tracking starts at the first run),
// and flags sale games that sit at the lowest price tracked so far.
// Prices that differ by 2 cents or less are the same price: the store sometimes shows a deal as $9.99 one day
// and $10.00 the next (80% off $49.99 is $9.998), which isn't a price change
const samePrice_ = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.02;

function updateHistory_(catalog, games) {
  const props = PropertiesService.getScriptProperties();
  const today = Number(Utilities.formatDate(new Date(), "UTC", "yyyyMMdd"));
  let data = { since: today, h: {} };
  const id = props.getProperty("HISTORY_FILE_ID");
  if (id) {
    try {
      data = JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString());
    } catch (e) {
      throw new Error("couldn't read the existing history, leaving it untouched: " + e.message);
    }
  }
  catalog.forEach(r => {
    const price = Number(r[3]);
    const list = data.h[r[0]] || (data.h[r[0]] = []);
    const last = list[list.length - 1];
    if (!last || !samePrice_(last[1], price)) list.push([today, price]);
  });
  data.updated = today;

  games.forEach(g => {
    const list = data.h[g.productId] || [];
    g.atLow = list.length >= 2 && Number(g.price) <= Math.min.apply(null, list.map(x => x[1])) + 0.02;
    const n = list.length;   // date (YYYYMMDD) the current, lower price started
    g.newSale = n >= 2 && list[n - 1][1] < list[n - 2][1] - 0.02 ? list[n - 1][0] : 0;
  });

  saveJsonToDrive_(data, "xbox_history.json", "HISTORY_FILE_ID");
  Logger.log("History: " + Object.keys(data.h).length + " games tracked since " + data.since +
             ", " + games.filter(g => g.atLow).length + " at their lowest tracked price");
}

// True when the store lists the game for PC only (no Xbox console).
function pcOnly_(product) {
  const a = product.availableOn;
  if (!Array.isArray(a) || !a.length) return false;
  const t = a.map(x => String(x).toLowerCase()).join(",");
  return t.indexOf("pc") >= 0 && t.indexOf("xbox") < 0;
}

// Product ids, in ranked order, from a Microsoft Store chart page (top paid, most played...).
function fetchChartIds_(url) {
  try {
    const res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    let html = res.getContentText();
    const start = html.indexOf("Showing 1");   // skip the header and menu links
    if (start > 0) html = html.slice(start);
    const ids = [], seen = {};
    const re = /\/p\/[a-z0-9-]+\/([a-z0-9]{12})(?![a-z0-9])/gi;
    let m;
    while ((m = re.exec(html))) {
      const id = m[1].toUpperCase();
      if (id.indexOf("CFQ7TTC0") === 0 || seen[id]) continue;   // gift cards, Game Pass itself
      seen[id] = true;
      ids.push(id);
    }
    if (!ids.length) Logger.log("No products found on " + url + " (HTTP " + res.getResponseCode() + ")");
    return ids;
  } catch (e) {
    Logger.log("Chart failed: " + url + " " + e.message);
    return [];
  }
}

// ---------- Game description for the pop-up ----------
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// The Metacritic score (and the release date) for the pop-up, read from Metacritic's own site backend
// (backend.metacritic.com), the same data its pages use. No key needed. Results are cached for 6 hours.
function cleanTitle_(t) {
  return String(t || "").replace(/[™®©]/g, "").replace(/\s*[\(\[].*?[\)\]]/g, "")
    .replace(/\s*[-–:|]?\s*\b(PS4|PS5)\b(\s*(&|and|\/|\+)\s*(PS4|PS5)\b)?\s*$/i, "")   // "… PS4 & PS5" on PlayStation titles
    .replace(/\s*[-–:|]?\s*(standard|deluxe|ultimate|premium|gold|complete|definitive|digital|collector'?s|anniversary|game of the year)\s+edition\b.*$/i, "")
    .replace(/\s*[-–:|]?\s*(game of the year|goty)\b.*$/i, "").trim();
}
// Xbox's own listing order isn't a good popularity measure, so "Most popular" everywhere on the site (each game's
// rank) is the number of store ratings, most first; the store's order breaks ties and ranks games without ratings.
function rerankByRatings_(catalog, games) {
  const n = id => (RATINGS[String(id).toUpperCase()] || [0, 0])[1];
  const order = catalog.filter(r => r[0]).sort((a, b) => n(b[0]) - n(a[0]) || a[7] - b[7]);
  const newRank = {};
  order.forEach((r, i) => { newRank[r[0]] = i + 1; r[7] = i + 1; });
  games.forEach(g => { if (newRank[g.productId]) g.rank = newRank[g.productId]; });
}

// One key for every edition of a game: "Microsoft Flight Simulator (2020) Premium Deluxe 40th Anniversary Edition"
// and "… Standard 40th Anniversary Edition" are the same game
function editionKey_(t) {
  const words = "(standard|deluxe|ultimate|premium|gold|complete|definitive|digital|collector'?s|anniversary|special|enhanced|legendary|launch|cross-gen|\\d+(st|nd|rd|th))";
  const ed = new RegExp("\\s*[-–:|]?\\s*(" + words + "\\s+)+edition\\b.*$", "i");
  return norm_(cleanTitle_(String(t || "").replace(/[™®©]/g, "").replace(ed, "")
    .replace(/\b(xbox one|xbox series x\|s|xbox series x|windows|for pc|pc|ps4|ps5)\b/gi, "")));
}
function norm_(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function slug_(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

// Also returns the game's screenshots (shots), trailers (videos: [{url, title, poster}], MP4 or HLS) and genres
// for the pop-up. pid: a PlayStation product id for
// cards that are whole games (concepts), whose own id can't be looked up.
// noMc: the site already has this game's Metascore (from the scores file), so Metacritic isn't asked
function reviewsJson_(id, title, pid, noMc) {
  // Xbox ids are 12 letters/digits; PlayStation ids look like UP1001-PPSA35889_00-NBA2K27SUPERED00 or 10000730
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) return json_({ error: "bad id" });
  const xbox = /^[A-Za-z0-9]{12}$/.test(id);
  const cache = CacheService.getScriptCache();
  const ck = "r7:" + id + (noMc ? ":n" : ""), hit = cache.get(ck);
  if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);

  const q = cleanTitle_(title);
  // hero: 16:9 key art for the pop-up's banner; sr: store rating [average out of 5, number of ratings]
  // (PlayStation's comes separately, from file=rating, because it needs the whole store page)
  const out = { mc: null, mcUrl: null, released: null, shots: [], videos: [], genres: [], hero: null, sr: null };
  const uniq = (x, i, a) => x && a.indexOf(x) === i;
  const abs = u => u && u.startsWith("//") ? "https:" + u : u;
  const prodId = xbox ? id : (/^\d+$/.test(id) ? pid : id);

  // every request at once, one attempt each: the pop-up is waiting
  const reqs = [], at = {};
  const add = (name, r) => { at[name] = reqs.length; reqs.push(Object.assign({ muteHttpExceptions: true }, r)); };
  if (xbox) {
    add("catalog", { url: "https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=" + id + "&market=US&languages=en-US&MS-CV=DGU1mcuYo0WMMp%2BF.1" });
    add("details", { url: "https://emerald.xboxservices.com/xboxcomfd/productDetails/" + id + "?locale=en-US",
                     headers: { "MS-CV": "test", "Accept": "application/json", "x-ms-api-version": "2.0" } });
  } else if (/^[A-Za-z0-9_-]{4,64}$/.test(prodId || "")) {
    add("ps", psRequest_("metGetProductById", { productId: prodId }));
  }
  if (q && !noMc) add("mc", Object.assign({ url: mcUrl_(q) }, mcOpts_()));
  let res = [];
  try { res = UrlFetchApp.fetchAll(reqs); } catch (e) { Logger.log("Pop-up lookup failed: " + e.message); }
  const json = name => { try { return at[name] === undefined ? null : JSON.parse(res[at[name]].getContentText()); } catch (e) { return null; } };

  const cat = json("catalog");
  if (cat) try {   // release date, screenshots, genres and key art from the Microsoft catalog
    const p = (cat.Products || [])[0];
    out.released = relDate_(p);
    const imgs = (p && p.LocalizedProperties && p.LocalizedProperties[0] && p.LocalizedProperties[0].Images) || [];
    out.shots = imgs.filter(x => x.ImagePurpose === "Screenshot" && x.Uri).map(x => abs(x.Uri)).filter(uniq).slice(0, 12);
    out.genres = ((p && p.Properties && (p.Properties.Categories || [p.Properties.Category])) || []).filter(uniq);
    const hero = imgs.find(x => x.ImagePurpose === "SuperHeroArt") || imgs.find(x => x.ImagePurpose === "TitledHeroArt");
    if (hero && hero.Uri) out.hero = abs(hero.Uri);
  } catch (e) {}
  const det = json("details");
  if (det) try {   // trailers (HLS streams over https) and the store rating, from the Xbox store's product details
    const prod = (det.productSummaries || [])[0] || {};
    out.videos = (prod.cmsVideos || []).filter(v => v && /^https:/.test(v.url)).slice(0, 4)
      .map(v => ({ url: v.url, title: v.title || "Trailer", poster: (v.previewImage && v.previewImage.url) || "" }));
    if (prod.categories && prod.categories.length) out.genres = prod.categories.filter(uniq);
    if (prod.ratingCount) out.sr = [Number(prod.averageRating) || 0, prod.ratingCount];
    const sh = prod.images && prod.images.superHeroArt;
    if (!out.hero && sh && sh.url) out.hero = abs(sh.url);
  } catch (e) {}
  const ps = json("ps");
  if (ps) try {   // PlayStation: screenshots, trailers, genres and key art from the store's game details
    const prod = (ps.data && ps.data.productRetrieve) || {}, concept = prod.concept || {};
    const media = (prod.media || []).concat(concept.media || []);   // edition first, then the whole game's
    out.shots = media.filter(m => m.role === "SCREENSHOT" && m.type === "IMAGE" && m.url).map(m => String(m.url).split("?")[0]).filter(uniq).slice(0, 12);
    out.videos = media.filter(m => m.type === "VIDEO" && /^https:/.test(m.url || "")).map(m => m.url).filter(uniq).slice(0, 4)
      .map((u, i) => ({ url: u, title: i ? "Trailer " + (i + 1) : "Trailer", poster: out.shots[i] || "" }));
    out.genres = (prod.combinedLocalizedGenres || concept.combinedLocalizedGenres || []).map(x => x.value).filter(uniq);
    out.hero = psWide_(concept.media) || psWide_(prod.media);
  } catch (e) {}
  const mc = json("mc");
  if (mc) {   // Metacritic
    const f = mcFind_(q, (mc.data && mc.data.items) || mc.items || []);
    if (f && f.mc > 0) { out.mc = f.mc; out.mcUrl = "https://www.metacritic.com/game/" + f.slug + "/"; }
  }

  const text = JSON.stringify(out);
  cache.put(ck, text, 21600);
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

// A PlayStation game's store rating for the pop-up: {sr: [average, count]} or {sr: null}. Cached for a day.
function ratingJson_(id) {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) return json_({ error: "bad id" });
  const cache = CacheService.getScriptCache(), hit = cache.get("sr:" + id);
  if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
  const text = JSON.stringify({ sr: psStarRating_(id) });
  cache.put("sr:" + id, text, 86400);
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

// Popular games, on both stores. Deal spotlight: 7 games picked at random each day from the SPOT_TOP most-rated
// games on sale (one per game). "Big discounts on popular games": hotPool_; its See all: SEE_ALL_RATINGS or more.
const SPOT_TOP = 20, SEE_ALL_RATINGS = 7000;
// "Newest discounts" on the home page: only games with at least this many store ratings
const NEWEST_MIN_RATINGS = 200;
// "Big discounts on popular games" (home page and its See all list): this much off or more
const HOT_MIN_PCT = 60;
// and at least this many store ratings (Xbox games get far fewer ratings than PlayStation ones)
const HOT_MIN_RATINGS = { xbox: 3000, ps: 10000 };
// The home page's pool for it: of the 50 most-rated games on sale, those HOT_MIN_PCT% off or more with
// HOT_MIN_RATINGS ratings. When that's fewer than 7, the 7 most-rated games at HOT_MIN_PCT% off or more.
// `rated` is sorted by number of ratings, most first; each entry has rc (its number of ratings).
const hotPool_ = (rated, off, plat) => {
  const top = rated.slice(0, 50).filter(e => off(e) && e.rc >= HOT_MIN_RATINGS[plat]);
  return top.length >= 7 ? top : rated.filter(off).slice(0, 7);
};
const bigOff_ = e => e.price > 0 && e.msrp > e.price && Math.round((1 - e.price / e.msrp) * 100) >= HOT_MIN_PCT;

// ---------- Daily request budget ----------
// Apps Script allows 20,000 web requests (UrlFetch) a day on a personal Google account, and every request fails
// once they're used up. The background jobs (psFillPublishers, fillScores) count what they use here and stop at
// BACKGROUND_BUDGET a day between them, which leaves room for the daily exports and the site's pop-ups.
const BACKGROUND_BUDGET = 1e9;   // no daily request limit on GitHub (Apps Script allows 20,000)
// Records n requests (0 = just ask) and returns how many the background jobs may still make today (UTC)
function fetchBudget_(n) {
  const p = PropertiesService.getScriptProperties(), day = Utilities.formatDate(new Date(), "UTC", "yyyyMMdd");
  let used = p.getProperty("FETCH_DAY") === day ? Number(p.getProperty("FETCH_USED")) || 0 : 0;
  if (n) { used += n; p.setProperties({ FETCH_DAY: day, FETCH_USED: String(used) }); }
  return Math.max(0, BACKGROUND_BUDGET - used);
}
// Google's "Service invoked too many times for one day: urlfetch": nothing more can be fetched today
function quotaHit_(e) { return /too many times/i.test(String((e && e.message) || e)); }

// ---------- Metacritic scores, looked up ahead of time ----------
// fillScores (every 3 hours) looks up the Metascore of the home page games, every game
// on sale and the 1,000 most popular games of the full list, on both stores in turn, and keeps them by title in metacritic.json
// ({title key: [score, slug, day]}, score 0 = not on Metacritic). It then writes a small map per platform,
// scores.json and ps_scores.json ({game id: [score, slug]}), which the site loads so a pop-up shows the
// score straight away. Read with doGet &file=scores (and &platform=ps).
const SCORE_MAX = 1200;  // Metacritic searches per run (about 2 minutes; no daily budget on GitHub)


// The same game on Xbox and PlayStation, in any edition, gets the same key
function scoreKey_(title) {
  return norm_(cleanTitle_(String(title || "").replace(/\b(xbox one|xbox series x\|s|xbox series x|windows|for pc)\b/gi, "")));
}
// Metacritic's search results for a title ([] if the search failed)
function mcSearch_(q) {
  try {
    const res = UrlFetchApp.fetch(mcUrl_(q), mcOpts_());
    const j = JSON.parse(res.getContentText());
    return (j.data && j.data.items) || j.items || [];
  } catch (e) { Logger.log("Metacritic lookup failed: " + e.message); return null; }
}
function mcUrl_(q) {
  return "https://backend.metacritic.com/finder/metacritic/search/" + encodeURIComponent(q) +
    "/web?mcoTypeId=13&offset=0&limit=5&componentName=search&componentDisplayName=Search&componentType=SearchResults";
}
function mcOpts_() {
  return { muteHttpExceptions: true, headers: { "User-Agent": "Mozilla/5.0 (compatible; XboxDealsTracker/1.0)", "Accept": "application/json" } };
}
// The matching game in the results: {mc, slug} (mc 0 when there's no Metascore), or null when no result matches
function mcFind_(q, items) {
  if (!items) return null;
  const nq = norm_(q), close = name => { const a = norm_(name); return a === nq || (a && nq && (a.indexOf(nq) === 0 || nq.indexOf(a) === 0)); };
  const best = items.find(x => norm_(x.title) === nq) || items.find(x => close(x.title));
  if (!best) return { mc: 0, slug: "" };
  const sc = best.criticScoreSummary ? best.criticScoreSummary.score : (best.metascore || best.metaScore);
  return { mc: sc > 0 ? Math.round(sc) : 0, slug: best.slug || slug_(best.title) };
}

function fillScores() {
  const start = Date.now(), today = Number(Utilities.formatDate(new Date(), "UTC", "yyyyMMdd"));
  const old = d => Number(Utilities.formatDate(new Date(Date.now() - d * 864e5), "UTC", "yyyyMMdd"));
  const store = psReadJson_("METACRITIC_FILE_ID", {});
  // [id, title] of each platform's games, most visible first: the home page, every game on sale (best selling
  // first), then the 1,000 most popular games of the full list (PlayStation's whole games carry their product id too)
  const games = pre => {
    const out = [], home = psReadJson_(pre + "HOME_FILE_ID", { sections: {} }), sales = psReadJson_(pre + "JSON_FILE_ID", { games: [] });
    const cat = psReadJson_(pre + "CATALOG_FILE_ID", { games: [] });
    Object.keys(home.sections || {}).forEach(k => Array.isArray(home.sections[k]) && home.sections[k].forEach(e => { if (e && e.id) { out.push([e.id, e.title]); if (e.pid) out.push([e.pid, e.title]); } }));
    (sales.games || []).slice().sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9)).forEach(g => out.push([g.productId, g.title]));
    (cat.games || []).slice(0, 1000).forEach(r => { out.push([r[0], r[1]]); if (r[13]) out.push([r[13], r[1]]); });
    return out.filter(x => x[0] && x[1]);
  };
  const plats = { "": games(""), "PS_": games("PS_") };

  // titles to look up: never seen, or seen long enough ago (games without a score are checked more often).
  // Xbox and PlayStation take turns, so both fill up at the same pace.
  const both = [], n = Math.max(plats[""].length, plats["PS_"].length);
  for (let i = 0; i < n; i++) { if (plats[""][i]) both.push(plats[""][i]); if (plats["PS_"][i]) both.push(plats["PS_"][i]); }
  const need = [], seen = {};
  both.forEach(([id, title]) => {
    const k = scoreKey_(title), s = store[k];
    if (!k || seen[k]) return;
    seen[k] = true;
    if (!s || s[2] < old(s[0] ? 30 : 14)) need.push([k, cleanTitle_(title)]);
  });
  let found = 0, sent = 0;
  const max = Math.min(SCORE_MAX, fetchBudget_(0));
  if (!max) console.log("Metacritic: today's request budget is used up, trying again next run");
  for (let i = 0; i < Math.min(need.length, max) && Date.now() - start < RUN_LIMIT_MS; i += 5) {
    if (i) Utilities.sleep(1000);
    const chunk = need.slice(i, Math.min(i + 5, max));
    let res = [];
    sent += chunk.length;
    try { res = UrlFetchApp.fetchAll(chunk.map(c => Object.assign({ url: mcUrl_(c[1]) }, mcOpts_()))); }
    catch (e) { Logger.log("Metacritic batch error: " + e.message); if (quotaHit_(e)) { console.log("Google's daily request limit reached, stopping"); break; } }
    chunk.forEach((c, j) => {
      let items = null;
      try { const d = JSON.parse(res[j].getContentText()); items = (d.data && d.data.items) || d.items || []; } catch (e) {}
      const f = mcFind_(c[1], items);
      if (f) { store[c[0]] = [f.mc, f.slug, today]; found++; }
    });
  }
  fetchBudget_(sent);
  saveJsonToDrive_(store, "metacritic.json", "METACRITIC_FILE_ID");

  // one small map per platform: game id -> [score, slug]
  Object.keys(plats).forEach(pre => {
    const map = {};
    plats[pre].forEach(([id, title]) => { const s = store[scoreKey_(title)]; if (s && s[0] > 0) map[id] = [s[0], s[1]]; });
    saveJsonToDrive_(map, pre ? "ps_scores.json" : "scores.json", pre + "SCORES_FILE_ID");
    console.log((pre ? "PlayStation" : "Xbox") + " games with a Metascore: " + Object.keys(map).length);
  });
  console.log("Metacritic: " + found + " titles looked up, " + Math.max(0, need.length - found) + " still to go, " +
              Object.keys(store).length + " known");
}
