// One-time check: how many saved copies of store pages the Internet Archive (Wayback Machine) has, and whether a
// price can be read from them. Run by .github/workflows/archive-probe.yml (by hand).
const { execFileSync } = require("child_process");
const get = url => { try { return execFileSync("curl", ["-sL", "--max-time", "60", url], { maxBuffer: 1 << 28, encoding: "utf8" }); } catch (e) { return ""; } };
const pages = [
  ["Xbox Forza Horizon 5", "www.xbox.com/en-US/games/store/forza-horizon-5-standard-edition/9NKX70BBCDRN"],
  ["Xbox Elden Ring", "www.xbox.com/en-US/games/store/elden-ring/9P3J32CTXLRZ"],
  ["Xbox Cyberpunk 2077", "www.xbox.com/en-US/games/store/cyberpunk-2077/BX3M8L83BBRW"],
  ["Xbox (old store) Forza Horizon 5", "www.microsoft.com/en-us/p/forza-horizon-5-standard-edition/9nkx70bbcdrn"],
  ["PS Elden Ring", "store.playstation.com/en-us/concept/10001820"],
  ["PS God of War Ragnarok", "store.playstation.com/en-us/concept/10001850"],
  ["PS Cyberpunk 2077", "store.playstation.com/en-us/concept/10000590"]
];
for (const [name, url] of pages) {
  const rows = JSON.parse(get("https://web.archive.org/cdx/search/cdx?url=" + encodeURIComponent(url) + "*&output=json&fl=timestamp,original&filter=statuscode:200&limit=2000") || "[]").slice(1);
  const days = new Set(rows.map(r => r[0].slice(0, 8)));
  const months = new Set(rows.map(r => r[0].slice(0, 6)));
  let sample = "";
  if (rows.length) {   // read a price from the newest copy
    const r = rows[rows.length - 1], html = get("https://web.archive.org/web/" + r[0] + "id_/" + r[1]);
    const m = html.match(/"listPrice":\s*([\d.]+)|"price":\s*"?\$?([\d.]+)|"discountedPrice":"\$([\d.]+)"|\$(\d+\.\d\d)/);
    sample = r[0].slice(0, 8) + " price " + (m ? (m[1] || m[2] || m[3] || m[4]) : "not found") + " (page " + Math.round(html.length / 1024) + " KB)";
  }
  console.log(name + ": " + rows.length + " copies on " + days.size + " days, " + months.size + " months" +
              (rows.length ? ", first " + rows[0][0].slice(0, 8) + ", last " + rows[rows.length - 1][0].slice(0, 8) : "") + (sample ? " | newest: " + sample : ""));
}
