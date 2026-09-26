import { expect, test, describe, beforeEach } from "bun:test";

const app = require("../extension/app.js");
const i18n = require("../extension/i18n.js");

describe("Category Focus View & Segmented Button Bar (TDD)", () => {
  beforeEach(() => {
    if (typeof app.resetRenderCache === "function") {
      app.resetRenderCache();
    }
    if (typeof app.selectCategoryFilter === "function") {
      app.selectCategoryFilter(null);
    } else {
      app.activeCategoryFilter = null;
    }
  });

  describe("Pillar 1: Segmented Button Bar & 'All' View Tab", () => {
    test("renderPerspectiveTagsBar renders 'All' button as first tab with total tab count and is-selected state by default", () => {
      let renderedHtml = "";
      let barDisplay = "none";
      const dummyBar = {
        style: {
          get display() { return barDisplay; },
          set display(v: string) { barDisplay = v; }
        },
        get innerHTML() { return renderedHtml; },
        set innerHTML(v: string) { renderedHtml = v; },
        querySelectorAll: () => []
      };

      (globalThis as any).document = {
        getElementById: (id: string) => (id === "perspectiveTagsBar" ? dummyBar : null),
        querySelector: () => null,
        querySelectorAll: () => []
      };

      const origActivePid = app.activePerspectiveId;
      const origPerspectives = app.currentPerspectives;
      const origKey = app.openRouterApiKey;

      try {
        app.activePerspectiveId = "custom_p";
        app.openRouterApiKey = "mock-key";
        app.activeCategoryFilter = null;
        app.currentPerspectives = [
          { id: "domain", name: "Domain", isSystem: true },
          {
            id: "custom_p",
            name: "Topic",
            labels: [
              { name: "Work", description: "Productivity", color: "blue" },
              { name: "Social", description: "Social media", color: "rose" },
              { name: "Other", description: "", color: "" }
            ]
          }
        ];

        const mockGroups = [
          { label: "Work", domain: "perspective:work", isSemantic: true, tabs: [{ id: 1 }, { id: 2 }] },
          { label: "Social", domain: "perspective:social", isSemantic: true, tabs: [{ id: 3 }] }
        ];

        app.renderPerspectiveTagsBar(mockGroups);

        expect(barDisplay).toBe("flex");
        // Must contain an 'All' button
        expect(renderedHtml).toContain('data-category="all"');
        expect(renderedHtml).toContain('is-all');
        expect(renderedHtml).toContain('is-selected'); // Default view chung is selected
        // Total count should be 3
        expect(renderedHtml).toContain('3');
      } finally {
        app.activePerspectiveId = origActivePid;
        app.currentPerspectives = origPerspectives;
        app.openRouterApiKey = origKey;
        delete (globalThis as any).document;
      }
    });

    test("renders category items as interactive buttons with role='tab' and selected state when matching activeCategoryFilter", () => {
      let renderedHtml = "";
      const dummyBar = {
        style: { display: "none" },
        get innerHTML() { return renderedHtml; },
        set innerHTML(v: string) { renderedHtml = v; }
      };

      (globalThis as any).document = {
        getElementById: (id: string) => (id === "perspectiveTagsBar" ? dummyBar : null),
        querySelector: () => null,
        querySelectorAll: () => []
      };

      const origActivePid = app.activePerspectiveId;
      const origPerspectives = app.currentPerspectives;
      const origKey = app.openRouterApiKey;

      try {
        app.activePerspectiveId = "custom_p";
        app.openRouterApiKey = "mock-key";
        app.activeCategoryFilter = "Work"; // Focus on Work
        app.currentPerspectives = [
          {
            id: "custom_p",
            name: "Topic",
            labels: [
              { name: "Work", description: "Productivity", color: "blue" },
              { name: "Social", description: "Social media", color: "rose" }
            ]
          }
        ];

        const mockGroups = [
          { label: "Work", domain: "perspective:work", isSemantic: true, tabs: [{ id: 1 }] },
          { label: "Social", domain: "perspective:social", isSemantic: true, tabs: [{ id: 2 }] }
        ];

        app.renderPerspectiveTagsBar(mockGroups);

        // All button should NOT be selected
        expect(renderedHtml).not.toMatch(/class="[^"]*is-selected[^"]*"[^>]*data-category="all"/);
        // Work button MUST be selected
        expect(renderedHtml).toMatch(/class="[^"]*is-selected[^"]*"[^>]*data-category="Work"/);
        // Buttons should have button tag and role="tab"
        expect(renderedHtml).toContain('role="tab"');
        expect(renderedHtml).toContain('<button');
      } finally {
        app.activePerspectiveId = origActivePid;
        app.currentPerspectives = origPerspectives;
        app.openRouterApiKey = origKey;
        app.activeCategoryFilter = null;
        delete (globalThis as any).document;
      }
    });
  });

  describe("Pillar 2: Category Filter State Management", () => {
    test("selectCategoryFilter switches active category and handles 'all' as null", () => {
      expect(typeof app.selectCategoryFilter).toBe("function");

      app.selectCategoryFilter("Work");
      expect(app.activeCategoryFilter).toBe("Work");

      app.selectCategoryFilter("all");
      expect(app.activeCategoryFilter).toBe(null);

      app.selectCategoryFilter(null);
      expect(app.activeCategoryFilter).toBe(null);
    });

    test("switchPerspective resets activeCategoryFilter to null", async () => {
      app.activeCategoryFilter = "Work";
      app.activePerspectiveId = "custom_p";
      // Switch perspective should clear category focus
      if (typeof app.switchPerspective === "function") {
        await app.switchPerspective("domain");
        expect(app.activeCategoryFilter).toBe(null);
      }
    });
  });

  describe("Pillar 3: Dedicated Category View Layout", () => {
    test("renderCategoryFocusView produces dedicated layout with header, actions, and tab list", () => {
      expect(typeof app.renderCategoryFocusView).toBe("function");

      const categoryGroup = {
        label: "AI & Assistants",
        domain: "perspective:ai",
        isSemantic: true,
        tabs: [
          { id: 101, title: "ChatGPT", url: "https://chatgpt.com", favIconUrl: "https://chatgpt.com/favicon.ico" },
          { id: 102, title: "Claude AI", url: "https://claude.ai", favIconUrl: "https://claude.ai/favicon.ico" }
        ]
      };

      const categoryMeta = {
        name: "AI & Assistants",
        description: "AI conversational agents and tools",
        color: "purple"
      };

      const html = app.renderCategoryFocusView(categoryGroup, categoryMeta);

      // Must have dedicated focus container
      expect(html).toContain("category-focus-view");
      // Must display category title & description
      expect(html).toContain("AI &amp; Assistants");
      expect(html).toContain("AI conversational agents and tools");
      // Clean header: redundant breadcrumbs and duplicate close button are removed from focus view
      expect(html).not.toContain("category-focus-nav-bar");
      expect(html).not.toContain("category-focus-breadcrumb");
      // Must render domain cards and tab items
      expect(html).toContain("ChatGPT");
      expect(html).toContain("Claude AI");
      expect(html).toContain("chatgpt.com");
      expect(html).toContain("claude.ai");
    });

    test("renderCategoryFocusView handles empty category gracefully", () => {
      const emptyGroup = {
        label: "Gaming",
        domain: "perspective:gaming",
        isSemantic: true,
        tabs: []
      };

      const categoryMeta = {
        name: "Gaming",
        description: "Games and streaming",
        color: "emerald"
      };

      const html = app.renderCategoryFocusView(emptyGroup, categoryMeta);
      expect(html).toContain("category-focus-view");
      expect(html).toContain("Gaming");
      expect(html).toContain("category-focus-empty");
    });

    test("groupTabsByDomain groups tabs by domain and sorts domain with most tabs first", () => {
      expect(typeof app.groupTabsByDomain).toBe("function");

      const tabs = [
        { id: 1, title: "ChatGPT Prompt", url: "https://chatgpt.com/c/1" },
        { id: 2, title: "Grok Review 1", url: "https://grok.com/1" },
        { id: 3, title: "Grok Review 2", url: "https://grok.com/2" },
        { id: 4, title: "Grok Review 3", url: "https://grok.com/3" }
      ];

      const groups = app.groupTabsByDomain(tabs);
      expect(groups.length).toBe(2);
      // Grok has 3 tabs, so it MUST be first
      expect(groups[0].domain).toBe("grok.com");
      expect(groups[0].tabs.length).toBe(3);
      // ChatGPT has 1 tab, so it MUST be second
      expect(groups[1].domain).toBe("chatgpt.com");
      expect(groups[1].tabs.length).toBe(1);
    });

    test("renderCategoryFocusView renders domain cards matching default perspective layout, sorted by most tabs first", () => {
      const categoryGroup = {
        label: "AI & Assistants",
        domain: "perspective:ai",
        isSemantic: true,
        tabs: [
          { id: 101, title: "ChatGPT", url: "https://chatgpt.com", favIconUrl: "https://chatgpt.com/favicon.ico" },
          { id: 102, title: "Grok Review 1", url: "https://grok.com/review1", favIconUrl: "https://grok.com/favicon.ico" },
          { id: 103, title: "Grok Review 2", url: "https://grok.com/review2", favIconUrl: "https://grok.com/favicon.ico" }
        ]
      };

      const categoryMeta = {
        name: "AI & Assistants",
        description: "AI conversational agents and tools",
        color: "purple"
      };

      const html = app.renderCategoryFocusView(categoryGroup, categoryMeta);

      // Must have domain cards (.mission-card) inside .missions container
      expect(html).toContain("mission-card");
      expect(html).toContain("category-focus-missions");
      expect(html).toContain("missions");

      // Grok has 2 tabs vs ChatGPT 1 tab -> grok.com card must appear before chatgpt.com card
      const grokIdx = html.indexOf('data-domain="grok.com"');
      const chatgptIdx = html.indexOf('data-domain="chatgpt.com"');
      expect(grokIdx).toBeGreaterThan(-1);
      expect(chatgptIdx).toBeGreaterThan(-1);
      expect(grokIdx).toBeLessThan(chatgptIdx);

      // Cards must have domain close actions (close-domain-tabs)
      expect(html).toContain('data-action="close-domain-tabs"');
      expect(html).toContain('Close 2 tabs');
      expect(html).toContain('Close tab');

      // Chips must have single tab close and save actions
      expect(html).toContain('data-action="close-single-tab"');
      expect(html).toContain('data-action="defer-single-tab"');
    });
  });

  describe("Pillar 4: Localization Keys in i18n", () => {
    test("i18n defines bilingual keys for all categories and back navigation", () => {
      const en = i18n.TRANSLATIONS?.en || {};
      const vi = i18n.TRANSLATIONS?.vi || {};

      expect(en['tabs.all_categories']).toBeDefined();
      expect(vi['tabs.all_categories']).toBeDefined();

      expect(en['tabs.back_to_all']).toBeDefined();
      expect(vi['tabs.back_to_all']).toBeDefined();

      expect(en['tabs.close_category_tabs']).toBeDefined();
      expect(vi['tabs.close_category_tabs']).toBeDefined();
    });
  });

  describe("Pillar 5: Robustness, Security & Undo Stack", () => {
    test("renderCategoryFocusView sanitizes url with safeUrl and includes data-tab-url on title button", () => {
      const group = {
        label: "AI",
        domain: "perspective:ai",
        isSemantic: true,
        tabs: [
          { id: 42, title: "Dangerous Scheme", url: "javascript:alert(1)", favIconUrl: "" },
          { id: 43, title: "Legit Tab", url: "https://example.com", favIconUrl: "https://example.com/icon.png" }
        ]
      };
      const meta = { name: "AI", description: "", color: "purple" };
      const html = app.renderCategoryFocusView(group, meta);

      expect(html).not.toContain("javascript:alert(1)");
      expect(html).toContain('data-tab-url="https://example.com"');
      expect(html).toContain('data-tab-id="43"');
    });

    test("renderStaticDashboard does not throw when activeP.labels contains plain strings or malformed items", async () => {
      const origActivePid = app.activePerspectiveId;
      const origPerspectives = app.currentPerspectives;
      const origGroups = (globalThis as any).domainGroups;

      let dummyMissionsHtml = "";
      const dummyMissionsEl = {
        innerHTML: "",
        querySelector: () => null,
        querySelectorAll: () => []
      };

      (globalThis as any).document = {
        getElementById: (id: string) => {
          if (id === "openTabsMissions") return dummyMissionsEl;
          return null;
        },
        querySelector: () => null,
        querySelectorAll: () => []
      };

      try {
        app.activePerspectiveId = "p_strings";
        app.activeCategoryFilter = "Work";
        app.currentPerspectives = [
          {
            id: "p_strings",
            name: "String Labels",
            labels: ["Work", "Study", null as any, undefined as any]
          }
        ];

        // Should not throw TypeError: Cannot read properties of undefined (reading 'toLowerCase')
        expect(() => {
          if (typeof app.renderStaticDashboard === "function") {
            app.renderStaticDashboard();
          }
        }).not.toThrow();
      } finally {
        app.activePerspectiveId = origActivePid;
        app.currentPerspectives = origPerspectives;
        app.activeCategoryFilter = null;
      }
    });

    test("areCategoryLabelsEquivalent correctly matches EN and VI template labels", () => {
      expect(typeof app.areCategoryLabelsEquivalent).toBe("function");

      const topicPerspective = {
        id: "topic",
        templateId: "topic",
        name: "Topic",
        labels: [
          { name: "Work & Productivity", description: "", color: "blue" },
          { name: "Education & Study", description: "", color: "amber" },
          { name: "Other", description: "", color: "" }
        ]
      };

      // Exact match
      expect(app.areCategoryLabelsEquivalent("Work & Productivity", "Work & Productivity", topicPerspective)).toBe(true);
      // Case insensitive
      expect(app.areCategoryLabelsEquivalent("work & productivity", "WORK & PRODUCTIVITY", topicPerspective)).toBe(true);
      // Cross-locale match: English <-> Vietnamese
      expect(app.areCategoryLabelsEquivalent("Work & Productivity", "Công việc & Năng suất", topicPerspective)).toBe(true);
      expect(app.areCategoryLabelsEquivalent("Giáo dục & Học tập", "Education & Study", topicPerspective)).toBe(true);
      // Mismatched categories
      expect(app.areCategoryLabelsEquivalent("Work & Productivity", "Giáo dục & Học tập", topicPerspective)).toBe(false);
      // Null / empty safety
      expect(app.areCategoryLabelsEquivalent(null, "Work", topicPerspective)).toBe(false);
      expect(app.areCategoryLabelsEquivalent("Work", undefined, topicPerspective)).toBe(false);

      // Fallback labels match across languages even for custom perspectives
      expect(app.areCategoryLabelsEquivalent("Other", "Khác")).toBe(true);
      expect(app.areCategoryLabelsEquivalent("Khác", "Other")).toBe(true);
    });

    test("checkAndShowEmptyState preserves category focus view when closing single tab if other tabs exist", () => {
      let missionsHtml = '<div class="category-focus-view"><div class="category-focus-tab-row">Tab 1</div></div>';
      const dummyMissionsEl = {
        get innerHTML() { return missionsHtml; },
        set innerHTML(v: string) { missionsHtml = v; },
        querySelectorAll: (selector: string) => {
          if (selector === '.mission-card') return [];
          if (selector.includes('.category-focus-tab-row')) return [{ isConnected: true }];
          return [];
        },
        querySelector: (selector: string) => {
          if (selector === '.category-focus-empty') return null;
          return null;
        }
      };

      (globalThis as any).document = {
        getElementById: (id: string) => (id === "openTabsMissions" ? dummyMissionsEl : null),
        querySelector: () => null,
        querySelectorAll: () => []
      };

      app.activeCategoryFilter = "Work";

      // Call checkAndShowEmptyState
      if (typeof app.checkAndShowEmptyState === "function") {
        app.checkAndShowEmptyState();
      }

      // Must NOT be overwritten with global "All tabs closed" screen!
      expect(missionsHtml).not.toContain("missions-empty-state");
      expect(missionsHtml).toContain("category-focus-view");
    });

    test("closing last tab in category focus view transitions to category-focus-empty", () => {
      let missionsHtml = '<div class="category-focus-view"></div>';
      const dummyMissionsEl = {
        get innerHTML() { return missionsHtml; },
        set innerHTML(v: string) { missionsHtml = v; },
        querySelectorAll: (selector: string) => {
          if (selector.includes('.category-focus-tab-row')) return []; // all tabs removed
          return [];
        },
        querySelector: (selector: string) => {
          if (selector === '.category-focus-empty') return null;
          return null;
        }
      };

      (globalThis as any).document = {
        getElementById: (id: string) => (id === "openTabsMissions" ? dummyMissionsEl : null),
        querySelector: () => null,
        querySelectorAll: () => []
      };

      app.activeCategoryFilter = "Work";
      app.currentPerspectives = [
        {
          id: "custom",
          name: "Custom",
          labels: [{ name: "Work", description: "Work tasks", color: "blue" }]
        }
      ];
      app.activePerspectiveId = "custom";

      // When all tabs in category are closed, checkAndShowEmptyState should render category-focus-empty
      if (typeof app.checkAndShowEmptyState === "function") {
        app.checkAndShowEmptyState();
      }

      expect(missionsHtml).toContain("category-focus-empty");
      expect(missionsHtml).toContain('data-action="filter-category"');
    });

    test("checkAndShowEmptyState respects page-chip presence in category focus view", () => {
      let missionsHtml = '<div class="category-focus-view"><div class="category-focus-missions missions"><div class="mission-card"><div class="page-chip">Tab</div></div></div></div>';
      const dummyMissionsEl = {
        get innerHTML() { return missionsHtml; },
        set innerHTML(v: string) { missionsHtml = v; },
        querySelectorAll: (selector: string) => {
          if (selector.includes('.page-chip')) return [{ isConnected: true }];
          return [];
        },
        querySelector: (selector: string) => null
      };

      (globalThis as any).document = {
        getElementById: (id: string) => (id === "openTabsMissions" ? dummyMissionsEl : null),
        querySelector: () => null,
        querySelectorAll: () => []
      };

      app.activeCategoryFilter = "Work";

      if (typeof app.checkAndShowEmptyState === "function") {
        app.checkAndShowEmptyState();
      }

      // Remaining chip exists, so it should NOT transition to empty!
      expect(missionsHtml).not.toContain("category-focus-empty");
      expect(missionsHtml).toContain("category-focus-view");
    });

    test("updateHeaderAndStats accurately sums duplicate tab counts and skips closing cards", () => {
      const countEl = { textContent: "" };
      const headerCountEl = { textContent: "" };

      const chip1 = {
        dataset: { tabCount: "3" },
        closest: (sel: string) => null
      };
      const chip2 = {
        dataset: { tabCount: "2" },
        closest: (sel: string) => null
      };
      const closingChip = {
        dataset: { tabCount: "5" },
        closest: (sel: string) => (sel.includes(".mission-card.closing") ? { isClosing: true } : null)
      };

      const missionsEl = {
        querySelector: (sel: string) => {
          if (sel === ".category-focus-view") return { isCategoryView: true };
          if (sel === ".category-focus-count") return headerCountEl;
          return null;
        },
        querySelectorAll: (sel: string) => {
          if (sel.includes(".page-chip")) return [chip1, chip2, closingChip];
          return [];
        }
      };

      (globalThis as any).document = {
        getElementById: (id: string) => {
          if (id === "openTabsMissions") return missionsEl;
          if (id === "openTabsSectionCount") return countEl;
          return null;
        },
        querySelector: () => null,
        querySelectorAll: () => []
      };

      app.activeCategoryFilter = "AI & Assistants";

      if (typeof app.updateHeaderAndStats === "function") {
        app.updateHeaderAndStats();
      }

      // Expected sum: 3 (chip1) + 2 (chip2) = 5 tabs (closingChip with 5 is ignored!)
      expect(countEl.textContent).toContain("5 open tabs");
      expect(headerCountEl.textContent).toContain("5 open tabs");
    });
  });

  describe("Pillar 6: Section Header Adaptability — Dynamic Tag Close Action", () => {
    test("in 'All' view, header actions button closes all open tabs across perspective", () => {
      let headerHtml = "";
      const container = {
        get innerHTML() { return headerHtml; },
        set innerHTML(v: string) { headerHtml = v; }
      };

      (globalThis as any).document = {
        getElementById: (id: string) => (id === "openTabsHeaderActions" ? container : null),
        querySelector: () => null,
        querySelectorAll: () => []
      };

      app.activeCategoryFilter = null;
      app.activePerspectiveId = "topic";
      if (typeof app.resetRenderCache === "function") {
        app.resetRenderCache("headerActions");
      }

      const tabs = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, url: `https://site${i}.com` }));

      if (typeof app.renderOpenTabsHeaderActions === "function") {
        app.renderOpenTabsHeaderActions(tabs);
      }

      expect(headerHtml).toContain('data-action="close-all-open-tabs"');
      expect(headerHtml).toContain("Close all 9 tabs");
    });

    test("when focused on a specific category tag, header action adapts to close that category's tabs only", () => {
      let headerHtml = "";
      const container = {
        get innerHTML() { return headerHtml; },
        set innerHTML(v: string) { headerHtml = v; }
      };

      (globalThis as any).document = {
        getElementById: (id: string) => (id === "openTabsHeaderActions" ? container : null),
        querySelector: () => null,
        querySelectorAll: () => []
      };

      app.activePerspectiveId = "topic";
      app.activeCategoryFilter = "AI & Assistants";
      if (typeof app.resetRenderCache === "function") {
        app.resetRenderCache("headerActions");
      }

      app.domainGroups = [
        {
          label: "AI & Assistants",
          domain: "perspective:ai",
          isSemantic: true,
          tabs: [
            { id: 1, url: "https://chatgpt.com" },
            { id: 2, url: "https://grok.com" }
          ]
        },
        {
          label: "Social Media",
          domain: "perspective:social",
          isSemantic: true,
          tabs: [
            { id: 3, url: "https://x.com" },
            { id: 4, url: "https://reddit.com" },
            { id: 5, url: "https://youtube.com" },
            { id: 6, url: "https://facebook.com" }
          ]
        }
      ];

      const allTabs = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, url: `https://site${i}.com` }));

      if (typeof app.renderOpenTabsHeaderActions === "function") {
        app.renderOpenTabsHeaderActions(allTabs);
      }

      // Must adapt to AI & Assistants with 2 tabs!
      expect(headerHtml).toContain('data-action="close-category-tabs"');
      expect(headerHtml).toContain('data-category="AI &amp; Assistants"');
      expect(headerHtml).toContain("Close all 2 tabs");
      // Must NOT close all 9 tabs!
      expect(headerHtml).not.toContain('data-action="close-all-open-tabs"');
      expect(headerHtml).not.toContain("Close all 9 tabs");
    });

    test("when category has 1 tab, header action displays singular close text", () => {
      let headerHtml = "";
      const container = {
        get innerHTML() { return headerHtml; },
        set innerHTML(v: string) { headerHtml = v; }
      };

      (globalThis as any).document = {
        getElementById: (id: string) => (id === "openTabsHeaderActions" ? container : null),
        querySelector: () => null,
        querySelectorAll: () => []
      };

      app.activePerspectiveId = "topic";
      app.activeCategoryFilter = "Work";
      if (typeof app.resetRenderCache === "function") {
        app.resetRenderCache("headerActions");
      }

      app.domainGroups = [
        {
          label: "Work",
          domain: "perspective:work",
          isSemantic: true,
          tabs: [{ id: 10, url: "https://github.com" }]
        }
      ];

      if (typeof app.renderOpenTabsHeaderActions === "function") {
        app.renderOpenTabsHeaderActions(app.domainGroups[0].tabs);
      }

      expect(headerHtml).toContain('data-action="close-category-tabs"');
      expect(headerHtml).toContain("Close tab");
    });
  });

  describe("Pillar 7: Overflow Mechanics & Smart Tag Collapsing (Options 1 & 2)", () => {
    test("smart tag collapsing: when user has few tabs with empty categories, collapses empty tags into '+ N more' by default", () => {
      let renderedHtml = "";
      const dummyBar = {
        style: { display: "none" },
        get innerHTML() { return renderedHtml; },
        set innerHTML(v: string) { renderedHtml = v; },
        setAttribute: () => {},
        querySelector: () => null,
        querySelectorAll: () => []
      };

      (globalThis as any).document = {
        getElementById: (id: string) => (id === "perspectiveTagsBar" ? dummyBar : null),
        querySelector: () => null,
        querySelectorAll: () => []
      };

      const origActivePid = app.activePerspectiveId;
      const origPerspectives = app.currentPerspectives;
      const origKey = app.openRouterApiKey;

      try {
        app.activePerspectiveId = "custom_p";
        app.openRouterApiKey = "mock-key";
        app.activeCategoryFilter = null;
        if (typeof app.setShowEmptyCategoryTags === "function") {
          app.setShowEmptyCategoryTags(false);
        } else {
          app.showEmptyCategoryTags = false;
        }

        app.currentPerspectives = [
          {
            id: "custom_p",
            name: "Topic",
            labels: [
              { name: "Work", description: "", color: "blue" },
              { name: "Social", description: "", color: "rose" },
              { name: "Study", description: "", color: "amber" },
              { name: "Development", description: "", color: "emerald" },
              { name: "Other", description: "", color: "" }
            ]
          }
        ];

        const mockGroups = [
          { label: "Work", domain: "perspective:work", isSemantic: true, tabs: [{ id: 1 }, { id: 2 }] },
          { label: "Social", domain: "perspective:social", isSemantic: true, tabs: [{ id: 3 }] }
        ];

        app.renderPerspectiveTagsBar(mockGroups);

        expect(renderedHtml).toContain('data-category="all"');
        expect(renderedHtml).toContain('data-category="Work"');
        expect(renderedHtml).toContain('data-category="Social"');
        // Empty categories (Study, Development, Other) should be collapsed into toggle button
        expect(renderedHtml).toContain('data-action="toggle-empty-tags"');
        expect(renderedHtml).toContain("+ 3 more");
        expect(renderedHtml).not.toContain('data-category="Study"');
        expect(renderedHtml).not.toContain('data-category="Development"');
      } finally {
        app.activePerspectiveId = origActivePid;
        app.currentPerspectives = origPerspectives;
        app.openRouterApiKey = origKey;
        delete (globalThis as any).document;
      }
    });

    test("smart tag collapsing: when showEmptyCategoryTags is true, renders all categories and a '- Less' toggle button", () => {
      let renderedHtml = "";
      const dummyBar = {
        style: { display: "none" },
        get innerHTML() { return renderedHtml; },
        set innerHTML(v: string) { renderedHtml = v; },
        setAttribute: () => {},
        querySelector: () => null,
        querySelectorAll: () => []
      };

      (globalThis as any).document = {
        getElementById: (id: string) => (id === "perspectiveTagsBar" ? dummyBar : null),
        querySelector: () => null,
        querySelectorAll: () => []
      };

      const origActivePid = app.activePerspectiveId;
      const origPerspectives = app.currentPerspectives;
      const origKey = app.openRouterApiKey;

      try {
        app.activePerspectiveId = "custom_p";
        app.openRouterApiKey = "mock-key";
        app.activeCategoryFilter = null;
        if (typeof app.setShowEmptyCategoryTags === "function") {
          app.setShowEmptyCategoryTags(true);
        } else {
          app.showEmptyCategoryTags = true;
        }

        app.currentPerspectives = [
          {
            id: "custom_p",
            name: "Topic",
            labels: [
              { name: "Work", description: "", color: "blue" },
              { name: "Social", description: "", color: "rose" },
              { name: "Study", description: "", color: "amber" },
              { name: "Development", description: "", color: "emerald" },
              { name: "Other", description: "", color: "" }
            ]
          }
        ];

        const mockGroups = [
          { label: "Work", domain: "perspective:work", isSemantic: true, tabs: [{ id: 1 }, { id: 2 }] },
          { label: "Social", domain: "perspective:social", isSemantic: true, tabs: [{ id: 3 }] }
        ];

        app.renderPerspectiveTagsBar(mockGroups);

        expect(renderedHtml).toContain('data-category="Work"');
        expect(renderedHtml).toContain('data-category="Social"');
        expect(renderedHtml).toContain('data-category="Study"');
        expect(renderedHtml).toContain('data-category="Development"');
        expect(renderedHtml).toContain('data-action="toggle-empty-tags"');
        expect(renderedHtml).toContain("Less");
      } finally {
        app.activePerspectiveId = origActivePid;
        app.currentPerspectives = origPerspectives;
        app.openRouterApiKey = origKey;
        delete (globalThis as any).document;
      }
    });

    test("smart tag collapsing: selected empty category remains visible even when collapsed", () => {
      let renderedHtml = "";
      const dummyBar = {
        style: { display: "none" },
        get innerHTML() { return renderedHtml; },
        set innerHTML(v: string) { renderedHtml = v; },
        setAttribute: () => {},
        querySelector: () => null,
        querySelectorAll: () => []
      };

      (globalThis as any).document = {
        getElementById: (id: string) => (id === "perspectiveTagsBar" ? dummyBar : null),
        querySelector: () => null,
        querySelectorAll: () => []
      };

      const origActivePid = app.activePerspectiveId;
      const origPerspectives = app.currentPerspectives;
      const origKey = app.openRouterApiKey;

      try {
        app.activePerspectiveId = "custom_p";
        app.openRouterApiKey = "mock-key";
        app.activeCategoryFilter = "Study"; // Selected category is empty!
        if (typeof app.setShowEmptyCategoryTags === "function") {
          app.setShowEmptyCategoryTags(false);
        } else {
          app.showEmptyCategoryTags = false;
        }

        app.currentPerspectives = [
          {
            id: "custom_p",
            name: "Topic",
            labels: [
              { name: "Work", description: "", color: "blue" },
              { name: "Social", description: "", color: "rose" },
              { name: "Study", description: "", color: "amber" },
              { name: "Development", description: "", color: "emerald" },
              { name: "Other", description: "", color: "" }
            ]
          }
        ];

        const mockGroups = [
          { label: "Work", domain: "perspective:work", isSemantic: true, tabs: [{ id: 1 }] }
        ];

        app.renderPerspectiveTagsBar(mockGroups);

        // Study must be rendered and selected
        expect(renderedHtml).toContain('data-category="Study"');
        expect(renderedHtml).toContain('is-selected');
        // Remaining empty categories are Social, Development and Other (3 items)
        expect(renderedHtml).toContain('data-action="toggle-empty-tags"');
        expect(renderedHtml).toContain("+ 3 more");
      } finally {
        app.activePerspectiveId = origActivePid;
        app.currentPerspectives = origPerspectives;
        app.openRouterApiKey = origKey;
        delete (globalThis as any).document;
      }
    });

    test("updateTagsBarScrollMask toggles can-scroll-left and can-scroll-right accurately", () => {
      expect(typeof app.updateTagsBarScrollMask).toBe("function");

      const classes = new Set<string>();
      const mockBar = {
        scrollWidth: 1000,
        clientWidth: 500,
        scrollLeft: 0,
        classList: {
          toggle: (cls: string, force?: boolean) => {
            if (force) classes.add(cls);
            else classes.delete(cls);
          },
          remove: (...args: string[]) => {
            args.forEach(a => classes.delete(a));
          },
          contains: (cls: string) => classes.has(cls)
        }
      };

      // At start (scrollLeft: 0) -> only can-scroll-right
      app.updateTagsBarScrollMask(mockBar);
      expect(classes.has("can-scroll-right")).toBe(true);
      expect(classes.has("can-scroll-left")).toBe(false);

      // Scrolled to middle (scrollLeft: 250) -> both
      mockBar.scrollLeft = 250;
      app.updateTagsBarScrollMask(mockBar);
      expect(classes.has("can-scroll-right")).toBe(true);
      expect(classes.has("can-scroll-left")).toBe(true);

      // Scrolled to end (scrollLeft: 500) -> only can-scroll-left
      mockBar.scrollLeft = 500;
      app.updateTagsBarScrollMask(mockBar);
      expect(classes.has("can-scroll-right")).toBe(false);
      expect(classes.has("can-scroll-left")).toBe(true);

      // No overflow (scrollWidth: 400 <= clientWidth: 500) -> neither
      mockBar.scrollWidth = 400;
      mockBar.scrollLeft = 0;
      app.updateTagsBarScrollMask(mockBar);
      expect(classes.has("can-scroll-right")).toBe(false);
      expect(classes.has("can-scroll-left")).toBe(false);
    });
  });
});




