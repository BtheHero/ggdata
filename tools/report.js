// A report on the automatic jobs: every GitHub Actions run of the last days (did it succeed, which step failed), what
// each run said it did (its log's own summary lines: games, regions, prices, files uploaded), and every social media
// post, network by network (live, or the error). Read only: it changes nothing.
//
//   node tools/report.js [out-dir]      (default report/; REPORT_DAYS, default 7)
//
// Writes flat tables, one JSON array each: workflows.json (each workflow's week), runs.json (each run), steps.json (each
// step's own output), posts.json (each social post, network by network), queue.json (posts queued by the store runs).
//
// REPORT_CACHE=<file>: keeps the finished runs' details there and reads only new runs' jobs and logs next time.
//
// Needs the GitHub API: GITHUB_TOKEN (in Actions), or a proxy that signs the requests. GITHUB_REPOSITORY picks the repo
// (default BtheHero/ggdata).
const fs = require("fs"), path = require("path");
const REPO = process.env.GITHUB_REPOSITORY || "BtheHero/ggdata";
const DAYS = Number(process.env.REPORT_DAYS || 7);
const OUT = process.argv[2] || "report";
const ROOT = path.resolve(__dirname, "..");
const NETS = ["bluesky", "facebook", "instagram", "pinterest", "x"];
const headers = { Accept: "application/vnd.github+json", "User-Agent": "ggdata-report" };
if (process.env.GITHUB_TOKEN) headers.Authorization = "Bearer " + process.env.GITHUB_TOKEN;

