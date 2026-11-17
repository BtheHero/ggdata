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

1. Make it a business account, create a board (e.g. "Game Deals"), and an app at developers.pinterest.com with the scopes `boards:read`, `pins:read`, `pins:write`. New apps get **Trial access**: request **Standard access** in the app's settings; until then, pins may only be visible to you.
2. Get a refresh token with the OAuth flow (the app's page has a button to generate an access token for your own account; the token response includes a `refresh_token`, valid for a year).
3. The board id: `GET https://api.pinterest.com/v5/boards` with the access token.
4. Secrets: `PINTEREST_BOARD_ID`, `PINTEREST_APP_ID`, `PINTEREST_APP_SECRET`, `PINTEREST_REFRESH_TOKEN`. The job gets a fresh access token each run; renew the refresh token once a year.

## X / Twitter (free tier, limited)

X's free API tier lets you post, but only a small number of posts (check the current limit at developer.x.com: it has changed several times). The job stops at `X_DAILY_CAP` posts a day (default 15; set it as a repository variable to lower it, and add `X_DAILY_CAP: ${{ vars.X_DAILY_CAP }}` to the workflow steps' `env`). If X answers 429 (limit reached), that post is skipped on X only.

1. developer.x.com → sign up for the Free plan → create a project and app.
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
| `X_DAILY_CAP` | 15 | Posts a day on X |
| `FB_GRAPH_VERSION` | v23.0 | Facebook Graph API version |

What was posted: `data/social/<xbox|ps|weekly>-posted.json` in the bucket. Delete an entry to allow a game to be posted again.
