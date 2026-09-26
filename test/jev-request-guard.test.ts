import { expect, test, describe, beforeEach, afterEach } from "bun:test";

const app = require("../extension/app.js");
const worker = require("../extension/background.js");

// Fake chrome.storage.local backed by a plain object; runtime messages reach the real service worker.
function installChrome(store: Record<string, any>, extra: Record<string, any> = {}) {
  const reads: string[][] = [];
  const sender = { id: "ext", url: "chrome-extension://ext/index.html" };
  (globalThis as any).chrome = {
    runtime: {
      id: "ext",
      getURL: (p = "") => `chrome-extension://ext/${p}`,
      sendMessage: (m: any) => new Promise(resolve => {
        if (!worker.handleJevMessage(m, sender, resolve)) resolve(undefined);
      })
    },
    storage: {
      local: {
        get: async (keys: any) => {
          const list = [].concat(keys);
          reads.push(list);
          const out: Record<string, any> = {};
          for (const k of list) if (k in store) out[k] = structuredClone(store[k]);
          return out;
        },
        set: async (obj: any) => { Object.assign(store, structuredClone(obj)); },
        remove: async () => {}
      }
    },
    ...extra
  };
  return reads;
}

// Fake Jev endpoint: records every request body and answers "Dev" or fails with `status`.
function installFetch(status = 200) {
  const requests: any[] = [];
  (globalThis as any).fetch = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (status !== 200) {
      return new Response("{}", { status });
    }
    const answers: Record<string, any> = {};
    for (const k of Object.keys(body.questions)) answers[k] = { choice: "Dev", confidence: 0.9 };
    return new Response(JSON.stringify({ answers }), { status: 200 });
  };
  return requests;
}

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 1));
};

const pA = { id: "pA", name: "A", labels: [{ name: "Dev" }, { name: "Other" }] };
const pB = { id: "pB", name: "B", labels: [{ name: "Dev" }, { name: "Other" }] };

let saved: any;
beforeEach(() => {
  saved = {
    chrome: (globalThis as any).chrome,
    fetch: (globalThis as any).fetch,
    document: (globalThis as any).document,
    now: Date.now
  };
  app.currentPerspectives = [{ id: "domain", name: "Domain", isSystem: true }, pA, pB];
  app.isPerspectivesLoaded = true;
  app.openRouterApiKey = "sk-test";
  app.aiAuthBlocked = false;
  app.activePerspectiveId = "pA";
  app.tabClassificationCache = {};
  app.isLocalSettingUpdate = false;
  app.jevBlockedUntil = 0;
  worker._resetJevWorkerForTesting();
});
afterEach(() => {
  (globalThis as any).chrome = saved.chrome;
  (globalThis as any).fetch = saved.fetch;
  if (saved.document === undefined) delete (globalThis as any).document;
  else (globalThis as any).document = saved.document;
  Date.now = saved.now;
  app.activePerspectiveId = "domain";
  app.currentPerspectives = app.cloneDefaultPerspectives();
  app.tabClassificationCache = {};
  app.openRouterApiKey = "";
  app.isLocalSettingUpdate = false;
  app.resetRenderCache();
});

describe("classifyTabs — never classifies half-loaded tabs", () => {
  test("a tab still loading (stale title from the previous page) is not sent to Jev", async () => {
    installChrome({ perspectives: [pA, pB] });
    const requests = installFetch();

    await app.classifyTabs(
      [{ id: 1, url: "https://example.com/new-article", title: "Previous Page Title", status: "loading" }],
      pA,
      { silent: true }
    );

    expect(requests.length).toBe(0);
    expect(app.tabClassificationCache.pA?.["https://example.com/new-article"]?.source).not.toBe("ai");
  });

  test("a tab finishing its load counts as a tab change so the dashboard re-syncs and classifies it", () => {
    const loading = [{ id: 1, url: "https://example.com/a", title: "A", active: false, windowId: 1, status: "loading" }];
    const complete = [{ ...loading[0], status: "complete" }];

    expect(app.areTabsEqual(loading, complete)).toBe(false);
  });

  test("the same tab is classified once it finished loading", async () => {
    installChrome({ perspectives: [pA, pB] });
    const requests = installFetch();

    await app.classifyTabs(
      [{ id: 1, url: "https://example.com/new-article", title: "New Article", status: "complete" }],
      pA,
      { silent: true }
    );

    expect(requests.length).toBe(1);
    expect(requests[0].state.tabs.tab_0.title).toBe("New Article");
  });
});

