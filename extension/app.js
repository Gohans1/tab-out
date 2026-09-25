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

const DANGEROUS_KEYS = new Set([
  '__proto__', 'constructor', 'prototype',
  'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
  'propertyIsEnumerable', 'toLocaleString',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'
]);

function isDangerousKey(key) {
  if (typeof key !== 'string' || !key.trim()) return true;
  const trimmed = key.trim();
  return DANGEROUS_KEYS.has(trimmed) || trimmed in Object.prototype;
}

function stripUserInfoFallback(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const protoIdx = rawUrl.indexOf('://');
  if (protoIdx !== -1) {
    const withoutProto = rawUrl.slice(protoIdx + 3);
    const pathOrQueryIdx = withoutProto.search(/[\/?#]/);
    const authority = pathOrQueryIdx === -1 ? withoutProto : withoutProto.slice(0, pathOrQueryIdx);
    const atIdx = authority.lastIndexOf('@');
    if (atIdx !== -1) {
      const afterAuth = pathOrQueryIdx === -1 ? '' : withoutProto.slice(pathOrQueryIdx);
      return rawUrl.slice(0, protoIdx + 3) + authority.slice(atIdx + 1) + afterAuth;
    }
  }
  return rawUrl;
}

/**
 * stripCredentialsFromUrl(rawUrl)
 *
 * Strips HTTP Basic Auth username and password from URLs to prevent
 * leaking credentials in storage or DOM attributes.
 */
function stripCredentialsFromUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const u = new URL(rawUrl);
    if (!u.username && !u.password) return rawUrl;
    u.username = '';
    u.password = '';
    let res = u.toString();
    if (!rawUrl.endsWith('/') && res.endsWith('/')) {
      if (!rawUrl.includes(u.host + '/')) {
        res = res.slice(0, -1);
      }
    }
    return res;
  } catch {
    return stripUserInfoFallback(rawUrl);
  }
}

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
 * Validates URLs using standard URL parsing to ensure only safe web protocols
 * (http, https) are permitted in href, and strips any embedded credentials.
 */
function safeUrl(url) {
  if (!url) return '#';
  const trimmed = String(url).trim();
  try {
    const parsed = new URL(trimmed);
    if (['http:', 'https:'].includes(parsed.protocol)) {
      if (!parsed.username && !parsed.password) {
        return escapeHtml(trimmed);
      }
      return escapeHtml(stripCredentialsFromUrl(trimmed));
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
const faviconCache = new Map();

function getFaviconUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return '';
  if (faviconCache.has(trimmed)) return faviconCache.get(trimmed);
  try {
    let cleanUrl = '';
    try {
      const u = new URL(trimmed);
      u.username = '';
      u.password = '';
      u.search = '';
      u.hash = '';
      cleanUrl = u.toString();
    } catch {
      const split = trimmed.split('?')[0].split('#')[0];
      cleanUrl = stripUserInfoFallback(split);
    }
    let res = '';
    if (cleanUrl && typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      res = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(cleanUrl)}&size=16`);
    }
    if (faviconCache.size > 500) {
      const firstKey = faviconCache.keys().next().value;
      if (firstKey) faviconCache.delete(firstKey);
    }
    faviconCache.set(trimmed, res);
    return res;
  } catch {}
  return '';
}

// Clean image error fallback compliant with MV3 CSP (no inline onerror)
if (typeof document !== 'undefined') {
  document.addEventListener('error', (e) => {
    if (e.target && e.target.classList && (
      e.target.classList.contains('chip-favicon') ||
      e.target.classList.contains('recent-sidebar-favicon') ||
      e.target.classList.contains('quick-return-favicon')
    )) {
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

// Render cache: Track last-rendered HTML strings to prevent tearing down DOM nodes when data is unchanged
const renderCache = new Map();

function renderIfChanged(container, newHtml, cacheKey) {
  if (!container) return false;
  const prev = renderCache.get(cacheKey);
  if (prev === newHtml) return false;
  renderCache.set(cacheKey, newHtml);
  container.innerHTML = newHtml;
  return true;
}

function resetRenderCache(cacheKey) {
  if (cacheKey) renderCache.delete(cacheKey);
  else renderCache.clear();
}

// User interaction lock: Prevent background re-renders while the user is actively clicking
let isUserInteractingState = false;
let pendingInteractionSync = false;
let interactionSafetyTimeout = null;
let debouncedSyncRef = null;

function isUserInteracting() {
  return isUserInteractingState;
}

function releaseUserInteraction() {
  if (interactionSafetyTimeout) {
    clearTimeout(interactionSafetyTimeout);
    interactionSafetyTimeout = null;
  }
  if (isUserInteractingState) {
    isUserInteractingState = false;
    if (pendingInteractionSync) {
      pendingInteractionSync = false;
      if (typeof debouncedSyncRef === 'function') {
        debouncedSyncRef(100, false);
      }
    }
  }
}

function startUserInteraction(timeoutMs = 2000) {
  isUserInteractingState = true;
  if (interactionSafetyTimeout) clearTimeout(interactionSafetyTimeout);
  // Defensive auto-release after timeoutMs max to prevent deadlocking background sync if mouseup was swallowed
  interactionSafetyTimeout = setTimeout(() => {
    releaseUserInteraction();
  }, timeoutMs);
}

function setUserInteracting(val) {
  if (val) startUserInteraction();
  else releaseUserInteraction();
}

/**
 * areTabsEqual(a, b)
 *
 * Compares two tab arrays by identity and structure.
 * Compares top MRU tabs so tab switching correctly updates the dashboard,
 * while ignoring lastAccessed jitter when MRU rank order has not changed.
 */
function areTabsEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;

  // Check top recent (MRU) tabs rank order so changes in the last-active tab or recent sidebar
  // trigger re-render without spurious jitter on pure timestamp increments
  const recA = typeof getRecentTabs === 'function' ? getRecentTabs(a, { limit: 5 }) : [];
  const recB = typeof getRecentTabs === 'function' ? getRecentTabs(b, { limit: 5 }) : [];
  if (recA.length !== recB.length) return false;
  for (let i = 0; i < recA.length; i++) {
    if (recA[i]?.id !== recB[i]?.id) return false;
  }

  for (let i = 0; i < a.length; i++) {
    const tA = a[i];
    const tB = b[i];
    if (!tA || !tB) return false;
    if (tA.id !== tB.id ||
        tA.url !== tB.url ||
        tA.title !== tB.title ||
        tA.active !== tB.active ||
        tA.favIconUrl !== tB.favIconUrl ||
        tA.windowId !== tB.windowId) {
      return false;
    }
  }
  return true;
}

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
    openTabs = tabs.map(t => {
      const url = t.url || t.pendingUrl || '';
      return {
        id:           t.id,
        url,
        title:        t.title,
        windowId:     t.windowId,
        active:       t.active,
        favIconUrl:   t.favIconUrl,
        lastAccessed: typeof t.lastAccessed === 'number' ? t.lastAccessed : 0,
        openerTabId:  t.openerTabId,
        incognito:    Boolean(t.incognito),
        // Flag Tab Out's own pages so we can detect duplicate new tabs
        isTabOut:     url === newtabUrl || url === 'chrome://newtab/' || url === 'chrome://newtab' || (extensionId && typeof url === 'string' && url.startsWith(`chrome-extension://${extensionId}/`)),
      };
    });
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}


/**
 * focusTab(url, tabId)
 *
 * Switches Chrome to the tab with the given tabId or URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url, tabId) {
  if (tabId && typeof chrome !== 'undefined' && chrome.tabs?.update) {
    try {
      const updatedTab = await chrome.tabs.update(tabId, { active: true });
      const windowId = updatedTab?.windowId;
      if (windowId && chrome.windows?.update) {
        try {
          await chrome.windows.update(windowId, { focused: true });
        } catch {}
      }
      return;
    } catch {
      // Fallback to URL matching if tabId lookup fails (e.g. tab was closed)
    }
  }

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
  const match = matches.find(t => t.windowId === currentWindow?.id) || matches[0];
  try {
    await chrome.tabs.update(match.id, { active: true });
    if (match.windowId && chrome.windows?.update) {
      try {
        await chrome.windows.update(match.windowId, { focused: true });
      } catch {}
    }
  } catch {}
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
    let currentWindow = null;
    try {
      if (chrome.windows?.getCurrent) {
        currentWindow = await chrome.windows.getCurrent();
      }
    } catch {}
    const toClose = [];

    const tabsByUrl = new Map();
    for (const t of allTabs) {
      if (t && t.url) {
        let list = tabsByUrl.get(t.url);
        if (!list) {
          list = [];
          tabsByUrl.set(t.url, list);
        }
        list.push(t);
      }
    }

    for (const url of urls) {
      const matching = tabsByUrl.get(url);
      if (!matching || matching.length === 0) continue;
      if (keepOne) {
        const keep = matching.find(t => t.active && t.windowId === currentWindow?.id)
                  || matching.find(t => t.windowId === currentWindow?.id)
                  || matching.find(t => t.active)
                  || matching[0];
        for (const tab of matching) {
          if (tab && tab.id !== undefined && keep && tab.id !== keep.id) {
            toClose.push(tab.id);
          }
        }
      } else {
        for (const tab of matching) {
          if (tab && tab.id !== undefined) toClose.push(tab.id);
        }
      }
    }

    const uniqueToClose = Array.from(new Set(toClose));
    if (uniqueToClose.length > 0) {
      try {
        await chrome.tabs.remove(uniqueToClose);
      } catch {
        // Fall back to closing remaining tabs individually in case one tab was closed concurrently
        for (const id of uniqueToClose) {
          try { await chrome.tabs.remove(id); } catch {}
        }
      }
    }
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
    t.url === newtabUrl || t.url === 'chrome://newtab/' || t.url === 'chrome://newtab' || (extensionId && typeof t.url === 'string' && t.url.startsWith(`chrome-extension://${extensionId}/`))
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow?.id) ||
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
    let cleanList = Array.isArray(updated) ? updated : rawDeferred;

    // Prune archived items if they exceed reasonable bounds (keep all active, keep max 500 newest archived)
    if (cleanList.length > 500) {
      const active = cleanList.filter(t => t && !t.completed);
      const archived = cleanList.filter(t => t && Boolean(t.completed));
      if (archived.length > 500) {
        archived.sort((a, b) => {
          const timeA = Date.parse(a.completedAt || a.savedAt || 0) || 0;
          const timeB = Date.parse(b.completedAt || b.savedAt || 0) || 0;
          return timeB - timeA;
        });
        cleanList = [...active, ...archived.slice(0, 500)];
      }
    }

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
  if (!tab || !tab.url || !isRealTabUrl(tab.url)) return;
  const id = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString() + '-' + Math.random().toString(36).slice(2);
  const cleanUrl = stripCredentialsFromUrl(tab.url);
  const boundedTitle = typeof tab.title === 'string' ? tab.title.slice(0, 300) : (cleanUrl ? cleanUrl.slice(0, 300) : '');
  await mutateDeferred(deferred => {
    deferred.push({
      id,
      url:       cleanUrl,
      title:     boundedTitle,
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
    active:   visible.filter(t => t && !t.completed),
    archived: visible.filter(t => t && Boolean(t.completed)),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  await mutateDeferred(deferred => {
    const tab = deferred.find(t => t && t.id !== undefined && String(t.id) === String(id));
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
  let dismissedTab = null;
  await mutateDeferred(deferred => {
    dismissedTab = deferred.find(t => t && t.id !== undefined && String(t.id) === String(id)) || null;
    return deferred.filter(t => t && t.id !== undefined && String(t.id) !== String(id));
  });
  return dismissedTab;
}

/**
 * unarchiveSavedTab(id)
 *
 * Restores an archived tab back to active checklist (completed = false).
 */
async function unarchiveSavedTab(id) {
  let targetTab = null;
  await mutateDeferred(deferred => {
    const tab = deferred.find(t => t && t.id !== undefined && String(t.id) === String(id));
    if (tab) {
      targetTab = { ...tab };
      tab.completed = false;
      delete tab.completedAt;
    }
    return deferred;
  });
  return targetTab;
}

/**
 * deleteSavedTab(id)
 *
 * Permanently removes an archived tab from chrome.storage.local.
 */
async function deleteSavedTab(id) {
  let deletedTab = null;
  await mutateDeferred(deferred => {
    deletedTab = deferred.find(t => t && t.id !== undefined && String(t.id) === String(id)) || null;
    return deferred.filter(t => t && t.id !== undefined && String(t.id) !== String(id));
  });
  return deletedTab;
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

let isUndoing = false;

/**
 * triggerUndo()
 *
 * Executes the topmost action on the undo stack.
 */
async function triggerUndo() {
  if (isUndoing || undoStack.length === 0) return false;
  isUndoing = true;
  try {
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
  } finally {
    isUndoing = false;
  }
}

/**
 * showConfirmDialog({ title, description, confirmText, cancelText, danger })
 *
 * Renders a Vercel-style confirmation modal dialog for destructive operations.
 * Returns a Promise<boolean> that resolves to true if confirmed, false if cancelled.
 */
function showConfirmDialog({
  title = '',
  description = '',
  confirmText = '',
  cancelText = '',
  danger = true
} = {}) {
  const resolvedTitle = title || (typeof t === 'function' ? t('modal.confirm.title') : 'Confirm');
  const resolvedConfirmText = confirmText || (typeof t === 'function' ? t('modal.confirm.ok') : 'Confirm');
  const resolvedCancelText = cancelText || (typeof t === 'function' ? t('modal.confirm.cancel') : 'Cancel');

  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(true);
      return;
    }
    const overlay = document.getElementById('confirmModalOverlay');
    if (!overlay) {
      resolve(typeof window !== 'undefined' && window.confirm ? window.confirm(`${resolvedTitle}\n\n${description}`) : true);
      return;
    }
    if (overlay.style.display === 'flex') {
      resolve(false);
      return;
    }

    const previousActive = document.activeElement;
    const titleEl = document.getElementById('confirmModalTitle');
    const descEl = document.getElementById('confirmModalDesc');
    const okBtn = document.getElementById('confirmModalOkBtn');
    const cancelBtn = document.getElementById('confirmModalCancelBtn');
    const closeBtn = overlay.querySelector('.perspective-modal-close');

    if (titleEl) titleEl.textContent = resolvedTitle;
    if (descEl) descEl.textContent = description;
    if (okBtn) {
      okBtn.textContent = resolvedConfirmText;
      if (danger) {
        okBtn.className = 'btn-primary btn-danger';
      } else {
        okBtn.className = 'btn-primary';
      }
    }
    if (cancelBtn) cancelBtn.textContent = resolvedCancelText;

    let settled = false;

    let isMouseDownOnBackdrop = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      overlay.style.display = 'none';
      okBtn?.removeEventListener('click', onOk);
      cancelBtn?.removeEventListener('click', onCancel);
      closeBtn?.removeEventListener('click', onCancel);
      overlay.removeEventListener('mousedown', onMouseDown);
      overlay.removeEventListener('mouseup', onMouseUp);
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

    const onMouseDown = (e) => {
      isMouseDownOnBackdrop = (e.target === overlay);
    };

    const onMouseUp = (e) => {
      if (isMouseDownOnBackdrop && e.target === overlay) {
        onCancel(e);
      }
      isMouseDownOnBackdrop = false;
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel(e);
        return;
      }
      if (e.key === 'Tab') {
        const focusable = Array.from(overlay.querySelectorAll('button:not([disabled]), [tabindex]:not([tabindex="-1"])'));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!overlay.contains(document.activeElement)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
          return;
        }
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
    overlay.addEventListener('mousedown', onMouseDown);
    overlay.addEventListener('mouseup', onMouseUp);
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
      expandedDomains.delete(domain);
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
      const closeGroupText = typeof t === 'function' ? t('tabs.close_group', { count: remainingCount }) : `Close ${remainingCount} tabs`;
      closeBtn.innerHTML = `${ICONS.close} ${escapeHtml(closeGroupText)}`;
    } else if (remainingCount === 1) {
      const closeSingleText = typeof t === 'function' ? t('tabs.close_single_tab') : 'Close tab';
      closeBtn.innerHTML = `${ICONS.close} ${escapeHtml(closeSingleText)}`;
    } else {
      closeBtn.remove();
    }
  }

  // Update dedup button
  const dedupBtn = card.querySelector('.action-btn[data-action="dedup-keep-one"]:not(.removing)');
  if (dedupBtn) {
    if (remainingDupes > 0) {
      const closeDupesText = typeof t === 'function' ? t('tabs.close_dupes', { count: remainingDupes }) : `Close ${remainingDupes} duplicate${remainingDupes !== 1 ? 's' : ''}`;
      dedupBtn.textContent = closeDupesText;
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

  const emptyTitle = typeof t === 'function' ? t('tabs.all_closed_title') : 'All tabs closed';
  const emptyDesc = typeof t === 'function' ? t('tabs.all_closed_desc') : 'Clean workspace';
  const emptyHtml = `
    <div class="missions-empty-state">
      <div class="empty-title">${escapeHtml(emptyTitle)}</div>
      <div class="empty-subtitle">${escapeHtml(emptyDesc)}</div>
    </div>
  `;
  renderIfChanged(missionsEl, emptyHtml, 'missions');

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) {
    countEl.textContent = activePerspectiveId === 'domain'
      ? (typeof t === 'function' ? `0 ${t('tabs.domains_local_plural')}` : '0 domains · Local')
      : (typeof t === 'function' ? `0 ${t('tabs.categories_plural')}` : '0 categories');
  }

  renderOpenTabsHeaderActions([]);
  renderPerspectiveTagsBar([]);
  renderRecentSidebarCard();
  renderQuickReturnBar();
}

/**
 * renderOpenTabsHeaderActions(tabsList)
 *
 * Renders the right-hand header actions for the Open Tabs section:
 * 1. "Chỉnh sửa tags" button (when in custom semantic perspective)
 * 2. "Close all X tabs" button (when more than 1 real tab is open)
 * Automatically avoids innerHTML churn when HTML is unchanged.
 */
function renderOpenTabsHeaderActions(tabsList) {
  if (typeof document === 'undefined') return;
  const container = document.getElementById('openTabsHeaderActions');
  if (!container) return;

  const realTabs = Array.isArray(tabsList) ? tabsList : (typeof getRealTabs === 'function' ? getRealTabs() : []);
  const isDomainView = activePerspectiveId === 'domain';

  let actionsHtml = '';
  if (!isDomainView) {
    const editTagsText = typeof t === 'function' ? t('tabs.edit_tags') : 'Chỉnh sửa tags';
    actionsHtml += `<button type="button" class="perspective-edit-header-btn" data-action="edit-perspective" data-perspective-id="${escapeHtml(activePerspectiveId)}" title="${escapeHtml(editTagsText)}">${PERSPECTIVE_ICONS.edit}<span>${escapeHtml(editTagsText)}</span></button>`;
  }
  if (realTabs.length > 1) {
    const closeAllText = typeof t === 'function' ? t('tabs.close_all_count', { count: realTabs.length }) : `Close all ${realTabs.length} tabs`;
    actionsHtml += `<button class="action-btn close-tabs close-all-btn" data-action="close-all-open-tabs">${ICONS.close} ${escapeHtml(closeAllText)}</button>`;
  }

  renderIfChanged(container, actionsHtml, 'headerActions');
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
    if (typeof t === 'function') {
      const windowWord = winCount !== 1 ? t('common.window_plural') : t('common.window_single');
      heroSub.textContent = t('header.tabs_across_windows', {
        tabs: realTabs.length,
        windows: winCount,
        windowWord: windowWord
      });
    } else {
      heroSub.textContent = `${realTabs.length} tab${realTabs.length !== 1 ? 's' : ''} across ${winCount} window${winCount !== 1 ? 's' : ''}`;
    }
  }

  const missionsEl = document.getElementById('openTabsMissions');
  const countEl = document.getElementById('openTabsSectionCount');
  if (missionsEl && countEl) {
    const visibleCards = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
    const isDomain = activePerspectiveId === 'domain';
    const activeP = currentPerspectives.find(p => p.id === activePerspectiveId);
    const totalLabels = (!isDomain && activeP?.labels?.length) || 0;
    const unitLabel = isDomain
      ? (typeof t === 'function' ? (visibleCards !== 1 ? t('tabs.domains_local_plural') : t('tabs.domains_local_single')) : (visibleCards !== 1 ? 'domains · Local' : 'domain · Local'))
      : (totalLabels > 0
          ? (typeof t === 'function' ? t('tabs.categories_of', { visible: visibleCards, total: Math.max(totalLabels, visibleCards) }) : `${visibleCards} of ${Math.max(totalLabels, visibleCards)} categories`)
          : (typeof t === 'function' ? (visibleCards !== 1 ? t('tabs.categories_plural') : t('tabs.categories_single')) : (visibleCards !== 1 ? 'categories' : 'category')));
    countEl.textContent = isDomain || totalLabels === 0
      ? `${visibleCards} ${unitLabel}`
      : unitLabel;
  }
  const recentTabs = getRecentTabs(realTabs, { limit: 5 });
  renderPerspectiveTagsBar(domainGroups);
  renderPerspectiveRail(realTabs);
  renderRecentSidebarCard(recentTabs);
  renderQuickReturnBar(recentTabs);

  renderOpenTabsHeaderActions(realTabs);

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
  if (typeof TabOutI18n !== 'undefined' && typeof TabOutI18n.formatRelativeTime === 'function') {
    const formatted = TabOutI18n.formatRelativeTime(dateStr);
    if (formatted) return formatted;
  }
  const then = new Date(dateStr);
  if (isNaN(then.getTime())) return '';
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return typeof t === 'function' ? t('relative_time.just_now') : 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return typeof t === 'function' ? t('relative_time.yesterday') : 'yesterday';
  return diffDays + ' days ago';
}


/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  if (typeof TabOutI18n !== 'undefined' && typeof TabOutI18n.formatDate === 'function') {
    return TabOutI18n.formatDate(new Date(), {
      weekday: 'long',
      year:    'numeric',
      month:   'long',
      day:     'numeric',
    });
  }
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
  if (!url) return (title || '').replace(/\/+$/, '');
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return (title || '').replace(/\/+$/, ''); }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title.replace(/\/+$/, '');
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') {
        const filePath = rest.slice(2).join('/');
        return filePath ? `${owner}/${repo} / ${filePath}` : (rest[1] ? `${owner}/${repo} (${rest[1]})` : `${owner}/${repo}`);
      }
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

  return (title || url).replace(/\/+$/, '');
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
  'alert-circle': `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>`,
  folder: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" /></svg>`,
  edit: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" /></svg>`
};

/* Curated Vercel Dark Mode Tag Palette */
const TAG_PALETTE = {
  cyan:    { id: 'cyan',    name: 'Cyan',    hex: '#06b6d4', bgTint: 'rgba(6, 182, 212, 0.08)',  borderTint: 'rgba(6, 182, 212, 0.35)' },
  purple:  { id: 'purple',  name: 'Purple',  hex: '#a855f7', bgTint: 'rgba(168, 85, 247, 0.08)', borderTint: 'rgba(168, 85, 247, 0.35)' },
  emerald: { id: 'emerald', name: 'Emerald', hex: '#10b981', bgTint: 'rgba(16, 185, 129, 0.08)', borderTint: 'rgba(16, 185, 129, 0.35)' },
  amber:   { id: 'amber',   name: 'Amber',   hex: '#f59e0b', bgTint: 'rgba(245, 158, 11, 0.08)', borderTint: 'rgba(245, 158, 11, 0.35)' },
  rose:    { id: 'rose',    name: 'Rose',    hex: '#f43f5e', bgTint: 'rgba(244, 63, 94, 0.08)',  borderTint: 'rgba(244, 63, 94, 0.35)' },
  blue:    { id: 'blue',    name: 'Blue',    hex: '#3b82f6', bgTint: 'rgba(59, 130, 246, 0.08)', borderTint: 'rgba(59, 130, 246, 0.35)' }
};

function resolveTagColor(color) {
  if (!color || typeof color !== 'string') return null;
  const trimmed = color.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(TAG_PALETTE, trimmed)) return TAG_PALETTE[trimmed];
  for (const k of Object.keys(TAG_PALETTE)) {
    if (TAG_PALETTE[k].hex.toLowerCase() === trimmed) return TAG_PALETTE[k];
  }
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(trimmed)) {
    return { id: 'custom', name: 'Custom', hex: trimmed, bgTint: 'rgba(255, 255, 255, 0.05)', borderTint: 'rgba(255, 255, 255, 0.25)' };
  }
  return null;
}

