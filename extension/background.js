/**
 * background.js — Service Worker for Badge Updates
 *
 * Chrome's "always-on" background script for Tab Out.
 * Its only job: keep the toolbar badge showing the current open tab count.
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts real web tabs (skipping chrome:// and extension pages).
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

// ─── Badge updater ────────────────────────────────────────────────────────────

let lastBadgeText = null;
let lastBadgeColor = null;

/**
 * isRealTabUrl(url)
 *
 * Strict protocol allowlist (http:, https:) using URL parser.
 * Rejects javascript:, data:, chrome:, about:, file:, view-source:, etc.
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
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => {
      const url = t.url || t.pendingUrl || '';
      return isRealTabUrl(url);
    }).length;

    const newText = count > 0 ? String(count) : '';
    if (newText !== lastBadgeText) {
      await chrome.action.setBadgeText({ text: newText });
      lastBadgeText = newText;
    }

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#3d7a4a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    if (color !== lastBadgeColor) {
      await chrome.action.setBadgeBackgroundColor({ color });
      lastBadgeColor = color;
    }

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    try {
      const p = chrome.action.setBadgeText({ text: '' });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
    lastBadgeText = null;
    lastBadgeColor = null;
  }
}

// ─── Background AI Pre-Classification Engine ────────────────────────────────

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

const bgNormalizedUrlCache = new Map();

function normalizeUrlForCache(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (bgNormalizedUrlCache.has(trimmed)) {
    const cached = bgNormalizedUrlCache.get(trimmed);
    bgNormalizedUrlCache.delete(trimmed);
    bgNormalizedUrlCache.set(trimmed, cached);
    return cached;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    parsed.username = '';
    parsed.password = '';

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
    if (bgNormalizedUrlCache.size > 2000) {
      const it = bgNormalizedUrlCache.keys();
      for (let i = 0; i < 200; i++) {
        const nextKey = it.next().value;
        if (nextKey) bgNormalizedUrlCache.delete(nextKey);
      }
    }
    bgNormalizedUrlCache.set(trimmed, res);
    return res;
  } catch {
    let safeFallback = stripUserInfoFallback(trimmed).split('?')[0].split('#')[0];
    if (bgNormalizedUrlCache.size > 2000) {
      const it = bgNormalizedUrlCache.keys();
      for (let i = 0; i < 200; i++) {
        const nextKey = it.next().value;
        if (nextKey) bgNormalizedUrlCache.delete(nextKey);
      }
    }
    bgNormalizedUrlCache.set(trimmed, safeFallback);
    return safeFallback;
  }
}

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

function stripTitleNoise(title) {
  if (!title) return '';
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  title = title.replace(/\s*[-\u2010-\u2015]\s*[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function getCacheSource(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return 'ai';
  if (typeof entry === 'object' && entry.source) return entry.source;
  return 'local';
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
    const rawName = (typeof item === 'string' ? item : item?.name || '').trim();
    if (!rawName || isDangerousKey(rawName)) continue;
    if (isFallbackLabel(rawName)) hasOther = true;
    const name = rawName.slice(0, 50);
    const desc = typeof item === 'string' ? '' : (item?.description || '').slice(0, 300);
    if (item && typeof item === 'object' && item.rubric && typeof item.rubric === 'object') {
      criteria[name] = item.rubric;
    } else {
      criteria[name] = desc || name;
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
      host = colonIdx === -1 ? hostWithPort : hostWithPort.slice(0, colonIdx);
    }
    return host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

let bgStorageWriteMutex = Promise.resolve();

function enqueueBgStorageWrite(fn) {
  const next = bgStorageWriteMutex.then(fn, fn);
  bgStorageWriteMutex = next;
  return next;
}

async function saveBgClassificationCache(updates) {
  if (!updates || Object.keys(updates).length === 0) return;
  return enqueueBgStorageWrite(async () => {
    try {
      const partitionKeys = Object.keys(updates).map(pid => `tabClassificationCache_${pid}`);
      const latestStorage = await chrome.storage.local.get(['perspectives', ...partitionKeys]);
      const validPerspectiveIds = new Set((latestStorage.perspectives || []).filter(p => p && p.id && !isDangerousKey(p.id)).map(p => p.id));
      const storageToSet = {};

      const initialDiskKeysByPartition = new Map();
      let totalChanges = false;
      for (const [pid, newItems] of Object.entries(updates)) {
        if (isDangerousKey(pid)) continue;
        if (Array.isArray(latestStorage.perspectives) && !validPerspectiveIds.has(pid)) {
          continue;
        }
        const partitionKey = `tabClassificationCache_${pid}`;
        let partitionCache = latestStorage[partitionKey];
        if (!partitionCache || typeof partitionCache !== 'object' || Array.isArray(partitionCache)) {
          partitionCache = {};
        } else {
          partitionCache = { ...partitionCache };
        }
        initialDiskKeysByPartition.set(partitionKey, new Set(Object.keys(partitionCache)));

        let partitionChanged = false;
        for (const [urlKey, entry] of Object.entries(newItems)) {
          if (isDangerousKey(urlKey)) continue;
          const existing = partitionCache[urlKey];
          const existingSource = getCacheSource(existing);
          const entrySource = getCacheSource(entry);
          // A completed AI decision must not be replaced by a stale local placeholder.
          if (existing && ['ai', 'ai-low-confidence'].includes(existingSource) &&
              !['ai', 'ai-low-confidence'].includes(entrySource)) {
            continue;
          }
          // A completed high-confidence AI decision must not be downgraded to low confidence.
          if (existing && existingSource === 'ai' && entrySource === 'ai-low-confidence') {
            continue;
          }
          if (existing && existingSource === 'ai' && entrySource === 'ai' &&
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
          partitionChanged = true;
        }

        if (Object.keys(partitionCache).length > 1000) {
          const prePruneLen = Object.keys(partitionCache).length;
          const pEntries = Object.entries(partitionCache);
          const hasTimes = pEntries.some(e => e[1] && typeof e[1] === 'object' && typeof e[1].timestamp === 'number');
          if (hasTimes) {
            pEntries.sort((a, b) => ((b[1]?.timestamp || 0) - (a[1]?.timestamp || 0)));
            partitionCache = Object.fromEntries(pEntries.slice(0, 1000));
          } else {
            partitionCache = Object.fromEntries(pEntries.slice(Math.max(0, pEntries.length - 1000)));
          }
          if (Object.keys(partitionCache).length !== prePruneLen) {
            partitionChanged = true;
          }
        }

        if (partitionChanged) {
          storageToSet[partitionKey] = partitionCache;
          totalChanges = true;
        }
      }

      if (totalChanges && Object.keys(storageToSet).length > 0) {
        // Delta merge: Reload fresh storage to avoid clobbering any concurrent entries from dashboard tab
        const freshDisk = await chrome.storage.local.get(['perspectives', ...Object.keys(storageToSet)]);
        if (Array.isArray(freshDisk.perspectives)) {
          const freshValidIds = new Set(
            freshDisk.perspectives
              .filter(p => p && typeof p === 'object' && p.id && !isDangerousKey(p.id))
              .map(p => p.id)
          );
          for (const partKey of Object.keys(storageToSet)) {
            const pid = partKey.slice('tabClassificationCache_'.length);
            if (!freshValidIds.has(pid)) {
              delete storageToSet[partKey];
            }
          }
        }
        for (const [partKey, memoryCache] of Object.entries(storageToSet)) {
          const diskCache = freshDisk[partKey];
          const initialKeys = initialDiskKeysByPartition.get(partKey) || new Set();
          if (diskCache && typeof diskCache === 'object' && !Array.isArray(diskCache)) {
            for (const [k, v] of Object.entries(diskCache)) {
              if (isDangerousKey(k)) continue;
              const current = memoryCache[k];
              if (!current) {
                // Only merge keys that were newly created on disk during this transaction
                // Do NOT resurrect keys that were intentionally pruned!
                if (!initialKeys.has(k)) {
                  memoryCache[k] = v;
                }
              } else {
                // Provenance & precedence check: upgrade placeholder/lower-confidence to higher-confidence decision from disk
                const currentSrc = getCacheSource(current);
                const diskSrc = getCacheSource(v);
                if (['ai', 'ai-low-confidence'].includes(diskSrc) && !['ai', 'ai-low-confidence'].includes(currentSrc)) {
                  memoryCache[k] = v;
                } else if (diskSrc === 'ai' && currentSrc === 'ai-low-confidence') {
                  memoryCache[k] = v;
                } else if (diskSrc === 'ai' && currentSrc === 'ai' && typeof v?.confidence === 'number' && typeof current?.confidence === 'number' && v.confidence > current.confidence) {
                  memoryCache[k] = v;
                }
              }
            }
          }
          if (Object.keys(memoryCache).length > 1000) {
            const pEntries = Object.entries(memoryCache);
            const hasTimes = pEntries.some(e => e[1] && typeof e[1] === 'object' && typeof e[1].timestamp === 'number');
            if (hasTimes) {
              pEntries.sort((a, b) => ((b[1]?.timestamp || 0) - (a[1]?.timestamp || 0)));
              storageToSet[partKey] = Object.fromEntries(pEntries.slice(0, 1000));
            } else {
              storageToSet[partKey] = Object.fromEntries(pEntries.slice(Math.max(0, pEntries.length - 1000)));
            }
          }
        }
        await chrome.storage.local.set(storageToSet);
      }
    } catch {}
  });
}

// ─── Debounced Multi-Perspective Background Preclassifier ────────────────────

const pendingPreclassifyTabs = new Map();
const aiReservations = new Map();
const deferredPreclassifyTabs = new Map();

// Hydrate reservations from session storage to preserve stampede protection across service worker suspensions
let hydrationPromise = null;

function hydrateAiReservationsFromSession() {
  if (typeof chrome !== 'undefined' && chrome.storage?.session) {
    hydrationPromise = chrome.storage.session.get(['aiReservations']).then(res => {
      if (res?.aiReservations && typeof res.aiReservations === 'object' && !Array.isArray(res.aiReservations)) {
        const now = Date.now();
        for (const [k, r] of Object.entries(res.aiReservations)) {
          if (!isDangerousKey(k) && r && typeof r === 'object' && r.until > now && !aiReservations.has(k)) {
            aiReservations.set(k, r);
          }
        }
      }
    }).catch(() => {}).finally(() => {
      hydrationPromise = null;
    });
    return hydrationPromise;
  }
  return Promise.resolve();
}

hydrateAiReservationsFromSession();

function _resetAiReservationsForTesting() {
  aiReservations.clear();
  deferredPreclassifyTabs.clear();
  pendingPreclassifyTabs.clear();
  if (sessionReservationSaveTimer) {
    clearTimeout(sessionReservationSaveTimer);
    sessionReservationSaveTimer = null;
  }
  sessionReservationResolvers = [];
  hydrationPromise = null;
}

function reservationMapKey(key) {
  if (key.length <= 500) return key;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  }
  return `${key.slice(0, 180)}:${key.length}:${(hash >>> 0).toString(16)}:${key.slice(-180)}`;
}

let sessionReservationSaveTimer = null;
let sessionReservationResolvers = [];

function persistReservationsToSession(immediate = false) {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return Promise.resolve();
  if (sessionReservationSaveTimer) {
    clearTimeout(sessionReservationSaveTimer);
    sessionReservationSaveTimer = null;
  }
  const doSave = async () => {
    try {
      await chrome.storage.session.set({
        aiReservations: Object.fromEntries(aiReservations)
      });
    } catch {}
    const resolvers = sessionReservationResolvers;
    sessionReservationResolvers = [];
    for (const r of resolvers) {
      try { r(); } catch {}
    }
  };
  if (immediate) {
    return doSave();
  }
  return new Promise((resolve) => {
    sessionReservationResolvers.push(resolve);
    sessionReservationSaveTimer = setTimeout(() => {
      sessionReservationSaveTimer = null;
      doSave();
    }, 50);
  });
}

function updateAiReservations(message) {
  const now = Date.now();
  const claimed = [];
  const released = [];

  // Evict expired reservations to prevent unbounded memory growth and unblock waiting tabs
  for (const [k, r] of aiReservations) {
    if (r && r.until <= now) {
      aiReservations.delete(k);
      released.push(r.rawKey || k);
    }
  }

  for (const key of message.keys) {
    if (typeof key !== 'string' || !key || isDangerousKey(key)) continue;
    const mapKey = reservationMapKey(key);
    const reservation = aiReservations.get(mapKey);
    if (message.type === 'tabout-ai-release') {
      if (reservation?.owner === message.owner) {
        aiReservations.delete(mapKey);
        released.push(key);
      }
    } else if (!reservation || reservation.until <= now || reservation.owner === message.owner) {
      aiReservations.set(mapKey, { owner: message.owner, until: now + 30000, rawKey: key });
      claimed.push(key);
    }
  }

  if (aiReservations.size > 200) {
    for (const [k, r] of aiReservations) {
      aiReservations.delete(k);
      released.push(r?.rawKey || k);
      if (aiReservations.size <= 100) break;
    }
  }
  if (released.length && deferredPreclassifyTabs.size) {
    const releasedKeys = new Set(released);
    for (const [tabId, deferred] of deferredPreclassifyTabs) {
      if (deferred.keys.some(key => releasedKeys.has(key))) {
        deferredPreclassifyTabs.delete(tabId);
        if (!pendingPreclassifyTabs.has(tabId)) pendingPreclassifyTabs.set(tabId, deferred.tab);
      }
    }
    if (pendingPreclassifyTabs.size && !isProcessingPreclassifications) {
      processPendingPreclassifications().catch(() => {});
    }
  }
  if (deferredPreclassifyTabs.size > 100) {
    const it = deferredPreclassifyTabs.keys();
    for (let i = 0; i < 20; i++) {
      const k = it.next().value;
      if (k) deferredPreclassifyTabs.delete(k);
    }
  }

  const savePromise = persistReservationsToSession();

  return { claimed, savePromise };
}

function handleAiReservationMessage(message, sender, sendResponse) {
  if (message?.type !== 'tabout-ai-claim' && message?.type !== 'tabout-ai-release') return false;
  if (typeof chrome !== 'undefined' && chrome.runtime?.id && sender?.id !== chrome.runtime.id) return false;
  // Ensure message comes from an internal extension page, not injected content scripts or untrusted origins
  const extensionOrigin = typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL('') : '';
  if (!extensionOrigin || !sender?.url || !sender.url.startsWith(extensionOrigin)) return false;
  if (typeof message.owner !== 'string' || !message.owner.trim() || message.owner.length > 128 || !Array.isArray(message.keys) || message.keys.length > 1000) {
    sendResponse({ claimed: [] });
    return false;
  }

  const processAndRespond = async () => {
    const { claimed } = updateAiReservations(message);
    try {
      await persistReservationsToSession(true);
    } catch {}
    sendResponse({ claimed });
  };

  if (hydrationPromise) {
    hydrationPromise.then(processAndRespond).catch(processAndRespond);
    return true; // Keep IPC channel open for async hydration
  }

  processAndRespond();
  return true;
}

let preclassifyDebounceTimer = null;
let preclassifyResolvers = [];
let isProcessingPreclassifications = false;

/**
 * processPendingPreclassifications()
 *
 * Batches pending tabs across ALL semantic perspectives simultaneously in a single
 * TypeSafe Jev API call (Multi-Question), eliminating redundant network calls and
 * avoiding storage clobbering race conditions.
 */
