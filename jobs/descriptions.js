// Every game's store description in the site's other languages, for its game pages in those languages (the site's
// lib/lang.js shows the language's text in place of the English one).
//
//   data/desc/<plat>-<lang>-<n>.json  {updatedAt, games: {id: text}}: the stores' own text; [text, 1] when it is a
//                                     machine translation (the store has none in that language). n: the game pages'
//                                     64 groups (shardOf). plat: xbox | ps. lang: es pt fr de it pl tr ru ja ko zh.
//   data/desc/<plat>-state.json      {id: [hash of the English text, day looked up (yyyymmdd)]}
//   data/desc/mt-batches.json        machine translations asked for and not collected yet
//
// The stores first: Xbox from Microsoft's catalog (20 games a request, one language at a time); PlayStation from the
// store's product data (one product and language a request: PS_DESC_MAX requests a run, new games first). A game is
// looked up again when its English description changes, or after STALE_DAYS. A language the store doesn't have is
// machine-translated from the English text; the store's own text replaces it when there is one. Two ways:
//   GitHub Models (free, the workflow's own GITHUB_TOKEN with the models: read permission): GH_MAX requests a run, within
//     the free tier's limits (about 150 requests a day, 15 a minute, 4000 tokens out a request), several languages a request;
//   the Claude API's Message Batches (when ANTHROPIC_API_KEY is set: used instead): asked for in one run, collected in a
//     later one, up to MT_MAX games a run.
const fs = require("fs"), path = require("path");

const SHARDS = 64;
const LANGS = ["es", "pt", "fr", "de", "it", "pl", "tr", "ru", "ja", "ko", "zh"];
// Microsoft's catalog: the language asked for (it answers with the closest it has, "neutral" for none)
const XBOX_LANG = { es: "es-es", pt: "pt-br", fr: "fr-fr", de: "de-de", it: "it-it", pl: "pl-pl", tr: "tr-tr", ru: "ru-ru", ja: "ja-jp", ko: "ko-kr", zh: "zh-cn" };
// PlayStation's store: the locale (Russian from the Ukrainian store, simplified Chinese from Hong Kong's)
const PS_LOCALE = { es: "es-ES", pt: "pt-BR", fr: "fr-FR", de: "de-DE", it: "it-IT", pl: "pl-PL", tr: "tr-TR", ru: "ru-UA", ja: "ja-JP", ko: "ko-KR", zh: "zh-Hans-HK" };
const LANG_NAME = { es: "Spanish (Spain)", pt: "Brazilian Portuguese", fr: "French", de: "German", it: "Italian", pl: "Polish", tr: "Turkish",
  ru: "Russian", ja: "Japanese", ko: "Korean", zh: "Simplified Chinese" };
const STALE_DAYS = 30;
const PS_DESC_MAX = Number(process.env.PS_DESC_MAX) || 12000;   // PlayStation requests a run
const MT_MAX = Number(process.env.MT_MAX) || 500;                 // games sent for machine translation a run
const MT_MODEL = process.env.TRANSLATE_MODEL || "claude-opus-5-5";
const GH_MODEL = process.env.GH_MODEL || "openai/gpt-4.1-mini";
const GH_MAX = Number(process.env.GH_MAX) || 140;                // GitHub Models requests a run (the free tier: 150 a day)
const GH_OUT = 3200;                                              // tokens a request's answer may take (the limit: 4000)
const GH_GAP_MS = Number(process.env.GH_GAP_MS ?? 4500);                                           // between requests (the limit: 15 a minute)
const PS_GQL = "https://web.np.playstation.com/api/graphql/v1/op";
const PS_PRODUCT_HASH = "a128042177bd93dd831164103d53b73ef790d56f51dae647064cb8f9d9fc9d1a";   // metGetProductById

function shardOf(id) {
  let h = 0;
  const s = String(id).toUpperCase();
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h % SHARDS;
}
const today = () => Number(new Date().toISOString().slice(0, 10).replace(/-/g, ""));
const daysAgo = n => Number(new Date(Date.now() - n * 864e5).toISOString().slice(0, 10).replace(/-/g, ""));
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return fallback; } };
const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
// the same cleaning as the English text (descText_ in gs/xbox.gs: tags, entities, "this edition includes" lists, length)
const clean = (short, long) => (typeof descText_ === "function" ? descText_(short, long) : String(long || short || "").trim()) || "";
const sameText = (a, b) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