/* Helper functions for perspective label structures */
function getLabelName(l) {
  if (!l) return '';
  return typeof l === 'string' ? l : (l.name || '');
}

function getLabelDesc(l) {
  if (!l || typeof l === 'string') return '';
  return l.description || '';
}

function getLabelColor(l) {
  if (!l || typeof l === 'string') return '';
  return typeof l.color === 'string' ? l.color.trim() : '';
}

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) return [];
  return labels.map(l => {
    if (!l) return null;
    if (typeof l === 'string') {
      return {
        name: l,
        description: '',
        color: ''
      };
    }
    return {
      name: (typeof l.name === 'string' ? l.name : '') || '',
      description: typeof l.description === 'string' ? l.description : '',
      color: typeof l.color === 'string' ? l.color.trim() : ''
    };
  }).filter(l => l && typeof l.name === 'string' && l.name.trim().length > 0 && !isDangerousKey(l.name.trim()));
}

const FALLBACK_TAG_REGEX = /^(khác|other|misc|linh tinh|chưa phân loại)(\s*[\/\(\-]\s*(chưa phân loại|unclassified|other|khác|misc|tổng hợp)\)?)?$/iu;

function isFallbackLabel(name) {
  if (!name || typeof name !== 'string') return false;
  return FALLBACK_TAG_REGEX.test(name.trim());
}

function buildChoiceCriteria(perspective) {
  const criteria = Object.create(null);
  if (!perspective || !Array.isArray(perspective.labels)) return criteria;
  let hasOther = false;
  for (const item of perspective.labels) {
    const name = getLabelName(item);
    if (!name || isDangerousKey(name)) continue;
    if (isFallbackLabel(name)) hasOther = true;
    const desc = getLabelDesc(item);
    const safeName = typeof name === 'string' ? name.slice(0, 50) : '';
    if (item && typeof item === 'object' && item.rubric && typeof item.rubric === 'object') {
      criteria[safeName] = item.rubric;
    } else {
      const safeDesc = typeof desc === 'string' ? desc.slice(0, 300) : '';
      criteria[safeName] = safeDesc || safeName;
    }
  }
  if (!hasOther) {
    criteria['Khác'] = 'Khác';
  }
  if (Object.keys(criteria).length < 2) {
    criteria['Chung'] = 'Chung';
  }
  return criteria;
}

function createTagRowElement(name = '', description = '', color = '') {
  if (typeof document === 'undefined') return null;
  const row = document.createElement('div');
  row.className = 'tag-row';
  row.setAttribute('data-tag-name', name);
  row.setAttribute('data-tag-color', color || '');

  const resolved = resolveTagColor(color);
  const colorHex = resolved ? resolved.hex : '';
  const dotIndicatorClass = resolved ? 'tag-color-dot-indicator' : 'tag-color-dot-indicator none';
  const dotIndicatorStyle = colorHex ? `style="background-color: ${escapeHtml(colorHex)}; border-color: ${escapeHtml(colorHex)};"` : '';

  const activeKey = resolved ? resolved.id : '';
  const noneSwatchTitle = typeof t === 'function' ? t('modal.perspective.swatch_none') : 'Default (no color)';
  const dragAriaLabel = typeof t === 'function' ? t('modal.perspective.drag_tag') : 'Drag or use arrow keys to reorder';
  const colorBtnLabel = typeof t === 'function' ? t('modal.perspective.tag_color') : 'Select tag color';
  const namePlaceholder = typeof t === 'function' ? t('modal.perspective.tag_name_placeholder') : 'Tag name (e.g. Work, Research)';
  const descPlaceholder = typeof t === 'function' ? t('modal.perspective.tag_instruct_placeholder') : 'Description / AI prompt instructions (optional)';
  const deleteTagLabel = typeof t === 'function' ? t('modal.perspective.delete_tag') : 'Delete tag';

  const swatchesHtml = [
    `<button type="button" class="tag-color-swatch none-swatch${!resolved ? ' active' : ''}" data-color="" title="${escapeHtml(noneSwatchTitle)}" aria-label="${escapeHtml(noneSwatchTitle)}" role="menuitemradio" aria-checked="${!resolved ? 'true' : 'false'}"></button>`,
    `<button type="button" class="tag-color-swatch${activeKey === 'cyan' ? ' active' : ''}" data-color="cyan" style="background-color: #06b6d4;" title="Cyan" aria-label="Cyan" role="menuitemradio" aria-checked="${activeKey === 'cyan' ? 'true' : 'false'}"></button>`,
    `<button type="button" class="tag-color-swatch${activeKey === 'purple' ? ' active' : ''}" data-color="purple" style="background-color: #a855f7;" title="Purple" aria-label="Purple" role="menuitemradio" aria-checked="${activeKey === 'purple' ? 'true' : 'false'}"></button>`,
    `<button type="button" class="tag-color-swatch${activeKey === 'emerald' ? ' active' : ''}" data-color="emerald" style="background-color: #10b981;" title="Emerald" aria-label="Emerald" role="menuitemradio" aria-checked="${activeKey === 'emerald' ? 'true' : 'false'}"></button>`,
    `<button type="button" class="tag-color-swatch${activeKey === 'amber' ? ' active' : ''}" data-color="amber" style="background-color: #f59e0b;" title="Amber" aria-label="Amber" role="menuitemradio" aria-checked="${activeKey === 'amber' ? 'true' : 'false'}"></button>`,
    `<button type="button" class="tag-color-swatch${activeKey === 'rose' ? ' active' : ''}" data-color="rose" style="background-color: #f43f5e;" title="Rose" aria-label="Rose" role="menuitemradio" aria-checked="${activeKey === 'rose' ? 'true' : 'false'}"></button>`,
    `<button type="button" class="tag-color-swatch${activeKey === 'blue' ? ' active' : ''}" data-color="blue" style="background-color: #3b82f6;" title="Blue" aria-label="Blue" role="menuitemradio" aria-checked="${activeKey === 'blue' ? 'true' : 'false'}"></button>`
  ].join('');

  row.innerHTML = `
    <button type="button" class="tag-drag-handle" data-variant="tertiary" aria-label="${escapeHtml(dragAriaLabel)}" title="${escapeHtml(dragAriaLabel)}">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="8" cy="4" r="2"/>
        <circle cx="8" cy="12" r="2"/>
        <circle cx="8" cy="20" r="2"/>
        <circle cx="16" cy="4" r="2"/>
        <circle cx="16" cy="12" r="2"/>
        <circle cx="16" cy="20" r="2"/>
      </svg>
    </button>
    <div class="tag-color-picker-wrap">
      <button type="button" class="tag-color-btn" data-action="toggle-tag-color-picker" aria-haspopup="true" aria-expanded="false" aria-label="${escapeHtml(colorBtnLabel)}" title="${escapeHtml(colorBtnLabel)}">
        <span class="${dotIndicatorClass}" ${dotIndicatorStyle}></span>
      </button>
      <div class="tag-color-popover" style="display: none;" role="menu" aria-label="${escapeHtml(colorBtnLabel)}">
        ${swatchesHtml}
      </div>
    </div>
    <div class="tag-row-inputs">
      <input type="text" class="form-input tag-field-name" placeholder="${escapeHtml(namePlaceholder)}" value="${escapeHtml(name)}" aria-label="${escapeHtml(namePlaceholder)}" autocomplete="off" maxlength="50">
      <textarea class="form-input tag-field-desc" placeholder="${escapeHtml(descPlaceholder)}" aria-label="${escapeHtml(descPlaceholder)}" title="${escapeHtml(description)}" autocomplete="off" rows="1" maxlength="300">${escapeHtml(description)}</textarea>
    </div>
    <button type="button" class="tag-row-del-btn" data-variant="tertiary" data-action="remove-tag-row" aria-label="${escapeHtml(deleteTagLabel)}" title="${escapeHtml(deleteTagLabel)}">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M6 18 18 6M6 6l12 12" />
      </svg>
    </button>
  `;

  // Enable dragging row via handle
  const handle = row.querySelector('.tag-drag-handle');
  if (handle) {
    handle.addEventListener('mousedown', () => {
      row.setAttribute('draggable', 'true');
    });
    handle.addEventListener('mouseup', () => {
      row.removeAttribute('draggable');
    });
    handle.addEventListener('mouseleave', () => {
      if (!row.classList.contains('is-dragging')) {
        row.removeAttribute('draggable');
      }
    });
    // Keyboard accessibility: ArrowUp / ArrowDown to move row
    handle.addEventListener('keydown', (e) => {
      const container = row.parentElement;
      if (!container) return;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = row.previousElementSibling;
        if (prev && prev.classList.contains('tag-row')) {
          container.insertBefore(row, prev);
          handle.focus();
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = row.nextElementSibling;
        if (next && next.classList.contains('tag-row')) {
          container.insertBefore(next, row);
          handle.focus();
        }
      }
    });
  }

  return row;
}

function autoResizeTagDesc(textarea) {
  if (!textarea || typeof textarea.scrollHeight !== 'number') return;
  const targetHeight = Math.min(Math.max(textarea.scrollHeight, 76), 220);
  textarea.style.height = `${targetHeight}px`;
}

function addTagRowToModal(name = '', description = '', focus = false, color = '') {
  if (typeof document === 'undefined') return null;
  const container = document.getElementById('perspectiveTagsContainer');
  if (!container) return null;
  const row = createTagRowElement(name, description, color);
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
  }
];

const PERSPECTIVE_TEMPLATES = {
  topic: {
    id: 'topic',
    icon: 'tag',
    en: {
      name: 'Topic',
      labels: [
        { name: 'Work & Productivity', description: 'Office apps, docs, spreadsheets, project management, email, meetings, calendars', color: 'blue' },
        { name: 'Education & Study', description: 'Coursework, LMS portals, university resources, academic papers, research articles, textbooks, tutorials', color: 'amber' },
        { name: 'Development', description: 'Source code, git repos, developer documentation, APIs, cloud consoles, dev tools, debugging', color: 'emerald' },
        { name: 'AI & Assistants', description: 'AI chatbots, LLM tools, prompt generators, generative media, AI search engines', color: 'purple' },
        { name: 'News & Reading', description: 'News outlets, journalism, industry blogs, newsletters, editorials, long-form reading', color: 'amber' },
        { name: 'Social Media', description: 'Social feeds, community discussion, messaging, microblogs, profile browsing', color: 'blue' },
        { name: 'Media & Entertainment', description: 'Video streaming, music, movies, gaming, anime, comics, creative hobbies', color: 'rose' },
        { name: 'Shopping & Finance', description: 'E-commerce, online marketplaces, banking, investments, price tracking, receipts', color: 'cyan' },
        { name: 'Other', description: 'Miscellaneous or uncategorized content', color: '' }
      ]
    },
    vi: {
      name: 'Chủ đề',
      labels: [
        { name: 'Công việc & Năng suất', description: 'Ứng dụng văn phòng, tài liệu, bảng tính, quản lý dự án, email, lịch họp', color: 'blue' },
        { name: 'Giáo dục & Học tập', description: 'Bài giảng, portal trường học (LMS), tài liệu học tập, nghiên cứu học thuật, sách giáo trình', color: 'amber' },
        { name: 'Lập trình / Dev', description: 'Mã nguồn, kho git, tài liệu kỹ thuật, API, console đám mây, công cụ lập trình', color: 'emerald' },
        { name: 'AI & Trợ lý ảo', description: 'Trợ lý AI, chatbot LLM, công cụ sinh ảnh/chữ, công cụ tìm kiếm bằng AI', color: 'purple' },
        { name: 'Tin tức & Đọc báo', description: 'Báo chí, tạp chí, bản tin email, bài phân tích chuyên sâu', color: 'amber' },
        { name: 'Mạng xã hội', description: 'Bảng tin xã hội, diễn đàn cộng đồng, nhắn tin, theo dõi cập nhật', color: 'blue' },
        { name: 'Giải trí / Media', description: 'Xem video, nghe nhạc, phim ảnh, trò chơi, truyện tranh, sở thích', color: 'rose' },
        { name: 'Mua sắm & Tài chính', description: 'Sàn thương mại điện tử, cửa hàng online, ngân hàng, đầu tư, theo dõi đơn hàng', color: 'cyan' },
        { name: 'Khác', description: 'Nội dung khác hoặc chưa phân loại', color: '' }
      ]
    }
  },
  purpose: {
    id: 'purpose',
    icon: 'target',
    en: {
      name: 'Purpose',
      labels: [
        { name: 'Focus Work', description: 'Active creation, authoring documents, coding, executing tasks, solving problems', color: 'blue' },
        { name: 'Study & Learning', description: 'Exam preparation, reading lecture notes, academic research, studying course materials', color: 'amber' },
        { name: 'Reference & Reading', description: 'Documentation lookups, reading articles, API specs, background guides', color: 'emerald' },
        { name: 'Communication', description: 'Messaging, emails, meetings, social networking, team coordination', color: 'purple' },
        { name: 'Quick Lookup', description: 'Ephemeral searches, price checks, fact checking, quick queries', color: 'cyan' },
        { name: 'Other', description: 'Uncategorized or miscellaneous intent', color: '' }
      ]
    },
    vi: {
      name: 'Mục đích',
      labels: [
        { name: 'Làm việc tập trung', description: 'Xử lý công việc chính, viết tài liệu, code, hoàn thành nhiệm vụ', color: 'blue' },
        { name: 'Học tập & Nghiên cứu', description: 'Học bài, nghiên cứu đề tài, đọc tài liệu khóa học, ôn thi', color: 'amber' },
        { name: 'Tham khảo & Đọc', description: 'Tra cứu tài liệu, đọc bài blog, xem hướng dẫn kỹ thuật', color: 'emerald' },
        { name: 'Giao tiếp & Trao đổi', description: 'Nhắn tin, trả lời email, họp hành, thảo luận công việc', color: 'purple' },
        { name: 'Tra cứu nhanh', description: 'Tìm kiếm lướt qua, kiểm tra giá, xem nhanh thông tin ngắn hạn', color: 'cyan' },
        { name: 'Khác', description: 'Mục đích khác hoặc chưa phân loại', color: '' }
      ]
    }
  },
  priority: {
    id: 'priority',
    icon: 'alert-circle',
    en: {
      name: 'Priority',
      labels: [
        { name: 'Urgent / Immediate', description: 'Urgent tasks, active meetings, hot production issues, unsubmitted forms', color: 'rose' },
        { name: 'Important / Today', description: 'Primary work tasks for today, active documents, in-progress research', color: 'amber' },
        { name: 'Backlog / Read Later', description: 'Articles, tutorials, technical blogs, videos saved for later reference', color: 'blue' },
        { name: 'Disposable / Can Close', description: 'Search queries, completed downloads, temporary redirects, auth logins', color: 'cyan' },
        { name: 'Other', description: '', color: '' }
      ]
    },
    vi: {
      name: 'Ưu tiên',
      labels: [
        { name: 'Khẩn cấp / Làm ngay', description: 'Việc gấp, sự cố production, form đang điền, tài liệu họp', color: 'rose' },
        { name: 'Quan trọng trong ngày', description: 'Công việc chính hôm nay, tài liệu đang soạn thảo, nghiên cứu dở', color: 'amber' },
        { name: 'Đọc sau / Backlog', description: 'Bài blog kỹ thuật, bài hướng dẫn, video tham khảo khi rảnh', color: 'blue' },
        { name: 'Có thể đóng luôn', description: 'Kết quả tìm kiếm, tải xong, trang tạm thời hoặc xác thực xong', color: 'cyan' },
        { name: 'Khác', description: '', color: '' }
      ]
    }
  }
};

function getPerspectiveTemplate(templateId, lang = 'en') {
  const tpl = PERSPECTIVE_TEMPLATES[templateId];
  if (!tpl) return null;
  const langKey = lang === 'vi' ? 'vi' : 'en';
  const localized = tpl[langKey] || tpl.en;
  return {
    id: tpl.id,
    icon: tpl.icon,
    isSystem: false,
    name: localized.name,
    labels: (localized.labels || []).map(l => ({ ...l }))
  };
}

const CATEGORY_RULES = [
  {
    category: 'ai',
    domains: ['aistudio.google.com', 'chatgpt.com', 'claude.ai', 'anthropic.com', 'openai.com', 'huggingface.co', 'grok.com', 'x.ai', 'kimi.moonshot.cn', 'deepseek.com', 'perplexity.ai', 'replicate.com'],
    keywords: ['ai', 'artificial intelligence', 'machine learning', 'deep learning', 'gemini', 'chatgpt', 'claude', 'anthropic', 'openai', 'llm', 'prompt', 'grok', 'kimi', 'deepseek', 'copilot', 'assistant', 'assistants', 'trợ lý ảo']
  },
  {
    category: 'dev',
    domains: ['github.com', 'gist.github.com', 'gitlab.com', 'stackoverflow.com', 'npm.im', 'npmjs.com', 'crates.io', 'developer.mozilla.org', 'w3schools.com'],
    keywords: ['github', 'gitlab', 'gist', 'code', 'commit', 'pull request', 'react', 'vue', 'angular', 'bun', 'node', 'typescript', 'javascript', 'python', 'rust', 'golang', 'docker', 'api', 'dev', 'sdk', 'bug', 'fix', 'refactor', 'repo', 'lập trình', 'docs', 'documentation']
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
    domains: ['shopee.vn', 'shopee.com', 'lazada.vn', 'amazon.com', 'ebay.com', 'tiki.vn', 'aliexpress.com', 'stripe.com', 'paypal.com', 'binance.com', 'coinbase.com'],
    keywords: ['shopping', 'mua sắm', 'cart', 'checkout', 'price', 'giá', 'order', 'deal', 'store', 'finance', 'tài chính', 'bank', 'banking', 'ngân hàng', 'crypto']
  },
  {
    category: 'work',
    domains: ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'slack.com', 'jira.atlassian.com', 'linear.app', 'notion.so', 'docs.google.com', 'sheets.google.com', 'meet.google.com', 'zoom.us', 'teams.microsoft.com', 'trello.com', 'asana.com', 'figma.com'],
    keywords: ['mail', 'email', 'inbox', 'meeting', 'calendar', 'công việc', 'task', 'project', 'work', 'productivity', 'năng suất', 'office', 'workspace']
  },
  {
    category: 'education',
    domains: ['wikipedia.org', 'arxiv.org', 'scholar.google.com', 'canvas.net', 'instructure.com', 'blackboard.com', 'moodle.org', 'coursera.org', 'edx.org', 'overleaf.com', 'jstor.org', 'quizlet.com', 'researchgate.net'],
    keywords: ['docs', 'documentation', 'guide', 'tutorial', 'wiki', 'paper', 'research', 'nghiên cứu', 'tài liệu', 'education', 'study', 'học tập', 'giáo dục', 'lecture', 'assignment', 'course', 'university', 'academic', 'lms']
  }
];

function cloneDefaultPerspectives() {
  return DEFAULT_PERSPECTIVES.map(p => ({
    ...p,
    labels: Array.isArray(p.labels) ? p.labels.map(l => (typeof l === 'object' && l ? { ...l } : l)) : []
  }));
}

DEFAULT_PERSPECTIVES.forEach(p => {
  if (Array.isArray(p.labels)) {
    p.labels.forEach(l => { if (typeof l === 'object' && l) Object.freeze(l); });
    Object.freeze(p.labels);
  }
  Object.freeze(p);
});
Object.freeze(DEFAULT_PERSPECTIVES);

let currentPerspectives = cloneDefaultPerspectives();
let activePerspectiveId = 'domain';
let isLocalSettingUpdate = false;
let localSettingUpdateTimeout = null;
let pendingSettingsReload = false;
let pendingSync = false;
let pendingFullSync = false;

function setLocalSettingLock(duration = 400) {
  isLocalSettingUpdate = true;
  clearTimeout(localSettingUpdateTimeout);
  localSettingUpdateTimeout = setTimeout(async () => {
    isLocalSettingUpdate = false;
    if (pendingSettingsReload) {
      pendingSettingsReload = false;
      try {
        await loadPerspectiveSettings(true);
        await renderStaticDashboard();
      } catch (err) {
        console.warn('[tab-out] Failed to reload settings during unlock:', err);
      }
    }
    if (pendingSync && typeof window !== 'undefined' && typeof window.__tabOutPerformSync === 'function') {
      const full = pendingFullSync;
      pendingSync = false;
      pendingFullSync = false;
      window.__tabOutPerformSync(full);
    }
  }, duration);
}
const getLocalKey = () => (typeof window !== 'undefined' && typeof window.LOCAL_OPENROUTER_KEY === 'string' ? window.LOCAL_OPENROUTER_KEY.trim().replace(/[^\x21-\x7E]/g, '') : '') || '';
let openRouterApiKey = getLocalKey();
let aiAuthBlocked = false;
let tabClassificationCache = {};
let isPerspectivesLoaded = false;

function isJevActive() {
  return Boolean(openRouterApiKey && !aiAuthBlocked);
}

async function loadPerspectiveSettings(force = false) {
  if (isPerspectivesLoaded && !force) return;
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  try {
    const res = await chrome.storage.local.get(['perspectives', 'activePerspectiveId', 'openRouterApiKey', 'classifierApiKey', 'aiAuthBlocked', 'lastBlockedApiKey']);
    if (res.perspectives && Array.isArray(res.perspectives) && res.perspectives.length > 0) {
      let needsStorageSync = false;
      currentPerspectives = res.perspectives
        .filter(p => p && typeof p === 'object' && p.id && !isDangerousKey(p.id))
        .map(p => {
          let labels = normalizeLabels(p.labels);
          if (!p.isSystem && labels.length > 0) {
            const userLabels = labels.filter(l => !isFallbackLabel(l.name));
            if (!labels.some(l => isFallbackLabel(l.name)) || labels.some(l => isFallbackLabel(l.name) && l.name !== 'Khác')) {
              needsStorageSync = true;
            }
            labels = [...userLabels, { name: 'Khác', description: '', color: '' }];
          }
          return {
            ...p,
            labels
          };
        });
      if (needsStorageSync && typeof chrome !== 'undefined' && chrome.storage?.local?.set) {
        setLocalSettingLock(400);
        enqueueStorageWrite(() => chrome.storage.local.set({ perspectives: currentPerspectives })).catch(() => {});
      }
    }
    if (res.activePerspectiveId && !isLocalSettingUpdate && !isDangerousKey(res.activePerspectiveId) && currentPerspectives.some(p => p.id === res.activePerspectiveId)) {
      activePerspectiveId = res.activePerspectiveId;
    } else if (!currentPerspectives.some(p => p.id === activePerspectiveId)) {
      activePerspectiveId = 'domain';
    }
    const localKey = (getLocalKey() || '').trim().replace(/[^\x21-\x7E]/g, '');
    const hasStoredKeySetting = res.openRouterApiKey !== undefined || res.classifierApiKey !== undefined;
    const storedKey = ((res.openRouterApiKey !== undefined ? res.openRouterApiKey : res.classifierApiKey) || '').trim().replace(/[^\x21-\x7E]/g, '');

    if (storedKey) {
      openRouterApiKey = storedKey;
    } else if (!hasStoredKeySetting && localKey) {
      openRouterApiKey = localKey;
      enqueueStorageWrite(() => chrome.storage.local.set({
        openRouterApiKey: localKey,
        classifierApiKey: localKey
      })).catch(() => {});
    } else {
      openRouterApiKey = '';
    }

    if (res.lastBlockedApiKey && openRouterApiKey && openRouterApiKey !== res.lastBlockedApiKey) {
      aiAuthBlocked = false;
      enqueueStorageWrite(() => chrome.storage.local.set({ aiAuthBlocked: false, lastBlockedApiKey: null })).catch(() => {});
    } else {
      aiAuthBlocked = res.aiAuthBlocked === true;
    }
    if (!isJevActive() && activePerspectiveId !== 'domain') {
      activePerspectiveId = 'domain';
    }
    tabClassificationCache = {};
    // Load partitioned perspective caches, lazily falling back to monolithic cache only if partition missing
    if (currentPerspectives && Array.isArray(currentPerspectives)) {
      const partKeys = currentPerspectives.map(p => `tabClassificationCache_${p.id}`);
      const partRes = await chrome.storage.local.get(partKeys);
      let fallbackMonolithic = null;
      for (const p of currentPerspectives) {
        if (!p || !p.id || isDangerousKey(p.id)) continue;
        const pKey = `tabClassificationCache_${p.id}`;
        let rawPartition = null;
        if (partRes[pKey] && typeof partRes[pKey] === 'object' && !Array.isArray(partRes[pKey])) {
          rawPartition = partRes[pKey];
        } else {
          if (!fallbackMonolithic) {
            const monoRes = await chrome.storage.local.get(['tabClassificationCache']);
            fallbackMonolithic = (monoRes && typeof monoRes.tabClassificationCache === 'object' && !Array.isArray(monoRes.tabClassificationCache)) ? monoRes.tabClassificationCache : {};
          }
          if (fallbackMonolithic && typeof fallbackMonolithic[p.id] === 'object' && !Array.isArray(fallbackMonolithic[p.id])) {
            rawPartition = fallbackMonolithic[p.id];
          }
        }
        const cleanPartition = {};
        if (rawPartition) {
          for (const [k, v] of Object.entries(rawPartition)) {
            if (!isDangerousKey(k) && v && typeof v === 'object' && !Array.isArray(v)) {
              cleanPartition[k] = v;
            }
          }
        }
        tabClassificationCache[p.id] = cleanPartition;
      }
    }
    isPerspectivesLoaded = true;

    // Update telemetry dot in sidebar rail
    updatePerspectiveTelemetry();
  } catch (err) {
    console.warn('[tab-out] Failed to load perspective settings:', err);
  }
}

