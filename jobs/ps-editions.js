// PlayStation regional prices, edition by edition (run.js jobs "ps" and "psregions").
//
// Every game page and deal of the site is a US product: a deal is its own product, a game page (a concept of the full
// game list) is the edition its US price is for (ps_catalog.json column 17, else its main product, column 13). In another
// region the page shows that same edition's price in that region's store, never the US price converted; when that store
// doesn't sell it, the region's price file lists it in na and the site says "Not sold in this region".
//
// Which product is the same edition: product ids differ per region (UP9000-CUSA07820_00-THELASTOFUSPART2 in the US,
// EP9000-CUSA10249_00-THELASTOFUSPART2 in the UK, JP9000-CUSA13986_00-THELASTOFUS2STND in Japan), concept ids
// (the game) mostly don't. So each game's editions are looked up in every store (metGetPricingDataByConceptId: every
// edition sold there, with its kind, platforms, name and price) and paired (psMatchEditions_): the same product id or
// store code, else the same kind (FULL_GAME, PREMIUM_EDITION…) for the same platforms, by name, else the only one of
// them, else by regular price order. A PS4 game and its PS5 version are different editions (The Last of Us Part II and
// The Last of Us Part II Remastered are sold on one page): the PS4 game's page never gets the remaster's price.
// Add-ons aren't listed with their game's editions: their product id in another store is the game's there with the
// add-on's own code (UP1018-PPSA01617_00-MK1100KOMBATPACK -> EP1018-PPSA01619_00-MK1100KOMBATPACK), looked up on its own.
//
// Kept in data/psed/<code>.json (US: the US editions, the same way), a part at a time (lookups every run, the most in
// the "psregions" job):
//   c:  {US concept id: [checked ms, [[product id, name key, kind, platforms, regular price, price, sale end ms], ...]
//        or null (not sold there), the store's own concept id when it's another]}
//   a:  {US add-on product id: [checked ms, product id there or null, price, regular price, sale end ms]}
//   pc: (US) {product id: concept id} of the deals whose game the other files don't say
//   names: {name key: concept id} of the store's games (its full game list, read by the daily run), for the games it
//        sells under another concept id
// Each run then rewrites the region's prices (psResolveRegion_): the store's own lists give the current sale prices
// (exportPsRegion_), the editions above say which product each US game and deal is there.
const fs = require("fs"), path = require("path");
const PSE_RECHECK_DAYS = 7, PSE_GAME = /^(FULL_GAME|GAME_BUNDLE|PREMIUM_EDITION|BUNDLE)$/;
const X = () => global.__XBOX;   // names of the Apps Script files that aren't global (run.js)
const dir = () => path.join(require("../runtime/appsscript").DATA_DIR, "psed");
const readData = f => { try { return JSON.parse(fs.readFileSync(path.join(require("../runtime/appsscript").DATA_DIR, f), "utf8")); } catch (e) { return null; } };
function load(code) {
  let d = null;
  try { d = JSON.parse(fs.readFileSync(path.join(dir(), code + ".json"), "utf8")); } catch (e) {}
  d = d || {};
  d.c = d.c || {}; d.a = d.a || {}; d.pc = d.pc || {}; d.names = d.names || {};
  return d;
}
function save(code, d) {
  fs.mkdirSync(dir(), { recursive: true });
  d.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir(), code + ".json"), JSON.stringify(d));
}
const localeOf = code => code === "US" ? "en-US" : psQueryLocale_(code);
// an edition's name as a key: "The Last of Us™ Part II" -> "thelastofuspartii" (the words some stores add at the end
// left out, psLooseKey_; names in other scripts give "")
const edKey = name => { const k = norm_(psName_(name)); return k.replace(X().PS_LOOSE, "") || k; };
const platsOf = p => (p || []).slice().sort().join("+");
const overlap = (a, b) => String(a).split("+").some(x => x && String(b).split("+").indexOf(x) >= 0);
const parseId = id => { const m = String(id || "").match(/^([A-Z]{2}\d{4})-([A-Z]{4}\d{5}_\d\d)-([A-Z0-9]+)$/); return m ? { prefix: m[1], title: m[2], label: m[3] } : null; };

