// Xbox add-ons (on sale: job "addons"; all: job "alladdons"). Run by run.js.
// ---------- Xbox add-ons on sale ----------
// The Xbox store's game list doesn't include add-ons, but it says which games have some (hasAddOns; the US export
// saves that list in xbox_addon_games.json). This looks up each of those games' add-ons on sale with the store's own
// add-on search (the one xbox.com uses, filtered to "On sale") and keeps them in xbox_addons.json, which the
// Add-ons on sale page reads (doGet &file=addons) and the game pages use (GamePages.gs matches each add-on to its game).
//
// There are about 5,000 games with add-ons, too many for one run: each run asks about the XADDON_TOP best-known
// games, then the next ones in turn, up to XADDON_QUERIES searches, so every game is looked up every few days.
// Run exportXboxAddOns once by hand, then createXboxAddOnsTrigger once.

const XADDON_QUERIES = 4500;   // searches per run (within the daily budget, see fetchBudget_)
const XADDON_TOP = 400;        // the best-known games with add-ons, looked up on every run
const XADDON_PAGES = 4;        // pages of 25 add-ons per game at most
const XADDON_KEEP_DAYS = 6;    // an add-on not seen again for this long (and with no sale end date) is dropped

function createXboxAddOnsTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === "exportXboxAddOns").forEach(t => ScriptApp.deleteTrigger(t));
  // after the Xbox exports and before the game pages (6 AM and 7 PM Pacific)
  ScriptApp.newTrigger("exportXboxAddOns").timeBased().everyDays(1).atHour(5).inTimezone("America/Los_Angeles").create();
  ScriptApp.newTrigger("exportXboxAddOns").timeBased().everyDays(1).atHour(18).inTimezone("America/Los_Angeles").create();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === "exportXboxAllAddOns").forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("exportXboxAllAddOns").timeBased().everyDays(1).atHour(3).inTimezone("America/Los_Angeles").create();
  Logger.log("Xbox add-ons on sale will update every day around 5 AM and 6 PM Pacific; the full add-on list around 3 AM.");
}

// What an add-on is, from its title (the store only says "Durable" or "Consumable")
function xAddOnKind_(title, productKind) {
  const t = String(title || "");
  if (/season pass|expansion pass|year \d+ pass|battle pass/i.test(t)) return "Season Pass";
  if (/\bexpansion\b|\bepisode\b|\bchapter\b|\bcampaign\b/i.test(t)) return "Expansion";
  if (/soundtrack|\bost\b/i.test(t)) return "Soundtrack";
  if (/\b(coins?|points|credits|gold bars|gems|crystals|v-bucks|currency|shark card)\b/i.test(t) || productKind === "Consumable") return "Virtual Currency";
  if (/\b(costume|outfit|skins?|cosmetic|livery|liveries|attire|look)\b/i.test(t)) return "Costume";
  if (/\b(car|cars|vehicles?|tank|aircraft|plane|truck)\b/i.test(t)) return "Vehicle";
  if (/\b(weapons?|guns?|rifle|sword)\b/i.test(t)) return "Weapon";
  if (/\b(map|maps|track|tracks|circuit)\b/i.test(t)) return "Map";
  if (/\b(character|fighter|operator|hero)\b/i.test(t)) return "Character";
  return "Add-on";
}

// The text to search for: the game's name without its edition or platforms
function xAddOnQuery_(title) {
  return cleanTitle_(String(title || "").replace(/\b(for )?(xbox one|xbox series x\|s|xbox series x|windows( 10)?|pc)\b/gi, " "))
    .replace(/\s+/g, " ").replace(/[\s\-–:|]+$/, "").trim();
}

// "11/18/2026 09:59:59" (UTC) -> ISO time, or undefined
function xEndDate_(s) {
  const m = String(s || "").match(/^(\d+)\/(\d+)\/(\d{4}) (\d+):(\d+):(\d+)/);
  if (!m) return undefined;
  const t = Date.UTC(+m[3], m[1] - 1, +m[2], +m[4], +m[5], +m[6]);
  return t > Date.now() && t < Date.UTC(3000, 0, 1) ? new Date(t).toISOString() : undefined;
}