/**
 * updatePerspectiveTelemetry()
 *
 * Synchronizes the sidebar telemetry status with the active perspective.
 * When in Domain view, shows 'Local rules' with neutral dot and local tooltip.
 * When in a Semantic view, shows 'OpenRouter (Jev)' or 'Auth Blocked' or 'Smart Local'.
 */
function updatePerspectiveTelemetry() {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
  const container = document.getElementById('telemetryAiStatus');
  const dot = (container && typeof container.querySelector === 'function') ? container.querySelector('.telemetry-dot') : document.querySelector('.telemetry-dot');
  const aiLabel = (container && typeof container.querySelector === 'function') ? container.querySelector('.telemetry-label') : document.querySelector('.telemetry-label');
  if (!dot || !aiLabel) return;

  if (aiAuthBlocked) {
    dot.className = 'telemetry-dot auth-blocked';
    aiLabel.textContent = typeof t === 'function' ? t('telemetry.status_auth_error_label') : 'API Key Issue';
    if (container) container.title = typeof t === 'function' ? t('telemetry.status_auth_error') : 'OpenRouter API key invalid or restricted';
  } else if (openRouterApiKey) {
    dot.className = 'telemetry-dot ready';
    aiLabel.textContent = 'OpenRouter (Jev)';
    if (container) container.title = typeof t === 'function' ? t('telemetry.status_openrouter') : 'AI classification active (Model Jev)';
  } else {
    dot.className = 'telemetry-dot inactive';
    aiLabel.textContent = typeof t === 'function' ? t('telemetry.status_inactive') : 'AI Inactive';
    if (container) container.title = typeof t === 'function' ? t('telemetry.status_inactive_tooltip') : 'OpenRouter API key required to activate AI perspectives';
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
  if (!tab || !labels || labels.length === 0) return 'Khác';

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

  const tokenizedLabels = labelObjects.map(labelObj => {
    const label = labelObj.name;
    const lLower = label.toLowerCase();
    const descLower = (labelObj.description || '').toLowerCase();
    return {
      name: label,
      isFallback: isFallbackLabel(label),
      lLower,
      descLower,
      labelTokens: lLower.split(/[\s/,&+-]+/).filter(Boolean),
      descTokens: descLower ? descLower.split(/[\s/,&+.,;:()_-]+/).filter(t => t.length > 2) : []
    };
  });

  for (const item of tokenizedLabels) {
    if (item.isFallback) continue;
    const { name: label, lLower, descTokens, labelTokens } = item;
    let score = 0;

    // Direct match against category rules
    for (const [cat, weight] of Object.entries(categoryWeights)) {
      const catRule = CATEGORY_RULES.find(r => r.category === cat);
      if (catRule) {
        const catMatches = lLower.includes(cat) || catRule.keywords.some(kw => {
          if (kw.length <= 2) {
            const rx = SHORT_KW_REGEX.get(kw) || new RegExp(`(^|[^a-z0-9])${kw}([^a-z0-9]|$)`, 'i');
            return rx.test(lLower);
          }
          return lLower.includes(kw);
        });
        if (catMatches) {
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
    for (const token of labelTokens) {
      if (token.length > 1 && fullText.includes(token)) {
        score += 3;
      }
    }

    // Custom user description tokens (boost matching based on user instructions for AI)
    for (const token of descTokens) {
      if (fullText.includes(token) || (hostname && hostname.includes(token))) {
        score += 4;
      }
    }

    if (score > highestScore && score > 0) {
      highestScore = score;
      bestLabel = label;
    }
  }

  if (!bestLabel) {
    const fallback = labelObjects.find(l => isFallbackLabel(l.name));
    return fallback ? fallback.name : 'Khác';
  }

  return bestLabel;
}

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'msclkid', 'mc_eid', '_ga',
  'ref', 'source', 'feature', 'si', 't',
  'oq', 'aqs', 'sourceid', 'ved', 'ei',
  'token', 'auth', 'key', 'apikey', 'api_key', 'secret', 'access_token', 'id_token', 'code', 'password',
  'jwt', 'bearer', 'access_key', 'key_id', 'state', 'code_challenge', 'code_verifier', 'sig', 'signature',
  'auth_token', 'session_token', 'session_id', 'sid', 'session', 'ticket', 'sso', 'assertion', 'client_secret',
  'refresh_token', 'credential'
]);

/**
 * isAiEligibleUrl(url)
 *
 * Ensures only public or intranet web resources (http://, https://)
 * are ever sent to external AI decision engines. Prevents local files
 * (file://), extension assets, blobs, and internal browser states from leaking.
 */
function isAiEligibleUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
  try {
    const parsed = new URL(url);
    const h = parsed.hostname.toLowerCase().replace(/\.+$/, '');
    if (
      h === '169.254.169.254' ||
      h.startsWith('169.254.') ||
      h === '[fd00:ec2::254]' ||
      h.includes('a9fe:a9fe') ||
      h.includes('169.254.') ||
      h === 'metadata.google.internal' ||
      h.endsWith('.metadata.google.internal') ||
      h === 'metadata' ||
      h === '100.100.100.200' ||
      h === '[::ffff:6464:64c8]' ||
      h.includes('6464:64c8') ||
      /^\[fe[89ab][0-9a-f]:/i.test(h)
    ) {
      return false;
    }
    if (parsed.username || parsed.password) return false;
    return true;
  } catch {
    return false;
  }
}

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
    const cached = normalizedUrlCache.get(trimmed);
    normalizedUrlCache.delete(trimmed);
    normalizedUrlCache.set(trimmed, cached);
    return cached;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    parsed.username = '';
    parsed.password = '';

    // Strip trailing slash from pathname (unless it is just root '/')
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    const searchParams = parsed.searchParams;
    let modified = false;
    for (const key of Array.from(searchParams.keys())) {
      const lowerKey = key.toLowerCase();
      const val = searchParams.get(key) || '';
      if (
        TRACKING_PARAMS.has(lowerKey) ||
        lowerKey.startsWith('utm_') ||
        lowerKey.includes('token') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('auth') ||
        lowerKey.includes('password') ||
        lowerKey.includes('session') ||
        lowerKey.includes('signature') ||
        val.length > 80 ||
        val.startsWith('ey')
      ) {
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
    let safeFallback = stripUserInfoFallback(trimmed).split('?')[0].split('#')[0];
    if (normalizedUrlCache.size > 2000) {
      const it = normalizedUrlCache.keys();
      for (let i = 0; i < 200; i++) {
        const nextKey = it.next().value;
        if (nextKey) normalizedUrlCache.delete(nextKey);
      }
    }
    normalizedUrlCache.set(trimmed, safeFallback);
    return safeFallback;
  }
}

function stripUrlQueryParams(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    const clean = url.split('?')[0].split('#')[0];
    return stripUserInfoFallback(clean);
  }
}

/**
 * pruneClassificationCache(cache, maxEntries)
 *
 * True LRU bounds: sorts by entry timestamp descending (newest first) before keeping maxEntries.
 */
function pruneClassificationCache(cache, maxEntries = 1000) {
  if (!cache || typeof cache !== 'object') return {};
  const keys = Object.keys(cache);
  if (keys.length <= maxEntries) return cache;
  const entries = Object.entries(cache);
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
      if (isDangerousKey(pid)) return;
      if (isPerspectivesLoaded && Array.isArray(currentPerspectives) && currentPerspectives.length > 0 && !currentPerspectives.some(p => p.id === pid)) {
        return;
      }
      const partitionKey = `tabClassificationCache_${pid}`;
      const res = await chrome.storage.local.get([partitionKey, 'perspectives']);
      let validPerspectivesList = Array.isArray(res.perspectives) && res.perspectives.length > 0
        ? res.perspectives.filter(p => p && p.id && !isDangerousKey(p.id))
        : (isPerspectivesLoaded && Array.isArray(currentPerspectives) && currentPerspectives.length > 0 ? currentPerspectives.filter(p => p && p.id && !isDangerousKey(p.id)) : null);

      if (validPerspectivesList && !validPerspectivesList.some(p => p.id === pid)) {
        return;
      }
      let partitionCache = res[partitionKey];
      if (!partitionCache || typeof partitionCache !== 'object' || Array.isArray(partitionCache)) {
        const fallbackRes = await chrome.storage.local.get(['tabClassificationCache']);
        const fb = fallbackRes.tabClassificationCache?.[pid];
        partitionCache = (fb && typeof fb === 'object' && !Array.isArray(fb)) ? { ...fb } : {};
      } else {
        partitionCache = { ...partitionCache };
      }
      const initialDiskKeys = new Set(Object.keys(partitionCache));

      let hasChanges = false;
      if (newEntries && typeof newEntries === 'object') {
        for (const [urlKey, entry] of Object.entries(newEntries)) {
          if (isDangerousKey(urlKey)) continue;
          const existing = partitionCache[urlKey];
          // A completed AI decision must not be replaced by a stale local placeholder.
          if (existing && ['ai', 'ai-low-confidence'].includes(getCacheSource(existing)) &&
              !['ai', 'ai-low-confidence'].includes(getCacheSource(entry))) {
            continue;
          }
          // A completed high-confidence AI decision must not be downgraded to low confidence.
          if (existing && getCacheSource(existing) === 'ai' && getCacheSource(entry) === 'ai-low-confidence') {
            continue;
          }
          // If both are 'ai' and existing has higher confidence, preserve higher confidence
          if (existing && getCacheSource(existing) === 'ai' && getCacheSource(entry) === 'ai' &&
              typeof existing?.confidence === 'number' && typeof entry?.confidence === 'number' &&
              entry.confidence < existing.confidence) {
            continue;
          }

          const normalizedEntry = typeof entry === 'string'
            ? { label: entry, source: 'ai', timestamp: Date.now() }
            : (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {});

          // Skip redundant write if identical
          if (existing &&
              existing.label === normalizedEntry.label &&
              existing.source === normalizedEntry.source &&
              existing.confidence === normalizedEntry.confidence &&
              existing.secondaryLabel === normalizedEntry.secondaryLabel) {
            continue;
          }

          partitionCache[urlKey] = {
            ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}),
            ...normalizedEntry,
            secondaryLabel: normalizedEntry.secondaryLabel !== undefined ? normalizedEntry.secondaryLabel : existing?.secondaryLabel
          };
          hasChanges = true;
        }
      }

      const prePruneCount = Object.keys(partitionCache).length;
      partitionCache = pruneClassificationCache(partitionCache, 1000);
      if (Object.keys(partitionCache).length !== prePruneCount) {
        hasChanges = true;
      }

      // Keep RAM copy in sync using a fresh object clone to eliminate memory leaks
      tabClassificationCache[pid] = { ...partitionCache };

      if (!hasChanges) {
        return;
      }

      // Delta merge: Reload fresh storage to avoid clobbering any concurrent entries written by background service worker
      try {
        const freshCheck = await chrome.storage.local.get(['perspectives', partitionKey]);
        if (Array.isArray(freshCheck.perspectives)) {
          const freshValidIds = new Set(
            freshCheck.perspectives
              .filter(p => p && typeof p === 'object' && p.id && !isDangerousKey(p.id))
              .map(p => p.id)
          );
          if (!freshValidIds.has(pid)) {
            // Perspective was deleted while this batch was processing - abort writing orphan partition
            delete tabClassificationCache[pid];
            return;
          }
        }
        const freshDisk = freshCheck[partitionKey];
        if (freshDisk && typeof freshDisk === 'object' && !Array.isArray(freshDisk)) {
          for (const [k, v] of Object.entries(freshDisk)) {
            if (isDangerousKey(k)) continue;
            const current = partitionCache[k];
            if (!current) {
              // Only adopt if this key is newly added by another process concurrently,
              // NOT an old key that we intentionally pruned!
              if (!initialDiskKeys.has(k)) {
                partitionCache[k] = v;
              }
            } else {
              // Precedence check: if disk has AI decision and current RAM entry is local or lower confidence, upgrade to disk entry!
              const currentSrc = getCacheSource(current);
              const diskSrc = getCacheSource(v);
              if (['ai', 'ai-low-confidence'].includes(diskSrc) && !['ai', 'ai-low-confidence'].includes(currentSrc)) {
                partitionCache[k] = v;
              } else if (diskSrc === 'ai' && currentSrc === 'ai-low-confidence') {
                partitionCache[k] = v;
              } else if (diskSrc === 'ai' && currentSrc === 'ai' && typeof v?.confidence === 'number' && typeof current?.confidence === 'number' && v.confidence > current.confidence) {
                partitionCache[k] = v;
              }
            }
          }
          if (Object.keys(partitionCache).length > 1000) {
            partitionCache = pruneClassificationCache(partitionCache, 1000);
          }
        }
      } catch {}

      // Keep in-memory RAM cache in sync after delta-merge and pruning
      tabClassificationCache[pid] = { ...partitionCache };

      await chrome.storage.local.set({
        [partitionKey]: partitionCache
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
    let host;
    if (hostWithPort.startsWith('[')) {
      const closeBracketIdx = hostWithPort.indexOf(']');
      host = closeBracketIdx !== -1 ? hostWithPort.slice(0, closeBracketIdx + 1) : hostWithPort;
    } else {
      const colonIdx = hostWithPort.indexOf(':');
      host = (colonIdx === -1 ? hostWithPort : hostWithPort.slice(0, colonIdx));
    }
    return host.toLowerCase().replace(/^www\./, '');
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

async function claimAiKeys(keys, owner) {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return keys;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'tabout-ai-claim', keys, owner });
    return Array.isArray(response?.claimed) ? response.claimed : [];
  } catch {
    return keys; // No worker is available to make a competing request.
  }
}

async function releaseAiKeys(keys, owner) {
  if (!keys.length || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
  try { await chrome.runtime.sendMessage({ type: 'tabout-ai-release', keys, owner }); } catch {}
}


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
  if (!isJevActive() && typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
    try {
      const stored = await chrome.storage.local.get(['openRouterApiKey', 'classifierApiKey', 'aiAuthBlocked']);
      const k = ((stored.openRouterApiKey !== undefined ? stored.openRouterApiKey : stored.classifierApiKey) || '').trim().replace(/[^\x21-\x7E]/g, '');
      if (k) openRouterApiKey = k;
      if (stored.aiAuthBlocked !== undefined) aiAuthBlocked = stored.aiAuthBlocked === true;
    } catch {}
  }
  if (!isJevActive()) {
    const pid = perspective?.id;
    return (pid && tabClassificationCache[pid]) ? tabClassificationCache[pid] : {};
  }
  if (!perspective || !perspective.labels || perspective.labels.length === 0) {
    return {};
  }

  const silent = options && options.silent === true;
  const pid = perspective.id;
  if (!pid || isDangerousKey(pid)) {
    return {};
  }
  if (!Object.prototype.hasOwnProperty.call(tabClassificationCache, pid)) {
    tabClassificationCache[pid] = {};
  }
  const cache = tabClassificationCache[pid];

  // 1. Identify which tabs genuinely need AI decision pass BEFORE mutating cache (never send incognito tabs to cloud AI)
  const toClassify = (forceAi
    ? tabs.filter(t => !t?.incognito && isAiEligibleUrl(t?.url))
    : tabs.filter(t => {
        if (t?.incognito || !isAiEligibleUrl(t?.url)) return false;
        const normUrl = normalizeUrlForCache(t.url) || t.url || '';
        if (!normUrl) return false;
        const entry = cache[normUrl];
        if (!entry) return true;
        if (['ai', 'ai-low-confidence'].includes(getCacheSource(entry))) return false;
        const isFailedRecently = entry.lastAiAttempt && (Date.now() - entry.lastAiAttempt < (entry.cooldownMs || 15000));
        return !isFailedRecently;
      })
  ).filter(t => {
    const normUrl = normalizeUrlForCache(t.url) || t.url || '';
    return normUrl && !inFlightUrls.has(`${pid}:${normUrl}`);
  });

  // 2. For incognito tabs only, classify locally in-memory to preserve privacy without sending to cloud AI
  for (const tab of tabs) {
    const normUrl = normalizeUrlForCache(tab.url) || tab.url || '';
    if (!normUrl || isDangerousKey(normUrl)) continue;
    if (!cache[normUrl] && tab.incognito) {
      const localLabel = localFallbackClassify(tab, perspective.labels);
      cache[normUrl] = { label: localLabel, source: 'local', timestamp: Date.now() };
    }
  }

  // Mark pending URLs as in-flight immediately so concurrent calls never double-fetch or race during await
  const pendingKeys = [];
  const reservationOwner = `dashboard-${Date.now()}-${Math.random()}`;
  const reservedKeys = new Set();
  for (const t of toClassify) {
    const normUrl = normalizeUrlForCache(t.url) || t.url || '';
    if (normUrl) {
      const key = `${pid}:${normUrl}`;
      inFlightUrls.add(key);
      pendingKeys.push(key);
    }
  }

  // If Jev is not active (no OpenRouter key or auth blocked) or no tabs need AI, return cache immediately
  if (!isJevActive() || toClassify.length === 0) {
    for (const key of pendingKeys) inFlightUrls.delete(key);
    return tabClassificationCache[pid] || cache;
  }

  let activeSignal = null;
  if (!silent && typeof AbortController !== 'undefined') {
    if (activeClassificationAbortController) {
      try { activeClassificationAbortController.abort(); } catch {}
    }
    activeClassificationAbortController = new AbortController();
    activeSignal = activeClassificationAbortController.signal;
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

    // Strict On-Demand: Only classify tabs for the requested perspective (zero token waste)

    // Bound each request while sharing its state and criteria across tabs.
    const batchSize = 24;
    const batches = [];
    for (let i = 0; i < uniqueTabs.length; i += batchSize) {
      batches.push(uniqueTabs.slice(i, i + batchSize));
    }

    // Send batches sequentially to avoid bursts against the Decisions endpoint.
    const maxConcurrency = 1;
    for (let b = 0; b < batches.length; b += maxConcurrency) {
      if (aiAuthBlocked || activeSignal?.aborted) break;
      const chunk = batches.slice(b, b + maxConcurrency);
      await Promise.all(chunk.map(async (candidateBatch) => {
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
          try {
            const partitionKey = `tabClassificationCache_${pid}`;
            const res = await chrome.storage.local.get([partitionKey]);
            let latest = res[partitionKey];
            if (!latest) {
              const fallbackRes = await chrome.storage.local.get(['tabClassificationCache']);
              latest = fallbackRes.tabClassificationCache?.[pid];
            }
            if (latest && typeof latest === 'object' && !Array.isArray(latest)) {
              for (const [k, v] of Object.entries(latest)) {
                if (!isDangerousKey(k) && v && typeof v === 'object' && !Array.isArray(v)) {
                  tabClassificationCache[pid][k] = v;
                }
              }
            }
          } catch {}
        }

        const activeBatch = candidateBatch.filter(tab => {
          const normUrl = normalizeUrlForCache(tab.url) || tab.url || '';
          const entry = tabClassificationCache[pid]?.[normUrl];
          return !entry || !['ai', 'ai-low-confidence'].includes(getCacheSource(entry));
        });
        if (!activeBatch.length) return;

        const candidateKeys = activeBatch.map(tab => {
          const url = normalizeUrlForCache(tab.url) || tab.url || '';
          return `${pid}:${url}`;
        });
        const claimedKeys = await claimAiKeys([...new Set(candidateKeys)], reservationOwner);
        const claimed = new Set(claimedKeys);
        for (const key of claimedKeys) {
          reservedKeys.add(key);
          inFlightUrls.add(key);
        }
        const batch = activeBatch.filter(tab => claimed.has(`${pid}:${normalizeUrlForCache(tab.url) || tab.url || ''}`));
        if (!batch.length) {
          await releaseAiKeys(claimedKeys, reservationOwner);
          for (const key of claimedKeys) {
            inFlightUrls.delete(key);
            reservedKeys.delete(key);
          }
          return;
        }
        const questions = {};
        const state = { tabs: {} };
        const batchUpdates = {};

        batch.forEach((tab, idx) => {
          const qKey = `tab_${idx}`;
          const cleanUrl = normalizeUrlForCache(tab.url) || tab.url || '';
          const cleanTitle = stripTitleNoise(tab.title || '').replace(/[\r\n]+/g, ' ').slice(0, 140);
          const domain = extractHostname(tab.url);
          state.tabs[qKey] = {
            title: cleanTitle,
            url: stripUrlQueryParams(cleanUrl).slice(0, 300),
            domain
          };
          questions[qKey] = {
            type: 'choice',
            instructions: `Categorize \`tabs.${qKey}\` into the single most fitting category based on title, domain, and criteria.`,
            criteria
          };
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
          const requestKey = (openRouterApiKey || '').trim().replace(/[^\x21-\x7E]/g, '');
          const response = await fetch('https://openrouter.ai/api/alpha/decisions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${requestKey}`,
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
            if (response.status === 401 || response.status === 402 || response.status === 403) {
              const latest = await chrome.storage.local.get(['openRouterApiKey', 'classifierApiKey']);
              const rawKey = latest?.openRouterApiKey || latest?.classifierApiKey || '';
              const sanitizedLatest = rawKey.trim().replace(/[^\x21-\x7E]/g, '');
              const sanitizedRequest = (requestKey || '').trim().replace(/[^\x21-\x7E]/g, '');
              if (sanitizedLatest === sanitizedRequest || (!sanitizedLatest && sanitizedRequest)) {
                aiAuthBlocked = true;
                await chrome.storage.local.set({ aiAuthBlocked: true, lastBlockedApiKey: sanitizedRequest });
              }
            }
            const httpErr = new Error(`OpenRouter decisions HTTP ${response.status}`);
            httpErr.cooldownMs = cooldownMs;
            throw httpErr;
          }

          const data = await response.json();
          const answers = (data && typeof data === 'object') ? (data.answers || {}) : {};

          batch.forEach((tab, idx) => {
            const qKey = `tab_${idx}`;
            const ans = answers[qKey] || answers[`${pid}__${qKey}`];
            const choice = ans?.choice;
            const confidence = typeof ans?.confidence === 'number' ? ans.confidence : 1.0;
            const isHighConfidence = confidence >= 0.45;
            const normUrl = normalizeUrlForCache(tab.url) || tab.url || '';
            if (!normUrl || isDangerousKey(normUrl)) return;


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

                source: isHighConfidence ? 'ai' : 'ai-low-confidence',
                confidence,
                cooldownMs: isHighConfidence ? undefined : 60000,
                lastAiAttempt: isHighConfidence ? undefined : Date.now(),
                timestamp: Date.now()
              };
              batchUpdates[normUrl] = cache[normUrl];
            } else if (!cache[normUrl] || !['ai', 'ai-low-confidence'].includes(getCacheSource(cache[normUrl]))) {
              const fallback = localFallbackClassify(tab, perspective.labels);
              cache[normUrl] = {
                label: fallback,
                source: 'local',
                cooldownMs: 15000,
                lastAiAttempt: Date.now(),
                timestamp: Date.now()
              };
              batchUpdates[normUrl] = cache[normUrl];
            }
          });
        } catch (batchErr) {
          // If aborted by user switching perspectives, do not penalize tabs with cooldown!
          if (batchErr?.name === 'AbortError' || activeSignal?.aborted) {
            return;
          }
          console.warn('[tab-out] Jev batch request fallback:', batchErr);
          const cooldownMs = (batchErr && batchErr.cooldownMs) ? batchErr.cooldownMs : 15000;
          batch.forEach(tab => {
            const normUrl = normalizeUrlForCache(tab.url) || tab.url || '';
            if (normUrl && !isDangerousKey(normUrl) && (!cache[normUrl] || !['ai', 'ai-low-confidence'].includes(getCacheSource(cache[normUrl])))) {
              const fallback = (aiAuthBlocked || !isJevActive())
                ? ((perspective.labels || []).find(l => isFallbackLabel(getLabelName(l)))?.name || 'Khác')
                : localFallbackClassify(tab, perspective.labels);
              cache[normUrl] = {
                label: fallback,
                source: 'local',
                cooldownMs,
                lastAiAttempt: Date.now(),
                timestamp: Date.now()
              };
              batchUpdates[normUrl] = cache[normUrl];
            }
          });
        }
        if (Object.keys(batchUpdates).length) await saveClassificationCacheAtomic(pid, batchUpdates);
        await releaseAiKeys(claimedKeys, reservationOwner);
        for (const key of claimedKeys) {
          inFlightUrls.delete(key);
          reservedKeys.delete(key);
        }
      }));
    }

  } catch (err) {
    if (err?.name === 'AbortError' || activeSignal?.aborted) {
      return cache;
    }
    console.warn('[tab-out] OpenRouter ~typesafe/jev-latest request fell back to local classifier:', err);
  } finally {
    if (hasNewLocalFallback) {
      for (const url of Object.keys(localFallbackUpdates)) {
        if (['ai', 'ai-low-confidence'].includes(getCacheSource(tabClassificationCache[pid]?.[url]))) {
          delete localFallbackUpdates[url];
        }
      }
      if (Object.keys(localFallbackUpdates).length) {
        try { await saveClassificationCacheAtomic(pid, localFallbackUpdates); } catch {}
      }
    }
    const remainingReserved = Array.from(reservedKeys);
    if (remainingReserved.length) {
      await releaseAiKeys(remainingReserved, reservationOwner);
    }
    for (const key of pendingKeys) {
      inFlightUrls.delete(key);
    }
    for (const key of reservedKeys) {
      inFlightUrls.delete(key);
    }
    const hasActiveInFlight = Array.from(inFlightUrls).some(k => k.startsWith(`${activePerspectiveId}:`));
    if (!hasActiveInFlight && typeof document !== 'undefined') {
      const l = document.getElementById('perspectiveLoader');
      if (l) l.style.display = 'none';
      updatePerspectiveTelemetry();
    }
  }

  return tabClassificationCache[pid] || cache;
}