describe("classifyTabs — the service worker owns every Jev request", () => {
  test("a dashboard hands its tabs to the service worker instead of calling Jev itself", async () => {
    installChrome({ perspectives: [pA, pB] });
    const messages: any[] = [];
    (globalThis as any).chrome.runtime.sendMessage = async (m: any) => {
      messages.push(m);
      return { entries: { "https://a.com/1": { label: "Dev", source: "ai", confidence: 0.9, timestamp: 1 } }, blockedUntil: 0 };
    };
    let fetchCalls = 0;
    (globalThis as any).fetch = async () => { fetchCalls++; return new Response("{}"); };

    await app.classifyTabs([{ id: 1, url: "https://a.com/1", title: "A", status: "complete" }], pA, { silent: true });

    expect(fetchCalls).toBe(0);
    expect(messages[0].items.map((i: any) => i.key)).toEqual(["https://a.com/1"]);
    expect(app.tabClassificationCache.pA["https://a.com/1"].source).toBe("ai");
  });

  test("while the worker reports Jev as blocked the dashboard does not even message it", async () => {
    Date.now = () => 1_000_000;
    installChrome({ perspectives: [pA, pB] });
    const messages: any[] = [];
    (globalThis as any).chrome.runtime.sendMessage = async (m: any) => {
      messages.push(m);
      return { entries: {}, blockedUntil: 1_000_000 + 60_000 };
    };

    await app.classifyTabs([{ id: 1, url: "https://a.com/1", title: "A", status: "complete" }], pA, { silent: true });
    await app.classifyTabs([{ id: 2, url: "https://b.com/1", title: "B", status: "complete" }], pA, { silent: true });

    expect(messages.length).toBe(1);
  });
});

describe("classifyTabs — exponential backoff on repeated failures", () => {
  test("a tab failing with 5xx is not retried 16s later once it has already failed twice", async () => {
    installChrome({ perspectives: [pA, pB] });
    const requests = installFetch(503);
    let now = 1_000_000;
    Date.now = () => now;
    const tab = { id: 4, url: "https://c.com/x", title: "c", status: "complete" };

    await app.classifyTabs([tab], pA, { silent: true }); // attempt 1 -> 15s
    now += 16_000;
    await app.classifyTabs([tab], pA, { silent: true }); // attempt 2 -> 30s
    now += 16_000;
    await app.classifyTabs([tab], pA, { silent: true }); // still cooling down

    expect(requests.length).toBe(2);
  });

  test("backoff is capped at one hour", async () => {
    const failedThirtyTimes = { label: "Other", source: "local", aiAttempts: 30, lastAiAttempt: 0, cooldownMs: 1 };
    installChrome({ perspectives: [pA, pB], tabClassificationCache_pA: { "https://c.com/x": failedThirtyTimes } });
    installFetch(503);
    app.tabClassificationCache = { pA: { "https://c.com/x": { ...failedThirtyTimes } } };

    await app.classifyTabs([{ id: 4, url: "https://c.com/x", title: "c", status: "complete" }], pA, { silent: true });

    expect(app.tabClassificationCache.pA["https://c.com/x"].cooldownMs).toBe(60 * 60 * 1000);
  });
});

