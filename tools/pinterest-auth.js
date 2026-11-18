// Connects the Pinterest account to the posting job (jobs/social.js), once: run it on your own computer.
//
//   PINTEREST_APP_ID=… PINTEREST_APP_SECRET=… node tools/pinterest-auth.js            sign in, then print the
//                                                     refresh token and your boards (their ids)
//   PINTEREST_APP_ID=… PINTEREST_APP_SECRET=… node tools/pinterest-auth.js BOARD_ID   …and post a test pin to that board
//
// It opens Pinterest's sign-in page; after you allow access, Pinterest sends the browser back to this script
// (http://localhost:8085/), which swaps the code for tokens. Add that address to the app's Redirect URIs first
// (developers.pinterest.com → My apps → your app → Configure). The run is also what Pinterest wants to see in the
// video for Standard access: the sign-in, the consent screen, the return to the app and a live API call (the test pin).
// Needs Node 18 or newer. Nothing is saved: copy the refresh token into the GitHub secret PINTEREST_REFRESH_TOKEN.
const http = require("http"), crypto = require("crypto"), { exec } = require("child_process");
const ID = process.env.PINTEREST_APP_ID, SECRET = process.env.PINTEREST_APP_SECRET, BOARD = process.argv[2];
const PORT = 8085, REDIRECT = "http://localhost:" + PORT + "/", API = process.env.PINTEREST_API || "https://api.pinterest.com";
const SCOPES = "boards:read,boards:write,pins:read,pins:write,user_accounts:read";   // creating a pin needs boards:write too
if (!ID || !SECRET) { console.log("Set PINTEREST_APP_ID and PINTEREST_APP_SECRET (from the app's page on developers.pinterest.com)."); process.exit(1); }

const state = crypto.randomBytes(12).toString("hex");
const authUrl = "https://www.pinterest.com/oauth/?" + new URLSearchParams({ client_id: ID, redirect_uri: REDIRECT, response_type: "code", scope: SCOPES, state });
const basic = "Basic " + Buffer.from(ID + ":" + SECRET).toString("base64");
async function api(method, p, token, body) {
  const r = await fetch(API + "/v5" + p, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(method + " " + p + " → " + r.status + " " + JSON.stringify(j));
  return j;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== "/") { res.writeHead(404); return res.end(); }
  const page = (title, msg) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<body style="font:18px system-ui;max-width:640px;margin:60px auto;padding:0 16px"><h1>${title}</h1><p>${msg}</p></body>`); };
  if (u.searchParams.get("state") !== state || !u.searchParams.get("code")) { page("Not connected", "Pinterest didn't send a code (" + (u.searchParams.get("error") || "access refused") + ")."); return; }
  try {
    console.log("\n2. Pinterest sent us back with a code: getting the tokens…");
    const r = await fetch(API + "/v5/oauth/token", { method: "POST", headers: { authorization: basic, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: u.searchParams.get("code"), redirect_uri: REDIRECT }) });
    const t = await r.json();
    if (!r.ok || !t.access_token) throw new Error("token → " + r.status + " " + JSON.stringify(t));
    const me = await api("GET", "/user_account", t.access_token);
    console.log("   Connected as @" + me.username);
    const boards = await api("GET", "/boards?page_size=100", t.access_token);
    console.log("\n3. Your boards (PINTEREST_BOARD_ID is the number):");
    (boards.items || []).forEach(b => console.log("   " + b.id + "   " + b.name));
    let pinMsg = "";
    if (BOARD) {
      console.log("\n4. Posting a test pin to board " + BOARD + "…");
      let pin = null;
      try { pin = await api("POST", "/pins", t.access_token, { board_id: BOARD, title: "GameDealTrack: Xbox & PlayStation deals",
        description: "Every Xbox & PlayStation deal, the moment it drops. #GameDeals", link: "https://gamedealtrack.com/?utm_source=pinterest&utm_medium=social",
        alt_text: "The GameDealTrack logo", media_source: { source_type: "image_url", url: "https://gamedealtrack.com/og.png" } }); }
      catch (e) {   // Trial apps may only create pins in the sandbox (with a sandbox token: see pinterest-token.js)
        if (!/"code":29|Trial access/.test(e.message)) throw e;
        console.log("   Not posted: with Trial access, Pinterest only allows pins in its sandbox (a separate test token).");
        pinMsg = " (Pins can be posted here once Pinterest grants Standard access.)";
      }
      if (pin) {
      console.log("   Pin created: https://www.pinterest.com/pin/" + pin.id + "/");
      pinMsg = ` A test pin was posted: <a href="https://www.pinterest.com/pin/${pin.id}/">open it</a>.`;
    }
    }
    console.log("\nGitHub secret PINTEREST_REFRESH_TOKEN (valid " + Math.round((t.refresh_token_expires_in || 0) / 86400) + " days):\n\n" + t.refresh_token + "\n");
    page("GameDealTrack is connected to Pinterest", "Signed in as @" + me.username + "." + pinMsg + " You can close this tab.");
  } catch (e) {
    console.log("   Failed: " + e.message);
    page("Something went wrong", String(e.message).replace(/</g, "&lt;"));
  }
  server.close();
});
server.listen(PORT, () => {
  console.log("1. Opening Pinterest to sign in and allow access. If no browser opens, go to:\n\n" + authUrl + "\n");
  const cmd = process.platform === "win32" ? 'start "" "' + authUrl + '"' : (process.platform === "darwin" ? "open" : "xdg-open") + ' "' + authUrl + '"';
  exec(cmd, () => {});
});