/**
 * triggerBackgroundClassification(tabs, perspective)
 *
 * Runs non-blocking AI classification in the background.
 * Seamlessly updates UI when AI decisions complete without recursive storms.
 */
let isBackgroundClassifying = false;
let pendingClassificationRequest = null;

function triggerBackgroundClassification(tabs, perspective) {
  if (!tabs || tabs.length === 0 || !isJevActive()) return;
  const pid = perspective.id;

  if (isBackgroundClassifying) {
    if (pendingClassificationRequest && pendingClassificationRequest.perspective?.id === perspective.id) {
      const existingKeys = new Set(pendingClassificationRequest.tabs.map(t => t.id || t.url));
      const extraTabs = tabs.filter(t => !existingKeys.has(t.id || t.url));
      if (extraTabs.length > 0) {
        pendingClassificationRequest.tabs = pendingClassificationRequest.tabs.concat(extraTabs);
      }
    } else {
      pendingClassificationRequest = { tabs, perspective };
    }
    return;
  }
  isBackgroundClassifying = true;

  (async () => {
    try {
      const cacheBefore = tabClassificationCache[pid] || {};
      const prevLabels = new Map();
      for (const t of tabs) {
        const norm = normalizeUrlForCache(t.url) || t.url || '';
        prevLabels.set(norm, getCacheLabel(cacheBefore[norm]));
      }

      await classifyTabs(tabs, perspective, false, { silent: false });

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
    } finally {
      isBackgroundClassifying = false;
      if (pendingClassificationRequest) {
        const next = pendingClassificationRequest;
        pendingClassificationRequest = null;
        triggerBackgroundClassification(next.tabs, next.perspective);
      }
    }
  })();
}

/**
 * prewarmMultiPerspective()
 * Deprecated: Strict on-demand architecture replaces speculative prewarming to eliminate token waste.
 */
async function prewarmMultiPerspective() {
  return;
}

/**
 * schedulePerspectivePrewarm()
 * Deprecated: Strict on-demand architecture replaces speculative hover prewarming to eliminate token waste.
 */
function schedulePerspectivePrewarm() {
  return;
}

/**
 * renderPerspectiveTagsBar()
 *
 * Renders a subheader pill bar showing an overview of all tags (both active with counts and empty).
 * Allows users to see at a glance all available categories in the current perspective.
 * Clicking an active pill scrolls smoothly to that specific category card.
 */
function renderPerspectiveTagsBar(groupsOverride = null) {
  if (typeof document === 'undefined') return;
  const barEl = document.getElementById('perspectiveTagsBar');
  if (!barEl) return;

  const isDomainView = activePerspectiveId === 'domain';
  const activeP = currentPerspectives.find(p => p.id === activePerspectiveId);

  if (isDomainView || !activeP || !isJevActive()) {
    barEl.style.display = 'none';
    barEl.innerHTML = '';
    resetRenderCache('perspectiveTags');
    return;
  }

  const normalizedLabels = normalizeLabels(activeP.labels);
  if (normalizedLabels.length === 0) {
    barEl.style.display = 'none';
    barEl.innerHTML = '';
    resetRenderCache('perspectiveTags');
    return;
  }

  // Count open tabs per category (prefer in-memory groups if provided to avoid layout thrashing)
  const categoryCounts = Object.create(null);
  let cardCount = 0;
  if (Array.isArray(groupsOverride)) {
    cardCount = groupsOverride.length;
    for (const group of groupsOverride) {
      const cat = group.label || group.domain;
      if (cat) {
        const count = Array.isArray(group.tabs) ? group.tabs.length : 0;
        categoryCounts[cat] = (categoryCounts[cat] || 0) + count;
      }
    }
  } else {
    const missionsEl = document.getElementById('openTabsMissions');
    if (missionsEl && typeof missionsEl.querySelectorAll === 'function') {
      const cards = missionsEl.querySelectorAll('.mission-card:not(.closing)');
      cardCount = (cards && cards.length) || 0;
      if (cards && cards.length > 0) {
        cards.forEach(card => {
          const cat = card.dataset?.category;
          if (cat) {
            const tabChips = typeof card.querySelectorAll === 'function' ? card.querySelectorAll('.page-chip:not(.removing)') : [];
            let totalCardTabs = 0;
            tabChips.forEach(chip => {
              const rawCount = chip.dataset?.tabCount;
              const parsed = parseInt(rawCount || '1', 10);
              totalCardTabs += (isNaN(parsed) || parsed < 1) ? 1 : parsed;
            });
            categoryCounts[cat] = (categoryCounts[cat] || 0) + totalCardTabs;
          }
        });
      }
    }
  }

  const realTabs = typeof getRealTabs === 'function' ? getRealTabs() : [];
  if (cardCount === 0 && realTabs.length === 0) {
    barEl.style.display = 'none';
    barEl.innerHTML = '';
    resetRenderCache('perspectiveTags');
    return;
  }

  const activeList = [];
  const emptyList = [];

  for (const labelObj of normalizedLabels) {
    const name = labelObj.name;
    const count = categoryCounts[name] || 0;
    const desc = labelObj.description || '';
    const color = labelObj.color || '';
    if (count > 0) {
      activeList.push({ name, count, desc, color });
    } else {
      emptyList.push({ name, count: 0, desc, color });
    }
  }

  // Safety: ensure any active category with tabs that is not in normalizedLabels is also shown
  for (const [catName, count] of Object.entries(categoryCounts)) {
    if (count > 0 && !normalizedLabels.some(l => l.name === catName)) {
      activeList.push({ name: catName, count, desc: '', color: '' });
    }
  }

  // Active pills sorted by open tab count descending
  activeList.sort((a, b) => b.count - a.count);

  let pillsHtml = '';

  for (const item of activeList) {
    const isOther = isFallbackLabel(item.name);
    const displayName = isOther ? (typeof t === 'function' ? t('tabs.uncategorized') : item.name) : item.name;
    const titleText = item.desc ? `${item.desc}: ${item.count} tab${item.count !== 1 ? 's' : ''}` : `${displayName}: ${item.count} tab${item.count !== 1 ? 's' : ''}`;
    const resolved = resolveTagColor(item.color);
    const colorClass = (resolved && !isOther) ? ' has-color' : '';
    const colorStyle = (resolved && !isOther) ? ` style="--pill-color: ${escapeHtml(resolved.hex)};"` : '';
    const dotHtml = (resolved && !isOther) ? `<span class="pill-dot" style="background-color: ${escapeHtml(resolved.hex)};" aria-hidden="true"></span>` : '';
    pillsHtml += `<button type="button" class="perspective-tag-pill is-active${colorClass}"${colorStyle} data-action="scroll-to-tag" data-target-tag="${escapeHtml(item.name)}" title="${escapeHtml(titleText)}" aria-label="${escapeHtml(displayName)}, ${item.count} tab${item.count !== 1 ? 's' : ''} open">${dotHtml}<span class="pill-name">${escapeHtml(displayName)}</span><span class="pill-count">${item.count}</span></button>`;
  }

  for (const item of emptyList) {
    const isOther = isFallbackLabel(item.name);
    const displayName = isOther ? (typeof t === 'function' ? t('tabs.uncategorized') : item.name) : item.name;
    const titleText = item.desc ? `${item.desc}` : `${displayName}`;
    const resolved = resolveTagColor(item.color);
    const colorClass = (resolved && !isOther) ? ' has-color' : '';
    const colorStyle = (resolved && !isOther) ? ` style="--pill-color: ${escapeHtml(resolved.hex)};"` : '';
    const dotHtml = (resolved && !isOther) ? `<span class="pill-dot" style="background-color: ${escapeHtml(resolved.hex)}; opacity: 0.6;" aria-hidden="true"></span>` : '';
    pillsHtml += `<span class="perspective-tag-pill is-empty${colorClass}"${colorStyle} title="${escapeHtml(titleText)}" aria-label="${escapeHtml(displayName)}, 0 open tabs">${dotHtml}<span class="pill-name">${escapeHtml(displayName)}</span><span class="pill-count">0</span></span>`;
  }

  renderIfChanged(barEl, pillsHtml, 'perspectiveTags');
  barEl.style.display = 'flex';
}

async function switchPerspective(pid) {
  if (!pid || pid === activePerspectiveId || isDangerousKey(pid) || !currentPerspectives.some(p => p.id === pid)) return;
  if (pid !== 'domain' && !isJevActive()) {
    if (typeof showToast === 'function') {
      showToast(typeof t === 'function' ? t('perspective.ai_required_toast') : 'OpenRouter API key required to activate AI perspectives');
    }
    if (typeof document !== 'undefined') {
      previousModalFocus = document.activeElement;
      const overlay = document.getElementById('apiKeyModalOverlay');
      const keyInput = document.getElementById('apiKeyInput');
      const langSelect = document.getElementById('settingsLanguageSelect');
      if (overlay) {
        if (keyInput) keyInput.value = openRouterApiKey || '';
        if (langSelect && typeof TabOutI18n !== 'undefined') {
          langSelect.value = TabOutI18n.getLanguage();
        }
        overlay.style.display = 'flex';
        setTimeout(() => keyInput?.focus(), 50);
      }
    }
    return;
  }
  if (activeClassificationAbortController) {
    try { activeClassificationAbortController.abort(); } catch {}
    activeClassificationAbortController = null;
  }
  activePerspectiveId = pid;
  resetRenderCache('missions');
  resetRenderCache('perspectiveTags');
  setLocalSettingLock(400);
  if (typeof chrome !== 'undefined' && chrome.storage?.local?.set) {
    enqueueStorageWrite(() => chrome.storage.local.set({ activePerspectiveId })).catch(() => {});
  }
  if (typeof document !== 'undefined') {
    const l = document.getElementById('perspectiveLoader');
    if (l && pid === 'domain') l.style.display = 'none';
  }
  await renderStaticDashboard({ inMemoryOnly: true });
  updatePerspectiveTelemetry();
}

function getPerspectiveDisplayName(p) {
  if (!p) return '';
  if (p.id === 'domain') return typeof t === 'function' ? t('rail.domain_default') : 'Domain';
  if (p.id === 'topic' && (p.name === 'Chủ đề' || p.name === 'Topic')) return typeof t === 'function' ? t('rail.topic_default') : p.name;
  if (p.id === 'purpose' && (p.name === 'Mục đích' || p.name === 'Purpose')) return typeof t === 'function' ? t('rail.purpose_default') : p.name;
  return p.name;
}

function renderPerspectiveRail(tabsOverride = null) {
  const listEl = document.getElementById('perspectiveList');
  if (!listEl) return;

  const realTabs = Array.isArray(tabsOverride) ? tabsOverride : getRealTabs();
  const count = realTabs.length;
  const jevReady = isJevActive();

  // Smart In-Place DOM Update: If perspective IDs haven't changed, toggle .active and .locked class in-place
  // This prevents tearing down and recreating DOM nodes during clicks or rapid startup syncs
  const existingTabs = listEl.querySelectorAll('.perspective-tab');
  const canUpdateInPlace = existingTabs.length === currentPerspectives.length &&
    Array.from(existingTabs).every((tabEl, i) => {
      const p = currentPerspectives[i];
      const isLocked = p.id !== 'domain' && !jevReady;
      return tabEl.dataset.perspectiveId === p.id && tabEl.classList.contains('locked') === isLocked;
    });

  if (canUpdateInPlace) {
    existingTabs.forEach((tabEl, i) => {
      const p = currentPerspectives[i];
      const isActive = p.id === activePerspectiveId;
      const isLocked = p.id !== 'domain' && !jevReady;
      tabEl.classList.toggle('active', isActive);
      tabEl.classList.toggle('locked', isLocked);
      tabEl.setAttribute('aria-selected', isActive ? 'true' : 'false');
      tabEl.setAttribute('aria-disabled', isLocked ? 'true' : 'false');
      const countEl = tabEl.querySelector('.perspective-tab-count');
      if (countEl && countEl.textContent !== String(count)) {
        countEl.textContent = count;
      }
      const nameEl = tabEl.querySelector('.perspective-tab-name');
      const dispName = getPerspectiveDisplayName(p);
      if (nameEl && nameEl.textContent !== dispName) {
        nameEl.textContent = dispName;
      }
    });
    return;
  }

  listEl.innerHTML = currentPerspectives.map(p => {
    const isActive = p.id === activePerspectiveId;
    const isLocked = p.id !== 'domain' && !jevReady;
    const iconSvg = (p.icon && Object.prototype.hasOwnProperty.call(PERSPECTIVE_ICONS, p.icon))
      ? PERSPECTIVE_ICONS[p.icon]
      : PERSPECTIVE_ICONS.folder;
    const editBtn = !p.isSystem
      ? `<button type="button" class="perspective-tab-edit-btn" data-action="edit-perspective" data-perspective-id="${escapeHtml(p.id)}" title="${escapeHtml(typeof t === 'function' ? t('rail.edit_perspective') : 'Edit perspective')}" aria-label="${escapeHtml(typeof t === 'function' ? t('rail.edit_perspective') : 'Edit perspective')}">
          ${PERSPECTIVE_ICONS.edit}
        </button>`
      : '';
    const dispName = getPerspectiveDisplayName(p);
    let tabTitle = `${dispName} perspective`;
    if (p.id === 'domain') {
      tabTitle = typeof t === 'function' ? t('rail.domain_tooltip') : 'Domain: Group tabs by URL hostname — 100% local, no AI';
    } else if (isLocked) {
      tabTitle = typeof t === 'function' ? t('rail.perspective_locked_tooltip') : 'Requires OpenRouter API key (Model Jev)';
    }

    return `
      <div class="perspective-tab ${isActive ? 'active' : ''} ${isLocked ? 'locked' : ''}" role="tab" tabindex="0" aria-selected="${isActive}" aria-disabled="${isLocked ? 'true' : 'false'}" data-action="switch-perspective" data-perspective-id="${escapeHtml(p.id)}" title="${escapeHtml(tabTitle)}">
        <span class="perspective-tab-icon">${iconSvg}</span>
        <span class="perspective-tab-name">${escapeHtml(dispName)}</span>
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
  return openTabs.filter(t => isRealTabUrl(t.url));
}

/**
 * getRecentTabs(tabs, options)
 *
 * Extracts and sorts real web tabs by their last accessed timestamp (MRU order).
 * Highly extensible: allows retrieving top N recent tabs, filtering by window, etc.
 *
 * @param {Array} [tabs] - Optional tab list; defaults to getRealTabs()
 * @param {Object} [options]
 * @param {number} [options.limit=5] - Maximum number of recent tabs to return
 * @param {boolean} [options.excludeCurrent=true] - Exclude active/extension tabs
 * @param {number} [options.currentTabId] - Optional tab id to exclude
 * @returns {Array} Sorted list of recent tabs with rank and last active flag
 */
function getRecentTabs(tabs, options = {}) {
  const source = Array.isArray(tabs) ? tabs : getRealTabs();
  const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : 5;
  const excludeCurrent = options.excludeCurrent !== false;
  const currentTabId = options.currentTabId;

  const valid = source.filter(t => {
    if (!t || !t.url) return false;
    if (!isRealTabUrl(t.url)) return false;
    if (t.isTabOut) return false;
    if (excludeCurrent && currentTabId && t.id === currentTabId) return false;
    return true;
  });

  valid.sort((a, b) => {
    const aTime = typeof a.lastAccessed === 'number' ? a.lastAccessed : 0;
    const bTime = typeof b.lastAccessed === 'number' ? b.lastAccessed : 0;
    if (bTime !== aTime) return bTime - aTime;
    return (b.id || 0) - (a.id || 0);
  });

  return valid.slice(0, limit).map((tab, idx) => ({
    ...tab,
    isLastActive: idx === 0,
    mruRank: idx + 1
  }));
}

/**
 * getLastActiveTab(tabs, options)
 *
 * Retrieves the single most recently active tab prior to new tab opening.
 */
function getLastActiveTab(tabs, options = {}) {
  const list = getRecentTabs(tabs, { ...options, limit: 1 });
  return list.length > 0 ? list[0] : null;
}

let isQuickReturnDismissed = false;

/**
 * renderQuickReturnBar(tabsOverride)
 *
 * Renders the top quick-return pill for the most recent active tab.
 */
function renderQuickReturnBar(tabsOverride) {
  if (typeof document === 'undefined') return;
  const container = document.getElementById('quickReturnBar');
  if (!container) return;

  if (isQuickReturnDismissed) {
    if (container.style.display !== 'none') {
      container.style.display = 'none';
      container.innerHTML = '';
      resetRenderCache('quickReturn');
    }
    return;
  }

  const lastTab = Array.isArray(tabsOverride) && tabsOverride.length > 0 && tabsOverride[0]?.mruRank !== undefined
    ? tabsOverride[0]
    : getLastActiveTab(tabsOverride);
  if (!lastTab || !lastTab.url) {
    if (container.style.display !== 'none') {
      container.style.display = 'none';
      container.innerHTML = '';
      resetRenderCache('quickReturn');
    }
    return;
  }

  // If recent sidebar card is active and rendered, hide the redundant quickReturnBar in Column 2
  const sidebarCard = document.getElementById('recentSidebarCard');
  if (sidebarCard && sidebarCard.style.display !== 'none') {
    if (container.style.display !== 'none') {
      container.style.display = 'none';
      container.innerHTML = '';
      resetRenderCache('quickReturn');
    }
    return;
  }

  const validUrl = safeUrl(lastTab.url);
  const cleanTabTitle = cleanTitle(smartTitle(stripTitleNoise(lastTab.title || ''), lastTab.url), extractHostname(lastTab.url));
  const safeTitle = escapeHtml(cleanTabTitle || lastTab.url);
  const faviconUrl = getFaviconUrl(lastTab.url);

  const quickReturnBadge = typeof t === 'function' ? t('quick_return.label') : 'Recent';
  const quickReturnBackTo = typeof t === 'function' ? t('quick_return.back_to', { title: safeTitle }) : `Back to: ${safeTitle} (Press Esc)`;
  const quickReturnClose = typeof t === 'function' ? t('quick_return.close') : 'Dismiss quick return bar';

  const quickReturnHtml = `
    <div class="quick-return-inner">
      <div class="quick-return-main">
        <span class="quick-return-badge" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
          </svg>
          <span>${escapeHtml(quickReturnBadge)}</span>
        </span>
        <button type="button" class="quick-return-btn" data-action="focus-tab" data-tab-url="${validUrl}"${lastTab.id ? ` data-tab-id="${lastTab.id}"` : ''} aria-keyshortcuts="Escape" title="${escapeHtml(quickReturnBackTo)}">
          ${faviconUrl ? `<img class="quick-return-favicon" src="${faviconUrl}" alt="" aria-hidden="true">` : ''}
          <span class="quick-return-title">${safeTitle}</span>
          <span class="quick-return-kbd vbg-mono"><kbd>Esc</kbd></span>
        </button>
      </div>
      <button type="button" class="quick-return-dismiss" data-action="dismiss-quick-return" title="${escapeHtml(quickReturnClose)}" aria-label="${escapeHtml(quickReturnClose)}">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  `;
  renderIfChanged(container, quickReturnHtml, 'quickReturn');
  container.style.display = 'flex';
}

/**
 * renderRecentSidebarCard(tabsOverride)
 *
 * Renders the compact recent tabs card in the left perspective rail (Column 1)
 * directly below OpenRouter (Jev). Displays up to 5 tabs with Recency Opacity Decay,
 * favicons, truncated titles, and keyboard shortcuts (Esc, 2..5).
 */
function renderRecentSidebarCard(tabsOverride) {
  if (typeof document === 'undefined') return;
  const card = document.getElementById('recentSidebarCard');
  const list = document.getElementById('recentSidebarList');
  const badge = document.getElementById('recentSidebarBadge');
  if (!card || !list) return;

  const recentTabs = Array.isArray(tabsOverride) && tabsOverride.length > 0 && tabsOverride[0]?.mruRank !== undefined
    ? tabsOverride
    : getRecentTabs(tabsOverride, { limit: 5 });
  if (!recentTabs || recentTabs.length === 0) {
    card.style.display = 'none';
    list.innerHTML = '';
    resetRenderCache('recentSidebar');
    return;
  }

  if (badge) {
    badge.textContent = `${recentTabs.length}`;
  }

  const itemsHtml = recentTabs.map((tab, idx) => {
    const validUrl = safeUrl(tab.url || '');
    const cleanTabTitle = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), extractHostname(tab.url));
    const safeTitle = escapeHtml(cleanTabTitle || tab.url);
    const faviconUrl = getFaviconUrl(tab.url);
    const kbd = idx === 0 ? 'Esc' : `${idx + 1}`;
    const returnHint = typeof t === 'function' ? t('quick_return.card_tooltip', { title: safeTitle }) : `${safeTitle} (Press ${idx === 0 ? 'Esc or 1' : idx + 1} to return)`;
    const rank = tab.mruRank || (idx + 1);

    return `
      <button type="button" class="recent-sidebar-item decay-rank-${rank}" data-action="focus-tab" data-tab-url="${validUrl}"${tab.id ? ` data-tab-id="${tab.id}"` : ''} title="${escapeHtml(returnHint)}" aria-label="${safeTitle}">
        ${faviconUrl ? `<img class="recent-sidebar-favicon" src="${faviconUrl}" alt="" aria-hidden="true">` : ''}
        <span class="recent-sidebar-item-title">${safeTitle}</span>
        <span class="recent-sidebar-kbd vbg-mono"><kbd>${kbd}</kbd></span>
      </button>
    `;
  }).join('');

  renderIfChanged(list, itemsHtml, 'recentSidebar');
  card.style.display = 'flex';
}

/**
 * returnToLastActiveTab(lastTab)
 *
 * Switches focus back to the last active tab.
 */
async function returnToLastActiveTab(lastTab) {
  const target = lastTab || getLastActiveTab();
  if (!target) return;
  await focusTab(target.url, target.id);
}

/**
 * getTabRecentAttrs(tab, lastActiveTab)
 *
 * Evaluates whether a tab matches the last active tab, giving strict precedence
 * to unique tab.id over url to avoid misidentifying duplicate URLs.
 */
function getTabRecentAttrs(tab, lastActiveTab) {
  const isLastActive = Boolean(
    lastActiveTab && (
      (tab?.id && lastActiveTab?.id)
        ? tab.id === lastActiveTab.id
        : (tab?.url && lastActiveTab?.url && tab.url === lastActiveTab.url)
    )
  );
  const recentWord = typeof t === 'function' ? t('chip.recent') : 'Vừa xem';
  const recentTitle = typeof t === 'function' ? t('chip.recent_title') : 'Tab vừa xem gần nhất';
  return {
    isLastActive,
    lastActiveTag: isLastActive ? ` <span class="chip-recent-badge" title="${escapeHtml(recentTitle)}">${escapeHtml(recentWord)}</span>` : '',
    lastActiveClass: isLastActive ? ' is-last-active' : ''
  };
}

let isTabOutDupeDismissed = false;

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1 and not dismissed,
 * shows a floating action pill offering to close the extras.
 */
function checkTabOutDupes(tabsOverride) {
  const tabsList = Array.isArray(tabsOverride) ? tabsOverride : openTabs;
  const tabOutTabs = tabsList.filter(t => t && t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length <= 1) {
    isTabOutDupeDismissed = false;
    banner.style.display = 'none';
    return;
  }

  if (isTabOutDupeDismissed) {
    banner.style.display = 'none';
    return;
  }

  const textEl = banner.querySelector('.tab-cleanup-text');
  if (textEl && typeof t === 'function') {
    textEl.innerHTML = t('banner.dupe_count', { count: `<strong id="tabOutDupeCount">${tabOutTabs.length}</strong>` });
  } else if (countEl) {
    countEl.textContent = tabOutTabs.length;
  }
  banner.classList?.remove?.('removing');
  banner.style.display = 'flex';
}






/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}, isExpanded = false, domain = '', lastActiveTabOverride) {
  const lastActiveTab = lastActiveTabOverride !== undefined ? lastActiveTabOverride : getLastActiveTab();
  const hiddenChips = hiddenTabs.map(tab => {
    const domainForClean = (domain && !domain.startsWith('perspective:')) ? domain : extractHostname(tab.url);
    const rawLabel  = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), domainForClean);
    let portPrefix  = '';
    if (tab.url && tab.url.includes('localhost')) {
      try {
        const parsed = new URL(tab.url);
        if (parsed.hostname === 'localhost' && parsed.port) {
          portPrefix = `<code class="chip-port vbg-mono">${escapeHtml(parsed.port)}</code>`;
        }
      } catch {}
    }
    const count     = urlCounts[tab.url] || 1;
    const dupeTag   = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const validUrl  = safeUrl(tab.url);
    const safeTitle = escapeHtml(rawLabel);
    const faviconUrl = getFaviconUrl(tab.url);
    const { lastActiveTag, lastActiveClass } = getTabRecentAttrs(tab, lastActiveTab);
    const saveTooltip = typeof t === 'function' ? t('chip.save_for_later') : 'Save for later';
    const closeTooltip = typeof t === 'function' ? t('chip.close_tab') : 'Close this tab';

    return `<div class="page-chip${lastActiveClass}" data-tab-count="${count}" data-tab-url="${validUrl}"${tab.id ? ` data-tab-id="${tab.id}"` : ''}>
      <button type="button" class="chip-title-btn" data-action="focus-tab" data-tab-url="${validUrl}"${tab.id ? ` data-tab-id="${tab.id}"` : ''} title="${safeTitle}" aria-label="${safeTitle}">
        ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="">` : ''}
        <span class="chip-text">${portPrefix}${escapeHtml(rawLabel)}</span>${dupeTag}${lastActiveTag}
      </button>
      <div class="chip-actions">
        <button type="button" class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${validUrl}" data-tab-title="${safeTitle}" title="${escapeHtml(saveTooltip)}" aria-label="${escapeHtml(saveTooltip)}">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button type="button" class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${validUrl}" title="${escapeHtml(closeTooltip)}" aria-label="${escapeHtml(closeTooltip)}">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  if (isExpanded) {
    return `<div class="page-chips-overflow" style="display:contents">${hiddenChips}</div>`;
  }

  const moreText = typeof t === 'function' ? t('chip.show_more', { count: hiddenTabs.length }) : `+${hiddenTabs.length} more`;
  const moreAria = typeof t === 'function' ? t('chip.show_more_aria', { count: hiddenTabs.length }) : `Show ${hiddenTabs.length} more tabs`;

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <button type="button" class="page-chip-overflow" data-action="expand-chips" aria-label="${escapeHtml(moreAria)}">
      ${escapeHtml(moreText)}
    </button>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, lastActiveTabOverride)
 *
 * Builds the HTML string for one domain card.
 * Handles tab count badges, duplicate badges, page chips,
 * and card action buttons.
 */
function renderDomainCard(group, lastActiveTabOverride) {
  const tabs       = group.tabs;
  const isLanding  = group.domain === '__landing-pages__';
  const tabCount   = tabs.length;
  const isExpanded = expandedDomains.has(group.domain);

  // Count occurrences of each URL to detect exact duplicates
  const urlCounts = Object.create(null);
  for (const tab of tabs) {
    urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  }

  // Find all duplicates (URLs appearing more than once)
  const dupeUrls = Object.entries(urlCounts).filter(([, count]) => count > 1);
  const hasDupes = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((sum, [, count]) => sum + (count - 1), 0);

  // Badges: quiet tabular text label
  const tabBadgeKey = tabCount === 1 ? 'tabs.open_tabs_count_single' : 'tabs.open_tabs_count_plural';
  const tabBadgeText = typeof t === 'function' ? t(tabBadgeKey, { count: tabCount }) : `${tabCount} tab${tabCount !== 1 ? 's' : ''} open`;
  const tabBadge = tabCount > 0
    ? `<span class="open-tabs-badge">${escapeHtml(tabBadgeText)}</span>`
    : '';

  const dupeBadgeText = typeof t === 'function' ? t('tabs.close_dupes', { count: totalExtras }) : `${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}`;
  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge dupe-badge">
        ${escapeHtml(dupeBadgeText)}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const lastActiveTab = lastActiveTabOverride !== undefined ? lastActiveTabOverride : getLastActiveTab();

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    const domainForClean = group.isSemantic ? extractHostname(tab.url) : group.domain;
    let rawLabel = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), domainForClean);
    let portPrefix = '';
    // For localhost tabs, prepend port number with monospace styling so you can tell projects apart
    if (tab.url && tab.url.includes('localhost')) {
      try {
        const parsed = new URL(tab.url);
        if (parsed.hostname === 'localhost' && parsed.port) {
          portPrefix = `<code class="chip-port vbg-mono">${escapeHtml(parsed.port)}</code>`;
        }
      } catch {}
    }
    const count     = urlCounts[tab.url] || 1;
    const dupeTag   = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const validUrl  = safeUrl(tab.url);
    const safeTitle = escapeHtml(rawLabel);
    const faviconUrl = getFaviconUrl(tab.url);
    const { lastActiveTag, lastActiveClass } = getTabRecentAttrs(tab, lastActiveTab);

    const saveTooltip = typeof t === 'function' ? t('chip.save_for_later') : 'Save for later';
    const closeTooltip = typeof t === 'function' ? t('chip.close_tab') : 'Close this tab';

    return `<div class="page-chip${lastActiveClass}" data-tab-count="${count}" data-tab-url="${validUrl}"${tab.id ? ` data-tab-id="${tab.id}"` : ''}>
      <button type="button" class="chip-title-btn" data-action="focus-tab" data-tab-url="${validUrl}"${tab.id ? ` data-tab-id="${tab.id}"` : ''} title="${safeTitle}" aria-label="${safeTitle}">
        ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="">` : ''}
        <span class="chip-text">${portPrefix}${escapeHtml(rawLabel)}</span>${dupeTag}${lastActiveTag}
      </button>
      <div class="chip-actions">
        <button type="button" class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${validUrl}" data-tab-title="${safeTitle}" title="${escapeHtml(saveTooltip)}" aria-label="${escapeHtml(saveTooltip)}">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button type="button" class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${validUrl}" title="${escapeHtml(closeTooltip)}" aria-label="${escapeHtml(closeTooltip)}">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts, isExpanded, group.domain, lastActiveTab) : '');

  let actionsHtml = '';
  if (tabCount >= 1) {
    const closeBtnText = tabCount === 1
      ? (typeof t === 'function' ? t('tabs.close_single_tab') : 'Close tab')
      : (typeof t === 'function' ? t('tabs.close_group', { count: tabCount }) : `Close ${tabCount} tabs`);
    actionsHtml += `
      <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain="${escapeHtml(group.domain)}">
        ${ICONS.close}
        ${escapeHtml(closeBtnText)}
      </button>`;
  }

  if (hasDupes) {
    const dupeUrlsEncoded = escapeHtml(JSON.stringify(dupeUrls.map(([url]) => url)));
    const closeDupesText = typeof t === 'function' ? t('tabs.close_dupes', { count: totalExtras }) : `Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}`;
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        ${escapeHtml(closeDupesText)}
      </button>`;
  }

  const rawHeading = group.label || friendlyDomain(group.domain);
  const headingText = (group.isSemantic && isFallbackLabel(rawHeading) && typeof t === 'function')
    ? t('tabs.uncategorized')
    : rawHeading;
  const groupHeading = isLanding ? (typeof t === 'function' ? t('tabs.landing_pages') : 'Homepages') : escapeHtml(headingText);

  const categoryAttr = group.isSemantic && group.label ? ` data-category="${escapeHtml(group.label)}"` : '';

  let tagColorAttr = '';
  let colorDotHtml = '';
  if (group.isSemantic && group.label && activePerspectiveId !== 'domain') {
    const activeP = currentPerspectives.find(p => p.id === activePerspectiveId);
    if (activeP && Array.isArray(activeP.labels)) {
      const match = activeP.labels.find(l => getLabelName(l).toLowerCase() === group.label.toLowerCase());
      const colorKey = match ? getLabelColor(match) : '';
      const resolved = resolveTagColor(colorKey);
      if (resolved && !isFallbackLabel(group.label)) {
        tagColorAttr = ` data-tag-color="${escapeHtml(resolved.id)}" style="--tag-color: ${escapeHtml(resolved.hex)};"`;
        colorDotHtml = `<span class="card-tag-dot" style="background-color: ${escapeHtml(resolved.hex)};" aria-hidden="true"></span>`;
      }
    }
  }

  return `
    <div class="mission-card ${hasDupes ? 'has-amber-bar' : ''}" data-domain="${escapeHtml(group.domain)}"${categoryAttr}${tagColorAttr}>
      <div class="mission-content">
        <div class="mission-top">
          <h3 class="mission-name">${colorDotHtml}${groupHeading}</h3>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        ${actionsHtml ? `<div class="actions">${actionsHtml}</div>` : ''}
      </div>
    </div>`;
}

