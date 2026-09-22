/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';

/**
 * escapeHtml(str)
 *
 * Strict HTML entity escaping to prevent DOM-based XSS when interpolating
 * untrusted page titles, URLs, and labels into innerHTML.
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * safeUrl(url)
 *
 * Validates URLs using standard URL parsing to ensure only safe protocols
 * (http, https, file, chrome, chrome-extension) are permitted in href.
 */
function safeUrl(url) {
  if (!url) return '#';
  const trimmed = String(url).trim();
  try {
    const parsed = new URL(trimmed);
    if (['http:', 'https:', 'file:', 'chrome:', 'chrome-extension:'].includes(parsed.protocol)) {
      return escapeHtml(trimmed);
    }
    return '#';
  } catch {
    return '#';
  }
}

/**
 * getFaviconUrl(url)
 *
 * Uses Chrome's native MV3 favicon API (_favicon) when available to prevent
 * leaking browsing history to external services and to support offline caching.
 */
function getFaviconUrl(url) {
  if (!url) return '';
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=16`);
    }
  } catch {}
  return '';
}

// Clean image error fallback compliant with MV3 CSP (no inline onerror)
document.addEventListener('error', (e) => {
  if (e.target && e.target.classList && e.target.classList.contains('chip-favicon')) {
    e.target.style.display = 'none';
  }
}, true);


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

// Track user-expanded domain chip sections across dashboard syncs
const expandedDomains = new Set();

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}


/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in the current window so focus stays local
  const match = matches.find(t => t.windowId === currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  try {
    const allTabs = await chrome.tabs.query({});
    const toClose = [];

    for (const url of urls) {
      const matching = allTabs.filter(t => t.url === url);
      if (keepOne) {
        const keep = matching.find(t => t.active) || matching[0];
        for (const tab of matching) {
          if (tab.id !== keep.id) toClose.push(tab.id);
        }
      } else {
        for (const tab of matching) toClose.push(tab.id);
      }
    }

    if (toClose.length > 0) await chrome.tabs.remove(toClose);
  } catch (err) {
    console.warn('[tab-out] Failed to close duplicate tabs:', err);
  }
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  try {
    const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
    if (toClose.length > 0) await chrome.tabs.remove(toClose);
  } catch (err) {
    console.warn('[tab-out] Failed to close extra Tab Out tabs:', err);
  }
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

// Serialized mutation queue to prevent concurrent read-modify-write race conditions
let storageQueue = Promise.resolve();

// In-flight animated deferred item IDs to prevent storage.onChanged from clobbering UI transitions
const animatingDeferredIds = new Set();

function mutateDeferred(mutator) {
  const resultPromise = storageQueue.then(async () => {
    const res = await chrome.storage.local.get('deferred');
    const rawDeferred = res && Array.isArray(res.deferred) ? res.deferred : [];
    const updated = await mutator([...rawDeferred]);
    const cleanList = Array.isArray(updated) ? updated : rawDeferred;
    await chrome.storage.local.set({ deferred: cleanList });
    return cleanList;
  }).catch(err => {
    console.error('[tab-out] Storage mutation error:', err);
    throw err;
  });
  storageQueue = resultPromise.catch(() => {});
  return resultPromise;
}

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * Uses atomic Promise serialization to prevent race conditions.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const id = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString() + '-' + Math.random().toString(36).slice(2);
  await mutateDeferred(deferred => {
    deferred.push({
      id,
      url:       tab.url,
      title:     tab.title,
      savedAt:   new Date().toISOString(),
      completed: false,
    });
    return deferred;
  });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const res = await chrome.storage.local.get('deferred');
  const visible = res && Array.isArray(res.deferred) ? res.deferred : [];
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  await mutateDeferred(deferred => {
    const tab = deferred.find(t => String(t.id) === String(id));
    if (tab) {
      tab.completed = true;
      tab.completedAt = new Date().toISOString();
    }
    return deferred;
  });
}

/**
 * dismissSavedTab(id)
 *
 * Removes a saved tab permanently from chrome.storage.local.
 */
async function dismissSavedTab(id) {
  await mutateDeferred(deferred => {
    return deferred.filter(t => String(t.id) !== String(id));
  });
}

/**
 * unarchiveSavedTab(id)
 *
 * Restores an archived tab back to active checklist (completed = false).
 */
async function unarchiveSavedTab(id) {
  await mutateDeferred(deferred => {
    const tab = deferred.find(t => String(t.id) === String(id));
    if (tab) {
      tab.completed = false;
      delete tab.completedAt;
    }
    return deferred;
  });
}

/**
 * deleteSavedTab(id)
 *
 * Permanently removes an archived tab from chrome.storage.local.
 */
async function deleteSavedTab(id) {
  await mutateDeferred(deferred => {
    return deferred.filter(t => String(t.id) !== String(id));
  });
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card with a subtle opacity fade.
 * Adheres strictly to the stillness principle of Vercel Brand Guidelines.
 */
function animateCardOut(card) {
  if (!card || card.classList.contains('closing')) return;

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 200);
}

let toastTimeout = null;

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  const textEl = document.getElementById('toastText');
  if (textEl) textEl.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * syncCardState(card)
 *
 * Reconciles the visual badge, close buttons, duplicate indicators, and in-memory
 * domainGroups for a domain card when tabs are incrementally removed or deferred.
 */
function syncCardState(card) {
  if (!card) return;
  const chips = card.querySelectorAll('.page-chip:not(.removing)');
  const domain = card.dataset.domain;

  if (chips.length === 0) {
    animateCardOut(card);
    if (domain) {
      domainGroups = domainGroups.filter(g => g.domain !== domain);
    }
    return;
  }

  // Count remaining tabs across all chips in this card
  let remainingCount = 0;
  let remainingDupes = 0;
  chips.forEach(c => {
    const cnt = parseInt(c.dataset.tabCount || '1', 10);
    remainingCount += cnt;
    if (cnt > 1) remainingDupes += (cnt - 1);
  });

  // Update in-memory group tab count
  const grp = domainGroups.find(g => g.domain === domain);
  if (grp) {
    // Keep only tabs whose URLs still exist in the remaining chips
    const remainingUrls = new Set(Array.from(chips).map(c => c.dataset.tabUrl));
    grp.tabs = grp.tabs.filter(t => remainingUrls.has(t.url));
  }

  // Update open-tabs count badge on card
  const countBadge = card.querySelector('.open-tabs-badge:not(.dupe-badge)');
  if (countBadge) {
    countBadge.textContent = `${remainingCount} tab${remainingCount !== 1 ? 's' : ''}`;
  }

  // Update duplicate count badge on card
  const dupeCountBadge = card.querySelector('.open-tabs-badge.dupe-badge');
  if (remainingDupes > 0) {
    if (dupeCountBadge) {
      dupeCountBadge.textContent = `${remainingDupes} dupe${remainingDupes !== 1 ? 's' : ''}`;
    }
    card.classList.add('has-amber-bar');
  } else {
    if (dupeCountBadge) dupeCountBadge.remove();
    card.classList.remove('has-amber-bar');
  }

  // Update close-domain-tabs button
  const closeBtn = card.querySelector('.action-btn.close-tabs');
  if (closeBtn) {
    if (remainingCount > 1) {
      closeBtn.innerHTML = `${ICONS.close} Close ${remainingCount} tabs`;
    } else {
      closeBtn.remove();
    }
  }

  // Update dedup button
  const dedupBtn = card.querySelector('.action-btn[data-action="dedup-keep-one"]:not(.removing)');
  if (dedupBtn) {
    if (remainingDupes > 0) {
      dedupBtn.textContent = `Close ${remainingDupes} duplicate${remainingDupes !== 1 ? 's' : ''}`;
    } else {
      dedupBtn.remove();
    }
  }
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-title">All tabs closed</div>
      <div class="empty-subtitle">Clean workspace</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';

  const headerActionsEl = document.getElementById('openTabsHeaderActions');
  if (headerActionsEl) headerActionsEl.innerHTML = '';
}

/**
 * updateHeaderAndStats()
 *
 * Keeps header counts, hero subtitle, section domain counts, and header actions
 * synchronized across all incremental tab actions without requiring a full re-render.
 */
function updateHeaderAndStats() {
  const realTabs = getRealTabs();
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = realTabs.length;

  const heroSub = document.getElementById('heroSubtitle');
  if (heroSub) {
    const windowIds = new Set(realTabs.map(t => t.windowId));
    const winCount = windowIds.size || 1;
    heroSub.textContent = `${realTabs.length} tab${realTabs.length !== 1 ? 's' : ''} across ${winCount} window${winCount !== 1 ? 's' : ''}`;
  }

  const missionsEl = document.getElementById('openTabsMissions');
  const countEl = document.getElementById('openTabsSectionCount');
  if (missionsEl && countEl) {
    const visibleCards = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
    countEl.textContent = `${visibleCards} domain${visibleCards !== 1 ? 's' : ''}`;
  }

  const headerActionsEl = document.getElementById('openTabsHeaderActions');
  if (headerActionsEl) {
    if (realTabs.length > 1) {
      headerActionsEl.innerHTML = `<button class="action-btn close-tabs close-all-btn" data-action="close-all-open-tabs">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    } else {
      headerActionsEl.innerHTML = '';
    }
  }

  if (realTabs.length === 0) {
    checkAndShowEmptyState();
  }
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  if (isNaN(then.getTime())) return '';
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}