function xAddOnRequest_(query, ct, every) {
  const body = { Query: query, ChannelKeyToBeUsedInResponse: "X" };
  if (!every) body.Filters = Utilities.base64Encode(JSON.stringify({ Price: { id: "Price", choices: [{ id: "OnSale" }] } }));   // on sale only
  if (ct) body.EncodedCT = ct;
  return {
    url: "https://emerald.xboxservices.com/xboxcomfd/search/addons?locale=en-US",
    method: "post", contentType: "application/json", payload: JSON.stringify(body), muteHttpExceptions: true,
    headers: { "MS-CV": "test", "Accept": "application/json", "x-ms-api-version": "1.1" }
  };
}

// One search per game name (editions of a game share one), the best-known games first: [{q, rank}]
function xAddOnQueries_() {
  const games = (psReadJson_("XADDONGAMES_FILE_ID", { games: [] }).games || []).filter(r => r[0] && r[1]);
  games.sort((a, b) => (b[2] || 0) - (a[2] || 0));
  const queries = [], seen = Object.create(null);
  games.forEach((r, i) => {
    const q = xAddOnQuery_(r[1]);
    if (q.length < 2 || seen[q.toLowerCase()]) return;
    seen[q.toLowerCase()] = 1;
    queries.push({ q: q, rank: i + 1 });
  });
  return queries;
}

