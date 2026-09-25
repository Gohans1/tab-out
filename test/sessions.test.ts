import { expect, test, describe } from "bun:test";

const {
  getRecentlyClosedTabs,
  restoreClosedTab
} = require("../extension/app.js");

describe("Recently Closed Tabs — Native chrome.sessions", () => {
  test("getRecentlyClosedTabs returns empty array when chrome.sessions API is missing", async () => {
    const origChrome = (globalThis as any).chrome;
    try {
      delete (globalThis as any).chrome;
      const result = await getRecentlyClosedTabs();
      expect(result).toEqual([]);
    } finally {
      (globalThis as any).chrome = origChrome;
    }
  });

  test("getRecentlyClosedTabs returns empty array when chrome.sessions.getRecentlyClosed throws", async () => {
    const origChrome = (globalThis as any).chrome;
    try {
      (globalThis as any).chrome = {
        sessions: {
          getRecentlyClosed: async () => { throw new Error("API disabled"); }
        }
      };
      const resultWithError = await getRecentlyClosedTabs();
      expect(resultWithError).toEqual([]);
    } finally {
      (globalThis as any).chrome = origChrome;
    }
  });

  test("getRecentlyClosedTabs flattens sessions from individual tabs and window tab groups", async () => {
    const origChrome = (globalThis as any).chrome;
    try {
      (globalThis as any).chrome = {
        sessions: {
          MAX_SESSION_RESULTS: 25,
          getRecentlyClosed: async () => [
            {
              lastModified: 1000,
              tab: { sessionId: "s1", title: "Single Tab", url: "https://example.com" }
            },
            {
              lastModified: 2000,
              window: {
                tabs: [
                  { sessionId: "s2", title: "Window Tab 1", url: "https://site-a.com" },
                  { sessionId: "s3", title: "Window Tab 2", url: "chrome://settings" } // Non-real tab should be filtered
                ]
              }
            }
          ]
        }
      };

      const tabs = await getRecentlyClosedTabs(5);
      expect(tabs.length).toBe(2);
      expect(tabs[0].sessionId).toBe("s1");
      expect(tabs[1].sessionId).toBe("s2");
    } finally {
      (globalThis as any).chrome = origChrome;
    }
  });

  test("restoreClosedTab invokes chrome.sessions.restore when sessionId is provided", async () => {
    const origChrome = (globalThis as any).chrome;
    try {
      let restoredSessionId = "";
      let createdTab: any = null;

      (globalThis as any).chrome = {
        sessions: {
          restore: async (sid: string) => { restoredSessionId = sid; }
        },
        tabs: {
          create: async (opts: any) => { createdTab = opts; }
        }
      };

      await restoreClosedTab("session-42", "https://fallback.com");
      expect(restoredSessionId).toBe("session-42");
      expect(createdTab).toBeNull();
    } finally {
      (globalThis as any).chrome = origChrome;
    }
  });

  test("restoreClosedTab falls back to chrome.tabs.create if native session restore fails", async () => {
    const origChrome = (globalThis as any).chrome;
    try {
      let createdTab: any = null;

      (globalThis as any).chrome = {
        sessions: {
          restore: async () => { throw new Error("Session expired"); }
        },
        tabs: {
          create: async (opts: any) => { createdTab = opts; }
        }
      };

      await restoreClosedTab("expired-session", "https://fallback.com");
      expect(createdTab).toEqual({ url: "https://fallback.com" });
    } finally {
      (globalThis as any).chrome = origChrome;
    }
  });
});
