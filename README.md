# ggdata

Scheduled jobs that collect game store data (prices, sales, add-ons) and publish it as JSON files.

- `gs/`: the jobs, written for Google Apps Script and run here unchanged
- `runtime/appsscript.js`: stand-ins for the Apps Script services (web requests, files, settings)
- `jobs/media.js`: screenshots, trailers, key art and genres of every game (links only)
- `jobs/lists.js`: the site's list pages (best games of the year, kept for every year; upcoming and recent releases; publishers; free games; top Metacritic; most wanted; PS Plus new and announced) and the home page's publisher rows
- `run.js`: runs one job (`node run.js xbox`, `node run.js media`). The Xbox job also looks up, in each region's own store,
  the prices its browse list leaves out (`xbox_gaps_<code>.json`, merged into the region's price file, with `na`: games not
  sold there) and keeps each region's price history (`rhist/<xbox|ps>-<code>.json`) for the game pages
- `gs/addons.gs`: Xbox add-ons, and what each edition includes (`xbox_bundles.json`); every add-on gets a game page
- `seed.js`: copies files the jobs build on from the site's data service
- `.github/workflows/`: the schedules

Files are kept in a Cloudflare R2 bucket. Repository secrets: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `SOURCE_API`.