// ---------- matching ----------
// us, here: [[product id, name key, kind, platforms, regular price, ...]]. Returns Map {US product id: edition here}.
function psMatchEditions_(us, here) {
  const m = new Map(), used = new Set();
  const take = (u, h) => { m.set(u[0], h); used.add(h); };
  const free = () => here.filter(h => !used.has(h));
  // the same product (the stores of the Americas share most); the same name for the same kind and platforms, when
  // each store has one of that name; then the same store code (label and PS4/PS5: stores can give one edition's code
  // to another, God of War's Digital Deluxe Edition in the UK has the US game's)
  us.forEach(u => { const h = here.find(x => !used.has(x) && x[0] === u[0]); if (h) take(u, h); });
  const sameEd = (a, b) => a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
  us.forEach(u => {
    if (m.has(u[0]) || !u[1] || us.filter(o => sameEd(o, u)).length !== 1) return;
    const hs = free().filter(h => sameEd(h, u));
    if (hs.length === 1) take(u, hs[0]);
  });
  us.forEach(u => {
    const c = !m.has(u[0]) && psCodeKey_(u[0]);
    if (!c) return;
    const hs = free().filter(h => psCodeKey_(h[0]) === c);
    if (hs.length === 1) take(u, hs[0]);
  });
  // the same kind for the same platforms: by name, else the only one each store has, else in regular price order
  // (names that can't be compared: other scripts)
  const groups = {};
  us.filter(u => !m.has(u[0])).forEach(u => { const g = u[2] + "|" + u[3]; (groups[g] = groups[g] || []).push(u); });
  Object.keys(groups).forEach(g => {
    const left = () => free().filter(h => h[2] + "|" + h[3] === g);
    groups[g].forEach(u => { if (!u[1]) return; const hs = left().filter(h => h[1] === u[1]); if (hs.length === 1) take(u, hs[0]); });
    const uu = groups[g].filter(u => !m.has(u[0])), hh = left();
    if (!uu.length || uu.length !== hh.length) return;
    if (uu.length > 1 && uu.concat(hh).every(x => x[1])) return;   // several, all named, none alike: not the same editions
    const byPrice = (a, b) => (a[4] || 0) - (b[4] || 0);
    uu.sort(byPrice); hh.sort(byPrice);
    uu.forEach((u, i) => take(u, hh[i]));
  });
  // the same name, sold as another kind of game ("… Full Game" sold as a bundle) or for other platforms (one product
  // for PS4 and PS5 here, one each there)
  us.filter(u => !m.has(u[0]) && u[1]).forEach(u => {
    const hs = free().filter(h => h[1] === u[1] && (h[2] === u[2] || (PSE_GAME.test(h[2]) && PSE_GAME.test(u[2]))) && overlap(h[3], u[3]));
    const same = hs.filter(h => h[3] === u[3]);
    if (hs.length === 1) take(u, hs[0]); else if (same.length === 1) take(u, same[0]);
  });
  return m;
}

