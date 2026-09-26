import { expect, test, describe, beforeEach, afterEach } from "bun:test";

const bg = require("../extension/background.js");

const SENDER = { id: "ext", url: "chrome-extension://ext/index.html" };

// Fake chrome for the service worker: storage.local / storage.session backed by plain objects.
function installChrome(store: Record<string, any>, session: Record<string, any> = {}) {
  const pick = (src: Record<string, any>, keys: any) => {
    const out: Record<string, any> = {};
    for (const k of [].concat(keys)) if (k in src) out[k] = structuredClone(src[k]);
    return out;
  };
  (globalThis as any).chrome = {
    runtime: { id: "ext", getURL: (p = "") => `chrome-extension://ext/${p}` },
    storage: {
      local: {
        get: async (keys: any) => pick(store, keys),
        set: async (obj: any) => { Object.assign(store, structuredClone(obj)); },
        remove: async (keys: any) => { for (const k of [].concat(keys)) delete store[k]; }
      },
      session: {
        get: async (keys: any) => pick(session, keys),
        set: async (obj: any) => { Object.assign(session, structuredClone(obj)); }
      }
    }
  };
}

// Fake Jev endpoint: answers "Dev" for every question unless `respond` overrides the response.
function installFetch(respond?: (body: any, n: number) => Response | Promise<Response>) {
  const requests: any[] = [];
  (globalThis as any).fetch = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (respond) return respond(body, requests.length);
    const answers: Record<string, any> = {};
    for (const k of Object.keys(body.questions)) answers[k] = { choice: "Dev", confidence: 0.9 };
    return new Response(JSON.stringify({ answers }), { status: 200 });
  };
  return requests;
}

function job(pid: string, urls: string[], extra: Record<string, any> = {}) {
  return {
    type: "tabout-jev-classify",
    pid,
    apiKey: "sk-test",
    criteria: { Dev: "Dev", Other: "Other" },
    otherLabel: "Other",
    items: urls.map(u => ({ key: u, title: `Title ${u}`, url: u, domain: "site.com", fallbackLabel: "Other" })),
    ...extra
  };
}

function ask(message: any, sender: any = SENDER): Promise<any> {
  return new Promise(resolve => {
    if (!bg.handleJevMessage(message, sender, resolve)) resolve(undefined);
  });
}

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 1));
};

const pA = { id: "pA", name: "A", labels: [{ name: "Dev" }, { name: "Other" }] };
const pB = { id: "pB", name: "B", labels: [{ name: "Dev" }, { name: "Other" }] };

let saved: any;
beforeEach(() => {
  saved = { chrome: (globalThis as any).chrome, fetch: (globalThis as any).fetch, now: Date.now };
  bg._resetJevWorkerForTesting();
});
afterEach(() => {
  (globalThis as any).chrome = saved.chrome;
  (globalThis as any).fetch = saved.fetch;
  Date.now = saved.now;
  bg._resetJevWorkerForTesting();
});

describe("Jev worker — a dashboard closing mid-request loses nothing", () => {
  test("the answer is saved even when the dashboard that asked is already gone", async () => {
    const store: Record<string, any> = { perspectives: [pA] };
    installChrome(store);
    installFetch();

    bg.handleJevMessage(job("pA", ["https://a.com/1"]), SENDER, () => { /* the new-tab page navigated away */ });
    await flush();

    expect(store.tabClassificationCache_pA["https://a.com/1"].source).toBe("ai");
  });

  test("the dashboard gets the saved entries back when it is still open", async () => {
    installChrome({ perspectives: [pA] });
    installFetch();

    const res = await ask(job("pA", ["https://a.com/1"]));

    expect(res.entries["https://a.com/1"].label).toBe("Dev");
  });

  test("two dashboards asking for the same tab at once cause a single request", async () => {
    installChrome({ perspectives: [pA] });
    const requests = installFetch();

    await Promise.all([ask(job("pA", ["https://a.com/1"])), ask(job("pA", ["https://a.com/1"]))]);

    expect(requests.length).toBe(1);
  });

  test("a tab already answered by another dashboard is not asked again", async () => {
    installChrome({
      perspectives: [pA],
      tabClassificationCache_pA: { "https://a.com/1": { label: "Dev", source: "ai", confidence: 0.9, timestamp: 1 } }
    });
    const requests = installFetch();

    await ask(job("pA", ["https://a.com/1"]));

    expect(requests.length).toBe(0);
  });

  test("a tab cooling down after a failure is not re-sent, whoever asks", async () => {
    Date.now = () => 1_000_000;
    installChrome({
      perspectives: [pA],
      tabClassificationCache_pA: {
        "https://a.com/1": { label: "Other", source: "local", lastAiAttempt: 1_000_000 - 5_000, cooldownMs: 60_000, aiAttempts: 2 }
      }
    });
    const requests = installFetch();

    await ask(job("pA", ["https://a.com/1"]));

    expect(requests.length).toBe(0);
  });
});

