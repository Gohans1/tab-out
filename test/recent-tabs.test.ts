import { expect, test, describe } from "bun:test";

const {
  getRecentTabs,
  getLastActiveTab
} = require("../extension/app.js");

describe("getRecentTabs — Most Recently Used (MRU) Ordering", () => {
  const sampleTabs = [
    { id: 1, title: "Tab 1", url: "https://site1.com", lastAccessed: 1000 },
    { id: 2, title: "Tab 2", url: "https://site2.com", lastAccessed: 5000 },
    { id: 3, title: "Tab 3", url: "https://site3.com", lastAccessed: 3000 },
    { id: 4, title: "Tab 4", url: "https://site4.com", lastAccessed: 2000 },
    { id: 5, title: "Tab 5", url: "https://site5.com", lastAccessed: 4000 },
    { id: 6, title: "Tab 6", url: "https://site6.com", lastAccessed: 6000 }
  ];

  test("sorts tabs descending by lastAccessed timestamp", () => {
    const sorted = getRecentTabs(sampleTabs);
    expect(sorted.length).toBe(5); // default limit 5
    expect(sorted[0].id).toBe(6);  // lastAccessed: 6000
    expect(sorted[1].id).toBe(2);  // lastAccessed: 5000
    expect(sorted[2].id).toBe(5);  // lastAccessed: 4000
    expect(sorted[3].id).toBe(3);  // lastAccessed: 3000
    expect(sorted[4].id).toBe(4);  // lastAccessed: 2000
  });

  test("respects custom limit parameter", () => {
    const limited = getRecentTabs(sampleTabs, { limit: 3 });
    expect(limited.length).toBe(3);
    expect(limited[0].id).toBe(6);
    expect(limited[2].id).toBe(5);
  });

  test("filters out internal URLs and Tab Out extension pages", () => {
    const mixedTabs = [
      { id: 10, title: "New Tab", url: "chrome://newtab", lastAccessed: 9000 },
      { id: 11, title: "Extension", url: "chrome-extension://xyz/index.html", lastAccessed: 8500 },
      { id: 12, title: "About", url: "about:blank", lastAccessed: 8000 },
      { id: 13, title: "Flagged TabOut", url: "https://tabout.com", isTabOut: true, lastAccessed: 7500 },
      { id: 14, title: "Real Web Tab", url: "https://real.com", lastAccessed: 7000 }
    ];

    const result = getRecentTabs(mixedTabs);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe(14);
  });

  test("filters out currentTabId when provided", () => {
    const result = getRecentTabs(sampleTabs, { currentTabId: 6 });
    expect(result.some((t: any) => t.id === 6)).toBe(false);
    expect(result[0].id).toBe(2);
  });

  test("returns empty array when no tabs are provided or eligible", () => {
    expect(getRecentTabs([])).toEqual([]);
    expect(getRecentTabs([null, undefined] as any)).toEqual([]);
  });
});

describe("getLastActiveTab", () => {
  test("returns top MRU tab", () => {
    const tabs = [
      { id: 1, title: "Older", url: "https://old.com", lastAccessed: 100 },
      { id: 2, title: "Newer", url: "https://new.com", lastAccessed: 200 }
    ];
    const top = getLastActiveTab(tabs);
    expect(top).toBeDefined();
    expect(top.id).toBe(2);
  });

  test("returns null when no eligible tabs exist", () => {
    expect(getLastActiveTab([])).toBeNull();
    expect(getLastActiveTab([{ id: 1, url: "chrome://newtab", lastAccessed: 100 }])).toBeNull();
  });
});

describe("renderRecentSidebarCard — Safe Rendering & Decay Rank", () => {
  const { renderRecentSidebarCard } = require("../extension/app.js");

  test("renders recent sidebar card without throwing ReferenceError for rank", () => {
    const origDoc = (globalThis as any).document;
    const cardEl = { style: { display: "none" } };
    const listEl = { innerHTML: "", style: {} };
    const badgeEl = { textContent: "" };

    (globalThis as any).document = {
      getElementById: (id: string) => {
        if (id === "recentSidebarCard") return cardEl;
        if (id === "recentSidebarList") return listEl;
        if (id === "recentSidebarBadge") return badgeEl;
        return null;
      }
    };

    try {
      const mockRecent = [
        { id: 10, title: "Google", url: "https://google.com", lastAccessed: 500 },
        { id: 11, title: "GitHub", url: "https://github.com", lastAccessed: 400, mruRank: 2 }
      ];

      expect(() => {
        renderRecentSidebarCard(mockRecent);
      }).not.toThrow();

      expect(cardEl.style.display).toBe("flex");
      expect(listEl.innerHTML).toContain("decay-rank-1");
      expect(listEl.innerHTML).toContain("decay-rank-2");
    } finally {
      (globalThis as any).document = origDoc;
    }
  });
});