/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[-\u2010-\u2015]\s*[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} / ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  close: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}, isExpanded = false, domain = '') {
  const hiddenChips = hiddenTabs.map(tab => {
    const rawLabel  = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), domain);
    let portPrefix  = '';
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) {
        portPrefix = `<code class="chip-port vbg-mono">${escapeHtml(parsed.port)}</code>`;
      }
    } catch {}
    const count     = urlCounts[tab.url] || 1;
    const dupeTag   = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const validUrl  = safeUrl(tab.url);
    const safeTitle = escapeHtml(rawLabel);
    const faviconUrl = getFaviconUrl(tab.url);
    return `<div class="page-chip" data-tab-count="${count}" data-tab-url="${validUrl}">
      <button type="button" class="chip-title-btn" data-action="focus-tab" data-tab-url="${validUrl}" title="${safeTitle}" aria-label="${safeTitle}">
        ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="">` : ''}
        <span class="chip-text">${portPrefix}${escapeHtml(rawLabel)}</span>${dupeTag}
      </button>
      <div class="chip-actions">
        <button type="button" class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${validUrl}" data-tab-title="${safeTitle}" title="Save for later" aria-label="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button type="button" class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${validUrl}" title="Close this tab" aria-label="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  if (isExpanded) {
    return `<div class="page-chips-overflow" style="display:contents">${hiddenChips}</div>`;
  }

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <button type="button" class="page-chip-overflow" data-action="expand-chips" aria-label="Show ${hiddenTabs.length} more tabs">
      +${hiddenTabs.length} more
    </button>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML string for one domain card.
 * Handles tab count badges, duplicate badges, page chips,
 * and card action buttons.
 */