async function processPendingPreclassifications() {
  if (isProcessingPreclassifications || pendingPreclassifyTabs.size === 0) return;
  isProcessingPreclassifications = true;

  if (hydrationPromise) {
    try { await hydrationPromise; } catch {}
  }

  try {
    while (pendingPreclassifyTabs.size > 0) {
      let semanticPerspectives = [];
      let validTabsInBatch = [];
      let currentCache = {};
      const reservationOwner = `background-${Date.now()}-${Math.random()}`;
      let reservedKeys = [];

      try {
        const settings = await chrome.storage.local.get([
          'openRouterApiKey',
          'classifierApiKey',
          'aiAuthBlocked',
          'perspectives',
          'activePerspectiveId'
        ]);

        const apiKey = (settings.openRouterApiKey || settings.classifierApiKey || '').trim().replace(/[^\x21-\x7E]/g, '');
        if (!apiKey || settings.aiAuthBlocked) {
          pendingPreclassifyTabs.clear();
          break;
        }

        const allPerspectives = settings.perspectives;
        if (!allPerspectives || !Array.isArray(allPerspectives) || allPerspectives.length === 0) {
          pendingPreclassifyTabs.clear();
          break;
        }

        semanticPerspectives = allPerspectives.filter(p => p && p.id && !isDangerousKey(p.id) && p.id !== 'domain' && Array.isArray(p.labels) && p.labels.length > 0);
        if (semanticPerspectives.length === 0) {
          pendingPreclassifyTabs.clear();
          break;
        }

        const partitionKeys = semanticPerspectives.map(p => `tabClassificationCache_${p.id}`);
        const partRes = partitionKeys.length ? await chrome.storage.local.get(partitionKeys) : {};
        let fallbackMonolithic = null;
        currentCache = {};
        for (const p of semanticPerspectives) {
          const partKey = `tabClassificationCache_${p.id}`;
          let rawPart = null;
          if (partRes[partKey] && typeof partRes[partKey] === 'object' && !Array.isArray(partRes[partKey])) {
            rawPart = partRes[partKey];
          } else {
            if (!fallbackMonolithic) {
              const monoRes = await chrome.storage.local.get(['tabClassificationCache']);
              fallbackMonolithic = (monoRes && typeof monoRes.tabClassificationCache === 'object' && !Array.isArray(monoRes.tabClassificationCache)) ? monoRes.tabClassificationCache : {};
            }
            if (fallbackMonolithic && typeof fallbackMonolithic[p.id] === 'object' && !Array.isArray(fallbackMonolithic[p.id])) {
              rawPart = fallbackMonolithic[p.id];
            }
          }
          const cleanPart = {};
          if (rawPart) {
            for (const [k, v] of Object.entries(rawPart)) {
              if (!isDangerousKey(k) && v && typeof v === 'object' && !Array.isArray(v)) {
                cleanPart[k] = v;
              }
            }
          }
          currentCache[p.id] = cleanPart;
        }

        const batch = Array.from(pendingPreclassifyTabs.values()).slice(0, 24);
        for (const t of batch) {
          pendingPreclassifyTabs.delete(t.id || t.url);
        }

        const questions = {};
        const criteriaByPerspective = new Map();

        for (const p of semanticPerspectives) {
          criteriaByPerspective.set(p.id, buildChoiceCriteria(p));
        }

        const seenBatchUrls = new Set();
        batch.forEach((tab, tabIdx) => {
          if (!tab || tab.incognito || !isAiEligibleUrl(tab?.url)) return;
          const normUrl = normalizeUrlForCache(tab.url);
          if (!normUrl || seenBatchUrls.has(normUrl)) return;
          seenBatchUrls.add(normUrl);

          const cleanTitle = stripTitleNoise(tab.title || '').replace(/[\r\n]+/g, ' ').slice(0, 140);
          const cleanUrl = normUrl.slice(0, 140);
          const tabKey = `tab_${tabIdx}`;

          let tabHasAnyQuestion = false;
          for (const p of semanticPerspectives) {
            const pCache = currentCache[p.id] || {};
            const pEntry = pCache[normUrl];
            const isFailedRecently = pEntry?.lastAiAttempt && (Date.now() - pEntry.lastAiAttempt < (pEntry.cooldownMs || 15000));
            if (!isFailedRecently && (!pEntry || !['ai', 'ai-low-confidence'].includes(getCacheSource(pEntry)))) {
              const qKey = `${p.id}__${tabKey}`;
              questions[qKey] = {
                type: 'choice',
                instructions: `Categorize \`tabs.${tabKey}\` into the single most fitting category for "${p.name || p.id}" based on criteria.`,
                criteria: criteriaByPerspective.get(p.id)
              };
              tabHasAnyQuestion = true;
            }
          }

          if (tabHasAnyQuestion) {
            validTabsInBatch.push({ tabKey, cleanTitle, cleanUrl, normUrl, tabIdx });
          }
        });

        if (validTabsInBatch.length === 0 || Object.keys(questions).length === 0) {
          continue;
        }

        const keysByQuestion = new Map();
        for (const t of validTabsInBatch) {
          for (const p of semanticPerspectives) {
            const qKey = `${p.id}__${t.tabKey}`;
            if (questions[qKey]) keysByQuestion.set(qKey, `${p.id}:${t.normUrl}`);
          }
        }
        const claimResult = updateAiReservations({ type: 'tabout-ai-claim', owner: reservationOwner, keys: [...new Set(keysByQuestion.values())] });
        reservedKeys = claimResult.claimed;
        if (claimResult.savePromise) {
          try { await claimResult.savePromise; } catch {}
        }
        const claimed = new Set(reservedKeys);
        for (const t of validTabsInBatch) {
          const blockedKeys = semanticPerspectives
            .map(p => keysByQuestion.get(`${p.id}__${t.tabKey}`))
            .filter(key => key && !claimed.has(key));
          if (blockedKeys.length) {
            const tab = batch[t.tabIdx];
            deferredPreclassifyTabs.set(tab.id || tab.url, { tab, keys: blockedKeys });
          }
        }
        for (const [qKey, key] of keysByQuestion) {
          if (!claimed.has(key)) delete questions[qKey];
        }
        validTabsInBatch = validTabsInBatch.filter(t => semanticPerspectives.some(p => questions[`${p.id}__${t.tabKey}`]));
        if (validTabsInBatch.length === 0) continue;

        const state = { tabs: {} };
        validTabsInBatch.forEach(t => {
          state.tabs[t.tabKey] = {
            title: t.cleanTitle,
            url: stripUrlQueryParams(t.normUrl).slice(0, 300),
            domain: extractHostname(t.normUrl)
          };
        });

        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeoutId = setTimeout(() => controller?.abort(), 12000);

        let response;
        try {
          response = await fetch('https://openrouter.ai/api/alpha/decisions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
              'HTTP-Referer': 'https://github.com/Gohans1/tab-out',
              'X-Title': 'Tab Out Background Preclassifier'
            },
            signal: controller?.signal,
            body: JSON.stringify({
              model: '~typesafe/jev-latest',
              state,
              questions
            })
          });
        } finally {
          clearTimeout(timeoutId);
        }

        if (!response.ok) {
          if (response.status === 401 || response.status === 402 || response.status === 403) {
            const latest = await chrome.storage.local.get(['openRouterApiKey', 'classifierApiKey']);
            const latestKey = (latest.openRouterApiKey || latest.classifierApiKey || '').trim().replace(/[^\x21-\x7E]/g, '');
            if (latestKey === apiKey || (!latestKey && apiKey)) {
              await chrome.storage.local.set({ aiAuthBlocked: true, lastBlockedApiKey: apiKey });
            }
          }
          if (response.status === 401 || response.status === 403 || response.status === 402 || response.status === 429 || response.status === 529) {
            pendingPreclassifyTabs.clear();
          }
          let cooldownMs = 15000;
          const retryAfter = Number(response.headers?.get?.('retry-after'));
          if (!isNaN(retryAfter) && retryAfter > 0) {
            cooldownMs = Math.min(Math.max(retryAfter * 1000, 5000), 300000);
          } else if (response.status === 401 || response.status === 403 || response.status === 429 || response.status === 529) {
            cooldownMs = 60000;
          } else if (response.status === 400 || response.status === 402 || response.status === 422) {
            cooldownMs = 300000;
          }
          const failedUpdates = {};
          validTabsInBatch.forEach(t => {
            semanticPerspectives.forEach(p => {
              if (isDangerousKey(p.id) || isDangerousKey(t.normUrl)) return;
              const qKey = `${p.id}__${t.tabKey}`;
              if (!questions[qKey]) return;
              const existing = currentCache[p.id]?.[t.normUrl];
              if (!existing || !['ai', 'ai-low-confidence'].includes(getCacheSource(existing))) {
                if (!Object.prototype.hasOwnProperty.call(failedUpdates, p.id)) failedUpdates[p.id] = {};
                failedUpdates[p.id][t.normUrl] = {
                  ...(typeof existing === 'object' ? existing : {}),
                  label: existing?.label || 'Khác',
                  source: existing?.source || 'local',
                  cooldownMs,
                  lastAiAttempt: Date.now(),
                  timestamp: Date.now()
                };
              }
            });
          });
          if (Object.keys(failedUpdates).length > 0) {
            await saveBgClassificationCache(failedUpdates);
          }
          break;
        }

        const data = await response.json();
        const answers = (data && typeof data === 'object') ? (data.answers || {}) : {};

        const updates = {};
        for (const [qKey, ans] of Object.entries(answers)) {
          const choice = ans?.choice;
          if (!choice) continue;

          let pid = '';
          let tabKey = '';
          const splitIdx = qKey.lastIndexOf('__');
          if (splitIdx !== -1) {
            pid = qKey.slice(0, splitIdx);
            tabKey = qKey.slice(splitIdx + 2);
          } else {
            // Fallback for single-perspective or legacy mock compatibility
            pid = semanticPerspectives[0]?.id || 'topic';
            tabKey = qKey;
          }

          const tabInfo = validTabsInBatch.find(t => t.tabKey === tabKey);
          if (!tabInfo) continue;

          const criteria = criteriaByPerspective.get(pid);
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

          if (isDangerousKey(pid) || isDangerousKey(tabInfo.normUrl)) continue;
          if (!Object.prototype.hasOwnProperty.call(updates, pid)) updates[pid] = {};
          updates[pid][tabInfo.normUrl] = {
            label: matched,
            secondaryLabel: secondaryLabel || undefined,
            source: isHighConfidence ? 'ai' : 'ai-low-confidence',
            confidence,
            cooldownMs: isHighConfidence ? undefined : 60000,
            lastAiAttempt: isHighConfidence ? undefined : Date.now(),
            timestamp: Date.now()
          };
        }

        if (Object.keys(updates).length > 0) {
          await saveBgClassificationCache(updates);
        }
      } catch (err) {
        // Graceful cooldown on network or runtime error to prevent rapid retry loops
        try {
          if (typeof validTabsInBatch !== 'undefined' && validTabsInBatch.length > 0 && typeof semanticPerspectives !== 'undefined') {
            const cooldownMs = 30000;
            const failedUpdates = {};
            validTabsInBatch.forEach(t => {
              semanticPerspectives.forEach(p => {
                if (isDangerousKey(p.id) || isDangerousKey(t.normUrl)) return;
                const existing = currentCache?.[p.id]?.[t.normUrl];
                if (!existing || !['ai', 'ai-low-confidence'].includes(getCacheSource(existing))) {
                  if (!Object.prototype.hasOwnProperty.call(failedUpdates, p.id)) failedUpdates[p.id] = {};
                  failedUpdates[p.id][t.normUrl] = {
                    ...(typeof existing === 'object' ? existing : {}),
                    label: existing?.label || 'Khác',
                    source: existing?.source || 'local',
                    cooldownMs,
                    lastAiAttempt: Date.now(),
                    timestamp: Date.now()
                  };
                }
              });
            });
            if (Object.keys(failedUpdates).length > 0) {
              await saveBgClassificationCache(failedUpdates);
            }
          }
        } catch {}
        break;
      } finally {
        if (reservedKeys.length > 0) {
          const releaseResult = updateAiReservations({ type: 'tabout-ai-release', owner: reservationOwner, keys: reservedKeys });
          if (releaseResult?.savePromise) {
            try { await releaseResult.savePromise; } catch {}
          }
          reservedKeys = [];
        }
      }
    }
  } finally {
    isProcessingPreclassifications = false;
    const resolvers = preclassifyResolvers;
    preclassifyResolvers = [];
    for (const res of resolvers) {
      try { res(); } catch {}
    }
  }
}