function exportXboxAddOns() {
  const t0 = Date.now();
  const props = PropertiesService.getScriptProperties();
  const queries = xAddOnQueries_();
  if (!queries.length) { Logger.log("No list of games with add-ons yet: run exportXboxCatalog first."); return; }
  const allow = Math.min(XADDON_QUERIES, fetchBudget_(0));
  if (allow < 50) { Logger.log("Today's request budget is used up; the add-ons update on the next run."); return; }
  const top = queries.slice(0, Math.min(XADDON_TOP, allow)), rest = queries.slice(top.length);
  let cursor = Number(props.getProperty("XADDON_CURSOR")) || 0;
  if (cursor >= rest.length) cursor = 0;
  const turn = [];
  for (let k = 0; k < Math.min(allow - top.length, rest.length); k++) turn.push(rest[(cursor + k) % rest.length]);
  const todo = top.concat(turn);

  // search, 25 at a time; a game with more add-ons on sale gets its next pages in a later batch
  const found = {}, done = {};
  let sent = 0, next = 0, asked = 0;
  let pending = [];   // [query, continuation token, page]
  while ((next < todo.length || pending.length) && Date.now() - t0 < 4.5 * 60 * 1000) {
    const batch = pending.splice(0, 25);
    while (batch.length < 25 && next < todo.length) batch.push([todo[next++], null, 1]);
    let res = [];
    try { res = UrlFetchApp.fetchAll(batch.map(b => xAddOnRequest_(b[0].q, b[1]))); }
    catch (e) { if (quotaHit_(e)) break; Logger.log("Add-on search failed: " + e.message); }
    sent += batch.length;
    batch.forEach((b, i) => {
      const r = res[i];
      let d = null;
      try { if (r && r.getResponseCode() === 200) d = JSON.parse(r.getContentText()); } catch (e) {}
      if (!d) return;
      if (b[2] === 1) asked++;
      (d.productSummaries || []).forEach(p => {
        const buy = p.specificPrices && p.specificPrices.purchaseable && p.specificPrices.purchaseable[0];
        const price = Number(buy && buy.listPrice) || 0, msrp = Number(buy && buy.msrp) || 0;
        if (!p.productId || !buy || !(msrp > price)) return;
        // the search is loose ("minecraft" also finds PAYDAY 2 packs): an add-on takes the rank of a game its title starts with
        const rank = addOnName_(p.title).indexOf(addOnName_(b[0].q)) === 0 ? b[0].rank : 1e5 + b[0].rank;
        const old = found[p.productId];
        if (old && old.rank <= rank) return;
        found[p.productId] = {
          productId: p.productId, title: p.title || "", publisher: p.publisherName || "", kind: xAddOnKind_(p.title, p.productKind),
          price: price, msrp: msrp, discountPercent: Number(buy.discountPercentage) || 0, currency: buy.currency || "USD",
          image: pickImage_(p), sq: shortImg_(pickSquare_(p)), saleEnds: xEndDate_(buy.endDateUtc),
          rank: rank, q: b[0].q.toLowerCase(), seen: Date.now()
        };
      });
      const ch = d.channels && d.channels.X, ct = ch && ch.encodedCT;
      if (ct && (d.productSummaries || []).length && b[2] < XADDON_PAGES && ch.totalItems > b[2] * 25) pending.push([b[0], ct, b[2] + 1]);
      else done[b[0].q.toLowerCase()] = 1;   // every add-on on sale for this search was seen
    });
  }
  fetchBudget_(sent);
  props.setProperty("XADDON_CURSOR", String(rest.length ? (cursor + Math.max(0, next - top.length)) % rest.length : 0));

  // keep what earlier runs found unless its sale ended, or its game was searched again and it wasn't there
  const prev = (psReadJson_("XADDONS_FILE_ID", { games: [] }).games || []);
  let kept = 0;
  prev.forEach(g => {
    if (!g.productId || found[g.productId] || done[g.q]) return;
    const ends = Date.parse(g.saleEnds);
    if (ends ? ends <= Date.now() : Date.now() - (g.seen || 0) > XADDON_KEEP_DAYS * 864e5) return;
    found[g.productId] = g;
    kept++;
  });
  // the Xbox and Windows listings of the same add-on ("… Cosmetic Pack - Windows 10") once
  const same = Object.create(null);
  const list = Object.keys(found).map(id => found[id]).sort((a, b) => a.rank - b.rank || b.discountPercent - a.discountPercent)
    .sort((a, b) => /windows/i.test(a.title) - /windows/i.test(b.title))
    .filter(g => {
      const k = addOnName_(g.title.replace(/[\s\-–:(]*(windows( 10)?|pc|xbox one|xbox series x\|s)\)?\s*$/i, "")) + "|" + g.price;
      return same[k] ? false : (same[k] = 1);
    })
    .sort((a, b) => a.rank - b.rank || b.discountPercent - a.discountPercent);
  if (!list.length && prev.length) { Logger.log("No add-ons found this time; keeping the previous file."); return; }
  saveJsonToDrive_({ updatedAt: new Date().toISOString(), count: list.length, games: list }, "xbox_addons.json", "XADDONS_FILE_ID");
  Logger.log("Xbox add-ons on sale: " + list.length + " (" + kept + " from earlier runs). Searched " + asked + " of " + queries.length +
             " games with add-ons, " + sent + " requests, " + Math.round((Date.now() - t0) / 1000) + " s.");
}

// ---------- Every Xbox add-on (on sale or not) ----------
// The same search without the "On sale" filter, for the "add-ons" section of each game page. Add-ons rarely change,
// so each run goes through the next games in turn (XALL_REQUESTS requests), and every game is looked up about once
// every week or two. Only results whose title starts with the game's name are kept (the search is loose).
// Saved in xbox_addons_all.json: {a: {product id: [title, square art, regular price, kind, last seen (ms), game rank, store order]}}.
// Their sale prices come from exportXboxAddOns, which runs more often.
const XALL_REQUESTS = 1500;    // requests per run (within the daily budget, see fetchBudget_)
const XALL_PAGES = 20;         // pages of 25 per game at most
const XALL_KEEP_DAYS = 30;     // an add-on not seen again for this long is dropped (taken off the store)

