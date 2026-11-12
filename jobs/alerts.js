// Sale and price alerts, sent after each Xbox and PlayStation run (.github/workflows/alerts.yml).
//
// Who: the site's accounts with alerts on (POST {action: "alert_subs", key: ALERT_KEY} to SOURCE_API): their wishlist,
// target prices ({game id: price}), email (when email alerts are on) and push subscriptions.
// What: a game on the wishlist that's on sale, or any game at or below its target price, in the US store.
// Each person gets at most one email and one notification a run, listing everything new. A game is only mentioned again
// when its price drops further, or after its sale ended and a new one started (data/alerts_sent.json remembers).
//
// Secrets: SOURCE_API, ALERT_KEY, RESEND_API_KEY (email), VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (push).
// ALERTS_DRY=1: logs what would be sent and sends nothing.
const fs = require("fs"), path = require("path");
const DATA = path.resolve(process.env.DATA_DIR || "data");
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")); } catch (e) { return d; } };
const DRY = !!process.env.ALERTS_DRY;
const API = process.env.SOURCE_API, SITE = API ? new URL(API).origin : "";
const XIMG = "https://store-images.s-microsoft.com/image/";
const slug = t => String(t || "game").toLowerCase().normalize("NFKD").replace(/[™®©]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "game";
const usd = v => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Every game's US price: the full lists, then the deals (more exact: sale end, editions on sale)
function prices() {
  const info = {};
  [["xbox", "xbox_catalog.json", "xbox_sales.json"], ["ps", "ps_catalog.json", "ps_sales.json"]].forEach(([plat, cat, sales]) => {
    (read(cat, { games: [] }).games || []).forEach(r => {
      if (!r[0] || !r[1]) return;
      info[r[0]] = { plat, title: r[1], price: Number(r[3]) || 0, msrp: Number(r[4]) || Number(r[3]) || 0, image: r[6] || "" };
    });
    (read(sales, { games: [] }).games || []).forEach(g => {
      if (!g.productId || !g.title || (g.saleEnds && Date.parse(g.saleEnds) <= Date.now())) return;
      info[g.productId] = { plat, title: g.title, price: Number(g.price) || 0, msrp: Number(g.msrp) || 0, image: g.image || "", ends: g.saleEnds || null };
    });
  });
  Object.values(info).forEach(x => { if (x.image && !/^https?:/.test(x.image)) x.image = XIMG + x.image; });
  return info;
}
const pageUrl = (id, x) => `${SITE}/game/${x.plat}/${encodeURIComponent(id)}/${slug(x.title)}`;

function emailHtml(u, items) {
  const rows = items.map(({ id, x, kind, target }) => {
    const pct = x.msrp > x.price ? Math.round((1 - x.price / x.msrp) * 100) : 0;
    const why = kind === "target" ? `Your price: ${usd(target)}` : x.ends ? `Sale ends ${new Date(x.ends).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : "On sale";
    return `<tr><td style="padding:10px 12px 10px 0;width:64px"><a href="${pageUrl(id, x)}"><img src="${esc(x.image)}${x.image.includes("?") ? "" : "?w=128"}" width="64" alt="" style="display:block;border-radius:8px"></a></td>
      <td style="padding:10px 0"><a href="${pageUrl(id, x)}" style="color:#0b1f17;font-weight:700;text-decoration:none">${esc(x.title)}</a>
      <div style="margin-top:4px"><b style="color:#0d8a5f;font-size:16px">${usd(x.price)}</b>${pct ? ` <s style="color:#777">${usd(x.msrp)}</s> <span style="background:#ffd166;border-radius:6px;padding:1px 6px;font-weight:700;font-size:13px">-${pct}%</span>` : ""}</div>
      <div style="color:#666;font-size:13px;margin-top:2px">${x.plat === "ps" ? "PlayStation" : "Xbox"} · ${esc(why)}</div></td></tr>`;
  }).join("");
  const unsub = `${SITE}/api?action=unsub&u=${encodeURIComponent(u.uid)}&t=${encodeURIComponent(u.unsub)}`;
  return `<!DOCTYPE html><html><body style="margin:0;background:#f3f6f4;font-family:Arial,Helvetica,sans-serif;color:#0b1f17">
    <div style="max-width:560px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border-radius:14px;padding:22px">
    <div style="font-weight:800;font-size:18px;margin-bottom:12px">GameDealTrack</div>
    <p style="margin:0 0 8px">${items.length === 1 ? "A game you're watching has a new price:" : "Games you're watching have new prices:"}</p>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">${rows}</table>
    <p style="margin:18px 0 0"><a href="${SITE}/deals?wl=1" style="color:#0d8a5f">See your wishlist</a></p></div>
    <p style="color:#777;font-size:12px;text-align:center;margin:14px 0 0">Prices are the US store's and can change. You get these because you turned on alerts on GameDealTrack.<br>
    <a href="${unsub}" style="color:#777">Unsubscribe from alert emails</a></p></div></body></html>`;
}
const subjectOf = items => {
  const a = items[0], pct = a.x.msrp > a.x.price ? Math.round((1 - a.x.price / a.x.msrp) * 100) : 0;
  if (items.length > 1) return `${items.length} games you're watching have new prices`;
  return a.kind === "target" ? `${a.x.title} is now ${usd(a.x.price)} (your price: ${usd(a.target)})` : `${a.x.title} is on sale: ${usd(a.x.price)}${pct ? ` (-${pct}%)` : ""}`;
};

async function main() {
  if (!API || !process.env.ALERT_KEY) { console.log("SOURCE_API and ALERT_KEY are needed"); process.exit(1); }
  const r = await fetch(API, { method: "POST", body: JSON.stringify({ action: "alert_subs", key: process.env.ALERT_KEY }) });
  const feed = await r.json().catch(() => ({}));
  if (!feed.ok) { console.log("The site didn't give the alert list: " + r.status + " " + JSON.stringify(feed).slice(0, 200)); process.exit(1); }
  const info = prices(), sent = read("alerts_sent.json", {}), today = new Date().toISOString().slice(0, 10);
  let webpush = null;
  if (process.env.VAPID_PRIVATE_KEY && process.env.VAPID_PUBLIC_KEY) {
    webpush = require("web-push");
    webpush.setVapidDetails("mailto:alerts@" + new URL(API).hostname, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  }
  const mail = process.env.RESEND_API_KEY;
  let emails = 0, pushes = 0, people = 0;
  const gone = [];
  for (const u of feed.users || []) {
    const mine = sent[u.uid] || {}, wish = new Set(u.wish || []), targets = u.targets || {};
    const items = [];
    new Set([...wish, ...Object.keys(targets)]).forEach(id => {
      const x = info[id];
      if (!x || !(x.price > 0)) return;
      const onSale = x.msrp > x.price + 0.009, target = Number(targets[id]) || 0, hit = target > 0 && x.price <= target + 0.001;
      if (!(hit || (onSale && wish.has(id)))) { delete mine[id]; return; }   // nothing to tell: told again at the next sale
      if (mine[id] && x.price >= mine[id].p - 0.009) return;                 // already told at this price or lower
      items.push({ id, x, kind: hit ? "target" : "sale", target });
    });
    if (!items.length) { if (Object.keys(mine).length) sent[u.uid] = mine; else delete sent[u.uid]; continue; }
    items.sort((a, b) => (a.kind === "target" ? 0 : 1) - (b.kind === "target" ? 0 : 1) || (b.x.msrp - b.x.price) - (a.x.msrp - a.x.price));
    const list = items.slice(0, 20);
    let delivered = false;
    if (u.email && mail) {
      if (DRY) { console.log("[dry] email to " + u.email.replace(/^(.).*@/, "$1…@") + ": " + subjectOf(list)); delivered = true; }
      else {
        const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + mail, "Content-Type": "application/json" },
          body: JSON.stringify({ from: process.env.ALERT_FROM || ("GameDealTrack <alerts@" + new URL(API).hostname + ">"), to: [u.email], subject: subjectOf(list), html: emailHtml(u, list),
            headers: { "List-Unsubscribe": `<${SITE}/api?action=unsub&u=${encodeURIComponent(u.uid)}&t=${encodeURIComponent(u.unsub)}>` } }) });
        if (res.ok) { emails++; delivered = true; } else console.log("Email failed (" + res.status + "): " + (await res.text()).slice(0, 200));
        await sleep(600);   // Resend allows a few emails a second
      }
    }
    if (webpush && (u.push || []).length) {
      const a = list[0], payload = JSON.stringify({
        title: list.length > 1 ? list.length + " games you're watching have new prices" : (a.kind === "target" ? "Your price alert: " : "On sale: ") + a.x.title,
        body: list.length > 1 ? list.slice(0, 3).map(i => i.x.title + " " + usd(i.x.price)).join(" · ") : usd(a.x.price) + (a.x.msrp > a.x.price ? " (was " + usd(a.x.msrp) + ")" : ""),
        url: list.length > 1 ? "/deals?wl=1" : pageUrl(a.id, a.x).slice(SITE.length), tag: "gdt-alert" });
      for (const s of u.push) {
        if (DRY) { console.log("[dry] push: " + payload.slice(0, 120)); delivered = true; continue; }
        try { await webpush.sendNotification(s, payload, { TTL: 86400 }); pushes++; delivered = true; }
        catch (e) { if (e.statusCode === 404 || e.statusCode === 410) gone.push(s.endpoint); else console.log("Push failed: " + (e.statusCode || e.message)); }
      }
    }
    if (delivered) { list.forEach(i => { mine[i.id] = { p: i.x.price, d: today }; }); people++; }
    if (Object.keys(mine).length) sent[u.uid] = mine; else delete sent[u.uid];
  }
  if (gone.length && !DRY) await fetch(API, { method: "POST", body: JSON.stringify({ action: "alert_gone", key: process.env.ALERT_KEY, endpoints: gone }) }).catch(() => {});
  // people no longer in the list (alerts off, account deleted): forgotten
  const live = new Set((feed.users || []).map(u => u.uid));
  Object.keys(sent).forEach(uid => { if (!live.has(uid)) delete sent[uid]; });
  if (!DRY) fs.writeFileSync(path.join(DATA, "alerts_sent.json"), JSON.stringify(sent));
  console.log("Alerts: " + (feed.users || []).length + " people with alerts on, " + people + " told, " + emails + " emails, " + pushes + " notifications, " +
              gone.length + " expired subscriptions" + (mail ? "" : " (no RESEND_API_KEY: no emails)") + (webpush ? "" : " (no VAPID keys: no notifications)") + (DRY ? " [dry run]" : ""));
}
main().catch(e => { console.log("Alerts failed: " + e.message); process.exit(1); });
