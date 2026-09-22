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
if (typeof document !== 'undefined') {
  document.addEventListener('error', (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('chip-favicon')) {
      e.target.style.display = 'none';
    }
  }, true);
}


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
const undoStack = [];

/**
 * showToast(message, options)
 *
 * Brief pop-up notification at the bottom of the screen with optional Undo button.
 */
function showToast(message, { onUndo = null, duration = 2500 } = {}) {
  if (typeof document === 'undefined') return;
  const toast = document.getElementById('toast');
  if (!toast) return;
  const textEl = document.getElementById('toastText');
  const undoBtn = document.getElementById('toastUndoBtn');

  if (textEl) textEl.textContent = message;

  clearTimeout(toastTimeout);

  if (onUndo && undoBtn) {
    undoBtn.style.display = 'inline-flex';
    duration = 6000;
  } else if (undoBtn) {
    undoBtn.style.display = 'none';
  }

  toast.classList.add('visible');
  toastTimeout = setTimeout(() => {
    toast.classList.remove('visible');
  }, duration);
}

/**
 * pushUndoAction({ description, onUndo })
 *
 * Pushes a restorable action to the undo stack and triggers an interactive toast.
 */
function pushUndoAction({ description, onUndo }) {
  if (typeof onUndo !== 'function') return;
  undoStack.push({ description, onUndo, timestamp: Date.now() });
  if (undoStack.length > 20) {
    undoStack.shift();
  }
  showToast(description, { onUndo });
}

/**
 * triggerUndo()
 *
 * Executes the topmost action on the undo stack.
 */
async function triggerUndo() {
  if (undoStack.length === 0) return false;
  const action = undoStack.pop();
  if (typeof document !== 'undefined') {
    const toast = document.getElementById('toast');
    if (toast) toast.classList.remove('visible');
  }
  if (action && typeof action.onUndo === 'function') {
    try {
      await action.onUndo();
      return true;
    } catch (err) {
      console.warn('[tab-out] Failed to execute undo:', err);
    }
  }
  return false;
}

/**
 * showConfirmDialog({ title, description, confirmText, cancelText, danger })
 *
 * Renders a Vercel-style confirmation modal dialog for destructive operations.
 * Returns a Promise<boolean> that resolves to true if confirmed, false if cancelled.
 */
function showConfirmDialog({
  title = 'Xác nhận',
  description = '',
  confirmText = 'Xác nhận',
  cancelText = 'Hủy',
  danger = true
} = {}) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(true);
      return;
    }
    const overlay = document.getElementById('confirmModalOverlay');
    if (!overlay) {
      resolve(typeof window !== 'undefined' && window.confirm ? window.confirm(`${title}\n\n${description}`) : true);
      return;
    }

    const previousActive = document.activeElement;
    const titleEl = document.getElementById('confirmModalTitle');
    const descEl = document.getElementById('confirmModalDesc');
    const okBtn = document.getElementById('confirmModalOkBtn');
    const cancelBtn = document.getElementById('confirmModalCancelBtn');
    const closeBtn = overlay.querySelector('.perspective-modal-close');

    if (titleEl) titleEl.textContent = title;
    if (descEl) descEl.textContent = description;
    if (okBtn) {
      okBtn.textContent = confirmText;
      if (danger) {
        okBtn.className = 'btn-primary btn-danger';
      } else {
        okBtn.className = 'btn-primary';
      }
    }
    if (cancelBtn) cancelBtn.textContent = cancelText;

    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      overlay.style.display = 'none';
      okBtn?.removeEventListener('click', onOk);
      cancelBtn?.removeEventListener('click', onCancel);
      closeBtn?.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKeyDown, true);
      if (previousActive && typeof previousActive.focus === 'function') {
        try { previousActive.focus(); } catch {}
      }
    };

    const onOk = (e) => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      cleanup();
      resolve(true);
    };

    const onCancel = (e) => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      cleanup();
      resolve(false);
    };

    const onBackdrop = (e) => {
      if (e.target === overlay) {
        onCancel(e);
      }
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel(e);
        return;
      }
      if (e.key === 'Tab') {
        const focusable = [cancelBtn, okBtn, closeBtn].filter(Boolean);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    okBtn?.addEventListener('click', onOk);
    cancelBtn?.addEventListener('click', onCancel);
    closeBtn?.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKeyDown, true);

    overlay.style.display = 'flex';
    // Focus Cancel button to prevent accidental Enter submit
    setTimeout(() => {
      cancelBtn?.focus();
    }, 50);
  });
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
    const isDomain = activePerspectiveId === 'domain';
    const unitLabel = isDomain
      ? (visibleCards !== 1 ? 'domains' : 'domain')
      : (visibleCards !== 1 ? 'categories' : 'category');
    countEl.textContent = `${visibleCards} ${unitLabel}`;
  }

  const headerActionsEl = document.getElementById('openTabsHeaderActions');
  if (headerActionsEl) {
    let actionsHtml = '';
    if (activePerspectiveId !== 'domain') {
      actionsHtml += `<button type="button" class="perspective-edit-header-btn" data-action="edit-perspective" data-perspective-id="${escapeHtml(activePerspectiveId)}" title="Chỉnh sửa tags của perspective này">${PERSPECTIVE_ICONS.edit}<span>Chỉnh sửa tags</span></button>`;
    }
    if (realTabs.length > 1) {
      actionsHtml += `<button class="action-btn close-tabs close-all-btn" data-action="close-all-open-tabs">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    }
    headerActionsEl.innerHTML = actionsHtml;
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
   PERSPECTIVES & CLASSIFICATION ENGINE
   ---------------------------------------------------------------- */
const PERSPECTIVE_ICONS = {
  globe: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" /></svg>`,
  tag: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.568 3H5.25A2.25 2.25 0 0 0 3 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 0 0 5.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 0 0 9.568 3Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M6 6h.008v.008H6V6Z" /></svg>`,
  target: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" /></svg>`,
  folder: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" /></svg>`,
  edit: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" /></svg>`
};

/* Helper functions for perspective label structures */
function getLabelName(l) {
  if (!l) return '';
  return typeof l === 'string' ? l : (l.name || '');
}

function getLabelDesc(l) {
  if (!l || typeof l === 'string') return '';
  return l.description || '';
}

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) return [];
  return labels.map(l => {
    if (typeof l === 'string') {
      return {
        name: l,
        description: `Các trang web và nội dung liên quan đến ${l}`
      };
    }
    return {
      name: l.name || '',
      description: l.description || (l.name ? `Các trang web và nội dung liên quan đến ${l.name}` : '')
    };
  }).filter(l => l.name.trim().length > 0);
}

function buildChoiceCriteria(perspective) {
  const criteria = {};
  if (!perspective || !Array.isArray(perspective.labels)) return criteria;
  let hasOther = false;
  for (const item of perspective.labels) {
    const name = getLabelName(item);
    if (!name) continue;
    const low = name.toLowerCase();
    if (/\b(khác|other)\b/i.test(low)) hasOther = true;
    const desc = getLabelDesc(item);
    if (item && typeof item === 'object' && item.rubric && typeof item.rubric === 'object') {
      criteria[name] = item.rubric;
    } else {
      criteria[name] = desc || `Classify tabs and pages related to ${name}`;
    }
  }
  if (!hasOther) {
    criteria['Khác'] = 'Tabs or web pages that do not fit into any other category above';
  }
  if (Object.keys(criteria).length < 2) {
    criteria['Chung'] = 'General tabs or web pages that do not fit the specific criteria';
  }
  return criteria;
}

function createTagRowElement(name = '', description = '') {
  if (typeof document === 'undefined') return null;
  const row = document.createElement('div');
  row.className = 'tag-row';
  row.innerHTML = `
    <div class="tag-row-inputs">
      <input type="text" class="form-input tag-field-name" placeholder="Tên tag (vd: Công việc)" value="${escapeHtml(name)}" aria-label="Tên tag" autocomplete="off">
      <input type="text" class="form-input tag-field-desc" placeholder="Mô tả / Hướng dẫn AI (để trống sẽ dùng mặc định)" value="${escapeHtml(description)}" aria-label="Mô tả hoặc hướng dẫn AI cho tag này" autocomplete="off">
    </div>
    <button type="button" class="tag-row-del-btn" data-action="remove-tag-row" aria-label="Xóa tag" title="Xóa tag">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
      </svg>
    </button>
  `;
  return row;
}

function addTagRowToModal(name = '', description = '', focus = false) {
  if (typeof document === 'undefined') return null;
  const container = document.getElementById('perspectiveTagsContainer');
  if (!container) return null;
  const row = createTagRowElement(name, description);
  if (!row) return null;
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
  if (focus) {
    const input = row.querySelector('.tag-field-name');
    if (input) setTimeout(() => input.focus(), 50);
  }
  return row;
}

const DEFAULT_PERSPECTIVES = [
  {
    id: 'domain',
    name: 'Domain',
    icon: 'globe',
    isSystem: true,
    labels: []
  },
  {
    id: 'topic',
    name: 'Chủ đề',
    icon: 'tag',
    isSystem: false,
    labels: [
      { name: 'AI & Machine Learning', description: 'Công cụ trí tuệ nhân tạo, mô hình ngôn ngữ lớn LLM, ChatGPT, Claude, Hugging Face, prompt engineering' },
      { name: 'Lập trình / Dev', description: 'Kho mã nguồn GitHub, GitLab, tài liệu API, lập trình web, backend, frontend, debug, pull requests' },
      { name: 'Mạng xã hội', description: 'Mạng xã hội, chia sẻ bài viết, tin nhắn, Facebook, Twitter/X, LinkedIn, Reddit, Discord' },
      { name: 'Giải trí / Media', description: 'Xem video YouTube, phim ảnh, âm nhạc Spotify, Twitch, streaming giải trí' },
      { name: 'Tin tức & Đọc báo', description: 'Báo chí, bài viết công nghệ, tin tức thời sự, newsletter, blog kiến thức' },
      { name: 'Mua sắm', description: 'Thương mại điện tử, mua sắm online, đặt hàng, giỏ hàng, Shopee, Amazon' },
      { name: 'Công việc / Email', description: 'Email, hòm thư Gmail, lịch họp, quản lý công việc Jira, Linear, Notion, Docs' },
      { name: 'Khác / Chưa phân loại', description: 'Các trang web và tab không thuộc các chủ đề trên' }
    ]
  },
  {
    id: 'purpose',
    name: 'Mục đích',
    icon: 'target',
    isSystem: false,
    labels: [
      { name: 'Công việc', description: 'Các tab phục vụ trực tiếp cho công việc, dự án và nhiệm vụ chuyên môn' },
      { name: 'Nghiên cứu', description: 'Tài liệu học tập, nghiên cứu khoa học, đọc hiểu sâu' },
      { name: 'Giải trí', description: 'Thư giãn, nghe nhạc, xem phim, lướt web giải trí' },
      { name: 'Cá nhân', description: 'Việc cá nhân, quản lý đời sống, tài chính, mua sắm' },
      { name: 'Tạm thời', description: 'Tra cứu nhanh một lần rồi đóng, không cần lưu trữ' },
      { name: 'Khác / Chưa phân loại', description: 'Chưa xác định mục đích cụ thể' }
    ]
  }
];