const renderMissionCard = renderDomainCard;


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

let deferredRenderSeq = 0;

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const seq = ++deferredRenderSeq;
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
    if (seq !== deferredRenderSeq) return;

    // Render active checklist items
    if (active.length > 0) {
      const itemWord = active.length !== 1
        ? (typeof t === 'function' ? t('common.item_plural') : 'items')
        : (typeof t === 'function' ? t('common.item_single') : 'item');
      countEl.textContent = typeof t === 'function'
        ? t('saved.items_count', { count: active.length, word: itemWord })
        : `${active.length} ${itemWord}`;
      const activeHtml = active.map(item => renderDeferredItem(item)).join('');
      renderIfChanged(list, activeHtml, 'deferredActive');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      list.innerHTML = '';
      resetRenderCache('deferredActive');
      countEl.textContent = '';
      empty.style.display = 'flex';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      const searchInput = document.getElementById('archiveSearch');
      const q = searchInput ? searchInput.value.trim().toLowerCase() : '';
      let archiveHtml;
      if (q.length >= 2) {
        const results = archived.filter(item =>
          (item.title || '').toLowerCase().includes(q) ||
          (item.url   || '').toLowerCase().includes(q)
        );
        const displayed = results.slice(0, 50);
        archiveHtml = displayed.map(item => renderArchiveItem(item)).join('')
          || `<div class="archive-no-results">${escapeHtml(typeof t === 'function' ? t('archive.no_results') : 'No results')}</div>`;
        if (results.length > 50) {
          archiveHtml += `<div class="archive-more-hint" style="text-align:center;padding:8px;font-size:12px;color:var(--text-muted, #888);">${results.length - 50} more matching items. Refine your search to narrow results.</div>`;
        }
      } else {
        const displayed = archived.slice(0, 50);
        archiveHtml = displayed.map(item => renderArchiveItem(item)).join('');
        if (archived.length > 50) {
          archiveHtml += `<div class="archive-more-hint" style="text-align:center;padding:8px;font-size:12px;color:var(--text-muted, #888);">${archived.length - 50} more archived items. Use search to find older items.</div>`;
        }
      }
      renderIfChanged(archiveList, archiveHtml, 'deferredArchive');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
      if (archiveList) archiveList.innerHTML = '';
      resetRenderCache('deferredArchive');
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    if (empty) empty.style.display = 'flex';
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
  const dismissTooltip = typeof t === 'function' ? t('saved.item_dismiss') : 'Dismiss';

  return `
    <div class="deferred-item" data-deferred-id="${escapeHtml(item.id)}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${escapeHtml(item.id)}" aria-label="Mark completed">
      <div class="deferred-info">
        <a href="${validUrl}" target="_blank" rel="noopener noreferrer" class="deferred-title" title="${displayTitle}">
          ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="">` : ''}<span>${displayTitle}</span>
        </a>
        <div class="deferred-meta">
          <span>${escapeHtml(domain)}</span>
          <span>${escapeHtml(ago)}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${escapeHtml(item.id)}" title="${escapeHtml(dismissTooltip)}" aria-label="${escapeHtml(dismissTooltip)}">
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

  const restoreTooltip = typeof t === 'function' ? t('saved.restore_tooltip') : 'Restore to Saved for later';
  const deleteTooltip = typeof t === 'function' ? t('saved.delete_tooltip') : 'Delete permanently';

  return `
    <div class="archive-item" data-archive-id="${escapeHtml(item.id)}">
      <div class="archive-item-main">
        <a href="${validUrl}" target="_blank" rel="noopener noreferrer" class="archive-item-title" title="${displayTitle}">
          ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="">` : ''}
          <span class="archive-item-text">${displayTitle}</span>
        </a>
        <span class="archive-item-date">${escapeHtml(domain ? domain + ' · ' + ago : ago)}</span>
      </div>
      <div class="archive-item-actions">
        <button type="button" class="archive-action-btn unarchive" data-action="unarchive-saved-tab" data-archive-id="${escapeHtml(item.id)}" title="${escapeHtml(restoreTooltip)}" aria-label="${escapeHtml(restoreTooltip)}">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" /></svg>
        </button>
        <button type="button" class="archive-action-btn delete" data-action="delete-archived-tab" data-archive-id="${escapeHtml(item.id)}" title="${escapeHtml(deleteTooltip)}" aria-label="${escapeHtml(deleteTooltip)}">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
        </button>
      </div>
    </div>`;
}

/* ----------------------------------------------------------------
   RECENTLY CLOSED TABS — Native chrome.sessions API (Column 3)
   ---------------------------------------------------------------- */

/**
 * isRealTabUrl(url)
 *
 * Validates that a URL is a real web page, filtering out browser internals
 * and extension pages.
 */
function isRealTabUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * getRecentlyClosedTabs(maxCount)
 *
 * Uses the native chrome.sessions.getRecentlyClosed() API to retrieve
 * up to maxCount recently closed tabs, flattening window tabs and filtering out
 * browser internals.
 */
async function getRecentlyClosedTabs(maxCount = 5) {
  if (typeof chrome === 'undefined' || !chrome.sessions || typeof chrome.sessions.getRecentlyClosed !== 'function') {
    return [];
  }
  try {
    const maxResults = Math.min(25, (typeof chrome !== 'undefined' && chrome.sessions?.MAX_SESSION_RESULTS) || 25);
    const sessions = await chrome.sessions.getRecentlyClosed({ maxResults });
    if (!Array.isArray(sessions)) return [];
    const closedTabs = [];
    for (const session of sessions) {
      if (session.tab && session.tab.url && isRealTabUrl(session.tab.url)) {
        closedTabs.push({
          sessionId: session.tab.sessionId,
          title: session.tab.title || session.tab.url || 'Untitled',
          url: session.tab.url,
          favIconUrl: session.tab.favIconUrl || '',
          lastModified: session.lastModified || 0,
        });
      } else if (session.window && Array.isArray(session.window.tabs)) {
        for (const tab of session.window.tabs) {
          if (tab.url && isRealTabUrl(tab.url)) {
            closedTabs.push({
              sessionId: tab.sessionId,
              title: tab.title || tab.url || 'Untitled',
              url: tab.url,
              favIconUrl: tab.favIconUrl || '',
              lastModified: session.lastModified || 0,
            });
            if (closedTabs.length >= maxCount) break;
          }
        }
      }
      if (closedTabs.length >= maxCount) break;
    }
    return closedTabs.slice(0, maxCount);
  } catch (err) {
    console.warn('[tab-out] Failed to fetch recently closed sessions:', err);
    return [];
  }
}

/**
 * renderRecentlyClosedItem(item)
 *
 * Builds HTML for one recently closed tab: favicon, truncated title,
 * domain + relative time, and restore button.
 */
function renderRecentlyClosedItem(item) {
  let domain = '';
  try {
    domain = new URL(item.url).hostname.replace(/^www\./, '');
  } catch {}
  const rawFavicon = getFaviconUrl(item.url);
  const faviconUrl = rawFavicon ? escapeHtml(rawFavicon) : '';
  const ago = item.lastModified ? timeAgo(item.lastModified * 1000) : '';
  const displayTitle = escapeHtml(item.title || item.url || 'Untitled');
  const validUrl = safeUrl(item.url);
  const metaText = escapeHtml(domain ? (domain + (ago ? ' · ' + ago : '')) : ago);

  const reopenTooltip = typeof t === 'function' ? t('saved.reopen_closed') : 'Reopen closed tab';

  return `
    <div class="recently-closed-item" data-action="restore-closed-tab" data-session-id="${escapeHtml(item.sessionId || '')}" data-url="${validUrl}">
      <div class="recently-closed-main">
        <a href="${validUrl}" target="_blank" rel="noopener noreferrer" class="recently-closed-title" title="${displayTitle}" data-action="restore-closed-tab" data-session-id="${escapeHtml(item.sessionId || '')}" data-url="${validUrl}">
          ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="">` : ''}
          <span class="recently-closed-text">${displayTitle}</span>
        </a>
        <span class="recently-closed-meta">${metaText}</span>
      </div>
      <button type="button" class="recently-closed-action-btn restore" data-action="restore-closed-tab" data-session-id="${escapeHtml(item.sessionId || '')}" data-url="${validUrl}" title="${escapeHtml(reopenTooltip)}" aria-label="${escapeHtml(reopenTooltip)}">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
        </svg>
      </button>
    </div>`;
}

let recentlyClosedRenderSeq = 0;

/**
 * renderRecentlyClosedSection()
 *
 * Renders the 5 most recently closed tabs in Column 3.
 * Avoids DOM churn if the generated HTML is unchanged.
 */
async function renderRecentlyClosedSection() {
  const seq = ++recentlyClosedRenderSeq;
  const section = document.getElementById('recentlyClosedSection');
  const list = document.getElementById('recentlyClosedList');
  const countEl = document.getElementById('recentlyClosedCount');
  const emptyEl = document.getElementById('recentlyClosedEmpty');

  if (!section || !list) return;

  try {
    const closedTabs = await getRecentlyClosedTabs(5);
    if (seq !== recentlyClosedRenderSeq) return;

    if (closedTabs.length > 0) {
      if (countEl) countEl.textContent = `(${closedTabs.length})`;
      const html = closedTabs.map(t => renderRecentlyClosedItem(t)).join('');
      renderIfChanged(list, html, 'recentlyClosed');
      list.style.display = 'flex';
      if (emptyEl) emptyEl.style.display = 'none';
      section.style.display = 'block';
    } else {
      if (countEl) countEl.textContent = '';
      list.innerHTML = '';
      resetRenderCache('recentlyClosed');
      list.style.display = 'none';
      section.style.display = 'none';
    }
  } catch (err) {
    console.warn('[tab-out] Failed to render recently closed section:', err);
    section.style.display = 'none';
  }
}

/**
 * restoreClosedTab(sessionId, fallbackUrl)
 *
 * Reopens a closed tab using chrome.sessions.restore(sessionId), restoring
 * navigation history. Falls back to chrome.tabs.create({ url }) if sessions.restore fails.
 */