function exportXboxAllAddOns() {
  const t0 = Date.now();
  const props = PropertiesService.getScriptProperties();
  const queries = xAddOnQueries_();
  if (!queries.length) { Logger.log("No list of games with add-ons yet: run exportXboxCatalog first."); return; }
  const allow = Math.min(XALL_REQUESTS, fetchBudget_(0));
  if (allow < 50) { Logger.log("Today's request budget is used up; the add-on list updates on the next run."); return; }
  let cursor = Number(props.getProperty("XALL_CURSOR")) || 0;
  if (cursor >= queries.length) cursor = 0;
  const all = psReadJson_("XADDONS_ALL_FILE_ID", { a: {} }).a || {};
  const now = Date.now();

  let sent = 0, started = 0, added = 0;
  const pending = [];   // [query, continuation token, page, pages in a row without a match]
  while (sent < allow && (pending.length || started < queries.length) && Date.now() - t0 < 4.5 * 60 * 1000) {
    const batch = pending.splice(0, Math.min(25, allow - sent));
    while (batch.length < Math.min(25, allow - sent) && started < queries.length) batch.push([queries[(cursor + started++) % queries.length], null, 1, 0]);
    let res = [];
    try { res = UrlFetchApp.fetchAll(batch.map(b => xAddOnRequest_(b[0].q, b[1], true))); }
    catch (e) { if (quotaHit_(e)) break; Logger.log("Add-on search failed: " + e.message); }
    sent += batch.length;
    batch.forEach((b, i) => {
      let d = null;
      try { if (res[i] && res[i].getResponseCode() === 200) d = JSON.parse(res[i].getContentText()); } catch (e) {}
      if (!d) return;
      const name = addOnName_(b[0].q) + " ";
      let hits = 0;
      (d.productSummaries || []).forEach((p, k) => {
        if (!p.productId || (addOnName_(p.title) + " ").indexOf(name) !== 0 || addOnName_(p.title) === name.trim()) return;
        const buy = p.specificPrices && p.specificPrices.purchaseable && p.specificPrices.purchaseable[0];
        if (!buy) return;
        hits++;
        if (!all[p.productId]) added++;
        const old = all[p.productId];
        all[p.productId] = [p.title, shortImg_(pickSquare_(p) || pickImage_(p)) || "", Number(buy.msrp) || Number(buy.listPrice) || 0,
          xAddOnKind_(p.title, p.productKind), now, Math.min(b[0].rank, old ? old[5] : Infinity), (b[2] - 1) * 25 + k];
      });
      const ch = d.channels && d.channels.X, ct = ch && ch.encodedCT, miss = hits ? 0 : b[3] + 1;
      // the search puts the game's own add-ons first: stop after two pages without any
      if (ct && (d.productSummaries || []).length && b[2] < XALL_PAGES && miss < 2 && ch.totalItems > b[2] * 25) pending.push([b[0], ct, b[2] + 1, miss]);
    });
  }
  fetchBudget_(sent);
  props.setProperty("XALL_CURSOR", String((cursor + started) % queries.length));
  let dropped = 0;
  Object.keys(all).forEach(id => { if (now - all[id][4] > XALL_KEEP_DAYS * 864e5) { delete all[id]; dropped++; } });
  saveJsonToDrive_({ updatedAt: new Date().toISOString(), count: Object.keys(all).length, a: all }, "xbox_addons_all.json", "XADDONS_ALL_FILE_ID");
  Logger.log("Xbox add-ons (all): " + Object.keys(all).length + " (" + added + " new, " + dropped + " dropped). Looked up " + started + " of " +
             queries.length + " games, " + sent + " requests, " + Math.round((Date.now() - t0) / 1000) + " s.");
}

