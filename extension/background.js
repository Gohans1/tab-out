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
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

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

    await chrome.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Background AI Pre-Classification Engine ────────────────────────────────

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'msclkid', 'mc_eid', '_ga',
  'ref', 'source', 'feature', 'si', 't',
  'oq', 'aqs', 'sourceid', 'ved', 'ei'
]);

const HYGIENE_SCORE_CRITERIA = [
  'Persistent important active workspace, primary application, document being edited, or critical reference',
  'Secondary reference, documentation, article being read, or active task context',
  'Browsing, search results, social feed, or non-critical reading',
  'Temporary search query, disposable lookup, ad, redirect, promotional page, or duplicate tab safe to close'
];

const bgNormalizedUrlCache = new Map();

function normalizeUrlForCache(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (bgNormalizedUrlCache.has(trimmed)) {
    return bgNormalizedUrlCache.get(trimmed);
  }
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';

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
    return trimmed;
  }
}

function buildChoiceCriteria(perspective) {
  const criteria = {};
  if (!perspective || !Array.isArray(perspective.labels)) return criteria;
  let hasOther = false;
  for (const item of perspective.labels) {
    const name = typeof item === 'string' ? item : item?.name;
    if (!name) continue;
    const low = name.toLowerCase();
    if (/\b(khác|other)\b/i.test(low)) hasOther = true;
    const desc = typeof item === 'string' ? '' : item?.description;
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
    const host = colonIdx === -1 ? hostWithPort : hostWithPort.slice(0, colonIdx);
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
      const latestStorage = await chrome.storage.local.get(['tabClassificationCache', ...partitionKeys]);
      const mergedCache = latestStorage.tabClassificationCache || {};
      const storageToSet = {};

      let hasChanges = false;
      for (const [pid, newItems] of Object.entries(updates)) {
        const partitionKey = `tabClassificationCache_${pid}`;
        let partitionCache = latestStorage[partitionKey];
        if (!partitionCache || typeof partitionCache !== 'object') {
          partitionCache = mergedCache[pid] || {};
        }

        for (const [urlKey, entry] of Object.entries(newItems)) {
          const existing = partitionCache[urlKey];
          // Protect existing high-confidence AI entries from being downgraded
          if (existing && existing.source === 'ai' && entry.source !== 'ai') {
            continue;
          }
          if (existing && existing.source === 'ai' && entry.source === 'ai' &&
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
          hasChanges = true;
        }

        const pEntries = Object.entries(partitionCache);
        if (pEntries.length > 1000) {
          pEntries.sort((a, b) => ((b[1]?.timestamp || 0) - (a[1]?.timestamp || 0)));
          partitionCache = Object.fromEntries(pEntries.slice(0, 1000));
        }

        mergedCache[pid] = partitionCache;
        storageToSet[partitionKey] = partitionCache;
      }

      if (hasChanges) {
        storageToSet.tabClassificationCache = mergedCache;
        await chrome.storage.local.set(storageToSet);
      }
    } catch {}
  });
}

// ─── Debounced Multi-Perspective Background Preclassifier ────────────────────

