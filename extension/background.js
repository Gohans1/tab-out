/**
 * background.js — Service Worker
 *
 * Two jobs:
 *   1. Keep the toolbar badge showing the current open tab count.
 *   2. Run every Jev classification request and own the classification cache,
 *      so dashboards that close mid-request never waste a paid answer.
 *
 * The badge counts real web tabs (skipping chrome:// and extension pages).
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

// ─── Jev classification worker ───────────────────────────────────────────────
// Every Jev request runs here, not in a dashboard: a new-tab dashboard is often navigated away
// within a second, which would throw away a request already sent and billed. Being the only
// writer of the classification partitions also leaves no write races to reconcile.

const JEV_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const JEV_MODEL = '~typesafe/jev-latest';
const JEV_TIMEOUT_MS = 10000;
const JEV_MAX_BATCH = 24;
// Jev's context is 32k tokens and the criteria repeat in every question, so batches are cut by size.
const JEV_BATCH_CHAR_BUDGET = 48000;
const AI_BASE_COOLDOWN_MS = 15000;
const AI_MAX_COOLDOWN_MS = 60 * 60 * 1000;
const JEV_MAX_BREAKER_MS = 15 * 60 * 1000;
const CLASSIFICATION_CACHE_MAX = 1000;
const MAX_CACHE_KEY_LENGTH = 2048;
const AI_SOURCES = ['ai', 'ai-low-confidence'];

const jevInFlight = new Set();
let jevQueue = Promise.resolve();
let jevBlockedUntil = 0;
// Consecutive failures of the endpoint itself; each one doubles how long the breaker holds.
let jevFailStreak = 0;

function _resetJevWorkerForTesting() {
  jevInFlight.clear();
  jevQueue = Promise.resolve();
  jevBlockedUntil = 0;
  jevFailStreak = 0;
}

const partitionKey = pid => `tabClassificationCache_${pid}`;
const sanitizeApiKey = key => (typeof key === 'string' ? key : '').trim().replace(/[^\x21-\x7E]/g, '');
const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

function getCacheSource(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return 'ai'; // legacy string cache
  return entry.source || 'local';
}

const isAiEntry = entry => AI_SOURCES.includes(getCacheSource(entry));

// Same rule the dashboard uses: a tab needs Jev unless it has an AI answer or is cooling down.
function needsJev(entry, now) {
  if (!entry) return true;
  if (isAiEntry(entry)) return false;
  return !(entry.lastAiAttempt && now - entry.lastAiAttempt < (entry.cooldownMs || AI_BASE_COOLDOWN_MS));
}

// Doubles the retry cooldown on every consecutive failure of the same URL, capped at one hour.
function nextAiBackoff(prevEntry, baseMs) {
  const aiAttempts = ((prevEntry && prevEntry.aiAttempts) || 0) + 1;
  return { aiAttempts, cooldownMs: Math.min(baseMs * 2 ** (aiAttempts - 1), AI_MAX_COOLDOWN_MS) };
}

// Same pattern as isFallbackLabel() in app.js.
const FALLBACK_TAG_REGEX = /^(khác|other|misc|linh tinh|chưa phân loại)(\s*[\/\(\-]\s*(chưa phân loại|unclassified|other|khác|misc|tổng hợp)\)?)?$/iu;

// What a perspective's answers depend on: its tags' names and descriptions, ignoring order, case and
// the fallback tag. app.js has the same function and wipes a partition only when it changes.
function perspectiveLabelsSignature(perspective) {
  const labels = Array.isArray(perspective?.labels) ? perspective.labels : [];
  return labels
    .map(l => (typeof l === 'string' ? { name: l } : l || {}))
    .map(l => [typeof l.name === 'string' ? l.name.trim() : '', typeof l.description === 'string' ? l.description.trim() : ''])
    .filter(([name]) => name && !FALLBACK_TAG_REGEX.test(name))
    .map(([name, desc]) => `${name.toLowerCase()}::${desc.toLowerCase()}`)
    .sort()
    .join('|');
}

// Fingerprint of a stored perspective's tags; null when the perspective no longer exists.
function labelsSignature(perspectives, pid) {
  const p = Array.isArray(perspectives) ? perspectives.find(x => x && typeof x === 'object' && x.id === pid) : null;
  return p ? perspectiveLabelsSignature(p) : null;
}

function readPartition(raw) {
  const clean = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (!isDangerousKey(k) && v) clean[k] = v;
    }
  }
  return clean;
}

// Keeps the newest answers, but never drops open tabs: they would be paid for again.
function pruneClassificationCache(cache, maxEntries = CLASSIFICATION_CACHE_MAX, keepKeys = []) {
  const entries = Object.entries(cache);
  if (entries.length <= maxEntries) return cache;
  const keep = new Set(keepKeys);
  const ts = entry => (entry && typeof entry === 'object' && entry.timestamp) || 0;
  entries.sort((a, b) => (keep.has(b[0]) - keep.has(a[0])) || ts(b[1]) - ts(a[1]));
  return Object.fromEntries(entries.slice(0, maxEntries));
}

// A completed AI answer is never replaced by a local guess, nor by a less confident answer.
function isUpgrade(existing, incoming) {
  if (!existing) return true;
  const oldSrc = getCacheSource(existing);
  const newSrc = getCacheSource(incoming);
  if (AI_SOURCES.includes(oldSrc) && !AI_SOURCES.includes(newSrc)) return false;
  if (oldSrc === 'ai' && newSrc === 'ai-low-confidence') return false;
  if (oldSrc === 'ai' && newSrc === 'ai' && typeof existing.confidence === 'number' &&
      typeof incoming.confidence === 'number' && incoming.confidence < existing.confidence) return false;
  return true;
}

function isSameEntry(a, b) {
  return Boolean(a) && typeof a === 'object' &&
    ['label', 'source', 'confidence', 'secondaryLabel', 'lastAiAttempt', 'aiAttempts'].every(f => a[f] === b[f]);
}

/**
 * saveClassificationCacheAtomic(pid, newEntries, { labelsSig, keepKeys })
 *
 * Merges answers into one perspective's partition and returns what is stored for those keys.
 * Nothing is written when the perspective was deleted, or its tags edited, while Jev was answering.
 */