// ---------- Which game (and which editions) each Xbox add-on belongs to ----------
// The store's own product data says it: an add-on's related products include its game ("Parent") and the editions
// (bundles) that already include it ("Bundle"). Matching by name can't tell editions apart ("GTA VI Ultimate Edition
// Upgrade" starts with "GTA VI Ultimate Edition", but it's for the Standard Edition), so the game pages use this first.
// Saved in xbox_addon_rel.json: {r: {add-on id: [game id or "", [edition ids that include it], checked (ms), XREL_V]}}.
// New add-ons are looked up on every run; known ones again after XREL_RECHECK_DAYS, XREL_MAX per run.
// The store calls the game "addOnParent". Without it, an old game's add-ons went to a newer game with a shorter name
// (Fable Anniversary's 2014 packs, "Fable Hero's Weapons…", were listed on the 2026 Fable).
// XREL_V: entries read before that are looked up again first, not after XREL_RECHECK_DAYS.
const XREL_MAX = 4000, XREL_RECHECK_DAYS = 30, XREL_V = 2;
const XREL_PARENT = /^(addonparent|parent|parentproduct|prerequisite|requiredproduct|basegame)$/i;
function xAddOnRelations_() {
  const t0 = Date.now(), file = psReadJson_("XADDON_REL_FILE_ID", { r: {} }), rel = file.r || {};
  const ids = Object.keys(psReadJson_("XADDONS_ALL_FILE_ID", { a: {} }).a || {})
    .concat((psReadJson_("XADDONS_FILE_ID", { games: [] }).games || []).map(g => g.productId)).filter(Boolean)
    .map(id => String(id).toUpperCase()).filter((id, i, a) => a.indexOf(id) === i);
  const fresh = id => rel[id] && rel[id][3] === XREL_V;
  const due = ids.filter(id => !fresh(id) || Date.now() - rel[id][2] > XREL_RECHECK_DAYS * 864e5)
    .sort((a, b) => (fresh(a) ? 1 : 0) - (fresh(b) ? 1 : 0)).slice(0, XREL_MAX);
  let found = 0, kinds = {};
  for (let i = 0; i < due.length && Date.now() - t0 < 8 * 60 * 1000; i += 160) {
    const chunks = [];
    for (let k = i; k < Math.min(i + 160, due.length); k += 20) chunks.push(due.slice(k, k + 20));
    let res = [];
    try {
      res = UrlFetchApp.fetchAll(chunks.map(c => ({ url: "https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=" + c.join(",") +
        "&market=US&languages=en-US&MS-CV=DGU1mcuYo0WMMp%2BF.1", muteHttpExceptions: true })));
    } catch (e) { if (quotaHit_(e)) break; Logger.log("Add-on relations lookup failed: " + e.message); continue; }
    res.forEach((r, n) => {
      let d = null;
      try { if (r && r.getResponseCode() === 200) d = JSON.parse(r.getContentText()); } catch (e) {}
      if (!d) return;
      const seen = Object.create(null);
      (d.Products || []).forEach(p => {
        const id = String(p.ProductId || "").toUpperCase();
        const list = (p.MarketProperties && p.MarketProperties[0] && p.MarketProperties[0].RelatedProducts) || [];
        list.forEach(x => { kinds[x.RelationshipType] = (kinds[x.RelationshipType] || 0) + 1; });
        const parent = list.find(x => XREL_PARENT.test(String(x.RelationshipType || "")));
        const bundles = list.filter(x => /^bundle$/i.test(String(x.RelationshipType || ""))).map(x => String(x.RelatedProductId).toUpperCase());
        rel[id] = [parent ? String(parent.RelatedProductId).toUpperCase() : "", bundles, Date.now(), XREL_V];
        seen[id] = 1;
        if (parent) found++;
      });
      chunks[n].forEach(id => { if (!seen[id]) rel[id] = ["", [], Date.now(), XREL_V]; });   // not in the catalog (any more)
    });
  }
  Object.keys(rel).forEach(id => { if (ids.indexOf(id) < 0 && Date.now() - rel[id][2] > 90 * 864e5) delete rel[id]; });
  saveJsonToDrive_({ updatedAt: new Date().toISOString(), r: rel }, "xbox_addon_rel.json", "XADDON_REL_FILE_ID");
  Logger.log("Add-on relations: looked up " + due.length + " of " + ids.length + " add-ons, " + found + " with their game. Relationship types seen: " +
    Object.keys(kinds).map(k => k + " " + kinds[k]).join(", "));
}