/**
 * preclassifyTabInBackground(tab)
 *
 * Runs non-blocking AI pre-classification for newly loaded tabs in the service worker.
 * Debounced and batched across multiple perspectives for 0ms instant display.
 */
async function preclassifyTabInBackground(tab) {
  if (!tab || tab.incognito || !isAiEligibleUrl(tab.url)) return;

  const key = tab.id || tab.url;
  deferredPreclassifyTabs.delete(key);
  pendingPreclassifyTabs.set(key, tab);
  if (pendingPreclassifyTabs.size > 100) {
    const firstKey = pendingPreclassifyTabs.keys().next().value;
    if (firstKey) pendingPreclassifyTabs.delete(firstKey);
  }

  if (preclassifyDebounceTimer) {
    clearTimeout(preclassifyDebounceTimer);
  }

  return new Promise((resolve) => {
    preclassifyResolvers.push(resolve);
    preclassifyDebounceTimer = setTimeout(async () => {
      try {
        await processPendingPreclassifications();
      } catch {}
      if (!isProcessingPreclassifications && pendingPreclassifyTabs.size === 0) {
        const resolvers = preclassifyResolvers;
        preclassifyResolvers = [];
        for (const res of resolvers) {
          try { res(); } catch {}
        }
      }
    }, 250);
  });
}