describe("classifyTabs — stops hammering an unhealthy endpoint", () => {
  const thirtyTabs = () => Array.from({ length: 30 }, (_, i) => ({
    id: i + 1, url: `https://site${i}.com/page`, title: `Site ${i}`, status: "complete"
  }));

  test("a 429 on the first batch cancels the remaining batches", async () => {
    installChrome({ perspectives: [pA, pB] });
    const requests = installFetch(429);

    await app.classifyTabs(thirtyTabs(), pA, { silent: true });

    expect(requests.length).toBe(1);
  });

  test("a 5xx on the first batch cancels the remaining batches", async () => {
    installChrome({ perspectives: [pA, pB] });
    const requests = installFetch(502);

    await app.classifyTabs(thirtyTabs(), pA, { silent: true });

    expect(requests.length).toBe(1);
  });

  test("a batch-specific 400 still lets the other batches through", async () => {
    installChrome({ perspectives: [pA, pB] });
    const requests = installFetch(400);

    await app.classifyTabs(thirtyTabs(), pA, { silent: true });

    expect(requests.length).toBe(2);
  });
});

describe("triggerBackgroundClassification — strictly on-demand", () => {
  test("a queued run for a perspective the user already left is dropped", async () => {
    installChrome({ perspectives: [pA, pB] });
    const requests = installFetch();

    app.triggerBackgroundClassification([{ id: 2, url: "https://a.com/1", title: "a1", status: "complete" }], pA);
    app.triggerBackgroundClassification([{ id: 3, url: "https://b.com/1", title: "b1", status: "complete" }], pB);
    await flush();

    expect(requests.length).toBe(1);
    expect(app.tabClassificationCache.pB?.["https://b.com/1"]).toBeUndefined();
  });
});