async function saveClassificationCacheAtomic(pid, newEntries, { labelsSig = null, keepKeys = [] } = {}) {
  const stored = {};
  if (isDangerousKey(pid) || !newEntries || typeof newEntries !== 'object') return stored;
  const key = partitionKey(pid);
  try {
    const res = await chrome.storage.local.get([key, 'perspectives']);
    const sig = labelsSignature(res.perspectives, pid);
    if (Array.isArray(res.perspectives) && sig === null) return stored;
    if (labelsSig !== null && sig !== labelsSig) return stored;

    const partition = readPartition(res[key]);
    let changed = false;
    for (const [urlKey, entry] of Object.entries(newEntries)) {
      if (isDangerousKey(urlKey)) continue;
      const incoming = typeof entry === 'string'
        ? { label: entry, source: 'ai', timestamp: Date.now() }
        : (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null);
      if (!incoming) continue;
      const existing = partition[urlKey];
      if (isUpgrade(existing, incoming) && !isSameEntry(existing, incoming)) {
        partition[urlKey] = { ...(existing && typeof existing === 'object' ? existing : {}), ...incoming };
        changed = true;
      }
      stored[urlKey] = partition[urlKey];
    }

    const pruned = pruneClassificationCache(partition, CLASSIFICATION_CACHE_MAX, keepKeys);
    if (pruned !== partition) changed = true;
    for (const k of Object.keys(stored)) {
      if (!(k in pruned)) delete stored[k];
    }
    if (changed) await chrome.storage.local.set({ [key]: pruned });
  } catch (err) {
    console.warn('[tab-out] Failed to save classification cache:', err);
  }
  return stored;
}

