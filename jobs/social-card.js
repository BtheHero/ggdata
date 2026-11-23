// The weekly roundup's pictures: the week's 5 best deals on one image, for the social posts (jobs/social.js weekly).
//
//   node jobs/social-card.js          both stores, this week's list (data/weekly/<plat>-index.json, newest week)
//   node jobs/social-card.js deals xbox|ps   the queued deal posts' pictures (data/social/<plat>-queue.json, after
//                                     jobs/social.js deals): the game's art filling the picture, with the discount, the
//                                     store's logo and the site's address, one per network's shape (SHAPES below:
//                                     <plat>-deal-<date>-<id>-<tall|poster|wide|link>.jpg). Each item gets them as "pics";
//                                     jobs/social.js uses them, else the plain art.
//   node jobs/social-card.js deals resend   the same for data/social/resend-queue.json (.github/workflows/social-resend.yml)
//
// Writes data/social/img/<plat>-<week>-tall.jpg (1080×1350, Instagram and Pinterest) and -wide.jpg (1200×630, Bluesky
// and Facebook). They're uploaded with the other files and served by the site at /social-img/<name> (functions/
// social-img in the site), the address the posts give Facebook, Instagram and Pinterest.
// Drawn by a browser: playwright-core with the runner's Chrome (CHROME_PATH, else /usr/bin/google-chrome), or playwright.
const fs = require("fs"), path = require("path");
const DATA = path.resolve(process.env.DATA_DIR || "data");
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")); } catch (e) { return d; } };
const fullImg = u => !u ? "" : /^https?:/.test(u) ? u : u[0] === "~" ? "https://image.api.playstation.com/vulcan/ap/rnd/" + u.slice(1)
  : "https://store-images.s-microsoft.com/image/" + u;
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const money = (n, cur) => (cur && cur !== "USD" ? cur + " " : "$") + Number(n).toFixed(2);
const PLAT = {
  xbox: { name: "Xbox", c1: "#7af0b4", c2: "#1fb877", c3: "#0b7a4c", bg: "#0a1a15", line: "#244538", mute: "#8fb1a0" },
  ps: { name: "PlayStation", c1: "#8fd0ff", c2: "#3d8bff", c3: "#2350d8", bg: "#0a1222", line: "#233656", mute: "#93a6c4" }
};
const fmtDay = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const MARK = (c1, c2, c3) => `<svg viewBox="0 0 48 48"><defs>
  <linearGradient id="M" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset=".55" stop-color="${c2}"/><stop offset="1" stop-color="${c3}"/></linearGradient>
  <linearGradient id="G" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe08a"/><stop offset="1" stop-color="#ffb020"/></linearGradient></defs>
  <path d="M14 12h20c6 0 10 4.6 11 11.2l1.3 8.6c.6 4.6-4.7 7.4-8.1 4.4L32.4 30.6H15.6l-5.8 5.6c-3.4 3-8.7.2-8.1-4.4L3 23.2C4 16.6 8 12 14 12z" fill="url(#M)"/>
  <path d="M12.5 18.5v8m-4-4h8" stroke="#08110e" stroke-width="3.4" stroke-linecap="round"/>
  <circle cx="29.5" cy="18.8" r="2.7" fill="url(#G)"/><circle cx="37.7" cy="26.4" r="2.7" fill="url(#G)"/><path d="M38.3 17.4l-9.4 10.4" stroke="url(#G)" stroke-width="3" stroke-linecap="round"/></svg>`;

