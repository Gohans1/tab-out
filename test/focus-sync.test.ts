import { expect, test, describe, beforeEach, afterEach } from "bun:test";

const app = require("../extension/app.js");

describe("Focus Sync, DOM Cache & Interaction Lock (TDD Behavior Verification)", () => {
  let originalDocument: any;
  let originalWindow: any;
  let originalChrome: any;

  beforeEach(() => {
    originalDocument = (globalThis as any).document;
    originalWindow = (globalThis as any).window;
    originalChrome = (globalThis as any).chrome;
    app.resetRenderCache();
    app.setUserInteracting(false);
  });

  afterEach(() => {
    (globalThis as any).document = originalDocument;
    (globalThis as any).window = originalWindow;
    (globalThis as any).chrome = originalChrome;
    app.resetRenderCache();
    app.setUserInteracting(false);
  });

  function setupMockDOM() {
    const mockElements: Record<string, any> = {};
    const createElement = (id: string) => {
      const el: any = {
        id,
        style: {},
        textContent: "",
        children: [] as any[],
        _raw: "",
        _serialized: "",
        set innerHTML(val: string) {
          this._raw = val;
          // Simulate browser DOM serialization (e.g. self closing tag adjustments)
          this._serialized = val ? val.replace(/\/>/g, "></path>") : "";
          this.children = val ? [{ tagName: "DIV", className: "mission-card", parentNode: this, text: val }] : [];
        },
        get innerHTML() {
          return this._serialized;
        },
        querySelectorAll: () => [],
        querySelector: () => null
      };
      mockElements[id] = el;
      return el;
    };

    createElement("openTabsSection");
    const missionsEl = createElement("openTabsMissions");
    createElement("openTabsSectionTitle");
    createElement("openTabsSectionCount");
    createElement("greeting");
    createElement("dateDisplay");
    createElement("heroSubtitle");
    createElement("perspectiveTagsBar");
    createElement("perspectiveList");
    createElement("statTabs");
    const headerActionsEl = createElement("openTabsHeaderActions");

    (globalThis as any).document = {
      getElementById: (id: string) => mockElements[id] || null,
      querySelectorAll: () => [],
      querySelector: () => null
    };

    return { mockElements, missionsEl, headerActionsEl };
  }

  describe("areTabsEqual — Tab Set Comparator", () => {
    test("detects identical tabs while ignoring lastAccessed timestamp jitter when MRU order is preserved", () => {
      const tabs1 = [
        { id: 1, url: "https://example.com", title: "Example", active: true, windowId: 10, lastAccessed: 1000 },
        { id: 2, url: "https://github.com", title: "GitHub", active: false, windowId: 10, lastAccessed: 2000 }
      ];

      // Tab list with slight jitter but identical MRU order (Tab 2 still > Tab 1)
      const tabsWithJitter = [
        { id: 1, url: "https://example.com", title: "Example", active: true, windowId: 10, lastAccessed: 1050 },
        { id: 2, url: "https://github.com", title: "GitHub", active: false, windowId: 10, lastAccessed: 2050 }
      ];

      expect(app.areTabsEqual(tabs1, tabsWithJitter)).toBe(true);
    });

    test("detects when the most recently active (MRU) tab changes even if tab count/URLs are identical", () => {
      const tabs1 = [
        { id: 1, url: "https://example.com", title: "Example", active: false, windowId: 10, lastAccessed: 1000 },
        { id: 2, url: "https://youtube.com", title: "YouTube", active: false, windowId: 10, lastAccessed: 2000 }
      ];

      // User switched to Tab 1 (e.g. Example.com), so its lastAccessed now surpasses Tab 2
      const tabsWithSwappedMru = [
        { id: 1, url: "https://example.com", title: "Example", active: false, windowId: 10, lastAccessed: 5000 },
        { id: 2, url: "https://youtube.com", title: "YouTube", active: false, windowId: 10, lastAccessed: 2000 }
      ];

      expect(app.areTabsEqual(tabs1, tabsWithSwappedMru)).toBe(false);
    });

    test("detects real tab modifications (URL, title, active state, order, additions/removals)", () => {
      const base = [
        { id: 1, url: "https://example.com", title: "Example", active: true, windowId: 10 },
        { id: 2, url: "https://github.com", title: "GitHub", active: false, windowId: 10 }
      ];

      expect(app.areTabsEqual(base, [
        { id: 1, url: "https://example.com/new", title: "Example", active: true, windowId: 10 },
        { id: 2, url: "https://github.com", title: "GitHub", active: false, windowId: 10 }
      ])).toBe(false);

      expect(app.areTabsEqual(base, [
        { id: 1, url: "https://example.com", title: "Different Title", active: true, windowId: 10 },
        { id: 2, url: "https://github.com", title: "GitHub", active: false, windowId: 10 }
      ])).toBe(false);

      expect(app.areTabsEqual(base, [
        { id: 1, url: "https://example.com", title: "Example", active: false, windowId: 10 },
        { id: 2, url: "https://github.com", title: "GitHub", active: true, windowId: 10 }
      ])).toBe(false);

      expect(app.areTabsEqual(base, [base[1], base[0]])).toBe(false);
      expect(app.areTabsEqual(base, base.slice(0, 1))).toBe(false);
      expect(app.areTabsEqual([], [])).toBe(true);
    });

    test("a tab whose title only changes its unread count is unchanged on screen, so no re-render", () => {
      const before = [{ id: 1, url: "https://mail.google.com/mail/u/0", title: "(3) Inbox (1,204) - Gmail", active: false, windowId: 10 }];
      const after = [{ ...before[0], title: "(4) Inbox (1,205) - Gmail" }];

      expect(app.areTabsEqual(before, after)).toBe(true);
    });

    test("a favicon swap alone is unchanged on screen (icons come from the URL), so no re-render", () => {
      const before = [{ id: 1, url: "https://chat.example.com/", title: "Chat", active: false, windowId: 10, favIconUrl: "https://chat.example.com/idle.png" }];
      const after = [{ ...before[0], favIconUrl: "https://chat.example.com/unread.png" }];

      expect(app.areTabsEqual(before, after)).toBe(true);
    });
  });

  describe("renderIfChanged & renderStaticDashboard — DOM Stability & Empty State Transitions", () => {
    test("preserves DOM node references when tabs are unchanged (prevents click dropping)", async () => {
      const { missionsEl } = setupMockDOM();

      (globalThis as any).chrome = {
        runtime: { id: "test-ext-id", getURL: (path: string) => `chrome-extension://test-ext-id/${path}` },
        tabs: {
          query: async () => [
            { id: 101, url: "https://github.com/oven-sh/bun", title: "Bun Repo", windowId: 1, active: false }
          ]
        }
      };

      // Initial render pass
      await app.renderStaticDashboard();
      expect(missionsEl.children.length).toBeGreaterThan(0);
      const firstChildRef = missionsEl.children[0];

      // Second render with exact same data
      await app.renderStaticDashboard();
      const secondChildRef = missionsEl.children[0];

      // Node reference MUST be preserved (not detached or recreated)
      expect(secondChildRef).toBe(firstChildRef);
    });

    test("re-renders and updates DOM when tab data actually changes", async () => {
      const { missionsEl } = setupMockDOM();

      let currentQueryTabs = [
        { id: 101, url: "https://github.com/oven-sh/bun", title: "Bun Initial", windowId: 1, active: false }
      ];

      (globalThis as any).chrome = {
        runtime: { id: "test-ext-id", getURL: (path: string) => `chrome-extension://test-ext-id/${path}` },
        tabs: { query: async () => currentQueryTabs }
      };

      await app.renderStaticDashboard();
      const initialNode = missionsEl.children[0];
      expect(initialNode.text).toContain("Bun Initial");

      // Tab title changes
      currentQueryTabs = [
        { id: 101, url: "https://github.com/oven-sh/bun", title: "Bun Updated", windowId: 1, active: false }
      ];

      await app.renderStaticDashboard();
      const updatedNode = missionsEl.children[0];
      expect(updatedNode.text).toContain("Bun Updated");
    });

    test("handles empty state transitions cleanly without leaving UI or header actions stale", async () => {
      const { missionsEl, headerActionsEl } = setupMockDOM();

      let currentQueryTabs = [
        { id: 101, url: "https://github.com/oven-sh/bun", title: "Bun Repo", windowId: 1, active: false },
        { id: 102, url: "https://github.com/oven-sh/bun/issues", title: "Bun Issues", windowId: 1, active: false }
      ];

      (globalThis as any).chrome = {
        runtime: { id: "test-ext-id", getURL: (path: string) => `chrome-extension://test-ext-id/${path}` },
        tabs: { query: async () => currentQueryTabs }
      };

      // 1. Populated state: 2 tabs open -> header action "Close all 2 tabs" should appear
      await app.renderStaticDashboard();
      expect(missionsEl.children[0].text).toContain("Bun Repo");
      expect(headerActionsEl.children[0]?.text || headerActionsEl.innerHTML).toContain("Close all 2 tabs");

      // 2. All tabs closed -> empty state: missions empty, header actions cleared
      currentQueryTabs = [];
      await app.renderStaticDashboard();
      expect(missionsEl.children[0].text).toContain("All tabs closed");
      expect(headerActionsEl.children.length === 0 || headerActionsEl.innerHTML === "").toBe(true);

      // 3. Same tabs reopened -> must re-render populated card AND header actions ("Close all 2 tabs")
      currentQueryTabs = [
        { id: 101, url: "https://github.com/oven-sh/bun", title: "Bun Repo", windowId: 1, active: false },
        { id: 102, url: "https://github.com/oven-sh/bun/issues", title: "Bun Issues", windowId: 1, active: false }
      ];
      await app.renderStaticDashboard();
      expect(missionsEl.children[0].text).toContain("Bun Repo");
      expect(headerActionsEl.children[0]?.text || headerActionsEl.innerHTML).toContain("Close all 2 tabs");
    });

    test("performSync updates dashboard and MRU badge when user switches tabs and returns", async () => {
      const { missionsEl } = setupMockDOM();

      let currentQueryTabs = [
        { id: 101, url: "https://site-x.com", title: "Site X", windowId: 1, active: false, lastAccessed: 2000 },
        { id: 102, url: "https://youtube.com", title: "YouTube", windowId: 1, active: false, lastAccessed: 1000 }
      ];

      (globalThis as any).chrome = {
        runtime: { id: "test-ext-id", getURL: (path: string) => `chrome-extension://test-ext-id/${path}` },
        tabs: { query: async () => currentQueryTabs }
      };

      // 1. Initial sync: Site X is last active tab (lastAccessed 2000 > 1000)
      await app.performSync(false);
      expect(missionsEl.children[0].text).toContain("is-last-active");
      expect(missionsEl.children[0].text).toContain("Site X");

      // 2. User switches to YouTube: YouTube's lastAccessed becomes 5000
      currentQueryTabs = [
        { id: 101, url: "https://site-x.com", title: "Site X", windowId: 1, active: false, lastAccessed: 2000 },
        { id: 102, url: "https://youtube.com", title: "YouTube", windowId: 1, active: false, lastAccessed: 5000 }
      ];

      // 3. User returns to Tab Out: performSync must detect MRU change and re-render
      await app.performSync(false);
      const updatedCardText = missionsEl.children[0].text;
      // In updated DOM, YouTube must specifically have is-last-active and Site X must NOT
      expect(updatedCardText).toContain('data-tab-url="https://youtube.com"');
      expect(updatedCardText).toMatch(/is-last-active[^>]*data-tab-url="https:\/\/youtube\.com"/);
      expect(updatedCardText).not.toMatch(/is-last-active[^>]*data-tab-url="https:\/\/site-x\.com"/);
    });
  });

  describe("User Interaction Lock & Background Sync Deferral", () => {
    test("defers sync while user is interacting and flushes on release", async () => {
      setupMockDOM();
      let queryCount = 0;

      (globalThis as any).chrome = {
        runtime: { id: "test-ext-id", getURL: (path: string) => `chrome-extension://test-ext-id/${path}` },
        tabs: {
          query: async () => {
            queryCount++;
            return [
              { id: 101, url: "https://github.com/oven-sh/bun", title: "Bun Repo", windowId: 1, active: false }
            ];
          }
        }
      };

      // Run baseline initial sync
      await app.performSync(true);
      const baselineCount = queryCount;
      expect(baselineCount).toBeGreaterThan(0);

      // 1. User starts clicking/interacting (mousedown)
      app.startUserInteraction();
      expect(app.isUserInteracting()).toBe(true);

      // 2. Sync is triggered during user interaction (e.g. window focus / background event)
      // Must be deferred to protect in-flight click target from DOM detachment
      await app.performSync(true);
      expect(queryCount).toBe(baselineCount);

      // 3. User finishes click (mouseup / pointerup)
      app.releaseUserInteraction();
      expect(app.isUserInteracting()).toBe(false);

      // 4. releaseUserInteraction flushes the deferred sync via debouncedSyncRef(100, false)
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(queryCount).toBeGreaterThan(baselineCount);
    });

    test("interaction lock safety timeout automatically releases lock to prevent deadlocks", async () => {
      // Start user interaction with a deterministic 40ms safety timeout
      app.startUserInteraction(40);
      expect(app.isUserInteracting()).toBe(true);

      // Wait 70ms without manually calling releaseUserInteraction()
      await new Promise(resolve => setTimeout(resolve, 70));

      // Lock MUST be released automatically by the defensive safety timer
      expect(app.isUserInteracting()).toBe(false);
    });
  });
});