describe("triggerBackgroundClassification — a queued run never uses stale data", () => {
  // Fake Jev whose answers are held back until `release()` is called.
  function installGatedFetch() {
    const requests: any[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    (globalThis as any).fetch = async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      await gate;
      const answers: Record<string, any> = {};
      for (const k of Object.keys(body.questions)) answers[k] = { choice: "Other", confidence: 0.9 };
      return new Response(JSON.stringify({ answers }), { status: 200 });
    };
    return { requests, release: () => release() };
  }

  test("a run queued before the user edited the tags asks Jev with the edited tags", async () => {
    const store: Record<string, any> = { perspectives: [pA, pB] };
    installChrome(store);
    const { requests, release } = installGatedFetch();
    const edited = { ...pA, labels: [{ name: "Reading" }, { name: "Other" }] };

    app.triggerBackgroundClassification([{ id: 1, url: "https://a.com/1", title: "a", status: "complete" }], pA);
    await flush(3);
    app.triggerBackgroundClassification([{ id: 2, url: "https://b.com/1", title: "b", status: "complete" }], pA);
    store.perspectives = [edited, pB];
    app.currentPerspectives = [{ id: "domain", name: "Domain", isSystem: true }, edited, pB];
    release();
    await flush(40);

    expect(requests.length).toBe(2);
    expect(Object.keys(requests[1].questions.tab_0.criteria)).toContain("Reading");
  });

  test("tabs whose answers were dropped because the tags were edited mid-run are asked again with the new tags", async () => {
    const store: Record<string, any> = { perspectives: [pA, pB] };
    installChrome(store);
    const tab = { id: 1, url: "https://a.com/1", title: "a", windowId: 1, status: "complete" };
    (globalThis as any).chrome.tabs = { query: async () => [tab] };
    (globalThis as any).document = { hidden: false, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
    await app.renderStaticDashboard({ skipBackgroundAi: true });
    const { requests, release } = installGatedFetch();
    const edited = { ...pA, labels: [{ name: "Reading" }, { name: "Other" }] };

    app.triggerBackgroundClassification([tab], pA);
    await flush(3);
    store.perspectives = [edited, pB];
    app.currentPerspectives = [{ id: "domain", name: "Domain", isSystem: true }, edited, pB];
    release();
    await flush(40);

    expect(requests.length).toBe(2);
    expect(requests[1].state.tabs.tab_0.url).toBe("https://a.com/1");
    expect(Object.keys(requests[1].questions.tab_0.criteria)).toContain("Reading");
  });

  test("a queued tab that navigated meanwhile is asked for its new page", async () => {
    installChrome({ perspectives: [pA, pB] });
    const { requests, release } = installGatedFetch();

    app.triggerBackgroundClassification([{ id: 1, url: "https://a.com/1", title: "a", status: "complete" }], pA);
    await flush(3);
    app.triggerBackgroundClassification([{ id: 2, url: "https://b.com/old", title: "old", status: "complete" }], pA);
    app.triggerBackgroundClassification([{ id: 2, url: "https://b.com/new", title: "new", status: "complete" }], pA);
    release();
    await flush(40);

    expect(requests.length).toBe(2);
    expect(requests[1].state.tabs.tab_0.url).toBe("https://b.com/new");
  });
});

describe("classifyTabs — more unclassified tabs than one job may carry", () => {
  test("the first 1000 are still sent instead of the whole job being refused", async () => {
    installChrome({ perspectives: [pA, pB] });
    const requests = installFetch();
    const tabs = Array.from({ length: 1001 }, (_, i) => ({ id: i + 1, url: `https://s${i}.com/p`, title: `S${i}`, status: "complete" }));

    await app.classifyTabs(tabs, pA, { silent: true });

    expect(requests.reduce((n, b) => n + Object.keys(b.questions).length, 0)).toBe(1000);
  });
});

describe("renderStaticDashboard — classification resumes by itself once Jev is unblocked", () => {
  test("the dashboard asks again when the block expires, without any tab event", async () => {
    installChrome({ perspectives: [pA, pB] });
    const tab = { id: 1, url: "https://a.com/1", title: "A", windowId: 1, status: "complete" };
    (globalThis as any).chrome.tabs = { query: async () => [tab] };
    (globalThis as any).document = { hidden: false, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
    const messages: any[] = [];
    (globalThis as any).chrome.runtime.sendMessage = async (m: any) => {
      messages.push(m);
      return messages.length === 1
        ? { entries: {}, blockedUntil: Date.now() + 30 }
        : { entries: { "https://a.com/1": { label: "Dev", source: "ai", confidence: 0.9, timestamp: 1 } }, blockedUntil: 0 };
    };

    await app.renderStaticDashboard();
    await new Promise(r => setTimeout(r, 500));

    expect(messages.length).toBe(2);
  });
});

describe("savePerspectiveSettings — edited tags never resurrect wiped answers", () => {
  test("a Jev answer landing while the edited tags are saved is not stored under them", async () => {
    const store: Record<string, any> = { perspectives: [pA, pB], activePerspectiveId: "pA" };
    installChrome(store);
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    (globalThis as any).fetch = async () => {
      await gate;
      return new Response(JSON.stringify({ answers: { tab_0: { choice: "Dev", confidence: 0.9 } } }), { status: 200 });
    };
    // The answer lands exactly while the old partition is being wiped.
    (globalThis as any).chrome.storage.local.remove = async (keys: any) => {
      for (const k of [].concat(keys)) delete store[k];
      release();
      await flush();
    };
    const classifying = app.classifyTabs([{ id: 1, url: "https://a.com/1", title: "a", status: "complete" }], pA, { silent: true });
    await flush(3);
    const edited = { ...pA, labels: [{ name: "Reading" }, { name: "Other" }] };
    app.currentPerspectives = [{ id: "domain", name: "Domain", isSystem: true }, edited, pB];

    await app.savePerspectiveSettings("pA");
    await classifying;

    expect(store.tabClassificationCache_pA).toBeUndefined();
    expect(store.perspectives.find((p: any) => p.id === "pA").labels[0].name).toBe("Reading");
  });
});

describe("handleStorageOnChanged — wiped answers are replaced at once", () => {
  test("a visible dashboard re-asks Jev when another tab wipes the shown perspective's answers", async () => {
    installChrome({ perspectives: [pA, pB] });
    const tab = { id: 1, url: "https://a.com/1", title: "A", windowId: 1, status: "complete" };
    (globalThis as any).chrome.tabs = { query: async () => [tab] };
    (globalThis as any).document = { hidden: false, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
    const old = { "https://a.com/1": { label: "Dev", source: "ai", confidence: 0.9, timestamp: 1 } };
    app.tabClassificationCache = { pA: structuredClone(old) };
    await app.renderStaticDashboard({ skipBackgroundAi: true });
    const requests = installFetch();

    await app.handleStorageOnChanged({ tabClassificationCache_pA: { oldValue: old, newValue: undefined } }, "local");
    await flush();

    expect(requests.length).toBe(1);
  });
});

describe("handleStorageOnChanged — a rewrite of identical perspectives does no work", () => {
  test("a visible dashboard does not reload settings when the stored perspectives did not change", async () => {
    const reads = installChrome({ perspectives: [pA, pB] });
    (globalThis as any).document = { hidden: false, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };

    await app.handleStorageOnChanged({ perspectives: { oldValue: [pA, pB], newValue: structuredClone([pA, pB]) } }, "local");

    expect(reads.length).toBe(0);
  });
});

describe("switchPerspective — keeps answers already paid for", () => {
  test("an in-flight Jev request still lands in the cache after switching away", async () => {
    installChrome({ perspectives: [pA, pB] });
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    (globalThis as any).fetch = async (_u: string, init: any) => {
      await gate;
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response(JSON.stringify({ answers: { tab_0: { choice: "Dev", confidence: 0.9 } } }), { status: 200 });
    };
    (globalThis as any).document = {
      hidden: false,
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => []
    };

    app.triggerBackgroundClassification([{ id: 2, url: "https://a.com/1", title: "a1", status: "complete" }], pA);
    await flush(3);
    await app.switchPerspective("pB");
    release();
    await flush();

    expect(app.tabClassificationCache.pA?.["https://a.com/1"]?.source).toBe("ai");
  });
});

describe("switchPerspective — the new perspective is classified at once", () => {
  test("its tabs reach Jev even when saving the switch to storage is slow", async () => {
    const store: Record<string, any> = { perspectives: [pA, pB], activePerspectiveId: "pA" };
    installChrome(store);
    (globalThis as any).chrome.storage.local.set = (obj: any) =>
      new Promise<void>(r => setTimeout(() => { Object.assign(store, structuredClone(obj)); r(); }, 5));
    const tab = { id: 9, url: "https://b.com/1", title: "B", windowId: 1, status: "complete" };
    (globalThis as any).chrome.tabs = { query: async () => [tab] };
    (globalThis as any).document = { hidden: false, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
    const requests = installFetch();
    await app.renderStaticDashboard({ skipBackgroundAi: true });

    await app.switchPerspective("pB");
    await flush();

    expect(requests.length).toBe(1);
    expect(app.tabClassificationCache.pB["https://b.com/1"].source).toBe("ai");
  });
});

describe("classifyTabs — only tabs that are still open cost money", () => {
  test("a tab closed before the service worker got to it is not sent to Jev", async () => {
    installChrome({ perspectives: [pA, pB] });
    (globalThis as any).chrome.tabs = { query: async () => [] };
    const requests = installFetch();

    await app.classifyTabs([{ id: 5, url: "https://gone.com/x", title: "Gone", status: "complete" }], pA, { silent: true });

    expect(requests.length).toBe(0);
  });

  test("a URL too long to be a cache key is not handed to the worker on every render", async () => {
    installChrome({ perspectives: [pA, pB] });
    const messages: any[] = [];
    const toWorker = (globalThis as any).chrome.runtime.sendMessage;
    (globalThis as any).chrome.runtime.sendMessage = (m: any) => { messages.push(m); return toWorker(m); };
    const requests = installFetch();
    const tab = { id: 6, url: `https://long.com/${"segment/".repeat(300)}end`, title: "Long", status: "complete" };

    for (let i = 0; i < 3; i++) await app.classifyTabs([tab], pA, { silent: true });

    expect(messages.length).toBe(0);
    expect(requests.length).toBe(0);
  });
});

describe("mergeClassificationEntries — memory bounds never drop an open tab", () => {
  test("the oldest answer survives the in-memory cap when its tab is open", async () => {
    installChrome({ perspectives: [pA, pB] });
    (globalThis as any).chrome.tabs = { query: async () => [{ id: 1, url: "https://open.com/", title: "Open", windowId: 1, status: "complete" }] };
    (globalThis as any).document = { hidden: false, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
    await app.renderStaticDashboard({ skipBackgroundAi: true });
    const entries: Record<string, any> = { "https://open.com/": { label: "Dev", source: "ai", confidence: 0.9, timestamp: 1 } };
    for (let i = 0; i < 1000; i++) entries[`https://old${i}.com/`] = { label: "Dev", source: "ai", confidence: 0.9, timestamp: 1000 + i };
    app.tabClassificationCache = { pA: {} };

    app.mergeClassificationEntries("pA", entries);

    expect(app.tabClassificationCache.pA["https://open.com/"]).toBeDefined();
    expect(Object.keys(app.tabClassificationCache.pA).length).toBe(1000);
  });
});

describe("handleStorageOnChanged — hidden or self-originated changes do no work", () => {
  test("a hidden dashboard does not reload settings when another tab switches perspective", async () => {
    const reads = installChrome({ perspectives: [pA, pB], activePerspectiveId: "pB" });
    (globalThis as any).document = { hidden: true, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };

    await app.handleStorageOnChanged({ activePerspectiveId: { oldValue: "pA", newValue: "pB" } }, "local");

    expect(reads.length).toBe(0);
    expect(app.isPerspectivesLoaded).toBe(false);
  });

  test("a visible dashboard ignores the echo of its own perspective switch", async () => {
    const reads = installChrome({ perspectives: [pA, pB], activePerspectiveId: "pB" });
    (globalThis as any).document = { hidden: false, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
    app.activePerspectiveId = "pB";

    await app.handleStorageOnChanged({ activePerspectiveId: { oldValue: "pA", newValue: "pB" } }, "local");

    expect(reads.length).toBe(0);
  });

  // Renders one "News" tab under perspective A (still unclassified), then broadcasts an AI label for it.
  async function renderThenBroadcastLabel(hidden: boolean) {
    installChrome({ perspectives: [pA, pB] });
    const missions = { innerHTML: "", querySelectorAll: () => [] };
    const section = { style: {} as any };
    (globalThis as any).chrome.tabs = {
      query: async () => [{ id: 7, url: "https://news.com/a", title: "News", windowId: 1, status: "complete" }]
    };
    (globalThis as any).document = {
      hidden: false,
      getElementById: (id: string) => id === "openTabsMissions" ? missions : id === "openTabsSection" ? section : null,
      querySelector: () => null,
      querySelectorAll: () => []
    };
    await app.renderStaticDashboard({ skipBackgroundAi: true });
    const before = missions.innerHTML;

    (globalThis as any).document.hidden = hidden;
    await app.handleStorageOnChanged({
      tabClassificationCache_pA: {
        oldValue: {},
        newValue: { "https://news.com/a": { label: "Dev", source: "ai", confidence: 0.9, timestamp: 1 } }
      }
    }, "local");
    return { before, after: missions.innerHTML };
  }

  test("a visible dashboard re-renders when another tab lands an AI label", async () => {
    const { before, after } = await renderThenBroadcastLabel(false);

    expect(after).not.toBe(before);
  });

  test("a hidden dashboard merges new AI labels without re-rendering", async () => {
    const { before, after } = await renderThenBroadcastLabel(true);

    expect(app.tabClassificationCache.pA["https://news.com/a"].label).toBe("Dev");
    expect(after).toBe(before);
  });
});

describe("saveApiKeySettings — re-saving the same key is not a retry button", () => {
  test("saving the unchanged key keeps failure cooldowns", async () => {
    installChrome({ perspectives: [pA, pB] });
    app.openRouterApiKey = "sk-same";
    app.tabClassificationCache = {
      pA: { "https://c.com/x": { label: "Other", source: "local", aiAttempts: 3, lastAiAttempt: 123, cooldownMs: 60000 } }
    };

    await app.saveApiKeySettings("sk-same");

    expect(app.tabClassificationCache.pA["https://c.com/x"].lastAiAttempt).toBe(123);
  });

  test("saving a new key resets failure cooldowns and backoff", async () => {
    installChrome({ perspectives: [pA, pB] });
    app.openRouterApiKey = "sk-old";
    app.tabClassificationCache = {
      pA: { "https://c.com/x": { label: "Other", source: "local", aiAttempts: 3, lastAiAttempt: 123, cooldownMs: 60000 } }
    };

    await app.saveApiKeySettings("sk-new");

    const entry = app.tabClassificationCache.pA["https://c.com/x"];
    expect(entry.lastAiAttempt).toBeUndefined();
    expect(entry.aiAttempts).toBeUndefined();
  });
});

describe("saveApiKeySettings — a new key gets a real retry", () => {
  test("a tab cooling down from the old key's failures is asked again with the new key", async () => {
    const cooled = { label: "Other", source: "local", aiAttempts: 3, lastAiAttempt: Date.now(), cooldownMs: 600_000 };
    installChrome({ perspectives: [pA, pB], tabClassificationCache_pA: { "https://c.com/x": cooled } });
    const requests = installFetch();
    app.openRouterApiKey = "sk-old";
    app.tabClassificationCache = { pA: { "https://c.com/x": { ...cooled } } };

    await app.saveApiKeySettings("sk-new");
    await app.classifyTabs([{ id: 4, url: "https://c.com/x", title: "c", status: "complete" }], pA, { silent: true });

    expect(requests.length).toBe(1);
  });
});

describe("loadPerspectiveSettings — its own migration write does not hide the stored perspective", () => {
  test("adopts the stored active perspective even when it back-fills a missing templateId", async () => {
    const purpose = { id: "pP", name: "Purpose", labels: [{ name: "Work" }, { name: "Other" }] };
    installChrome({ perspectives: [pA, purpose], activePerspectiveId: "pP", openRouterApiKey: "sk-test" });
    app.activePerspectiveId = "pA";

    await app.loadPerspectiveSettings(true);

    expect(app.activePerspectiveId).toBe("pP");
  });
});

describe("classification cache partitions — load only what is on screen", () => {
  test("opening a dashboard loads only the active perspective's partition", async () => {
    const reads = installChrome({
      perspectives: [pA, pB],
      activePerspectiveId: "pA",
      openRouterApiKey: "sk-test",
      tabClassificationCache_pA: { "https://a.com/1": { label: "Dev", source: "ai" } },
      tabClassificationCache_pB: { "https://b.com/1": { label: "Dev", source: "ai" } }
    });

    await app.loadPerspectiveSettings(true);

    expect(app.tabClassificationCache.pA["https://a.com/1"].label).toBe("Dev");
    expect(Object.prototype.hasOwnProperty.call(app.tabClassificationCache, "pB")).toBe(false);
    expect(reads.flat()).not.toContain("tabClassificationCache_pB");
  });

  test("switching to another perspective loads its partition before grouping", async () => {
    installChrome({
      perspectives: [pA, pB],
      activePerspectiveId: "pA",
      openRouterApiKey: "sk-test",
      tabClassificationCache_pA: {},
      tabClassificationCache_pB: { "https://b.com/1": { label: "Dev", source: "ai" } }
    });
    (globalThis as any).document = { hidden: false, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
    await app.loadPerspectiveSettings(true);

    await app.switchPerspective("pB");

    expect(app.tabClassificationCache.pB["https://b.com/1"].source).toBe("ai");
  });
});

describe("debouncedSync — a burst of tab events cannot starve the dashboard", () => {
  test("a tab retitling every 100ms still lets the dashboard sync within about a second", async () => {
    installChrome({ perspectives: [pA, pB] });
    let queries = 0;
    (globalThis as any).chrome.tabs = { query: async () => { queries++; return []; } };
    (globalThis as any).document = { hidden: false, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
    app.renderCache.set("missions", "rendered");

    for (let i = 0; i < 12; i++) {
      app.debouncedSync(250, false);
      await new Promise(r => setTimeout(r, 100));
    }
    const queriesDuringBurst = queries;
    await new Promise(r => setTimeout(r, 300));

    expect(queriesDuringBurst).toBeGreaterThan(0);
  });
});
