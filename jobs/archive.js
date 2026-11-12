// Older prices from the Internet Archive (Wayback Machine): saved copies of each game's store page, read for the price
// on that day. Each run takes the next games (best-known first) and reads up to PER_GAME copies of each, spread evenly
// over the years, at about one request a second (the archive asks for gentle use).
//
//   data/xbox_archive.json, data/ps_archive.json:
//     {updatedAt, cursor, done: {id: day checked}, h: {id: [[yyyymmdd, price, regular price], ...]}}
//   The game pages put these points before the site's own history (gs/gamepages.gs).
//
// node jobs/archive.js [xbox|ps] [minutes]   (both by default; minutes: how long to run, 40 by default)
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const DATA = path.resolve(process.env.DATA_DIR || "data");
const PER_GAME = 40, GAMES_MAX = 400, RECHECK_DAYS = 60;
const minutes = Number(process.argv[3]) || 40, until = Date.now() + minutes * 60000;
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")); } catch (e) { return d; } };
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let last = 0;
function get(url) {   // one request a second at most, 3 tries
  for (let t = 0; t < 3; t++) {
    const wait = 1100 - (Date.now() - last); if (wait > 0) sleep(wait);
    last = Date.now();
    try { return execFileSync("curl", ["-sL", "--max-time", "60", "-A", "gamedealtrack-archive/1.0", url], { maxBuffer: 1 << 28, encoding: "utf8" }); }
    catch (e) { sleep(5000 * (t + 1)); }
  }
  return "";
}
const slug = t => String(t || "").toLowerCase().normalize("NFKD").replace(/[™®©]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const ymd = ts => Number(String(ts).slice(0, 8));
const num = s => { const v = Number(String(s).replace(/[^0-9.]/g, "")); return isFinite(v) && v >= 0 && v < 1000 ? v : null; };

// The saved copies of a page (and the pages under it): [[timestamp, url]], one a day
function captures(url) {
  const raw = get("https://web.archive.org/cdx/search/cdx?url=" + encodeURIComponent(url) + "&matchType=prefix&output=json&fl=timestamp,original&filter=statuscode:200&collapse=timestamp:8&limit=5000");
  try { return JSON.parse(raw || "[]").slice(1); } catch (e) { return null; }   // null: the archive didn't answer
}
// PER_GAME copies spread evenly from first to last (the newest and the oldest always in)
function spread(list) {
  if (list.length <= PER_GAME) return list;
  const out = [];
  for (let i = 0; i < PER_GAME; i++) out.push(list[Math.round(i * (list.length - 1) / (PER_GAME - 1))]);
  return out.filter((x, i, a) => a.indexOf(x) === i);
}

// The price on a saved page: [price, regular price] or null
function xboxPrice(html, id) {
  // the store's data: the product's entry, then its first purchase price after it
  const at = html.search(new RegExp('"' + id + '"\\s*:\\s*\\{', "i"));
  const near = at >= 0 ? html.slice(at, at + 60000) : html;
  const lp = near.match(/"listPrice"\s*:\s*([\d.]+)/), mp = near.match(/"msrp"\s*:\s*([\d.]+)/);
  if (lp && num(lp[1]) !== null) { const a = num(lp[1]), b = mp ? num(mp[1]) : null; return [a, b !== null && b >= a ? b : a]; }
  let m;
  // older store pages: the page's product data (schema.org) or the price shown
  m = html.match(/"@type"\s*:\s*"Offer"[^}]*?"price"\s*:\s*"?([\d.]+)/) || html.match(/itemprop="price"\s+content="([\d.]+)"/);
  if (m && num(m[1]) !== null) return [num(m[1]), num(m[1])];
  return null;
}
function psPrice(html) {
  const m = html.match(/"basePrice"\s*:\s*"\$([\d,.]+)"\s*,\s*"discountedPrice"\s*:\s*"\$([\d,.]+)"/) ||
            html.match(/"discountedPrice"\s*:\s*"\$([\d,.]+)"[^}]*?"basePrice"\s*:\s*"\$([\d,.]+)"/);
  if (m) { const a = num(m[1].replace(/,/g, "")), b = num(m[2].replace(/,/g, "")); if (a !== null && b !== null) return html.indexOf('"basePrice"') < html.indexOf('"discountedPrice"') ? [b, a] : [a, b]; }
  const f = html.match(/"price"\s*:\s*\{[^}]*?"value"\s*:\s*"?\$?([\d.]+)/);
  return f && num(f[1]) !== null ? [num(f[1]), num(f[1])] : null;
}

function run(plat) {
  const file = plat === "ps" ? "ps_archive.json" : "xbox_archive.json";
  const out = read(file, { cursor: 0, done: {}, h: {} });
  out.done = out.done || {}; out.h = out.h || {};
  const cat = read(plat === "ps" ? "ps_catalog.json" : "xbox_catalog.json", { games: [] }).games || [];
  // best-known first (the full list's order is by store ratings / popularity), games bought for money
  const list = cat.filter(r => r[0] && r[1] && Number(r[4]) > 0).slice(0, 6000);
  const today = Math.floor(Date.now() / 864e5);   // days since 1970: done[id] is the day a game was last read
  const stale = d => !d || today - d > RECHECK_DAYS;
  const todo = list.filter(r => stale(out.done[r[0]])).slice(0, GAMES_MAX);
  let games = 0, points = 0, pages = 0, failed = 0;
  for (const r of todo) {
    if (Date.now() > until) break;
    const id = String(r[0]);
    const urls = plat === "ps"
      ? ["store.playstation.com/en-us/concept/" + id].concat(r[13] ? ["store.playstation.com/en-us/product/" + r[13]] : [])
      : ["www.xbox.com/en-US/games/store/" + slug(r[1]) + "/" + id, "www.microsoft.com/en-us/p/" + slug(r[1]) + "/" + id.toLowerCase()];
    let caps = [], answered = true;
    for (const u of urls) { const c = captures(u); if (c === null) answered = false; else caps = caps.concat(c); }
    if (!answered && !caps.length) { failed++; continue; }   // the archive didn't answer: tried again next run
    caps = caps.sort((a, b) => a[0].localeCompare(b[0])).filter((c, i, a) => i === 0 || a[i - 1][0].slice(0, 8) !== c[0].slice(0, 8));
    const pts = [];
    for (const [ts, orig] of spread(caps)) {
      if (Date.now() > until) break;
      const html = get("https://web.archive.org/web/" + ts + "id_/" + orig); pages++;
      const p = html && (plat === "ps" ? psPrice(html) : xboxPrice(html, id));
      if (p && p[0] !== null) pts.push([ymd(ts), p[0], p[1]]);
    }
    const had = out.h[id] || [];
    const merged = had.concat(pts).sort((a, b) => a[0] - b[0]).filter((x, i, a) => i === 0 || a[i - 1][0] !== x[0]);
    if (merged.length) out.h[id] = merged;
    out.done[id] = today;
    games++; points += pts.length;
    if (process.env.ARCHIVE_DEBUG) console.log("  " + id + " " + r[1] + ": " + caps.length + " saved days, prices " + JSON.stringify(pts.slice(0, 6)) + (pts.length > 6 ? "…" : ""));
    if (games % 10 === 0) console.log(plat + ": " + games + " games, " + points + " prices from " + pages + " saved pages");
  }
  out.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(DATA, file), JSON.stringify(out));
  console.log(plat + " done: " + games + " games looked at, " + points + " prices from " + pages + " saved pages, " + failed + " not answered; " +
              Object.keys(out.h).length + " games with older prices in all");
}

const which = process.argv[2] ? [process.argv[2]] : ["xbox", "ps"];
which.forEach(run);
