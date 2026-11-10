# ggdata

Scheduled jobs that collect game store data (prices, sales, add-ons) and publish it as JSON files.

- `gs/`: the jobs, written for Google Apps Script and run here unchanged
- `runtime/appsscript.js`: stand-ins for the Apps Script services (web requests, files, settings)
- `run.js`: runs one job (`node run.js xbox`)
- `seed.js`: copies files the jobs build on from the site's data service
- `.github/workflows/`: the schedules

Files are kept in a Cloudflare R2 bucket. Repository secrets: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `SOURCE_API`.