function renderDomainCard(group) {
  const tabs       = group.tabs;
  const isLanding  = group.domain === '__landing-pages__';
  const tabCount   = tabs.length;
  const isExpanded = expandedDomains.has(group.domain);

  // Count occurrences of each URL to detect exact duplicates
  const urlCounts = {};
  for (const tab of tabs) {
    urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  }

  // Find all duplicates (URLs appearing more than once)
  const dupeUrls = Object.entries(urlCounts).filter(([, count]) => count > 1);
  const hasDupes = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((sum, [, count]) => sum + (count - 1), 0);

  // Badges: quiet tabular text label
  const tabBadge = tabCount > 0
    ? `<span class="open-tabs-badge">${tabCount} tab${tabCount !== 1 ? 's' : ''} open</span>`
    : '';

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge dupe-badge">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let rawLabel = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    let portPrefix = '';
    // For localhost tabs, prepend port number with monospace styling so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) {
        portPrefix = `<code class="chip-port vbg-mono">${escapeHtml(parsed.port)}</code>`;
      }
    } catch {}
    const count     = urlCounts[tab.url] || 1;
    const dupeTag   = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const validUrl  = safeUrl(tab.url);
    const safeTitle = escapeHtml(rawLabel);
    const faviconUrl = getFaviconUrl(tab.url);
    return `<div class="page-chip" data-tab-count="${count}" data-tab-url="${validUrl}">
      <button type="button" class="chip-title-btn" data-action="focus-tab" data-tab-url="${validUrl}" title="${safeTitle}" aria-label="${safeTitle}">
        ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="">` : ''}
        <span class="chip-text">${portPrefix}${escapeHtml(rawLabel)}</span>${dupeTag}
      </button>
      <div class="chip-actions">
        <button type="button" class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${validUrl}" data-tab-title="${safeTitle}" title="Save for later" aria-label="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button type="button" class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${validUrl}" title="Close this tab" aria-label="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts, isExpanded, group.domain) : '');

  let actionsHtml = '';
  if (tabCount > 1) {
    actionsHtml += `
      <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain="${escapeHtml(group.domain)}">
        ${ICONS.close}
        Close ${tabCount} tabs
      </button>`;
  }

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  const groupHeading = isLanding ? 'Homepages' : escapeHtml(group.label || friendlyDomain(group.domain));

  return `
    <div class="mission-card ${hasDupes ? 'has-amber-bar' : ''}" data-domain="${escapeHtml(group.domain)}">
      <div class="mission-content">
        <div class="mission-top">
          <h3 class="mission-name">${groupHeading}</h3>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        ${actionsHtml ? `<div class="actions">${actionsHtml}</div>` : ''}
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      const searchInput = document.getElementById('archiveSearch');
      const q = searchInput ? searchInput.value.trim().toLowerCase() : '';
      if (q.length >= 2) {
        const results = archived.filter(item =>
          (item.title || '').toLowerCase().includes(q) ||
          (item.url   || '').toLowerCase().includes(q)
        );
        archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
          || '<div class="archive-no-results">No results</div>';
      } else {
        archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      }
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    if (empty) empty.style.display = 'block';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = getFaviconUrl(item.url);
  const ago = timeAgo(item.savedAt);
  const displayTitle = escapeHtml(item.title || item.url || '');
  const validUrl = safeUrl(item.url);

  return `
    <div class="deferred-item" data-deferred-id="${escapeHtml(item.id)}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${escapeHtml(item.id)}" aria-label="Mark completed">
      <div class="deferred-info">
        <a href="${validUrl}" target="_blank" rel="noopener" class="deferred-title" title="${displayTitle}">
          ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="">` : ''}<span>${displayTitle}</span>
        </a>
        <div class="deferred-meta">
          <span>${escapeHtml(domain)}</span>
          <span>${escapeHtml(ago)}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${escapeHtml(item.id)}" title="Dismiss" aria-label="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item with domain favicon,
 * title link, time ago, restore button, and delete button.
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = getFaviconUrl(item.url);
  const displayTitle = escapeHtml(item.title || item.url || '');
  const validUrl = safeUrl(item.url);

  return `
    <div class="archive-item" data-archive-id="${escapeHtml(item.id)}">
      <div class="archive-item-main">
        <a href="${validUrl}" target="_blank" rel="noopener" class="archive-item-title" title="${displayTitle}">
          ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="">` : ''}
          <span class="archive-item-text">${displayTitle}</span>
        </a>
        <span class="archive-item-date">${escapeHtml(domain ? domain + ' · ' + ago : ago)}</span>
      </div>
      <div class="archive-item-actions">
        <button type="button" class="archive-action-btn unarchive" data-action="unarchive-saved-tab" data-archive-id="${escapeHtml(item.id)}" title="Restore to Saved for later" aria-label="Restore to Saved for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" /></svg>
        </button>
        <button type="button" class="archive-action-btn delete" data-action="delete-archived-tab" data-archive-id="${escapeHtml(item.id)}" title="Delete permanently" aria-label="Delete permanently">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
        </button>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = 'Active tabs';
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  const heroSub = document.getElementById('heroSubtitle');
  if (heroSub) {
    const windowIds = new Set(realTabs.map(t => t.windowId));
    const winCount = windowIds.size || 1;
    heroSub.textContent = `${realTabs.length} tab${realTabs.length !== 1 ? 's' : ''} across ${winCount} window${winCount !== 1 ? 's' : ''}`;
  }

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',            pathExact: ['/home'] },
    { hostname: 'twitter.com',      pathExact: ['/home'] },
    { hostname: 'linkedin.com',     pathExact: ['/'] },
    { hostname: 'github.com',       pathExact: ['/'] },
    { hostname: 'youtube.com',      pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      const cleanHost = parsed.hostname.replace(/^www\./, '');
      return LANDING_PAGE_PATTERNS.some(p => {
        const targetHost = (p.hostname || '').replace(/^www\./, '');
        const hostnameMatch = p.hostname
          ? cleanHost === targetHost
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (openTabsSection) {
    if (domainGroups.length > 0) {
      if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
      if (openTabsSectionCount) openTabsSectionCount.textContent = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''}`;
      const openTabsHeaderActions = document.getElementById('openTabsHeaderActions');
      if (openTabsHeaderActions) {
        if (realTabs.length > 1) {
          openTabsHeaderActions.innerHTML = `<button class="action-btn close-tabs close-all-btn" data-action="close-all-open-tabs">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
        } else {
          openTabsHeaderActions.innerHTML = '';
        }
      }
      if (openTabsMissionsEl) openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    } else {
      if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
      if (openTabsSectionCount) openTabsSectionCount.textContent = '0 domains';
      const openTabsHeaderActions = document.getElementById('openTabsHeaderActions');
      if (openTabsHeaderActions) openTabsHeaderActions.innerHTML = '';
      if (openTabsMissionsEl) {
        openTabsMissionsEl.innerHTML = `
          <div class="missions-empty-state">
            <div class="empty-title">All tabs closed</div>
            <div class="empty-subtitle">Clean workspace</div>
          </div>
        `;
      }
    }
    openTabsSection.style.display = 'block';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = realTabs.length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action or #archiveToggle
  const actionEl = e.target.closest('[data-action], #archiveToggle');
  if (!actionEl) return;

  const action = actionEl.dataset.action || (actionEl.id === 'archiveToggle' ? 'toggle-archive' : '');

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.classList.add('removing');
      setTimeout(() => {
        banner.style.display = 'none';
        banner.classList.remove('removing');
      }, 200);
    }
    showToast('Closed extra Tab Out tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const card = actionEl.closest('.mission-card');
    const domain = card?.dataset.domain;
    if (domain) expandedDomains.add(domain);
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.classList.add('expanded');
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close one tab matching this URL in Chrome (preferring current window)
    let removedId = null;
    try {
      const allTabs = await chrome.tabs.query({});
      const currentWindow = await chrome.windows.getCurrent();
      const match = allTabs.find(t => t.url === tabUrl && t.windowId === currentWindow.id)
                 || allTabs.find(t => t.url === tabUrl);
      if (match) {
        removedId = match.id;
        await chrome.tabs.remove(match.id);
      }
    } catch (err) {
      console.warn('[tab-out] Failed to close tab:', err);
    }
    await fetchOpenTabs();

    // Reconcile in-memory domainGroups
    if (removedId) {
      for (const g of domainGroups) {
        g.tabs = g.tabs.filter(t => t.id !== removedId);
      }
      domainGroups = domainGroups.filter(g => g.tabs.length > 0);
    }

    const chip = actionEl.closest('.page-chip');
    const parentCard = chip ? chip.closest('.mission-card') : null;
    const currentCount = parseInt(chip?.dataset.tabCount || '1', 10);

    if (chip && currentCount > 1) {
      const newCount = currentCount - 1;
      chip.dataset.tabCount = String(newCount);
      const dupeBadge = chip.querySelector('.chip-dupe-badge');
      if (dupeBadge) {
        if (newCount > 1) {
          dupeBadge.textContent = ` (${newCount}x)`;
        } else {
          dupeBadge.remove();
        }
      }
      if (parentCard) syncCardState(parentCard);
      updateHeaderAndStats();
    } else if (chip) {
      chip.classList.add('removing');
      setTimeout(() => {
        chip.remove();
        if (parentCard) syncCardState(parentCard);
        updateHeaderAndStats();
      }, 160);
    } else {
      updateHeaderAndStats();
    }

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close one tab matching this URL in Chrome (preferring current window)
    let removedId = null;
    try {
      const allTabs = await chrome.tabs.query({});
      const currentWindow = await chrome.windows.getCurrent();
      const match = allTabs.find(t => t.url === tabUrl && t.windowId === currentWindow.id)
                 || allTabs.find(t => t.url === tabUrl);
      if (match) {
        removedId = match.id;
        await chrome.tabs.remove(match.id);
      }
    } catch (err) {
      console.warn('[tab-out] Failed to close deferred tab:', err);
    }
    await fetchOpenTabs();

    // Reconcile in-memory domainGroups
    if (removedId) {
      for (const g of domainGroups) {
        g.tabs = g.tabs.filter(t => t.id !== removedId);
      }
      domainGroups = domainGroups.filter(g => g.tabs.length > 0);
    }

    const chip = actionEl.closest('.page-chip');
    const parentCard = chip ? chip.closest('.mission-card') : null;
    const currentCount = parseInt(chip?.dataset.tabCount || '1', 10);

    if (chip && currentCount > 1) {
      const newCount = currentCount - 1;
      chip.dataset.tabCount = String(newCount);
      const dupeBadge = chip.querySelector('.chip-dupe-badge');
      if (dupeBadge) {
        if (newCount > 1) {
          dupeBadge.textContent = ` (${newCount}x)`;
        } else {
          dupeBadge.remove();
        }
      }
      if (parentCard) syncCardState(parentCard);
      updateHeaderAndStats();
    } else if (chip) {
      chip.classList.add('removing');
      setTimeout(() => {
        chip.remove();
        if (parentCard) syncCardState(parentCard);
        updateHeaderAndStats();
      }, 160);
    } else {
      updateHeaderAndStats();
    }

    showToast('Saved for later');
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id || animatingDeferredIds.has(id)) return;

    const item = actionEl.closest('.deferred-item');
    if (item && (item.classList.contains('checked') || item.classList.contains('removing'))) {
      return;
    }

    // Persist to storage immediately to prevent state loss on fast tab closure
    animatingDeferredIds.add(id);
    const savePromise = checkOffSavedTab(id);

    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(async () => {
          item.remove();
          try {
            await savePromise;
          } catch (err) {
            console.error('Failed to save deferred tab:', err);
          } finally {
            animatingDeferredIds.delete(id);
            if (animatingDeferredIds.size === 0) {
              renderDeferredColumn();
            }
          }
        }, 160);
      }, 120);
    } else {
      try {
        await savePromise;
      } catch (err) {
        console.error('Failed to save deferred tab:', err);
      } finally {
        animatingDeferredIds.delete(id);
        if (animatingDeferredIds.size === 0) {
          renderDeferredColumn();
        }
      }
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id || animatingDeferredIds.has(id)) return;

    const item = actionEl.closest('.deferred-item');
    if (item && (item.classList.contains('checked') || item.classList.contains('removing'))) {
      return;
    }

    // Persist to storage immediately to prevent state loss on fast tab closure
    animatingDeferredIds.add(id);
    const dismissPromise = dismissSavedTab(id);

    if (item) {
      item.classList.add('removing');
      setTimeout(async () => {
        item.remove();
        try {
          await dismissPromise;
        } catch (err) {
          console.error('Failed to dismiss deferred tab:', err);
        } finally {
          animatingDeferredIds.delete(id);
          if (animatingDeferredIds.size === 0) {
            renderDeferredColumn();
          }
        }
      }, 160);
    } else {
      try {
        await dismissPromise;
      } catch (err) {
        console.error('Failed to dismiss deferred tab:', err);
      } finally {
        animatingDeferredIds.delete(id);
        if (animatingDeferredIds.size === 0) {
          renderDeferredColumn();
        }
      }
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domain = actionEl.dataset.domain;
    const group  = domainGroups.find(g => g.domain === domain);
    if (!group) return;

    // Filter against currently active tabs in Chrome to avoid rejecting on closed IDs
    let validTabIds = [];
    try {
      const currentTabs = await chrome.tabs.query({});
      const liveIds = new Set(currentTabs.map(t => t.id));
      validTabIds = group.tabs.map(t => t.id).filter(id => liveIds.has(id));
      if (validTabIds.length > 0) {
        await chrome.tabs.remove(validTabIds);
      }
    } catch (err) {
      console.warn('[tab-out] Failed to close domain tabs:', err);
    }
    await fetchOpenTabs();

    if (card) {
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${validTabIds.length} tab${validTabIds.length !== 1 ? 's' : ''} from ${groupLabel}`);

    updateHeaderAndStats();
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    try {
      await closeDuplicateTabs(urls, true);
    } catch (err) {
      console.warn('[tab-out] Failed to close duplicates:', err);
    }

    // Reconcile in-memory domainGroups with live openTabs
    try {
      const liveTabs = await chrome.tabs.query({});
      const liveIds = new Set(liveTabs.map(t => t.id));
      for (const g of domainGroups) {
        g.tabs = g.tabs.filter(t => liveIds.has(t.id));
      }
      domainGroups = domainGroups.filter(g => g.tabs.length > 0);
    } catch {}

    // Hide the dedup button
    actionEl.classList.add('removing');
    setTimeout(() => actionEl.remove(), 160);

    // Remove dupe badges and reset chip counts to 1
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => b.remove());
      card.querySelectorAll('.open-tabs-badge.dupe-badge').forEach(b => b.remove());
      card.classList.remove('has-amber-bar');
      card.querySelectorAll('.page-chip').forEach(c => {
        c.dataset.tabCount = '1';
      });
      syncCardState(card);
    }

    updateHeaderAndStats();
    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Close ALL open tabs (with confirmation step) ----
  if (action === 'close-all-open-tabs') {
    if (!actionEl.classList.contains('confirming')) {
      actionEl.classList.add('confirming');
      const originalText = actionEl.innerHTML;
      actionEl.innerHTML = `${ICONS.close} Confirm closing all tabs?`;
      const timeoutId = setTimeout(() => {
        if (actionEl.isConnected) {
          actionEl.classList.remove('confirming');
          actionEl.innerHTML = originalText;
        }
      }, 4000);
      actionEl.dataset.confirmTimeout = String(timeoutId);
      return;
    }

    clearTimeout(parseInt(actionEl.dataset.confirmTimeout || '0', 10));
    actionEl.classList.remove('confirming');

    const realTabs = getRealTabs();
    const tabIds = realTabs.map(t => t.id).filter(Boolean);
    try {
      if (tabIds.length > 0) await chrome.tabs.remove(tabIds);
    } catch (err) {
      console.warn('[tab-out] Failed to close all tabs:', err);
    }
    await fetchOpenTabs();
    domainGroups = [];

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      animateCardOut(c);
    });

    setTimeout(() => {
      updateHeaderAndStats();
    }, 200);
    showToast('All tabs closed. Fresh start.');
    return;
  }

  // ---- Unarchive (restore saved tab to active checklist) ----
  if (action === 'unarchive-saved-tab') {
    e.stopPropagation();
    const id = actionEl.dataset.archiveId;
    if (!id) return;

    await unarchiveSavedTab(id);
    showToast('Restored to Saved for later');
    return;
  }

  // ---- Delete archived tab permanently ----
  if (action === 'delete-archived-tab') {
    e.stopPropagation();
    const id = actionEl.dataset.archiveId;
    if (!id) return;

    await deleteSavedTab(id);
    showToast('Deleted from archive');
    return;
  }

  // ---- Archive toggle — expand/collapse the archive section ----
  if (action === 'toggle-archive' || actionEl.id === 'archiveToggle' || actionEl.closest('#archiveToggle')) {
    const toggle = document.getElementById('archiveToggle');
    if (toggle) {
      toggle.classList.toggle('open');
      const isOpen = toggle.classList.contains('open');
      toggle.setAttribute('aria-expanded', String(isOpen));
      const body = document.getElementById('archiveBody');
      if (body) {
        body.classList.toggle('collapsed', !isOpen);
      }
    }
    return;
  }
});