describe("Jev worker — one breaker for every tab and dashboard", () => {
  test("a 429 holds back requests for tabs never tried until Retry-After has passed", async () => {
    let now = 1_000_000;
    Date.now = () => now;
    installChrome({ perspectives: [pA] });
    const requests = installFetch((_b, n) => n === 1
      ? new Response("{}", { status: 429, headers: { "retry-after": "60" } })
      : new Response(JSON.stringify({ answers: { tab_0: { choice: "Dev", confidence: 0.9 } } }), { status: 200 }));

    await ask(job("pA", ["https://a.com/1"]));
    await ask(job("pA", ["https://b.com/1"]));
    const blockedCount = requests.length;
    now += 61_000;
    await ask(job("pA", ["https://b.com/1"]));

    expect(blockedCount).toBe(1);
    expect(requests.length).toBe(2);
  });

  test("the dashboard is told how long Jev stays blocked", async () => {
    Date.now = () => 1_000_000;
    installChrome({ perspectives: [pA] });
    installFetch(() => new Response("{}", { status: 429, headers: { "retry-after": "60" } }));

    const res = await ask(job("pA", ["https://a.com/1"]));

    expect(res.blockedUntil).toBe(1_000_000 + 60_000);
  });

  test("the block survives the service worker being restarted", async () => {
    Date.now = () => 1_000_000;
    installChrome({ perspectives: [pA] }, { jevBlockedUntil: 1_000_000 + 30_000 });
    const requests = installFetch();

    await ask(job("pA", ["https://a.com/1"]));

    expect(requests.length).toBe(0);
  });

  test("a 401 blocks AI for that key and stops the remaining batches", async () => {
    const store: Record<string, any> = { perspectives: [pA], openRouterApiKey: "sk-test" };
    installChrome(store);
    const requests = installFetch(() => new Response("{}", { status: 401 }));
    const urls = Array.from({ length: 30 }, (_, i) => `https://site${i}.com/p`);

    await ask(job("pA", urls));

    expect(requests.length).toBe(1);
    expect(store.aiAuthBlocked).toBe(true);
    expect(store.lastBlockedApiKey).toBe("sk-test");
  });
});

describe("Jev worker — a new API key starts from a clean slate", () => {
  test("clears stored retry cooldowns and the breaker, but keeps AI answers", async () => {
    Date.now = () => 1_000_000;
    const store: Record<string, any> = {
      perspectives: [pA],
      tabClassificationCache_pA: {
        "https://failed.com/": { label: "Other", source: "local", lastAiAttempt: 999_000, cooldownMs: 600_000, aiAttempts: 5 },
        "https://done.com/": { label: "Dev", source: "ai", confidence: 0.9, timestamp: 1 }
      }
    };
    installChrome(store, { jevBlockedUntil: 2_000_000 });
    const requests = installFetch();

    await ask({ type: "tabout-jev-reset" });
    await ask(job("pA", ["https://failed.com/"]));

    expect(requests.length).toBe(1);
    expect(store.tabClassificationCache_pA["https://done.com/"].source).toBe("ai");
  });
});