async function readBlockedUntil() {
  try {
    const res = await chrome.storage.session?.get(['jevBlockedUntil', 'jevFailStreak']);
    jevBlockedUntil = Math.max(jevBlockedUntil, Number(res?.jevBlockedUntil) || 0);
    jevFailStreak = Math.max(jevFailStreak, Number(res?.jevFailStreak) || 0);
  } catch {}
  return jevBlockedUntil;
}

function saveBreaker() {
  try { chrome.storage.session?.set({ jevBlockedUntil, jevFailStreak })?.catch?.(() => {}); } catch {}
}

// One breaker for every tab and dashboard; kept in session storage to outlive a worker restart.
// A Retry-After is followed as given; otherwise each consecutive failure doubles the hold (capped
// at 15 min), so an outage costs a handful of requests instead of one every 15s.
function blockJev(minMs, fromRetryAfter = false) {
  jevFailStreak++;
  const escalated = Math.min(AI_BASE_COOLDOWN_MS * 2 ** (jevFailStreak - 1), JEV_MAX_BREAKER_MS);
  const ms = fromRetryAfter ? minMs : Math.max(minMs, escalated);
  jevBlockedUntil = Math.max(jevBlockedUntil, Date.now() + ms);
  saveBreaker();
}

function clearFailStreak() {
  if (!jevFailStreak) return;
  jevFailStreak = 0;
  saveBreaker();
}

async function blockAuth(requestKey) {
  const latest = await chrome.storage.local.get(['openRouterApiKey', 'classifierApiKey']);
  const storedKey = sanitizeApiKey(latest?.openRouterApiKey || latest?.classifierApiKey || '');
  // A 401 for a key the user has since replaced says nothing about the new key.
  if (storedKey === requestKey || !storedKey) {
    await chrome.storage.local.set({ aiAuthBlocked: true, lastBlockedApiKey: requestKey });
  }
}