// ─── Event listeners ──────────────────────────────────────────────────────────

if (typeof chrome !== 'undefined') {
  chrome.runtime?.onMessage?.addListener(handleAiReservationMessage);
  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    const keyChanged = (changes.openRouterApiKey && changes.openRouterApiKey.oldValue !== changes.openRouterApiKey.newValue) ||
                       (changes.classifierApiKey && changes.classifierApiKey.oldValue !== changes.classifierApiKey.newValue);
    if (areaName === 'local' && keyChanged) {
      chrome.storage.local.get(['aiAuthBlocked']).then(res => {
        if (res?.aiAuthBlocked === true) {
          chrome.storage.local.set({ aiAuthBlocked: false, lastBlockedApiKey: null }).catch(() => {});
        }
      }).catch(() => {});
    }
  });
  // Update badge when the extension is first installed
  chrome.runtime?.onInstalled?.addListener(() => {
    updateBadge();
    setupContextMenus();
  });

  // Handle context menu clicks (e.g. "New Tab")
  chrome.contextMenus?.onClicked?.addListener(handleContextMenuClick);

  // Update badge when Chrome starts up
  chrome.runtime?.onStartup?.addListener(() => {
    updateBadge();
  });

  // Debounce badge updates to prevent IPC storms during bulk tab operations
  let badgeDebounceTimer = null;
  const debouncedUpdateBadge = (delay = 100) => {
    clearTimeout(badgeDebounceTimer);
    badgeDebounceTimer = setTimeout(() => {
      updateBadge();
    }, delay);
  };

  // Update badge whenever a tab is opened
  chrome.tabs?.onCreated?.addListener(() => {
    debouncedUpdateBadge();
  });

  // Update badge whenever a tab is closed and purge from preclassification queues
  chrome.tabs?.onRemoved?.addListener((tabId) => {
    pendingPreclassifyTabs.delete(tabId);
    deferredPreclassifyTabs.delete(tabId);
    debouncedUpdateBadge();
  });

  // Update badge when a tab's URL changes
  chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
      debouncedUpdateBadge();
    }
  });
}