describe("Jev worker — never stores answers the user no longer wants", () => {
  test("answers asked with tags the user has since edited are thrown away", async () => {
    const store: Record<string, any> = { perspectives: [pA] };
    installChrome(store);
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    installFetch(async () => {
      await gate;
      return new Response(JSON.stringify({ answers: { tab_0: { choice: "Dev", confidence: 0.9 } } }), { status: 200 });
    });

    const pending = ask(job("pA", ["https://a.com/1"]));
    await flush();
    store.perspectives = [{ ...pA, labels: [{ name: "Reading" }, { name: "Other" }] }];
    release();
    await pending;

    expect(store.tabClassificationCache_pA?.["https://a.com/1"]).toBeUndefined();
  });

  test("answers for a perspective deleted mid-request are thrown away", async () => {
    const store: Record<string, any> = { perspectives: [pA] };
    installChrome(store);
    installFetch(() => {
      store.perspectives = [pB];
      return new Response(JSON.stringify({ answers: { tab_0: { choice: "Dev", confidence: 0.9 } } }), { status: 200 });
    });

    await ask(job("pA", ["https://a.com/1"]));

    expect(store.tabClassificationCache_pA).toBeUndefined();
  });

  test("a job queued for a perspective that is no longer on screen sends nothing", async () => {
    const store: Record<string, any> = { perspectives: [pA, pB], activePerspectiveId: "pA" };
    installChrome(store);
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const requests = installFetch(async body => {
      await gate;
      const answers: Record<string, any> = {};
      for (const k of Object.keys(body.questions)) answers[k] = { choice: "Dev", confidence: 0.9 };
      return new Response(JSON.stringify({ answers }), { status: 200 });
    });

    const inFlight = ask(job("pA", ["https://a.com/1"]));
    await flush();
    const queued = ask(job("pB", ["https://b.com/1"]));
    release();
    await Promise.all([inFlight, queued]);

    expect(requests.length).toBe(1);
    expect(store.tabClassificationCache_pB).toBeUndefined();
  });

  test("tabs the user closed while an earlier batch was answered are not sent", async () => {
    const store: Record<string, any> = { perspectives: [pA] };
    installChrome(store);
    let openTabs = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, url: `https://site${i}.com/p` }));
    (globalThis as any).chrome.tabs = { query: async () => structuredClone(openTabs) };
    const requests = installFetch(body => {
      openTabs = openTabs.slice(0, 24); // the user closes the group holding the last six tabs
      const answers: Record<string, any> = {};
      for (const k of Object.keys(body.questions)) answers[k] = { choice: "Dev", confidence: 0.9 };
      return new Response(JSON.stringify({ answers }), { status: 200 });
    });
    const items = openTabs.map(t => ({ key: t.url, tabId: t.id, tabUrl: t.url, title: "t", url: t.url, domain: "site.com", fallbackLabel: "Other" }));

    await ask({ ...job("pA", []), items });

    expect(requests.length).toBe(1);
  });

  test("a tab that navigated elsewhere before its job ran is not sent for its old page", async () => {
    installChrome({ perspectives: [pA] });
    (globalThis as any).chrome.tabs = { query: async () => [{ id: 1, url: "https://a.com/next" }] };
    const requests = installFetch();
    const items = [{ key: "https://a.com/old", tabId: 1, tabUrl: "https://a.com/old", title: "t", url: "https://a.com/old", domain: "a.com", fallbackLabel: "Other" }];

    await ask({ ...job("pA", []), items });

    expect(requests.length).toBe(0);
  });

  test("remaining batches stop once the user switches to another perspective", async () => {
    const store: Record<string, any> = { perspectives: [pA, pB], activePerspectiveId: "pA" };
    installChrome(store);
    const requests = installFetch(body => {
      store.activePerspectiveId = "pB";
      const answers: Record<string, any> = {};
      for (const k of Object.keys(body.questions)) answers[k] = { choice: "Dev", confidence: 0.9 };
      return new Response(JSON.stringify({ answers }), { status: 200 });
    });
    const urls = Array.from({ length: 30 }, (_, i) => `https://site${i}.com/p`);

    await ask(job("pA", urls));

    expect(requests.length).toBe(1);
    expect(store.tabClassificationCache_pA["https://site0.com/p"].source).toBe("ai");
  });
});

