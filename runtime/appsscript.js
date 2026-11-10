// Stand-ins for the Google Apps Script services the jobs use, so the same code runs on GitHub Actions:
//   UrlFetchApp      -> curl (fetchAll runs the requests in parallel)
//   DriveApp         -> files in DATA_DIR (a file's id is its name); the workflow syncs that folder with the bucket
//   PropertiesService-> DATA_DIR/_props.json
//   Utilities, Logger, CacheService, LockService, ScriptApp (triggers do nothing: GitHub runs the schedule)
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");

const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-"));
const stats = { requests: 0 };

// ---------- UrlFetchApp ----------
function curlArgs(url, o, bodyFile) {
  o = o || {};
  const a = ["-sS", "--compressed", "--max-time", "60", "-o", "-", "-w", "\n%{http_code}", "-A", "Mozilla/5.0 (compatible; ggdata)"];
  const method = String(o.method || (o.payload !== undefined ? "post" : "get")).toUpperCase();
  if (method !== "GET") a.push("-X", method);
  Object.entries(o.headers || {}).forEach(([k, v]) => a.push("-H", k + ": " + v));
  if (o.payload !== undefined) {
    if (o.contentType) a.push("-H", "Content-Type: " + o.contentType);
    a.push("--data-binary", "@" + bodyFile);
  }
  if (o.followRedirects !== false) a.push("-L");
  a.push(url);
  return a;
}
function response(out, url, o) {
  const i = out.lastIndexOf("\n");
  const body = i >= 0 ? out.slice(0, i) : "", code = i >= 0 ? Number(out.slice(i + 1)) || 0 : 0;
  if (!code && !(o && o.muteHttpExceptions)) throw new Error("Request failed: " + url);
  if (code >= 400 && !(o && o.muteHttpExceptions)) throw new Error("Request failed for " + url + " returned code " + code);
  return {
    getResponseCode: () => code,
    getContentText: () => body,
    getBlob: () => ({ getDataAsString: () => body }),
    getHeaders: () => ({}), getAllHeaders: () => ({})
  };
}
let reqN = 0;
function bodyFileFor(o) {
  if (!o || o.payload === undefined) return null;
  const f = path.join(TMP, "b" + (reqN++));
  fs.writeFileSync(f, typeof o.payload === "string" ? o.payload : JSON.stringify(o.payload));
  return f;
}
global.UrlFetchApp = {
  fetch(url, o) {
    stats.requests++;
    const bf = bodyFileFor(o);
    let out = "";
    try { out = execFileSync("curl", curlArgs(url, o, bf), { maxBuffer: 1 << 30, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
    catch (e) { out = (e.stdout || "") + ""; if (!/\n\d{3}$/.test(out)) out += "\n0"; }
    return response(out, url, o);
  },
  // all requests at once, like Apps Script (which runs them in parallel too)
  fetchAll(reqs) {
    stats.requests += reqs.length;
    const outs = reqs.map((r, i) => path.join(TMP, "o" + (reqN++) + "_" + i));
    const sh = reqs.map((r, i) => {
      const o = typeof r === "string" ? {} : r, url = typeof r === "string" ? r : r.url;
      const args = curlArgs(url, o, bodyFileFor(o)).map(x => "'" + String(x).replace(/'/g, "'\\''") + "'");
      return "curl " + args.join(" ") + " > '" + outs[i] + "' 2>/dev/null &";
    }).join("\n") + "\nwait";
    spawnSync("bash", ["-c", sh], { stdio: "ignore", maxBuffer: 1 << 20 });
    return reqs.map((r, i) => {
      let out = "";
      try { out = fs.readFileSync(outs[i], "utf8"); fs.unlinkSync(outs[i]); } catch (e) {}
      if (!/\n\d{3}$/.test(out)) out += "\n0";
      return response(out, typeof r === "string" ? r : r.url, Object.assign({ muteHttpExceptions: true }, typeof r === "string" ? {} : r));
    });
  }
};

// ---------- Files ----------
function file(id) {
  const p = path.join(DATA_DIR, id);
  return {
    getId: () => id, getName: () => id, isTrashed: () => false, getUrl: () => "data/" + id,
    setContent(c) { fs.writeFileSync(p, c); return this; },
    getBlob: () => ({ getDataAsString: () => fs.readFileSync(p, "utf8") })
  };
}
const safe = name => String(name).replace(/[^A-Za-z0-9._-]/g, "_");
global.DriveApp = {
  getFileById(id) {
    if (!fs.existsSync(path.join(DATA_DIR, safe(id)))) throw new Error("No file " + id);
    return file(safe(id));
  },
  createFile(name, content) {
    fs.writeFileSync(path.join(DATA_DIR, safe(name)), content || "");
    return file(safe(name));
  }
};

// ---------- Script properties ----------
const PROPS = path.join(DATA_DIR, "_props.json");
let props = {};
try { props = JSON.parse(fs.readFileSync(PROPS, "utf8")); } catch (e) {}
const saveProps = () => fs.writeFileSync(PROPS, JSON.stringify(props, null, 1));
const store = {
  getProperty: k => (k in props ? String(props[k]) : null),
  setProperty(k, v) { props[k] = String(v); saveProps(); return store; },
  setProperties(o) { Object.keys(o).forEach(k => { props[k] = String(o[k]); }); saveProps(); return store; },
  deleteProperty(k) { delete props[k]; saveProps(); return store; },
  getProperties: () => Object.assign({}, props)
};
global.PropertiesService = { getScriptProperties: () => store };

// ---------- The rest ----------
global.Logger = { log: m => console.log(String(m)) };
global.Utilities = {
  sleep: ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(ms, 60000)),
  // only the UTC formats the jobs use
  formatDate(d, tz, f) {
    const p = n => String(n).padStart(2, "0");
    return String(f).replace("yyyy", d.getUTCFullYear()).replace("MM", p(d.getUTCMonth() + 1)).replace("dd", p(d.getUTCDate()))
      .replace("HH", p(d.getUTCHours())).replace("mm", p(d.getUTCMinutes())).replace("ss", p(d.getUTCSeconds()));
  },
  base64Encode: s => Buffer.from(Array.isArray(s) ? Buffer.from(s) : String(s)).toString("base64"),
  base64Decode: s => [...Buffer.from(String(s), "base64")],
  DigestAlgorithm: { SHA_256: "sha256", MD5: "md5", SHA_1: "sha1" },
  computeDigest: (alg, s) => [...crypto.createHash(alg).update(String(s)).digest()].map(b => (b > 127 ? b - 256 : b)),
  getUuid: () => crypto.randomUUID()
};
const memo = {};
global.CacheService = { getScriptCache: () => ({ get: k => (k in memo ? memo[k] : null), put: (k, v) => { memo[k] = String(v); }, remove: k => { delete memo[k]; } }) };
global.LockService = { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, hasLock: () => true, releaseLock() {} }) };
const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain });
global.ScriptApp = { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: () => chain };
global.ContentService = { MimeType: { JSON: "json" }, createTextOutput: t => ({ setMimeType: () => ({ text: t }) }) };

// Loads .gs files into one shared global scope, like an Apps Script project
// (extra: code run in the same scope, e.g. to hand constants back to run.js)
function load(files, extra) {
  const src = files.map(f => fs.readFileSync(f, "utf8")).join("\n;\n") + "\n;\n" + (extra || "");
  (0, eval)(src);
}
module.exports = { load, stats, DATA_DIR };
