# XEraser

Delete your tweets, likes, DMs, bookmarks — or unfollow everyone. Free, runs in your browser.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari)
2. Click **[Install XEraser](https://github.com/thenayanhazra/XEraser/raw/main/xeraser.user.js)**
3. Go to [x.com](https://x.com) and navigate to your profile

The XEraser panel appears at the top of the page.

## What it can do

| Action | File needed | Rate limit |
|---|---|---|
| **Delete tweets** | `tweet-headers.js` | ~10,000–20,000/hr |
| **Delete likes** | `like.js` | ~500/15 min |
| **Delete DM conversations** | `direct-message-headers.js` or `direct-message-group-headers.js` | ~800/15 min |
| **Slow delete (no file)** | None — drives the UI directly | ~50/min |
| **Unfollow everyone** | None | ~200/min |
| **Export bookmarks** | None — downloads JSON | Read-only |

## Getting your data export files

1. Go to **Settings → Your account → Download an archive of your data**
2. Wait for X to prepare the archive (can take 24+ hours)
3. Download and unzip it
4. The files you need are in the `data/` folder

## How it works

XEraser runs inside your logged-in browser session. It uses the same internal API that the X web app uses when you manually delete a tweet — no external servers, no API keys, no third-party access.

Rate limits are handled automatically. When X throttles requests, XEraser reads the `x-rate-limit-reset` header and waits until the window reopens before resuming. You can also stop and restart at any time.

For tweet deletion, XEraser auto-calculates how many already-deleted tweets to skip (based on the difference between your export file and your current profile count). You can override this with the skip input field. The **Keep latest** field lets you protect your N most recent tweets from deletion (up to 100).

**Date-range deletion** — set a From and/or To date to only delete tweets (or likes) within that window. When a file is loaded, XEraser shows the date range it contains. Dates are extracted from the tweet's `created_at` field or derived from the snowflake ID when timestamps aren't available.

**Resume after interruption** — if you stop mid-session or close the tab, XEraser saves progress to localStorage. Next time you open x.com, a banner offers to pick up where you left off — no need to re-upload the file.

## License

MIT