describe("Jev worker — request size", () => {
  test("a perspective with many long tag descriptions is split so each request fits Jev's 32k-token context", async () => {
    const labels = Array.from({ length: 15 }, (_, i) => ({ name: `Tag ${i}`, description: "x".repeat(300) }));
    const criteria: Record<string, string> = {};
    for (const l of labels) criteria[l.name] = l.description;
    installChrome({ perspectives: [{ id: "pBig", name: "Big", labels }] });
    const requests = installFetch();
    const urls = Array.from({ length: 24 }, (_, i) => `https://site${i}.com/p`);

    await ask(job("pBig", urls, { criteria }));

    // Two characters per token is a pessimistic bound for mixed Vietnamese / English text.
    for (const body of requests) expect(JSON.stringify(body).length).toBeLessThanOrEqual(64_000);
    expect(requests.reduce((n, b) => n + Object.keys(b.questions).length, 0)).toBe(24);
  });
});

describe("Jev worker — cache bounds", () => {
  test("an open tab's old answer survives pruning so it is not paid for twice", async () => {
    const partition: Record<string, any> = { "https://open.com/": { label: "Dev", source: "ai", confidence: 0.9, timestamp: 1 } };
    for (let i = 0; i < 1000; i++) partition[`https://old${i}.com/`] = { label: "Dev", source: "ai", confidence: 0.9, timestamp: 1000 + i };
    const store: Record<string, any> = { perspectives: [pA], tabClassificationCache_pA: partition };
    installChrome(store);
    installFetch();

    await ask(job("pA", ["https://new.com/"], { keepKeys: ["https://open.com/"] }));

    expect(store.tabClassificationCache_pA["https://open.com/"]).toBeDefined();
    expect(Object.keys(store.tabClassificationCache_pA).length).toBe(1000);
  });

  test("the legacy single-key cache is split into partitions once and then removed", async () => {
    const store: Record<string, any> = {
      tabClassificationCache: {
        pA: { "https://a.com/": { label: "Dev", source: "ai" } },
        pB: { "https://b.com/": { label: "Old", source: "ai" } }
      },
      tabClassificationCache_pB: { "https://b.com/": { label: "New", source: "ai" } }
    };
    installChrome(store);

    await bg.migrateLegacyClassificationCache();

    expect(store.tabClassificationCache).toBeUndefined();
    expect(store.tabClassificationCache_pA["https://a.com/"].label).toBe("Dev");
    expect(store.tabClassificationCache_pB["https://b.com/"].label).toBe("New");
  });
});

describe("Jev worker — message boundary", () => {
  test("ignores senders from another extension", async () => {
    installChrome({ perspectives: [pA] });
    const requests = installFetch();

    const handled = bg.handleJevMessage(job("pA", ["https://a.com/1"]), { id: "evil", url: "chrome-extension://evil/x.html" }, () => {});
    await flush();

    expect(handled).toBe(false);
    expect(requests.length).toBe(0);
  });

  test("ignores senders that are not extension pages", async () => {
    installChrome({ perspectives: [pA] });
    const requests = installFetch();

    const handled = bg.handleJevMessage(job("pA", ["https://a.com/1"]), { id: "ext", url: "https://evil.com/" }, () => {});
    await flush();

    expect(handled).toBe(false);
    expect(requests.length).toBe(0);
  });

  test("ignores unrelated message types", () => {
    installChrome({ perspectives: [pA] });

    expect(bg.handleJevMessage({ type: "tabout-unknown" }, SENDER, () => {})).toBe(false);
  });

  test("rejects a job without an item list or with more than 1000 items", async () => {
    installChrome({ perspectives: [pA] });
    const requests = installFetch();
    const tooMany = job("pA", Array.from({ length: 1001 }, (_, i) => `https://s${i}.com/`));

    const notArray = await ask({ ...job("pA", []), items: "https://a.com/1" });
    const oversized = await ask(tooMany);

    expect(notArray.entries).toEqual({});
    expect(oversized.entries).toEqual({});
    expect(requests.length).toBe(0);
  });

  test("rejects prototype-polluting perspective ids and cache keys", async () => {
    installChrome({ perspectives: [pA] });
    const requests = installFetch();

    const res = await ask(job("__proto__", ["https://a.com/1"]));
    await ask(job("pA", ["constructor"]));

    expect(res.entries).toEqual({});
    expect(requests.length).toBe(0);
  });
});