function splitIntoBatches(items, criteria) {
  const perQuestion = JSON.stringify(criteria).length + 160;
  const batches = [];
  let current = [];
  let size = 0;
  for (const item of items) {
    const cost = perQuestion + item.title.length + item.url.length + item.domain.length + 60;
    if (current.length && (current.length >= JEV_MAX_BATCH || size + cost > JEV_BATCH_CHAR_BUDGET)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

function buildJevRequest(batch, criteria) {
  const state = { tabs: {} };
  const questions = {};
  batch.forEach((item, idx) => {
    const qKey = `tab_${idx}`;
    state.tabs[qKey] = { title: item.title, url: item.url, domain: item.domain };
    questions[qKey] = {
      type: 'choice',
      instructions: `Categorize \`tabs.${qKey}\` into the single most fitting category based on title, domain, and criteria.`,
      criteria
    };
  });
  return { model: JEV_MODEL, state, questions };
}

function failedEntries(batch, cache, baseMs, labelOverride) {
  const now = Date.now();
  const entries = {};
  for (const item of batch) {
    entries[item.key] = {
      label: labelOverride || item.fallbackLabel,
      source: 'local',
      ...nextAiBackoff(cache[item.key], baseMs),
      lastAiAttempt: now,
      timestamp: now
    };
  }
  return entries;
}

function answerEntries(batch, answers, criteria, cache) {
  const now = Date.now();
  const labels = Object.keys(criteria);
  const match = choice => labels.find(l => l.trim().toLowerCase() === String(choice).trim().toLowerCase());
  const entries = {};
  batch.forEach((item, idx) => {
    const ans = answers[`tab_${idx}`];
    const label = ans?.choice ? match(ans.choice) : null;
    if (!label) {
      Object.assign(entries, failedEntries([item], cache, AI_BASE_COOLDOWN_MS, null));
      return;
    }
    const confidence = typeof ans.confidence === 'number' ? ans.confidence : 1.0;
    const entry = { label, source: confidence >= 0.45 ? 'ai' : 'ai-low-confidence', confidence, timestamp: now };
    if (ans.probabilities && typeof ans.probabilities === 'object') {
      const [runnerUp] = Object.entries(ans.probabilities)
        .filter(([k]) => match(k) && match(k) !== label)
        .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0));
      if (runnerUp && Number(runnerUp[1]) >= 0.20) entry.secondaryLabel = match(runnerUp[0]);
    }
    entries[item.key] = entry;
  });
  return entries;
}

// Sends one batch. `stop` means no further batch should go out: the key or the endpoint is failing.
async function askJev(batch, job, cache) {
  let response;
  let data;
  try {
    response = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${job.apiKey}`,
        'HTTP-Referer': 'https://github.com/Gohans1/tab-out',
        'X-Title': 'Tab Out'
      },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(JEV_TIMEOUT_MS) : undefined,
      body: JSON.stringify(buildJevRequest(batch, job.criteria))
    });
    if (response.ok) data = await response.json();
  } catch (err) {
    // Network failure, timeout, or an unreadable body: the endpoint itself is unwell.
    console.warn('[tab-out] Jev request failed:', err);
    blockJev(AI_BASE_COOLDOWN_MS);
    return { entries: failedEntries(batch, cache, AI_BASE_COOLDOWN_MS, null), stop: true };
  }

  if (response.ok) {
    clearFailStreak();
    const answers = data && typeof data === 'object' && data.answers && typeof data.answers === 'object' ? data.answers : {};
    return { entries: answerEntries(batch, answers, job.criteria, cache), stop: false };
  }

  const status = response.status;
  const retryAfter = Number(response.headers?.get?.('retry-after'));
  let cooldownMs = AI_BASE_COOLDOWN_MS;
  if (retryAfter > 0) {
    cooldownMs = Math.min(Math.max(retryAfter * 1000, 5000), 300000);
  } else if ([401, 403, 429, 529].includes(status)) {
    cooldownMs = 60000;
  } else if ([400, 402, 404, 405, 410, 422].includes(status)) {
    cooldownMs = 300000;
  }
  const authFailed = [401, 402, 403].includes(status);
  // 400/413/422 can come from one batch's content; a missing or timed-out endpoint fails every batch.
  const endpointDown = status === 429 || status >= 500 || [404, 405, 408, 410].includes(status);
  console.warn(`[tab-out] Jev request failed: HTTP ${status}`);
  if (authFailed) await blockAuth(job.apiKey);
  if (endpointDown) blockJev(cooldownMs, retryAfter > 0);
  return {
    entries: failedEntries(batch, cache, cooldownMs, authFailed ? job.otherLabel : null),
    stop: authFailed || endpointDown
  };
}

// A job can wait seconds in the queue: a tab closed or navigated away meanwhile is not worth paying for.
async function openTabUrls() {
  try {
    const tabs = await chrome.tabs?.query?.({});
    return Array.isArray(tabs) ? new Map(tabs.map(t => [t.id, t.url || t.pendingUrl || ''])) : null;
  } catch {
    return null;
  }
}

async function runJevJob(job) {
  const { pid } = job;
  const results = {};
  let labelsSig = null;
  const batches = splitIntoBatches(job.items, job.criteria);
  for (let b = 0; b < batches.length; b++) {
    if (Date.now() < await readBlockedUntil()) break;
    const store = await chrome.storage.local.get([partitionKey(pid), 'perspectives', 'activePerspectiveId', 'aiAuthBlocked']);
    if (store.aiAuthBlocked === true) break;
    const sig = labelsSignature(store.perspectives, pid);
    // A deleted perspective, or tags edited since the dashboard built this job's criteria: the
    // answers would file tabs under tags the user no longer has.
    if (Array.isArray(store.perspectives) && (sig === null || (job.labelsSig !== null && sig !== job.labelsSig))) break;
    if (b === 0) labelsSig = sig;
    else if (sig !== labelsSig) break;
    // Strict on-demand: the batch in flight may finish, but no new one starts for a perspective the user left.
    if (store.activePerspectiveId && store.activePerspectiveId !== pid) break;

    const cache = readPartition(store[partitionKey(pid)]);
    const open = await openTabUrls();
    const now = Date.now();
    const batch = [];
    for (const item of batches[b]) {
      if (open && item.tabId !== undefined && open.get(item.tabId) !== item.tabUrl) continue;
      if (needsJev(cache[item.key], now)) batch.push(item);
      else if (isAiEntry(cache[item.key])) results[item.key] = cache[item.key];
    }
    if (!batch.length) continue;

    const { entries, stop } = await askJev(batch, job, cache);
    Object.assign(results, await saveClassificationCacheAtomic(pid, entries, { labelsSig, keepKeys: job.keepKeys }));
    if (stop) break;
  }
  return results;
}

function parseJevJob(m) {
  const pid = typeof m.pid === 'string' ? m.pid : '';
  const apiKey = sanitizeApiKey(m.apiKey);
  if (!pid || pid === 'domain' || isDangerousKey(pid) || !apiKey) return null;
  if (!m.criteria || typeof m.criteria !== 'object' || Array.isArray(m.criteria)) return null;
  if (!Array.isArray(m.items) || m.items.length > 1000) return null;

  const criteria = {};
  for (const [name, desc] of Object.entries(m.criteria)) {
    if (isDangerousKey(name) || name.length > 50) continue;
    criteria[name] = typeof desc === 'string' ? desc.slice(0, 300) : (desc && typeof desc === 'object' ? desc : name);
  }
  if (Object.keys(criteria).length < 2) return null;

  const seen = new Set();
  const items = [];
  for (const it of m.items) {
    // An oversized key is skipped, not clipped: a clipped key would never match the dashboard's.
    const key = typeof it?.key === 'string' && it.key.length <= MAX_CACHE_KEY_LENGTH ? it.key : '';
    if (!key || isDangerousKey(key) || seen.has(key)) continue;
    seen.add(key);
    items.push({
      key,
      tabId: Number.isInteger(it.tabId) ? it.tabId : undefined,
      tabUrl: typeof it.tabUrl === 'string' ? it.tabUrl : '',
      title: clip(it.title, 140),
      url: clip(it.url, 300),
      domain: clip(it.domain, 253),
      fallbackLabel: clip(it.fallbackLabel, 50)
    });
  }
  if (!items.length) return null;

  const keepKeys = Array.isArray(m.keepKeys)
    ? m.keepKeys.filter(k => typeof k === 'string' && !isDangerousKey(k)).slice(0, 5000)
    : [];
  const labelsSig = typeof m.labelsSig === 'string' ? m.labelsSig : null;
  return { pid, apiKey, criteria, otherLabel: clip(m.otherLabel, 50) || 'Other', items, keepKeys, labelsSig };
}

// A new API key deserves a real retry: drop the breaker and every stored failure cooldown.
async function resetJevCooldowns() {
  jevBlockedUntil = 0;
  jevFailStreak = 0;
  try { await chrome.storage.session?.set({ jevBlockedUntil: 0, jevFailStreak: 0 }); } catch {}
  try {
    const { perspectives } = await chrome.storage.local.get(['perspectives']);
    const keys = (Array.isArray(perspectives) ? perspectives : [])
      .map(p => p?.id)
      .filter(id => typeof id === 'string' && !isDangerousKey(id))
      .map(partitionKey);
    if (!keys.length) return;
    const res = await chrome.storage.local.get(keys);
    const updates = {};
    for (const key of keys) {
      const partition = readPartition(res[key]);
      let changed = false;
      for (const entry of Object.values(partition)) {
        if (entry && typeof entry === 'object' && !isAiEntry(entry) && (entry.lastAiAttempt || entry.aiAttempts)) {
          delete entry.lastAiAttempt;
          delete entry.cooldownMs;
          delete entry.aiAttempts;
          changed = true;
        }
      }
      if (changed) updates[key] = partition;
    }
    if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  } catch (err) {
    console.warn('[tab-out] Failed to reset Jev cooldowns:', err);
  }
}

function isTrustedSender(sender) {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id || sender?.id !== chrome.runtime.id) return false;
  // Only the extension's own pages, never content scripts or web origins.
  const extensionOrigin = chrome.runtime.getURL ? chrome.runtime.getURL('') : '';
  return Boolean(extensionOrigin && sender.url && sender.url.startsWith(extensionOrigin));
}

/**
 * handleJevMessage(message, sender, sendResponse)
 *
 * { type: 'tabout-jev-classify', pid, apiKey, criteria, otherLabel, items, keepKeys }
 *   Responds with the entries stored for the job's tabs and how long Jev stays blocked.
 * { type: 'tabout-jev-reset' } — sent when the user saves a new API key.
 * Jobs run one at a time; a tab already queued or in flight is not asked for twice.
 */
function handleJevMessage(message, sender, sendResponse) {
  const type = message?.type;
  if ((type !== 'tabout-jev-classify' && type !== 'tabout-jev-reset') || !isTrustedSender(sender)) return false;
  if (type === 'tabout-jev-reset') {
    const reset = jevQueue.then(resetJevCooldowns);
    jevQueue = reset.catch(() => {});
    reset.catch(() => {}).then(() => {
      try { sendResponse({ blockedUntil: jevBlockedUntil }); } catch {}
    });
    return true;
  }
  const job = parseJevJob(message);
  if (!job) {
    sendResponse({ entries: {}, blockedUntil: jevBlockedUntil });
    return false;
  }

  const flightKey = item => `${job.pid}:${item.key}`;
  const items = job.items.filter(item => !jevInFlight.has(flightKey(item)));
  for (const item of items) jevInFlight.add(flightKey(item));

  const run = jevQueue.then(() => (items.length ? runJevJob({ ...job, items }) : {}));
  jevQueue = run.catch(() => {});
  run.catch(err => {
    console.warn('[tab-out] Jev job failed:', err);
    return {};
  }).then(entries => {
    for (const item of items) jevInFlight.delete(flightKey(item));
    try { sendResponse({ entries, blockedUntil: jevBlockedUntil }); } catch {}
  });
  return true;
}

// Older versions kept every perspective under one key; split it into partitions once, then drop it.
async function migrateLegacyClassificationCache() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  try {
    const res = await chrome.storage.local.get(['tabClassificationCache', 'perspectives']);
    const mono = res.tabClassificationCache;
    if (mono === undefined) return;
    if (mono && typeof mono === 'object' && !Array.isArray(mono)) {
      const liveIds = Array.isArray(res.perspectives) ? new Set(res.perspectives.map(p => p?.id)) : null;
      const pids = Object.keys(mono).filter(pid => !isDangerousKey(pid) && (!liveIds || liveIds.has(pid)));
      const existing = await chrome.storage.local.get(pids.map(partitionKey));
      const moved = {};
      for (const pid of pids) {
        if (!existing[partitionKey(pid)]) moved[partitionKey(pid)] = readPartition(mono[pid]);
      }
      if (Object.keys(moved).length) await chrome.storage.local.set(moved);
    }
    await chrome.storage.local.remove('tabClassificationCache');
  } catch (err) {
    console.warn('[tab-out] Legacy cache migration failed:', err);
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

if (typeof chrome !== 'undefined') {
  chrome.runtime?.onMessage?.addListener(handleJevMessage);
  // Update badge when the extension is first installed
  chrome.runtime?.onInstalled?.addListener(() => {
    updateBadge();
    setupContextMenus();
    migrateLegacyClassificationCache();
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

  // Update badge whenever a tab is opened or closed
  chrome.tabs?.onCreated?.addListener(() => {
    debouncedUpdateBadge();
  });
  chrome.tabs?.onRemoved?.addListener(() => {
    debouncedUpdateBadge();
  });

  // Update badge when a tab's URL changes
  chrome.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
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
    handleJevMessage,
    saveClassificationCacheAtomic,
    migrateLegacyClassificationCache,
    isDangerousKey,
    setupContextMenus,
    handleContextMenuClick,
    isRealTabUrl,
    perspectiveLabelsSignature,
    _resetJevWorkerForTesting
  };
}