// ---------- the files ----------
// the English descriptions: the game pages' data (data/<plat>_games_<n>.json, built by the pages jobs)
function english(dataDir, plat) {
  const out = {};
  for (let n = 0; n < SHARDS; n++) {
    const games = (readJson(path.join(dataDir, `${plat}_games_${n}.json`), {}).games) || {};
    Object.keys(games).forEach(id => { const g = games[id]; if (g && !g.a && g.d && String(g.d).trim()) out[id] = { en: String(g.d).trim(), pid: g.pi || id }; });
  }
  return out;
}
function loadLang(dir, plat, lang) {
  const all = {};
  for (let n = 0; n < SHARDS; n++) Object.assign(all, (readJson(path.join(dir, `${plat}-${lang}-${n}.json`), {}).games) || {});
  return all;
}
function saveLang(dir, plat, lang, all) {
  const shards = Array.from({ length: SHARDS }, () => ({}));
  Object.keys(all).forEach(id => { shards[shardOf(id)][id] = all[id]; });
  const now = new Date().toISOString();
  shards.forEach((games, n) => {
    const f = path.join(dir, `${plat}-${lang}-${n}.json`);
    const old = readJson(f, null);
    if (old && JSON.stringify(old.games) === JSON.stringify(games)) return;   // unchanged: not uploaded again
    fs.writeFileSync(f, JSON.stringify({ updatedAt: now, games }));
  });
}
const isMt = v => Array.isArray(v);

// ---------- the stores ----------
// Xbox: Microsoft's catalog, 20 products a request, in one language
function xboxLookup(need, loc, stats) {
  const ids = Object.keys(need);
  for (let i = 0; i < ids.length; i += 200) {
    const groups = [];
    for (let j = i; j < Math.min(i + 200, ids.length); j += 20) groups.push(ids.slice(j, j + 20));
    for (const lang of LANGS) {
      const res = UrlFetchApp.fetchAll(groups.map(g => ({ muteHttpExceptions: true,
        url: "https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=" + g.join(",") + "&market=US&languages=" + XBOX_LANG[lang] + "&MS-CV=DGU1mcuYo0WMMp%2BF.1" })));
      groups.forEach((g, k) => {
        let products = [];
        try { products = JSON.parse(res[k].getContentText()).Products || []; } catch (e) { stats.failed++; return; }
        products.forEach(p => {
          const id = String(p.ProductId || "").toUpperCase(), lp = (p.LocalizedProperties || [])[0];
          if (!need[id] || !lp) return;
          need[id].seen = true;
          // the language asked for ("es", "es-es", "es-019"...); "neutral" or another one: the store has none
          if (!String(lp.Language || "").toLowerCase().startsWith(lang)) return;
          const t = clean(lp.ShortDescription, lp.ProductDescription);
          if (t && !sameText(t, need[id].en)) { loc[lang][id] = t; stats.store++; }
        });
      });
    }
    Utilities.sleep(200);
  }
}
// PlayStation: the store's product data, one product and language a request
function psLookup(need, loc, stats, budget) {
  const jobs = [];
  Object.keys(need).forEach(id => LANGS.forEach(lang => jobs.push([id, lang])));
  const todo = jobs.slice(0, budget);
  const done = {};
  for (let i = 0; i < todo.length; i += 10) {
    const group = todo.slice(i, i + 10);
    const res = UrlFetchApp.fetchAll(group.map(([id, lang]) => ({ muteHttpExceptions: true,
      url: PS_GQL + "?operationName=metGetProductById&variables=" + encodeURIComponent(JSON.stringify({ productId: need[id].pid })) +
        "&extensions=" + encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: PS_PRODUCT_HASH } })),
      headers: { "x-psn-store-locale-override": PS_LOCALE[lang], "content-type": "application/json" } })));
    group.forEach(([id, lang], k) => {
      let prod = null;
      try { const j = JSON.parse(res[k].getContentText()); prod = j && j.data && j.data.productRetrieve; } catch (e) {}
      if (!prod) { stats.failed++; return; }
      done[id] = (done[id] || 0) + 1;
      const d = {};
      (prod.descriptions || []).forEach(x => { d[x.type] = x.value; });
      const t = clean(d.SHORT, d.LONG);
      if (t && !sameText(t, need[id].en)) { loc[lang][id] = t; stats.store++; }
    });
    if (stats.failed > 300 && stats.failed > stats.store) { console.log("PlayStation: too many failures, stopping for this run"); break; }
    Utilities.sleep(250);
  }
  // games looked up in every language this run
  Object.keys(done).forEach(id => { if (done[id] === LANGS.length) need[id].seen = true; });
}

// ---------- machine translation (the Message Batches API) ----------
const SYSTEM = "You translate video game store descriptions from English. Translate the description into each language " +
  "asked for, as a natural, fluent store description for players in that language. Keep game titles, names of characters, " +
  "places, studios and products, and trademark signs (™ ®) exactly as they are in English. Keep the paragraph and line " +
  "breaks. Translate everything else, without adding, leaving out or commenting on anything.";