async function restoreClosedTab(sessionId, fallbackUrl) {
  if (typeof chrome !== 'undefined' && chrome.sessions && typeof chrome.sessions.restore === 'function' && sessionId) {
    try {
      await chrome.sessions.restore(sessionId);
      return;
    } catch (err) {
      console.warn('[tab-out] chrome.sessions.restore failed, falling back to tabs.create:', err);
    }
  }
  if (fallbackUrl && fallbackUrl !== '#' && isRealTabUrl(fallbackUrl) && typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.create === 'function') {
    await chrome.tabs.create({ url: fallbackUrl });
  }
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
let currentRenderSequenceId = 0;

async function renderStaticDashboard(options = {}) {
  if (typeof document === 'undefined') return;
  const skipBackgroundAi = options && options.skipBackgroundAi === true;
  const inMemoryOnly = options && options.inMemoryOnly === true;
  const thisSeq = ++currentRenderSequenceId;

  // --- Ensure perspective settings are loaded ---
  if (!inMemoryOnly) {
    await loadPerspectiveSettings();
    if (thisSeq !== currentRenderSequenceId) return;
  }

  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = typeof t === 'function' ? t('header.active_tabs') : 'Active tabs';
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Fetch tabs ---
  if (!inMemoryOnly || !openTabs || openTabs.length === 0) {
    await fetchOpenTabs();
    if (thisSeq !== currentRenderSequenceId) return;
  }
  const realTabs = getRealTabs();

  // --- Render Vertical Tabs Rail ---
  renderPerspectiveRail(realTabs);
  updatePerspectiveTelemetry();

  const heroSub = document.getElementById('heroSubtitle');
  if (heroSub) {
    const windowIds = new Set(realTabs.map(t => t.windowId));
    const winCount = windowIds.size || 1;
    if (typeof t === 'function') {
      const windowWord = winCount !== 1 ? t('common.window_plural') : t('common.window_single');
      heroSub.textContent = t('header.tabs_across_windows', {
        tabs: realTabs.length,
        windows: winCount,
        windowWord: windowWord
      });
    } else {
      heroSub.textContent = `${realTabs.length} tab${realTabs.length !== 1 ? 's' : ''} across ${winCount} window${winCount !== 1 ? 's' : ''}`;
    }
  }

  if (activePerspectiveId !== 'domain' && (!isJevActive() || !currentPerspectives.some(p => p.id === activePerspectiveId))) {
    activePerspectiveId = 'domain';
  }

  // Check whether we are in Domain perspective or a custom Semantic perspective
  if (activePerspectiveId !== 'domain' && isJevActive()) {
    // --- SEMANTIC PERSPECTIVE GROUPING (INSTANT 0MS FAST PATH) ---
    const activeP = currentPerspectives.find(p => p.id === activePerspectiveId) || currentPerspectives[0];
    const pid = activeP ? activeP.id : 'domain';
    if (!tabClassificationCache[pid]) {
      tabClassificationCache[pid] = {};
    }
    const cache = tabClassificationCache[pid];
    const semMap = Object.create(null);
    const uncachedTabs = [];

    // Pre-build fast O(1) domain-to-AI-label map lazily only if there are uncached tabs
    let domainAiLabelMap = null;
    const hasUncachedTabs = realTabs.some(tab => {
      const normUrl = normalizeUrlForCache(tab.url) || tab.url || '';
      return normUrl && !getCacheLabel(cache[normUrl]);
    });
    if (hasUncachedTabs) {
      domainAiLabelMap = new Map();
      for (const cachedUrl of Object.keys(cache)) {
        const cEntry = cache[cachedUrl];
        if (getCacheSource(cEntry) === 'ai') {
          const host = extractHostname(cachedUrl);
          if (host && !MULTI_TOPIC_DOMAINS.has(host) && !domainAiLabelMap.has(host)) {
            domainAiLabelMap.set(host, getCacheLabel(cEntry));
          }
        }
      }
    }

    // Instant Fast Path: Group immediately from cache without waiting for network
    for (const tab of realTabs) {
      const normUrl = normalizeUrlForCache(tab.url) || tab.url || '';
      if (!normUrl) continue;

      let entry = cache[normUrl];
      let label = getCacheLabel(entry);
      const isFailedRecently = entry?.lastAiAttempt && (Date.now() - entry.lastAiAttempt < (entry.cooldownMs || 15000));
      const inFlightKey = `${pid}:${normUrl}`;

      if (!label) {
        const host = extractHostname(tab.url);
        const domainAiLabel = (domainAiLabelMap && !MULTI_TOPIC_DOMAINS.has(host) && domainAiLabelMap.get(host)) || null;
        if (domainAiLabel) {
          label = domainAiLabel;
          cache[normUrl] = { label, source: 'domain-ai', timestamp: Date.now() };
          // domain-ai serves as instant 0ms placeholder; queue for background Jev AI refinement
          if (!tab.incognito && !skipBackgroundAi && !inFlightUrls.has(inFlightKey) && !isFailedRecently) {
            uncachedTabs.push(tab);
          }
        } else {
          // If no domain-level AI cache exists, assign perspective fallback label ('Khác') while awaiting true Jev AI pass
          const fallbackObj = (activeP?.labels || []).find(l => isFallbackLabel(getLabelName(l)));
          label = fallbackObj ? getLabelName(fallbackObj) : 'Khác';
          if (!tab.incognito && !skipBackgroundAi && !inFlightUrls.has(inFlightKey) && !isFailedRecently) {
            uncachedTabs.push(tab);
          }
        }
      } else if (!['ai', 'ai-low-confidence'].includes(getCacheSource(entry))) {
        // Upgrade domain-ai placeholders to true AI in background
        if (!tab.incognito && !skipBackgroundAi && !inFlightUrls.has(inFlightKey) && !isFailedRecently) {
          uncachedTabs.push(tab);
        }
      }

      if (!semMap[label]) {
        semMap[label] = { domain: `perspective:${label}`, label, isSemantic: true, tabs: [] };
      }
      semMap[label].tabs.push(tab);
    }

    domainGroups = Object.values(semMap).sort((a, b) => {
      const aIsOther = isFallbackLabel(a.label);
      const bIsOther = isFallbackLabel(b.label);
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
      ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' && Array.isArray(LOCAL_LANDING_PAGE_PATTERNS) ? LOCAL_LANDING_PAGE_PATTERNS : []),
    ];

    function isLandingPage(parsed, url) {
      if (!parsed) return false;
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
    }

    domainGroups = [];
    const groupMap    = Object.create(null);
    const landingTabs = [];
    const customGroups = (typeof LOCAL_CUSTOM_GROUPS !== 'undefined' && Array.isArray(LOCAL_CUSTOM_GROUPS)) ? LOCAL_CUSTOM_GROUPS : [];

    const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
    const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
    function isLandingDomain(domain) {
      if (landingHostnames.has(domain)) return true;
      return landingSuffixes.some(s => domain.endsWith(s));
    }

    function matchCustomGroup(parsed) {
      if (!parsed) return null;
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
    }

    for (const tab of realTabs) {
      try {
        let parsed = null;
        let isFile = false;
        if (tab.url && tab.url.startsWith('file://')) {
          isFile = true;
        } else {
          try { parsed = new URL(tab.url); } catch {}
        }

        if (parsed && isLandingPage(parsed, tab.url)) {
          landingTabs.push(tab);
          continue;
        }

        const customRule = parsed ? matchCustomGroup(parsed) : null;
        if (customRule) {
          const key = customRule.groupKey;
          if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, isPriority: isLandingDomain(key), tabs: [] };
          groupMap[key].tabs.push(tab);
          continue;
        }

        let hostname = isFile ? 'local-files' : (parsed?.hostname || null);
        if (!hostname) continue;

        if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, isPriority: isLandingDomain(hostname), tabs: [] };
        groupMap[hostname].tabs.push(tab);
      } catch {}
    }

    if (landingTabs.length > 0) {
      groupMap['__landing-pages__'] = { domain: '__landing-pages__', isPriority: false, tabs: landingTabs };
    }

    domainGroups = Object.values(groupMap).sort((a, b) => {
      const aIsLanding = a.domain === '__landing-pages__';
      const bIsLanding = b.domain === '__landing-pages__';
      if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

      const aIsPriority = a.isPriority;
      const bIsPriority = b.isPriority;
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
    const viewTitle = isDomainView
      ? (typeof t === 'function' ? t('tabs.section_title') : 'Open tabs')
      : (activeP ? getPerspectiveDisplayName(activeP) : (typeof t === 'function' ? t('tabs.section_title') : 'Open tabs'));
    const totalLabels = (!isDomainView && activeP?.labels?.length) || 0;
    const countLabel = isDomainView
      ? (typeof t === 'function'
          ? `${domainGroups.length} ${domainGroups.length !== 1 ? t('tabs.domains_local_plural') : t('tabs.domains_local_single')}`
          : `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} · Local`)
      : (totalLabels > 0
          ? (typeof t === 'function'
              ? t('tabs.categories_of', { visible: domainGroups.length, total: Math.max(totalLabels, domainGroups.length) })
              : `${domainGroups.length} of ${Math.max(totalLabels, domainGroups.length)} categories`)
          : (typeof t === 'function'
              ? `${domainGroups.length} ${domainGroups.length !== 1 ? t('tabs.categories_plural') : t('tabs.categories_single')}`
              : `${domainGroups.length} categor${domainGroups.length !== 1 ? 'ies' : 'y'}`));

    const recentTabs = getRecentTabs(realTabs, { limit: 5 });
    const lastActiveTab = recentTabs.length > 0 ? recentTabs[0] : null;
    renderRecentSidebarCard(recentTabs);
    renderQuickReturnBar(recentTabs);
    if (domainGroups.length > 0) {
      if (openTabsSectionTitle) openTabsSectionTitle.textContent = viewTitle;
      if (openTabsSectionCount) openTabsSectionCount.textContent = countLabel;
      renderOpenTabsHeaderActions(realTabs);
      if (thisSeq !== currentRenderSequenceId) return;
      if (openTabsMissionsEl) {
        const activeConfirmings = [];
        openTabsMissionsEl.querySelectorAll('.confirming').forEach(el => {
          activeConfirmings.push({
            action: el.dataset.action,
            domain: el.dataset.domain,
            id: el.dataset.id,
            html: el.innerHTML,
            originalHtml: el.dataset.originalHtml,
            timeout: el.dataset.confirmTimeout
          });
        });
        const newHtml = domainGroups.map(g => renderDomainCard(g, lastActiveTab)).join('');
        const changed = renderIfChanged(openTabsMissionsEl, newHtml, 'missions');
        if (changed && activeConfirmings.length > 0) {
          activeConfirmings.forEach(item => {
            const btn = Array.from(openTabsMissionsEl.querySelectorAll(`[data-action="${item.action}"]`)).find(el => {
              if (item.domain && el.dataset.domain !== item.domain) return false;
              if (item.id && el.dataset.id !== item.id) return false;
              return true;
            });
            if (btn) {
              if (item.timeout) clearTimeout(parseInt(item.timeout, 10));
              btn.classList.add('confirming');
              btn.innerHTML = item.html;
              if (item.originalHtml) btn.dataset.originalHtml = item.originalHtml;
              const newTimeout = setTimeout(() => {
                if (btn.isConnected) {
                  btn.classList.remove('confirming');
                  btn.innerHTML = btn.dataset.originalHtml || item.originalHtml || '';
                  delete btn.dataset.originalHtml;
                  delete btn.dataset.confirmTimeout;
                }
              }, 4000);
              btn.dataset.confirmTimeout = String(newTimeout);
            }
          });
        }
      }
      renderPerspectiveTagsBar(domainGroups);
    } else {
      if (openTabsSectionTitle) openTabsSectionTitle.textContent = viewTitle;
      if (openTabsSectionCount) openTabsSectionCount.textContent = isDomainView
        ? (typeof t === 'function' ? `0 ${t('tabs.domains_local_plural')}` : '0 domains · Local')
        : (typeof t === 'function' ? `0 ${t('tabs.categories_plural')}` : '0 categories');
      renderOpenTabsHeaderActions([]);
      if (thisSeq !== currentRenderSequenceId) return;
      if (openTabsMissionsEl) {
        const emptyTitle = typeof t === 'function' ? t('tabs.all_closed_title') : 'All tabs closed';
        const emptyDesc = typeof t === 'function' ? t('tabs.all_closed_desc') : 'Clean workspace';
        const emptyHtml = `
          <div class="missions-empty-state">
            <div class="empty-title">${escapeHtml(emptyTitle)}</div>
            <div class="empty-subtitle">${escapeHtml(emptyDesc)}</div>
          </div>
        `;
        renderIfChanged(openTabsMissionsEl, emptyHtml, 'missions');
      }
      renderPerspectiveTagsBar([]);
    }
    openTabsSection.style.display = 'block';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = realTabs.length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();
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
  await renderRecentlyClosedSection();
}

/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

if (typeof document !== 'undefined') {
  // User interaction lock: track when mouse is pressed down to prevent background sync from detaching click targets
  document.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
      startUserInteraction();
    }
  }, true);

  document.addEventListener('mouseup', releaseUserInteraction, true);
  document.addEventListener('dragend', releaseUserInteraction, true);
  document.addEventListener('drop', releaseUserInteraction, true);
  document.addEventListener('contextmenu', releaseUserInteraction, true);
  if (typeof window !== 'undefined') {
    window.addEventListener('blur', releaseUserInteraction);
    window.addEventListener('pointercancel', releaseUserInteraction);
  }

  // Auto-close popover when keyboard focus leaves the picker
  document.addEventListener('focusout', (e) => {
    const wrap = e.target.closest?.('.tag-color-picker-wrap');
    if (wrap && (!e.relatedTarget || !wrap.contains(e.relatedTarget))) {
      const popover = wrap.querySelector('.tag-color-popover');
      if (popover) popover.style.display = 'none';
      const btn = wrap.querySelector('.tag-color-btn');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
  });

  let isClosingAllTabs = false;
  let previousModalFocus = null;

  function restoreModalFocus() {
    if (previousModalFocus && typeof previousModalFocus.focus === 'function') {
      try {
        if (previousModalFocus.isConnected) {
          previousModalFocus.focus();
        } else {
          const fallback = document.querySelector('.perspective-tab.active') || document.getElementById('openPerspectiveModalBtn');
          fallback?.focus?.();
        }
      } catch {}
    }
    previousModalFocus = null;
  }
  document.addEventListener('click', async (e) => {
    // If clicking outside color popover, close open popovers
    if (!e.target.closest('.tag-color-picker-wrap')) {
      document.querySelectorAll('.tag-color-popover').forEach(p => { p.style.display = 'none'; });
      document.querySelectorAll('.tag-color-btn').forEach(b => { b.setAttribute('aria-expanded', 'false'); });
    }

    // Swatch selection inside color popover
    const swatchEl = e.target.closest('.tag-color-swatch');
    if (swatchEl) {
      e.stopPropagation();
      const row = swatchEl.closest('.tag-row');
      const popover = swatchEl.closest('.tag-color-popover');
      const colorBtn = row?.querySelector('.tag-color-btn');
      const indicator = colorBtn?.querySelector('.tag-color-dot-indicator');
      const color = swatchEl.dataset.color || '';
      if (row) {
        row.dataset.tagColor = color;
        row.setAttribute('data-tag-color', color);
      }
      popover?.querySelectorAll('.tag-color-swatch').forEach(s => {
        const isCur = (s === swatchEl);
        s.classList.toggle('active', isCur);
        s.setAttribute('aria-checked', isCur ? 'true' : 'false');
      });

      if (indicator) {
        const resolved = resolveTagColor(color);
        if (resolved) {
          indicator.className = 'tag-color-dot-indicator';
          indicator.style.backgroundColor = resolved.hex;
          indicator.style.borderColor = resolved.hex;
        } else {
          indicator.className = 'tag-color-dot-indicator none';
          indicator.style.backgroundColor = '';
          indicator.style.borderColor = '';
        }
      }
      if (popover) popover.style.display = 'none';
      if (colorBtn) {
        colorBtn.setAttribute('aria-expanded', 'false');
        colorBtn.focus();
      }
      return;
    }

    // Walk up the DOM to find the nearest element with data-action or #archiveToggle
    const actionEl = e.target.closest('[data-action], #archiveToggle');
    if (!actionEl) return;

  const action = actionEl.dataset.action || (actionEl.id === 'archiveToggle' ? 'toggle-archive' : '');

  // ---- Switch active perspective tab ----
  if (action === 'switch-perspective') {
    const pid = actionEl.dataset.perspectiveId;
    if (pid) {
      await switchPerspective(pid);
    }
    return;
  }

  // ---- Scroll to specific category card from pill click ----
  if (action === 'scroll-to-tag') {
    e.stopPropagation();
    const targetTag = actionEl.dataset.targetTag;
    if (!targetTag) return;
    const targetCard = Array.from(document.querySelectorAll('.mission-card')).find(c => c.dataset.category === targetTag) || null;
    if (targetCard) {
      if (typeof targetCard.scrollIntoView === 'function') {
        const isReduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        try { targetCard.scrollIntoView({ behavior: isReduced ? 'auto' : 'smooth', block: 'nearest' }); } catch {}
      }
      targetCard.classList.remove('target-highlight');
      void targetCard.offsetWidth;
      targetCard.classList.add('target-highlight');
      setTimeout(() => {
        try { targetCard?.classList.remove('target-highlight'); } catch {}
      }, 1300);
    }
    return;
  }

  // ---- Open New Perspective Modal ----
  if (action === 'open-perspective-modal') {
    previousModalFocus = document.activeElement;
    const overlay = document.getElementById('perspectiveModalOverlay');
    const modalTitle = document.getElementById('perspectiveModalTitle');
    const editId = document.getElementById('perspectiveEditId');
    const nameInput = document.getElementById('perspectiveNameInput');
    const delBtn = document.getElementById('perspectiveDeleteBtn');
    const tagsContainer = document.getElementById('perspectiveTagsContainer');

    if (overlay) {
      const form = document.getElementById('perspectiveForm');
      if (form) form.dataset.templateIcon = '';
      if (modalTitle) modalTitle.textContent = typeof t === 'function' ? t('modal.perspective.title_new') : 'New Perspective';
      if (editId) editId.value = '';
      if (nameInput) nameInput.value = '';
      const resetBtn = document.getElementById('perspectiveResetDefaultBtn');
      if (resetBtn) resetBtn.style.display = 'none';
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
    previousModalFocus = document.activeElement;
    const pid = actionEl.dataset.perspectiveId;
    const p = currentPerspectives.find(item => item.id === pid);
    if (!p) return;

    const overlay = document.getElementById('perspectiveModalOverlay');
    const modalTitle = document.getElementById('perspectiveModalTitle');
    const editId = document.getElementById('perspectiveEditId');
    const nameInput = document.getElementById('perspectiveNameInput');
    const delBtn = document.getElementById('perspectiveDeleteBtn');
    const resetBtn = document.getElementById('perspectiveResetDefaultBtn');
    const tagsContainer = document.getElementById('perspectiveTagsContainer');

    if (overlay) {
      const pDisplayName = getPerspectiveDisplayName(p);
      if (modalTitle) modalTitle.textContent = typeof t === 'function' ? t('modal.perspective.title_edit', { name: pDisplayName }) : `Edit Perspective: ${p.name}`;
      if (editId) editId.value = p.id;
      if (nameInput) nameInput.value = p.name;
      if (delBtn) delBtn.style.display = p.isSystem ? 'none' : 'inline-flex';
      const isDefault = DEFAULT_PERSPECTIVES.some(dp => dp.id === p.id && !dp.isSystem) || Boolean(PERSPECTIVE_TEMPLATES && p.id && !isDangerousKey(p.id) && Object.prototype.hasOwnProperty.call(PERSPECTIVE_TEMPLATES, p.id));
      if (resetBtn) resetBtn.style.display = isDefault ? 'inline-flex' : 'none';
      if (tagsContainer) {
        tagsContainer.innerHTML = '';
        const normalized = normalizeLabels(p.labels);
        const userTags = normalized.filter(t => !isFallbackLabel(t.name));
        if (userTags.length > 0) {
          userTags.forEach(tag => addTagRowToModal(tag.name, tag.description, false, tag.color));
        } else {
          addTagRowToModal('', '');
        }
      }
      overlay.style.display = 'flex';
      setTimeout(() => nameInput?.focus(), 50);
    }
    return;
  }

  // ---- Reset Perspective to Defaults ----
  if (action === 'reset-perspective-default') {
    e.stopPropagation();
    const editId = document.getElementById('perspectiveEditId')?.value;
    let defaultP = DEFAULT_PERSPECTIVES.find(dp => dp.id === editId);
    if (!defaultP && typeof PERSPECTIVE_TEMPLATES !== 'undefined' && editId && !isDangerousKey(editId) && Object.prototype.hasOwnProperty.call(PERSPECTIVE_TEMPLATES, editId)) {
      const currentLang = typeof TabOutI18n !== 'undefined' ? TabOutI18n.getLanguage() : 'en';
      defaultP = getPerspectiveTemplate(editId, currentLang);
    }
    if (!defaultP) return;

    const tagsContainer = document.getElementById('perspectiveTagsContainer');
    const nameInput = document.getElementById('perspectiveNameInput');
    if (nameInput) nameInput.value = defaultP.name;
    if (tagsContainer) {
      tagsContainer.innerHTML = '';
      const normalized = normalizeLabels(defaultP.labels);
      const userTags = normalized.filter(t => !isFallbackLabel(t.name));
      userTags.forEach(tag => addTagRowToModal(tag.name, tag.description, false, tag.color));
    }
    showToast(typeof t === 'function' ? t('toast.tags_reset') : 'Reset to default tag list');
    return;
  }

  // ---- Apply Perspective Template ----
  if (action === 'apply-template-topic' || action === 'apply-template-purpose' || action === 'apply-template-priority') {
    e.stopPropagation();
    const templateType = action.replace('apply-template-', '');
    const currentLang = typeof TabOutI18n !== 'undefined' ? TabOutI18n.getLanguage() : 'en';
    const tpl = getPerspectiveTemplate(templateType, currentLang);
    if (!tpl) return;

    const nameInput = document.getElementById('perspectiveNameInput');
    const tagsContainer = document.getElementById('perspectiveTagsContainer');
    if (nameInput) {
      nameInput.value = tpl.name;
    }
    const form = document.getElementById('perspectiveForm');
    if (form) form.dataset.templateIcon = tpl.icon;
    if (tagsContainer) {
      tagsContainer.innerHTML = '';
      const userTags = tpl.labels.filter(t => !isFallbackLabel(t.name));
      if (userTags.length > 0) {
        userTags.forEach(tag => addTagRowToModal(tag.name, tag.description || '', false, tag.color));
      } else {
        addTagRowToModal('', '');
      }
    }
    return;
  }

  // ---- Toggle Tag Color Popover ----
  if (action === 'toggle-tag-color-picker') {
    e.stopPropagation();
    const wrap = actionEl.closest('.tag-color-picker-wrap');
    const popover = wrap?.querySelector('.tag-color-popover');
    if (!popover) return;
    const isShowing = popover.style.display !== 'none';
    document.querySelectorAll('.tag-color-popover').forEach(p => { p.style.display = 'none'; });
    document.querySelectorAll('.tag-color-btn').forEach(b => { b.setAttribute('aria-expanded', 'false'); });
    if (!isShowing) {
      popover.style.display = 'flex';
      actionEl.setAttribute('aria-expanded', 'true');
      const activeSwatch = popover.querySelector('.tag-color-swatch.active') || popover.querySelector('.tag-color-swatch');
      activeSwatch?.focus();
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
        row.dataset.tagColor = '';
        row.setAttribute('data-tag-color', '');
        const indicator = row.querySelector('.tag-color-dot-indicator');
        if (indicator) {
          indicator.className = 'tag-color-dot-indicator none';
          indicator.style.backgroundColor = '';
          indicator.style.borderColor = '';
        }
        row.querySelectorAll('.tag-color-swatch').forEach(s => {
          const isNone = s.classList.contains('none-swatch');
          s.classList.toggle('active', isNone);
          s.setAttribute('aria-checked', isNone ? 'true' : 'false');
        });
        if (nameInput) nameInput.focus();
      } else {
        row.remove();
      }
    }
    return;
  }

  // ---- Close Confirm Modal ----
  if (action === 'close-confirm-modal') {
    const cancelBtn = document.getElementById('confirmModalCancelBtn');
    if (cancelBtn && actionEl !== cancelBtn) {
      cancelBtn.click();
    } else {
      const overlay = document.getElementById('confirmModalOverlay');
      if (overlay) overlay.style.display = 'none';
    }
    return;
  }

  // ---- Close Perspective Modal ----
  if (action === 'close-perspective-modal') {
    const overlay = document.getElementById('perspectiveModalOverlay');
    if (overlay) overlay.style.display = 'none';
    restoreModalFocus();
    return;
  }

  // ---- Delete Perspective ----
  if (action === 'delete-perspective') {
    const editId = document.getElementById('perspectiveEditId')?.value;
    if (!editId || isDangerousKey(editId)) return;

    const targetPerspective = currentPerspectives.find(p => p.id === editId);
    if (!targetPerspective || targetPerspective.isSystem) return;

    const pName = targetPerspective.name || '';
    const confirmed = await showConfirmDialog({
      title: typeof t === 'function' ? t('modal.perspective.delete_title', { name: pName }) : `Delete perspective "${pName}"?`,
      description: typeof t === 'function' ? t('modal.perspective.delete_desc') : 'All custom tags and AI classification data for this perspective will be permanently removed.',
      confirmText: typeof t === 'function' ? t('modal.perspective.delete_confirm') : 'Delete permanently',
      cancelText: typeof t === 'function' ? t('modal.perspective.delete_keep') : 'Keep',
      danger: true
    });
    if (!confirmed) return;

    currentPerspectives = currentPerspectives.filter(p => p.id !== editId);
    if (activeClassificationAbortController) {
      try { activeClassificationAbortController.abort(); } catch {}
      activeClassificationAbortController = null;
    }
    if (activePerspectiveId === editId) {
      activePerspectiveId = 'domain';
    }
    if (tabClassificationCache[editId]) {
      delete tabClassificationCache[editId];
    }
    setLocalSettingLock(400);
    await enqueueStorageWrite(async () => {
      await chrome.storage.local.remove([`tabClassificationCache_${editId}`]);
      const freshRes = await chrome.storage.local.get(['tabClassificationCache']);
      const freshMonolithic = (freshRes.tabClassificationCache && typeof freshRes.tabClassificationCache === 'object' && !Array.isArray(freshRes.tabClassificationCache))
        ? freshRes.tabClassificationCache
        : {};
      if (editId && !isDangerousKey(editId)) {
        delete freshMonolithic[editId];
      }
      await chrome.storage.local.set({
        perspectives: currentPerspectives,
        activePerspectiveId,
        tabClassificationCache: freshMonolithic
      });
    });

    const overlay = document.getElementById('perspectiveModalOverlay');
    if (overlay) overlay.style.display = 'none';
    restoreModalFocus();

    await renderStaticDashboard();
    showToast(typeof t === 'function' ? t('toast.perspective_deleted') : 'Perspective deleted');
    return;
  }

  // ---- Open API Key / Settings Modal ----
  if (action === 'open-api-key-modal') {
    previousModalFocus = document.activeElement;
    const overlay = document.getElementById('apiKeyModalOverlay');
    const keyInput = document.getElementById('apiKeyInput');
    const langSelect = document.getElementById('settingsLanguageSelect');
    if (overlay) {
      if (keyInput) keyInput.value = openRouterApiKey || '';
      if (langSelect && typeof TabOutI18n !== 'undefined') {
        langSelect.value = TabOutI18n.getLanguage();
      }
      overlay.style.display = 'flex';
      setTimeout(() => (langSelect || keyInput)?.focus(), 50);
    }
    return;
  }

  // ---- Close API Key Modal ----
  if (action === 'close-api-key-modal') {
    const overlay = document.getElementById('apiKeyModalOverlay');
    if (overlay) overlay.style.display = 'none';
    restoreModalFocus();
    return;
  }

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    if (actionEl.dataset.inFlight) return;
    actionEl.dataset.inFlight = 'true';
    try {
      isTabOutDupeDismissed = false;
      await closeTabOutDupes();
      const banner = document.getElementById('tabOutDupeBanner');
      if (banner) {
        banner.classList.add('removing');
        setTimeout(() => {
          banner.style.display = 'none';
          banner.classList.remove('removing');
        }, 200);
      }
      showToast(typeof t === 'function' ? t('toast.closed_extras') : 'Closed extra Tab Out tabs');
    } finally {
      delete actionEl.dataset.inFlight;
    }
    return;
  }

  // ---- Dismiss duplicate Tab Out tabs pill ----
  if (action === 'dismiss-tabout-dupes') {
    isTabOutDupeDismissed = true;
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.classList.add('removing');
      setTimeout(() => {
        banner.style.display = 'none';
        banner.classList.remove('removing');
      }, 200);
    }
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
    const tabId = actionEl.dataset.tabId ? Number(actionEl.dataset.tabId) : undefined;
    if (tabId || tabUrl) await focusTab(tabUrl, tabId);
    return;
  }

  // ---- Dismiss Quick Return bar ----
  if (action === 'dismiss-quick-return') {
    isQuickReturnDismissed = true;
    const bar = document.getElementById('quickReturnBar');
    if (bar) {
      bar.classList.add('removing');
      setTimeout(() => {
        bar.style.display = 'none';
        bar.innerHTML = '';
        bar.classList.remove('removing');
      }, 150);
    }
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const chip = actionEl.closest('.page-chip');
    if (chip && (chip.classList.contains('removing') || chip.dataset.inFlight)) return;
    if (actionEl.dataset.inFlight) return;
    actionEl.dataset.inFlight = 'true';
    if (chip) chip.dataset.inFlight = 'true';
    try {
      const tabUrl = actionEl.dataset.tabUrl;
      if (!tabUrl) return;

      // Close one tab matching this URL in Chrome (preferring current window)
      let removedId = null;
      let closedTab = null;
      try {
        const allTabs = await chrome.tabs.query({});
        let currentWindow = null;
        try {
          if (chrome.windows?.getCurrent) {
            currentWindow = await chrome.windows.getCurrent();
          }
        } catch {}
        const targetTabId = (chip?.dataset.tabId && Number(chip.dataset.tabId)) || (actionEl.dataset.tabId && Number(actionEl.dataset.tabId)) || null;
        const match = (targetTabId && allTabs.find(t => t.id === targetTabId))
                   || allTabs.find(t => t.url === tabUrl && t.windowId === currentWindow?.id)
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
              if (isRealTabUrl(closedTab.url)) {
                await chrome.tabs.create({ url: closedTab.url, active: false });
              }
              await fetchOpenTabs();
              await renderAll();
              const restoredNamed = typeof t === 'function'
                ? t('toast.tab_restored_named', { title: closedTab.title || friendlyDomain(closedTab.url) })
                : `Restored "${closedTab.title || friendlyDomain(closedTab.url)}"`;
              showToast(restoredNamed);
            } catch (err) {
              console.warn('[tab-out] Failed to restore tab:', err);
            }
          }
        });
      } else {
        showToast(typeof t === 'function' ? t('toast.tab_closed') : 'Tab closed');
      }
    } finally {
      delete actionEl.dataset.inFlight;
      if (chip) delete chip.dataset.inFlight;
    }
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const chip = actionEl.closest('.page-chip');
    if (chip && (chip.classList.contains('removing') || chip.dataset.inFlight)) return;
    if (actionEl.dataset.inFlight) return;
    actionEl.dataset.inFlight = 'true';
    if (chip) chip.dataset.inFlight = 'true';
    try {
      const tabUrl   = actionEl.dataset.tabUrl;
      const tabTitle = actionEl.dataset.tabTitle || tabUrl;
      if (!tabUrl || !isRealTabUrl(tabUrl)) return;
      if (chip) chip.classList.add('removing');

      // Save to chrome.storage.local
      try {
        await saveTabForLater({ url: tabUrl, title: tabTitle });
      } catch (err) {
        if (chip) chip.classList.remove('removing');
        console.error('[tab-out] Failed to save tab:', err);
        showToast(typeof t === 'function' ? t('toast.tab_save_failed') : 'Failed to save tab');
        return;
      }

      // Close one tab matching this URL in Chrome (preferring current window)
      let removedId = null;
      try {
        const allTabs = await chrome.tabs.query({});
        let currentWindow = null;
        try {
          if (chrome.windows?.getCurrent) {
            currentWindow = await chrome.windows.getCurrent();
          }
        } catch {}
        const targetTabId = (chip?.dataset.tabId && Number(chip.dataset.tabId)) || (actionEl.dataset.tabId && Number(actionEl.dataset.tabId)) || null;
        const match = (targetTabId && allTabs.find(t => t.id === targetTabId))
                   || allTabs.find(t => t.url === tabUrl && t.windowId === currentWindow?.id)
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

      const parentCard = chip ? chip.closest('.mission-card') : null;
      const currentCount = parseInt(chip?.dataset.tabCount || '1', 10);

      if (chip && currentCount > 1) {
        chip.classList.remove('removing');
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

      showToast(typeof t === 'function' ? t('toast.saved_for_later') : 'Saved for later');
    } finally {
      delete actionEl.dataset.inFlight;
      if (chip) delete chip.dataset.inFlight;
    }
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
    savePromise.catch(() => {});

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
      const confirmDismissTitle = typeof t === 'function' ? t('saved.dismiss_confirm_title') : 'Click again to confirm dismiss';
      const confirmDismissText = typeof t === 'function' ? t('saved.dismiss_confirm') : 'Dismiss?';
      actionEl.title = confirmDismissTitle;
      actionEl.setAttribute('aria-label', confirmDismissTitle);
      const originalHtml = actionEl.innerHTML;
      actionEl.dataset.originalHtml = originalHtml;
      actionEl.innerHTML = `<span class="confirm-inline-label">${escapeHtml(confirmDismissText)}</span>`;

      const timeoutId = setTimeout(() => {
        const liveBtn = actionEl.isConnected ? actionEl : Array.from(document.querySelectorAll('[data-action="dismiss-deferred"]')).find(b => b.dataset.deferredId === id);
        if (liveBtn) {
          liveBtn.classList.remove('confirming');
          liveBtn.innerHTML = liveBtn.dataset.originalHtml || originalHtml;
          const dismissText = typeof t === 'function' ? t('saved.item_dismiss') : 'Dismiss';
          liveBtn.title = dismissText;
          liveBtn.setAttribute('aria-label', dismissText);
          delete liveBtn.dataset.originalHtml;
          delete liveBtn.dataset.confirmTimeout;
        }
      }, 3500);
      actionEl.dataset.confirmTimeout = String(timeoutId);
      return;
    }

    clearTimeout(parseInt(actionEl.dataset.confirmTimeout || '0', 10));
    actionEl.classList.remove('confirming');

    animatingDeferredIds.add(id);
    let itemSnapshot = null;
    let failed = false;
    try {
      itemSnapshot = await dismissSavedTab(id);
    } catch (err) {
      failed = true;
      console.error('Failed to dismiss deferred tab:', err);
    }

    if (failed || !item) {
      animatingDeferredIds.delete(id);
      if (animatingDeferredIds.size === 0) {
        renderDeferredColumn();
      }
    } else {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        animatingDeferredIds.delete(id);
        if (animatingDeferredIds.size === 0) {
          renderDeferredColumn();
        }
      }, 160);
    }

    if (itemSnapshot) {
      pushUndoAction({
        description: typeof t === 'function' ? t('undo.saved_dismissed') : 'Saved tab dismissed',
        onUndo: async () => {
          await mutateDeferred(deferred => {
            if (!deferred.some(t => t && t.id !== undefined && String(t.id) === String(itemSnapshot.id))) {
              deferred.unshift(itemSnapshot);
            }
            return deferred;
          });
          await renderDeferredColumn();
          updateHeaderAndStats();
          showToast(typeof t === 'function' ? t('toast.tab_restored') : 'Restored tab');
        }
      });
    } else {
      showToast(typeof t === 'function' ? t('undo.saved_dismissed') : 'Saved tab dismissed');
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
      const confirmCloseText = count === 1
        ? (typeof t === 'function' ? t('tabs.close_single_tab_confirm') : 'Close tab?')
        : (typeof t === 'function' ? t('tabs.close_group_confirm', { count }) : `Close ${count} tabs?`);
      actionEl.innerHTML = `${ICONS.close} ${escapeHtml(confirmCloseText)}`;

      const timeoutId = setTimeout(() => {
        const liveBtn = actionEl.isConnected ? actionEl : Array.from(document.querySelectorAll('[data-action="close-domain-tabs"]')).find(b => b.dataset.domain === domain);
        if (liveBtn) {
          liveBtn.classList.remove('confirming');
          liveBtn.innerHTML = liveBtn.dataset.originalHtml || originalHtml;
          delete liveBtn.dataset.originalHtml;
          delete liveBtn.dataset.confirmTimeout;
        }
      }, 4000);
      actionEl.dataset.confirmTimeout = String(timeoutId);
      return;
    }

    if (actionEl.dataset.inFlight) return;
    actionEl.dataset.inFlight = 'true';
    try {
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
      if (domain) expandedDomains.delete(domain);

      const groupLabel = group.domain === '__landing-pages__' ? (typeof t === 'function' ? t('tabs.landing_pages') : 'Homepages') : (group.label || friendlyDomain(group.domain));
      if (closedTabsSnapshot.length > 0) {
        pushUndoAction({
          description: typeof t === 'function'
            ? t('undo.closed_tabs_from', { count: closedTabsSnapshot.length, domain: groupLabel })
            : `Closed ${closedTabsSnapshot.length} tab${closedTabsSnapshot.length !== 1 ? 's' : ''} from ${groupLabel}`,
          onUndo: async () => {
            try {
              const validUrls = closedTabsSnapshot.filter(t => t.url && isRealTabUrl(t.url));
              await Promise.all(validUrls.map(t => chrome.tabs.create({ url: t.url, active: false }).catch(() => null)));
              await fetchOpenTabs();
              await renderAll();
              const restoredToast = typeof t === 'function'
                ? t('toast.tabs_restored_domain', { count: closedTabsSnapshot.length, domain: groupLabel })
                : `Restored ${closedTabsSnapshot.length} tabs from ${groupLabel}`;
              showToast(restoredToast);
            } catch (err) {
              console.warn('[tab-out] Failed to restore domain tabs:', err);
            }
          }
        });
      } else {
        const closedToast = typeof t === 'function'
          ? t('toast.tabs_closed_domain', { count: validTabIds.length, domain: groupLabel })
          : `Closed ${validTabIds.length} tab${validTabIds.length !== 1 ? 's' : ''} from ${groupLabel}`;
        showToast(closedToast);
      }

      updateHeaderAndStats();
    } finally {
      delete actionEl.dataset.inFlight;
    }
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    if (actionEl.dataset.inFlight) return;
    actionEl.dataset.inFlight = 'true';
    try {
      const rawDupeData = actionEl.dataset.dupeUrls || '';
      let urls = [];
      if (rawDupeData.startsWith('[')) {
        try {
          urls = JSON.parse(rawDupeData);
        } catch {}
      } else {
        urls = rawDupeData.split(',').map(u => {
          try {
            return decodeURIComponent(u);
          } catch {
            return u;
          }
        });
      }
      urls = (Array.isArray(urls) ? urls : []).filter(Boolean);
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
      showToast(typeof t === 'function' ? t('toast.closed_dupes') : 'Closed duplicates, kept one copy each');
    } finally {
      delete actionEl.dataset.inFlight;
    }
    return;
  }

  // ---- Close ALL open tabs (with modal confirmation) ----
  if (action === 'close-all-open-tabs') {
    if (isClosingAllTabs) return;
    isClosingAllTabs = true;
    try {
      const realTabs = getRealTabs();
      const count = realTabs.length;
      if (count === 0) return;

      const windowIds = new Set(realTabs.map(t => t.windowId));
      const winCount = windowIds.size || 1;
      const windowScopeText = winCount > 1
        ? (typeof t === 'function' ? t('dialog.scope_across_windows', { count: winCount }) : `across all ${winCount} windows`)
        : (typeof t === 'function' ? t('dialog.scope_this_window') : 'in this window');

      const confirmed = await showConfirmDialog({
        title: typeof t === 'function' ? t('dialog.close_all_title', { count }) : `Close all ${count} tabs?`,
        description: typeof t === 'function'
          ? t('dialog.close_all_desc', { count, scope: windowScopeText })
          : `You are about to close all ${count} open tabs ${windowScopeText}. Unsaved forms and page states will be closed.`,
        confirmText: typeof t === 'function' ? t('dialog.close_all_confirm', { count }) : `Close all ${count} tabs`,
        cancelText: typeof t === 'function' ? t('modal.confirm.cancel') : 'Cancel',
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
          description: typeof t === 'function' ? t('undo.closed_all_tabs') : `Closed all ${closedTabsSnapshot.length} tabs`,
          onUndo: async () => {
            try {
              const validUrls = closedTabsSnapshot.filter(t => t.url && isRealTabUrl(t.url));
              await Promise.all(validUrls.map(t => chrome.tabs.create({ url: t.url, active: false }).catch(() => null)));
              await fetchOpenTabs();
              await renderAll();
              showToast(typeof t === 'function' ? t('toast.undo') : `Restored ${closedTabsSnapshot.length} tabs`);
            } catch (err) {
              console.warn('[tab-out] Failed to restore all tabs:', err);
            }
          }
        });
      } else {
        showToast(typeof t === 'function' ? t('toast.all_tabs_closed') : 'All tabs closed. Fresh start.');
      }
    } finally {
      isClosingAllTabs = false;
    }
    return;
  }

  // ---- Unarchive (restore saved tab to active checklist) ----
  if (action === 'unarchive-saved-tab') {
    e.stopPropagation();
    if (actionEl.dataset.inFlight) return;
    actionEl.dataset.inFlight = 'true';
    try {
      const id = actionEl.dataset.archiveId;
      if (!id) return;

      animatingDeferredIds.add(id);
      let itemSnapshot = null;
      try {
        itemSnapshot = await unarchiveSavedTab(id);
        const item = actionEl.closest('.archive-item');
        if (item) item.remove();
        await renderDeferredColumn();
        updateHeaderAndStats();
      } finally {
        animatingDeferredIds.delete(id);
      }

      if (itemSnapshot) {
        pushUndoAction({
          description: typeof t === 'function' ? t('toast.tab_restored') : 'Restored to Saved for later',
          onUndo: async () => {
            try {
              await checkOffSavedTab(id);
              await renderDeferredColumn();
              showToast(typeof t === 'function' ? t('toast.undo') : 'Moved back to archive');
            } catch (err) {
              console.warn('[tab-out] Failed to undo unarchive:', err);
            }
          }
        });
      } else {
        showToast(typeof t === 'function' ? t('toast.tab_restored') : 'Restored to Saved for later');
      }
    } finally {
      delete actionEl.dataset.inFlight;
    }
    return;
  }

  // ---- Restore recently closed tab via chrome.sessions.restore ----
  if (action === 'restore-closed-tab') {
    e.preventDefault();
    e.stopPropagation();
    if (actionEl.dataset.inFlight) return;
    actionEl.dataset.inFlight = 'true';
    try {
      const sessionId = actionEl.dataset.sessionId;
      const url = actionEl.dataset.url || actionEl.getAttribute('href');
      await restoreClosedTab(sessionId, url);
      await renderRecentlyClosedSection();
      showToast(typeof t === 'function' ? t('toast.tab_reopened') : 'Tab reopened');
    } catch (err) {
      console.warn('[tab-out] Failed to reopen tab:', err);
    } finally {
      delete actionEl.dataset.inFlight;
    }
    return;
  }

  // ---- Delete archived tab permanently (with inline confirmation) ----
  if (action === 'delete-archived-tab') {
    e.stopPropagation();
    const id = actionEl.dataset.archiveId;
    if (!id) return;

    if (!actionEl.classList.contains('confirming')) {
      actionEl.classList.add('confirming');
      const confirmDeleteTitle = typeof t === 'function' ? t('saved.delete_confirm_title') : 'Click again to confirm permanent delete';
      const confirmDeleteText = typeof t === 'function' ? t('saved.delete_confirm') : 'Delete?';
      actionEl.title = confirmDeleteTitle;
      actionEl.setAttribute('aria-label', confirmDeleteTitle);
      const originalHtml = actionEl.innerHTML;
      actionEl.dataset.originalHtml = originalHtml;
      actionEl.innerHTML = `<span class="confirm-inline-label">${escapeHtml(confirmDeleteText)}</span>`;

      const timeoutId = setTimeout(() => {
        const liveBtn = actionEl.isConnected ? actionEl : Array.from(document.querySelectorAll('[data-action="delete-archived-tab"]')).find(b => b.dataset.archiveId === id);
        if (liveBtn) {
          liveBtn.classList.remove('confirming');
          liveBtn.innerHTML = liveBtn.dataset.originalHtml || originalHtml;
          const deleteTooltip = typeof t === 'function' ? t('saved.delete_tooltip') : 'Delete permanently';
          liveBtn.title = deleteTooltip;
          liveBtn.setAttribute('aria-label', deleteTooltip);
          delete liveBtn.dataset.originalHtml;
          delete liveBtn.dataset.confirmTimeout;
        }
      }, 3500);
      actionEl.dataset.confirmTimeout = String(timeoutId);
      return;
    }

    if (actionEl.dataset.inFlight) return;
    actionEl.dataset.inFlight = 'true';
    try {
      clearTimeout(parseInt(actionEl.dataset.confirmTimeout || '0', 10));
      actionEl.classList.remove('confirming');

      animatingDeferredIds.add(id);
      let itemSnapshot = null;
      try {
        itemSnapshot = await deleteSavedTab(id);
        const item = actionEl.closest('.archive-item');
        if (item) item.remove();
        await renderDeferredColumn();
        updateHeaderAndStats();
      } finally {
        animatingDeferredIds.delete(id);
      }

      if (itemSnapshot) {
        pushUndoAction({
          description: typeof t === 'function' ? t('undo.deleted_from_archive') : 'Deleted from archive',
          onUndo: async () => {
            await mutateDeferred(deferred => {
              if (!deferred.some(t => t && t.id !== undefined && String(t.id) === String(itemSnapshot.id))) {
                deferred.push(itemSnapshot);
              }
              return deferred;
            });
            await renderDeferredColumn();
            updateHeaderAndStats();
            showToast(typeof t === 'function' ? t('toast.restored_to_archive') : 'Restored to archive');
          }
        });
      } else {
        showToast(typeof t === 'function' ? t('toast.deleted_from_archive') : 'Deleted from archive');
      }
    } finally {
      delete actionEl.dataset.inFlight;
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
          const displayed = archived.slice(0, 50);
          let fullHtml = displayed.map(item => renderArchiveItem(item)).join('');
          if (archived.length > 50) {
            fullHtml += `<div class="archive-more-hint" style="text-align:center;padding:8px;font-size:12px;color:var(--text-muted, #888);">${archived.length - 50} more archived items. Use search to find older items.</div>`;
          }
          renderIfChanged(archiveList, fullHtml, 'deferredArchive');
          return;
        }

        const results = archived.filter(item =>
          (item.title || '').toLowerCase().includes(q) ||
          (item.url  || '').toLowerCase().includes(q)
        );

        const displayed = results.slice(0, 50);
        let filteredHtml = displayed.map(item => renderArchiveItem(item)).join('')
          || `<div class="archive-no-results">${escapeHtml(typeof t === 'function' ? t('archive.no_results') : 'No results')}</div>`;
        if (results.length > 50) {
          filteredHtml += `<div class="archive-more-hint" style="text-align:center;padding:8px;font-size:12px;color:var(--text-muted, #888);">${results.length - 50} more matching items. Refine your search to narrow results.</div>`;
        }
        renderIfChanged(archiveList, filteredHtml, 'deferredArchive');
      } catch (err) {
        console.warn('[tab-out] Archive search failed:', err);
      }
    }, 150);
  });
}