// ---- Archive search — debounced filter for archived items ----
let searchTimeout = null;
document.addEventListener('input', (e) => {
  if (e.target.id !== 'archiveSearch') return;
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async () => {
    const q = e.target.value.trim().toLowerCase();
    const archiveList = document.getElementById('archiveList');
    if (!archiveList) return;

    try {
      const { archived } = await getSavedTabs();

      if (q.length < 2) {
        archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
        return;
      }

      const results = archived.filter(item =>
        (item.title || '').toLowerCase().includes(q) ||
        (item.url  || '').toLowerCase().includes(q)
      );

      archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
        || '<div class="archive-no-results">No results</div>';
    } catch (err) {
      console.warn('[tab-out] Archive search failed:', err);
    }
  }, 150);
});

// Keep dashboard synchronized with external tab events, visibility changes & window focus
if (typeof chrome !== 'undefined' && chrome.tabs) {
  let syncTimeout = null;
  let isSyncing = false;
  let pendingSync = false;
  let pendingFullSync = false;

  const performSync = async (fullSync = false) => {
    // Re-check document visibility at execution time: skip background render if tab is hidden
    if (document.hidden && !fullSync) {
      return;
    }

    if (isSyncing) {
      pendingSync = true;
      if (fullSync) pendingFullSync = true;
      return;
    }
    isSyncing = true;
    try {
      await renderStaticDashboard();
      if ((fullSync || pendingFullSync) && animatingDeferredIds.size === 0) {
        pendingFullSync = false;
        await renderDeferredColumn();
      }
    } catch (err) {
      console.warn('[tab-out] Sync failed:', err);
    } finally {
      isSyncing = false;
      if (pendingSync) {
        pendingSync = false;
        const nextFull = pendingFullSync;
        pendingFullSync = false;
        performSync(nextFull);
      }
    }
  };

  // Coalesce rapid events (e.g. visibilitychange + focus) into a single execution
  const debouncedSync = (delay = 250, fullSync = false) => {
    clearTimeout(syncTimeout);
    if (fullSync) pendingFullSync = true;
    syncTimeout = setTimeout(() => {
      const isFull = pendingFullSync;
      pendingFullSync = false;
      performSync(isFull);
    }, delay);
  };

  chrome.tabs.onCreated?.addListener(() => debouncedSync(250, false));
  chrome.tabs.onRemoved?.addListener(() => debouncedSync(250, false));
  chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete' || changeInfo.url || changeInfo.title) {
      debouncedSync(250, false);
    }
  });
  chrome.tabs.onAttached?.addListener(() => debouncedSync(250, false));
  chrome.tabs.onDetached?.addListener(() => debouncedSync(250, false));

  // Coalesce tab visibility and window focus into a single short 50ms window
  window.addEventListener('focus', () => debouncedSync(50, true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      debouncedSync(50, true);
    }
  });

  // Export for initialization locking
  window.__tabOutPerformSync = performSync;
}

// Cross-tab sync for "Saved for later"
if (typeof chrome !== 'undefined' && chrome.storage) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.deferred) {
      if (animatingDeferredIds.size > 0) return;
      renderDeferredColumn();
    }
  });
}

/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
async function initDashboard() {
  if (typeof window !== 'undefined' && typeof window.__tabOutPerformSync === 'function') {
    await window.__tabOutPerformSync(true);
  } else {
    await renderStaticDashboard();
    await renderDeferredColumn();
  }
}
initDashboard();
