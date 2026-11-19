# Social media posting

`jobs/social.js` posts deals from the data the jobs already build:

- **Big new deals**: after every scheduled Xbox and PlayStation run (4 runs a day), up to 3 deals per run with a deal score of 85 or more and at least 50% off, or 30% off when it's the lowest price ever. Each game is posted at most once every 30 days, whichever edition is on sale.
- **Weekly roundup**: Sundays at 16:23 UTC (`.github/workflows/social-weekly.yml`), the 5 best deals of the week on each store, linking to `/best-deals/<xbox|ps>`.

Each network posts only once its secrets are set (GitHub: Settings → Secrets and variables → Actions → New repository secret). Leave a network's secrets unset to skip it. If a post fails on one network, the others still post, and the store run never fails because of it.

**Test first**: add a repository *variable* (not a secret) `SOCIAL_DRY_RUN` = `1`. The runs then print what they would post in the "Post…" step's log and send nothing. Delete the variable to go live. You can try it straight away from the Actions tab: **Social weekly → Run workflow**. (The deal posts run only on the schedule, not on manual runs.)

Images: the store art is converted to a square JPEG by the free image proxy [wsrv.nl](https://wsrv.nl), because Instagram only accepts JPEGs and Bluesky needs images under 1 MB.

## Bluesky (free)

1. Bluesky → Settings → Privacy and security → App passwords → Add.
2. Secrets: `BSKY_HANDLE` (e.g. `gamedealtrack.bsky.social`), `BSKY_APP_PASSWORD`.

## Facebook Page and Instagram (free)

1. A Facebook Page, and an Instagram **professional** account (Business or Creator) linked to it (Instagram → Settings →
   Account type and tools; or the Page's settings → Linked accounts).
2. developers.facebook.com → My Apps → Create app (type **Business**), with the use cases for managing a Page's posts and
   Instagram content. The app can stay in development mode: you're its admin, posting to your own Page and account.
3. Graph API Explorer (developers.facebook.com/tools/explorer): pick your app, "Get User Access Token" with
   `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`,
   and tick your Page (and Instagram account) when asked. Copy the token.
4. On your computer: `node tools/meta-setup.js`. It asks for the app's id and secret (App settings → Basic) and that
   token, and prints `FB_PAGE_ID`, `FB_PAGE_TOKEN` (never expires) and `IG_USER_ID`; it can post a test photo to each.
5. Secrets: `FB_PAGE_ID`, `FB_PAGE_TOKEN`, `IG_USER_ID`.

Links aren't clickable in Instagram captions, so Instagram posts say "Link in bio": put `https://gamedealtrack.com` in
the profile. Instagram allows 100 API posts a day; this posts at most about 13.

## Pinterest (free)

1. A business account, a board (e.g. "Game Deals"), and an app at developers.pinterest.com. In the app's settings, add
   the Redirect URI `http://localhost:8085/`.
2. On your computer (Node 18 or newer), from a copy of this repository, with the app's id and secret:

   ```
   PINTEREST_APP_ID=… PINTEREST_APP_SECRET=… node tools/pinterest-auth.js
   ```

   (Windows PowerShell: `$env:PINTEREST_APP_ID="…"; $env:PINTEREST_APP_SECRET="…"; node tools/pinterest-auth.js`)
   It opens Pinterest, you allow access, and it prints your boards with their ids and a refresh token (valid a year).
   Run it again with a board id at the end to also post a test pin.
3. Secrets: `PINTEREST_APP_ID`, `PINTEREST_APP_SECRET`, `PINTEREST_REFRESH_TOKEN`, `PINTEREST_BOARD_ID`. The job gets a
   fresh access token each run; run the script again once a year.

**Trial access**: pins the app makes are visible only to you until Pinterest grants **Standard access**. If posting
fails with a "trial"/"sandbox" error, add the repository variable `PINTEREST_API` = `https://api-sandbox.pinterest.com`
(and delete it after approval).

**Standard access video**: screen-record running `node tools/pinterest-auth.js BOARD_ID`: the terminal command, the
Pinterest sign-in and consent screen, the return to the "connected" page, then the test pin opened on Pinterest. Then
show the deal pins the job posted on the board. In the request, describe the use: "Posts Xbox and PlayStation game
deals from gamedealtrack.com to our own board, a few times a day; one account (ours), no other users."

## X / Twitter

### Through Buffer (recommended)

Buffer posts to X for you, with the picture, so X's own per-post API fees don't apply.

1. buffer.com: connect your X account as a channel.
2. Buffer → Settings → API: create an API key.
3. Secrets: `BUFFER_API_KEY` (that key) and `BUFFER_X_CHANNEL_ID` (the X channel's id in Buffer; for GameDealTrack it's
   `6afe5094ece6dfde5f16691c`).

When both are set, X posts go through Buffer and the `X_…` secrets below are ignored. `X_DAILY_CAP` (default 15 posts a
day) still applies; raise it if your Buffer plan allows more.

### X's own API (paid)

X has no free API tier any more (since early 2026): posting is billed per post, about $0.015 a post and about $0.20 for a
post with a link (all of these have one), per third-party write-ups; check X's developer pricing page for current rates.
At this job's volume that is roughly $50-75 a month. `X_DAILY_CAP` (default 15 posts a day) caps the spend.

1. developer.x.com → create a project and app, and add credit for pay-per-use.
2. App settings → User authentication settings: **Read and write**.
3. Keys and tokens: the **API Key and Secret**, then generate the **Access Token and Secret** (after setting Read and write, or they'll be read-only).
4. Secrets: `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`.

## Settings

Repository variables, if the defaults don't suit (add them to the steps' `env` in the workflows the same way as `SOCIAL_DRY_RUN`):

| Variable | Default | |
|---|---|---|
| `SOCIAL_MIN_SCORE` | 85 | Deal score a deal needs |
| `SOCIAL_MIN_PCT` | 50 | Discount it needs (30% for a new lowest price) |
| `SOCIAL_MAX_DEALS` | 3 | Deals per run per store |
| `X_DAILY_CAP` | 15 | Posts a day on X (through Buffer or X's paid API) |
| `FB_GRAPH_VERSION` | v23.0 | Facebook Graph API version |

What was posted: `data/social/<xbox|ps|weekly>-posted.json` in the bucket. Delete an entry to allow a game to be posted again.
