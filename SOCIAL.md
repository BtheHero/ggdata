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

## Facebook Page (free)

1. Create a Facebook Page for the site, and an app at developers.facebook.com (type **Business**), with the permissions `pages_manage_posts`, `pages_read_engagement` (and for Instagram: `instagram_basic`, `instagram_content_publish`).
2. In the Graph API Explorer, pick your app, get a **User** token with those permissions, then exchange it for a long-lived one:
   `GET /oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_TOKEN`
3. With the long-lived user token, `GET /me/accounts`: the page's `access_token` there does not expire.
4. Secrets: `FB_PAGE_ID` (the page's `id` from step 3), `FB_PAGE_TOKEN` (its `access_token`).

While the app is in development mode only you (the app's admin) can use it, which is all this needs: posting to your own page doesn't require App Review.

## Instagram (free)

1. Switch the Instagram account to a **Business** or **Creator** account and link it to the Facebook Page (Instagram → Settings → Account type and tools; or the Page's settings → Linked accounts).
2. With the page token: `GET /PAGE_ID?fields=instagram_business_account` gives the account id.
3. Secret: `IG_USER_ID`. It uses `FB_PAGE_TOKEN` too.

Links aren't clickable in Instagram captions, so posts say "Link in bio": put `https://gamedealtrack.com` in the profile's bio. Instagram allows 100 API posts a day; this posts at most about 13.

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

## X / Twitter (paid, optional)

X has no free API tier any more (since early 2026): posting is billed per post, about $0.015 a post and about $0.20 for a
post with a link (all of these have one), per third-party write-ups; check X's developer pricing page for current rates.
At this job's volume that is roughly $50-75 a month, so X is left out unless its secrets are set. `X_DAILY_CAP`
(default 15 posts a day) caps the spend.

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
| `X_DAILY_CAP` | 15 | Posts a day on X (each one is paid) |
| `FB_GRAPH_VERSION` | v23.0 | Facebook Graph API version |

What was posted: `data/social/<xbox|ps|weekly>-posted.json` in the bucket. Delete an entry to allow a game to be posted again.