// ---------- lookups ----------
// One store's answer for a game: its editions, null (not sold there), or undefined (no answer: asked again later)
function editionsOf_(res) {
  let j = null;
  try { if (res && res.getResponseCode() === 200) j = JSON.parse(res.getContentText()); } catch (e) {}
  if (!j || !j.data) return undefined;
  const c = j.data.conceptRetrieve;
  if (!c) return /not available|data_not_found/i.test(JSON.stringify(j.errors || "")) ? null : undefined;
  const eds = [];
  (((c.selectableProducts || {}).purchasableProducts) || []).forEach(p => {
    const pr = p && p.price;
    if (!p || !p.id || !pr) return;
    let base = psPrice_(pr.basePrice), price = psPrice_(pr.discountedPrice);
    if (base === null && price === null) return;
    if (price === null || pr.isTiedToSubscription || pr.isExclusive) price = base;   // ("Included" with PS Plus, member prices)
    if (base === null) base = price;
    eds.push([String(p.id), edKey(p.name), String(p.storeDisplayClassification || ""), platsOf(p.platforms), base, price, price < base ? Number(pr.endTime) || 0 : 0]);
  });
  return eds;
}
function lookupConcepts_(code, ids, until) {
  const out = {}, locale = localeOf(code);
  for (let i = 0; i < ids.length && Date.now() < until; i += 40) {
    const chunk = ids.slice(i, i + 40);
    let res = [];
    try { res = UrlFetchApp.fetchAll(chunk.map(id => psRequest_("metGetPricingDataByConceptId", { conceptId: String(id) }, locale))); }
    catch (e) { console.log("PlayStation " + code + " edition lookup failed: " + e.message); break; }
    chunk.forEach((id, k) => { const e = editionsOf_(res[k]); if (e !== undefined) out[id] = e; });
  }
  return out;
}
// A product's price in one store: {price, base, end}, null (not sold there), or undefined (no answer)
function productOf_(res, conceptOnly) {
  let j = null;
  try { if (res && res.getResponseCode() === 200) j = JSON.parse(res.getContentText()); } catch (e) {}
  if (!j || !j.data) return undefined;
  const p = j.data.productRetrieve;
  if (!p) return /not available|data_not_found/i.test(JSON.stringify(j.errors || "")) ? null : undefined;
  if (conceptOnly) return { concept: p.concept && p.concept.id ? String(p.concept.id) : "" };
  const ctas = (p.webctas || []).filter(c => c.price && (c.price.basePrice || c.price.discountedPrice));
  const member = c => /UPSELL|PS_PLUS/.test(c.type || "") || (c.price.serviceBranding || []).indexOf("PS_PLUS") >= 0 || c.price.isTiedToSubscription || c.price.isExclusive;
  const pr = (ctas.filter(c => !member(c))[0] || ctas[0] || {}).price;
  if (!pr) return null;   // shown, but not sold
  let base = psPrice_(pr.basePrice), price = member({ price: pr }) ? base : psPrice_(pr.discountedPrice);
  if (price === null) price = base;
  if (base === null) base = price;
  return price === null ? null : { price, base, end: price < base ? Number(pr.endTime) || 0 : 0 };
}
function lookupProducts_(code, ids, until, operation) {
  const out = {}, locale = localeOf(code);
  for (let i = 0; i < ids.length && Date.now() < until; i += 40) {
    const chunk = ids.slice(i, i + 40);
    let res = [];
    try { res = UrlFetchApp.fetchAll(chunk.map(id => psRequest_(operation || "productRetrieveForCtasWithPrice", { productId: id }, locale))); }
    catch (e) { console.log("PlayStation " + code + " product lookup failed: " + e.message); break; }
    chunk.forEach((id, k) => { const p = productOf_(res[k], !!operation); if (p !== undefined) out[id] = p; });
  }
  return out;
}

// ---------- what the US side has ----------
// The US games and deals, each with its game (concept): {cat: [[concept, priced product, title, rank]], deals: [{key,
// pid, con, title, kind, plats, game}], cons: concepts to look up (deals first)}
function usSide_() {
  const sales = (readData("ps_sales.json") || {}).games || [], cat = (readData("ps_catalog.json") || {}).games || [];
  const details = (psReadJson_("PS_CACHE_FILE_ID", { details: {} }).details) || {}, us = load("US");
  const conOfPid = {};
  cat.forEach(r => { if (r[0]) [r[17], r[13]].concat(r[16] ? String(r[16]).split(",") : []).forEach(p => { if (p && !conOfPid[p]) conOfPid[p] = String(r[0]); }); });
  const deals = sales.filter(g => g.key && g.productId).sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9)).map(g => {
    const d = details[g.productId], key = String(g.key), k = key.split("|");
    const kind = /^t:/.test(key) && k.length >= 3 ? k[1] : String(g.kind || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
    return { key, pid: String(g.productId), con: (d && d.con && String(d.con)) || conOfPid[g.productId] || us.pc[g.productId] || "",
             title: g.title || "", kind, plats: platsOf(g.platforms), game: PSE_GAME.test(kind) || X().psIsGame_(g.kind) };
  });
  // [concept, priced product, title, rank, price, regular price, main product, priced product given (column 17)]
  const rows = cat.filter(r => r[0]).map(r => [String(r[0]), String(r[17] || r[13] || ""), String(r[1] || ""), Number(r[7]) || 1e9, Number(r[3]), Number(r[4]), String(r[13] || ""), !!r[17]]);
  const cons = Array.from(new Set(deals.map(g => g.con).filter(Boolean).concat(rows.map(r => r[0]))));
  return { deals, rows, cons, us };
}