const CATEGORY_RULES = [
  {
    category: 'ai',
    domains: ['aistudio.google.com', 'chatgpt.com', 'claude.ai', 'anthropic.com', 'openai.com', 'huggingface.co', 'grok.com', 'x.ai', 'kimi.moonshot.cn', 'deepseek.com', 'perplexity.ai', 'replicate.com'],
    keywords: ['ai', 'artificial intelligence', 'machine learning', 'deep learning', 'gemini', 'chatgpt', 'claude', 'anthropic', 'openai', 'llm', 'prompt', 'grok', 'kimi', 'deepseek', 'copilot']
  },
  {
    category: 'dev',
    domains: ['github.com', 'gist.github.com', 'gitlab.com', 'stackoverflow.com', 'npm.im', 'npmjs.com', 'crates.io', 'developer.mozilla.org', 'w3schools.com'],
    keywords: ['github', 'gitlab', 'gist', 'code', 'commit', 'pull request', 'react', 'vue', 'angular', 'bun', 'node', 'typescript', 'javascript', 'python', 'rust', 'golang', 'docker', 'api', 'dev', 'sdk', 'bug', 'fix', 'refactor', 'repo', 'lập trình']
  },
  {
    category: 'social',
    domains: ['x.com', 'twitter.com', 'facebook.com', 'fb.com', 'instagram.com', 'threads.net', 'linkedin.com', 'reddit.com', 'tiktok.com', 'discord.com', 'telegram.org'],
    keywords: ['social', 'mạng xã hội', 'twitter', 'tweet', 'facebook', 'instagram', 'linkedin', 'reddit', 'post', 'status', 'followers']
  },
  {
    category: 'media',
    domains: ['youtube.com', 'youtu.be', 'netflix.com', 'spotify.com', 'twitch.tv', 'bilibili.com', 'soundcloud.com'],
    keywords: ['video', 'watch', 'music', 'sound', 'stream', 'movie', 'show', 'podcast', 'giải trí', 'ca nhạc', 'phim']
  },
  {
    category: 'news',
    domains: ['news.ycombinator.com', 'medium.com', 'dev.to', 'substack.com', 'vnexpress.net', 'tuoitre.vn', 'bbc.com', 'cnn.com', 'nytimes.com'],
    keywords: ['news', 'article', 'tin tức', 'báo', 'bản tin', 'thời sự', 'editorial', 'newsletter']
  },
  {
    category: 'shopping',
    domains: ['shopee.vn', 'shopee.com', 'lazada.vn', 'amazon.com', 'ebay.com', 'tiki.vn', 'aliexpress.com'],
    keywords: ['shopping', 'mua sắm', 'cart', 'checkout', 'price', 'giá', 'order', 'deal', 'store']
  },
  {
    category: 'work',
    domains: ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'slack.com', 'jira.atlassian.com', 'linear.app', 'notion.so', 'docs.google.com', 'sheets.google.com', 'meet.google.com', 'zoom.us'],
    keywords: ['mail', 'email', 'inbox', 'meeting', 'calendar', 'công việc', 'task', 'project', 'work']
  },
  {
    category: 'research',
    domains: ['wikipedia.org', 'arxiv.org', 'scholar.google.com'],
    keywords: ['docs', 'documentation', 'guide', 'tutorial', 'wiki', 'paper', 'research', 'nghiên cứu', 'tài liệu']
  }
];

let currentPerspectives = [...DEFAULT_PERSPECTIVES];
let activePerspectiveId = 'domain';
let isLocalSettingUpdate = false;
const getLocalKey = () => (typeof window !== 'undefined' && window.LOCAL_OPENROUTER_KEY) || '';
let openRouterApiKey = getLocalKey();
let tabClassificationCache = {};
let isPerspectivesLoaded = false;

async function loadPerspectiveSettings(force = false) {
  if (isPerspectivesLoaded && !force) return;
  try {
    const res = await chrome.storage.local.get(['perspectives', 'activePerspectiveId', 'openRouterApiKey', 'classifierApiKey', 'tabClassificationCache']);
    if (res.perspectives && Array.isArray(res.perspectives) && res.perspectives.length > 0) {
      currentPerspectives = res.perspectives.map(p => ({
        ...p,
        labels: normalizeLabels(p.labels)
      }));
    }
    if (res.activePerspectiveId) {
      activePerspectiveId = res.activePerspectiveId;
    }
    if (res.openRouterApiKey !== undefined) {
      openRouterApiKey = res.openRouterApiKey || '';
    } else if (res.classifierApiKey !== undefined) {
      openRouterApiKey = res.classifierApiKey || '';
    } else {
      openRouterApiKey = getLocalKey();
    }
    if (res.tabClassificationCache && typeof res.tabClassificationCache === 'object') {
      tabClassificationCache = { ...res.tabClassificationCache };
    }
    // Also load any partitioned perspective caches
    if (currentPerspectives && Array.isArray(currentPerspectives)) {
      const partKeys = currentPerspectives.map(p => `tabClassificationCache_${p.id}`);
      const partRes = await chrome.storage.local.get(partKeys);
      for (const p of currentPerspectives) {
        const pKey = `tabClassificationCache_${p.id}`;
        if (partRes[pKey] && typeof partRes[pKey] === 'object') {
          tabClassificationCache[p.id] = { ...partRes[pKey] };
        }
      }
    }
    isPerspectivesLoaded = true;

    // Update telemetry dot in sidebar rail
    if (typeof document !== 'undefined') {
      const dot = document.querySelector('.telemetry-dot');
      const aiLabel = document.querySelector('.telemetry-label');
      if (dot) {
        dot.className = 'telemetry-dot ready';
        if (aiLabel) {
          aiLabel.textContent = openRouterApiKey ? 'OpenRouter (Jev)' : 'Smart Local';
        }
      }
    }
  } catch (err) {
    console.warn('[tab-out] Failed to load perspective settings:', err);
  }
}

const SYNONYM_MAP = {
  'khẩn cấp': ['urgent', 'emergency', 'critical', 'asap', 'prod', 'alert', 'leak', 'hotfix', 'gấp'],
  'gấp': ['urgent', 'emergency', 'critical', 'asap', 'prod', 'alert', 'leak', 'hotfix', 'khẩn cấp'],
  'đọc sau': ['read later', 'pocket', 'bookmark', 'reading', 'saved', 'archive'],
  'quan trọng': ['important', 'priority', 'high', 'key', 'main'],
  'tham khảo': ['reference', 'ref', 'docs', 'manual', 'cheatsheet'],
};

const SHORT_KW_REGEX = new Map();
if (typeof CATEGORY_RULES !== 'undefined') {
  for (const rule of CATEGORY_RULES) {
    for (const k of rule.keywords) {
      if (k.length <= 2 && !SHORT_KW_REGEX.has(k)) {
        SHORT_KW_REGEX.set(k, new RegExp(`(^|[^a-z0-9])${k}([^a-z0-9]|$)`, 'i'));
      }
    }
  }
}

function localFallbackClassify(tab, labels) {
  if (!labels || labels.length === 0) return 'Khác';

  const labelObjects = labels.map(l => {
    if (typeof l === 'string') return { name: l, description: '' };
    return { name: l.name || '', description: l.description || '' };
  }).filter(l => l.name.trim().length > 0);

  if (labelObjects.length === 0) return 'Khác';

  const title = (tab.title || '').toLowerCase();
  const urlStr = (tab.url || '').toLowerCase();
  const hostname = extractHostname(tab.url);

  const fullText = `${title} ${urlStr}`;

  // Score categories based on domain and keyword rules
  const categoryWeights = {};
  for (const rule of CATEGORY_RULES) {
    if (rule.domains.some(d => hostname === d || hostname.endsWith('.' + d))) {
      categoryWeights[rule.category] = (categoryWeights[rule.category] || 0) + 30;
    }
    if (rule.keywords.some(k => {
      if (k.length <= 2) {
        const regex = SHORT_KW_REGEX.get(k) || new RegExp(`(^|[^a-z0-9])${k}([^a-z0-9]|$)`, 'i');
        return regex.test(fullText);
      }
      return fullText.includes(k);
    })) {
      categoryWeights[rule.category] = (categoryWeights[rule.category] || 0) + 10;
    }
  }

  let bestLabel = null;
  let highestScore = -1;

  for (const labelObj of labelObjects) {
    const label = labelObj.name;
    const lLower = label.toLowerCase();
    const descLower = (labelObj.description || '').toLowerCase();
    let score = 0;

    // Direct match against category rules
    for (const [cat, weight] of Object.entries(categoryWeights)) {
      const catRule = CATEGORY_RULES.find(r => r.category === cat);
      if (catRule) {
        if (lLower.includes(cat) || catRule.keywords.some(kw => lLower.includes(kw))) {
          score += weight;
        }
      }
    }

    // Direct match against synonyms
    for (const [key, syns] of Object.entries(SYNONYM_MAP)) {
      if (lLower.includes(key) || key.includes(lLower)) {
        if (syns.some(s => fullText.includes(s))) {
          score += 20;
        }
      }
    }

    // Direct label name tokens
    const labelTokens = lLower.split(/[\s/,&+-]+/).filter(Boolean);
    for (const token of labelTokens) {
      if (token.length > 1 && fullText.includes(token)) {
        score += 3;
      }
    }

    // Custom user description tokens (boost matching based on user instructions for AI)
    if (descLower) {
      const descTokens = descLower.split(/[\s/,&+.,;:()_-]+/).filter(t => t.length > 2);
      for (const token of descTokens) {
        if (fullText.includes(token) || (hostname && hostname.includes(token))) {
          score += 4;
        }
      }
    }

    if (score > highestScore && score > 0) {
      highestScore = score;
      bestLabel = label;
    }
  }

  if (!bestLabel) {
    const fallback = labelObjects.find(l => l.name.toLowerCase().includes('khác') || l.name.toLowerCase().includes('other'));
    return fallback ? fallback.name : (labelObjects[labelObjects.length - 1]?.name || 'Khác');
  }

  return bestLabel;
}

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'msclkid', 'mc_eid', '_ga',
  'ref', 'source', 'feature', 'si', 't',
  'oq', 'aqs', 'sourceid', 'ved', 'ei'
]);

const normalizedUrlCache = new Map();

/**
 * normalizeUrlForCache(url)
 *
 * Normalizes a URL for stable classification cache keys by stripping
 * non-semantic tracking query parameters and hash anchors.
 */
function normalizeUrlForCache(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (normalizedUrlCache.has(trimmed)) {
    return normalizedUrlCache.get(trimmed);
  }
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';

    // Strip trailing slash from pathname (unless it is just root '/')
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    const searchParams = parsed.searchParams;
    let modified = false;
    for (const key of Array.from(searchParams.keys())) {
      const lowerKey = key.toLowerCase();
      if (TRACKING_PARAMS.has(lowerKey) || lowerKey.startsWith('utm_')) {
        searchParams.delete(key);
        modified = true;
      }
    }
    searchParams.sort();
    const newSearch = searchParams.toString();
    parsed.search = newSearch ? `?${newSearch}` : '';
    const res = parsed.toString();
    if (normalizedUrlCache.size > 2000) {
      const it = normalizedUrlCache.keys();
      for (let i = 0; i < 200; i++) {
        const nextKey = it.next().value;
        if (nextKey) normalizedUrlCache.delete(nextKey);
      }
    }
    normalizedUrlCache.set(trimmed, res);
    return res;
  } catch {
    return trimmed;
  }
}

/**
 * pruneClassificationCache(cache, maxEntries)
 *
 * True LRU bounds: sorts by entry timestamp descending (newest first) before keeping maxEntries.
 */
