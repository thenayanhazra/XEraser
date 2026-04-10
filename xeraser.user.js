// ==UserScript==
// @name         XEraser
// @namespace    https://github.com/thenayanhazra/XEraser
// @version      1.0.0
// @description  Delete your tweets, likes, DMs, bookmarks — or unfollow everyone. Free.
// @author       Nayan
// @license      MIT
// @match        https://x.com/*
// @match        https://mobile.x.com/*
// @icon         https://www.google.com/s2/favicons?domain=x.com
// @grant        none
// @run-at       document-idle
// @downloadURL  https://github.com/thenayanhazra/XEraser/raw/main/xeraser.user.js
// @updateURL    https://github.com/thenayanhazra/XEraser/raw/main/xeraser.user.js
// @supportURL   https://github.com/thenayanhazra/XEraser/issues
// ==/UserScript==

(function () {
  'use strict';

  // ─── Constants ──────────────────────────────────────────────────────

  const BEARER =
    'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  const ENDPOINTS = {
    deleteTweet: '/i/api/graphql/VaenaVgh5q5ih7kvyVjgtg/DeleteTweet',
    unfavorite: '/i/api/graphql/ZYKSe-w7KEslx3JhSIk5LA/UnfavoriteTweet',
    deleteDM: '/i/api/graphql/BJ6DtxA2llfjnRoRjaiIiw/DMMessageDeleteMutation',
    deleteConvo: '/i/api/1.1/dm/conversation/{id}/delete.json',
    bookmarks: '/i/api/graphql/L7vvM2UluPgWOW4GDvWyvw/Bookmarks?',
  };

  const BOOKMARKS_FEATURES = JSON.stringify({
    graphql_timeline_v2_bookmark_timeline: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    rweb_video_timestamps_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_enhance_cards_enabled: false,
  });

  // ─── Utilities ──────────────────────────────────────────────────────

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getCookie(name) {
    const m = `; ${document.cookie}`.match(`;\\s*${name}=([^;]+)`);
    return m ? m[1] : null;
  }

  function generateTransactionId() {
    return [...crypto.getRandomValues(new Uint8Array(95))]
      .map((x) => {
        const i = (x / 255 * 61) | 0;
        return String.fromCharCode(i + (i > 9 ? (i > 35 ? 61 : 55) : 48));
      })
      .join('');
  }

  function waitForElement(selector, timeout = 10000) {
    const el = document.querySelector(selector);
    if (el) return Promise.resolve(el);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for ${selector}`));
      }, timeout);
      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          clearTimeout(timer);
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { subtree: true, childList: true });
    });
  }

  // ─── File Parser (pure — no side effects) ──────────────────────────

  function parseExportFile(text) {
    const eqIdx = text.indexOf('= ');
    const header = text.slice(0, eqIdx);
    const json = JSON.parse(text.slice(eqIdx + 1));

    if (header.includes('.tweet_headers.')) {
      return { action: 'tweets', ids: json.map((x) => x.tweet.tweet_id) };
    }
    if (header.includes('.tweets.') || header.includes('.tweet.')) {
      return { action: 'tweets', ids: json.map((x) => x.tweet.id_str) };
    }
    if (header.includes('.like.')) {
      return { action: 'likes', ids: json.map((x) => x.like.tweetId) };
    }
    if (
      header.includes('.direct_message_headers.') ||
      header.includes('.direct_message_group_headers.') ||
      header.includes('.direct_messages.') ||
      header.includes('.direct_message_groups.')
    ) {
      const convoIds = json.map((c) => c.dmConversation.conversationId);
      return { action: 'conversations', ids: convoIds };
    }

    throw new Error('Unrecognized file. Use a file from your X/Twitter data export.');
  }

  function computeSkip(totalInFile, profileCount, manualSkip) {
    if (manualSkip !== null) return Math.max(0, manualSkip);
    // Auto-skip: difference minus 5% tolerance
    const auto = totalInFile - profileCount - Math.floor(totalInFile / 20);
    return Math.max(0, auto);
  }

  // ─── API Layer ──────────────────────────────────────────────────────

  function createAPI(baseUrl) {
    let ct0 = getCookie('ct0');
    let txId = generateTransactionId();

    function headers(contentType = 'application/json') {
      ct0 = getCookie('ct0'); // refresh each call
      txId = generateTransactionId();
      return {
        authorization: BEARER,
        'content-type': contentType,
        'x-client-transaction-id': txId,
        'x-csrf-token': ct0,
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
      };
    }

    async function waitForRateLimit(response, onWaiting) {
      const remaining = response.headers.get('x-rate-limit-remaining');
      const reset = response.headers.get('x-rate-limit-reset');
      if (remaining !== null && parseInt(remaining) < 1 && reset) {
        const resetTime = parseInt(reset);
        let wait = resetTime - Math.floor(Date.now() / 1000);
        while (wait > 0) {
          if (onWaiting) onWaiting(wait);
          await sleep(1000);
          wait = resetTime - Math.floor(Date.now() / 1000);
        }
      }
    }

    // Core POST with retry on 429, timeout handling, rate-limit sleep
    async function post(url, body, { onWaiting, maxRetries = 3, successStatus = 200 } = {}) {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const response = await fetch(baseUrl + url, {
            headers: headers(),
            referrerPolicy: 'strict-origin-when-cross-origin',
            body: typeof body === 'string' ? body : JSON.stringify(body),
            method: 'POST',
            mode: 'cors',
            credentials: 'include',
            signal: AbortSignal.timeout(8000),
          });

          if (response.status === successStatus || response.status === 200) {
            await waitForRateLimit(response, onWaiting);
            return { ok: true, response };
          }

          if (response.status === 429 || response.status === 420) {
            const backoff = Math.min(60 * (attempt + 1), 300);
            for (let s = backoff; s > 0; s--) {
              if (onWaiting) onWaiting(s);
              await sleep(1000);
            }
            continue;
          }

          // Other errors — log and treat as failure
          console.warn(`[XEraser] Unexpected status ${response.status}`, await response.text().catch(() => ''));
          return { ok: false, status: response.status };

        } catch (err) {
          if (err.name === 'TimeoutError' || err.name === 'AbortError') {
            await sleep(5000);
            continue;
          }
          throw err;
        }
      }
      return { ok: false, status: 'max_retries' };
    }

    async function get(url, params, { onWaiting } = {}) {
      ct0 = getCookie('ct0');
      txId = generateTransactionId();
      const fullUrl = baseUrl + url + new URLSearchParams(params);
      const response = await fetch(fullUrl, {
        headers: headers(),
        referrerPolicy: 'strict-origin-when-cross-origin',
        method: 'GET',
        mode: 'cors',
        credentials: 'include',
      });
      if (response.ok) {
        await waitForRateLimit(response, onWaiting);
      }
      return response;
    }

    return { post, get, waitForRateLimit };
  }

  // ─── Deletion Workers ──────────────────────────────────────────────

  async function deleteTweets(api, ids, onProgress, signal) {
    for (let i = ids.length - 1; i >= 0; i--) {
      if (signal.aborted) return;
      const id = ids[i];
      const queryId = ENDPOINTS.deleteTweet.split('/')[6];
      const body = JSON.stringify({
        variables: { tweet_id: id, dark_request: false },
        queryId,
      });
      const result = await api.post(ENDPOINTS.deleteTweet, body, {
        onWaiting: (s) => onProgress({ waiting: s, id }),
      });
      if (result.ok) onProgress({ deleted: id, remaining: i });
    }
  }

  async function deleteLikes(api, ids, onProgress, signal) {
    for (let i = ids.length - 1; i >= 0; i--) {
      if (signal.aborted) return;
      const id = ids[i];
      const queryId = ENDPOINTS.unfavorite.split('/')[6];
      const body = JSON.stringify({
        variables: { tweet_id: id, dark_request: false },
        queryId,
      });
      const result = await api.post(ENDPOINTS.unfavorite, body, {
        onWaiting: (s) => onProgress({ waiting: s, id }),
      });
      if (result.ok) onProgress({ deleted: id, remaining: i });
    }
  }

  async function deleteConversations(api, ids, onProgress, signal) {
    for (let i = ids.length - 1; i >= 0; i--) {
      if (signal.aborted) return;
      const id = ids[i];
      const url = ENDPOINTS.deleteConvo.replace('{id}', id);
      const formBody = 'dm_secret_conversations_enabled=false&krs_registration_enabled=true&cards_platform=Web-12&include_cards=1&include_ext_alt_text=true&include_ext_limited_action_results=true&include_quote_count=true&include_reply_count=1&tweet_mode=extended&include_ext_views=true&dm_users=false&include_groups=true&include_inbox_timelines=true&include_ext_media_color=true&supports_reactions=true&supports_edit=true&include_conversation_info=true';

      const result = await api.post(url, formBody, {
        onWaiting: (s) => onProgress({ waiting: s, id }),
        successStatus: 204,
      });
      if (result.ok) {
        onProgress({ deleted: id, remaining: i });
        await sleep(Math.floor(Math.random() * 200));
      }
    }
  }

  async function exportBookmarks(api, onProgress) {
    const all = [];
    let cursor = '';

    while (true) {
      const variables = cursor
        ? `{"count":20,"cursor":"${cursor}","includePromotedContent":false}`
        : '{"count":20,"includePromotedContent":false}';

      const response = await api.get(ENDPOINTS.bookmarks, {
        variables,
        features: BOOKMARKS_FEATURES,
      });

      if (!response.ok) break;

      const data = await response.json();
      const entries = data.data.bookmark_timeline_v2.timeline.instructions[0].entries;
      let newCursor = '';

      for (const entry of entries) {
        if (entry.entryId.includes('tweet')) {
          all.push(entry.content.itemContent.tweet_results.result);
        } else if (entry.entryId.includes('cursor-bottom')) {
          newCursor = entry.content.value;
        }
      }

      onProgress(all.length);

      if (!newCursor || newCursor === cursor) break;
      cursor = newCursor;
    }

    return all;
  }

  async function slowDeleteFromUI(onProgress, signal) {
    // Navigate to replies tab
    const tabs = document.querySelectorAll('[data-testid="ScrollSnap-List"] a');
    if (tabs[1]) tabs[1].click();
    await sleep(2000);

    const CARET = '[data-testid="tweet"] [data-testid="caret"]';
    let deleted = 0;
    let consecutiveErrors = 0;

    while (document.querySelectorAll(CARET).length > 0) {
      if (signal.aborted) return deleted;
      await sleep(1200);

      // Remove non-tweet cards (recommendations, etc.)
      document.querySelectorAll('section [data-testid="cellInnerDiv"]>div>div>div').forEach((x) => x.remove());
      document.querySelectorAll('section [data-testid="cellInnerDiv"]>div>div>[role="link"]').forEach((x) => x.remove());

      try {
        const caret = document.querySelector(CARET);
        if (!caret) break;
        caret.scrollIntoView({ behavior: 'smooth' });

        // Retweet → undo retweet
        const unretweet = document.querySelector('[data-testid="unretweet"]');
        if (unretweet) {
          unretweet.click();
          const confirm = await waitForElement('[data-testid="unretweetConfirm"]');
          confirm.click();
        } else {
          caret.click();
          const menu = await waitForElement('[role="menuitem"]');
          if (menu.textContent.includes('@')) {
            // This is someone else's tweet in our replies tab — skip
            caret.click();
            document.querySelector('[data-testid="tweet"]')?.remove();
          } else {
            menu.click();
            const confirm = await waitForElement('[data-testid="confirmationSheetConfirm"]');
            if (confirm) confirm.click();
          }
        }

        deleted++;
        consecutiveErrors = 0;
        onProgress(deleted);
      } catch {
        consecutiveErrors++;
        if (consecutiveErrors >= 5) break;
      }
    }

    return deleted;
  }

  async function unfollowAll(onProgress, signal) {
    const link = document.querySelector('[href$="/following"]');
    if (!link) throw new Error('Navigate to your profile first.');
    link.click();
    await sleep(1500);

    let count = 0;
    while (true) {
      if (signal.aborted) return count;
      const cells = document.querySelectorAll('[data-testid="UserCell"] [data-testid$="-unfollow"]');
      if (cells.length === 0) break;

      const btn = cells[0];
      const cell = btn.closest('[data-testid="UserCell"]');
      cell.scrollIntoView({ behavior: 'smooth' });
      btn.click();

      try {
        const confirm = await waitForElement('[data-testid="confirmationSheetConfirm"]');
        confirm.click();
      } catch { break; }

      cell.remove();
      count++;
      onProgress(count);
      await sleep(Math.floor(Math.random() * 200));
    }

    return count;
  }

  // ─── Profile Tweet Count ───────────────────────────────────────────

  async function getProfileTweetCount() {
    await waitForElement('header');
    await sleep(1000);

    // If not on profile, try to navigate there
    if (!document.querySelector('[data-testid="UserName"]')) {
      const back = document.querySelector('[aria-label="Back"]') ||
                   document.querySelector('[data-testid="app-bar-back"]');
      if (back) { back.click(); await sleep(1000); }

      const profileLink = document.querySelector('[data-testid="AppTabBar_Profile_Link"]') ||
                          document.querySelector('[data-testid="DashButton_ProfileIcon_Link"]');
      if (profileLink) { profileLink.click(); await sleep(1000); }

      try { await waitForElement('[data-testid="UserName"]'); } catch {}
      await sleep(1000);
    }

    function extract(selector) {
      const el = document.querySelector(selector);
      if (!el) return null;
      const m = el.textContent.match(/([\d,.\dK]+)\s+\w+$/);
      if (!m) return null;
      return parseInt(
        m[1].replace(/\.(\d+)K/, (_, d) => d.padEnd(4, '0')).replace('K', '000').replace(/[,.]/g, ''),
        10
      );
    }

    return (
      extract('[data-testid="primaryColumn"]>div>div>div') ||
      extract('[data-testid="TopNavBar"]>div>div') ||
      1000000
    );
  }

  // ─── UI ─────────────────────────────────────────────────────────────

  const PANEL_ID = 'xeraser-panel';

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');

      #${PANEL_ID} {
        position: sticky;
        top: 0;
        z-index: 99999;
        font-family: 'DM Sans', system-ui, sans-serif;
        background: #0c0c0e;
        color: #e4e4e7;
        border-bottom: 1px solid #27272a;
        padding: 20px clamp(16px, 4vw, 48px);
        line-height: 1.5;
      }
      #${PANEL_ID} * { box-sizing: border-box; }

      .xer-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 16px;
      }
      .xer-title {
        font-size: 18px;
        font-weight: 700;
        letter-spacing: -0.02em;
        color: #fafafa;
      }
      .xer-title span { color: #f87171; }
      .xer-version {
        font-family: 'DM Mono', monospace;
        font-size: 11px;
        color: #52525b;
      }
      .xer-close {
        background: none; border: none; color: #71717a; font-size: 20px;
        cursor: pointer; padding: 4px 8px; border-radius: 4px;
      }
      .xer-close:hover { background: #18181b; color: #e4e4e7; }

      /* Action grid */
      .xer-actions {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 8px;
        margin-bottom: 16px;
      }
      .xer-action-btn {
        background: #18181b;
        border: 1px solid #27272a;
        border-radius: 8px;
        padding: 12px;
        color: #a1a1aa;
        font-family: inherit;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        text-align: left;
        transition: all 0.15s;
      }
      .xer-action-btn:hover {
        border-color: #3f3f46;
        background: #1c1c1f;
        color: #e4e4e7;
      }
      .xer-action-btn.active {
        border-color: #f87171;
        background: #1a0a0a;
        color: #fca5a5;
      }
      .xer-action-btn .xer-action-label {
        display: block;
        font-weight: 600;
        color: #e4e4e7;
        margin-bottom: 2px;
      }
      .xer-action-btn.active .xer-action-label { color: #fca5a5; }
      .xer-action-btn .xer-action-hint {
        font-size: 11px;
        color: #52525b;
      }

      /* File input and controls */
      .xer-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .xer-file-label {
        display: inline-block;
        background: #27272a;
        border: 1px solid #3f3f46;
        border-radius: 6px;
        padding: 8px 14px;
        font-family: inherit;
        font-size: 13px;
        color: #e4e4e7;
        cursor: pointer;
        font-weight: 500;
      }
      .xer-file-label:hover { background: #3f3f46; }
      .xer-file-label input { display: none; }

      .xer-go {
        background: #dc2626;
        border: none;
        border-radius: 6px;
        padding: 8px 20px;
        color: #fff;
        font-family: inherit;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
      }
      .xer-go:hover { background: #b91c1c; }
      .xer-go:disabled { opacity: 0.4; cursor: not-allowed; }

      .xer-stop {
        background: #3f3f46;
        border: none;
        border-radius: 6px;
        padding: 8px 16px;
        color: #e4e4e7;
        font-family: inherit;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
      }
      .xer-stop:hover { background: #52525b; }

      .xer-skip-input {
        background: #18181b;
        border: 1px solid #27272a;
        border-radius: 6px;
        padding: 8px 10px;
        color: #e4e4e7;
        font-family: 'DM Mono', monospace;
        font-size: 12px;
        width: 100px;
      }
      .xer-skip-input::placeholder { color: #3f3f46; }

      /* Progress */
      .xer-progress-wrap { margin-top: 12px; }
      .xer-progress-bar {
        width: 100%;
        height: 4px;
        background: #27272a;
        border-radius: 2px;
        overflow: hidden;
      }
      .xer-progress-fill {
        height: 100%;
        background: #f87171;
        border-radius: 2px;
        transition: width 0.3s;
        width: 0%;
      }
      .xer-status {
        font-family: 'DM Mono', monospace;
        font-size: 12px;
        color: #71717a;
        margin-top: 6px;
      }
    `;
    document.head.appendChild(style);
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) document.getElementById(PANEL_ID).remove();

    const div = document.createElement('div');
    div.id = PANEL_ID;
    div.innerHTML = `
      <div class="xer-header">
        <div>
          <span class="xer-title">X<span>Eraser</span></span>
          <span class="xer-version">v1.0.0</span>
        </div>
        <button class="xer-close" id="xer-close">&times;</button>
      </div>

      <div class="xer-actions" id="xer-actions">
        <button class="xer-action-btn" data-action="tweets">
          <span class="xer-action-label">Tweets</span>
          <span class="xer-action-hint">Needs tweet-headers.js</span>
        </button>
        <button class="xer-action-btn" data-action="likes">
          <span class="xer-action-label">Likes</span>
          <span class="xer-action-hint">Needs like.js</span>
        </button>
        <button class="xer-action-btn" data-action="conversations">
          <span class="xer-action-label">DMs</span>
          <span class="xer-action-hint">Needs dm-headers.js</span>
        </button>
        <button class="xer-action-btn" data-action="slow-delete">
          <span class="xer-action-label">Slow delete</span>
          <span class="xer-action-hint">No file needed</span>
        </button>
        <button class="xer-action-btn" data-action="unfollow">
          <span class="xer-action-label">Unfollow all</span>
          <span class="xer-action-hint">No file needed</span>
        </button>
        <button class="xer-action-btn" data-action="bookmarks">
          <span class="xer-action-label">Export bookmarks</span>
          <span class="xer-action-hint">Downloads JSON</span>
        </button>
      </div>

      <div class="xer-controls" id="xer-controls">
        <label class="xer-file-label" id="xer-file-label" style="display:none;">
          Choose file
          <input type="file" id="xer-file" accept=".js" />
        </label>
        <input class="xer-skip-input" id="xer-skip" type="number" placeholder="Skip #" title="Tweets to skip (oldest first)" style="display:none;" />
        <button class="xer-go" id="xer-go" disabled>Start</button>
        <button class="xer-stop" id="xer-stop" style="display:none;">Stop</button>
      </div>

      <div class="xer-progress-wrap" id="xer-progress" style="display:none;">
        <div class="xer-progress-bar"><div class="xer-progress-fill" id="xer-fill"></div></div>
        <div class="xer-status" id="xer-status"></div>
      </div>
    `;

    document.body.insertBefore(div, document.body.firstChild);
    return div;
  }

  // ─── Controller ─────────────────────────────────────────────────────

  async function main() {
    injectStyles();
    const panel = createPanel();

    const baseUrl = `https://${window.location.hostname}`;
    const api = createAPI(baseUrl);
    const profileCount = await getProfileTweetCount();

    // State
    let selectedAction = null;
    let parsedFile = null;
    let abortController = null;

    // DOM refs
    const actions = panel.querySelectorAll('.xer-action-btn');
    const fileLabel = panel.querySelector('#xer-file-label');
    const fileInput = panel.querySelector('#xer-file');
    const skipInput = panel.querySelector('#xer-skip');
    const goBtn = panel.querySelector('#xer-go');
    const stopBtn = panel.querySelector('#xer-stop');
    const progressWrap = panel.querySelector('#xer-progress');
    const fill = panel.querySelector('#xer-fill');
    const status = panel.querySelector('#xer-status');
    const closeBtn = panel.querySelector('#xer-close');

    const NEEDS_FILE = new Set(['tweets', 'likes', 'conversations']);

    function setStatus(text) { status.textContent = text; }
    function setProgress(ratio) { fill.style.width = `${Math.min(100, ratio * 100)}%`; }

    function updateReadiness() {
      if (!selectedAction) { goBtn.disabled = true; return; }
      if (NEEDS_FILE.has(selectedAction) && !parsedFile) { goBtn.disabled = true; return; }
      goBtn.disabled = false;
    }

    // Action selection
    actions.forEach((btn) => {
      btn.addEventListener('click', () => {
        actions.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        selectedAction = btn.dataset.action;
        parsedFile = null;
        fileInput.value = '';

        const needsFile = NEEDS_FILE.has(selectedAction);
        fileLabel.style.display = needsFile ? '' : 'none';
        skipInput.style.display = selectedAction === 'tweets' ? '' : 'none';

        updateReadiness();
      });
    });

    // File selection
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onloadend = (e) => {
        try {
          parsedFile = parseExportFile(e.target.result);
          setStatus(`Loaded ${parsedFile.ids.length} ${parsedFile.action}`);
          progressWrap.style.display = '';
          // Override action from file content if different
          selectedAction = parsedFile.action;
          actions.forEach((b) => {
            b.classList.toggle('active', b.dataset.action === selectedAction);
          });
          updateReadiness();
        } catch (err) {
          setStatus(err.message);
        }
      };
      reader.readAsText(file);
    });

    // Stop
    stopBtn.addEventListener('click', () => {
      if (abortController) abortController.abort();
    });

    // Close
    closeBtn.addEventListener('click', () => panel.remove());

    // Start
    goBtn.addEventListener('click', async () => {
      goBtn.disabled = true;
      stopBtn.style.display = '';
      progressWrap.style.display = '';
      abortController = new AbortController();

      let deleted = 0;

      function onProgress(info) {
        if (info.deleted !== undefined) {
          deleted++;
          setProgress(deleted / total);
          setStatus(`${deleted} / ${total} — ${info.deleted}`);
        }
        if (info.waiting !== undefined) {
          setStatus(`Rate limited — resuming in ${info.waiting}s (${deleted} deleted)`);
        }
      }

      let total = 0;

      try {
        if (selectedAction === 'tweets' && parsedFile) {
          const skip = computeSkip(
            parsedFile.ids.length,
            profileCount,
            skipInput.value ? parseInt(skipInput.value) : null
          );
          const ids = parsedFile.ids.slice().reverse().slice(skip);
          total = parsedFile.ids.length;
          deleted = skip;
          setStatus(`Skipping ${skip}, deleting ${ids.length} tweets`);
          await deleteTweets(api, ids, onProgress, abortController.signal);

        } else if (selectedAction === 'likes' && parsedFile) {
          total = parsedFile.ids.length;
          await deleteLikes(api, parsedFile.ids.slice().reverse(), onProgress, abortController.signal);

        } else if (selectedAction === 'conversations' && parsedFile) {
          total = parsedFile.ids.length;
          await deleteConversations(api, parsedFile.ids.slice().reverse(), onProgress, abortController.signal);

        } else if (selectedAction === 'slow-delete') {
          total = profileCount;
          await slowDeleteFromUI((count) => {
            deleted = count;
            setProgress(count / total);
            setStatus(`${count} deleted from UI`);
          }, abortController.signal);

        } else if (selectedAction === 'unfollow') {
          total = Infinity;
          await unfollowAll((count) => {
            setStatus(`Unfollowed ${count}`);
          }, abortController.signal);

        } else if (selectedAction === 'bookmarks') {
          total = Infinity;
          const bookmarks = await exportBookmarks(api, (count) => {
            setStatus(`Collected ${count} bookmarks`);
          });

          const blob = new Blob([JSON.stringify(bookmarks, null, 2)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'x-bookmarks.json';
          a.click();
          setStatus(`Exported ${bookmarks.length} bookmarks`);
        }

        setStatus(abortController.signal.aborted ? 'Stopped.' : 'Done.');

      } catch (err) {
        setStatus(`Error: ${err.message}`);
        console.error('[XEraser]', err);
      }

      stopBtn.style.display = 'none';
      goBtn.disabled = false;
      updateReadiness();
    });

    setStatus(`${profileCount.toLocaleString()} tweets on profile. Select an action above.`);
  }

  main();
})();