/**
 * setupContextMenus()
 *
 * Registers the "New Tab" context menu entry so right-clicking
 * anywhere on any webpage lets users open a new tab directly into Tab Out.
 */
function setupContextMenus() {
  if (typeof chrome === 'undefined' || !chrome.contextMenus?.create) return;
  try {
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime?.lastError;
      chrome.contextMenus.create({
        id: 'tabout-open-new-tab',
        title: 'New Tab',
        contexts: ['all']
      }, () => {
        void chrome.runtime?.lastError;
      });
    });
  } catch {
    // Ignore synchronous errors in test/mock environments
  }
}

/**
 * handleContextMenuClick(info, tab)
 *
 * Handles clicks on Tab Out's context menu entries.
 */
function handleContextMenuClick(info, tab) {
  if (info?.menuItemId === 'tabout-open-new-tab') {
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      chrome.tabs.create({});
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    updateBadge,
    preclassifyTabInBackground,
    buildChoiceCriteria,
    saveBgClassificationCache,
    handleAiReservationMessage,
    isAiEligibleUrl,
    isDangerousKey,
    setupContextMenus,
    handleContextMenuClick,
    stripUrlQueryParams,
    stripUserInfoFallback,
    stripTitleNoise,
    isFallbackLabel,
    isRealTabUrl,
    _resetAiReservationsForTesting,
    hydrateAiReservationsFromSession,
    aiReservations,
    deferredPreclassifyTabs,
    pendingPreclassifyTabs
  };
}
