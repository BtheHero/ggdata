// Uploads the game pages made by the site's tools/prerender.mjs (the prerender workflow) to the bucket's pages/ folder,
// where the site reads them (gtracker lib/prerendered.js).
//
//   node tools/upload-pages.js <out dir> <run id>
//
// The packs go up first and the indexes after, so an index never points at a pack that isn't there yet. Then the
// older packs are deleted, keeping each shard's previous one: the site keeps an index for a few minutes (up to an hour
// when the bucket is slow to answer), and an index it still holds may point at it.
// Needs R2 (endpoint) and the AWS_* keys in the environment, like the aws commands in the workflows.
const path = require("path"), { execFileSync } = require("child_process");
const [outDir, run] = process.argv.slice(2);
if (!outDir || !run) { console.log("usage: node tools/upload-pages.js <out dir> <run id>"); process.exit(1); }
const aws = (args, opts) => execFileSync("aws", args.concat(["--endpoint-url", process.env.R2, "--only-show-errors"]), opts || { stdio: "inherit" });
const SRC = path.join(path.resolve(outDir), "pages"), BUCKET = "s3://ggdata/pages";

aws(["s3", "sync", SRC, BUCKET, "--exclude", "*.json", "--content-type", "application/octet-stream"]);
aws(["s3", "sync", SRC, BUCKET, "--exclude", "*", "--include", "*.json", "--content-type", "application/json"]);
console.log("Uploaded the pages of run " + run);

// pages/<plat>/<n>/<run>.bin: by shard, newest first; all but the two newest deleted
const keys = aws(["s3", "ls", BUCKET + "/", "--recursive"], { encoding: "utf8" }).split("\n").map(l => l.trim().split(/\s+/).pop()).filter(Boolean);
const byShard = {};
keys.forEach(k => { const m = /^pages\/(\w+)\/(\d+)\/(\d+)\.bin$/.exec(k); if (m) (byShard[m[1] + "/" + m[2]] = byShard[m[1] + "/" + m[2]] || []).push([Number(m[3]), k]); });
let removed = 0;
Object.values(byShard).forEach(list => {
  list.sort((a, b) => b[0] - a[0]).slice(2).forEach(([, k]) => { aws(["s3", "rm", "s3://ggdata/" + k]); removed++; });
});
console.log("Removed " + removed + " older packs");