// ---------- the lookups of one store ----------
// opts: {until: ms, max: lookups, grid: {concept id: [regular price, [product ids]]} (the store's own full game list, to
// see which games changed)}
function psEditionLookups(code, opts) {
  const t0 = Date.now(), until = Math.min(opts.until || Infinity, Date.now() + 3 * 36e5), max = opts.max || 1e9, now = Date.now();
  const side = usSide_(), d = load(code), grid = opts.grid || null;
  if (opts.names) d.names = opts.names;
  // what to ask: games never asked first (the US deals' first), then those the store's own list shows changed, then
  // the oldest answers
  const old = x => now - x[0] > PSE_RECHECK_DAYS * 864e5;
  const changed = id => {
    const x = d.c[id], g = grid && grid[id];
    if (!x || !g || now - x[0] < 864e5) return false;   // (asked today: products it lists that aren't for sale stay)
    if (!x[1]) return true;   // listed now
    const ids = new Set(x[1].map(e => e[0]));
    return g[1].some(p => !ids.has(p)) || (g[0] !== null && !x[1].some(e => e[4] === g[0]));
  };
  const prio = id => !d.c[id] ? 0 : changed(id) ? 1 : old(d.c[id]) ? 2 : 9;
  const order = side.cons.map((id, i) => [id, prio(id), i]).filter(x => x[1] < 9)
    .sort((a, b) => a[1] - b[1] || (a[1] === 2 ? d.c[a[0]][0] - d.c[b[0]][0] : a[2] - b[2])).slice(0, max).map(x => x[0]);
  const got = lookupConcepts_(code, order, until);
  let sold = 0, none = 0;
  Object.keys(got).forEach(id => { d.c[id] = [now, got[id]]; if (got[id]) sold++; else none++; });
  // a game this store sells under another concept id (older games: Call of Duty: Modern Warfare Remastered): by name
  if (code !== "US") {
    const title = {};
    side.rows.forEach(r => { title[r[0]] = r[2]; });
    side.deals.forEach(g => { if (g.con && !title[g.con]) title[g.con] = g.title; });
    const other = {};
    Object.keys(got).forEach(id => { if (got[id] !== null) return; const k = d.names[norm_(cleanTitle_(String(title[id] || "").replace(/\s*\(PS4\)\s*$/, "")))]; if (k && k !== id) other[id] = k; });
    const ids = Object.keys(other);
    if (ids.length) {
      const res = lookupConcepts_(code, ids.map(id => other[id]), until);
      ids.forEach(id => { const e = res[other[id]]; if (e) d.c[id] = [now, e, other[id]]; });
    }
  }
  // US: the game of each deal the other files don't say (mostly add-ons), from the product itself
  if (code === "US") {
    const need = side.deals.filter(g => !g.con && !d.pc[g.pid]).map(g => g.pid).slice(0, Math.max(0, max - order.length));
    const res = lookupProducts_("US", need, until, "metGetProductById");
    Object.keys(res).forEach(id => { if (res[id] && res[id].concept) d.pc[id] = res[id].concept; });
    const live = new Set(side.deals.map(g => g.pid));
    Object.keys(d.pc).forEach(id => { if (!live.has(id)) delete d.pc[id]; });
  }
  // add-ons on sale in the US: the same add-on here, its id made from the game's id here
  let addOns = 0;
  if (code !== "US") {
    const usEd = load("US").c, want = [];
    side.deals.forEach(g => {
      if (g.game || !g.con || !psCodeKey_(g.pid)) return;
      const a = d.a[g.pid], x = d.c[g.con];
      if (a && !old(a)) return;
      if (!x) return;   // the game's editions here aren't known yet
      if (!x[1]) { d.a[g.pid] = [now, null]; return; }   // nor sold here
      const m = psMatchEditions_((usEd[g.con] && usEd[g.con][1]) || [], x[1]), u = parseId(g.pid), titles = [];
      let same = false;   // the game's editions have the same store codes in both stores: its add-ons' too
      m.forEach((h, uid) => { const a1 = parseId(uid), b = parseId(h[0]); if (a1 && b) { titles.push([a1.title, b.prefix + "-" + b.title]); if (a1.label === b.label) same = true; } });
      const ids = [].concat(titles.filter(t => t[0] === u.title), titles.filter(t => t[1].slice(7, 11) === u.title.slice(0, 4)), titles)
        .map(t => t[1] + "-" + u.label).concat([g.pid]).filter((x1, i, arr) => arr.indexOf(x1) === i).slice(0, 4);   // (the stores of the Americas share ids)
      want.push([g.pid, ids, same]);
    });
    const left = Math.max(0, max - order.length);
    let todo = want.slice(0, left);
    // each add-on's possible ids in turn, until one is sold here (none: the add-on isn't, when its game's codes are the
    // same here; otherwise it's not known: "", the store's own deal list stands)
    for (let round = 0; round < 4 && todo.length && Date.now() < until; round++) {
      const res = lookupProducts_(code, todo.map(w => w[1][round]), until), next = [];
      todo.forEach(w => {
        const p = res[w[1][round]];
        if (p) { d.a[w[0]] = [now, w[1][round], p.price, p.base, p.end]; addOns++; }
        else if (p === null) { if (w[1][round + 1]) next.push(w); else d.a[w[0]] = [now, w[2] ? null : ""]; }
      });
      todo = next;
    }
    const live = new Set(side.deals.map(g => g.pid));
    Object.keys(d.a).forEach(id => { if (!live.has(id) || now - d.a[id][0] > 30 * 864e5) delete d.a[id]; });
  }
  // games no longer in the US lists
  const liveCons = new Set(side.cons);
  Object.keys(d.c).forEach(id => { if (!liveCons.has(id) || now - d.c[id][0] > 30 * 864e5) delete d.c[id]; });
  save(code, d);
  const known = side.cons.filter(id => d.c[id]).length;
  console.log("PlayStation " + code + " editions: looked up " + Object.keys(got).length + " of " + order.length + " games (" + sold + " sold there, " + none +
              " not), " + addOns + " add-ons; " + known + " of " + side.cons.length + " games known (" + Math.round((Date.now() - t0) / 1000) + " s)");
  return order.length - Object.keys(got).length;   // games still to ask
}