function pruneClassificationCache(cache, maxEntries = 1000) {
  if (!cache || typeof cache !== 'object') return {};
  const entries = Object.entries(cache);
  if (entries.length <= maxEntries) return cache;
  const hasTimestamps = entries.some(e => e[1] && typeof e[1] === 'object' && typeof e[1].timestamp === 'number');
  if (hasTimestamps) {
    entries.sort((a, b) => {
      const timeA = (a[1] && typeof a[1] === 'object' && a[1].timestamp) || 0;
      const timeB = (b[1] && typeof b[1] === 'object' && b[1].timestamp) || 0;
      return timeB - timeA;
    });
    return Object.fromEntries(entries.slice(0, maxEntries));
  }
  return Object.fromEntries(entries.slice(entries.length - maxEntries));
}

let storageWriteMutex = Promise.resolve();

function enqueueStorageWrite(fn) {
  const next = storageWriteMutex.then(fn, fn);
  storageWriteMutex = next;
  return next;
}

/**
 * saveClassificationCacheAtomic(pid, newEntries)
 *
 * Performs serialized atomic read-modify-write against chrome.storage.local to eliminate
 * last-write-wins clobbering races between parallel batches and the background service worker.
 */
async function saveClassificationCacheAtomic(pid, newEntries) {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  return enqueueStorageWrite(async () => {
    try {
      const partitionKey = `tabClassificationCache_${pid}`;
      const res = await chrome.storage.local.get([partitionKey, 'tabClassificationCache']);
      const monolithic = res.tabClassificationCache || {};
      let partitionCache = res[partitionKey];
      if (!partitionCache || typeof partitionCache !== 'object') {
        partitionCache = monolithic[pid] || {};
      }

      if (newEntries && typeof newEntries === 'object') {
        for (const [urlKey, entry] of Object.entries(newEntries)) {
          const existing = partitionCache[urlKey];
          // Protect existing 'ai' entries from being downgraded to 'local', 'domain-ai', or 'ai-low-confidence'
          if (existing && getCacheSource(existing) === 'ai' && getCacheSource(entry) !== 'ai') {
            continue;
          }
          // If both are 'ai' and existing has higher confidence, preserve higher confidence
          if (existing && getCacheSource(existing) === 'ai' && getCacheSource(entry) === 'ai' &&
              typeof existing?.confidence === 'number' && typeof entry?.confidence === 'number' &&
              entry.confidence < existing.confidence) {
            continue;
          }
          partitionCache[urlKey] = {
            ...(typeof existing === 'object' ? existing : {}),
            ...entry,
            hygieneScore: entry.hygieneScore !== undefined ? entry.hygieneScore : existing?.hygieneScore,
            secondaryLabel: entry.secondaryLabel !== undefined ? entry.secondaryLabel : existing?.secondaryLabel
          };
        }
      }
      partitionCache = pruneClassificationCache(partitionCache, 1000);

      // Keep RAM copy in sync using a fresh object clone to eliminate memory leaks
      tabClassificationCache[pid] = { ...partitionCache };

      // Keep monolithic mirror in sync for backwards compatibility
      monolithic[pid] = partitionCache;

      await chrome.storage.local.set({
        [partitionKey]: partitionCache,
        tabClassificationCache: monolithic
      });
    } catch (err) {
      console.warn('[tab-out] Failed to atomically save classification cache:', err);
    }
  });
}

/**
 * Multi-topic domains where different tabs belong to completely different categories.
 * Domain fallback must NEVER automatically inherit classifications across these domains.
 */
const MULTI_TOPIC_DOMAINS = new Set([
  'youtube.com', 'youtu.be', 'github.com', 'reddit.com', 'x.com', 'twitter.com',
  'medium.com', 'wikipedia.org', 'facebook.com', 'instagram.com', 'linkedin.com',
  'threads.net', 'tiktok.com', 'news.ycombinator.com', 'google.com', 'bing.com'
]);

/**
 * Fast hostname extractor avoiding new URL() allocations
 */
