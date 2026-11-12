// Uploads only what a job changed, so jobs can run at the same time without one putting back another's old copies.
//
//   node tools/upload.js snapshot   right after downloading: notes every file's checksum (data/.snapshot.json)
//   node tools/upload.js push       at the end: uploads the files that are new or changed since the snapshot, and
//                                   merges _props.json (which file is which) with the bucket's current copy:
//                                   the keys this job added or changed win, everyone else's stay.
// Needs R2 (endpoint) and the AWS_* keys in the environment, like the aws commands in the workflows.
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { execFileSync } = require("child_process");
const DATA = path.resolve(process.env.DATA_DIR || "data"), SNAP = path.join(DATA, ".snapshot.json"), BUCKET = "s3://ggdata/data";
const aws = args => execFileSync("aws", args.concat(["--endpoint-url", process.env.R2, "--only-show-errors"]), { stdio: "inherit" });

function files(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, base, out);
    else if (e.isFile() && !e.name.startsWith(".")) out.push(path.relative(base, p));
  });
  return out;
}
const md5 = f => crypto.createHash("md5").update(fs.readFileSync(path.join(DATA, f))).digest("hex");
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };

if (process.argv[2] === "snapshot") {
  const sums = {};
  files(DATA).forEach(f => { sums[f] = md5(f); });
  fs.writeFileSync(SNAP, JSON.stringify({ sums, props: readJson(path.join(DATA, "_props.json"), {}) }));
  console.log("Snapshot: " + Object.keys(sums).length + " files");
} else if (process.argv[2] === "push") {
  const snap = readJson(SNAP, { sums: {}, props: {} });
  const changed = files(DATA).filter(f => f !== "_props.json" && snap.sums[f] !== md5(f));
  // the changed files, staged with their paths, then one sync
  const stage = path.join(path.dirname(DATA), ".upload");
  fs.rmSync(stage, { recursive: true, force: true });
  changed.forEach(f => { const to = path.join(stage, f); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(DATA, f), to); });
  if (changed.length) aws(["s3", "sync", stage, BUCKET, "--content-type", "application/json"]);
  console.log("Uploaded " + changed.length + " changed files" + (changed.length ? ": " + changed.slice(0, 12).join(", ") + (changed.length > 12 ? "…" : "") : ""));
  // _props.json: the bucket's current copy, with this job's new or changed keys on top
  const mine = readJson(path.join(DATA, "_props.json"), {}), was = snap.props || {};
  const keys = Object.keys(mine).filter(k => was[k] !== mine[k]);
  if (keys.length) {
    const tmp = path.join(path.dirname(DATA), ".props-remote.json");
    try { aws(["s3", "cp", BUCKET + "/_props.json", tmp]); } catch (e) { fs.writeFileSync(tmp, "{}"); }
    const merged = Object.assign(readJson(tmp, {}), ...keys.map(k => ({ [k]: mine[k] })));
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 1));
    aws(["s3", "cp", tmp, BUCKET + "/_props.json", "--content-type", "application/json"]);
    console.log("Settings: " + keys.length + " keys updated (" + keys.slice(0, 8).join(", ") + (keys.length > 8 ? "…" : "") + ")");
  }
} else {
  console.log("usage: node tools/upload.js snapshot|push");
  process.exit(1);
}
