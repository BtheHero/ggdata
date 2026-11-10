// Runs one job: node run.js <job>
//   xbox   the Xbox US export, then every other region
//   media  screenshots, trailers, key art and genres of every game
// The files it reads and writes are in data/ (the workflow downloads them from the bucket first and uploads them after).
const rt = require("./runtime/appsscript");
const job = process.argv[2];
const t0 = Date.now();
const secs = () => Math.round((Date.now() - t0) / 1000) + " s";

rt.load(["gs/common.gs", "gs/xbox.gs"], "global.__XBOX = { REGIONS: REGIONS };");

const jobs = {
  // screenshots, trailers, key art and genres of every game (jobs/media.js); PlayStation's game list comes from the
  // site's data service (seed.js copies it to SRC_DIR)
  media() {
    const media = require("./jobs/media");
    media.xboxMedia(rt.DATA_DIR);
    console.log("== Xbox done (" + secs() + ")");
    media.psMedia(rt.DATA_DIR, process.env.SRC_DIR || "src");
  },
  xbox() {
    exportUS_();
    console.log("== US done (" + secs() + ")");
    let failed = 0;
    Object.keys(__XBOX.REGIONS).filter(r => r !== "US").forEach(code => {
      let ok = false;
      try { ok = exportRegion_(code); } catch (e) { console.log(code + " failed: " + e.message); }
      if (!ok) failed++;
      console.log("== " + code + (ok ? " done" : " NOT updated") + " (" + secs() + ")");
    });
    if (failed) process.exitCode = 1;
  }
};

if (!jobs[job]) { console.log("Unknown job: " + job + ". Jobs: " + Object.keys(jobs).join(", ")); process.exit(2); }
jobs[job]();
console.log("Finished " + job + ": " + rt.stats.requests + " requests, " + secs());