async function gh(p, raw) {
  for (let i = 0; ; i++) {
    const r = await fetch(/^https:/.test(p) ? p : "https://api.github.com/repos/" + REPO + p, { headers }).catch(e => ({ ok: false, status: 0, e }));
    if (r.ok) return raw ? r.text() : r.json();
    if (r.status === 404 || r.status === 410 || i >= 3) throw new Error("GitHub " + r.status + " for " + p);
    await new Promise(res => setTimeout(res, 1500 * (i + 1)));
  }
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ---------- the workflows, from their files ----------
function workflows() {
  const dir = path.join(ROOT, ".github/workflows");
  return fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).map(f => {
    const t = fs.readFileSync(path.join(dir, f), "utf8");
    const about = []; for (const l of t.split("\n")) { if (/^#/.test(l)) about.push(l.replace(/^#\s?/, "")); else break; }
    const after = (t.match(/workflow_run:\s*\n\s*workflows:\s*\[([^\]]*)\]/) || [])[1];
    return {
      file: f, name: (t.match(/^name:\s*(.+)$/m) || [])[1] || f,
      about: about.join(" ").trim(),
      crons: [...t.matchAll(/cron:\s*"([^"]+)"/g)].map(m => m[1]),
      after: after ? after.split(",").map(s => s.trim()) : [],
      manual: /workflow_dispatch/.test(t),
    };
  });
}
// cron fields: minute hour day month weekday, with *, */n, a-b, lists (UTC)
function field(spec, v) {
  return spec.split(",").some(s => {
    const [r, step] = s.split("/"); const st = Number(step || 1);
    let lo, hi; if (r === "*") { lo = 0; hi = 99; } else if (r.includes("-")) [lo, hi] = r.split("-").map(Number); else { lo = Number(r); hi = step ? 99 : lo; }
    return v >= lo && v <= hi && (v - (r === "*" ? 0 : lo)) % st === 0;
  });
}
const cronHits = (c, d) => { const [mi, h, dom, mo, dow] = c.split(/\s+/);
  return field(mi, d.getUTCMinutes()) && field(h, d.getUTCHours()) && field(dom, d.getUTCDate()) && field(mo, d.getUTCMonth() + 1) && field(dow, d.getUTCDay()); };
function schedule(crons, from, to) {
  let expected = 0, next = null;
  const t0 = Math.ceil(from / 60000) * 60000;
  for (let t = t0; t < to + 7 * 864e5; t += 60000) {
    const d = new Date(t);
    if (crons.some(c => cronHits(c, d))) { if (t < to) expected++; else { next = d.toISOString(); break; } }
  }
  return { expected, next };
}

// ---------- a job's log: its steps' own output ----------
const NOISE = /^\[command\]|^\(node:\d+\)|^\(Use `node --trace|^shell: |^npm (warn|notice)|^added \d+ packages|^up to date|^Post job cleanup|^Cleaning up orphan/;
const KEY = /fail|error|not updated|not posted|posted|queued|uploaded|changes|settings|done|new|added|games|finished|snapshot|waiting|sent|deals|skipp|missing|warn/i;
function parseLog(text, job) {
  const steps = job.steps.filter(s => s.conclusion !== "skipped" && s.name !== "Set up job" && s.name !== "Complete job" && !/^Post Run /.test(s.name));
  const out = steps.map(s => ({ name: s.name, conclusion: s.conclusion, secs: s.started_at && s.completed_at ? (Date.parse(s.completed_at) - Date.parse(s.started_at)) / 1000 : null, lines: [] }));
  const errors = []; let k = -1, header = false, done = false;
  for (let line of text.split("\n")) {
    line = line.replace(/^﻿?\S+Z ?/, "").replace(/\x1b\[[0-9;]*m/g, "").replace(/\r$/, "");
    if (done) continue;
    if (/^##\[group\]Run /.test(line)) { k++; header = true; continue; }
    if (/^##\[endgroup\]/.test(line)) { header = false; continue; }
    if (/^##\[error\]/.test(line)) { errors.push((out[k] ? out[k].name + ": " : "") + line.slice(9)); continue; }
    if (/^Post job cleanup/.test(line)) { done = true; continue; }
    if (header || /^##\[/.test(line) || !line.trim() || NOISE.test(line)) continue;
    const s = out[k]; if (!s || /^Run actions\//.test(s.name)) continue;
    s.lines.push(line.length > 400 ? line.slice(0, 400) + "…" : line);
  }
  out.forEach(s => {   // long outputs: the lines that say something, and the end
    if (s.lines.length > 60) {
      const keep = new Set(s.lines.slice(-20)), imp = s.lines.filter(l => KEY.test(l) && !keep.has(l)).slice(0, 40);
      s.cut = s.lines.length; s.lines = imp.concat(["…"], s.lines.slice(-20));
    }
  });
  return { steps: out.filter(s => !/^Run actions\//.test(s.name)), errors };
}

// ---------- social posts, from the posting lines ----------
//   "  instagram: <title> → <id>"  /  "  x failed: <title>: <why>"  /  "Posted: <title>"  /  "Not posted anywhere: <title>"
function socialFrom(lines, run) {
  const posts = [], queued = []; let cur = {};
  for (const l of lines) {
    let m;
    if ((m = l.match(/^\s+(bluesky|facebook|instagram|pinterest|x) failed: (.*)$/))) cur[m[1]] = { ok: false, text: m[2] };
    else if ((m = l.match(/^\s+(bluesky|facebook|instagram|pinterest|x): (.*) → (.*)$/))) cur[m[1]] = { ok: true, ref: m[3] };
    else if ((m = l.match(/^(Posted|Not posted anywhere): (.*)$/))) {
      const title = m[2], nets = {};
      Object.keys(cur).forEach(n => { const v = cur[n]; nets[n] = v.ok ? { ok: true, ref: v.ref } : { ok: false, error: v.text.startsWith(title + ": ") ? v.text.slice(title.length + 2) : v.text }; });
      const ok = Object.values(nets).filter(v => v.ok).length;
      posts.push({ time: run.ended || run.created, title, store: /\(Xbox\)\s*$/.test(title) ? "Xbox" : /\(PlayStation\)\s*$/.test(title) ? "PlayStation" : "Weekly",
                   nets, status: ok === 0 ? "failed" : ok < Object.keys(nets).length ? "partial" : "posted", runId: run.id, wf: run.wf, url: run.url });
      cur = {};
    } else if ((m = l.match(/^Queued (\d+); (\d+) waiting in social\/(\w+)-queue\.json/))) queued.push({ time: run.ended || run.created, n: +m[1], waiting: +m[2], queue: m[3], wf: run.wf, url: run.url });
  }
  return { posts, queued };
}

// what a run uploaded: "Changes: {json}" (newer upload.js) or "Uploaded N changed files: a, b…"
function changesFrom(lines) {
  let total = 0, files = [], byFolder = null, settings = 0;
  for (const l of lines) {
    let m;
    if ((m = l.match(/^Changes: (\{.*\})$/))) { try { const j = JSON.parse(m[1]); byFolder = Object.assign(byFolder || {}, j.byFolder); files = files.concat(j.new || []); } catch (e) {} }
    else if ((m = l.match(/^Uploaded (\d+) changed files(?:: (.*))?$/))) { total += +m[1]; if (m[2] && !byFolder) files = files.concat(m[2].replace(/…$/, "").split(", ")); }
    else if ((m = l.match(/^Settings: (\d+) keys updated/))) settings += +m[1];
  }
  return { total, files: files.slice(0, 40), byFolder, settings };
}

(async () => {
  const now = Date.now(), from = now - DAYS * 864e5, since = new Date(from).toISOString().slice(0, 10);
  const wfs = workflows();
  const born = {};   // when each workflow was added: no runs were due before that
  (await gh("/actions/workflows?per_page=100")).workflows.forEach(w => { born[w.path.split("/").pop()] = Date.parse(w.created_at); });
  let runs = [], page = 1;
  for (;;) {
    const r = await gh("/actions/runs?per_page=100&created=>=" + since + "&page=" + page);
    runs = runs.concat(r.workflow_runs); if (r.workflow_runs.length < 100 || runs.length >= 2000) break; page++;
  }
  runs = runs.filter(r => Date.parse(r.created_at) >= from);
  console.log(runs.length + " runs since " + since);
  const CACHE = process.env.REPORT_CACHE, cached = {};
  if (CACHE) { try { JSON.parse(fs.readFileSync(CACHE, "utf8")).forEach(r => { cached[r.id + "-" + r.attempt] = r; }); } catch (e) {} }
  let reused = 0;
  const detailed = await pool(runs, 8, async r => {
    const hit = r.status === "completed" && cached[r.id + "-" + r.run_attempt];
    if (hit && hit.status === "completed") { reused++; return hit; }
    const run = { id: r.id, wf: r.name, file: r.path.split("/").pop(), event: r.event, attempt: r.run_attempt, number: r.run_number,
      status: r.status, conclusion: r.conclusion, created: r.created_at, started: r.run_started_at,
      ended: r.status === "completed" ? r.updated_at : null, url: r.html_url, commit: (r.head_commit && r.head_commit.message || "").split("\n")[0],
      secs: r.status === "completed" ? Math.round((Date.parse(r.updated_at) - Date.parse(r.run_started_at)) / 1000) : null,
      jobs: [], errors: [], failedSteps: [] };
    try {
      const jobs = (await gh("/actions/runs/" + r.id + "/jobs?per_page=50")).jobs;
      for (const j of jobs) {
        j.steps = j.steps || [];
        j.steps.filter(s => s.conclusion === "failure").forEach(s => run.failedSteps.push(j.name + " → " + s.name));
        let parsed = { steps: [], errors: [] };
        if (j.status === "completed") { try { parsed = parseLog(await gh("/actions/jobs/" + j.id + "/logs", true), j); } catch (e) { parsed.errors.push("log unavailable: " + e.message); } }
        run.jobs.push({ name: j.name, conclusion: j.conclusion, url: j.html_url, steps: parsed.steps });
        run.errors = run.errors.concat(parsed.errors);
      }
    } catch (e) { run.errors.push("jobs unavailable: " + e.message); }
    const lines = [].concat(...run.jobs.map(j => [].concat(...j.steps.map(s => s.lines))));
    run.changes = changesFrom(lines);
    const soc = socialFrom(lines, run); run.posts = soc.posts; run.queued = soc.queued;
    const q = lines.map(l => l.match(/^Social queue: (\d+) waiting; (.*)$/)).filter(Boolean).pop();
    if (q) run.queue = { waiting: +q[1], text: q[2] };
    run.warnings = lines.filter(l => /fail|NOT updated|not posted|error|isn't served/i.test(l)).slice(0, 30);
    return run;
  });
  detailed.sort((a, b) => b.created.localeCompare(a.created));
  if (CACHE) { fs.mkdirSync(path.dirname(path.resolve(CACHE)), { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(detailed.filter(r => r.status === "completed"))); }
  console.log((runs.length - reused) + " runs read from GitHub, " + reused + " from the cache");

  const wfOut = wfs.map(w => {
    const mine = detailed.filter(r => r.file === w.file), done = mine.filter(r => r.status === "completed");
    const sched = w.crons.length && born[w.file] ? schedule(w.crons, Math.max(from, born[w.file] || 0), now) : { expected: null, next: null };
    return Object.assign({}, w, {
      runs: mine.length, success: done.filter(r => r.conclusion === "success").length,
      failure: done.filter(r => r.conclusion === "failure").length,
      other: done.filter(r => !["success", "failure"].includes(r.conclusion)).length,
      running: mine.length - done.length, scheduledRuns: mine.filter(r => r.event === "schedule").length,
      expected: sched.expected, next: sched.next, added: born[w.file] ? new Date(born[w.file]).toISOString() : null,
      avgSecs: done.length ? Math.round(done.reduce((s, r) => s + (r.secs || 0), 0) / done.length) : null,
      last: mine[0] ? { id: mine[0].id, conclusion: mine[0].conclusion, status: mine[0].status, created: mine[0].created, url: mine[0].url } : null,
      lastSuccess: (done.find(r => r.conclusion === "success") || {}).created || null,
    });
  });
  const posts = [].concat(...detailed.map(r => r.posts)).sort((a, b) => b.time.localeCompare(a.time));
  const queued = [].concat(...detailed.map(r => r.queued)).sort((a, b) => b.time.localeCompare(a.time));
  const at = new Date(now).toISOString(), mins = s => s == null ? null : Math.round(s / 6) / 10;
  const BORING = /^(Snapshot: |FB_PAGE_TOKEN: |Copied |Uploaded |Changes: |Settings: |…$)/;
  const tables = {
    workflows: wfOut.map(w => ({
      workflow: w.name, file: w.file, about: w.about,
      schedule: w.crons.length ? w.crons.join(", ") + " (UTC)" : w.after.length ? "after " + w.after.join(" and ") : w.manual ? "by hand" : "",
      runs: w.runs, success: w.success, failure: w.failure, other: w.other, running: w.running,
      expected: w.expected, scheduled: w.scheduledRuns, missed: w.expected == null ? null : Math.max(0, w.expected - w.scheduledRuns),
      avgMinutes: mins(w.avgSecs), lastAt: w.last ? w.last.created : null, lastResult: w.last ? (w.last.conclusion || w.last.status) : "no runs",
      lastUrl: w.last ? w.last.url : null, lastSuccess: w.lastSuccess, next: w.next, generatedAt: at,
    })),
    runs: detailed.map(r => {
      const lines = [].concat(...r.jobs.map(j => [].concat(...j.steps.map(s => s.lines))));
      return { id: String(r.id), workflow: r.wf, event: r.event, result: r.conclusion || r.status, started: r.started || r.created, ended: r.ended,
        minutes: mins(r.secs), url: r.url, commit: r.commit, failedSteps: r.failedSteps.join("; "),
        problems: r.errors.concat(r.warnings).slice(0, 30).join("\n"),
        uploaded: r.changes.total, settings: r.changes.settings,
        folders: r.changes.byFolder ? Object.entries(r.changes.byFolder).map(([d, c]) => d + " " + (c.new + c.updated) + (c.new ? " (" + c.new + " new)" : "")).join(", ") : "",
        newFiles: r.changes.byFolder ? r.changes.files.join(", ") : "",
        posts: r.posts.length, postsOk: r.posts.filter(p => p.status !== "failed").length,
        waiting: r.queue ? r.queue.waiting : null, queueNote: r.queue ? r.queue.text : "",
        summary: lines.filter(l => !BORING.test(l)).slice(0, 40).join("\n") };
    }),
    steps: [].concat(...detailed.map(r => [].concat(...r.jobs.map(j => j.steps.map((s, k) => ({
      key: r.id + "-" + j.name + "-" + k, run: String(r.id), workflow: r.wf, job: j.name, step: s.name, result: s.conclusion, seconds: s.secs,
      lines: s.cut || s.lines.length, output: s.lines.join("\n") })))))),
    posts: posts.map((p, k) => Object.assign({ key: p.runId + "-" + k, time: p.time, title: p.title, store: p.store, status: p.status,
      networksOk: Object.values(p.nets).filter(v => v.ok).length, networksTried: Object.keys(p.nets).length },
      ...NETS.map(n => ({ [n]: !p.nets[n] ? "not tried" : p.nets[n].ok ? "live" : "failed" })),
      { errors: NETS.filter(n => p.nets[n] && !p.nets[n].ok).map(n => n + ": " + p.nets[n].error).join("\n"),
        refs: NETS.filter(n => p.nets[n] && p.nets[n].ok).map(n => n + ": " + p.nets[n].ref).join("\n"),
        workflow: p.wf, run: String(p.runId), url: p.url })),
    queue: queued.map((q, k) => ({ key: k, time: q.time, queue: q.queue, added: q.n, waiting: q.waiting, workflow: q.wf, url: q.url })),
  };
  fs.mkdirSync(OUT, { recursive: true });
  Object.entries(tables).forEach(([n, rows]) => fs.writeFileSync(path.join(OUT, n + ".json"), JSON.stringify(rows)));
  console.log("Report " + at + ": " + Object.entries(tables).map(([n, r]) => n + " " + r.length).join(", ") + " → " + OUT + "/");
})().catch(e => { console.error(e); process.exit(1); });