function extractHostname(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const start = url.indexOf('://');
    if (start === -1) return '';
    const withoutProto = url.slice(start + 3);
    const pathOrQueryIdx = withoutProto.search(/[\/?#]/);
    const authority = pathOrQueryIdx === -1 ? withoutProto : withoutProto.slice(0, pathOrQueryIdx);
    const atIdx = authority.lastIndexOf('@');
    const hostWithPort = atIdx === -1 ? authority : authority.slice(atIdx + 1);
    const colonIdx = hostWithPort.indexOf(':');
    const host = (colonIdx === -1 ? hostWithPort : hostWithPort.slice(0, colonIdx)).toLowerCase();
    return host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Helper to safely extract label from cache entry (supports legacy string and modern object)
 */
function getCacheLabel(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'object' && entry.label) return entry.label;
  return '';
}

/**
 * Helper to safely extract provenance source from cache entry
 */
function getCacheSource(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return 'ai'; // backwards compatibility with legacy string cache
  if (typeof entry === 'object' && entry.source) return entry.source;
  return 'local';
}

/**
 * getDomainFallbackLabel(tab, cache)
 *
 * Checks if another tab from the exact same domain already has an 'ai' classified label in cache.
 * Excludes multi-topic domains to prevent semantic cross-contamination.
 * Uses fast string hostname extraction instead of repeatedly allocating new URL().
 */
function getDomainFallbackLabel(tab, cache) {
  if (!tab || !tab.url || !cache) return null;
  const hostname = extractHostname(tab.url);
  if (!hostname || MULTI_TOPIC_DOMAINS.has(hostname)) return null;

  for (const [cachedUrl, entry] of Object.entries(cache)) {
    if (getCacheSource(entry) === 'ai') {
      const cachedHost = extractHostname(cachedUrl);
      if (cachedHost === hostname) {
        const label = getCacheLabel(entry);
        if (label) return label;
      }
    }
  }
  return null;
}

const inFlightUrls = new Set();

const HYGIENE_SCORE_CRITERIA = [
  'Persistent important active workspace, primary application, document being edited, or critical reference',
  'Secondary reference, documentation, article being read, or active task context',
  'Browsing, search results, social feed, or non-critical reading',
  'Temporary search query, disposable lookup, ad, redirect, promotional page, or duplicate tab safe to close'
];

/**
 * classifyTabs(tabs, perspective, forceAi)
 *
 * Fast classification engine for open tabs.
 * 1. Resolves known and local fallback categories immediately into memory.
 * 2. If OpenRouter API key is configured, batches uncached/heuristic tabs into unified
 *    multi-question OpenRouter decisions requests (~typesafe/jev-latest).
 */
let activeClassificationAbortController = null;

async function classifyTabs(tabs, perspective, forceAi = false, options = {}) {
  if (!perspective || !perspective.labels || perspective.labels.length === 0) {
    return {};
  }

  const silent = options && options.silent === true;
  const pid = perspective.id;
  if (!tabClassificationCache[pid]) {
    tabClassificationCache[pid] = {};
  }
  const cache = tabClassificationCache[pid];

  // 1. Identify which tabs genuinely need AI decision pass BEFORE mutating cache
  const toClassify = (forceAi
    ? tabs
    : tabs.filter(t => {
        const normUrl = normalizeUrlForCache(t.url) || t.url || '';
        if (!normUrl) return false;
        const entry = cache[normUrl];
        if (!entry) return true;
        if (getCacheSource(entry) === 'ai') return false;
        const isFailedRecently = entry.lastAiAttempt && (Date.now() - entry.lastAiAttempt < (entry.cooldownMs || 15000));
        return !isFailedRecently;
      })
  ).filter(t => {
    const normUrl = normalizeUrlForCache(t.url) || t.url || '';
    return normUrl && !inFlightUrls.has(`${pid}:${normUrl}`);
  });

  // 2. Ensure every tab has at least an instant local fallback in memory
  let hasNewLocalFallback = false;
  for (const tab of tabs) {
    const normUrl = normalizeUrlForCache(tab.url) || tab.url || '';
    if (normUrl && !cache[normUrl]) {
      const localLabel = localFallbackClassify(tab, perspective.labels);
      cache[normUrl] = { label: localLabel, source: 'local', timestamp: Date.now() };
      hasNewLocalFallback = true;
    }
  }

  // If no OpenRouter key is set or no tabs need AI, return cache immediately without unnecessary I/O
  if (!openRouterApiKey || toClassify.length === 0) {
    if (hasNewLocalFallback) {
      try {
        await saveClassificationCacheAtomic(pid, cache);
      } catch {}
    }
    return cache;
  }

  // Only abort previous active foreground request if this pass genuinely has tabs to classify
  let activeSignal = null;
  if (!silent && typeof AbortController !== 'undefined') {
    if (activeClassificationAbortController) {
      try { activeClassificationAbortController.abort(); } catch {}
    }
    activeClassificationAbortController = new AbortController();
    activeSignal = activeClassificationAbortController.signal;
  }

  // Mark pending URLs as in-flight so concurrent calls never double-fetch or drop
  const pendingKeys = [];
  for (const t of toClassify) {
    const normUrl = normalizeUrlForCache(t.url) || t.url || '';
    if (normUrl) {
      const key = `${pid}:${normUrl}`;
      inFlightUrls.add(key);
      pendingKeys.push(key);
    }
  }

  const loader = (!silent && typeof document !== 'undefined') ? document.getElementById('perspectiveLoader') : null;
  const dot = (!silent && typeof document !== 'undefined') ? document.querySelector('.telemetry-dot') : null;
  if (loader && activePerspectiveId === pid) loader.style.display = 'flex';
  if (dot && activePerspectiveId === pid) {
    dot.classList.add('busy');
    dot.classList.remove('ready');
  }

  try {
    // Deduplicate unique tab URLs
    const uniqueTabsMap = new Map();
    for (const t of toClassify) {
      const normUrl = normalizeUrlForCache(t.url) || t.url || '';
      if (normUrl && !uniqueTabsMap.has(normUrl)) {
        uniqueTabsMap.set(normUrl, t);
      }
    }
    const uniqueTabs = Array.from(uniqueTabsMap.values());

    // Build criteria options for OpenRouter typesafe decision choice
    const criteria = buildChoiceCriteria(perspective);

    // Prepare speculative fan-out criteria for inactive semantic perspectives
    // Covers up to 2 high-priority inactive perspectives in foreground without latency overhead
    const inactiveSemanticPerspectives = (options?.skipSpeculativeFanout)
      ? []
      : ((typeof currentPerspectives !== 'undefined' && Array.isArray(currentPerspectives))
          ? currentPerspectives.filter(p => p && p.id !== 'domain' && p.id !== pid && p.labels && p.labels.length > 0).slice(0, 2)
          : []);
    const inactiveCriteriaByPid = new Map();
    for (const otherP of inactiveSemanticPerspectives) {
      inactiveCriteriaByPid.set(otherP.id, buildChoiceCriteria(otherP));
    }

    // Batch tabs into groups of up to 12 tabs for lower latency and better focus
    const batchSize = 12;
    const batches = [];
    for (let i = 0; i < uniqueTabs.length; i += batchSize) {
      batches.push(uniqueTabs.slice(i, i + batchSize));
    }

    // Process batches with bounded concurrency (max 3 concurrent requests) to prevent 429 rate limits
    const maxConcurrency = 3;
    for (let b = 0; b < batches.length; b += maxConcurrency) {
      const chunk = batches.slice(b, b + maxConcurrency);
      await Promise.all(chunk.map(async (batch) => {
        const questions = {};
        const state = { tabs: {} };

        batch.forEach((tab, idx) => {
          const qKey = `tab_${idx}`;
          const cleanUrl = normalizeUrlForCache(tab.url) || tab.url || '';
          const cleanTitle = (tab.title || '').replace(/[\r\n]+/g, ' ').slice(0, 140);
          const domain = extractHostname(tab.url);
          state.tabs[qKey] = {
            title: cleanTitle,
            url: cleanUrl.slice(0, 300),
            domain
          };
          questions[qKey] = {
            type: 'choice',
            instructions: `Categorize \`tabs.${qKey}\` into the single most fitting category based on title, domain, and criteria.`,
            criteria
          };
          questions[`hygiene__${qKey}`] = {
            type: 'score',
            instructions: `Rate if \`tabs.${qKey}\` is disposable or transient: 0 for persistent important active workspace, up to 3 for temporary search/disposable lookup/duplicate tab safe to close.`,
            criteria: HYGIENE_SCORE_CRITERIA
          };

          // Speculative fan-out: also evaluate up to 1 inactive semantic perspective in parallel
          for (const otherP of inactiveSemanticPerspectives) {
            const otherCache = tabClassificationCache[otherP.id] || {};
            const otherEntry = otherCache[cleanUrl];
            if (!otherEntry || getCacheSource(otherEntry) !== 'ai') {
              const otherQKey = `${otherP.id}__${qKey}`;
              questions[otherQKey] = {
                type: 'choice',
                instructions: `Categorize \`tabs.${qKey}\` into the single most fitting category for "${otherP.name || otherP.id}" based on criteria.`,
                criteria: inactiveCriteriaByPid.get(otherP.id)
              };
            }
          }
        });

        let perRequestSignal;
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
          const timeoutSignal = AbortSignal.timeout(10000);
          perRequestSignal = (activeSignal && typeof AbortSignal.any === 'function')
            ? AbortSignal.any([timeoutSignal, activeSignal])
            : timeoutSignal;
        } else {
          perRequestSignal = activeSignal || undefined;
        }

        try {
          const response = await fetch('https://openrouter.ai/api/alpha/decisions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${openRouterApiKey}`,
              'HTTP-Referer': 'https://github.com/Gohans1/tab-out',
              'X-Title': 'Tab Out'
            },
            signal: perRequestSignal,
            body: JSON.stringify({
              model: '~typesafe/jev-latest',
              state,
              questions
            })
          });

          if (!response.ok) {
            let cooldownMs = 15000;
            const retryAfter = Number(response.headers?.get?.('retry-after'));
            if (!isNaN(retryAfter) && retryAfter > 0) {
              cooldownMs = Math.min(Math.max(retryAfter * 1000, 5000), 300000);
            } else if (response.status === 401 || response.status === 403 || response.status === 429 || response.status === 529) {
              cooldownMs = 60000;
            } else if (response.status === 400 || response.status === 402 || response.status === 422) {
              cooldownMs = 300000;
            }
            const httpErr = new Error(`OpenRouter decisions HTTP ${response.status}`);
            httpErr.cooldownMs = cooldownMs;
            throw httpErr;
          }

          const data = await response.json();
          const answers = data.answers || {};
          const otherPerspectiveUpdates = {};

          batch.forEach((tab, idx) => {
            const qKey = `tab_${idx}`;
            const ans = answers[qKey] || answers[`${pid}__${qKey}`];
            const choice = ans?.choice;
            const confidence = typeof ans?.confidence === 'number' ? ans.confidence : 1.0;
            const isHighConfidence = confidence >= 0.45;
            const normUrl = normalizeUrlForCache(tab.url) || tab.url || '';
            if (!normUrl) return;

            const hygieneAns = answers[`hygiene__${qKey}`];
            const hygieneScore = (hygieneAns && typeof hygieneAns.score === 'number') ? hygieneAns.score : undefined;

            // Robust case-insensitive and trimmed match for returned choice
            const validActiveKeys = Object.keys(criteria);
            const matchedLabel = choice
              ? validActiveKeys.find(l => l.trim().toLowerCase() === String(choice).trim().toLowerCase())
              : null;

            let secondaryLabel = null;
            if (ans?.probabilities && typeof ans.probabilities === 'object') {
              const sorted = Object.entries(ans.probabilities)
                .filter(([k]) => k.trim().toLowerCase() !== String(choice).trim().toLowerCase())
                .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0));
              if (sorted[0] && Number(sorted[0][1]) >= 0.20) {
                const validOther = validActiveKeys.find(l => l.trim().toLowerCase() === String(sorted[0][0]).trim().toLowerCase());
                if (validOther) secondaryLabel = validOther;
              }
            }

            if (matchedLabel) {
              cache[normUrl] = {
                label: matchedLabel,
                secondaryLabel: secondaryLabel || undefined,
                hygieneScore: hygieneScore !== undefined ? hygieneScore : cache[normUrl]?.hygieneScore,
                source: isHighConfidence ? 'ai' : 'ai-low-confidence',
                confidence,
                cooldownMs: isHighConfidence ? undefined : 60000,
                lastAiAttempt: isHighConfidence ? undefined : Date.now(),
                timestamp: Date.now()
              };
            } else if (!cache[normUrl] || getCacheSource(cache[normUrl]) !== 'ai') {
              const fallback = localFallbackClassify(tab, perspective.labels);
              cache[normUrl] = {
                label: fallback,
                source: 'local',
                cooldownMs: 15000,
                lastAiAttempt: Date.now(),
                timestamp: Date.now()
              };
            }

            // Also harvest answers for inactive perspectives from speculative fan-out
            for (const otherP of inactiveSemanticPerspectives) {
              const otherQKey = `${otherP.id}__${qKey}`;
              const otherAns = answers[otherQKey];
              if (!otherAns?.choice) continue;
              const otherChoice = otherAns.choice;
              const otherConfidence = typeof otherAns.confidence === 'number' ? otherAns.confidence : 1.0;
              const otherHighConf = otherConfidence >= 0.45;
              const otherCrit = inactiveCriteriaByPid.get(otherP.id);
              if (!otherCrit) continue;
              const validOtherKeys = Object.keys(otherCrit);
              const otherMatched = validOtherKeys.find(l => l.trim().toLowerCase() === String(otherChoice).trim().toLowerCase());
              if (otherMatched) {
                let otherSecondary = null;
                if (otherAns?.probabilities && typeof otherAns.probabilities === 'object') {
                  const sorted = Object.entries(otherAns.probabilities)
                    .filter(([k]) => k.trim().toLowerCase() !== String(otherChoice).trim().toLowerCase())
                    .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0));
                  if (sorted[0] && Number(sorted[0][1]) >= 0.20) {
                    const validOther = validOtherKeys.find(l => l.trim().toLowerCase() === String(sorted[0][0]).trim().toLowerCase());
                    if (validOther) otherSecondary = validOther;
                  }
                }

                if (!otherPerspectiveUpdates[otherP.id]) otherPerspectiveUpdates[otherP.id] = {};
                otherPerspectiveUpdates[otherP.id][normUrl] = {
                  label: otherMatched,
                  secondaryLabel: otherSecondary || undefined,
                  hygieneScore: hygieneScore !== undefined ? hygieneScore : undefined,
                  source: otherHighConf ? 'ai' : 'ai-low-confidence',
                  confidence: otherConfidence,
                  cooldownMs: otherHighConf ? undefined : 60000,
                  lastAiAttempt: otherHighConf ? undefined : Date.now(),
                  timestamp: Date.now()
                };
              }
            }
          });

          // Save inactive perspective updates atomically without blocking
          for (const [otherPid, items] of Object.entries(otherPerspectiveUpdates)) {
            try {
              await saveClassificationCacheAtomic(otherPid, items);
            } catch {}
          }
        } catch (batchErr) {
          // If aborted by user switching perspectives, do not penalize tabs with cooldown!
          if (batchErr?.name === 'AbortError' || activeSignal?.aborted) {
            return;
          }
          console.warn('[tab-out] Jev batch request fallback:', batchErr);
          const cooldownMs = (batchErr && batchErr.cooldownMs) ? batchErr.cooldownMs : 15000;
          batch.forEach(tab => {
            const normUrl = normalizeUrlForCache(tab.url) || tab.url || '';
            if (normUrl && (!cache[normUrl] || getCacheSource(cache[normUrl]) !== 'ai')) {
              const fallback = localFallbackClassify(tab, perspective.labels);
              cache[normUrl] = {
                label: fallback,
                source: 'local',
                cooldownMs,
                lastAiAttempt: Date.now(),
                timestamp: Date.now()
              };
            }
          });
        }
      }));
    }

  } catch (err) {
    if (err?.name === 'AbortError' || activeSignal?.aborted) {
      return cache;
    }
    console.warn('[tab-out] OpenRouter ~typesafe/jev-latest request fell back to local classifier:', err);
  } finally {
    for (const key of pendingKeys) {
      inFlightUrls.delete(key);
    }
    const hasActiveInFlight = Array.from(inFlightUrls).some(k => k.startsWith(`${activePerspectiveId}:`));
    if (!hasActiveInFlight && typeof document !== 'undefined') {
      const l = document.getElementById('perspectiveLoader');
      const d = document.querySelector('.telemetry-dot');
      if (l) l.style.display = 'none';
      if (d) {
        d.classList.remove('busy');
        d.classList.add('ready');
      }
    }
    try {
      await saveClassificationCacheAtomic(pid, cache);
    } catch {}
  }

  return cache;
}

/**
 * triggerBackgroundClassification(tabs, perspective)
 *
 * Runs non-blocking AI classification in the background.
 * Seamlessly updates UI when AI decisions complete without recursive storms.
 */
function triggerBackgroundClassification(tabs, perspective) {
  if (!tabs || tabs.length === 0 || !openRouterApiKey) return;
  const pid = perspective.id;

  (async () => {
    try {
      const cacheBefore = tabClassificationCache[pid] || {};
      const prevLabels = new Map();
      for (const t of tabs) {
        const norm = normalizeUrlForCache(t.url) || t.url || '';
        prevLabels.set(norm, getCacheLabel(cacheBefore[norm]));
      }

      await classifyTabs(tabs, perspective, true /* forceAi */, { silent: true });

      // Only re-render if user is still on this perspective AND at least one label actually changed!
      if (activePerspectiveId === pid) {
        const cacheAfter = tabClassificationCache[pid] || {};
        let hasLabelChanges = false;
        for (const t of tabs) {
          const norm = normalizeUrlForCache(t.url) || t.url || '';
          const newLabel = getCacheLabel(cacheAfter[norm]);
          if (newLabel && newLabel !== prevLabels.get(norm)) {
            hasLabelChanges = true;
            break;
          }
        }
        if (hasLabelChanges) {
          await renderStaticDashboard({ skipBackgroundAi: true, inMemoryOnly: true });
        }
      }
    } catch (err) {
      console.warn('[tab-out] Background classification error:', err);
    }
  })();
}

let prewarmTimer = null;

let isPrewarmingMultiPerspective = false;

/**
 * prewarmMultiPerspective(realTabs, inactivePerspectives)
 *
 * Utilizes TypeSafe Jev Multi-Question Decision batching to prewarm multiple
 * inactive perspectives concurrently in a single HTTP round-trip.
 */
