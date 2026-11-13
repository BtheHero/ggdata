// A light copy of the full game list for the site's pages, after each run that saves the list.
//
// The full list (<plat>_catalog.json) is mostly image addresses (three quarters of it), which don't compress. Pages
// that search or filter every game only show a few dozen at a time, so they read:
//   data/<plat>_catalog_lite.json   the same rows without the images: r[6] (cover) is "", r[14] is the number of the
//       art file that holds the game's images (PlayStation: r[12], the store address, is "" too: the site builds it
//       from the id; r[16], the editions, is left out). {updatedAt, count, art: {n: art files, per: games in each}, games}
//   data/art/<plat>-<k>.json        {id: [cover, square art]} as they are in the full list, ART_PER games each, the
//       best-known games first (so the most popular games' images are in the first files)
// The full list stays as it is (the jobs, the data feed and the site's fallback read it).
// node jobs/lite.js xbox|ps
const fs = require("fs"), path = require("path");
const DATA = path.resolve(process.env.DATA_DIR || "data");
const plat = process.argv[2] === "ps" ? "ps" : "xbox", ART_PER = 400;
let cat;
try { cat = JSON.parse(fs.readFileSync(path.join(DATA, plat + "_catalog.json"), "utf8")); } catch (e) { cat = null; }
if (!cat || !Array.isArray(cat.games) || cat.games.length < 100) { console.log("Light list: no full " + plat + " game list, nothing written"); process.exit(0); }

const rows = cat.games, rankOf = (r, i) => (r[7] !== "" && Number.isFinite(+r[7]) ? +r[7] : 1e9 + i);
const order = rows.map((r, i) => i).sort((a, b) => rankOf(rows[a], a) - rankOf(rows[b], b));
const fileOf = new Array(rows.length), files = [];
order.forEach((i, pos) => {
  const k = Math.floor(pos / ART_PER), r = rows[i];
  fileOf[i] = k;
  if (r[0] && (r[6] || r[14])) (files[k] = files[k] || {})[r[0]] = [r[6] || "", r[14] || ""];
});
const lite = rows.map((r, i) => {
  const x = r.slice(0, 16);
  x[6] = ""; x[14] = fileOf[i];
  if (plat === "ps") x[12] = "";
  return x;
});
const n = Math.ceil(rows.length / ART_PER);
fs.mkdirSync(path.join(DATA, "art"), { recursive: true });
for (let k = 0; k < n; k++) fs.writeFileSync(path.join(DATA, "art", plat + "-" + k + ".json"), JSON.stringify(files[k] || {}));
// (art files past the end, from a longer list: emptied, so nothing stale is read)
for (let k = n; fs.existsSync(path.join(DATA, "art", plat + "-" + k + ".json")); k++) fs.writeFileSync(path.join(DATA, "art", plat + "-" + k + ".json"), "{}");
const out = JSON.stringify({ updatedAt: cat.updatedAt, platform: cat.platform, count: lite.length, art: { n, per: ART_PER }, games: lite });
fs.writeFileSync(path.join(DATA, plat + "_catalog_lite.json"), out);
console.log("Light " + plat + " list: " + lite.length + " games, " + Math.round(out.length / 1024) + " KB (full list " +
            Math.round(fs.statSync(path.join(DATA, plat + "_catalog.json")).size / 1024) + " KB), images in " + n + " files");