// Keep dashboard synchronized with external tab events, visibility changes & window focus
let syncTimeout = null;
let isSyncing = false;

const performSync = async (fullSync = false) => {
  // Re-check document visibility at execution time: skip background render if tab is hidden
  if (typeof document !== 'undefined' && document.hidden && !fullSync) {
    return;
  }

  // Defer sync if user is actively clicking (mouse pressed down) to prevent detaching click targets
  if (isUserInteractingState) {
    pendingInteractionSync = true;
    if (fullSync) pendingFullSync = true;
    return;
  }

  if (typeof isLocalSettingUpdate !== 'undefined' && isLocalSettingUpdate) {
    pendingSync = true;
    if (fullSync) pendingFullSync = true;
    return;
  }

  if (isSyncing) {
    pendingSync = true;
    if (fullSync) pendingFullSync = true;
    return;
  }
  isSyncing = true;
  try {
    let hasFreshTabs = false;
    // Check if tabs have actually changed before running full render pass
    if (!fullSync && !pendingFullSync && renderCache.has('missions')) {
      const prevTabs = openTabs;
      if (typeof fetchOpenTabs === 'function') {
        await fetchOpenTabs();
        hasFreshTabs = true;
      }
      if (areTabsEqual(prevTabs, openTabs)) {
        return;
      }
    }
    await renderStaticDashboard(hasFreshTabs ? { inMemoryOnly: true } : {});
    if ((fullSync || pendingFullSync) && animatingDeferredIds.size === 0) {
      pendingFullSync = false;
      await renderDeferredColumn();
      await renderRecentlyClosedSection();
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

debouncedSyncRef = debouncedSync;
if (typeof window !== 'undefined') {
  window.__tabOutPerformSync = performSync;
}

if (typeof chrome !== 'undefined' && chrome.tabs) {
  chrome.tabs.onCreated?.addListener(() => debouncedSync(250, false));
  chrome.tabs.onRemoved?.addListener(() => debouncedSync(250, false));
  chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete' || changeInfo.url || changeInfo.title || changeInfo.favIconUrl) {
      debouncedSync(250, false);
    }
  });
  chrome.tabs.onActivated?.addListener(() => debouncedSync(50, false));
  chrome.tabs.onAttached?.addListener(() => debouncedSync(250, false));
  chrome.tabs.onDetached?.addListener(() => debouncedSync(250, false));
  let sessionsDebounceTimeout = null;
  let pendingSessionsSync = false;
  chrome.sessions?.onChanged?.addListener(() => {
    if (typeof document !== 'undefined' && document.hidden) {
      pendingSessionsSync = true;
      return;
    }
    clearTimeout(sessionsDebounceTimeout);
    sessionsDebounceTimeout = setTimeout(() => {
      renderRecentlyClosedSection().catch(() => {});
    }, 150);
  });

  // Coalesce tab visibility and window focus smoothly without interrupting click gestures
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => {
      if (pendingSessionsSync) {
        pendingSessionsSync = false;
        renderRecentlyClosedSection().catch(() => {});
      }
      debouncedSync(50, false);
    });
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (pendingSessionsSync) {
          pendingSessionsSync = false;
          renderRecentlyClosedSection().catch(() => {});
        }
        debouncedSync(0, false);
      }
    });
  }
}

