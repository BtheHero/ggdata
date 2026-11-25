// Sale and price alerts, sent after each Xbox and PlayStation run (.github/workflows/alerts.yml).
//
// Who: the site's accounts with alerts on (POST {action: "alert_subs", key: ALERT_KEY} to SOURCE_API): their wishlist,
// target prices ({game id: price}), email (when email alerts are on) and push subscriptions.
// What: a game on the wishlist that's on sale in the person's store (the region picked on the site, u.region), or any game that reached its price alert: at or below a
// price in a region's store and currency, or at least N% off there ({game id: US price (older alerts), {p, c, r} or {pct, r}},
// lib/accounts.js fb_target in the site), from that region's price file (<xbox|ps>_prices_<region>.json).
// Each person gets at most one email and one notification a run, listing everything new. A game is only mentioned again
// when its price drops further, or after its sale ended and a new one started (data/alerts_sent.json remembers).
//
// Secrets: SOURCE_API (or ALERTS_API + SITE_URL), ALERT_KEY, RESEND_API_KEY (email), VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (push),
// FCM_SERVICE_ACCOUNT (the app's notifications: the Firebase project's service account key, the whole JSON file).
// ALERTS_DRY=1: logs what would be sent and sends nothing.
const fs = require("fs"), path = require("path");
const { alertText } = require("./alert-text");   // the words, in the person's language (u.lang)
const DATA = path.resolve(process.env.DATA_DIR || "data");
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")); } catch (e) { return d; } };
const DRY = !!process.env.ALERTS_DRY;
// ALERTS_API: where to ask for the alert list. The workflow points it at the site's pages.dev address, because
// Cloudflare's Bot Fight Mode on gamedealtrack.com challenges requests from GitHub's runners and can't be skipped
// for one path on the free plan. SITE_URL: the address put in the emails and notifications (the real domain).
const API = process.env.ALERTS_API || process.env.SOURCE_API;
const SITE = (process.env.SITE_URL || (process.env.SOURCE_API ? new URL(process.env.SOURCE_API).origin : "")).replace(/\/+$/, "");
const XIMG = "https://store-images.s-microsoft.com/image/";
const slug = t => String(t || "game").toLowerCase().normalize("NFKD").replace(/[™®©]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "game";
const tNorm = t => typeof t === "number" ? { p: t, c: "USD", r: "US", pct: 0 } : t && typeof t === "object" ? { p: Number(t.p) || 0, c: t.c || "USD", r: t.r || "US", pct: Number(t.pct) || 0 } : null;
const tText = (L, t) => t.pct ? L.pctOff(t.pct) : L.money(t.p, t.c);
const pctOf = x => x.msrp > x.price && x.price > 0 ? Math.round((1 - x.price / x.msrp) * 100) : 0;
// a region's price file, by id in capitals (read once)
const regFiles = {};
function regionPrices(plat, code) {
  const k = plat + code;
  if (!(k in regFiles)) {
    const f = read((plat === "ps" ? "ps" : "xbox") + "_prices_" + code + ".json", null);
    let up = null;
    if (f && f.prices && f.currency) { up = {}; Object.keys(f.prices).forEach(id => { up[id.toUpperCase()] = f.prices[id]; }); }
    regFiles[k] = up ? { up, currency: f.currency, region: code } : null;
  }
  return regFiles[k];
}
// a game (prices() entry) priced in a region's store, or null when that region's file doesn't have it
function inRegion(id, x, code) {
  if (code === "US") return x;
  const f = regionPrices(x.plat, code);
  const p = f && [x.key, id, x.pid].filter(Boolean).map(k => f.up[String(k).toUpperCase()]).find(Boolean);
  return p ? Object.assign({}, x, { price: Number(p[0]) || 0, msrp: Number(p[1]) || Number(p[0]) || 0, currency: f.currency, region: code, ends: null }) : null;
}
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- the app's notifications (Firebase Cloud Messaging) ----------
// A Google access token from the service account (a signed JWT exchanged at Google's token endpoint), then one
// request per phone. Phones Firebase says are gone (uninstalled, signed out) are reported back like browsers.
let FCM = null;
async function fcmSetup() {
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  let sa;
  try { sa = JSON.parse(raw); } catch (e) { console.log("FCM_SERVICE_ACCOUNT isn't valid JSON: no app notifications"); return null; }
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url"), now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "RS256", typ: "JWT" }), body = b64({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const sig = require("crypto").createSign("RSA-SHA256").update(head + "." + body).sign(sa.private_key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + head + "." + body + "." + sig });
  const t = await r.json().catch(() => ({}));
  if (!t.access_token) { console.log("Firebase didn't give an access token (" + r.status + "): no app notifications"); return null; }
  return { project: sa.project_id, token: t.access_token };
}
// true: sent; "gone": the phone's token is no longer valid; false: failed
async function fcmSend(token, n) {
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${FCM.project}/messages:send`, { method: "POST",
    headers: { Authorization: "Bearer " + FCM.token, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { token, notification: { title: n.title, body: n.body }, data: { url: n.url, tag: n.tag },
      android: { collapse_key: n.tag, notification: { tag: n.tag, channel_id: "deals" } }, apns: { headers: { "apns-collapse-id": n.tag } } } }) });
  if (r.ok) return true;
  const e = await r.text();
  if (r.status === 404 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT/.test(e) && /token/i.test(e)) return "gone";
  console.log("App notification failed (" + r.status + "): " + e.slice(0, 200));
  return false;
}

// Every game's US price: the full lists, then the deals (more exact: sale end, editions on sale)
function prices() {
  const info = {};
  [["xbox", "xbox_catalog.json", "xbox_sales.json"], ["ps", "ps_catalog.json", "ps_sales.json"]].forEach(([plat, cat, sales]) => {
    (read(cat, { games: [] }).games || []).forEach(r => {
      if (!r[0] || !r[1]) return;
      info[r[0]] = { plat, title: r[1], price: Number(r[3]) || 0, msrp: Number(r[4]) || Number(r[3]) || 0, image: r[6] || "", pid: plat === "ps" ? r[13] || "" : "" };
    });
    (read(sales, { games: [] }).games || []).forEach(g => {
      if (!g.productId || !g.title || (g.saleEnds && Date.parse(g.saleEnds) <= Date.now())) return;
      info[g.productId] = { plat, title: g.title, price: Number(g.price) || 0, msrp: Number(g.msrp) || 0, image: g.image || "", ends: g.saleEnds || null, key: g.key || "" };
    });
  });
  // a PS4 or PS5 version merged into the other one's deal (gs/ps.gs psMergeVersions_): the kept deal's price
  const dups = read("ps_sales.json", {}).dups || {};
  Object.keys(dups).forEach(id => { const k = info[dups[id]]; if (k && k.ends !== undefined) info[id] = Object.assign({}, k, { page: dups[id] }); });
  Object.values(info).forEach(x => { if (x.image && !/^https?:/.test(x.image)) x.image = XIMG + x.image; });
  return info;
}
const pageUrl = (L, id, x) => SITE + L.path(`/game/${x.plat}/${encodeURIComponent(x.page || id)}/${slug(x.title)}`);
const unsubUrl = (L, u) => `${SITE}/api?action=unsub&u=${encodeURIComponent(u.uid)}&t=${encodeURIComponent(u.unsub)}${L.lang === "en" ? "" : "&l=" + L.lang}`;

function emailHtml(L, u, items) {
  const fmt = L.money;
  const rows = items.map(({ id, x, kind, target }) => {
    const pct = pctOf(x), store = x.region && x.region !== "US" ? ` · ${L.store(L.region(x.region))}` : "";
    const why = kind === "target" ? L.yourAlert(tText(L, target)) + store : x.ends ? L.ends(L.date(x.ends)) : L.onSale;
    return `<tr><td style="padding:10px 12px 10px 0;width:64px"><a href="${pageUrl(L, id, x)}"><img src="${esc(x.image)}${x.image.includes("?") ? "" : "?w=128"}" width="64" alt="" style="display:block;border-radius:8px"></a></td>
      <td style="padding:10px 0"><a href="${pageUrl(L, id, x)}" style="color:#0b1f17;font-weight:700;text-decoration:none">${esc(x.title)}</a>
      <div style="margin-top:4px"><b style="color:#0d8a5f;font-size:16px">${fmt(x.price, x.currency)}</b>${pct ? ` <s style="color:#777">${fmt(x.msrp, x.currency)}</s> <span style="background:#ffd166;border-radius:6px;padding:1px 6px;font-weight:700;font-size:13px">-${pct}%</span>` : ""}</div>
      <div style="color:#666;font-size:13px;margin-top:2px">${x.plat === "ps" ? "PlayStation" : "Xbox"} · ${esc(why)}</div></td></tr>`;
  }).join("");
  const unsub = unsubUrl(L, u);
  return `<!DOCTYPE html><html lang="${L.lang}"><body style="margin:0;background:#f3f6f4;font-family:Arial,Helvetica,sans-serif;color:#0b1f17">
    <div style="max-width:560px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border-radius:14px;padding:22px">
    <div style="font-weight:800;font-size:18px;margin-bottom:12px">GameDealTrack</div>
    <p style="margin:0 0 8px">${esc(items.length === 1 ? L.lead1 : L.leadN)}</p>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">${rows}</table>
    <p style="margin:18px 0 0"><a href="${SITE}${L.path("/deals?wl=1")}" style="color:#0d8a5f">${esc(L.wishlist)}</a></p></div>
    <p style="color:#777;font-size:12px;text-align:center;margin:14px 0 0">${esc(L.footer)}<br>
    <a href="${unsub}" style="color:#777">${esc(L.unsub)}</a></p></div></body></html>`;
}
const subjectOf = (L, items) => {
  const a = items[0], pct = pctOf(a.x), price = L.money(a.x.price, a.x.currency) + (pct ? ` (-${pct}%)` : "");
  if (items.length > 1) return L.subjN(items.length);
  return a.kind === "target" ? L.subjTarget(a.x.title, price, tText(L, a.target)) : L.subjSale(a.x.title, price);
};

async function main() {
  if (!API || !SITE || !process.env.ALERT_KEY) { console.log("SOURCE_API (or ALERTS_API and SITE_URL) and ALERT_KEY are needed"); process.exit(1); }
  const r = await fetch(API, { method: "POST", body: JSON.stringify({ action: "alert_subs", key: process.env.ALERT_KEY }) });
  const text = await r.text();
  let feed = {};
  try { feed = JSON.parse(text); } catch (e) {}
  // a page that isn't JSON came from Cloudflare (a bot challenge, an error page), not from the site's /api
  if (!feed.ok) { console.log("The site didn't give the alert list: " + r.status + " " + (r.headers.get("cf-mitigated") ? "(Cloudflare challenge) " : "") + text.slice(0, 200).replace(/\s+/g, " ")); process.exit(1); }
  const info = prices(), sent = read("alerts_sent.json", {}), today = new Date().toISOString().slice(0, 10);
  let webpush = null;
  if (process.env.VAPID_PRIVATE_KEY && process.env.VAPID_PUBLIC_KEY) {
    webpush = require("web-push");
    webpush.setVapidDetails("mailto:alerts@" + new URL(API).hostname, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  }
  FCM = await fcmSetup().catch(e => { console.log("Firebase setup failed: " + e.message); return null; });
  const mail = process.env.RESEND_API_KEY;
  let emails = 0, pushes = 0, apps = 0, people = 0;
  const gone = [], goneFcm = [];
  for (const u of feed.users || []) {
    const mine = sent[u.uid] || {}, wish = new Set(u.wish || []), targets = u.targets || {};
    const region = /^[A-Z]{2}$/.test(String(u.region || "")) ? u.region : "US";
    const items = [];
    new Set([...wish, ...Object.keys(targets)]).forEach(id => {
      const us = info[id];
      if (!us) return;
      // a price alert: the game in its region's store (no price there: nothing to tell yet)
      const target = tNorm(targets[id]), rx = target ? inRegion(id, us, target.r) : null;
      const hit = !!(rx && rx.price > 0 && (target.pct ? pctOf(rx) >= target.pct : rx.currency === target.c && target.p > 0 && rx.price <= target.p + 0.001));
      // a wishlisted game: on sale in the store of the region the person picked on the site (u.region); the US store's
      // price when that region's file doesn't have the game
      const wx = wish.has(id) ? inRegion(id, us, region) || us : null;
      const x = hit ? rx : wx || us;
      if (!(x.price > 0)) return;
      const onSale = !!wx && wx.price > 0 && wx.msrp > wx.price + 0.009;
      if (!(hit || onSale)) { delete mine[id]; return; }   // nothing to tell: told again at the next sale
      if (mine[id] && (mine[id].c || "USD") === (x.currency || "USD") && x.price >= mine[id].p - 0.009) return;   // already told at this price or lower
      items.push({ id, x, kind: hit ? "target" : "sale", target });
    });
    if (!items.length) { if (Object.keys(mine).length) sent[u.uid] = mine; else delete sent[u.uid]; continue; }
    items.sort((a, b) => (a.kind === "target" ? 0 : 1) - (b.kind === "target" ? 0 : 1) || (b.x.msrp - b.x.price) - (a.x.msrp - a.x.price));
    const list = items.slice(0, 20), L = alertText(u.lang), fmt = L.money;
    let delivered = false;
    if (u.email && mail) {
      if (DRY) { console.log("[dry] email (" + L.lang + ") to " + u.email.replace(/^(.).*@/, "$1…@") + ": " + subjectOf(L, list)); delivered = true; }
      else {
        const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + mail, "Content-Type": "application/json" },
          body: JSON.stringify({ from: process.env.ALERT_FROM || ("GameDealTrack <alerts@" + new URL(API).hostname + ">"), to: [u.email], subject: subjectOf(L, list), html: emailHtml(L, u, list),
            headers: { "List-Unsubscribe": `<${unsubUrl(L, u)}>` } }) });
        if (res.ok) { emails++; delivered = true; } else console.log("Email failed (" + res.status + "): " + (await res.text()).slice(0, 200));
        await sleep(600);   // Resend allows a few emails a second
      }
    }
    const a = list[0], note = {
      title: list.length > 1 ? L.subjN(list.length) : (a.kind === "target" ? L.pushTarget : L.pushSale)(a.x.title),
      body: list.length > 1 ? list.slice(0, 3).map(i => i.x.title + " " + fmt(i.x.price, i.x.currency)).join(" · ") : fmt(a.x.price, a.x.currency) + (a.x.msrp > a.x.price ? " " + L.was(fmt(a.x.msrp, a.x.currency)) : ""),
      url: list.length > 1 ? L.path("/deals?wl=1") : pageUrl(L, a.id, a.x).slice(SITE.length), tag: "gdt-alert" };
    if (FCM && (u.fcm || []).length) {
      for (const t of u.fcm) {
        if (DRY) { console.log("[dry] app: " + note.title); delivered = true; continue; }
        const res = await fcmSend(t, note).catch(e => { console.log("App notification failed: " + e.message); return false; });
        if (res === true) { apps++; delivered = true; } else if (res === "gone") goneFcm.push(t);
      }
    }
    if (webpush && (u.push || []).length) {
      const payload = JSON.stringify(note);
      for (const s of u.push) {
        if (DRY) { console.log("[dry] push: " + payload.slice(0, 120)); delivered = true; continue; }
        try { await webpush.sendNotification(s, payload, { TTL: 86400 }); pushes++; delivered = true; }
        catch (e) { if (e.statusCode === 404 || e.statusCode === 410) gone.push(s.endpoint); else console.log("Push failed: " + (e.statusCode || e.message)); }
      }
    }
    if (delivered) { list.forEach(i => { mine[i.id] = { p: i.x.price, d: today }; if (i.x.currency && i.x.currency !== "USD") mine[i.id].c = i.x.currency; }); people++; }
    if (Object.keys(mine).length) sent[u.uid] = mine; else delete sent[u.uid];
  }
  if ((gone.length || goneFcm.length) && !DRY) await fetch(API, { method: "POST", body: JSON.stringify({ action: "alert_gone", key: process.env.ALERT_KEY, endpoints: gone, fcm: goneFcm }) }).catch(() => {});
  // people no longer in the list (alerts off, account deleted): forgotten
  const live = new Set((feed.users || []).map(u => u.uid));
  Object.keys(sent).forEach(uid => { if (!live.has(uid)) delete sent[uid]; });
  if (!DRY) fs.writeFileSync(path.join(DATA, "alerts_sent.json"), JSON.stringify(sent));
  console.log("Alerts: " + (feed.users || []).length + " people with alerts on, " + people + " told, " + emails + " emails, " + pushes + " browser notifications, " + apps + " app notifications, " +
              (gone.length + goneFcm.length) + " expired subscriptions" + (mail ? "" : " (no RESEND_API_KEY: no emails)") + (webpush ? "" : " (no VAPID keys: no browser notifications)") + (FCM ? "" : " (no FCM_SERVICE_ACCOUNT: no app notifications)") + (DRY ? " [dry run]" : ""));
}
main().catch(e => { console.log("Alerts failed: " + e.message); process.exit(1); });