// ---------- Xbox publisher ids ----------
// The store's game list only gives a publisher's name, and spells some several ways; its product data also gives the
// publisher's id (Properties.PublisherId). Every game's is kept in xbox_pubids.json: {p: {product id: [publisher id, publisher
// name, checked (ms)]}}; new games are looked up on every run, known ones again after XPUB_RECHECK_DAYS, XPUB_MAX per run.
// The game pages carry it (pb) and the lists job groups publishers by it.
// Also each game's developer (the studio: DeveloperName), for the lists' "Upcoming games from acclaimed studios"
// (jobs/lists.js). xbox_pubids.json {p: {id: [publisher id, publisher name, checked ms, developer name]}}.
const XPUB_MAX = 20000, XPUB_RECHECK_DAYS = 45;
function xPublisherIds_() {
  const t0 = Date.now(), file = psReadJson_("XPUBIDS_FILE_ID", { p: {} }), known = file.p || {};
  const ids = (psReadJson_("CATALOG_FILE_ID", { games: [] }).games || []).map(r => String(r[0] || "").toUpperCase()).filter(Boolean);
  const due = ids.filter(id => !known[id] || known[id][3] === undefined || Date.now() - known[id][2] > XPUB_RECHECK_DAYS * 864e5)   // (older entries: no developer yet)
    .sort((a, b) => (known[a] ? 1 : 0) - (known[b] ? 1 : 0)).slice(0, XPUB_MAX);
  let withId = 0, asked = 0;
  for (let i = 0; i < due.length && Date.now() - t0 < 10 * 60 * 1000; i += 160) {
    const chunks = [];
    for (let k = i; k < Math.min(i + 160, due.length); k += 20) chunks.push(due.slice(k, k + 20));
    let res = [];
    try {
      res = UrlFetchApp.fetchAll(chunks.map(c => ({ url: "https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=" + c.join(",") +
        "&market=US&languages=en-US&MS-CV=DGU1mcuYo0WMMp%2BF.1", muteHttpExceptions: true })));
    } catch (e) { if (quotaHit_(e)) break; Logger.log("Publisher id lookup failed: " + e.message); continue; }
    asked += chunks.length;
    res.forEach(r => {
      let d = null;
      try { if (r && r.getResponseCode() === 200) d = JSON.parse(r.getContentText()); } catch (e) {}
      ((d && d.Products) || []).forEach(p => {
        const id = String(p.ProductId || "").toUpperCase(), pr = p.Properties || {}, lp = (p.LocalizedProperties && p.LocalizedProperties[0]) || {};
        const pub = String(pr.PublisherId || pr.PublisherID || "").trim();
        known[id] = [pub, lp.PublisherName || "", Date.now(), String(lp.DeveloperName || "").trim()];
        if (pub) withId++;
      });
    });
  }
  saveJsonToDrive_({ updatedAt: new Date().toISOString(), p: known }, "xbox_pubids.json", "XPUBIDS_FILE_ID");
  Logger.log("Publisher ids: looked up " + due.length + " games (" + asked + " requests), " + withId + " with an id; " + Object.keys(known).length + " known in all");
}

