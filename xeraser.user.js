// ==UserScript==
// @name         XEraser
// @namespace    https://github.com/thenayanhazra/XEraser
// @version      2.0.0
// @description  Delete tweets, likes, DMs, and bookmarks — or unfollow everyone — from your logged-in X session.
// @author       Nayan
// @license      MIT
// @match        https://x.com/*
// @match        https://mobile.x.com/*
// @grant        none
// @run-at       document-idle
// @downloadURL  https://github.com/thenayanhazra/XEraser/raw/main/xeraser.user.js
// @updateURL    https://github.com/thenayanhazra/XEraser/raw/main/xeraser.user.js
// @supportURL   https://github.com/thenayanhazra/XEraser/issues
// ==/UserScript==

(function () {
  'use strict';

  const APP = {
    name: 'XEraser',
    version: '2.0.0',
    storageKey: 'xeraser.session.v2',
    panelId: 'xeraser-panel',
    maxKeepLatestTweets: 100,
    rateLimitFloorSeconds: 5,
    domActionDelayMs: [350, 900],
    requestTimeoutMs: 15000,
    waitForElementTimeoutMs: 12000,
  };

  const AUTH = {
    bearer:
      'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
  };

  const ENDPOINTS = {
    deleteTweet: '/i/api/graphql/VaenaVgh5q5ih7kvyVjgtg/DeleteTweet',
    unfavorite: '/i/api/graphql/ZYKSe-w7KEslx3JhSIk5LA/UnfavoriteTweet',
    deleteConversation: '/i/api/1.1/dm/conversation/{id}/delete.json',
  };

  const selectors = {
    profileName: '[data-testid="UserName"]',
    profileLink: '[data-testid="AppTabBar_Profile_Link"], [data-testid="DashButton_ProfileIcon_Link"]',
    backButton: '[aria-label="Back"], [data-testid="app-bar-back"]',
    followingsLink: '[href$="/following"]',
    userCell: '[data-testid="UserCell"]',
    unfollowButton: '[data-testid$="-unfollow"]',
    confirmation: '[data-testid="confirmationSheetConfirm"]',
    bookmarkCell: 'article[data-testid="tweet"], [data-testid="cellInnerDiv"] article',
    bookmarkButton: '[data-testid="removeBookmark"], [data-testid="bookmark"]',
    tweetCaret: '[data-testid="tweet"] [data-testid="caret"]',
    menuItem: '[role="menuitem"]',
    scrollSnapTabs: '[data-testid="ScrollSnap-List"] a',
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function clampKeepLatest(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 0;
    return clamp(parsed, 0, APP.maxKeepLatestTweets);
  }

  function formatDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function getCookie(name) {
    const source = `; ${document.cookie}`;
    const match = source.match(`;\\s*${name}=([^;]+)`);
    return match ? match[1] : null;
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function saveSession(session) {
    try {
      localStorage.setItem(APP.storageKey, JSON.stringify(session));
    } catch {
      // ignore storage errors
    }
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(APP.storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function clearSession() {
    try {
      localStorage.removeItem(APP.storageKey);
    } catch {
      // ignore storage errors
    }
  }

  function dateFromSnowflake(id) {
    const epoch = 1288834974657n;
    const value = BigInt(String(id));
    const ms = (value >> 22n) + epoch;
    return new Date(Number(ms));
  }

  function detectExportType(header) {
    if (header.includes('.tweet_headers.')) return 'tweet_headers';
    if (header.includes('.tweets.') || header.includes('.tweet.')) return 'tweets';
    if (header.includes('.like.')) return 'likes';
    if (
      header.includes('.direct_message_headers.') ||
      header.includes('.direct_message_group_headers.') ||
      header.includes('.direct_messages.') ||
      header.includes('.direct_message_groups.')
    ) {
      return 'conversations';
    }
    return null;
  }

  function parseExportFile(text) {
    const splitAt = text.indexOf('= ');
    if (splitAt < 0) {
      throw new Error('Unsupported file format. Use a JavaScript file from your X export.');
    }

    const header = text.slice(0, splitAt);
    const type = detectExportType(header);
    if (!type) {
      throw new Error('Unrecognized export file. Use tweets, likes, or direct-message export files from X.');
    }

    const json = safeJsonParse(text.slice(splitAt + 1));
    if (!Array.isArray(json)) {
      throw new Error('Invalid export payload. Expected an array.');
    }

    if (type === 'tweet_headers') {
      return {
        action: 'tweets',
        entries: json
          .map((item) => item?.tweet?.tweet_id)
          .filter(Boolean)
          .map((id) => ({ id: String(id), date: dateFromSnowflake(id) })),
      };
    }

    if (type === 'tweets') {
      return {
        action: 'tweets',
        entries: json
          .map((item) => item?.tweet)
          .filter(Boolean)
          .map((tweet) => ({
            id: String(tweet.id_str),
            date: tweet.created_at ? new Date(tweet.created_at) : dateFromSnowflake(tweet.id_str),
          }))
          .filter((entry) => entry.id),
      };
    }

    if (type === 'likes') {
      return {
        action: 'likes',
        entries: json
          .map((item) => item?.like?.tweetId)
          .filter(Boolean)
          .map((id) => ({ id: String(id), date: dateFromSnowflake(id) })),
      };
    }

    return {
      action: 'conversations',
      entries: json
        .map((item) => item?.dmConversation?.conversationId)
        .filter(Boolean)
        .map((id) => ({ id: String(id), date: null })),
    };
  }

  function filterEntriesByDate(entries, fromDate, toDate) {
    return entries.filter((entry) => {
      if (!entry.date) return true;
      if (fromDate && entry.date < fromDate) return false;
      if (toDate && entry.date > toDate) return false;
      return true;
    });
  }

  function prepareTweetDeletionPlan(entries, options) {
    const { fromDate, toDate, keepLatest } = options;
    const filtered = filterEntriesByDate(entries, fromDate, toDate);
    const sortedNewestFirst = [...filtered].sort((a, b) => {
      const left = a.date ? a.date.getTime() : 0;
      const right = b.date ? b.date.getTime() : 0;
      return right - left;
    });
    const keep = sortedNewestFirst.slice(0, keepLatest);
    const deleteSet = sortedNewestFirst.slice(keepLatest);
    const deleteOldestFirst = deleteSet.sort((a, b) => {
      const left = a.date ? a.date.getTime() : 0;
      const right = b.date ? b.date.getTime() : 0;
      return left - right;
    });

    return {
      keepCount: keep.length,
      deleteCount: deleteOldestFirst.length,
      idsToDelete: deleteOldestFirst.map((entry) => entry.id),
      filteredCount: filtered.length,
    };
  }

  function createAbortableTimeout(timeoutMs) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(timeoutMs);
    }

    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timeout', 'AbortError')), timeoutMs);
    return controller.signal;
  }

  async function waitForElement(selector, timeoutMs = APP.waitForElementTimeoutMs) {
    const immediate = document.querySelector(selector);
    if (immediate) return immediate;

    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (!found) return;
        clearTimeout(timer);
        observer.disconnect();
        resolve(found);
      });

      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for ${selector}`));
      }, timeoutMs);

      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  function createXClient(baseUrl) {
    function buildHeaders(contentType = 'application/json') {
      return {
        authorization: AUTH.bearer,
        'content-type': contentType,
        'x-client-transaction-id': crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
        'x-csrf-token': getCookie('ct0') || '',
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
      };
    }

    function parseRateLimitHeaders(response) {
      const remainingRaw = response.headers.get('x-rate-limit-remaining');
      const resetRaw = response.headers.get('x-rate-limit-reset');
      const remaining = remainingRaw == null ? null : Number.parseInt(remainingRaw, 10);
      const reset = resetRaw == null ? null : Number.parseInt(resetRaw, 10);
      return { remaining, reset };
    }

    async function waitForRateLimitIfNeeded(response, notifyWaiting) {
      const { remaining, reset } = parseRateLimitHeaders(response);
      if (remaining == null || reset == null || remaining > 0) return;

      while (true) {
        const seconds = reset - Math.floor(Date.now() / 1000);
        if (seconds <= 0) return;
        notifyWaiting?.(seconds);
        await sleep(1000);
      }
    }

    async function request(method, url, options = {}) {
      const {
        body,
        contentType = 'application/json',
        successStatuses = [200],
        maxRetries = 4,
        notifyWaiting,
      } = options;

      for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        try {
          const response = await fetch(baseUrl + url, {
            method,
            headers: buildHeaders(contentType),
            body,
            mode: 'cors',
            credentials: 'include',
            referrerPolicy: 'strict-origin-when-cross-origin',
            signal: createAbortableTimeout(APP.requestTimeoutMs),
          });

          if (successStatuses.includes(response.status)) {
            await waitForRateLimitIfNeeded(response, notifyWaiting);
            return { ok: true, response };
          }

          if (response.status === 420 || response.status === 429) {
            const { reset } = parseRateLimitHeaders(response);
            if (reset) {
              while (true) {
                const seconds = Math.max(APP.rateLimitFloorSeconds, reset - Math.floor(Date.now() / 1000));
                if (seconds <= 0) break;
                notifyWaiting?.(seconds);
                await sleep(1000);
                if (reset - Math.floor(Date.now() / 1000) <= 0) break;
              }
            } else {
              const backoff = Math.min(120, 5 * (attempt + 1)) + randomInt(0, 3);
              for (let seconds = backoff; seconds > 0; seconds -= 1) {
                notifyWaiting?.(seconds);
                await sleep(1000);
              }
            }
            continue;
          }

          const text = await response.text().catch(() => '');
          return { ok: false, status: response.status, body: text };
        } catch (error) {
          const timeoutLike = error?.name === 'AbortError' || error?.name === 'TimeoutError';
          if (!timeoutLike || attempt === maxRetries - 1) {
            return { ok: false, status: 'network_error', body: String(error?.message || error) };
          }

          const backoff = 3 * (attempt + 1);
          for (let seconds = backoff; seconds > 0; seconds -= 1) {
            notifyWaiting?.(seconds);
            await sleep(1000);
          }
        }
      }

      return { ok: false, status: 'max_retries' };
    }

    function getGraphQLQueryId(endpoint) {
      const parts = endpoint.split('/');
      return parts[parts.length - 2];
    }

    return {
      async deleteTweet(id, notifyWaiting) {
        const endpoint = ENDPOINTS.deleteTweet;
        const body = JSON.stringify({
          variables: { tweet_id: String(id), dark_request: false },
          queryId: getGraphQLQueryId(endpoint),
        });
        return request('POST', endpoint, { body, notifyWaiting });
      },

      async unfavorite(id, notifyWaiting) {
        const endpoint = ENDPOINTS.unfavorite;
        const body = JSON.stringify({
          variables: { tweet_id: String(id), dark_request: false },
          queryId: getGraphQLQueryId(endpoint),
        });
        return request('POST', endpoint, { body, notifyWaiting });
      },

      async deleteConversation(id, notifyWaiting) {
        const endpoint = ENDPOINTS.deleteConversation.replace('{id}', String(id));
        const formBody = 'dm_secret_conversations_enabled=false&krs_registration_enabled=true&cards_platform=Web-12&include_cards=1&include_ext_alt_text=true&include_ext_limited_action_results=true&include_quote_count=true&include_reply_count=1&tweet_mode=extended&include_ext_views=true&dm_users=false&include_groups=true&include_inbox_timelines=true&include_ext_media_color=true&supports_reactions=true&supports_edit=true&include_conversation_info=true';
        return request('POST', endpoint, {
          body: formBody,
          contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
          successStatuses: [200, 204],
          notifyWaiting,
        });
      },
    };
  }

  function injectStyles() {
    if (document.getElementById(`${APP.panelId}-style`)) return;

    const style = document.createElement('style');
    style.id = `${APP.panelId}-style`;
    style.textContent = `
      #${APP.panelId} {
        position: sticky;
        top: 0;
        z-index: 2147483647;
        background: #0b0b0f;
        color: #e5e7eb;
        border-bottom: 1px solid #27272a;
        padding: 18px clamp(16px, 4vw, 48px);
        font: 14px/1.4 Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      }
      #${APP.panelId} * { box-sizing: border-box; }
      #${APP.panelId} .xe-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      #${APP.panelId} .xe-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px; }
      #${APP.panelId} .xe-title { font-size: 18px; font-weight: 700; color: #fafafa; }
      #${APP.panelId} .xe-subtitle { font-size: 12px; color: #9ca3af; }
      #${APP.panelId} .xe-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin-bottom: 14px; }
      #${APP.panelId} .xe-card {
        border: 1px solid #27272a;
        background: #141419;
        color: #d4d4d8;
        border-radius: 10px;
        padding: 12px;
        cursor: pointer;
        text-align: left;
      }
      #${APP.panelId} .xe-card.active { border-color: #ef4444; background: #1f1113; }
      #${APP.panelId} .xe-card .label { display: block; font-weight: 700; color: #f4f4f5; margin-bottom: 4px; }
      #${APP.panelId} .xe-card .hint { font-size: 12px; color: #9ca3af; }
      #${APP.panelId} input[type="number"],
      #${APP.panelId} input[type="date"] {
        background: #111827;
        color: #f9fafb;
        border: 1px solid #374151;
        border-radius: 8px;
        padding: 8px 10px;
      }
      #${APP.panelId} input[type="file"] { display: none; }
      #${APP.panelId} .xe-file {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        background: #1f2937;
        color: #f9fafb;
        border: 1px solid #374151;
        border-radius: 8px;
        padding: 8px 12px;
        cursor: pointer;
      }
      #${APP.panelId} button {
        border: 0;
        border-radius: 8px;
        padding: 9px 14px;
        cursor: pointer;
        font-weight: 600;
      }
      #${APP.panelId} .xe-primary { background: #dc2626; color: #fff; }
      #${APP.panelId} .xe-primary:disabled { opacity: 0.45; cursor: not-allowed; }
      #${APP.panelId} .xe-secondary { background: #374151; color: #f9fafb; }
      #${APP.panelId} .xe-progress { margin-top: 12px; }
      #${APP.panelId} .xe-bar { height: 4px; background: #27272a; border-radius: 999px; overflow: hidden; }
      #${APP.panelId} .xe-fill { height: 100%; background: #ef4444; width: 0%; transition: width 150ms ease; }
      #${APP.panelId} .xe-status { margin-top: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #d1d5db; }
      #${APP.panelId} .xe-banner {
        display: none;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        margin-bottom: 12px;
        border: 1px solid #854d0e;
        border-radius: 8px;
        background: #1c1917;
        color: #fbbf24;
      }
      #${APP.panelId} .xe-meta { color: #9ca3af; font-size: 12px; }
    `;
    document.head.appendChild(style);
  }

  function createPanel() {
    document.getElementById(APP.panelId)?.remove();

    const panel = document.createElement('div');
    panel.id = APP.panelId;
    panel.innerHTML = `
      <div class="xe-header">
        <div>
          <div class="xe-title">XEraser</div>
          <div class="xe-subtitle">Delete tweets, likes, DMs, and bookmarks — or unfollow everyone.</div>
        </div>
        <div class="xe-meta">v${APP.version}</div>
      </div>

      <div class="xe-banner" id="xe-resume-banner">
        <span id="xe-resume-text"></span>
        <div class="xe-row">
          <button class="xe-secondary" id="xe-resume-btn">Resume</button>
          <button class="xe-secondary" id="xe-resume-clear">Dismiss</button>
        </div>
      </div>

      <div class="xe-grid" id="xe-operations"></div>

      <div class="xe-row" style="margin-bottom: 10px;">
        <label class="xe-file" id="xe-file-wrap" style="display:none;">
          <span>Choose export file</span>
          <input type="file" id="xe-file-input" accept=".js" />
        </label>

        <div id="xe-date-wrap" class="xe-row" style="display:none;">
          <span class="xe-meta">From</span>
          <input type="date" id="xe-date-from" />
          <span class="xe-meta">To</span>
          <input type="date" id="xe-date-to" />
        </div>

        <div id="xe-keep-wrap" class="xe-row" style="display:none;">
          <span class="xe-meta">Skip newest tweets</span>
          <input type="number" id="xe-keep-input" min="0" max="100" placeholder="0-100" />
        </div>

        <button class="xe-primary" id="xe-start" disabled>Start</button>
        <button class="xe-secondary" id="xe-stop" style="display:none;">Stop</button>
      </div>

      <div class="xe-progress" id="xe-progress" style="display:none;">
        <div class="xe-bar"><div class="xe-fill" id="xe-fill"></div></div>
        <div class="xe-status" id="xe-status"></div>
      </div>
    `;

    document.body.insertBefore(panel, document.body.firstChild);
    return panel;
  }

  async function ensureProfileContext() {
    await waitForElement('header').catch(() => null);
    await sleep(500);

    if (document.querySelector(selectors.profileName)) return;

    const back = document.querySelector(selectors.backButton);
    if (back) {
      back.click();
      await sleep(900);
    }

    const profileLink = document.querySelector(selectors.profileLink);
    if (profileLink) {
      profileLink.click();
      await sleep(1100);
    }
  }

  async function getProfileTweetCount() {
    await ensureProfileContext();
    await waitForElement('header').catch(() => null);

    function extractCountFromNode(node) {
      if (!node?.textContent) return null;
      const match = node.textContent.match(/([\d.,]+\s*[KM]?)\s+Posts?$|([\d.,]+\s*[KM]?)\s+Tweets?$/i);
      const source = match?.[1] || match?.[2] || null;
      if (!source) return null;
      const normalized = source.replace(/\s+/g, '').toUpperCase();
      if (normalized.endsWith('K')) return Math.round(parseFloat(normalized) * 1000);
      if (normalized.endsWith('M')) return Math.round(parseFloat(normalized) * 1000000);
      return parseInt(normalized.replace(/[,.]/g, ''), 10);
    }

    const candidates = [
      '[data-testid="primaryColumn"] section',
      '[data-testid="UserProfileHeader_Items"]',
      '[data-testid="primaryColumn"]',
      '[data-testid="TopNavBar"]',
    ];

    for (const selector of candidates) {
      const root = document.querySelector(selector);
      const count = extractCountFromNode(root);
      if (Number.isFinite(count)) return count;
    }

    return 0;
  }

  async function runApiDeletion(ids, worker) {
    for (let index = 0; index < ids.length; index += 1) {
      if (worker.signal.aborted) return { aborted: true };

      const id = ids[index];
      const result = await worker.execute(id, (seconds) => {
        worker.onStatus(`Rate limited — retrying in ${seconds}s (${worker.progress.completed}/${worker.progress.total})`);
      });

      if (!result.ok) {
        worker.onStatus(`Stopped on ${id}. Reason: ${result.status}`);
        return { aborted: false, failed: true, failedId: id, result };
      }

      worker.progress.completed += 1;
      worker.onProgress(id);
      worker.onSave(ids.slice(index + 1));
    }

    return { aborted: false, failed: false };
  }

  async function removeBookmarksFromPage(worker) {
    if (!/\/i\/bookmarks/.test(location.pathname)) {
      location.assign('https://x.com/i/bookmarks');
      return { redirected: true };
    }

    await waitForElement('main').catch(() => null);
    let removed = 0;
    let idleRounds = 0;

    while (!worker.signal.aborted) {
      const articles = Array.from(document.querySelectorAll(selectors.bookmarkCell));
      const button = articles
        .map((article) => article.querySelector(selectors.bookmarkButton))
        .find(Boolean);

      if (!button) {
        window.scrollBy(0, window.innerHeight * 0.8);
        idleRounds += 1;
        if (idleRounds > 8) break;
        await sleep(900);
        continue;
      }

      idleRounds = 0;
      const article = button.closest('article') || button.closest('[data-testid="cellInnerDiv"]') || button.parentElement;
      article?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(randomInt(...APP.domActionDelayMs));
      button.click();
      removed += 1;
      worker.progress.completed = removed;
      worker.onProgress(`bookmark-${removed}`);
      article?.remove?.();
      await sleep(randomInt(...APP.domActionDelayMs));
    }

    return { removed };
  }

  async function unfollowEveryone(worker) {
    await ensureProfileContext();
    const followingLink = document.querySelector(selectors.followingsLink);
    if (!followingLink) throw new Error('Open your profile first so XEraser can reach the following list.');

    followingLink.click();
    await sleep(1400);

    let count = 0;
    let idleRounds = 0;

    while (!worker.signal.aborted) {
      const cells = Array.from(document.querySelectorAll(selectors.userCell));
      const button = cells
        .map((cell) => cell.querySelector(selectors.unfollowButton))
        .find(Boolean);

      if (!button) {
        window.scrollBy(0, window.innerHeight * 0.9);
        idleRounds += 1;
        if (idleRounds > 8) break;
        await sleep(1000);
        continue;
      }

      idleRounds = 0;
      const cell = button.closest(selectors.userCell) || button.parentElement;
      cell?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(randomInt(...APP.domActionDelayMs));
      button.click();
      const confirm = await waitForElement(selectors.confirmation).catch(() => null);
      if (!confirm) break;
      confirm.click();
      count += 1;
      worker.progress.completed = count;
      worker.onProgress(`unfollow-${count}`);
      cell?.remove?.();
      await sleep(randomInt(...APP.domActionDelayMs));
    }

    return { count };
  }

  async function slowDeleteFromUI(worker) {
    const tabs = document.querySelectorAll(selectors.scrollSnapTabs);
    if (tabs[1]) {
      tabs[1].click();
      await sleep(1400);
    }

    let deleted = 0;
    let errors = 0;

    while (!worker.signal.aborted) {
      const caret = document.querySelector(selectors.tweetCaret);
      if (!caret) break;

      caret.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(1000);

      try {
        const existingUnretweet = document.querySelector('[data-testid="unretweet"]');
        if (existingUnretweet) {
          existingUnretweet.click();
          const confirm = await waitForElement('[data-testid="unretweetConfirm"]');
          confirm.click();
        } else {
          caret.click();
          const menuItems = Array.from(document.querySelectorAll(selectors.menuItem));
          const deleteItem = menuItems.find((item) => /delete/i.test(item.textContent || ''));
          if (!deleteItem) throw new Error('Delete menu item not found');
          deleteItem.click();
          const confirm = await waitForElement(selectors.confirmation);
          confirm.click();
        }

        deleted += 1;
        errors = 0;
        worker.progress.completed = deleted;
        worker.onProgress(`ui-delete-${deleted}`);
        await sleep(1200);
      } catch {
        errors += 1;
        if (errors >= 5) break;
        await sleep(900);
      }
    }

    return { deleted };
  }

  function buildOperations({ xClient, ui }) {
    return {
      tweets: {
        id: 'tweets',
        label: 'Tweets',
        hint: 'Needs export file',
        needsFile: true,
        supportsDateRange: true,
        supportsKeepLatest: true,
        async run(context) {
          const fromDate = context.values.fromDate;
          const toDate = context.values.toDate;
          const keepLatest = clampKeepLatest(context.values.keepLatest);
          const plan = prepareTweetDeletionPlan(context.parsedFile.entries, { fromDate, toDate, keepLatest });

          context.progress.total = plan.idsToDelete.length;
          context.onStatus(
            `Deleting ${plan.deleteCount} tweets${keepLatest ? `, keeping newest ${plan.keepCount}` : ''}`
          );

          saveSession({
            version: 2,
            action: 'tweets',
            remainingIds: plan.idsToDelete,
            completed: 0,
            total: plan.idsToDelete.length,
          });

          return runApiDeletion(plan.idsToDelete, {
            signal: context.signal,
            progress: context.progress,
            execute: (id, notifyWaiting) => xClient.deleteTweet(id, notifyWaiting),
            onProgress: (id) => {
              context.onProgress(id);
            },
            onStatus: context.onStatus,
            onSave: (remainingIds) => {
              saveSession({
                version: 2,
                action: 'tweets',
                remainingIds,
                completed: context.progress.completed,
                total: context.progress.total,
              });
            },
          });
        },
      },

      likes: {
        id: 'likes',
        label: 'Likes',
        hint: 'Needs export file',
        needsFile: true,
        supportsDateRange: true,
        supportsKeepLatest: false,
        async run(context) {
          const entries = filterEntriesByDate(context.parsedFile.entries, context.values.fromDate, context.values.toDate)
            .sort((a, b) => (a.date?.getTime() || 0) - (b.date?.getTime() || 0));
          const ids = entries.map((entry) => entry.id);
          context.progress.total = ids.length;
          context.onStatus(`Deleting ${ids.length} likes`);

          saveSession({ version: 2, action: 'likes', remainingIds: ids, completed: 0, total: ids.length });

          return runApiDeletion(ids, {
            signal: context.signal,
            progress: context.progress,
            execute: (id, notifyWaiting) => xClient.unfavorite(id, notifyWaiting),
            onProgress: (id) => context.onProgress(id),
            onStatus: context.onStatus,
            onSave: (remainingIds) => {
              saveSession({
                version: 2,
                action: 'likes',
                remainingIds,
                completed: context.progress.completed,
                total: context.progress.total,
              });
            },
          });
        },
      },

      conversations: {
        id: 'conversations',
        label: 'DMs',
        hint: 'Needs export file',
        needsFile: true,
        supportsDateRange: false,
        supportsKeepLatest: false,
        async run(context) {
          const ids = context.parsedFile.entries.map((entry) => entry.id);
          context.progress.total = ids.length;
          context.onStatus(`Deleting ${ids.length} conversations`);

          saveSession({ version: 2, action: 'conversations', remainingIds: ids, completed: 0, total: ids.length });

          return runApiDeletion(ids, {
            signal: context.signal,
            progress: context.progress,
            execute: (id, notifyWaiting) => xClient.deleteConversation(id, notifyWaiting),
            onProgress: (id) => context.onProgress(id),
            onStatus: context.onStatus,
            onSave: (remainingIds) => {
              saveSession({
                version: 2,
                action: 'conversations',
                remainingIds,
                completed: context.progress.completed,
                total: context.progress.total,
              });
            },
          });
        },
      },

      bookmarks: {
        id: 'bookmarks',
        label: 'Bookmarks',
        hint: 'Runs from bookmarks page',
        needsFile: false,
        supportsDateRange: false,
        supportsKeepLatest: false,
        async run(context) {
          context.progress.total = Infinity;
          context.onStatus('Removing bookmarks from the bookmarks page');
          return removeBookmarksFromPage({
            signal: context.signal,
            progress: context.progress,
            onProgress: () => context.onProgress('bookmark'),
            onStatus: context.onStatus,
          });
        },
      },

      unfollow: {
        id: 'unfollow',
        label: 'Unfollow all',
        hint: 'Runs from your profile',
        needsFile: false,
        supportsDateRange: false,
        supportsKeepLatest: false,
        async run(context) {
          context.progress.total = Infinity;
          context.onStatus('Unfollowing from your logged-in browser session');
          return unfollowEveryone({
            signal: context.signal,
            progress: context.progress,
            onProgress: () => context.onProgress('unfollow'),
            onStatus: context.onStatus,
          });
        },
      },

      'slow-delete': {
        id: 'slow-delete',
        label: 'Slow delete',
        hint: 'UI-only fallback',
        needsFile: false,
        supportsDateRange: false,
        supportsKeepLatest: false,
        async run(context) {
          context.progress.total = Infinity;
          context.onStatus('Using slow UI deletion fallback');
          return slowDeleteFromUI({
            signal: context.signal,
            progress: context.progress,
            onProgress: () => context.onProgress('slow-delete'),
            onStatus: context.onStatus,
          });
        },
      },
    };
  }

  async function main() {
    injectStyles();
    const panel = createPanel();
    const baseUrl = `https://${window.location.hostname}`;
    const xClient = createXClient(baseUrl);

    const elements = {
      operations: panel.querySelector('#xe-operations'),
      fileWrap: panel.querySelector('#xe-file-wrap'),
      fileInput: panel.querySelector('#xe-file-input'),
      dateWrap: panel.querySelector('#xe-date-wrap'),
      dateFrom: panel.querySelector('#xe-date-from'),
      dateTo: panel.querySelector('#xe-date-to'),
      keepWrap: panel.querySelector('#xe-keep-wrap'),
      keepInput: panel.querySelector('#xe-keep-input'),
      start: panel.querySelector('#xe-start'),
      stop: panel.querySelector('#xe-stop'),
      progress: panel.querySelector('#xe-progress'),
      fill: panel.querySelector('#xe-fill'),
      status: panel.querySelector('#xe-status'),
      resumeBanner: panel.querySelector('#xe-resume-banner'),
      resumeText: panel.querySelector('#xe-resume-text'),
      resumeBtn: panel.querySelector('#xe-resume-btn'),
      resumeClear: panel.querySelector('#xe-resume-clear'),
    };

    const ui = {
      setStatus(text) {
        elements.progress.style.display = '';
        elements.status.textContent = text;
      },
      setProgress(completed, total) {
        if (!Number.isFinite(total) || total <= 0) {
          elements.fill.style.width = '8%';
          return;
        }
        const percent = clamp((completed / total) * 100, 0, 100);
        elements.fill.style.width = `${percent}%`;
      },
    };

    const operations = buildOperations({ xClient, ui });
    const operationList = Object.values(operations);

    const state = {
      selectedAction: null,
      parsedFile: null,
      abortController: null,
      profileCount: 0,
    };

    function renderOperations() {
      elements.operations.innerHTML = operationList
        .map(
          (operation) => `
            <button class="xe-card ${state.selectedAction === operation.id ? 'active' : ''}" data-action="${operation.id}">
              <span class="label">${operation.label}</span>
              <span class="hint">${operation.hint}</span>
            </button>
          `
        )
        .join('');
    }

    function getSelectedOperation() {
      return state.selectedAction ? operations[state.selectedAction] : null;
    }

    function updateVisibility() {
      const operation = getSelectedOperation();
      elements.fileWrap.style.display = operation?.needsFile ? '' : 'none';
      elements.dateWrap.style.display = operation?.supportsDateRange ? '' : 'none';
      elements.keepWrap.style.display = operation?.supportsKeepLatest ? '' : 'none';
    }

    function updateReadiness() {
      const operation = getSelectedOperation();
      if (!operation) {
        elements.start.disabled = true;
        return;
      }
      if (operation.needsFile && !state.parsedFile) {
        elements.start.disabled = true;
        return;
      }
      elements.start.disabled = false;
    }

    function resetFileDependentState() {
      state.parsedFile = null;
      elements.fileInput.value = '';
      elements.dateFrom.value = '';
      elements.dateTo.value = '';
    }

    function selectOperation(actionId) {
      state.selectedAction = actionId;
      resetFileDependentState();
      renderOperations();
      updateVisibility();
      updateReadiness();
    }

    async function resumeSavedSession() {
      const session = loadSession();
      if (!session?.action || !Array.isArray(session.remainingIds) || session.remainingIds.length === 0) {
        elements.resumeBanner.style.display = 'none';
        return;
      }

      const operation = operations[session.action];
      if (!operation || !['tweets', 'likes', 'conversations'].includes(session.action)) {
        clearSession();
        elements.resumeBanner.style.display = 'none';
        return;
      }

      state.abortController = new AbortController();
      elements.start.disabled = true;
      elements.stop.style.display = '';
      ui.setStatus(`Resuming ${session.action} — ${session.completed || 0}/${session.total || session.remainingIds.length}`);

      const progress = {
        completed: session.completed || 0,
        total: session.total || session.remainingIds.length,
      };

      const map = {
        tweets: (id, notifyWaiting) => xClient.deleteTweet(id, notifyWaiting),
        likes: (id, notifyWaiting) => xClient.unfavorite(id, notifyWaiting),
        conversations: (id, notifyWaiting) => xClient.deleteConversation(id, notifyWaiting),
      };

      const outcome = await runApiDeletion(session.remainingIds, {
        signal: state.abortController.signal,
        progress,
        execute: map[session.action],
        onProgress: (id) => {
          ui.setProgress(progress.completed, progress.total);
          ui.setStatus(`${progress.completed}/${progress.total} — ${id}`);
        },
        onStatus: (text) => ui.setStatus(text),
        onSave: (remainingIds) => {
          saveSession({
            version: 2,
            action: session.action,
            remainingIds,
            completed: progress.completed,
            total: progress.total,
          });
        },
      });

      if (!outcome.aborted && !outcome.failed) {
        clearSession();
        ui.setProgress(progress.total, progress.total);
        ui.setStatus('Done.');
      }

      if (state.abortController.signal.aborted) {
        ui.setStatus('Stopped. Resume is available from the banner.');
      }

      elements.stop.style.display = 'none';
      elements.start.disabled = false;
      state.abortController = null;
      elements.resumeBanner.style.display = 'none';
    }

    renderOperations();

    elements.operations.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      selectOperation(button.dataset.action);
    });

    elements.fileInput.addEventListener('change', () => {
      const file = elements.fileInput.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = () => {
        try {
          state.parsedFile = parseExportFile(String(reader.result || ''));
          state.selectedAction = state.parsedFile.action;
          renderOperations();
          updateVisibility();
          updateReadiness();

          const datedEntries = state.parsedFile.entries.filter((entry) => entry.date instanceof Date && !Number.isNaN(entry.date.getTime()));
          if (datedEntries.length > 0) {
            const sorted = [...datedEntries].sort((a, b) => a.date - b.date);
            ui.setStatus(
              `Loaded ${state.parsedFile.entries.length} ${state.parsedFile.action} (${formatDate(sorted[0].date)} → ${formatDate(sorted[sorted.length - 1].date)})`
            );
          } else {
            ui.setStatus(`Loaded ${state.parsedFile.entries.length} ${state.parsedFile.action}`);
          }
        } catch (error) {
          state.parsedFile = null;
          updateReadiness();
          ui.setStatus(error.message || String(error));
        }
      };
      reader.readAsText(file);
    });

    elements.stop.addEventListener('click', () => {
      state.abortController?.abort();
    });

    elements.resumeBtn.addEventListener('click', () => {
      elements.resumeBanner.style.display = 'none';
      resumeSavedSession().catch((error) => ui.setStatus(`Resume failed: ${error.message || error}`));
    });

    elements.resumeClear.addEventListener('click', () => {
      clearSession();
      elements.resumeBanner.style.display = 'none';
    });

    elements.start.addEventListener('click', async () => {
      const operation = getSelectedOperation();
      if (!operation) return;

      state.abortController = new AbortController();
      elements.start.disabled = true;
      elements.stop.style.display = '';
      elements.progress.style.display = '';
      elements.fill.style.width = '0%';

      const context = {
        parsedFile: state.parsedFile,
        signal: state.abortController.signal,
        progress: { completed: 0, total: 0 },
        values: {
          fromDate: elements.dateFrom.value ? new Date(`${elements.dateFrom.value}T00:00:00`) : null,
          toDate: elements.dateTo.value ? new Date(`${elements.dateTo.value}T23:59:59`) : null,
          keepLatest: elements.keepInput.value,
        },
        onStatus: (text) => ui.setStatus(text),
        onProgress: (id) => {
          ui.setProgress(context.progress.completed, context.progress.total);
          const totalText = Number.isFinite(context.progress.total)
            ? `${context.progress.completed}/${context.progress.total}`
            : `${context.progress.completed}`;
          ui.setStatus(`${totalText} — ${id}`);
        },
      };

      try {
        const outcome = await operation.run(context);
        if (outcome?.redirected) {
          ui.setStatus('Redirecting to bookmarks. Start again once the page loads.');
        } else if (state.abortController.signal.aborted) {
          ui.setStatus('Stopped. Resume is available for API-based actions.');
        } else if (!outcome?.failed) {
          if (Number.isFinite(context.progress.total) && context.progress.total > 0) {
            ui.setProgress(context.progress.total, context.progress.total);
          }
          clearSession();
          ui.setStatus('Done.');
        }
      } catch (error) {
        ui.setStatus(`Error: ${error.message || error}`);
      } finally {
        elements.stop.style.display = 'none';
        elements.start.disabled = false;
        state.abortController = null;
      }
    });

    state.profileCount = await getProfileTweetCount().catch(() => 0);
    ui.setStatus(
      state.profileCount > 0
        ? `${state.profileCount.toLocaleString()} tweets/posts detected. Select an action.`
        : 'Select an action.'
    );

    const saved = loadSession();
    if (saved?.action && Array.isArray(saved.remainingIds) && saved.remainingIds.length > 0) {
      elements.resumeText.textContent = `Previous ${saved.action} run: ${saved.completed || 0} complete, ${saved.remainingIds.length} remaining.`;
      elements.resumeBanner.style.display = 'flex';
    }
  }

  main().catch((error) => {
    console.error('[XEraser]', error);
  });
})();
