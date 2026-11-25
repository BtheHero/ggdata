# ggdata

Scheduled jobs that collect game store data (prices, sales, add-ons) and publish it as JSON files.

- `gs/`: the jobs, written for Google Apps Script and run here unchanged
- `runtime/appsscript.js`: stand-ins for the Apps Script services (web requests, files, settings)
- `jobs/media.js`: screenshots, trailers, key art and genres of every game (links only)
- `jobs/descriptions.js`: every game's store description in the site's other languages (`desc/<xbox|ps>-<lang>-<n>.json`), from each
  store in that language, else machine-translated: with GitHub Models, free (the workflow's own token with `models: read`; `GH_MODEL`,
  `GH_MAX` requests a run, within the free tier's ~150 a day), or with the Claude API instead when the repository secret
  `ANTHROPIC_API_KEY` is set (Message Batches; `TRANSLATE_MODEL`, `MT_MAX` games a run). `node run.js desc`, in the Media workflow
- `jobs/lists.js`: the site's list pages (best games of the year, kept for every year; upcoming and recent releases; publishers; free games; top Metacritic; most wanted; PS Plus new and announced) and the home page's publisher rows
- `run.js`: runs one job (`node run.js xbox`, `node run.js media`). The Xbox job also looks up, in each region's own store,
  the prices its browse list leaves out (`xbox_gaps_<code>.json`, merged into the region's price file, with `na`: games not
  sold there) and keeps each region's price history (`rhist/<xbox|ps>-<code>.json`) for the game pages
- `jobs/ps-editions.js`: PlayStation regional prices, edition by edition. Every game page and deal gets the price of the
  same edition in each region's store (a PS4 game never gets its PS5 remaster's price), or is listed as not sold there
  (`na`); never the US price converted. Each region's editions are kept in `psed/<code>.json`, looked up a part at a time
  by the daily run and by `node run.js psregions` (`ps-regions.yml`, twice a day)
- `jobs/ps-posters.js`: PlayStation posters. Games the store has no portrait art for (about a third) get the portrait art
  of their PlayStation product, else the same game's Steam library art (looked up by the PlayStation details job), else
  its Xbox cover, instead of their square art cropped (`ps_posters.json`)
- `gs/addons.gs`: Xbox add-ons, and what each edition includes (`xbox_bundles.json`); every add-on gets a game page
- `jobs/social-card.js`: the weekly roundup's pictures (the week's top 5 deals, tall and wide), served by the site at /social-img/
- `jobs/social.js`: posts big deals (2 a day on each store) and the week's best deals (Sundays) to Bluesky, Facebook, Instagram, Pinterest and X, one at a time through the day (`social-queue.yml`, hourly); setup in `SOCIAL.md`
- `tools/report.js`: a report on the automatic jobs (`node tools/report.js report/`): every run of the last 7 days, its
  result and failed steps, what its log says it did, the files it uploaded, and each social post network by network.
  `report.yml` publishes it every 6 hours to Cloudflare Pages (`report-site/`, project `ggdata-report`), behind a password.
  Secrets: `CLOUDFLARE_API_TOKEN` (Account → Cloudflare Pages → Edit), `CLOUDFLARE_ACCOUNT_ID`, `REPORT_PASSWORD`
- `.github/workflows/prerender.yml` (Game pages): after each Xbox, PlayStation and Media run, makes every game page in every language
  with the site's own code (gtracker `tools/prerender.mjs`) and uploads them to the bucket's `pages/` folder (`tools/upload-pages.js`),
  where the site serves them from. Secret: `SITE_REPO_TOKEN` (fine-grained token, read access to the gtracker repository's contents)
- `seed.js`: copies files the jobs build on from the site's data service
- `.github/workflows/`: the schedules

Files are kept in a Cloudflare R2 bucket. Repository secrets: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `SOURCE_API`.
