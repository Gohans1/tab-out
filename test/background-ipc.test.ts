import { expect, test, describe, beforeEach, afterEach } from "bun:test";

const {
  handleAiReservationMessage,
  setupContextMenus,
  handleContextMenuClick
} = require("../extension/background.js");

describe("Background Service Worker IPC & AI Reservation Subsystem", () => {
  let originalChrome: any;
  let sessionState: Record<string, any> = {};

  beforeEach(() => {
    originalChrome = (globalThis as any).chrome;
    sessionState = {};

    (globalThis as any).chrome = {
      runtime: {
        id: "test-extension-id",
        getURL: (path: string) => `chrome-extension://test-extension-id/${path || ""}`
      },
      storage: {
        session: {
          get: async (key: string) => ({ [key]: sessionState[key] }),
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

      // Clean up
      await sendIpc({ type: "tabout-ai-release", owner: "owner-A", keys: [contestedKey] });
      await sendIpc({ type: "tabout-ai-release", owner: "owner-B", keys: [freeKey] });
    });

    test("same owner can re-claim and refresh expiration timestamp of their own keys", async () => {
      const key = "topic:https://refresh-me.org";

      const first = await sendIpc({
        type: "tabout-ai-claim",
        owner: "owner-refresh",
        keys: [key]
      });
      expect(first.response.claimed).toEqual([key]);

      const second = await sendIpc({
        type: "tabout-ai-claim",
        owner: "owner-refresh",
        keys: [key]
      });
      expect(second.response.claimed).toEqual([key]);

      // Clean up
      await sendIpc({ type: "tabout-ai-release", owner: "owner-refresh", keys: [key] });
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

      // Clean up
      await sendIpc({ type: "tabout-ai-release", owner: "owner-Beta", keys: [key] });
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

      // Clean up
      await sendIpc({ type: "tabout-ai-release", owner: "owner-genuine", keys: [key] });
    });
  });

  describe("Session Storage Durability & Memory Bounding", () => {
    test("persists reservations to chrome.storage.session before answering IPC message", async () => {
      const testKey = "topic:https://durable-persist.com";

      await sendIpc({
        type: "tabout-ai-claim",
        owner: "durable-tester",
        keys: [testKey]
      });

      // sessionState must have been updated durably
      expect(sessionState.aiReservations).toBeDefined();
      expect(typeof sessionState.aiReservations).toBe("object");

      // Verify the map entry exists in session storage
      const entries = Object.entries(sessionState.aiReservations);
      const found = entries.some(([k, r]: [string, any]) => r?.owner === "durable-tester" && r?.rawKey === testKey);
      expect(found).toBe(true);

      // Clean up
      await sendIpc({ type: "tabout-ai-release", owner: "durable-tester", keys: [testKey] });
    });

    test("hashes extremely long URLs (> 500 chars) into stable map keys without collisions", async () => {
      const longUrl1 = "https://example.com/search?q=" + "a".repeat(600);
      const longUrl2 = "https://example.com/search?q=" + "b".repeat(600);

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
      expect(claim2.response.claimed).toEqual([longUrl2]);

      // Clean up
      await sendIpc({ type: "tabout-ai-release", owner: "long-url-owner-1", keys: [longUrl1] });
      await sendIpc({ type: "tabout-ai-release", owner: "long-url-owner-2", keys: [longUrl2] });
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

    test("rejects invalid or oversized owner strings", async () => {
      // Empty string
      const emptyOwner = await sendIpc({ type: "tabout-ai-claim", owner: "", keys: ["k1"] });
      expect(emptyOwner.handled).toBe(false);

      // Whitespace only
      const wsOwner = await sendIpc({ type: "tabout-ai-claim", owner: "   ", keys: ["k1"] });
      expect(wsOwner.handled).toBe(false);

      // Oversized owner (> 128 chars)
      const hugeOwner = await sendIpc({ type: "tabout-ai-claim", owner: "x".repeat(150), keys: ["k1"] });
      expect(hugeOwner.handled).toBe(false);
    });

    test("rejects non-array or oversized key batches (> 1000 keys)", async () => {
      const nonArray = await sendIpc({ type: "tabout-ai-claim", owner: "valid-owner", keys: "not-an-array" });
      expect(nonArray.handled).toBe(false);

      const oversizedBatch = Array.from({ length: 1005 }, (_, i) => `key-${i}`);
      const hugeBatch = await sendIpc({ type: "tabout-ai-claim", owner: "valid-owner", keys: oversizedBatch });
      expect(hugeBatch.handled).toBe(false);
    });

    test("safely skips prototype pollution keys without polluting objects", async () => {
      const keysWithProto = ["__proto__", "constructor", "prototype", "toString", "topic:https://valid.com"];
      const res = await sendIpc({
        type: "tabout-ai-claim",
        owner: "proto-tester",
        keys: keysWithProto
      });

      expect(res.handled).toBe(true);
      // Only the valid key is claimed; prototype pollution keys are ignored
      expect(res.response.claimed).toEqual(["topic:https://valid.com"]);

      // Verify Object.prototype is unpolluted
      expect((Object.prototype as any).owner).toBeUndefined();

      // Clean up
      await sendIpc({ type: "tabout-ai-release", owner: "proto-tester", keys: ["topic:https://valid.com"] });
    });
  });

  describe("Context Menu Registration & Action Handler", () => {
    test("setupContextMenus registers context menu entry without throwing", () => {
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