// Cross-tab sync for "Saved for later", Perspectives, and Tab Classification Cache
async function handleStorageOnChanged(changes, areaName) {
  if (areaName === 'local') {
      let didRenderDashboard = false;
      if (changes.tabout_language && typeof TabOutI18n !== 'undefined') {
        const newLang = changes.tabout_language.newValue;
        if ((newLang === 'en' || newLang === 'vi') && newLang !== TabOutI18n.getLanguage()) {
          TabOutI18n.setLanguage(newLang, false);
        }
      }
      if (changes.deferred) {
        if (animatingDeferredIds.size === 0) {
          renderDeferredColumn();
        }
      }

      // Check for partitioned tab classification cache updates first!
      const incomingByPid = {};
      let hasPartitionChanges = false;
      for (const [key, change] of Object.entries(changes)) {
        if (key.startsWith('tabClassificationCache_')) {
          const pid = key.slice('tabClassificationCache_'.length);
          if (isDangerousKey(pid)) continue;
          if (change.newValue && typeof change.newValue === 'object' && !Array.isArray(change.newValue)) {
            incomingByPid[pid] = change.newValue;
            hasPartitionChanges = true;
          } else if (change.newValue === undefined) {
            delete tabClassificationCache[pid];
            hasPartitionChanges = true;
          }
        }
      }
      // Only process monolithic if no specific partition key changes were broadcast
      if (!hasPartitionChanges && changes.tabClassificationCache?.newValue && typeof changes.tabClassificationCache.newValue === 'object' && !Array.isArray(changes.tabClassificationCache.newValue)) {
        for (const [k, v] of Object.entries(changes.tabClassificationCache.newValue)) {
          if (!isDangerousKey(k) && v && typeof v === 'object' && !Array.isArray(v)) {
            incomingByPid[k] = v;
          }
        }
      }

      let hasRelevantChanges = false;
      if (Object.keys(incomingByPid).length > 0) {
        const realTabs = typeof getRealTabs === 'function' ? getRealTabs() : [];
        const openTabNormUrls = new Set(realTabs.map(t => normalizeUrlForCache(t.url) || t.url || ''));
        const activePid = activePerspectiveId;

        for (const [pid, pCache] of Object.entries(incomingByPid)) {
          if (isDangerousKey(pid)) continue;
          if (!tabClassificationCache[pid]) {
            tabClassificationCache[pid] = {};
          }
          if (pCache && typeof pCache === 'object' && !Array.isArray(pCache)) {
            for (const [urlKey, entry] of Object.entries(pCache)) {
              if (isDangerousKey(urlKey)) continue;
              const prev = tabClassificationCache[pid][urlKey];
              const prevSource = getCacheSource(prev);
              const newSource = getCacheSource(entry);

              // Never overwrite completed AI decisions ('ai' or 'ai-low-confidence') with non-AI placeholders
              if (['ai', 'ai-low-confidence'].includes(prevSource) && !['ai', 'ai-low-confidence'].includes(newSource)) {
                continue;
              }

              // Never downgrade a high-confidence AI decision to low confidence
              if (prevSource === 'ai' && newSource === 'ai-low-confidence') {
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

              // Never downgrade a valid non-fallback label to a fallback label via a non-AI placeholder update
              if (prevLabel && !isFallbackLabel(prevLabel) && isFallbackLabel(newLabel) && !['ai', 'ai-low-confidence'].includes(newSource)) {
                continue;
              }

              const normalizedEntry = typeof entry === 'string'
                ? { label: entry, source: 'ai', timestamp: Date.now() }
                : (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {});

              // Avoid allocating new objects and triggering GC churn if entry is identical to prev
              if (prev &&
                  prev.label === normalizedEntry.label &&
                  prev.source === normalizedEntry.source &&
                  prev.confidence === normalizedEntry.confidence &&
                  prev.timestamp === normalizedEntry.timestamp &&
                  prev.secondaryLabel === normalizedEntry.secondaryLabel) {
                continue;
              }

              tabClassificationCache[pid][urlKey] = {
                ...(prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}),
                ...normalizedEntry,
                secondaryLabel: normalizedEntry.secondaryLabel !== undefined ? normalizedEntry.secondaryLabel : prev?.secondaryLabel
              };

              if (pid === activePid && newLabel && newLabel !== prevLabel && openTabNormUrls.has(urlKey)) {
                hasRelevantChanges = true;
              }
            }
          }
        }

        for (const pid of Object.keys(incomingByPid)) {
          if (tabClassificationCache[pid] && Object.keys(tabClassificationCache[pid]).length > 1000) {
            tabClassificationCache[pid] = pruneClassificationCache(tabClassificationCache[pid], 1000);
          }
        }
      }

      const hasActualSettingChange =
        (changes.perspectives && changes.perspectives.oldValue !== changes.perspectives.newValue) ||
        (changes.activePerspectiveId && changes.activePerspectiveId.oldValue !== changes.activePerspectiveId.newValue) ||
        (changes.openRouterApiKey && changes.openRouterApiKey.oldValue !== changes.openRouterApiKey.newValue) ||
        (changes.classifierApiKey && changes.classifierApiKey.oldValue !== changes.classifierApiKey.newValue) ||
        (changes.aiAuthBlocked && changes.aiAuthBlocked.oldValue !== changes.aiAuthBlocked.newValue);

      if (hasActualSettingChange) {
        if (!isLocalSettingUpdate) {
          await loadPerspectiveSettings(true);
          await renderStaticDashboard();
          didRenderDashboard = true;
        } else {
          pendingSettingsReload = true;
        }
      }

      if (hasRelevantChanges && !didRenderDashboard) {
        if (!isBackgroundClassifying) {
          await renderStaticDashboard({ skipBackgroundAi: true, inMemoryOnly: true });
        }
      }
    }
  }

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener(handleStorageOnChanged);
}

/* ----------------------------------------------------------------
   MODAL FORM SUBMISSIONS & KEYBOARD SHORTCUTS
   ---------------------------------------------------------------- */

if (typeof document !== 'undefined') {
  // Perspective creation / edit form
  let isSubmittingPerspective = false;
  document.getElementById('perspectiveForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isSubmittingPerspective) return;
    isSubmittingPerspective = true;
    try {
      if (activeClassificationAbortController) {
        try { activeClassificationAbortController.abort(); } catch {}
        activeClassificationAbortController = null;
      }
      const editId = document.getElementById('perspectiveEditId')?.value;
      const name = (document.getElementById('perspectiveNameInput')?.value.trim() || '').slice(0, 50);
      const rows = Array.from(document.querySelectorAll('#perspectiveTagsContainer .tag-row'));

      if (!name) {
        showToast(typeof t === 'function' ? t('toast.enter_perspective_name') : 'Please enter a perspective name');
        return;
      }

    const labels = [];
    const seenNames = new Set();
    for (const r of rows) {
      const tagName = (r.querySelector('.tag-field-name')?.value.trim() || '').slice(0, 50);
      const tagDesc = (r.querySelector('.tag-field-desc')?.value.trim() || '').slice(0, 300);
      const tagColor = r.dataset?.tagColor || r.getAttribute('data-tag-color') || '';
      const lower = tagName.toLowerCase();
      if (isFallbackLabel(tagName)) continue;
      if (tagName && !seenNames.has(lower) && !isDangerousKey(tagName) && !isDangerousKey(lower)) {
        seenNames.add(lower);
        labels.push({
          name: tagName,
          description: tagDesc,
          color: tagColor
        });
      }
    }

    if (labels.length === 0) {
      showToast(typeof t === 'function' ? t('toast.add_at_least_one_tag') : 'Please add at least 1 tag');
      return;
    }

    // Always automatically attach the immutable default 'Khác' fallback tag
    labels.push({
      name: 'Khác',
      description: '',
      color: ''
    });

    let semanticsChanged = true;
    if (editId) {
      const existing = currentPerspectives.find(p => p.id === editId);
      if (!existing || existing.isSystem) return;
        // Compare semantic contents (names & descriptions) ignoring colors and fallback tag
        const getSemanticSignature = (list) => (list || [])
          .filter(l => !isFallbackLabel(l.name))
          .map(l => `${(l.name || '').trim().toLowerCase()}::${(l.description || '').trim().toLowerCase()}`)
          .sort()
          .join('|');

        semanticsChanged = getSemanticSignature(existing.labels) !== getSemanticSignature(labels);

        const idx = currentPerspectives.findIndex(p => p.id === editId);
        if (idx !== -1) {
          currentPerspectives[idx] = {
            ...existing,
            name,
            labels
          };
        }

        // ONLY wipe classification cache if the semantic tags actually changed!
        if (semanticsChanged) {
          if (tabClassificationCache[editId]) {
            delete tabClassificationCache[editId];
          }
        }
      } else {
      const newId = 'p_' + Date.now().toString(36);
      const templateIcon = document.getElementById('perspectiveForm')?.dataset.templateIcon;
      currentPerspectives.push({
        id: newId,
        name,
        icon: templateIcon || 'folder',
        isSystem: false,
        labels
      });
      if (isJevActive()) {
        activePerspectiveId = newId;
      } else {
        activePerspectiveId = 'domain';
      }
    }

    setLocalSettingLock(400);
    await enqueueStorageWrite(async () => {
      if (editId && !isDangerousKey(editId) && semanticsChanged) {
        await chrome.storage.local.remove([`tabClassificationCache_${editId}`]);
      }
      const freshRes = await chrome.storage.local.get(['tabClassificationCache']);
      const freshMonolithic = (freshRes.tabClassificationCache && typeof freshRes.tabClassificationCache === 'object' && !Array.isArray(freshRes.tabClassificationCache))
        ? freshRes.tabClassificationCache
        : {};
      if (editId && !isDangerousKey(editId) && semanticsChanged) {
        delete freshMonolithic[editId];
      }
      await chrome.storage.local.set({
        perspectives: currentPerspectives,
        activePerspectiveId,
        tabClassificationCache: freshMonolithic
      });
    });

    const overlay = document.getElementById('perspectiveModalOverlay');
    if (overlay) overlay.style.display = 'none';
    restoreModalFocus();

    await renderStaticDashboard();
    showToast(editId
      ? (typeof t === 'function' ? t('toast.perspective_updated') : 'Perspective updated')
      : (isJevActive()
        ? (typeof t === 'function' ? t('toast.perspective_created') : 'Perspective created & applied')
        : (typeof t === 'function' ? t('toast.perspective_created_inactive') : 'Perspective saved (locked until API key configured)')));
    } finally {
      isSubmittingPerspective = false;
    }
  });

  // API Key configuration form
  document.getElementById('apiKeyForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (activeClassificationAbortController) {
      try { activeClassificationAbortController.abort(); } catch {}
      activeClassificationAbortController = null;
    }
    const key = (document.getElementById('apiKeyInput')?.value || '').trim().replace(/[^\x21-\x7E]/g, '');
    aiAuthBlocked = false;
    openRouterApiKey = key;
    if (key) {
      for (const pid of Object.keys(tabClassificationCache)) {
        const pCache = tabClassificationCache[pid];
        if (pCache && typeof pCache === 'object') {
          for (const entry of Object.values(pCache)) {
            if (entry && !['ai', 'ai-low-confidence'].includes(getCacheSource(entry))) {
              delete entry.lastAiAttempt;
              delete entry.cooldownMs;
            }
          }
        }
      }
    }
    setLocalSettingLock(400);
    const storagePayload = { openRouterApiKey: key, classifierApiKey: key, aiAuthBlocked: false, lastBlockedApiKey: null };
    if (!isJevActive() && activePerspectiveId !== 'domain') {
      activePerspectiveId = 'domain';
      storagePayload.activePerspectiveId = 'domain';
    }
    await enqueueStorageWrite(async () => {
      await chrome.storage.local.set(storagePayload);
    });

    // Check language change from select
    const langSelect = document.getElementById('settingsLanguageSelect');
    if (langSelect && typeof TabOutI18n !== 'undefined') {
      const chosenLang = langSelect.value;
      if (chosenLang && (chosenLang === 'en' || chosenLang === 'vi') && chosenLang !== TabOutI18n.getLanguage()) {
        TabOutI18n.setLanguage(chosenLang);
      }
    }

    const overlay = document.getElementById('apiKeyModalOverlay');
    if (overlay) overlay.style.display = 'none';
    restoreModalFocus();

    showToast(typeof t === 'function' ? t('toast.settings_saved') : (key ? 'OpenRouter API key saved' : 'Settings saved'));

    // Instantly upgrade all active tabs from local heuristic to Jev AI
    await renderStaticDashboard();
  });

  // Close popovers or modals with Escape key in stacked order (topmost first)
  document.addEventListener('keydown', (e) => {
    // Trap Tab focus inside visible modal overlays (perspective and apiKey modals)
    if (e.key === 'Tab') {
      const confirmOverlay = document.getElementById('confirmModalOverlay');
      if (confirmOverlay && confirmOverlay.style.display === 'flex') {
        return; // Confirm modal is topmost; let showConfirmDialog handle Tab trap
      }
      const activeModal = Array.from(document.querySelectorAll('.perspective-modal-overlay')).find(m => m.style.display === 'flex' && m.id !== 'confirmModalOverlay');
      if (activeModal) {
        const focusable = Array.from(activeModal.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(el => el.getClientRects().length > 0);
        if (focusable.length > 0) {
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (!activeModal.contains(document.activeElement)) {
            e.preventDefault();
            (e.shiftKey ? last : first).focus();
            return;
          }
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
            return;
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
            return;
          }
        }
      }
    }

    // ArrowLeft / ArrowRight navigation inside swatch popover
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const currentSwatch = e.target.closest?.('.tag-color-swatch');
      if (currentSwatch) {
        const popover = currentSwatch.closest('.tag-color-popover');
        if (popover) {
          e.preventDefault();
          const swatches = Array.from(popover.querySelectorAll('.tag-color-swatch'));
          const idx = swatches.indexOf(currentSwatch);
          if (idx !== -1) {
            const nextIdx = e.key === 'ArrowRight'
              ? (idx + 1) % swatches.length
              : (idx - 1 + swatches.length) % swatches.length;
            swatches[nextIdx]?.focus();
          }
          return;
        }
      }
    }

    if (e.key === 'Escape') {
      const openPopovers = Array.from(document.querySelectorAll('.tag-color-popover')).filter(p => p.style.display !== 'none');
      if (openPopovers.length > 0) {
        openPopovers.forEach(p => {
          p.style.display = 'none';
          const wrap = p.closest('.tag-color-picker-wrap');
          const btn = wrap?.querySelector('.tag-color-btn');
          if (btn) {
            btn.setAttribute('aria-expanded', 'false');
            btn.focus();
          }
        });
        return;
      }

      const cModal = document.getElementById('confirmModalOverlay');
      if (cModal && cModal.style.display !== 'none') {
        const cancelBtn = document.getElementById('confirmModalCancelBtn');
        if (cancelBtn) cancelBtn.click();
        else cModal.style.display = 'none';
        return;
      }
      const pModal = document.getElementById('perspectiveModalOverlay');
      if (pModal && pModal.style.display !== 'none') {
        pModal.style.display = 'none';
        restoreModalFocus();
        return;
      }
      const aModal = document.getElementById('apiKeyModalOverlay');
      if (aModal && aModal.style.display !== 'none') {
        aModal.style.display = 'none';
        restoreModalFocus();
        return;
      }

      // If typing in an active input/textarea/select, let Escape blur it first
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT' || activeEl.isContentEditable)) {
        activeEl.blur();
        return;
      }

      // If no popover, modal, or input focus, Escape returns to the last active tab!
      const lastTab = getLastActiveTab();
      if (lastTab) {
        e.preventDefault();
        returnToLastActiveTab(lastTab);
        return;
      }
    }

    // Direct numerical shortcuts 1-5 to switch to recent tabs (MRU 1 to 5)
    if (['1', '2', '3', '4', '5'].includes(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing) {
      const openPopovers = Array.from(document.querySelectorAll('.tag-color-popover')).filter(p => p.style.display !== 'none');
      if (openPopovers.length > 0) return;

      const cModal = document.getElementById('confirmModalOverlay');
      if (cModal && cModal.style.display !== 'none') return;
      const pModal = document.getElementById('perspectiveModalOverlay');
      if (pModal && pModal.style.display !== 'none') return;
      const aModal = document.getElementById('apiKeyModalOverlay');
      if (aModal && aModal.style.display !== 'none') return;

      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT' || activeEl.isContentEditable)) {
        return;
      }

      const recentTabs = getRecentTabs(undefined, { limit: 5 });
      const targetIdx = parseInt(e.key, 10) - 1;
      if (recentTabs && recentTabs[targetIdx]) {
        e.preventDefault();
        returnToLastActiveTab(recentTabs[targetIdx]);
        return;
      }
    }
  });

  // Close modals when clicking directly on overlay backdrop (ignoring drags that started inside the modal)
  document.querySelectorAll('.perspective-modal-overlay').forEach(overlay => {
    let isMouseDownOnBackdrop = false;

    overlay.addEventListener('mousedown', (e) => {
      isMouseDownOnBackdrop = (e.target === overlay);
    });

    overlay.addEventListener('mouseup', (e) => {
      if (isMouseDownOnBackdrop && e.target === overlay) {
        if (overlay.id === 'confirmModalOverlay') {
          const cancelBtn = document.getElementById('confirmModalCancelBtn');
          if (cancelBtn) cancelBtn.click();
          else overlay.style.display = 'none';
        } else {
          overlay.style.display = 'none';
          restoreModalFocus();
        }
      }
      isMouseDownOnBackdrop = false;
    });
  });

  // Enter & Escape key handling in dynamic tag inputs: smooth field progression instead of accidental submit
  document.getElementById('perspectiveTagsContainer')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (e.target.classList.contains('tag-field-name')) {
        e.preventDefault();
        const row = e.target.closest('.tag-row');
        const descInput = row?.querySelector('.tag-field-desc');
        if (descInput) descInput.focus();
      } else if (e.target.classList.contains('tag-field-desc')) {
        // Multi-line prompt: Enter inserts newline; Ctrl+Enter or Cmd+Enter creates new tag
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          addTagRowToModal('', '', true);
        }
      }
    } else if (e.key === 'Escape' && e.target.classList.contains('tag-field-desc')) {
      e.preventDefault();
      e.stopPropagation();
      e.target.blur();
    }
  });

  // Focus expansion, auto-resize, and collapse for tag-field-desc
  const tagsContainerEl = document.getElementById('perspectiveTagsContainer');
  tagsContainerEl?.addEventListener('focusin', (e) => {
    if (e.target?.classList?.contains('tag-field-desc')) {
      const textarea = e.target;
      const row = textarea.closest('.tag-row');
      if (row) {
        row.classList.add('is-desc-expanded');
        textarea.style.whiteSpace = 'pre-wrap';
        textarea.style.textOverflow = '';
        textarea.style.overflowY = 'auto';
        autoResizeTagDesc(textarea);
      }
    }
  });

  tagsContainerEl?.addEventListener('focusout', (e) => {
    if (e.target?.classList?.contains('tag-field-desc')) {
      const textarea = e.target;
      const row = textarea.closest('.tag-row');
      if (row) {
        row.classList.remove('is-desc-expanded');
        textarea.style.overflowY = 'hidden';
        textarea.style.height = '34px';
        if (typeof textarea.value === 'string') {
          textarea.title = textarea.value.trim();
        }
        if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
          textarea.style.whiteSpace = 'nowrap';
          textarea.style.textOverflow = 'ellipsis';
        }
      }
    }
  });

  tagsContainerEl?.addEventListener('transitionend', (e) => {
    if (e.propertyName === 'height' && e.target?.classList?.contains('tag-field-desc')) {
      const textarea = e.target;
      if (document.activeElement !== textarea) {
        textarea.style.whiteSpace = 'nowrap';
        textarea.style.textOverflow = 'ellipsis';
        textarea.style.overflowY = 'hidden';
      }
    }
  });

  tagsContainerEl?.addEventListener('input', (e) => {
    if (e.target?.classList?.contains('tag-field-desc')) {
      const textarea = e.target;
      const row = textarea.closest('.tag-row');
      if (row?.classList?.contains('is-desc-expanded')) {
        textarea.style.height = 'auto';
        autoResizeTagDesc(textarea);
      }
    }
  });
  let draggedTagRow = null;

  tagsContainerEl?.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.tag-row');
    if (!row) return;
    draggedTagRow = row;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ''); // required for cross-browser DnD
    setTimeout(() => {
      row.classList.add('is-dragging');
    }, 0);
  });

  tagsContainerEl?.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!draggedTagRow) return;

    const targetRow = e.target.closest('.tag-row');
    if (!targetRow || targetRow === draggedTagRow) return;

    const rect = targetRow.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      tagsContainerEl.insertBefore(draggedTagRow, targetRow);
    } else {
      tagsContainerEl.insertBefore(draggedTagRow, targetRow.nextSibling);
    }
  });

  tagsContainerEl?.addEventListener('dragend', () => {
    if (draggedTagRow) {
      draggedTagRow.classList.remove('is-dragging');
      draggedTagRow.removeAttribute('draggable');
      draggedTagRow = null;
    }
  });

  tagsContainerEl?.addEventListener('drop', (e) => {
    e.preventDefault();
    if (draggedTagRow) {
      draggedTagRow.classList.remove('is-dragging');
      draggedTagRow.removeAttribute('draggable');
      draggedTagRow = null;
    }
  });

  // Keyboard navigation on perspective tabs in rail
  document.getElementById('perspectiveList')?.addEventListener('keydown', async (e) => {
    if (e.target.closest('.perspective-tab-edit-btn')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      const tab = e.target.closest('.perspective-tab');
      if (tab && tab.dataset.perspectiveId) {
        e.preventDefault();
        await switchPerspective(tab.dataset.perspectiveId);
      }
    }
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
      const apiKeyOverlay = document.getElementById('apiKeyModalOverlay');
      if ((confirmOverlay && confirmOverlay.style.display === 'flex') ||
          (perspectiveOverlay && perspectiveOverlay.style.display === 'flex') ||
          (apiKeyOverlay && apiKeyOverlay.style.display === 'flex')) {
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
  if (typeof TabOutI18n !== 'undefined') {
    if (typeof TabOutI18n.init === 'function') {
      try {
        await TabOutI18n.init();
      } catch (_) {}
    }
    TabOutI18n.applyI18n();
    const currentLang = TabOutI18n.getLanguage();
    document.querySelectorAll('.lang-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.lang === currentLang);
    });
    const langSelect = document.getElementById('settingsLanguageSelect');
    if (langSelect) langSelect.value = currentLang;
  }
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
  // Language switcher click handler in rail footer
  document.getElementById('langSwitcher')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.lang-btn');
    if (!btn) return;
    const targetLang = btn.dataset.lang;
    if (targetLang && typeof TabOutI18n !== 'undefined') {
      TabOutI18n.setLanguage(targetLang);
    }
  });

  // Listen to language change to update UI and re-render
  if (typeof window !== 'undefined') {
    window.addEventListener('tabout:language-changed', async (e) => {
      const newLang = e?.detail?.language || e?.detail?.lang || (typeof TabOutI18n !== 'undefined' ? TabOutI18n.getLanguage() : 'en');
      document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lang === newLang);
      });
      const langSelect = document.getElementById('settingsLanguageSelect');
      if (langSelect) langSelect.value = newLang;
      if (typeof TabOutI18n !== 'undefined') {
        TabOutI18n.applyI18n(document);
      }
      const dateEl = document.getElementById('dateDisplay');
      if (dateEl) dateEl.textContent = getDateDisplay();
      await renderAll();
    });
  }

  initDashboard().catch(err => {
    console.warn('[tab-out] Initial dashboard load error:', err);
  });
}

// Export canonical modules for test suites in Node/Bun environment
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_PERSPECTIVES,
    PERSPECTIVE_TEMPLATES,
    PERSPECTIVE_ICONS,
    getPerspectiveTemplate,
    renderMissionCard,
    TAG_PALETTE,
    resolveTagColor,
    getLabelColor,
    renderDomainCard,
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
    handleStorageOnChanged,
    isAiEligibleUrl,
    renderPerspectiveTagsBar,
    renderDeferredColumn,
    stripUrlQueryParams,
    updateHeaderAndStats,
    renderOpenTabsHeaderActions,
    updatePerspectiveTelemetry,
    autoResizeTagDesc,
    checkTabOutDupes,
    closeTabOutDupes,
    closeDuplicateTabs,
    focusTab,
    getFaviconUrl,
    getRecentTabs,
    getLastActiveTab,
    renderQuickReturnBar,
    renderRecentSidebarCard,
    returnToLastActiveTab,
    get isQuickReturnDismissed() { return isQuickReturnDismissed; },
    set isQuickReturnDismissed(v) { isQuickReturnDismissed = Boolean(v); },
    smartTitle,
    getRealTabs,
    renderPerspectiveRail,
    switchPerspective,
    isJevActive,
    get openRouterApiKey() { return openRouterApiKey; },
    set openRouterApiKey(v) { openRouterApiKey = typeof v === 'string' ? v.trim() : ''; },
    get aiAuthBlocked() { return aiAuthBlocked; },
    set aiAuthBlocked(v) { aiAuthBlocked = Boolean(v); },
    get activePerspectiveId() { return activePerspectiveId; },
    set activePerspectiveId(v) { activePerspectiveId = v; },
    get isLocalSettingUpdate() { return isLocalSettingUpdate; },
    set isLocalSettingUpdate(v) { isLocalSettingUpdate = Boolean(v); },
    get isPerspectivesLoaded() { return isPerspectivesLoaded; },
    set isPerspectivesLoaded(v) { isPerspectivesLoaded = Boolean(v); },
    cloneDefaultPerspectives,
    get currentPerspectives() { return currentPerspectives; },
    set currentPerspectives(v) { currentPerspectives = v; },
    isRealTabUrl,
    getRecentlyClosedTabs,
    renderRecentlyClosedItem,
    renderRecentlyClosedSection,
    restoreClosedTab,
    isFallbackLabel,
    areTabsEqual,
    isUserInteracting,
    setUserInteracting,
    startUserInteraction,
    releaseUserInteraction,
    renderCache,
    renderIfChanged,
    resetRenderCache,
    performSync,
    debouncedSync,
    safeUrl,
    stripCredentialsFromUrl,
    stripUserInfoFallback,
    isDangerousKey,
    mutateDeferred,
    saveTabForLater,
    getSavedTabs,
    checkOffSavedTab,
    unarchiveSavedTab,
    deleteSavedTab,
    dismissSavedTab,
    renderDeferredColumn
  };
}