// ---------- the region's price file ----------
// Prices each US game and deal with its edition in this store (ps_prices_<code>.json: prices, na, ends). The entries
// it sets (ed) and the store's own ones it replaced (was) are put back first, so each run starts from the store's lists.
function psResolveRegion_(code) {
  const DATA = require("../runtime/appsscript").DATA_DIR, file = path.join(DATA, "ps_prices_" + code + ".json");
  let rf = null;
  try { rf = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  if (!rf || !rf.prices) return;
  (rf.ed || []).forEach(k => { delete rf.prices[k]; });
  Object.keys(rf.was || {}).forEach(k => { rf.prices[k] = rf.was[k]; });
  if (rf.xwas) { rf.extra = (rf.extra || []).concat(rf.xwas); delete rf.xwas; }   // (the store's deals paired by name below)
  const now = Date.now(), side = usSide_(), here = load(code), usEd = side.us.c;
  // the prices the earlier way merged (gap: looked up by game, paired by name) stay until every game's editions here
  // are known
  if (rf.gap && side.cons.every(id => here.c[id])) { rf.gap.forEach(k => { delete rf.prices[k]; }); delete rf.gap; }
  // the store's own deals (its deal list, exportPsRegion_), by its product id: today's sale prices
  const sale = {};
  Object.keys(rf.prices).forEach(k => { const p = rf.prices[k]; if (p[2] < 1e6 && /-/.test(String(p[4] || ""))) sale[p[4]] = p; });
  const ed = [], was = {}, na = new Set(), ends = {}, gapKeys = new Set(rf.gap || []);
  // [price, regular price, sale end] of an edition here
  const priceOf = (rid, base, price, end, checked) => {
    const s = sale[rid];
    if (s) return [s[0], s[1], end && Math.abs(price - s[0]) < 0.005 && end > now ? end : 0, s[2]];
    if (price < base && end > now) return [price, base, end, 1e6];
    if (price < base && !end && now - checked < 2 * 864e5) return [price, base, 0, 1e6];
    return [base, base, 0, 1e6];
  };
  const put = (k, rid, p) => {
    if (rf.prices[k] && ed.indexOf(k) < 0 && !(k in was) && !gapKeys.has(k)) was[k] = rf.prices[k];
    rf.prices[k] = [p[0], p[1], p[3], p[1] > p[0] ? Math.round((1 - p[0] / p[1]) * 100) : 0, rid];
    if (p[2]) ends[k] = p[2];
    if (ed.indexOf(k) < 0) ed.push(k);
    na.delete(k);
  };
  const notSold = k => {
    if (rf.prices[k] && ed.indexOf(k) < 0 && !(k in was) && !gapKeys.has(k)) was[k] = rf.prices[k];
    if (rf.prices[k]) { delete rf.prices[k]; if (ed.indexOf(k) < 0) ed.push(k); }
    na.add(k);
  };
  const dealsOf = {};
  side.deals.forEach(g => { if (g.con) (dealsOf[g.con] = dealsOf[g.con] || []).push(g); });
  const rowOf = {};
  side.rows.forEach(r => { rowOf[r[0]] = r; });
  let priced = 0, missing = 0;
  side.cons.forEach(con => {
    const x = here.c[con];
    if (!x) return;   // not looked up yet: the store's own lists stand
    const deals = dealsOf[con] || [], row = rowOf[con];
    if (!x[1]) {   // the game isn't sold here
      if (row) notSold(con);
      // (its deals too, unless the store's own deal list has them: one it sells under another game)
      deals.forEach(g => { if (!rf.prices[g.key] || ed.indexOf(g.key) >= 0) notSold(g.key); });
      return;
    }
    // the US editions, with the deals the US lookup didn't have
    const us = ((usEd[con] && usEd[con][1]) || []).slice(), ids = new Set(us.map(e => e[0]));
    deals.forEach(g => { if (g.game && !ids.has(g.pid)) { us.push([g.pid, edKey(g.title.replace(/\s*\(PS4\)\s*$/, "")), g.kind, g.plats, null]); ids.add(g.pid); } });
    const m = psMatchEditions_(us, x[1]);
    const priceEd = h => priceOf(h[0], h[4], h[5], h[6], x[0]);
    if (row) {
      // the edition the US page's price is for; else its main product, or the US edition with its regular price
      // (no column 17: the US edition with the page's price and regular price, else its regular price; the main
      // product first, then a full game)
      let pid = row[1];
      if (!row[7] || !ids.has(pid)) {
        const pick = list => list.find(e => e[0] === row[6]) || list.find(e => e[2] === "FULL_GAME") || list[0];
        const both = us.filter(e => e[5] === row[4] && e[4] === row[5]), base = us.filter(e => e[4] === row[5] && PSE_GAME.test(e[2]));
        pid = ((both.length ? pick(both) : base.length ? pick(base) : null) || [row[6]])[0];
      }
      const u = us.find(e => e[0] === pid), h = m.get(pid);
      if (h) { put(con, h[0], priceEd(h)); priced++; }
      else if (u) {
        // that edition isn't paired with one here: an edition of the game only this store sells, for the same console
        // (the cheapest), else it isn't sold here. Editions the US also sells are other editions (the PS5 remaster
        // isn't the PS4 game, the Deluxe Edition isn't the game alone).
        const paired = new Set(m.values());
        const pool = x[1].filter(e => !paired.has(e) && PSE_GAME.test(e[2]) && PSE_GAME.test(u[2]) && overlap(e[3], u[3]));
        if (pool.length) { const best = pool.reduce((a, e) => e[4] < a[4] ? e : a, pool[0]); put(con, best[0], priceEd(best)); priced++; }
        else { notSold(con); missing++; }
      }
      // (no US edition known: the store's own price for the game stands)
    }
    deals.forEach(g => {
      if (!g.game) return;
      const h = m.get(g.pid);
      if (h) put(g.key, h[0], priceEd(h));
      else if (!rf.prices[g.key] || ed.indexOf(g.key) >= 0) notSold(g.key);   // (the store's own deal list wins)
    });
  });
  // add-ons
  side.deals.forEach(g => {
    if (g.game) return;
    const a = here.a[g.pid];
    if (!a) return;
    if (a[1]) put(g.key, a[1], priceOf(a[1], a[3], a[2], a[4], a[0]));
    else if (a[1] === "") return;
    else if (!rf.prices[g.key] || ed.indexOf(g.key) >= 0) notSold(g.key);
  });
  // still without a price nor known not sold here (mostly add-ons whose store code says nothing, "…_00-0716578793176238"):
  // the deal of this store's own deal list with the same name, for the same consoles, when each store has one deal of
  // that name. The store's deal is then the US deal's (taken out of extra: its deals not sold in the US).
  const nameOf = t => edKey(String(t || "").replace(/\s*\(PS4\)\s*$/, ""));
  const open = side.deals.filter(g => !rf.prices[g.key] && !na.has(g.key) && nameOf(g.title).length >= 3);
  const usCount = {}, theirs = {};
  open.forEach(g => { const n = nameOf(g.title); usCount[n] = (usCount[n] || 0) + 1; });
  side.deals.forEach(g => { const n = nameOf(g.title); if (usCount[n] && rf.prices[g.key]) usCount[n]++; });   // (another US deal of that name is priced here already)
  (rf.extra || []).forEach(x => { const n = nameOf(x.title); if (usCount[n] && rf.prices[x.key]) (theirs[n] = theirs[n] || []).push(x); });
  const paired = new Set();
  let byName = 0;
  open.forEach(g => {
    // (and, when the game's editions here are known, a product of the same game: its id has one of their title ids,
    // "UP0999-CUSA05186_00-…", so a name like "Gold Edition 6 in 1" isn't another publisher's)
    const x = g.con && here.c[g.con], titles = x && x[1] ? new Set(x[1].map(e => { const q = parseId(e[0]); return q && q.prefix + "-" + q.title; })) : null;
    const sameGame = id => { const q = parseId(id); return !titles || (q && titles.has(q.prefix + "-" + q.title)); };
    const n = nameOf(g.title), xs = (theirs[n] || []).filter(x => overlap(platsOf(x.platforms), g.plats) && sameGame(x.productId));
    if (usCount[n] !== 1 || xs.length !== 1) return;
    const p = rf.prices[xs[0].key];
    put(g.key, xs[0].productId, [p[0], p[1], 0, p[2]]);
    paired.add(xs[0]);
    byName++;
  });
  if (paired.size) { rf.xwas = rf.extra.filter(x => paired.has(x)); rf.extra = rf.extra.filter(x => !paired.has(x)); }
  rf.ed = ed;
  rf.was = was;
  // (while the earlier way's prices stay, so do the games it found not sold here)
  if (rf.gap) (rf.na || []).forEach(k => { if (!rf.prices[k] && !(k in was) && ed.indexOf(k) < 0) na.add(k); });
  rf.na = Array.from(na);
  // sale end times: the looked-up ones are exact; the store's other deals end at the US deal's end in this store's time
  // zone, when they have its discount (the most common difference between the two, learnt from the exact ones)
  const usEnd = {}, usPct = {};
  ((readData("ps_sales.json") || {}).games || []).forEach(g => { const t = Date.parse(g.saleEnds); if (g.key && t > now) { usEnd[g.key] = t; usPct[g.key] = Number(g.msrp) > 0 ? Math.round((1 - g.price / g.msrp) * 100) : 0; } });
  const diffs = {};
  Object.keys(ends).forEach(k => { if (usEnd[k]) { const dd = ends[k] - usEnd[k]; diffs[dd] = (diffs[dd] || 0) + 1; } });
  const best = Object.keys(diffs).sort((a, b) => diffs[b] - diffs[a])[0], shift = best !== undefined && diffs[best] >= 3 && Math.abs(best) <= 864e5 ? Number(best) : null;
  Object.keys(rf.prices).forEach(k => {
    const p = rf.prices[k];
    if (!(p[1] > p[0]) || ends[k]) return;
    if (shift !== null && usEnd[k] && Math.abs((usPct[k] || 0) - (p[3] || 0)) <= 1) ends[k] = usEnd[k] + shift;
  });
  rf.ends = ends;
  fs.writeFileSync(file, JSON.stringify(rf));
  console.log("PlayStation " + code + " prices by edition: " + ed.length + " set, " + priced + " games priced by their own edition, " + missing +
              " whose edition isn't sold here; " + rf.na.length + " not sold here, " + Object.keys(ends).length + " sale ends, " + byName + " deals paired by name");
}

module.exports = { psEditionLookups, psResolveRegion_, psMatchEditions_, edKey, editionsOf_ };
