// Check by hand (.github/workflows/archive-probe.yml): how prices appear on saved copies of store pages in the
// Internet Archive, and how long the archive takes to answer. Prints the text around each price on a few copies.
const { execFileSync } = require("child_process");
const get = url => { const t = Date.now(); let s = ""; try { s = execFileSync("curl", ["-sL", "--max-time", "90", url], { maxBuffer: 1 << 28, encoding: "utf8" }); } catch (e) {} return [s, Date.now() - t]; };
const pages = [
  ["PS Elden Ring", "store.playstation.com/en-us/concept/10001820"],
  ["PS God of War Ragnarok", "store.playstation.com/en-us/concept/10001850"],
  ["Xbox GTA VI Ultimate", "www.xbox.com/en-US/games/store/grand-theft-auto-vi-ultimate-edition/9NNZSNHLR63L"],
  ["Xbox Elden Ring", "www.xbox.com/en-US/games/store/elden-ring/9P3J32CTXLRZ"]
];
for (const [name, url] of pages) {
  const [raw, ms] = get("https://web.archive.org/cdx/search/cdx?url=" + encodeURIComponent(url) + "&matchType=prefix&output=json&fl=timestamp,original&filter=statuscode:200&collapse=timestamp:8&limit=5000");
  let rows = []; try { rows = JSON.parse(raw || "[]").slice(1); } catch (e) {}
  console.log("== " + name + ": " + rows.length + " days (list took " + ms + " ms)");
  for (const r of [rows[0], rows[Math.floor(rows.length / 2)], rows[rows.length - 1]].filter(Boolean)) {
    const [html, t] = get("https://web.archive.org/web/" + r[0] + "id_/" + r[1]);
    const hits = [];
    const re = /.{0,140}(\$\d{1,3}\.\d\d|"(?:basePrice|discountedPrice|listPrice|msrp|price)"\s*:).{0,140}/g;
    let m; while ((m = re.exec(html)) && hits.length < 4) hits.push(m[0].replace(/\s+/g, " "));
    console.log("-- " + r[0] + " " + r[1] + " (" + Math.round(html.length / 1024) + " KB, " + t + " ms)");
    hits.forEach(h => console.log("   " + h));
  }
}