function mtRequest(key, en, langs) {
  const schema = { type: "object", properties: {}, required: langs, additionalProperties: false };
  langs.forEach(l => { schema.properties[l] = { type: "string" }; });
  return { custom_id: key, params: {
    model: MT_MODEL, max_tokens: 16000, system: SYSTEM,
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: "Languages: " + langs.map(l => `${l} (${LANG_NAME[l]})`).join(", ") + "\n\nDescription:\n" + en }] } };
}
// ---------- machine translation (GitHub Models) ----------
// the tokens a language's translation takes, about (languages not in the Latin alphabet: more)
const outTokens = (en, l) => Math.ceil(en.length / 4 * (["ru", "ja", "ko", "zh"].includes(l) ? 2 : 1.4)) + 20;
// the languages a game still needs, in groups that fit one answer
function packLangs(en, langs) {
  const groups = [];
  let cur = [], size = 0;
  for (const l of langs) {
    const t = outTokens(en, l);
    if (t > GH_OUT) continue;
    if (cur.length && size + t > GH_OUT) { groups.push(cur); cur = []; size = 0; }
    cur.push(l); size += t;
  }
  if (cur.length) groups.push(cur);
  return groups;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ghTranslate(en, langs) {
  const res = await fetch("https://models.github.ai/inference/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/vnd.github+json", authorization: "Bearer " + process.env.GITHUB_TOKEN },
    body: JSON.stringify({ model: GH_MODEL, max_tokens: 4000, temperature: 0.2, response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM + " Answer with a JSON object: one key per language code asked for, the translation as its value." },
        { role: "user", content: "Languages: " + langs.map(l => `${l} (${LANG_NAME[l]})`).join(", ") + "\n\nDescription:\n" + en }] }) });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`); e.status = res.status; throw e; }
  const j = await res.json(), c = j.choices && j.choices[0];
  if (!c || c.finish_reason !== "stop") throw new Error("answer cut off (" + (c && c.finish_reason) + ")");
  const out = JSON.parse(c.message.content), got = {};
  langs.forEach(l => { const v = typeof out[l] === "string" ? out[l].trim() : ""; if (v && !sameText(v, en)) got[l] = v; });
  return got;
}
async function githubModels(all, loc) {
  let used = 0, got = 0, failed = 0, inRow = 0;
  outer:
  for (const plat of ["xbox", "ps"]) {
    for (const id of Object.keys(all[plat])) {
      const g = all[plat][id];
      if (!g.seen) continue;   // (only games the stores have been asked about)
      for (const langs of packLangs(g.en, LANGS.filter(l => !loc[plat][l][id]))) {
        if (used >= GH_MAX) break outer;
        if (used) await sleep(GH_GAP_MS);
        used++;
        try {
          const out = await ghTranslate(g.en, langs);
          Object.keys(out).forEach(l => { loc[plat][l][id] = [out[l], 1]; got++; });
          inRow = 0;
        } catch (e) {
          failed++; inRow++;
          if (e.status === 429) { console.log("GitHub Models: the free tier's limit reached, stopping for this run (" + e.message + ")"); break outer; }
          if (e.status === 401 || e.status === 403) { console.log("GitHub Models: not allowed (" + e.message + "): the workflow needs the models: read permission"); break outer; }
          if (inRow >= 5) { console.log("GitHub Models: 5 failures in a row, stopping for this run (" + e.message + ")"); break outer; }
        }
      }
    }
  }
  console.log(`Machine translation (GitHub Models, ${GH_MODEL}): ${used} requests, ${got} descriptions, ${failed} failed`);
}

async function machineTranslate(dir, all, loc) {
  if (!process.env.ANTHROPIC_API_KEY) {
    if (process.env.GITHUB_TOKEN) return githubModels(all, loc);
    console.log("Machine translation: skipped (no GITHUB_TOKEN or ANTHROPIC_API_KEY)"); return;
  }
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic();
  const file = path.join(dir, "mt-batches.json");
  let pending = readJson(file, []);
  // 1. the batches asked for in earlier runs: the translations of those that have ended
  const still = [];
  for (const b of pending) {
    let batch;
    try { batch = await client.messages.batches.retrieve(b.id); }
    catch (e) { console.log("Machine translation: batch " + b.id + " not found (" + e.message + "), dropped"); continue; }
    if (batch.processing_status !== "ended") { still.push(b); continue; }
    let got = 0, failed = 0;
    for await (const r of await client.messages.batches.results(b.id)) {
      const item = b.items[r.custom_id];
      if (!item) continue;
      const [plat, id, hashEn] = item;
      if (r.result.type !== "succeeded" || r.result.message.stop_reason !== "end_turn") { failed++; continue; }
      const text = r.result.message.content.filter(c => c.type === "text").map(c => c.text).join("");
      let out;
      try { out = JSON.parse(text); } catch (e) { failed++; continue; }
      const g = all[plat][id];
      if (!g || hash(g.en) !== hashEn) continue;   // the English text has changed since: asked for again
      Object.keys(out).forEach(lang => {
        const v = String(out[lang] || "").trim();
        if (LANG_NAME[lang] && v && !(loc[plat][lang][id] && !isMt(loc[plat][lang][id]))) { loc[plat][lang][id] = [v, 1]; got++; }
      });
    }
    console.log(`Machine translation: batch ${b.id} collected, ${got} descriptions (${failed} failed)`);
  }
  // 2. a new batch: the games with a language that has neither the store's text nor a translation (not already asked for)
  const asked = new Set(still.flatMap(b => Object.values(b.items).map(([plat, id]) => plat + ":" + id)));
  const requests = [], items = {};
  for (const plat of ["xbox", "ps"]) {
    for (const id of Object.keys(all[plat])) {
      if (requests.length >= MT_MAX) break;
      if (asked.has(plat + ":" + id) || !all[plat][id].seen) continue;   // (only games the stores have been asked about)
      const langs = LANGS.filter(l => !loc[plat][l][id]);
      if (!langs.length) continue;
      const key = "d" + requests.length;
      requests.push(mtRequest(key, all[plat][id].en, langs));
      items[key] = [plat, id, hash(all[plat][id].en)];
    }
  }
  if (requests.length) {
    const batch = await client.messages.batches.create({ requests });
    still.push({ id: batch.id, created: new Date().toISOString(), items });
    console.log(`Machine translation: asked for ${requests.length} games (batch ${batch.id}, model ${MT_MODEL})`);
  } else console.log("Machine translation: nothing new to translate");
  fs.writeFileSync(file, JSON.stringify(still));
}

// ---------- the job ----------
async function descriptions(dataDir) {
  const dir = path.join(dataDir, "desc");
  fs.mkdirSync(dir, { recursive: true });
  const all = {}, loc = {};
  for (const plat of ["xbox", "ps"]) {
    all[plat] = english(dataDir, plat);
    loc[plat] = {};
    LANGS.forEach(l => { loc[plat][l] = loadLang(dir, plat, l); });
    const state = readJson(path.join(dir, `${plat}-state.json`), {});
    // games that left the store or lost their description
    LANGS.forEach(l => Object.keys(loc[plat][l]).forEach(id => { if (!all[plat][id]) delete loc[plat][l][id]; }));
    Object.keys(state).forEach(id => { if (!all[plat][id]) delete state[id]; });
    // to look up: new games, changed English text, or looked up longest ago (over STALE_DAYS)
    const stale = daysAgo(STALE_DAYS), need = {};
    Object.keys(all[plat]).forEach(id => {
      const s = state[id], h = hash(all[plat][id].en);
      if (!s || s[0] !== h || s[1] < stale) {
        need[id] = all[plat][id];
        if (s && s[0] !== h) LANGS.forEach(l => { delete loc[plat][l][id]; });   // the old text's translations
      } else all[plat][id].seen = true;
    });
    const order = Object.keys(need).sort((a, b) => (state[a] ? state[a][1] : 0) - (state[b] ? state[b][1] : 0));   // never looked up first
    const sorted = {};
    order.forEach(id => { sorted[id] = need[id]; });
    const stats = { store: 0, failed: 0 };
    if (plat === "xbox") xboxLookup(sorted, loc[plat], stats);
    else psLookup(sorted, loc[plat], stats, PS_DESC_MAX);
    let seen = 0;
    Object.keys(sorted).forEach(id => { if (sorted[id].seen) { state[id] = [hash(sorted[id].en), today()]; seen++; } });
    fs.writeFileSync(path.join(dir, `${plat}-state.json`), JSON.stringify(state));
    const have = l => Object.values(loc[plat][l]).filter(v => !isMt(v)).length, mt = l => Object.values(loc[plat][l]).filter(isMt).length;
    console.log(`${plat}: ${Object.keys(all[plat]).length} games with a description; ${seen} of ${order.length} due looked up (${stats.store} store texts, ${stats.failed} failed requests)`);
    console.log(`${plat}: ` + LANGS.map(l => `${l} ${have(l)}+${mt(l)}`).join(", ") + " (store + machine-translated)");
  }
  try { await machineTranslate(dir, all, loc); } catch (e) { console.log("Machine translation failed: " + e.message); }
  for (const plat of ["xbox", "ps"]) LANGS.forEach(l => saveLang(dir, plat, l, loc[plat][l]));
}

module.exports = { descriptions, shardOf, LANGS, packLangs };