const pendingPreclassifyTabs = new Map();
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

  let semanticPerspectives = [];
  let validTabsInBatch = [];
  let currentCache = {};

  try {
    const settings = await chrome.storage.local.get([
      'openRouterApiKey',
      'perspectives',
      'activePerspectiveId',
      'tabClassificationCache'
    ]);

    const apiKey = settings.openRouterApiKey;
    if (!apiKey) {
      pendingPreclassifyTabs.clear();
      return;
    }

    const allPerspectives = settings.perspectives;
    if (!allPerspectives || !Array.isArray(allPerspectives) || allPerspectives.length === 0) {
      pendingPreclassifyTabs.clear();
      return;
    }

    semanticPerspectives = allPerspectives.filter(p => p.id !== 'domain' && p.labels && p.labels.length > 0);
    if (semanticPerspectives.length === 0) {
      pendingPreclassifyTabs.clear();
      return;
    }

    const batch = Array.from(pendingPreclassifyTabs.values()).slice(0, 12);
    for (const t of batch) {
      pendingPreclassifyTabs.delete(t.id || t.url);
    }

    currentCache = settings.tabClassificationCache || {};
    const questions = {};
    const criteriaByPerspective = new Map();

    for (const p of semanticPerspectives) {
      criteriaByPerspective.set(p.id, buildChoiceCriteria(p));
    }

    const seenBatchUrls = new Set();
    batch.forEach((tab, tabIdx) => {
      const normUrl = normalizeUrlForCache(tab.url);
      if (!normUrl || seenBatchUrls.has(normUrl)) return;
      seenBatchUrls.add(normUrl);

      const cleanTitle = (tab.title || '').replace(/[\r\n]+/g, ' ').slice(0, 140);
      const cleanUrl = normUrl.slice(0, 140);
      const tabKey = `tab_${tabIdx}`;

      let tabHasAnyQuestion = false;
      for (const p of semanticPerspectives) {
        const pCache = currentCache[p.id] || {};
        const pEntry = pCache[normUrl];
        const isFailedRecently = pEntry?.lastAiAttempt && (Date.now() - pEntry.lastAiAttempt < (pEntry.cooldownMs || 15000));
        if (!isFailedRecently && (!pEntry || pEntry.source !== 'ai')) {
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
        questions[`hygiene__${tabKey}`] = {
          type: 'score',
          instructions: `Rate if \`tabs.${tabKey}\` is disposable or transient: 0 for persistent important active workspace, up to 3 for temporary search/disposable lookup/duplicate tab safe to close.`,
          criteria: HYGIENE_SCORE_CRITERIA
        };
        validTabsInBatch.push({ tabKey, cleanTitle, cleanUrl, normUrl, tabIdx });
      }
    });

    if (validTabsInBatch.length === 0 || Object.keys(questions).length === 0) {
      return;
    }

    const state = { tabs: {} };
    validTabsInBatch.forEach(t => {
      state.tabs[t.tabKey] = {
        title: t.cleanTitle,
        url: t.normUrl.slice(0, 300),
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
          const qKey = `${p.id}__${t.tabKey}`;
          if (!questions[qKey]) return;
          const existing = currentCache[p.id]?.[t.normUrl];
          if (!existing || existing.source !== 'ai') {
            if (!failedUpdates[p.id]) failedUpdates[p.id] = {};
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
      return;
    }
    const data = await response.json();
    const answers = data.answers || {};

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

      const hygieneAns = answers[`hygiene__${tabKey}`];
      const hygieneScore = (hygieneAns && typeof hygieneAns.score === 'number') ? hygieneAns.score : undefined;

      if (!updates[pid]) updates[pid] = {};
      updates[pid][tabInfo.normUrl] = {
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

    await saveBgClassificationCache(updates);
  } catch (err) {
    // Graceful cooldown on network or runtime error to prevent rapid retry loops
    try {
      if (typeof validTabsInBatch !== 'undefined' && validTabsInBatch.length > 0 && typeof semanticPerspectives !== 'undefined') {
        const cooldownMs = 30000;
        const failedUpdates = {};
        validTabsInBatch.forEach(t => {
          semanticPerspectives.forEach(p => {
            const existing = currentCache?.[p.id]?.[t.normUrl];
            if (!existing || existing.source !== 'ai') {
              if (!failedUpdates[p.id]) failedUpdates[p.id] = {};
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
  } finally {
    isProcessingPreclassifications = false;
    if (pendingPreclassifyTabs.size > 0) {
      processPendingPreclassifications().catch(() => {});
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
  if (!tab || !tab.url) return;
  const url = tab.url;

  // Skip browser internals, extension pages, and local files
  if (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('about:') ||
    url.startsWith('edge://') ||
    url.startsWith('brave://') ||
    url.startsWith('file://')
  ) {
    return;
  }

  const key = tab.id || url;
  pendingPreclassifyTabs.set(key, tab);

  if (preclassifyDebounceTimer) {
    clearTimeout(preclassifyDebounceTimer);
  }

  return new Promise((resolve) => {
    preclassifyResolvers.push(resolve);
    if (preclassifyDebounceTimer) {
      clearTimeout(preclassifyDebounceTimer);
    }
    preclassifyDebounceTimer = setTimeout(async () => {
      const resolvers = preclassifyResolvers;
      preclassifyResolvers = [];
      try {
        await processPendingPreclassifications();
      } finally {
        for (const res of resolvers) {
          try { res(); } catch {}
        }
      }
    }, 250);
  });
}

// ─── Event listeners ──────────────────────────────────────────────────────────

if (typeof chrome !== 'undefined') {
  // Update badge when the extension is first installed
  chrome.runtime?.onInstalled?.addListener(() => {
    updateBadge();
  });

  // Update badge when Chrome starts up
  chrome.runtime?.onStartup?.addListener(() => {
    updateBadge();
  });

  // Update badge whenever a tab is opened
  chrome.tabs?.onCreated?.addListener(() => {
    updateBadge();
  });

  // Update badge whenever a tab is closed
  chrome.tabs?.onRemoved?.addListener(() => {
    updateBadge();
  });

  // Update badge when a tab's URL changes and pre-classify loaded web tabs
  chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
    updateBadge();
    if (changeInfo && changeInfo.status === 'complete' && tab && tab.url) {
      preclassifyTabInBackground(tab);
    }
  });

  // ─── Initial run ─────────────────────────────────────────────────────────────

  // Run once immediately when the service worker first loads
  updateBadge();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    updateBadge,
    preclassifyTabInBackground,
    buildChoiceCriteria,
    saveBgClassificationCache
  };
}