async function prewarmMultiPerspective(realTabs, inactivePerspectives) {
  if (isPrewarmingMultiPerspective) return;
  if (!openRouterApiKey || !realTabs || realTabs.length === 0) return;
  const targetPerspectives = (inactivePerspectives && inactivePerspectives.length > 0)
    ? inactivePerspectives
    : ((typeof currentPerspectives !== 'undefined' && Array.isArray(currentPerspectives))
        ? currentPerspectives.filter(p => p && p.id !== 'domain' && p.id !== activePerspectiveId && p.labels && p.labels.length > 0)
        : []);
  if (targetPerspectives.length === 0) return;
  isPrewarmingMultiPerspective = true;

  const validTabs = [];
  const questions = {};
  const criteriaByPid = new Map();
  for (const p of targetPerspectives) {
    if (!p.labels || p.labels.length === 0) continue;
    criteriaByPid.set(p.id, buildChoiceCriteria(p));
  }

  // Collect up to 12 tabs that need AI classification in at least one inactive perspective
  const candidateTabs = [];
  for (const tab of realTabs) {
    const normUrl = normalizeUrlForCache(tab.url) || tab.url || '';
    if (!normUrl) continue;
    let needsAny = false;
    for (const p of targetPerspectives) {
      const pCache = tabClassificationCache[p.id] || {};
      const entry = pCache[normUrl];
      const isFailedRecently = entry?.lastAiAttempt && (Date.now() - entry.lastAiAttempt < (entry.cooldownMs || 15000));
      if (!isFailedRecently && (!entry || getCacheSource(entry) !== 'ai')) {
        needsAny = true;
        break;
      }
    }
    if (needsAny) {
      candidateTabs.push(tab);
      if (candidateTabs.length >= 12) break;
    }
  }

  if (candidateTabs.length === 0) {
    isPrewarmingMultiPerspective = false;
    return;
  }

  candidateTabs.forEach((tab, tabIdx) => {
    const normUrl = normalizeUrlForCache(tab.url) || tab.url || '';
    const cleanTitle = (tab.title || '').replace(/[\r\n]+/g, ' ').slice(0, 140);
    const cleanUrl = normUrl.slice(0, 140);
    const tabKey = `tab_${tabIdx}`;

    let hasQuestionForTab = false;
    for (const p of targetPerspectives) {
      const pCache = tabClassificationCache[p.id] || {};
      const entry = pCache[normUrl];
      const isFailedRecently = entry?.lastAiAttempt && (Date.now() - entry.lastAiAttempt < (entry.cooldownMs || 15000));
      if (!isFailedRecently && (!entry || getCacheSource(entry) !== 'ai')) {
        const criteria = criteriaByPid.get(p.id);
        if (criteria) {
          questions[`${p.id}__${tabKey}`] = {
            type: 'choice',
            instructions: `Categorize \`tabs.${tabKey}\` into the single most fitting category for "${p.name || p.id}" based on criteria.`,
            criteria
          };
          hasQuestionForTab = true;
        }
      }
    }
    if (hasQuestionForTab) {
      questions[`hygiene__${tabKey}`] = {
        type: 'score',
        instructions: `Rate if \`tabs.${tabKey}\` is disposable or transient: 0 for persistent important active workspace, up to 3 for temporary search/disposable lookup/duplicate tab safe to close.`,
        criteria: HYGIENE_SCORE_CRITERIA
      };
      validTabs.push({ tabKey, normUrl, cleanTitle, cleanUrl });
    }
  });

  if (validTabs.length === 0 || Object.keys(questions).length === 0) {
    isPrewarmingMultiPerspective = false;
    return;
  }

  const state = { tabs: {} };
  validTabs.forEach(t => {
    state.tabs[t.tabKey] = {
      title: t.cleanTitle,
      url: t.normUrl.slice(0, 300),
      domain: extractHostname(t.normUrl)
    };
  });
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = setTimeout(() => controller?.abort(), 12000);

  try {
    const response = await fetch('https://openrouter.ai/api/alpha/decisions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openRouterApiKey}`,
        'HTTP-Referer': 'https://github.com/Gohans1/tab-out',
        'X-Title': 'Tab Out Perspective Prewarm'
      },
      signal: controller?.signal,
      body: JSON.stringify({
        model: '~typesafe/jev-latest',
        state,
        questions
      })
    });

    if (!response.ok) {
      let cooldownMs = 15000;
      const retryAfter = Number(response.headers?.get?.('retry-after'));
      if (!isNaN(retryAfter) && retryAfter > 0) {
        cooldownMs = Math.min(Math.max(retryAfter * 1000, 5000), 300000);
      } else if (response.status === 401 || response.status === 403 || response.status === 429 || response.status === 529) {
        cooldownMs = 60000;
      } else if (response.status === 400 || response.status === 402 || response.status === 422) {
        cooldownMs = 300000;
      }
      const failedByPid = {};
      for (const t of validTabs) {
        for (const p of targetPerspectives) {
          const qKey = `${p.id}__${t.tabKey}`;
          if (questions[qKey]) {
            if (!tabClassificationCache[p.id]) tabClassificationCache[p.id] = {};
            const entry = tabClassificationCache[p.id][t.normUrl];
            if (!entry || getCacheSource(entry) !== 'ai') {
              const updatedEntry = {
                ...(typeof entry === 'object' ? entry : {}),
                label: getCacheLabel(entry) || 'Khác',
                source: getCacheSource(entry) || 'local',
                cooldownMs,
                lastAiAttempt: Date.now(),
                timestamp: Date.now()
              };
              tabClassificationCache[p.id][t.normUrl] = updatedEntry;
              if (!failedByPid[p.id]) failedByPid[p.id] = {};
              failedByPid[p.id][t.normUrl] = updatedEntry;
            }
          }
        }
      }
      for (const [failedPid, items] of Object.entries(failedByPid)) {
        try {
          await saveClassificationCacheAtomic(failedPid, items);
        } catch {}
      }
      return;
    }
    const data = await response.json();
    const answers = data.answers || {};

    const updatesByPid = {};
    for (const [qKey, ans] of Object.entries(answers)) {
      const choice = ans?.choice;
      if (!choice) continue;
      const lastSep = qKey.lastIndexOf('__');
      if (lastSep === -1) continue;
      const pid = qKey.slice(0, lastSep);
      const tabKey = qKey.slice(lastSep + 2);

      const tabInfo = validTabs.find(t => t.tabKey === tabKey);
      if (!tabInfo) continue;
      const criteria = criteriaByPid.get(pid);
      if (!criteria) continue;

      const validNames = Object.keys(criteria);
      const matched = validNames.find(n => n.trim().toLowerCase() === String(choice).trim().toLowerCase());
      if (!matched) continue;

      const confidence = typeof ans?.confidence === 'number' ? ans.confidence : 1.0;
      const isHighConfidence = confidence >= 0.45;

      let secondaryLabel = null;
      if (ans?.probabilities && typeof ans.probabilities === 'object') {
        const sorted = Object.entries(ans.probabilities)
          .filter(([k]) => k.trim().toLowerCase() !== String(choice).trim().toLowerCase())
          .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0));
        if (sorted[0] && Number(sorted[0][1]) >= 0.20) {
          const validOther = validNames.find(l => l.trim().toLowerCase() === String(sorted[0][0]).trim().toLowerCase());
          if (validOther) secondaryLabel = validOther;
        }
      }

      const hygieneAns = answers[`hygiene__${tabKey}`];
      const hygieneScore = (hygieneAns && typeof hygieneAns.score === 'number') ? hygieneAns.score : undefined;

      if (!updatesByPid[pid]) updatesByPid[pid] = {};
      updatesByPid[pid][tabInfo.normUrl] = {
        label: matched,
        secondaryLabel: secondaryLabel || undefined,
        hygieneScore: hygieneScore !== undefined ? hygieneScore : undefined,
        source: isHighConfidence ? 'ai' : 'ai-low-confidence',
        confidence,
        cooldownMs: isHighConfidence ? undefined : 60000,
        lastAiAttempt: isHighConfidence ? undefined : Date.now(),
        timestamp: Date.now()
      };
    }

    for (const [pid, newItems] of Object.entries(updatesByPid)) {
      await saveClassificationCacheAtomic(pid, newItems);
      if (activePerspectiveId === pid) {
        await renderStaticDashboard({ skipBackgroundAi: true, inMemoryOnly: true });
      }
    }
  } catch (err) {
    // Silent fail in idle prewarm
  } finally {
    clearTimeout(timeoutId);
    isPrewarmingMultiPerspective = false;
  }
}

/**
 * schedulePerspectivePrewarm()
 *
 * Runs non-blocking pre-warming of inactive perspectives during browser idle time.
 * Populates cache ahead of user clicks so switching perspective is 0ms instant.
 * Uses snappy 80ms debounce on hover to initiate request before click.
 */
function schedulePerspectivePrewarm(targetPid = null) {
  if (typeof openRouterApiKey === 'undefined' || !openRouterApiKey) return;
  if (prewarmTimer) {
    if (typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(prewarmTimer);
    } else if (typeof clearTimeout !== 'undefined') {
      clearTimeout(prewarmTimer);
    }
    prewarmTimer = null;
  }

  const runner = async () => {
    if (typeof currentPerspectives === 'undefined' || !Array.isArray(currentPerspectives)) return;
    const inactivePerspectives = currentPerspectives.filter(
      p => p.id !== 'domain' && p.id !== activePerspectiveId
    );
    if (inactivePerspectives.length === 0) return;

    if (targetPid) {
      inactivePerspectives.sort((a, b) => (a.id === targetPid ? -1 : b.id === targetPid ? 1 : 0));
    }

    const realTabs = typeof getRealTabs === 'function' ? getRealTabs() : [];
    if (realTabs.length === 0) return;

    await prewarmMultiPerspective(realTabs, inactivePerspectives);
  };

  // If triggered by hover on a specific perspective, kick off in 80ms to lead user click
  if (targetPid && typeof setTimeout !== 'undefined') {
    prewarmTimer = setTimeout(() => runner(), 80);
  } else if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    prewarmTimer = window.requestIdleCallback(() => runner(), { timeout: 2000 });
  } else if (typeof setTimeout !== 'undefined') {
    prewarmTimer = setTimeout(() => runner(), 800);
  }
}