// ---------- What each Xbox edition (bundle) includes ----------
// A bundle's product data lists the products it's made of (its SKU's BundledSkus: the game, add-ons, season pass...).
// Looked up for every game in the full list whose name says it's an edition or bundle, and every edition the add-on
// relations name as including an add-on; again after XBUN_RECHECK_DAYS, XBUN_MAX per run. Saved in xbox_bundles.json:
// {b: {bundle id: [[item ids], checked (ms)]}, n: {item id: [title, product type, square art]}} (names of the items, looked
// up too when they're not known). The game pages show it (g.inc: "What's included"; g.inb: "Included in").
const XBUN_MAX = 3000, XBUN_RECHECK_DAYS = 20;
const XBUN_NAME = /\b(edition|bundle|collection|vault|trilogy|anthology|double pack|triple pack|complete|ultimate|deluxe|premium|gold|definitive|goty|game of the year)\b/i;
function xDcFetch_(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 160) {
    const chunks = [];
    for (let k = i; k < Math.min(i + 160, ids.length); k += 20) chunks.push(ids.slice(k, k + 20));
    let res = [];
    try {
      res = UrlFetchApp.fetchAll(chunks.map(c => ({ url: "https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=" + c.join(",") +
        "&market=US&languages=en-US&MS-CV=DGU1mcuYo0WMMp%2BF.1", muteHttpExceptions: true })));
    } catch (e) { if (quotaHit_(e)) break; Logger.log("Bundle lookup failed: " + e.message); continue; }
    res.forEach((r, n) => {
      let d = null;
      try { if (r && r.getResponseCode() === 200) d = JSON.parse(r.getContentText()); } catch (e) {}
      out.push([chunks[n], d ? d.Products || [] : null]);
    });
  }
  return out;
}
function xBundleContents_() {
  const t0 = Date.now(), file = psReadJson_("XBUNDLES_FILE_ID", { b: {}, n: {} }), b = file.b || {}, names = file.n || {};
  const cat = psReadJson_("CATALOG_FILE_ID", { games: [] }).games || [];
  const rel = psReadJson_("XADDON_REL_FILE_ID", { r: {} }).r || {};
  const ids = cat.filter(r => r[0] && XBUN_NAME.test(String(r[1] || ""))).map(r => String(r[0]).toUpperCase());
  Object.keys(rel).forEach(k => (rel[k][1] || []).forEach(x => ids.push(String(x).toUpperCase())));
  const uniq = Array.from(new Set(ids));
  const due = uniq.filter(id => !b[id] || Date.now() - b[id][1] > XBUN_RECHECK_DAYS * 864e5).sort((x, y) => (b[x] ? 1 : 0) - (b[y] ? 1 : 0)).slice(0, XBUN_MAX);
  const nameOf = p => {
    const lp = (p.LocalizedProperties && p.LocalizedProperties[0]) || {}, imgs = lp.Images || [];
    const sq = imgs.find(x => x.ImagePurpose === "BoxArt") || imgs.find(x => x.ImagePurpose === "Poster");
    return [lp.ProductTitle || "", p.ProductType || "", sq && sq.Uri ? shortImg_(sq.Uri.startsWith("//") ? "https:" + sq.Uri : sq.Uri) : ""];
  };
  let withItems = 0;
  xDcFetch_(due).forEach(([chunk, products]) => {
    if (!products) return;
    const seen = Object.create(null);
    products.forEach(p => {
      const id = String(p.ProductId || "").toUpperCase();
      seen[id] = 1;
      names[id] = nameOf(p);
      const items = [];
      (p.DisplaySkuAvailabilities || []).slice(0, 1).forEach(sa => {
        const sp = (sa.Sku && sa.Sku.Properties) || {};
        (sp.BundledSkus || []).forEach(x => { const bid = String(x.BigId || x.bigId || "").toUpperCase(); if (bid && bid !== id && items.indexOf(bid) < 0) items.push(bid); });
      });
      if (!items.length) ((p.MarketProperties && p.MarketProperties[0] && p.MarketProperties[0].RelatedProducts) || [])
        .filter(x => /^(bundlecomponent|component|contains|bundleditem)$/i.test(String(x.RelationshipType || "")))
        .forEach(x => { const bid = String(x.RelatedProductId || "").toUpperCase(); if (bid && items.indexOf(bid) < 0) items.push(bid); });
      b[id] = [items, Date.now()];
      if (items.length) withItems++;
    });
    chunk.forEach(id => { if (!seen[id]) b[id] = [[], Date.now()]; });
  });
  // the items' names
  const unknown = Array.from(new Set([].concat(...Object.keys(b).map(k => b[k][0])))).filter(id => !names[id]).slice(0, 4000);
  xDcFetch_(unknown).forEach(([chunk, products]) => (products || []).forEach(p => { names[String(p.ProductId || "").toUpperCase()] = nameOf(p); }));
  // names no bundle needs any more
  const used = {};
  Object.keys(b).forEach(k => { used[k] = 1; b[k][0].forEach(x => { used[x] = 1; }); });
  Object.keys(names).forEach(k => { if (!used[k]) delete names[k]; });
  saveJsonToDrive_({ updatedAt: new Date().toISOString(), b: b, n: names }, "xbox_bundles.json", "XBUNDLES_FILE_ID");
  Logger.log("Bundles: looked up " + due.length + " of " + uniq.length + " editions, " + withItems + " with their contents; " +
    unknown.length + " item names looked up (" + Math.round((Date.now() - t0) / 1000) + " s)");
}
