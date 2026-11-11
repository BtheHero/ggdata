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

const XADDON_QUERIES = 1000;   // searches per run (within the daily budget, see fetchBudget_)
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
  const queries = [], seen = {};
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
  const same = {};
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
