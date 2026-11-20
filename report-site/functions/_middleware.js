// Password for the whole report site: every page and data file. The password is the REPORT_PASSWORD secret of the
// Cloudflare Pages project (set by .github/workflows/report.yml from the GitHub secret of the same name).
// Any user name is accepted; only the password is checked.
const enc = new TextEncoder();
async function same(a, b) {   // compares hashes, so the time taken says nothing about the password
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const u = new Uint8Array(x), v = new Uint8Array(y); let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}
export async function onRequest({ request, env, next }) {
  const pw = env.REPORT_PASSWORD;
  if (!pw) return new Response("The report has no password set yet.", { status: 503, headers: { "Cache-Control": "no-store" } });
  const h = request.headers.get("Authorization") || "";
  let ok = false;
  if (h.startsWith("Basic ")) {
    try { const s = atob(h.slice(6)), i = s.indexOf(":"); ok = i >= 0 && await same(s.slice(i + 1), pw); } catch (e) {}
  }
  if (!ok) return new Response("Password required.", { status: 401, headers: {
    "WWW-Authenticate": 'Basic realm="ggdata report", charset="UTF-8"', "Cache-Control": "no-store" } });
  const res = await next(), out = new Response(res.body, res);
  out.headers.set("Cache-Control", "private, no-store");
  out.headers.set("X-Robots-Tag", "noindex, nofollow");
  return out;
}
