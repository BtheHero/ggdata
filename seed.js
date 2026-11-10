// Copies files from the site's data service (SOURCE_API, a repository secret):
// - once, files the jobs then keep building on themselves (price history), if they aren't in data/ yet;
// - every run, files only the site has: how many people wishlisted each game (counts only, no account data).
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const api = process.env.SOURCE_API, dir = path.resolve(process.env.DATA_DIR || "data");
const FILES = [   // [property key, file name, query, refresh every run]
  ["HISTORY_FILE_ID", "xbox_history.json", "file=history"],
  ["WISHCOUNTS_FILE_ID", "wishcounts.json", "file=wishcounts", true],
];
if (!api) {
  const missing = FILES.filter(f => !f[3] && !fs.existsSync(path.join(dir, f[1]))).map(f => f[1]);
  if (missing.length) { console.log("SOURCE_API isn't set, and " + missing.join(", ") + " must be copied first."); process.exit(1); }
  console.log("SOURCE_API isn't set: nothing to copy.");
  process.exit(0);
}
fs.mkdirSync(dir, { recursive: true });
const pf = path.join(dir, "_props.json");
let props = {};
try { props = JSON.parse(fs.readFileSync(pf, "utf8")); } catch (e) {}
FILES.forEach(([key, name, q, refresh]) => {
  if (!refresh && fs.existsSync(path.join(dir, name))) return;
  try {
    const body = execFileSync("curl", ["-sSL", "--max-time", "120", api + "?" + q], { maxBuffer: 1 << 30, encoding: "utf8" });
    const d = JSON.parse(body);   // only valid JSON is kept
    if (!d || typeof d !== "object" || d.error || (d.games && !d.games.length)) throw new Error("no data");
    fs.writeFileSync(path.join(dir, name), body);
    props[key] = name;
    console.log("Copied " + name + " (" + Math.round(body.length / 1024) + " KB)");
  } catch (e) {
    console.log("Couldn't copy " + name + ": " + e.message + (refresh ? " (keeping the previous copy)" : ""));
    if (!refresh) process.exitCode = 1;   // the price history must not start over
  }
});
fs.writeFileSync(pf, JSON.stringify(props, null, 1));