function renderPerspectiveRail() {
  const listEl = document.getElementById('perspectiveList');
  if (!listEl) return;

  const realTabs = getRealTabs();
  const count = realTabs.length;

  listEl.innerHTML = currentPerspectives.map(p => {
    const isActive = p.id === activePerspectiveId;
    const iconSvg = PERSPECTIVE_ICONS[p.icon] || PERSPECTIVE_ICONS.folder;
    const editBtn = !p.isSystem
      ? `<button type="button" class="perspective-tab-edit-btn" data-action="edit-perspective" data-perspective-id="${escapeHtml(p.id)}" title="Chỉnh sửa perspective" aria-label="Chỉnh sửa perspective">
          ${PERSPECTIVE_ICONS.edit}
        </button>`
      : '';

    return `
      <div class="perspective-tab ${isActive ? 'active' : ''}" role="tab" tabindex="0" aria-selected="${isActive}" data-action="switch-perspective" data-perspective-id="${escapeHtml(p.id)}">
        <span class="perspective-tab-icon">${iconSvg}</span>
        <span class="perspective-tab-name">${escapeHtml(p.name)}</span>
        <span class="perspective-tab-count">${count}</span>
        ${editBtn}
      </div>
    `;
  }).join('');
}

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
    const domainForClean = (domain && !domain.startsWith('perspective:')) ? domain : extractHostname(tab.url);
    const rawLabel  = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), domainForClean);
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
    const domainForClean = group.isSemantic ? extractHostname(tab.url) : group.domain;
    let rawLabel = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), domainForClean);
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
async function renderStaticDashboard(options = {}) {
  if (typeof document === 'undefined') return;
  const skipBackgroundAi = options && options.skipBackgroundAi === true;
  const inMemoryOnly = options && options.inMemoryOnly === true;

  // --- Ensure perspective settings are loaded ---
  if (!inMemoryOnly) {
    await loadPerspectiveSettings();
  }

  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = 'Active tabs';
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Fetch tabs ---
  if (!inMemoryOnly || !openTabs || openTabs.length === 0) {
    await fetchOpenTabs();
  }
  const realTabs = getRealTabs();

  // --- Render Vertical Tabs Rail ---
  renderPerspectiveRail();

  const heroSub = document.getElementById('heroSubtitle');
  if (heroSub) {
    const windowIds = new Set(realTabs.map(t => t.windowId));
    const winCount = windowIds.size || 1;
    heroSub.textContent = `${realTabs.length} tab${realTabs.length !== 1 ? 's' : ''} across ${winCount} window${winCount !== 1 ? 's' : ''}`;
  }

  // Check whether we are in Domain perspective or a custom Semantic perspective
  if (activePerspectiveId !== 'domain') {
    // --- SEMANTIC PERSPECTIVE GROUPING (INSTANT 0MS FAST PATH) ---
    const activeP = currentPerspectives.find(p => p.id === activePerspectiveId) || currentPerspectives[0];
    const pid = activeP ? activeP.id : 'domain';
    if (!tabClassificationCache[pid]) {
      tabClassificationCache[pid] = {};
    }
    const cache = tabClassificationCache[pid];
    const semMap = {};
    const uncachedTabs = [];

    // Pre-build fast O(1) domain-to-AI-label map for current perspective cache
    const domainAiLabelMap = new Map();
    for (const [cachedUrl, cEntry] of Object.entries(cache)) {
      if (getCacheSource(cEntry) === 'ai') {
        const host = extractHostname(cachedUrl);
        if (host && !MULTI_TOPIC_DOMAINS.has(host) && !domainAiLabelMap.has(host)) {
          domainAiLabelMap.set(host, getCacheLabel(cEntry));
        }
      }
    }

    // Instant Fast Path: Group immediately from cache or local heuristic without waiting for network
    for (const tab of realTabs) {
      const normUrl = normalizeUrlForCache(tab.url) || tab.url || '';
      if (!normUrl) continue;

      let entry = cache[normUrl];
      let label = getCacheLabel(entry);
      const isFailedRecently = entry?.lastAiAttempt && (Date.now() - entry.lastAiAttempt < (entry.cooldownMs || 15000));
      const inFlightKey = `${pid}:${normUrl}`;

      if (!label) {
        const host = extractHostname(tab.url);
        const domainAiLabel = (!MULTI_TOPIC_DOMAINS.has(host) && domainAiLabelMap.get(host)) || null;
        if (domainAiLabel) {
          label = domainAiLabel;
          cache[normUrl] = { label, source: 'domain-ai', timestamp: Date.now() };
          // domain-ai serves as instant 0ms placeholder; queue for background Jev AI refinement
          if (!skipBackgroundAi && !inFlightUrls.has(inFlightKey) && !isFailedRecently) {
            uncachedTabs.push(tab);
          }
        } else {
          label = localFallbackClassify(tab, activeP?.labels);
          cache[normUrl] = { label, source: 'local', timestamp: Date.now() };
          if (!skipBackgroundAi && !inFlightUrls.has(inFlightKey) && !isFailedRecently) {
            uncachedTabs.push(tab);
          }
        }
      } else if (getCacheSource(entry) !== 'ai') {
        // Upgrade local heuristics and domain-ai placeholders to true AI in background
        if (!skipBackgroundAi && !inFlightUrls.has(inFlightKey) && !isFailedRecently) {
          uncachedTabs.push(tab);
        }
      }

      if (!semMap[label]) {
        semMap[label] = { domain: `perspective:${label}`, label, isSemantic: true, tabs: [] };
      }
      semMap[label].tabs.push(tab);
    }

    domainGroups = Object.values(semMap).sort((a, b) => {
      const aIsOther = a.label.toLowerCase().includes('khác') || a.label.toLowerCase().includes('other');
      const bIsOther = b.label.toLowerCase().includes('khác') || b.label.toLowerCase().includes('other');
      if (aIsOther !== bIsOther) return aIsOther ? 1 : -1;
      return b.tabs.length - a.tabs.length;
    });

    // If OpenRouter is configured and there are uncached tabs, run non-blocking background Jev refinement
    if (!skipBackgroundAi && openRouterApiKey && uncachedTabs.length > 0) {
      triggerBackgroundClassification(uncachedTabs, activeP);
    }

  } else {
    // --- STANDARD DOMAIN GROUPING ---
    const LANDING_PAGE_PATTERNS = [
      { hostname: 'mail.google.com', test: (p, h) =>
          !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
      { hostname: 'x.com',            pathExact: ['/home'] },
      { hostname: 'twitter.com',      pathExact: ['/home'] },
      { hostname: 'linkedin.com',     pathExact: ['/'] },
      { hostname: 'github.com',       pathExact: ['/'] },
      { hostname: 'youtube.com',      pathExact: ['/'] },
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
    const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

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
          return true;
        }) || null;
      } catch { return null; }
    }

    for (const tab of realTabs) {
      try {
        if (isLandingPage(tab.url)) {
          landingTabs.push(tab);
          continue;
        }

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
      } catch {}
    }

    if (landingTabs.length > 0) {
      groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
    }

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
  }

  // --- Render domain/perspective cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (openTabsSection) {
    const isDomainView = activePerspectiveId === 'domain';
    const activeP = currentPerspectives.find(p => p.id === activePerspectiveId);
    const viewTitle = isDomainView ? 'Open tabs' : (activeP ? activeP.name : 'Open tabs');
    const countLabel = isDomainView
      ? `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''}`
      : `${domainGroups.length} categor${domainGroups.length !== 1 ? 'ies' : 'y'}`;

    if (domainGroups.length > 0) {
      if (openTabsSectionTitle) openTabsSectionTitle.textContent = viewTitle;
      if (openTabsSectionCount) openTabsSectionCount.textContent = countLabel;
      const openTabsHeaderActions = document.getElementById('openTabsHeaderActions');
      if (openTabsHeaderActions) {
        let actionsHtml = '';
        if (!isDomainView) {
          actionsHtml += `<button type="button" class="perspective-edit-header-btn" data-action="edit-perspective" data-perspective-id="${escapeHtml(activePerspectiveId)}" title="Chỉnh sửa tags của perspective này">${PERSPECTIVE_ICONS.edit}<span>Chỉnh sửa tags</span></button>`;
        }
        if (realTabs.length > 1) {
          actionsHtml += `<button class="action-btn close-tabs close-all-btn" data-action="close-all-open-tabs">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
        }
        openTabsHeaderActions.innerHTML = actionsHtml;
      }
      if (openTabsMissionsEl) openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    } else {
      if (openTabsSectionTitle) openTabsSectionTitle.textContent = viewTitle;
      if (openTabsSectionCount) openTabsSectionCount.textContent = isDomainView ? '0 domains' : '0 categories';
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

  // --- Pre-warm inactive perspectives in background idle time ---
  if (!skipBackgroundAi && openRouterApiKey) {
    schedulePerspectivePrewarm();
  }
}

/**
 * renderAll()
 *
 * Synchronizes and updates the entire dashboard interface: open tabs and deferred column.
 */
async function renderAll() {
  if (typeof document === 'undefined') return;
  await renderStaticDashboard();
  await renderDeferredColumn();
}

/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

if (typeof document !== 'undefined') {
  document.addEventListener('click', async (e) => {
    // Walk up the DOM to find the nearest element with data-action or #archiveToggle
    const actionEl = e.target.closest('[data-action], #archiveToggle');
    if (!actionEl) return;

  const action = actionEl.dataset.action || (actionEl.id === 'archiveToggle' ? 'toggle-archive' : '');

  // ---- Switch active perspective tab ----
  if (action === 'switch-perspective') {
    const pid = actionEl.dataset.perspectiveId;
    if (pid && pid !== activePerspectiveId) {
      if (activeClassificationAbortController) {
        try { activeClassificationAbortController.abort(); } catch {}
        activeClassificationAbortController = null;
      }
      activePerspectiveId = pid;
      isLocalSettingUpdate = true;
      chrome.storage.local.set({ activePerspectiveId }).catch(() => {});
      setTimeout(() => { isLocalSettingUpdate = false; }, 200);
      await renderStaticDashboard({ inMemoryOnly: true });
    }
    return;
  }

  // ---- Open New Perspective Modal ----
  if (action === 'open-perspective-modal') {
    const overlay = document.getElementById('perspectiveModalOverlay');
    const modalTitle = document.getElementById('perspectiveModalTitle');
    const editId = document.getElementById('perspectiveEditId');
    const nameInput = document.getElementById('perspectiveNameInput');
    const delBtn = document.getElementById('perspectiveDeleteBtn');
    const tagsContainer = document.getElementById('perspectiveTagsContainer');

    if (overlay) {
      if (modalTitle) modalTitle.textContent = 'Thêm Perspective Mới';
      if (editId) editId.value = '';
      if (nameInput) nameInput.value = '';
      if (delBtn) delBtn.style.display = 'none';
      if (tagsContainer) {
        tagsContainer.innerHTML = '';
        addTagRowToModal('', '');
      }
      overlay.style.display = 'flex';
      setTimeout(() => nameInput?.focus(), 50);
    }
    return;
  }

  // ---- Edit Perspective ----
  if (action === 'edit-perspective') {
    e.stopPropagation();
    const pid = actionEl.dataset.perspectiveId;
    const p = currentPerspectives.find(item => item.id === pid);
    if (!p) return;

    const overlay = document.getElementById('perspectiveModalOverlay');
    const modalTitle = document.getElementById('perspectiveModalTitle');
    const editId = document.getElementById('perspectiveEditId');
    const nameInput = document.getElementById('perspectiveNameInput');
    const delBtn = document.getElementById('perspectiveDeleteBtn');
    const tagsContainer = document.getElementById('perspectiveTagsContainer');

    if (overlay) {
      if (modalTitle) modalTitle.textContent = `Chỉnh sửa Perspective: ${p.name}`;
      if (editId) editId.value = p.id;
      if (nameInput) nameInput.value = p.name;
      if (delBtn) delBtn.style.display = (p.isSystem || p.id === 'topic' || p.id === 'purpose') ? 'none' : 'inline-block';
      if (tagsContainer) {
        tagsContainer.innerHTML = '';
        const normalized = normalizeLabels(p.labels);
        if (normalized.length > 0) {
          normalized.forEach(tag => addTagRowToModal(tag.name, tag.description));
        } else {
          addTagRowToModal('', '');
        }
      }
      overlay.style.display = 'flex';
      setTimeout(() => nameInput?.focus(), 50);
    }
    return;
  }

  // ---- Add Tag Row in Perspective Modal ----
  if (action === 'add-tag-row') {
    addTagRowToModal('', '', true);
    return;
  }

  // ---- Remove Tag Row in Perspective Modal ----
  if (action === 'remove-tag-row') {
    const row = actionEl.closest('.tag-row');
    if (row) {
      const container = document.getElementById('perspectiveTagsContainer');
      const allRows = container ? container.querySelectorAll('.tag-row') : [];
      if (allRows.length <= 1) {
        const nameInput = row.querySelector('.tag-field-name');
        const descInput = row.querySelector('.tag-field-desc');
        if (nameInput) nameInput.value = '';
        if (descInput) descInput.value = '';
        if (nameInput) nameInput.focus();
      } else {
        row.remove();
      }
    }
    return;
  }

  // ---- Close Confirm Modal ----
  if (action === 'close-confirm-modal') {
    const overlay = document.getElementById('confirmModalOverlay');
    if (overlay) overlay.style.display = 'none';
    return;
  }

  // ---- Close Perspective Modal ----
  if (action === 'close-perspective-modal') {
    const overlay = document.getElementById('perspectiveModalOverlay');
    if (overlay) overlay.style.display = 'none';
    return;
  }

  // ---- Delete Perspective ----
  if (action === 'delete-perspective') {
    const editId = document.getElementById('perspectiveEditId')?.value;
    if (!editId) return;

    const targetPerspective = currentPerspectives.find(p => p.id === editId);
    if (!targetPerspective || targetPerspective.isSystem || targetPerspective.id === 'topic' || targetPerspective.id === 'purpose') return;

    const pName = targetPerspective.name || 'này';
    const confirmed = await showConfirmDialog({
      title: `Xóa perspective "${pName}"?`,
      description: `Toàn bộ tags tùy chỉnh và dữ liệu phân loại AI của perspective này sẽ bị xóa vĩnh viễn khỏi trình duyệt.`,
      confirmText: 'Xóa vĩnh viễn',
      cancelText: 'Giữ lại',
      danger: true
    });
    if (!confirmed) return;

    currentPerspectives = currentPerspectives.filter(p => p.id !== editId);
    if (activePerspectiveId === editId) {
      activePerspectiveId = 'domain';
    }
    if (tabClassificationCache[editId]) {
      delete tabClassificationCache[editId];
    }
    isLocalSettingUpdate = true;
    await chrome.storage.local.remove([`tabClassificationCache_${editId}`]);
    await chrome.storage.local.set({
      perspectives: currentPerspectives,
      activePerspectiveId,
      tabClassificationCache
    });
    setTimeout(() => { isLocalSettingUpdate = false; }, 200);

    const overlay = document.getElementById('perspectiveModalOverlay');
    if (overlay) overlay.style.display = 'none';

    await renderStaticDashboard();
    showToast('Perspective deleted');
    return;
  }

  // ---- Open API Key Modal ----
  if (action === 'open-api-key-modal') {
    const overlay = document.getElementById('apiKeyModalOverlay');
    const keyInput = document.getElementById('apiKeyInput');
    if (overlay) {
      if (keyInput) keyInput.value = openRouterApiKey || '';
      overlay.style.display = 'flex';
      setTimeout(() => keyInput?.focus(), 50);
    }
    return;
  }

  // ---- Close API Key Modal ----
  if (action === 'close-api-key-modal') {
    const overlay = document.getElementById('apiKeyModalOverlay');
    if (overlay) overlay.style.display = 'none';
    return;
  }

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
    let closedTab = null;
    try {
      const allTabs = await chrome.tabs.query({});
      const currentWindow = await chrome.windows.getCurrent();
      const match = allTabs.find(t => t.url === tabUrl && t.windowId === currentWindow.id)
                 || allTabs.find(t => t.url === tabUrl);
      if (match) {
        removedId = match.id;
        closedTab = { url: match.url, title: match.title };
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

    if (closedTab && closedTab.url) {
      pushUndoAction({
        description: `Closed "${closedTab.title || friendlyDomain(closedTab.url)}"`,
        onUndo: async () => {
          try {
            await chrome.tabs.create({ url: closedTab.url, active: false });
            await fetchOpenTabs();
            await renderAll();
            showToast(`Restored "${closedTab.title || friendlyDomain(closedTab.url)}"`);
          } catch (err) {
            console.warn('[tab-out] Failed to restore tab:', err);
          }
        }
      });
    } else {
      showToast('Tab closed');
    }
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

    if (!actionEl.classList.contains('confirming')) {
      actionEl.classList.add('confirming');
      actionEl.title = 'Click again to confirm dismiss';
      actionEl.setAttribute('aria-label', 'Click again to confirm dismiss');
      const originalHtml = actionEl.innerHTML;
      actionEl.dataset.originalHtml = originalHtml;
      actionEl.innerHTML = `<span class="confirm-inline-label">Dismiss?</span>`;

      const timeoutId = setTimeout(() => {
        if (actionEl.isConnected) {
          actionEl.classList.remove('confirming');
          actionEl.innerHTML = actionEl.dataset.originalHtml || originalHtml;
          actionEl.title = 'Dismiss';
          actionEl.setAttribute('aria-label', 'Dismiss');
          delete actionEl.dataset.originalHtml;
        }
      }, 3500);
      actionEl.dataset.confirmTimeout = String(timeoutId);
      return;
    }

    clearTimeout(parseInt(actionEl.dataset.confirmTimeout || '0', 10));
    actionEl.classList.remove('confirming');

    let itemSnapshot = null;
    try {
      const res = await chrome.storage.local.get('deferred');
      const all = res && Array.isArray(res.deferred) ? res.deferred : [];
      itemSnapshot = all.find(t => String(t.id) === String(id));
    } catch {}

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

    if (itemSnapshot) {
      pushUndoAction({
        description: 'Saved tab dismissed',
        onUndo: async () => {
          await mutateDeferred(deferred => {
            if (!deferred.some(t => String(t.id) === String(itemSnapshot.id))) {
              deferred.unshift(itemSnapshot);
            }
            return deferred;
          });
          await renderDeferredColumn();
          updateHeaderAndStats();
          showToast('Restored to Saved for later');
        }
      });
    } else {
      showToast('Saved tab dismissed');
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domain = actionEl.dataset.domain;
    const group  = domainGroups.find(g => g.domain === domain);
    if (!group) return;

    if (!actionEl.classList.contains('confirming')) {
      actionEl.classList.add('confirming');
      const originalHtml = actionEl.innerHTML;
      actionEl.dataset.originalHtml = originalHtml;
      const count = group.tabs ? group.tabs.length : 0;
      actionEl.innerHTML = `${ICONS.close} Close ${count} tabs?`;

      const timeoutId = setTimeout(() => {
        if (actionEl.isConnected) {
          actionEl.classList.remove('confirming');
          actionEl.innerHTML = actionEl.dataset.originalHtml || originalHtml;
          delete actionEl.dataset.originalHtml;
        }
      }, 4000);
      actionEl.dataset.confirmTimeout = String(timeoutId);
      return;
    }

    clearTimeout(parseInt(actionEl.dataset.confirmTimeout || '0', 10));
    actionEl.classList.remove('confirming');
    if (actionEl.dataset.originalHtml) {
      actionEl.innerHTML = actionEl.dataset.originalHtml;
      delete actionEl.dataset.originalHtml;
    }

    // Filter against currently active tabs in Chrome to avoid rejecting on closed IDs
    let validTabIds = [];
    let closedTabsSnapshot = [];
    try {
      const currentTabs = await chrome.tabs.query({});
      const liveMap = new Map(currentTabs.map(t => [t.id, t]));
      const liveIds = new Set(liveMap.keys());
      validTabIds = group.tabs.map(t => t.id).filter(id => liveIds.has(id));
      closedTabsSnapshot = validTabIds.map(id => {
        const t = liveMap.get(id);
        return { url: t?.url, title: t?.title };
      }).filter(t => Boolean(t.url));

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
    if (closedTabsSnapshot.length > 0) {
      pushUndoAction({
        description: `Closed ${closedTabsSnapshot.length} tab${closedTabsSnapshot.length !== 1 ? 's' : ''} from ${groupLabel}`,
        onUndo: async () => {
          try {
            for (const t of closedTabsSnapshot) {
              if (t.url) await chrome.tabs.create({ url: t.url, active: false });
            }
            await fetchOpenTabs();
            await renderAll();
            showToast(`Restored ${closedTabsSnapshot.length} tabs from ${groupLabel}`);
          } catch (err) {
            console.warn('[tab-out] Failed to restore domain tabs:', err);
          }
        }
      });
    } else {
      showToast(`Closed ${validTabIds.length} tab${validTabIds.length !== 1 ? 's' : ''} from ${groupLabel}`);
    }

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

  // ---- Close ALL open tabs (with modal confirmation) ----
  if (action === 'close-all-open-tabs') {
    const realTabs = getRealTabs();
    const count = realTabs.length;
    if (count === 0) return;

    const confirmed = await showConfirmDialog({
      title: `Close all ${count} tabs?`,
      description: `You are about to close all ${count} open tabs in this window. Unsaved forms and page states will be closed.`,
      confirmText: `Close all ${count} tabs`,
      cancelText: 'Cancel',
      danger: true
    });
    if (!confirmed) return;

    // Filter against currently active tabs in Chrome to avoid rejecting on closed IDs
    let validTabIds = [];
    let closedTabsSnapshot = [];
    try {
      const currentTabs = await chrome.tabs.query({});
      const liveIds = new Set(currentTabs.map(t => t.id));
      validTabIds = realTabs.map(t => t.id).filter(id => id && liveIds.has(id));
      closedTabsSnapshot = validTabIds.map(id => {
        const t = currentTabs.find(tab => tab.id === id);
        return { url: t?.url, title: t?.title };
      }).filter(t => Boolean(t.url));

      if (validTabIds.length > 0) {
        await chrome.tabs.remove(validTabIds);
      }
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

    if (closedTabsSnapshot.length > 0) {
      pushUndoAction({
        description: `Closed all ${closedTabsSnapshot.length} tabs`,
        onUndo: async () => {
          try {
            for (const t of closedTabsSnapshot) {
              if (t.url) await chrome.tabs.create({ url: t.url, active: false });
            }
            await fetchOpenTabs();
            await renderAll();
            showToast(`Restored ${closedTabsSnapshot.length} tabs`);
          } catch (err) {
            console.warn('[tab-out] Failed to restore all tabs:', err);
          }
        }
      });
    } else {
      showToast('All tabs closed. Fresh start.');
    }
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

  // ---- Delete archived tab permanently (with inline confirmation) ----
  if (action === 'delete-archived-tab') {
    e.stopPropagation();
    const id = actionEl.dataset.archiveId;
    if (!id) return;

    if (!actionEl.classList.contains('confirming')) {
      actionEl.classList.add('confirming');
      actionEl.title = 'Click again to confirm permanent delete';
      actionEl.setAttribute('aria-label', 'Click again to confirm permanent delete');
      const originalHtml = actionEl.innerHTML;
      actionEl.dataset.originalHtml = originalHtml;
      actionEl.innerHTML = `<span class="confirm-inline-label">Delete?</span>`;

      const timeoutId = setTimeout(() => {
        if (actionEl.isConnected) {
          actionEl.classList.remove('confirming');
          actionEl.innerHTML = actionEl.dataset.originalHtml || originalHtml;
          actionEl.title = 'Delete permanently';
          actionEl.setAttribute('aria-label', 'Delete permanently');
          delete actionEl.dataset.originalHtml;
        }
      }, 3500);
      actionEl.dataset.confirmTimeout = String(timeoutId);
      return;
    }

    clearTimeout(parseInt(actionEl.dataset.confirmTimeout || '0', 10));
    actionEl.classList.remove('confirming');

    let itemSnapshot = null;
    try {
      const res = await chrome.storage.local.get('deferred');
      const all = res && Array.isArray(res.deferred) ? res.deferred : [];
      itemSnapshot = all.find(t => String(t.id) === String(id));
    } catch {}

    await deleteSavedTab(id);
    const item = actionEl.closest('.archive-item');
    if (item) item.remove();

    if (itemSnapshot) {
      pushUndoAction({
        description: 'Deleted from archive',
        onUndo: async () => {
          await mutateDeferred(deferred => {
            if (!deferred.some(t => String(t.id) === String(itemSnapshot.id))) {
              deferred.push(itemSnapshot);
            }
            return deferred;
          });
          await renderDeferredColumn();
          updateHeaderAndStats();
          showToast('Restored to archive');
        }
      });
    } else {
      showToast('Deleted from archive');
    }
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
}

// ---- Archive search — debounced filter for archived items ----
let searchTimeout = null;
if (typeof document !== 'undefined') {
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
}

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

// Cross-tab sync for "Saved for later", Perspectives, and Tab Classification Cache
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName === 'local') {
      if (changes.deferred) {
        if (animatingDeferredIds.size === 0) {
          renderDeferredColumn();
        }
      }
      if (changes.perspectives || changes.activePerspectiveId || changes.openRouterApiKey || changes.classifierApiKey) {
        if (isLocalSettingUpdate) return;
        await loadPerspectiveSettings(true);
        await renderStaticDashboard();
      }
      // Check for partitioned tab classification cache updates first!
      const incomingByPid = {};
      let hasPartitionChanges = false;
      for (const [key, change] of Object.entries(changes)) {
        if (key.startsWith('tabClassificationCache_') && change.newValue && typeof change.newValue === 'object') {
          const pid = key.slice('tabClassificationCache_'.length);
          incomingByPid[pid] = change.newValue;
          hasPartitionChanges = true;
        }
      }
      // Only process monolithic if no specific partition key changes were broadcast
      if (!hasPartitionChanges && changes.tabClassificationCache?.newValue && typeof changes.tabClassificationCache.newValue === 'object') {
        Object.assign(incomingByPid, changes.tabClassificationCache.newValue);
      }

      if (Object.keys(incomingByPid).length > 0) {
        let hasRelevantChanges = false;
        const realTabs = typeof getRealTabs === 'function' ? getRealTabs() : [];
        const openTabNormUrls = new Set(realTabs.map(t => normalizeUrlForCache(t.url) || t.url || ''));
        const activePid = activePerspectiveId;

        for (const [pid, pCache] of Object.entries(incomingByPid)) {
          if (!tabClassificationCache[pid]) {
            tabClassificationCache[pid] = {};
          }
          if (pCache && typeof pCache === 'object') {
            for (const [urlKey, entry] of Object.entries(pCache)) {
              const prev = tabClassificationCache[pid][urlKey];
              const prevSource = getCacheSource(prev);
              const newSource = getCacheSource(entry);

              // Never overwrite existing 'ai' with non-'ai'
              if (prevSource === 'ai' && newSource !== 'ai') {
                continue;
              }

              // If both are 'ai', keep higher confidence if existing has better confidence
              if (prevSource === 'ai' && newSource === 'ai' &&
                  typeof prev?.confidence === 'number' && typeof entry?.confidence === 'number' &&
                  entry.confidence < prev.confidence) {
                continue;
              }

              const prevLabel = getCacheLabel(prev);
              const newLabel = getCacheLabel(entry);
              tabClassificationCache[pid][urlKey] = {
                ...(typeof prev === 'object' ? prev : {}),
                ...entry,
                hygieneScore: entry.hygieneScore !== undefined ? entry.hygieneScore : prev?.hygieneScore,
                secondaryLabel: entry.secondaryLabel !== undefined ? entry.secondaryLabel : prev?.secondaryLabel
              };

              if (pid === activePid && newLabel && newLabel !== prevLabel && openTabNormUrls.has(urlKey)) {
                hasRelevantChanges = true;
              }
            }
          }
        }

        if (hasRelevantChanges) {
          await renderStaticDashboard({ skipBackgroundAi: true, inMemoryOnly: true });
        }
      }
    }
  });
}

/* ----------------------------------------------------------------
   MODAL FORM SUBMISSIONS & KEYBOARD SHORTCUTS
   ---------------------------------------------------------------- */

if (typeof document !== 'undefined') {
  // Perspective creation / edit form
  document.getElementById('perspectiveForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('perspectiveEditId')?.value;
    const name = document.getElementById('perspectiveNameInput')?.value.trim();
    const rows = Array.from(document.querySelectorAll('#perspectiveTagsContainer .tag-row'));

    if (!name) {
      showToast('Vui lòng nhập tên Perspective');
      return;
    }

    const labels = [];
    const seenNames = new Set();
    for (const r of rows) {
      const tagName = r.querySelector('.tag-field-name')?.value.trim() || '';
      const tagDesc = r.querySelector('.tag-field-desc')?.value.trim() || '';
      const lower = tagName.toLowerCase();
      if (tagName && !seenNames.has(lower)) {
        seenNames.add(lower);
        labels.push({
          name: tagName,
          description: tagDesc || `Các trang web và nội dung liên quan đến ${tagName}`
        });
      }
    }

    if (labels.length === 0) {
      showToast('Vui lòng thêm ít nhất 1 tag');
      return;
    }

    if (editId) {
      const existing = currentPerspectives.find(p => p.id === editId);
      if (existing) {
        existing.name = name;
        existing.labels = labels;
      }
      if (tabClassificationCache[editId]) {
        delete tabClassificationCache[editId];
      }
      await chrome.storage.local.remove([`tabClassificationCache_${editId}`]);
    } else {
      const newId = 'p_' + Date.now().toString(36);
      currentPerspectives.push({
        id: newId,
        name,
        icon: 'folder',
        isSystem: false,
        labels
      });
      activePerspectiveId = newId;
    }

    isLocalSettingUpdate = true;
    await chrome.storage.local.set({
      perspectives: currentPerspectives,
      activePerspectiveId,
      tabClassificationCache
    });
    setTimeout(() => { isLocalSettingUpdate = false; }, 200);

    const overlay = document.getElementById('perspectiveModalOverlay');
    if (overlay) overlay.style.display = 'none';

    await renderStaticDashboard();
    showToast(editId ? 'Perspective đã được cập nhật' : 'Perspective đã được tạo & áp dụng');
  });

  // API Key configuration form
  document.getElementById('apiKeyForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = document.getElementById('apiKeyInput')?.value.trim() || '';
    openRouterApiKey = key;
    await chrome.storage.local.set({ openRouterApiKey: key });

    const overlay = document.getElementById('apiKeyModalOverlay');
    if (overlay) overlay.style.display = 'none';

    showToast(key ? 'OpenRouter API key saved' : 'Using smart local fallback');

    // Instantly upgrade all active tabs from local heuristic to Jev AI
    await renderStaticDashboard();
  });

  // Close modals with Escape key in stacked order (topmost first)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const cModal = document.getElementById('confirmModalOverlay');
      if (cModal && cModal.style.display !== 'none') {
        cModal.style.display = 'none';
        return;
      }
      const pModal = document.getElementById('perspectiveModalOverlay');
      if (pModal && pModal.style.display !== 'none') {
        pModal.style.display = 'none';
        return;
      }
      const aModal = document.getElementById('apiKeyModalOverlay');
      if (aModal && aModal.style.display !== 'none') {
        aModal.style.display = 'none';
        return;
      }
    }
  });

  // Close modals when clicking directly on overlay backdrop
  document.querySelectorAll('.perspective-modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.style.display = 'none';
      }
    });
  });

  // Enter key handling in dynamic tag inputs: smooth field progression instead of accidental submit
  document.getElementById('perspectiveTagsContainer')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.target.classList.contains('tag-field-name')) {
        const row = e.target.closest('.tag-row');
        const descInput = row?.querySelector('.tag-field-desc');
        if (descInput) descInput.focus();
      } else if (e.target.classList.contains('tag-field-desc')) {
        addTagRowToModal('', '', true);
      }
    }
  });

  // Keyboard navigation on perspective tabs in rail
  document.getElementById('perspectiveList')?.addEventListener('keydown', async (e) => {
    if (e.target.closest('.perspective-tab-edit-btn')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      const tab = e.target.closest('.perspective-tab');
      if (tab && tab.dataset.perspectiveId) {
        e.preventDefault();
        const pid = tab.dataset.perspectiveId;
        if (pid !== activePerspectiveId) {
          if (activeClassificationAbortController) {
            try { activeClassificationAbortController.abort(); } catch {}
            activeClassificationAbortController = null;
          }
          activePerspectiveId = pid;
          isLocalSettingUpdate = true;
          chrome.storage.local.set({ activePerspectiveId }).catch(() => {});
          setTimeout(() => { isLocalSettingUpdate = false; }, 200);
          await renderStaticDashboard({ inMemoryOnly: true });
        }
      }
    }
  });

  // Prewarm cache on pointer hover over perspective rail tabs
  let lastHoveredPrewarmPid = null;
  document.getElementById('perspectiveList')?.addEventListener('pointerover', (e) => {
    const tabEl = e.target.closest('.perspective-tab');
    if (tabEl && tabEl.dataset.perspectiveId) {
      const pid = tabEl.dataset.perspectiveId;
      if (pid !== activePerspectiveId && pid !== lastHoveredPrewarmPid) {
        lastHoveredPrewarmPid = pid;
        schedulePerspectivePrewarm(pid);
      }
    }
  });
  document.getElementById('perspectiveList')?.addEventListener('pointerleave', () => {
    lastHoveredPrewarmPid = null;
  });

  // Toast Undo button click handler
  document.getElementById('toastUndoBtn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await triggerUndo();
  });

  // Global Ctrl+Z / Cmd+Z shortcut for Undo
  document.addEventListener('keydown', async (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable) return;

      // Do not trigger undo if any modal dialog is currently open
      const confirmOverlay = document.getElementById('confirmModalOverlay');
      const perspectiveOverlay = document.getElementById('perspectiveModalOverlay');
      if ((confirmOverlay && confirmOverlay.style.display === 'flex') ||
          (perspectiveOverlay && perspectiveOverlay.style.display === 'flex')) {
        return;
      }

      if (undoStack.length > 0) {
        e.preventDefault();
        await triggerUndo();
      }
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
    await renderAll();
  }
}

if (typeof window !== 'undefined') {
  window.initDashboard = initDashboard;
}

if (typeof document !== 'undefined') {
  initDashboard();
}

// Export canonical modules for test suites in Node/Bun environment
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_PERSPECTIVES,
    CATEGORY_RULES,
    SYNONYM_MAP: typeof SYNONYM_MAP !== 'undefined' ? SYNONYM_MAP : {},
    getLabelName,
    getLabelDesc,
    normalizeLabels,
    createTagRowElement,
    localFallbackClassify,
    normalizeUrlForCache,
    pruneClassificationCache,
    getCacheLabel,
    getCacheSource,
    triggerBackgroundClassification,
    classifyTabs,
    renderStaticDashboard,
    loadPerspectiveSettings,
    showConfirmDialog,
    renderAll,
    undoStack,
    pushUndoAction,
    triggerUndo,
    getDomainFallbackLabel,
    schedulePerspectivePrewarm,
    initDashboard,
    MULTI_TOPIC_DOMAINS,
    extractHostname,
    saveClassificationCacheAtomic,
    prewarmMultiPerspective,
    buildOverflowChips,
    buildChoiceCriteria,
    HYGIENE_SCORE_CRITERIA
  };
}
