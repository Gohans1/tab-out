import { expect, test, describe, beforeEach, afterEach } from "bun:test";

const {
  handleAiReservationMessage,
  setupContextMenus,
  handleContextMenuClick,
  _resetAiReservationsForTesting,
  hydrateAiReservationsFromSession,
  aiReservations,
  deferredPreclassifyTabs,
  pendingPreclassifyTabs
} = require("../extension/background.js");

describe("Background Service Worker IPC & AI Reservation Subsystem", () => {
  let originalChrome: any;
  let sessionState: Record<string, any> = {};

  beforeEach(() => {
    originalChrome = (globalThis as any).chrome;
    sessionState = {};

    // 100% Test Isolation: reset all module-level reservation & deferred maps
    _resetAiReservationsForTesting();

    (globalThis as any).chrome = {
      runtime: {
        id: "test-extension-id",
        getURL: (path: string) => `chrome-extension://test-extension-id/${path || ""}`
      },
      storage: {
        session: {
          get: async (keys: any) => {
            if (Array.isArray(keys)) {
              const res: Record<string, any> = {};
              for (const k of keys) res[k] = sessionState[k];
              return res;
            }
            if (typeof keys === "string") {
              return { [keys]: sessionState[keys] };
            }
            return sessionState;
          },
          set: async (obj: any) => {
            Object.assign(sessionState, obj);
          }
        }
      },
      contextMenus: {
        removeAll: (cb: () => void) => cb(),
        create: (opts: any, cb?: () => void) => {
          if (cb) cb();
        }
      },
      tabs: {
        create: async (opts: any) => opts
      }
    };
  });

  afterEach(() => {
    _resetAiReservationsForTesting();
    (globalThis as any).chrome = originalChrome;
  });

  function sendIpc(msg: any, customSender?: any): Promise<{ handled: boolean; response: any }> {
    return new Promise((resolve) => {
      const sender = customSender || {
        id: "test-extension-id",
        url: "chrome-extension://test-extension-id/index.html"
      };
      let handledResult: boolean | undefined;
      let responseVal: any;
      let isResolved = false;

      const safeResolve = () => {
        if (!isResolved && handledResult !== undefined) {
          isResolved = true;
          resolve({ handled: handledResult, response: responseVal });
        }
      };

      handledResult = handleAiReservationMessage(msg, sender, (val: any) => {
        responseVal = val;
        safeResolve();
      });

      if (!handledResult) {
        safeResolve();
      }
    });
  }

  describe("handleAiReservationMessage — Atomic Claiming & Conflict Resolution", () => {
    test("atomically claims available keys for owner and responds with claimed array", async () => {
      const keys = ["topic:https://github.com", "topic:https://bun.sh"];
      const { handled, response } = await sendIpc({
        type: "tabout-ai-claim",
        owner: "dashboard-owner-1",
        keys
      });

      expect(handled).toBe(true);
      expect(response).toBeDefined();
      expect(response.claimed).toEqual(keys);
    });

    test("contested keys cannot be claimed by a different owner until released", async () => {
      const contestedKey = "topic:https://contested-site.com";
      const freeKey = "topic:https://free-site.com";

      // 1. Owner A claims contestedKey
      const first = await sendIpc({
        type: "tabout-ai-claim",
        owner: "owner-A",
        keys: [contestedKey]
      });
      expect(first.response.claimed).toEqual([contestedKey]);

      // 2. Owner B tries to claim both contestedKey and freeKey
      const second = await sendIpc({
        type: "tabout-ai-claim",
        owner: "owner-B",
        keys: [contestedKey, freeKey]
      });
      // Owner B only succeeds for freeKey; contestedKey is denied
      expect(second.response.claimed).toEqual([freeKey]);
    });

    test("same owner can re-claim and refresh expiration timestamp of their own keys", async () => {
      const origNow = Date.now;
      let currentTime = 1000000;
      Date.now = () => currentTime;

      try {
        const key = "topic:https://refresh-me.org";

        const first = await sendIpc({
          type: "tabout-ai-claim",
          owner: "owner-refresh",
          keys: [key]
        });
        expect(first.response.claimed).toEqual([key]);
        const firstUntil = aiReservations.get(key)?.until;
        expect(firstUntil).toBe(currentTime + 30000);

        currentTime += 10000; // 10 seconds pass

        const second = await sendIpc({
          type: "tabout-ai-claim",
          owner: "owner-refresh",
          keys: [key]
        });
        expect(second.response.claimed).toEqual([key]);
        const secondUntil = aiReservations.get(key)?.until;
        expect(secondUntil).toBe(currentTime + 30000);
        expect(secondUntil).toBeGreaterThan(firstUntil!);
      } finally {
        Date.now = origNow;
      }
    });

    test("releasing keys frees them up for acquisition by subsequent owners", async () => {
      const key = "topic:https://handover-site.com";

      // 1. Owner A claims
      await sendIpc({
        type: "tabout-ai-claim",
        owner: "owner-Alpha",
        keys: [key]
      });

      // 2. Owner A releases
      const rel = await sendIpc({
        type: "tabout-ai-release",
        owner: "owner-Alpha",
        keys: [key]
      });
      expect(rel.handled).toBe(true);

      // 3. Owner B claims now-available key
      const claimB = await sendIpc({
        type: "tabout-ai-claim",
        owner: "owner-Beta",
        keys: [key]
      });
      expect(claimB.response.claimed).toEqual([key]);
    });

    test("unauthorized non-owner cannot release keys held by another owner", async () => {
      const key = "topic:https://protected-vault.com";

      // Owner Genuine claims
      await sendIpc({
        type: "tabout-ai-claim",
        owner: "owner-genuine",
        keys: [key]
      });

      // Rogue owner attempts to release
      await sendIpc({
        type: "tabout-ai-release",
        owner: "rogue-intruder",
        keys: [key]
      });

      // Genuine owner's claim must still stand; third party cannot claim
      const third = await sendIpc({
        type: "tabout-ai-claim",
        owner: "third-party",
        keys: [key]
      });
      expect(third.response.claimed).toEqual([]);
    });
  });

  describe("Expiration TTL (30s) & LRU Eviction Cap (200 -> 100)", () => {
    test("automatically expires and evicts reservations older than 30 seconds", async () => {
      const origNow = Date.now;
      let currentTime = 1000000;
      Date.now = () => currentTime;

      try {
        const key = "topic:https://ttl-test.org";

        // Owner A claims key at T=1,000,000
        const claimA = await sendIpc({
          type: "tabout-ai-claim",
          owner: "owner-A",
          keys: [key]
        });
        expect(claimA.response.claimed).toEqual([key]);

        // At T=1,029,000 (29 seconds later), Owner B cannot claim yet
        currentTime += 29000;
        const earlyB = await sendIpc({
          type: "tabout-ai-claim",
          owner: "owner-B",
          keys: [key]
        });
        expect(earlyB.response.claimed).toEqual([]);

        // At T=1,031,000 (31 seconds later, > 30s TTL), Owner A's reservation is expired
        currentTime += 2000;
        const lateB = await sendIpc({
          type: "tabout-ai-claim",
          owner: "owner-B",
          keys: [key]
        });
        // Expired claim is evicted and Owner B successfully acquires the key!
        expect(lateB.response.claimed).toEqual([key]);
      } finally {
        Date.now = origNow;
      }
    });

    test("enforces LRU memory bound by pruning down to 100 items when exceeding 200 keys", async () => {
      // Populate 205 keys
      const keysBatch1 = Array.from({ length: 150 }, (_, i) => `topic:https://bulk-${i}.com`);
      const keysBatch2 = Array.from({ length: 55 }, (_, i) => `topic:https://bulk-${150 + i}.com`);

      await sendIpc({
        type: "tabout-ai-claim",
        owner: "batch-owner",
        keys: keysBatch1
      });

      await sendIpc({
        type: "tabout-ai-claim",
        owner: "batch-owner",
        keys: keysBatch2
      });

      // Because total reservations exceeded 200 (150 + 55 = 205),
      // updateAiReservations prunes oldest entries down to <= 100
      expect(aiReservations.size).toBeLessThanOrEqual(100);
      expect(aiReservations.size).toBeGreaterThan(0);

      // Verify FIFO/LRU eviction: oldest key (bulk-0) must be evicted, newest key (bulk-204) retained
      expect(aiReservations.has("topic:https://bulk-0.com")).toBe(false);
      expect(aiReservations.has("topic:https://bulk-204.com")).toBe(true);
    });
  });

  describe("Service Worker Suspension & Hydration Flow", () => {
    test("hydrates unexpired reservations from session storage and rejects expired or dangerous keys", async () => {
      const origNow = Date.now;
      const now = 2000000;
      Date.now = () => now;

      try {
        sessionState.aiReservations = {
          "topic:https://valid-unexpired.com": {
            owner: "persisted-owner",
            until: now + 25000,
            rawKey: "topic:https://valid-unexpired.com"
          },
          "topic:https://expired.com": {
            owner: "old-owner",
            until: now - 5000,
            rawKey: "topic:https://expired.com"
          },
          "__proto__": {
            owner: "hacker",
            until: now + 50000,
            rawKey: "__proto__"
          }
        };

        // Trigger hydration
        await hydrateAiReservationsFromSession();

        // 1. Unexpired reservation is hydrated into in-memory map
        expect(aiReservations.has("topic:https://valid-unexpired.com")).toBe(true);

        // 2. Expired reservation is NOT hydrated
        expect(aiReservations.has("topic:https://expired.com")).toBe(false);

        // 3. Dangerous prototype key is rejected
        expect(aiReservations.has("__proto__")).toBe(false);

        // 4. Another owner attempting to claim the unexpired key is denied
        const attempt = await sendIpc({
          type: "tabout-ai-claim",
          owner: "new-owner",
          keys: ["topic:https://valid-unexpired.com"]
        });
        expect(attempt.response.claimed).toEqual([]);
      } finally {
        Date.now = origNow;
      }
    });

    test("handleAiReservationMessage awaits in-flight hydrationPromise before answering", async () => {
      let resolveSessionGet: (val: any) => void;
      const delayedGetPromise = new Promise((res) => { resolveSessionGet = res; });

      (globalThis as any).chrome.storage.session.get = () => delayedGetPromise;

      // Start hydration with delayed promise
      const hydratePromise = hydrateAiReservationsFromSession();

      let ipcFinished = false;
      const sendPromise = sendIpc({
        type: "tabout-ai-claim",
        owner: "test-owner",
        keys: ["topic:https://hydrate-wait.com"]
      }).then((res) => {
        ipcFinished = true;
        return res;
      });

      // IPC response must NOT be delivered yet because hydration is pending
      await new Promise((r) => setTimeout(r, 10));
      expect(ipcFinished).toBe(false);

      // Now resolve session get
      resolveSessionGet!({
        aiReservations: {
          "topic:https://hydrate-wait.com": {
            owner: "prior-owner",
            until: Date.now() + 20000,
            rawKey: "topic:https://hydrate-wait.com"
          }
        }
      });

      await hydratePromise;
      const result = await sendPromise;

      expect(result.handled).toBe(true);
      // Because prior-owner was hydrated, test-owner cannot claim it
      expect(result.response.claimed).toEqual([]);
    });
  });

  describe("Deferred Preclassification Trigger on Key Release", () => {
    test("releasing a key unblocks matching deferred tabs and moves them to pendingPreclassifyTabs", async () => {
      const targetKey = "topic:https://deferred-worker-tab.com";

      // 1. Owner claims targetKey
      await sendIpc({
        type: "tabout-ai-claim",
        owner: "claimant-owner",
        keys: [targetKey]
      });

      // 2. Put tab into deferredPreclassifyTabs waiting for targetKey
      const deferredTab = { id: 777, url: "https://deferred-worker-tab.com", title: "Deferred Tab" };
      deferredPreclassifyTabs.set(777, {
        tab: deferredTab,
        keys: [targetKey]
      });

      expect(deferredPreclassifyTabs.has(777)).toBe(true);
      expect(pendingPreclassifyTabs.has(777)).toBe(false);

      // 3. Claimant releases targetKey
      await sendIpc({
        type: "tabout-ai-release",
        owner: "claimant-owner",
        keys: [targetKey]
      });

      // 4. Deferred tab must be unblocked from deferred and moved to pending!
      expect(deferredPreclassifyTabs.has(777)).toBe(false);
      expect(pendingPreclassifyTabs.has(777)).toBe(true);
      expect(pendingPreclassifyTabs.get(777)).toEqual(deferredTab);
    });

    test("deferred tabs waiting on an expired key are unblocked when natural TTL expiration evicts the key", async () => {
      const origNow = Date.now;
      let currentTime = 1000000;
      Date.now = () => currentTime;

      try {
        const targetKey = "topic:https://auto-expire-deferred.com";

        // 1. Owner claims targetKey at T=1,000,000
        await sendIpc({
          type: "tabout-ai-claim",
          owner: "first-owner",
          keys: [targetKey]
        });

        // 2. Tab is deferred waiting for targetKey
        const deferredTab = { id: 888, url: "https://auto-expire-deferred.com", title: "Auto Expire Tab" };
        deferredPreclassifyTabs.set(888, {
          tab: deferredTab,
          keys: [targetKey]
        });

        expect(deferredPreclassifyTabs.has(888)).toBe(true);

        // 3. Time passes past 30s TTL
        currentTime += 35000;

        // 4. Any subsequent IPC message triggers eviction of expired keys
        await sendIpc({
          type: "tabout-ai-claim",
          owner: "second-owner",
          keys: ["topic:https://unrelated.com"]
        });

        // 5. Expired targetKey was evicted and released, unblocking deferred tab 888!
        expect(deferredPreclassifyTabs.has(888)).toBe(false);
        expect(pendingPreclassifyTabs.has(888)).toBe(true);
        expect(pendingPreclassifyTabs.get(888)).toEqual(deferredTab);
      } finally {
        Date.now = origNow;
      }
    });
  });

  describe("Storage Error Resilience & Durability", () => {
    test("resolves IPC cleanly without throwing when chrome.storage.session.set fails", async () => {
      (globalThis as any).chrome.storage.session.set = async () => {
        throw new Error("QUOTA_BYTES_PER_ITEM exceeded");
      };

      const key = "topic:https://error-resilience.com";
      const { handled, response } = await sendIpc({
        type: "tabout-ai-claim",
        owner: "resilience-tester",
        keys: [key]
      });

      expect(handled).toBe(true);
      expect(response).toBeDefined();
      expect(response.claimed).toEqual([key]);
    });

    test("persists reservations to chrome.storage.session before answering IPC message", async () => {
      const testKey = "topic:https://durable-persist.com";

      await sendIpc({
        type: "tabout-ai-claim",
        owner: "durable-tester",
        keys: [testKey]
      });

      expect(sessionState.aiReservations).toBeDefined();
      expect(typeof sessionState.aiReservations).toBe("object");

      const entries = Object.entries(sessionState.aiReservations);
      const found = entries.some(([k, r]: [string, any]) => r?.owner === "durable-tester" && r?.rawKey === testKey);
      expect(found).toBe(true);
    });

    test("hashes extremely long URLs with identical prefixes and suffixes into distinct keys without collisions", async () => {
      // 180 characters of identical prefix + 180 characters of identical suffix
      const prefix = "https://example.com/api/v1/search?query=" + "x".repeat(140);
      const suffix = "&signature=" + "y".repeat(169);

      // Distinct middle payloads
      const longUrl1 = prefix + "_MIDDLE_ALPHA_123_" + suffix;
      const longUrl2 = prefix + "_MIDDLE_BETA_987_" + suffix;

      const claim1 = await sendIpc({
        type: "tabout-ai-claim",
        owner: "long-url-owner-1",
        keys: [longUrl1]
      });
      expect(claim1.response.claimed).toEqual([longUrl1]);

      const claim2 = await sendIpc({
        type: "tabout-ai-claim",
        owner: "long-url-owner-2",
        keys: [longUrl2]
      });
      // Both must succeed independently because FNV-1a middle hashing differentiates them
      expect(claim2.response.claimed).toEqual([longUrl2]);
    });
  });

  describe("Security Boundaries & Protocol Hardening", () => {
    test("rejects messages when sender.id does not match extension runtime id", async () => {
      const res = await sendIpc(
        { type: "tabout-ai-claim", owner: "attacker", keys: ["topic:https://evil.com"] },
        { id: "wrong-malicious-extension-id", url: "chrome-extension://wrong-malicious-extension-id/popup.html" }
      );
      expect(res.handled).toBe(false);
    });

    test("rejects messages when sender URL does not originate from internal extension origin", async () => {
      const res = await sendIpc(
        { type: "tabout-ai-claim", owner: "attacker", keys: ["topic:https://evil.com"] },
        { id: "test-extension-id", url: "https://malicious-web-page.com/exploit.html" }
      );
      expect(res.handled).toBe(false);
    });

    test("rejects messages with unknown or unsupported message types", async () => {
      const res = await sendIpc({
        type: "tabout-unknown-action",
        owner: "caller",
        keys: ["key"]
      });
      expect(res.handled).toBe(false);
    });

    test("rejects invalid or oversized owner strings and returns empty claimed array", async () => {
      // Empty string
      const emptyOwner = await sendIpc({ type: "tabout-ai-claim", owner: "", keys: ["k1"] });
      expect(emptyOwner.handled).toBe(false);
      expect(emptyOwner.response?.claimed).toEqual([]);

      // Whitespace only
      const wsOwner = await sendIpc({ type: "tabout-ai-claim", owner: "   ", keys: ["k1"] });
      expect(wsOwner.handled).toBe(false);
      expect(wsOwner.response?.claimed).toEqual([]);

      // Oversized owner (> 128 chars)
      const hugeOwner = await sendIpc({ type: "tabout-ai-claim", owner: "x".repeat(150), keys: ["k1"] });
      expect(hugeOwner.handled).toBe(false);
      expect(hugeOwner.response?.claimed).toEqual([]);
    });

    test("rejects non-array or oversized key batches (> 1000 keys) and returns empty claimed array", async () => {
      const nonArray = await sendIpc({ type: "tabout-ai-claim", owner: "valid-owner", keys: "not-an-array" });
      expect(nonArray.handled).toBe(false);
      expect(nonArray.response?.claimed).toEqual([]);

      const oversizedBatch = Array.from({ length: 1005 }, (_, i) => `key-${i}`);
      const hugeBatch = await sendIpc({ type: "tabout-ai-claim", owner: "valid-owner", keys: oversizedBatch });
      expect(hugeBatch.handled).toBe(false);
      expect(hugeBatch.response?.claimed).toEqual([]);
    });

    test("safely skips prototype pollution keys without polluting objects", async () => {
      const keysWithProto = ["__proto__", "constructor", "prototype", "toString", "topic:https://valid.com"];
      const res = await sendIpc({
        type: "tabout-ai-claim",
        owner: "proto-tester",
        keys: keysWithProto
      });

      expect(res.handled).toBe(true);
      expect(res.response.claimed).toEqual(["topic:https://valid.com"]);

      // Verify Object.prototype is unpolluted
      expect((Object.prototype as any).owner).toBeUndefined();
    });
  });

  describe("Context Menu Registration & Action Handler", () => {
    test("setupContextMenus registers context menu entry with title, contexts and id", () => {
      let createdMenu: any = null;
      (globalThis as any).chrome.contextMenus = {
        removeAll: (cb: () => void) => cb(),
        create: (opts: any, cb?: () => void) => {
          createdMenu = opts;
          if (cb) cb();
        }
      };

      expect(() => setupContextMenus()).not.toThrow();
      expect(createdMenu).toBeDefined();
      expect(createdMenu.id).toBe("tabout-open-new-tab");
      expect(createdMenu.title).toBe("New Tab");
      expect(createdMenu.contexts).toEqual(["all"]);
    });

    test("setupContextMenus safely no-ops without throwing when chrome.contextMenus API is unavailable", () => {
      delete (globalThis as any).chrome.contextMenus;
      expect(() => setupContextMenus()).not.toThrow();
    });

    test("handleContextMenuClick creates new tab on menu selection", async () => {
      let createdTabOpts: any = null;
      (globalThis as any).chrome.tabs = {
        create: async (opts: any) => { createdTabOpts = opts; }
      };

      handleContextMenuClick({ menuItemId: "tabout-open-new-tab" }, {});
      expect(createdTabOpts).toEqual({});
    });

    test("handleContextMenuClick ignores unknown menu item IDs", () => {
      let tabCreated = false;
      (globalThis as any).chrome.tabs = {
        create: async () => { tabCreated = true; }
      };

      handleContextMenuClick({ menuItemId: "unknown-menu-id" }, {});
      expect(tabCreated).toBe(false);
    });
  });
});