function html(plat, wk, games, shape) {
  const P = PLAT[plat], tall = shape === "tall";
  const rows = games.map((g, i) => {
    const pct = Math.round((1 - g.price / g.msrp) * 100), img = fullImg(g.sq || g.image);
    return `<div class="g">
      <div class="cv">${img ? `<img src="${esc(img)}${img.includes("playstation") ? "?w=440" : "?w=440&h=440"}">` : ""}<span class="rk">${i + 1}</span></div>
      <div class="tx"><div class="t">${esc(g.title)}</div>
        <div class="pr"><b>${money(g.price, g.currency)}</b><s>${money(g.msrp, g.currency)}</s></div>
        ${tall ? "" : `<div class="low" style="visibility:hidden">.</div>`}</div>
      <div class="pc">-${pct}%</div></div>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@600;700&family=Figtree:wght@500;600;700;800&display=block" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0}
body{width:${tall ? 1080 : 1200}px;height:${tall ? 1350 : 630}px;overflow:hidden;font-family:Figtree,sans-serif;color:#eef5f1;
  background:radial-gradient(ellipse 60% 45% at 100% 0%,${P.c2}55,transparent 70%),radial-gradient(ellipse 50% 40% at 0% 100%,${P.c3}66,transparent 70%),${P.bg};
  display:flex;flex-direction:column;padding:${tall ? "64px 60px 52px" : "38px 44px 30px"}}
.hd{display:flex;align-items:center;gap:${tall ? 22 : 16}px}
.hd svg{width:${tall ? 92 : 64}px;height:${tall ? 92 : 64}px;flex:none;filter:drop-shadow(0 6px 18px ${P.c2}80)}
.k{font:700 ${tall ? 22 : 15}px/1 Figtree;letter-spacing:.14em;text-transform:uppercase;color:${P.c1}}
h1{font:800 ${tall ? 47 : 40}px/1.1 Figtree;letter-spacing:-.015em;white-space:nowrap}
h1 i{font-style:normal;background:linear-gradient(90deg,${P.c1},${P.c2});-webkit-background-clip:text;background-clip:text;color:transparent}
.dt{margin-top:${tall ? 10 : 7}px;font:600 ${tall ? 24 : 18}px/1 Figtree;color:${P.mute}}
.ls{flex:1;display:flex;${tall ? "flex-direction:column;gap:18px;margin:46px 0 34px" : "gap:16px;margin:22px 0 18px;align-items:center"}}
.g{position:relative;display:flex;${tall ? "align-items:center;gap:26px;flex:1;padding:16px 26px 16px 16px" : "flex-direction:column;flex:1;min-width:0;padding:12px"};
  background:rgba(255,255,255,.045);border:1px solid ${P.line};border-radius:${tall ? 26 : 20}px}
.cv{position:relative;flex:none;${tall ? "width:150px;height:150px" : "width:100%;aspect-ratio:1"};border-radius:${tall ? 18 : 14}px;overflow:hidden;background:${P.line}}
.cv img{width:100%;height:100%;object-fit:cover;display:block}
.rk{position:absolute;left:${tall ? 10 : 8}px;top:${tall ? 10 : 8}px;font:700 ${tall ? 22 : 16}px/1 Unbounded;color:#08110e;background:linear-gradient(180deg,#ffe08a,#ffb020);
  width:${tall ? 42 : 30}px;height:${tall ? 42 : 30}px;border-radius:50%;display:grid;place-items:center;box-shadow:0 4px 12px rgba(0,0,0,.35)}
.tx{flex:1;min-width:0;${tall ? "" : "margin-top:10px"}}
.t{font:700 ${tall ? 34 : 19}px/1.18 Figtree;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;${tall ? "" : "min-height:45px"}}
.pr{display:flex;align-items:baseline;gap:${tall ? 14 : 8}px;margin-top:${tall ? 10 : 6}px;flex-wrap:wrap}
.pr b{font:700 ${tall ? 36 : 25}px/1 Unbounded;color:${P.c1}}
.pr s{font:600 ${tall ? 24 : 16}px/1 Figtree;color:${P.mute}}
.low{display:inline-block;margin-top:${tall ? 10 : 7}px;font:800 ${tall ? 17 : 12}px/1 Figtree;letter-spacing:.06em;text-transform:uppercase;color:#ffd166}
.pc{font:700 ${tall ? 34 : 18}px/1 Unbounded;color:#3a2500;background:linear-gradient(180deg,#ffe08a,#ffb020);border-radius:${tall ? 16 : 10}px;
  padding:${tall ? "14px 16px" : "8px 9px"};flex:none;${tall ? "" : "position:absolute;right:20px;top:20px"};box-shadow:0 8px 24px rgba(255,176,32,.25)}
.ft{display:flex;align-items:center;justify-content:space-between;font:600 ${tall ? 26 : 17}px/1 Figtree;color:${P.mute}}
.ft b{font:700 ${tall ? 30 : 20}px/1 Unbounded;color:#eef5f1;letter-spacing:-.02em}
.ft b i{font-style:normal;color:${P.c1}}
</style></head><body>
<div class="hd">${MARK(P.c1, P.c2, P.c3)}<div><h1>This week's top 5 <i>${P.name}</i> Deals</h1><div class="dt">${fmtDay(wk.start)} – ${fmtDay(wk.end)}</div></div></div>
<div class="ls">${rows}</div>
<div class="ft"><b>game<i>deal</i>track.com</b></div>
</body></html>`;
}

// one deal: the game's art filling the picture, with the discount, the store's logo and the site's address on it.
// fit "cover": the art fills it all (cropped to the shape); "frame": the whole art on a blurred copy of itself (art of
// another shape, e.g. a portrait poster on a wide picture, when the game has no art of the right shape)
const sized = (u, w) => u + (u.includes("?") ? "&" : "?") + "w=" + w;
function dealHtml(plat, it, w, h, src, fit) {
  const P = PLAT[plat], d = it.deal, s = Math.min(w, h), r = n => Math.round(s * n), img = esc(sized(src, Math.min(1920, Math.max(w, h))));
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@700;800&family=Figtree:wght@700;800&display=block" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0}
body{width:${w}px;height:${h}px;overflow:hidden;font-family:Figtree,sans-serif;color:#fff;background:${P.bg};position:relative}
.bg{position:absolute;inset:-80px;background:url("${img}") center/cover;filter:blur(40px) brightness(.5) saturate(1.25)}
.art{position:absolute;inset:0;width:100%;height:100%;display:block;object-fit:${fit === "cover" ? "cover;object-position:center 30%" : "contain;filter:drop-shadow(0 20px 50px rgba(0,0,0,.6))"}}
.sh{position:absolute;left:0;right:0;pointer-events:none}
.sh.t{top:0;height:${r(.34)}px;background:linear-gradient(180deg,rgba(0,0,0,.55),rgba(0,0,0,0))}
.sh.b{bottom:0;height:${r(.3)}px;background:linear-gradient(0deg,rgba(0,0,0,.72),rgba(0,0,0,0))}
.plat{position:absolute;left:${r(.045)}px;top:${r(.045)}px;display:flex;align-items:center;gap:${r(.016)}px;padding:${r(.014)}px ${r(.026)}px ${r(.014)}px ${r(.016)}px;
  border-radius:999px;background:rgba(8,12,18,.55);border:1px solid rgba(255,255,255,.18);backdrop-filter:blur(10px);
  font:800 ${r(.048)}px/1 Figtree;letter-spacing:.01em;box-shadow:0 8px 26px rgba(0,0,0,.35)}
.plat img{height:${r(.072)}px;width:auto;display:block}
.pc{position:absolute;right:${r(.045)}px;top:${r(.045)}px;font:800 ${r(.075)}px/1 Unbounded;letter-spacing:-.03em;color:#fff;
  background:linear-gradient(180deg,#ff4d5e,#e0162b);border-radius:${r(.026)}px;padding:${r(.02)}px ${r(.024)}px;
  box-shadow:0 12px 34px rgba(0,0,0,.45),inset 0 -${r(.005)}px 0 rgba(0,0,0,.15)}
.site{position:absolute;left:0;right:0;bottom:${r(.045)}px;display:flex;align-items:center;justify-content:center;gap:${r(.014)}px;
  font:700 ${r(.046)}px/1 Unbounded;letter-spacing:-.02em;text-shadow:0 2px 14px rgba(0,0,0,.6)}
.site svg{width:${r(.07)}px;height:${r(.07)}px;filter:drop-shadow(0 4px 12px rgba(0,0,0,.5))}
.site i{font-style:normal;color:${P.c1}}
</style></head><body>
${fit === "cover" ? "" : `<div class="bg"></div>`}<img class="art" src="${img}">
<div class="sh t"></div><div class="sh b"></div>
<div class="plat"><img src="${LOGO[plat]}" onerror="this.remove()">${P.name}</div>
<div class="pc">-${d.pct}%</div>
<div class="site">${MARK(P.c1, P.c2, P.c3)}<span>game<i>deal</i>track.com</span></div>
</body></html>`;
}

const SITE = "https://gamedealtrack.com";
// the platforms' logos, as the site shows them (its img/ph-*.png); a picture without it if it doesn't load
const LOGO = { xbox: SITE + "/img/ph-xbox.png?v=2", ps: SITE + "/img/ph-ps.png" };
// each network's picture, in its feed's best shape, and the art it's drawn from first (the other one framed, else)
//   tall    1080×1350 (4:5)    Instagram and Facebook
//   poster  1000×1500 (2:3)    Pinterest
//   wide    1600×900  (16:9)   X
//   link    1200×630  (1.91:1) Bluesky (its link card)
const SHAPES = [["tall", 1080, 1350, "poster"], ["poster", 1000, 1500, "poster"], ["wide", 1600, 900, "hero"], ["link", 1200, 630, "hero"]];
async function dealCards(name) {   // name: xbox, ps, or resend (its items say their store)
  const file = "social/" + name + "-queue.json", q = read(file, { items: [] }), items = q.items || [];
  const todo = items.filter(it => it.deal && !it.pics);
  const out = path.join(DATA, "social", "img");
  fs.mkdirSync(out, { recursive: true });
  if (todo.length) {
    const b = await browser();
    for (const it of todo) {
      const plat = it.plat === "ps" || it.plat === "xbox" ? it.plat : name;
      const base = plat + "-deal-" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + String(it.key).replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
      const pics = {};
      for (const [shape, w, h, art] of SHAPES) {
        // the art of the shape's kind fills it; else the other one, whole, on a blurred copy of itself
        const other = art === "poster" ? "hero" : "poster";
        const tries = [[it[art], "cover"], [it[other], "frame"]].filter(t => t[0]);
        let done = false;
        for (const [src, fit] of tries) {
          try {
            const page = await b.newPage({ viewport: { width: w, height: h } });
            await page.setContent(dealHtml(plat, it, w, h, src, fit), { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
            await page.evaluate(() => document.fonts.ready);
            const ok = await page.evaluate(() => { const i = document.querySelector(".art"); return !!(i && i.complete && i.naturalWidth); });
            const name = base + "-" + shape + ".jpg";
            if (ok) { await page.screenshot({ path: path.join(out, name), type: "jpeg", quality: 88 }); pics[shape] = { file: "social/img/" + name, url: SITE + "/social-img/" + name }; done = true; }
            await page.close();
          } catch (e) { console.log("Deal card " + it.title + " (" + shape + ") failed: " + e.message); }
          if (done) break;
        }
        if (!done) console.log("Deal card " + it.title + " (" + shape + "): no art loaded, the post keeps the plain picture");
      }
      if (Object.keys(pics).length) { it.pics = pics; console.log("Deal card: " + base + " (" + it.title + ")"); }
    }
    await b.close();
    fs.writeFileSync(path.join(DATA, file), JSON.stringify(Object.assign(q, { items })));
  } else console.log("Deal cards " + name + ": nothing new in the queue");
  // keep the deal pictures 14 days (a queued post waits at most a few days)
  const cutoff = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10).replace(/-/g, "");
  fs.readdirSync(out).forEach(f => { const m = f.match(/^(?:xbox|ps)-deal-(\d{8})-/); if (m && m[1] < cutoff) fs.unlinkSync(path.join(out, f)); });
}

async function browser() {
  let pw;
  try { pw = require("playwright-core"); } catch (e) { pw = require("playwright"); }
  const exe = process.env.CHROME_PATH || (fs.existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
  return pw.chromium.launch(exe ? { executablePath: exe } : {});
}

// the week's top 5 still on sale, as jobs/social.js picks them
function topFive(plat) {
  const idx = read("weekly/" + plat + "-index.json", { weeks: [] }), wk = (idx.weeks || [])[0];
  if (!wk) return null;
  const games = (read("weekly/" + plat + "-" + wk.week + ".json", { games: [] }).games || [])
    .filter(g => !(g.ends && Date.parse(g.ends) <= Date.now())).slice(0, 5);
  return games.length >= 3 ? { wk, games } : null;
}

async function main() {
  const b = await browser(), out = path.join(DATA, "social", "img");
  fs.mkdirSync(out, { recursive: true });
  for (const plat of ["xbox", "ps"]) {
    const t = topFive(plat);
    if (!t) { console.log("Social cards " + plat + ": no week list"); continue; }
    for (const [shape, w, h] of [["tall", 1080, 1350], ["wide", 1200, 630]]) {
      const page = await b.newPage({ viewport: { width: w, height: h } });
      await page.setContent(html(plat, t.wk, t.games, shape), { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
      await page.evaluate(() => document.fonts.ready);
      const file = path.join(out, plat + "-" + t.wk.week + "-" + shape + ".jpg");
      await page.screenshot({ path: file, type: "jpeg", quality: 90 });
      await page.close();
      console.log("Social card: social/img/" + path.basename(file) + " (" + t.games.map(g => g.title).join(", ") + ")");
    }
  }
  // keep the last 8 weeks
  const files = fs.readdirSync(out).sort();
  ["xbox", "ps"].forEach(p => files.filter(f => f.startsWith(p + "-") && !f.includes("-deal-")).reverse().slice(16).forEach(f => fs.unlinkSync(path.join(out, f))));
  await b.close();
}
if (require.main === module) {
  const [mode, plat] = process.argv.slice(2);
  (mode === "deals" ? dealCards(plat === "ps" || plat === "resend" ? plat : "xbox") : main()).catch(e => { console.error("Social cards failed: " + e.message); process.exit(0); });
}
module.exports = { topFive };
