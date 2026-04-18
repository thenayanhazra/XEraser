# XEraser

Delete tweets, likes, DMs, and bookmarks — or unfollow everyone — from your logged-in X session.

XEraser is a browser userscript that runs directly in your authenticated browser on `x.com` and `mobile.x.com`. It uses the session that is already active in your browser, respects rate limits, and supports resumable runs for API-based actions.

## Features

- Delete tweets from your X export file
- Unlike tweets from your X export file
- Delete DM conversations from your X export file
- Remove bookmarks from the bookmarks page
- Unfollow accounts in bulk from your following list
- UI-only slow-delete fallback for tweet removal
- Resume interrupted API-backed runs
- Keep your latest tweets by skipping the newest `0–100` tweets during tweet deletion
- Optional date filtering for tweets and likes

## Important behavior

XEraser runs in your logged-in browser session. It does not ask for your password or route requests through a separate backend.

API-backed actions are rate-limit aware. When X returns limit headers or throttling responses, XEraser waits and continues instead of hammering the endpoint.

Some features depend on internal X endpoints or UI selectors. X changes these periodically, so occasional maintenance is expected.

## Supported actions

| Action | Input required | Notes |
|---|---|---|
| Tweets | X export `.js` file | Supports date filtering and skipping newest tweets (`0–100`) |
| Likes | X export `.js` file | Supports date filtering |
| DMs | X export `.js` file | Deletes conversations using logged-in browser auth |
| Bookmarks | None | Runs from the bookmarks page using in-browser UI interaction |
| Unfollow all | None | Runs from your profile/following list using in-browser UI interaction |
| Slow delete | None | UI-only fallback for cases where export/API flow is not desired |

## Installation

1. Install a userscript manager such as Tampermonkey or Violentmonkey.
2. Open `dist/xeraser.user.js`.
3. Install the script in your userscript manager.
4. Visit `https://x.com` while logged in.

For GitHub-hosted installs, use the raw file URL from the repository once uploaded.

## How to use

### Delete tweets

1. Request your X data export and download the tweet archive file.
2. Open `x.com` while logged in.
3. Select **Tweets**.
4. Load the export `.js` file.
5. Optionally set a date range.
6. Set **Skip newest tweets** to a value between `0` and `100` to preserve your most recent tweets.
7. Click **Start**.

### Delete likes

1. Select **Likes**.
2. Load the likes export `.js` file.
3. Optionally set a date range.
4. Click **Start**.

### Delete DMs

1. Select **DMs**.
2. Load the direct message export `.js` file.
3. Click **Start**.

### Remove bookmarks

1. Select **Bookmarks**.
2. If needed, XEraser will redirect you to the bookmarks page.
3. Start the run again once the page is loaded.

### Unfollow everyone

1. Open your profile on X.
2. Select **Unfollow all**.
3. Click **Start**.

### Resume a run

If an API-backed run stops partway through, XEraser stores the remaining IDs in local storage. Reloading the page shows a resume banner.

## File structure

```text
XEraser/
├── .github/
│   └── workflows/
│       └── release.yml
├── dist/
│   └── xeraser.user.js
├── src/
│   └── xeraser.user.js
├── .gitignore
├── CHANGELOG.md
├── LICENSE
├── package.json
└── README.md
```

## Release flow

1. Update the version in `src/xeraser.user.js` and `dist/xeraser.user.js`.
2. Update `CHANGELOG.md`.
3. Commit and push to GitHub.
4. Create a tag such as `v2.0.0`.
5. Publish a GitHub release.
6. Verify the raw GitHub URL installs correctly in your userscript manager.

## Publishing to GitHub

Repository owner target: `https://github.com/thenayanhazra`

Suggested repository name: `XEraser`

After upload, make sure these metadata values match the final repo:

- `@namespace`
- `@downloadURL`
- `@updateURL`
- `@supportURL`

## Safety and expectations

This tool performs destructive actions. Review the action you select before starting.

For tweets, the `Skip newest tweets` option preserves your latest posts and is capped at `100` by design.

The bookmark and unfollow flows are intentionally slower because they rely on the live interface and should behave more like user-driven actions.

## License

MIT
