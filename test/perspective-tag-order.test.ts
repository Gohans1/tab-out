import { expect, test, describe } from "bun:test";

const app = require("../extension/app.js");
const {
  sortGroupsByPerspectiveLabels,
  renderPerspectiveTagsBar,
  normalizeLabels,
  getPerspectiveDisplayLabels
} = app;

describe("Perspective Tag & Category Order (TDD)", () => {
  describe("sortGroupsByPerspectiveLabels", () => {
    test("sorts category cards strictly by the order defined in perspective labels, NOT by tab count", () => {
      const labels = [
        { name: "Priority High", description: "Urgent items", color: "rose" },
        { name: "Priority Medium", description: "Important items", color: "amber" },
        { name: "Priority Low", description: "Backlog items", color: "blue" },
        { name: "Khác", description: "", color: "" }
      ];

      // Medium has 10 tabs, Low has 5 tabs, High has 1 tab
      const mockGroups = [
        { label: "Priority Low", domain: "perspective:Priority Low", isSemantic: true, tabs: [{}, {}, {}, {}, {}] },
        { label: "Priority Medium", domain: "perspective:Priority Medium", isSemantic: true, tabs: [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}] },
        { label: "Priority High", domain: "perspective:Priority High", isSemantic: true, tabs: [{}] }
      ];

      const sorted = sortGroupsByPerspectiveLabels(mockGroups, labels);

      // Must be ordered High (index 0) -> Medium (index 1) -> Low (index 2)
      expect(sorted.map((g: any) => g.label)).toEqual([
        "Priority High",
        "Priority Medium",
        "Priority Low"
      ]);
    });

    test("places fallback labels ('Khác', 'Other') always at the end regardless of tab count", () => {
      const labels = [
        { name: "Work", description: "Job tabs", color: "blue" },
        { name: "Personal", description: "Personal tabs", color: "emerald" },
        { name: "Khác", description: "", color: "" }
      ];

      const mockGroups = [
        { label: "Khác", domain: "perspective:Khác", isSemantic: true, tabs: [{}, {}, {}, {}, {}] }, // 5 tabs
        { label: "Personal", domain: "perspective:Personal", isSemantic: true, tabs: [{}] }, // 1 tab
        { label: "Work", domain: "perspective:Work", isSemantic: true, tabs: [{}, {}] } // 2 tabs
      ];

      const sorted = sortGroupsByPerspectiveLabels(mockGroups, labels);

      expect(sorted.map((g: any) => g.label)).toEqual([
        "Work",
        "Personal",
        "Khác"
      ]);
    });

    test("places any active categories not in labels after configured labels and before fallback", () => {
      const labels = [
        { name: "Frontend", description: "UI work", color: "cyan" },
        { name: "Backend", description: "API work", color: "purple" },
        { name: "Khác", description: "", color: "" }
      ];

      const mockGroups = [
        { label: "Khác", domain: "perspective:Khác", isSemantic: true, tabs: [{}] },
        { label: "Unknown Category", domain: "perspective:Unknown", isSemantic: true, tabs: [{}, {}] },
        { label: "Backend", domain: "perspective:Backend", isSemantic: true, tabs: [{}] },
        { label: "Frontend", domain: "perspective:Frontend", isSemantic: true, tabs: [{}] }
      ];

      const sorted = sortGroupsByPerspectiveLabels(mockGroups, labels);

      expect(sorted.map((g: any) => g.label)).toEqual([
        "Frontend",
        "Backend",
        "Unknown Category",
        "Khác"
      ]);
    });

    test("handles case-insensitive and trimmed label matching", () => {
      const labels = [
        { name: "Dev & Code", description: "", color: "emerald" },
        { name: "Docs & Research", description: "", color: "blue" }
      ];

      const mockGroups = [
        { label: "  docs & research  ", domain: "perspective:docs", isSemantic: true, tabs: [{}] },
        { label: "dev & code", domain: "perspective:dev", isSemantic: true, tabs: [{}] }
      ];

      const sorted = sortGroupsByPerspectiveLabels(mockGroups, labels);

      expect(sorted[0].label.trim().toLowerCase()).toBe("dev & code");
      expect(sorted[1].label.trim().toLowerCase()).toBe("docs & research");
    });

    test("safely handles null or non-array inputs without throwing", () => {
      expect(sortGroupsByPerspectiveLabels(null as any, null as any)).toEqual([]);
      expect(sortGroupsByPerspectiveLabels(undefined as any, [] as any)).toEqual([]);
      expect(sortGroupsByPerspectiveLabels([], [])).toEqual([]);
    });

    test("preserves first occurrence index when duplicate label names exist in perspective", () => {
      const labels = [
        { name: "First Priority", description: "", color: "rose" },
        { name: "Second Priority", description: "", color: "blue" },
        { name: "first priority", description: "duplicate", color: "gray" }
      ];

      const mockGroups = [
        { label: "Second Priority", domain: "perspective:2", isSemantic: true, tabs: [{}] },
        { label: "First Priority", domain: "perspective:1", isSemantic: true, tabs: [{}] }
      ];

      const sorted = sortGroupsByPerspectiveLabels(mockGroups, labels);
      expect(sorted.map((g: any) => g.label)).toEqual(["First Priority", "Second Priority"]);
    });
  });

  describe("renderPerspectiveTagsBar — Pill Ordering", () => {
    test("renders all pills in the exact order set in perspective labels, maintaining position", () => {
      // Setup DOM mock for tags bar
      let renderedHtml = "";
      let barDisplay = "none";
      const dummyBar = {
        style: {
          get display() { return barDisplay; },
          set display(v: string) { barDisplay = v; }
        },
        get innerHTML() { return renderedHtml; },
        set innerHTML(v: string) { renderedHtml = v; },
        querySelectorAll: (sel: string) => {
          if (sel === ".perspective-tag-pill") {
            const matches: any[] = [];
            const regex = /class="([^"]*perspective-tag-pill[^"]*)"[^>]*data-target-tag="([^"]*)"/g;
            let m;
            while ((m = regex.exec(renderedHtml)) !== null) {
              matches.push({
                className: m[1],
                targetTag: m[2],
                isActive: m[1].includes("is-active"),
                isEmpty: m[1].includes("is-empty")
              });
            }
            return matches;
          }
          return [];
        }
      };

      const origT = (globalThis as any).t;
      const origI18n = (globalThis as any).TabOutI18n;
      delete (globalThis as any).t;
      delete (globalThis as any).TabOutI18n;

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
        app.showEmptyCategoryTags = true;
        app.currentPerspectives = [
          { id: "domain", name: "Domain", isSystem: true },
          {
            id: "custom_p",
            name: "Custom Workflow",
            labels: [
              { name: "Step 1: Triage", description: "Inbox", color: "rose" },
              { name: "Step 2: Investigation", description: "Debugging", color: "amber" },
              { name: "Step 3: Fix & Test", description: "Coding", color: "emerald" },
              { name: "Step 4: Review", description: "PR", color: "blue" },
              { name: "Khác", description: "", color: "" }
            ]
          }
        ];

        // Only Step 1 and Step 3 have tabs; Step 3 has more tabs than Step 1
        const mockGroups = [
          { label: "Step 3: Fix & Test", domain: "perspective:s3", isSemantic: true, tabs: [{}, {}, {}, {}] }, // 4 tabs
          { label: "Step 1: Triage", domain: "perspective:s1", isSemantic: true, tabs: [{}] } // 1 tab
        ];

        renderPerspectiveTagsBar(mockGroups);

        expect(barDisplay).toBe("flex");
        // Active tags first (Step 1 -> Step 3), then empty tags in user order (Step 2 -> Step 4 -> Khác)
        const step1Idx = renderedHtml.indexOf("Step 1: Triage");
        const step2Idx = renderedHtml.indexOf("Step 2: Investigation");
        const step3Idx = renderedHtml.indexOf("Step 3: Fix &amp; Test");
        const step4Idx = renderedHtml.indexOf("Step 4: Review");
        const khacIdx = renderedHtml.indexOf("Khác");

        expect(step1Idx).toBeGreaterThan(-1);
        expect(step2Idx).toBeGreaterThan(-1);
        expect(step3Idx).toBeGreaterThan(-1);
        expect(step4Idx).toBeGreaterThan(-1);
        expect(khacIdx).toBeGreaterThan(-1);

        // Strict order verification: 1 -> 3 -> 2 -> 4 -> Khác
        expect(step1Idx).toBeLessThan(step3Idx);
        expect(step3Idx).toBeLessThan(step2Idx);
        expect(step2Idx).toBeLessThan(step4Idx);
        expect(step4Idx).toBeLessThan(khacIdx);

        // Verify active pills have active class and empty pills have empty class
        expect(renderedHtml).toContain('data-target-tag="Step 1: Triage"');
        expect(renderedHtml).toContain('data-target-tag="Step 3: Fix &amp; Test"');
      } finally {
        app.activePerspectiveId = origActivePid;
        app.currentPerspectives = origPerspectives;
        app.openRouterApiKey = origKey;
        app.showEmptyCategoryTags = false;
        delete (globalThis as any).document;
        if (origT !== undefined) (globalThis as any).t = origT;
        else delete (globalThis as any).t;
        if (origI18n !== undefined) (globalThis as any).TabOutI18n = origI18n;
        else delete (globalThis as any).TabOutI18n;
        if (typeof app.resetRenderCache === "function") app.resetRenderCache();
      }
    });

    test("when empty tags are expanded, tags with open tabs come first in user order, then empty tags in user order", () => {
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
        app.showEmptyCategoryTags = true; // user clicked "+ N more"
        app.currentPerspectives = [
          {
            id: "custom_p",
            name: "Custom Workflow",
            labels: [
              { name: "Work", description: "", color: "blue" },
              { name: "Study", description: "", color: "amber" },
              { name: "Dev", description: "", color: "emerald" },
              { name: "News", description: "", color: "amber" },
              { name: "Social", description: "", color: "blue" },
              { name: "Khác", description: "", color: "" }
            ]
          }
        ];

        // Only Dev and Social have tabs (Social has more)
        const mockGroups = [
          { label: "Social", domain: "perspective:social", isSemantic: true, tabs: [{}, {}, {}] },
          { label: "Dev", domain: "perspective:dev", isSemantic: true, tabs: [{}] }
        ];

        renderPerspectiveTagsBar(mockGroups);

        const order = [...renderedHtml.matchAll(/data-target-tag="([^"]*)"/g)].map(m => m[1]);
        expect(order).toEqual(["Dev", "Social", "Work", "Study", "News", "Khác"]);
      } finally {
        app.activePerspectiveId = origActivePid;
        app.currentPerspectives = origPerspectives;
        app.openRouterApiKey = origKey;
        app.showEmptyCategoryTags = false;
        delete (globalThis as any).document;
        if (typeof app.resetRenderCache === "function") app.resetRenderCache();
      }
    });

    test("correctly matches case-insensitive category names in count lookup", () => {
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
        app.currentPerspectives = [
          {
            id: "custom_p",
            name: "Custom Workflow",
            labels: [
              { name: "Dev & Code", description: "", color: "emerald" },
              { name: "Khác", description: "", color: "" }
            ]
          }
        ];

        // Group has lowercase "dev & code" with 3 tabs
        const mockGroups = [
          { label: "  dev & code  ", domain: "perspective:dev", isSemantic: true, tabs: [{}, {}, {}] }
        ];

        renderPerspectiveTagsBar(mockGroups);

        expect(renderedHtml).toContain('data-target-tag="Dev &amp; Code"');
        expect(renderedHtml).toContain('is-active');
        expect(renderedHtml).toContain('<span class="pill-count">3</span>');
      } finally {
        app.activePerspectiveId = origActivePid;
        app.currentPerspectives = origPerspectives;
        app.openRouterApiKey = origKey;
        delete (globalThis as any).document;
        if (typeof app.resetRenderCache === "function") app.resetRenderCache();
      }
    });

    test("positions unconfigured active categories between configured labels and fallback Khác in tags bar", () => {
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
        app.currentPerspectives = [
          {
            id: "custom_p",
            name: "Custom Workflow",
            labels: [
              { name: "Configured Alpha", description: "", color: "rose" },
              { name: "Configured Beta", description: "", color: "blue" },
              { name: "Khác", description: "", color: "" }
            ]
          }
        ];

        // Active groups: Configured Alpha (1 tab), Configured Beta (1 tab), Unconfigured Active (5 tabs), Khác (2 tabs)
        const mockGroups = [
          { label: "Configured Alpha", domain: "perspective:alpha", isSemantic: true, tabs: [{}] },
          { label: "Khác", domain: "perspective:khac", isSemantic: true, tabs: [{}, {}] },
          { label: "Unconfigured Active", domain: "perspective:unconf", isSemantic: true, tabs: [{}, {}, {}, {}, {}] },
          { label: "Configured Beta", domain: "perspective:beta", isSemantic: true, tabs: [{}] }
        ];

        renderPerspectiveTagsBar(mockGroups);

        const alphaIdx = renderedHtml.indexOf("Configured Alpha");
        const betaIdx = renderedHtml.indexOf("Configured Beta");
        const unconfIdx = renderedHtml.indexOf("Unconfigured Active");
        const khacIdx = renderedHtml.indexOf("Khác");

        expect(alphaIdx).toBeGreaterThan(-1);
        expect(betaIdx).toBeGreaterThan(-1);
        expect(unconfIdx).toBeGreaterThan(-1);
        expect(khacIdx).toBeGreaterThan(-1);

        // Alpha -> Beta -> Unconfigured Active -> Khác
        expect(alphaIdx).toBeLessThan(betaIdx);
        expect(betaIdx).toBeLessThan(unconfIdx);
        expect(unconfIdx).toBeLessThan(khacIdx);
      } finally {
        app.activePerspectiveId = origActivePid;
        app.currentPerspectives = origPerspectives;
        app.openRouterApiKey = origKey;
        delete (globalThis as any).document;
        if (typeof app.resetRenderCache === "function") app.resetRenderCache();
      }
    });
  });

  describe("renderPerspectiveTagsBar — Active vs Empty Distinction", () => {
    const labels = [
      { name: "Work", description: "", color: "blue" },
      { name: "Dev", description: "", color: "emerald" },
      { name: "News", description: "", color: "amber" },
      { name: "Social", description: "", color: "blue" },
      { name: "Khác", description: "", color: "" }
    ];
    // Only Dev and Social have tabs
    const groups = [
      { label: "Social", domain: "perspective:social", isSemantic: true, tabs: [{}, {}, {}] },
      { label: "Dev", domain: "perspective:dev", isSemantic: true, tabs: [{}] }
    ];

    function renderBar(showEmpty: boolean): string {
      let html = "";
      const bar = {
        style: { display: "none" },
        get innerHTML() { return html; },
        set innerHTML(v: string) { html = v; }
      };
      (globalThis as any).document = {
        getElementById: (id: string) => (id === "perspectiveTagsBar" ? bar : null),
        querySelector: () => null,
        querySelectorAll: () => []
      };
      const orig = {
        pid: app.activePerspectiveId,
        ps: app.currentPerspectives,
        key: app.openRouterApiKey,
        filter: app.activeCategoryFilter
      };
      try {
        app.activePerspectiveId = "custom_p";
        app.openRouterApiKey = "mock-key";
        app.activeCategoryFilter = null;
        app.showEmptyCategoryTags = showEmpty;
        app.currentPerspectives = [{ id: "custom_p", name: "Custom", labels }];
        renderPerspectiveTagsBar(groups);
        return html;
      } finally {
        app.activePerspectiveId = orig.pid;
        app.currentPerspectives = orig.ps;
        app.openRouterApiKey = orig.key;
        app.activeCategoryFilter = orig.filter;
        app.showEmptyCategoryTags = false;
        delete (globalThis as any).document;
        if (typeof app.resetRenderCache === "function") app.resetRenderCache();
      }
    }

    function pillHtml(html: string, tag: string): string {
      const start = html.indexOf(`data-target-tag="${tag}"`);
      expect(start).toBeGreaterThan(-1);
      return html.slice(start, html.indexOf("</button>", start));
    }

    test("when expanded, renders exactly one divider between the last tag with tabs and the first empty tag", () => {
      const html = renderBar(true);

      const dividers = html.match(/class="perspective-tag-sep"/g) || [];
      expect(dividers.length).toBe(1);

      const dividerIdx = html.indexOf('class="perspective-tag-sep"');
      expect(dividerIdx).toBeGreaterThan(html.indexOf('data-target-tag="Social"'));
      expect(dividerIdx).toBeLessThan(html.indexOf('data-target-tag="Work"'));
    });

    test("divider is hidden from assistive technology", () => {
      const html = renderBar(true);
      expect(html).toContain('<span class="perspective-tag-sep" aria-hidden="true"></span>');
    });

    test("when collapsed (no empty tags shown), renders no divider", () => {
      const html = renderBar(false);
      expect(html).not.toContain("perspective-tag-sep");
    });

    test("empty tags render without a count badge, tags with tabs keep theirs", () => {
      const html = renderBar(true);
      expect(pillHtml(html, "Work")).not.toContain("pill-count");
      expect(pillHtml(html, "Social")).toContain('<span class="pill-count">3</span>');
    });
  });

  describe("Integration: Modal Reordering & Dashboard Card Sequence", () => {
    test("when user reorders tags in modal, saved perspective labels reflect new order and sort cards accordingly", () => {
      // Simulate tags as defined by user in modal rows after dragging
      const reorderedRows = [
        { name: "Documentation", desc: "Reading docs", color: "blue" },
        { name: "Bugfix", desc: "Urgent fix", color: "rose" },
        { name: "Feature", desc: "New feature", color: "emerald" }
      ];

      const labels = [
        ...reorderedRows.map(r => ({ name: r.name, description: r.desc, color: r.color })),
        { name: "Khác", description: "", color: "" }
      ];

      // Simulate open tabs classified into these tags: Feature (8 tabs), Documentation (2 tabs), Bugfix (4 tabs)
      const semMap: Record<string, any> = {
        "Feature": { label: "Feature", domain: "perspective:Feature", isSemantic: true, tabs: Array(8).fill({}) },
        "Documentation": { label: "Documentation", domain: "perspective:Documentation", isSemantic: true, tabs: Array(2).fill({}) },
        "Bugfix": { label: "Bugfix", domain: "perspective:Bugfix", isSemantic: true, tabs: Array(4).fill({}) }
      };

      const sortedCards = sortGroupsByPerspectiveLabels(Object.values(semMap), labels);

      // Verify that cards follow user's set order: Documentation -> Bugfix -> Feature (NOT Feature -> Bugfix -> Documentation)
      expect(sortedCards[0].label).toBe("Documentation");
      expect(sortedCards[1].label).toBe("Bugfix");
      expect(sortedCards[2].label).toBe("Feature");
    });
  });

  describe("Language Switching & Tag Order Preservation (Bug Reproduction & Verification)", () => {
    test("sortGroupsByPerspectiveLabels sorts cards in tag order even when groups have Vietnamese labels and labels are English", () => {
      // Like in user's screenshot: activeLabels are English topic template labels:
      // Index 3: AI & Assistants, Index 5: Social Media, Index 6: Media & Entertainment
      const enLabels = [
        { name: "Work & Productivity", description: "", color: "blue" },
        { name: "Education & Study", description: "", color: "amber" },
        { name: "Development", description: "", color: "emerald" },
        { name: "AI & Assistants", description: "", color: "purple" },
        { name: "News & Reading", description: "", color: "amber" },
        { name: "Social Media", description: "", color: "blue" },
        { name: "Media & Entertainment", description: "", color: "rose" },
        { name: "Other", description: "", color: "" }
      ];

      // Groups from cache/classification with Vietnamese labels (like in media_1790362128025.png):
      // "Mạng xã hội" has 4 tabs, "Giải trí / Media" has 2 tabs, "AI & Trợ lý ảo" has 2 tabs
      const mockGroups = [
        { label: "Mạng xã hội", domain: "perspective:Mạng xã hội", isSemantic: true, tabs: [{}, {}, {}, {}] }, // 4 tabs
        { label: "Giải trí / Media", domain: "perspective:Giải trí / Media", isSemantic: true, tabs: [{}, {}] }, // 2 tabs
        { label: "AI & Trợ lý ảo", domain: "perspective:AI & Trợ lý ảo", isSemantic: true, tabs: [{}, {}] } // 2 tabs
      ];

      const sorted = sortGroupsByPerspectiveLabels(mockGroups, enLabels);

      // In the tag list:
      // AI & Assistants (idx 3) comes BEFORE Social Media (idx 5) which comes BEFORE Media & Entertainment (idx 6)
      // Must NOT be sorted by tab count (4 tabs first)!
      expect(sorted[0].label).toBe("AI & Trợ lý ảo");
      expect(sorted[1].label).toBe("Mạng xã hội");
      expect(sorted[2].label).toBe("Giải trí / Media");
    });

    test("sortGroupsByPerspectiveLabels sorts cards in tag order when groups have English labels and labels are Vietnamese", () => {
      const viLabels = [
        { name: "Công việc & Năng suất", description: "", color: "blue" },
        { name: "Giáo dục & Học tập", description: "", color: "amber" },
        { name: "Lập trình / Dev", description: "", color: "emerald" },
        { name: "AI & Trợ lý ảo", description: "", color: "purple" },
        { name: "Tin tức & Đọc báo", description: "", color: "amber" },
        { name: "Mạng xã hội", description: "", color: "blue" },
        { name: "Giải trí / Media", description: "", color: "rose" },
        { name: "Khác", description: "", color: "" }
      ];

      const mockGroups = [
        { label: "Social Media", domain: "perspective:Social Media", isSemantic: true, tabs: [{}, {}, {}, {}] }, // 4 tabs
        { label: "Media & Entertainment", domain: "perspective:Media & Entertainment", isSemantic: true, tabs: [{}, {}] },
        { label: "AI & Assistants", domain: "perspective:AI & Assistants", isSemantic: true, tabs: [{}, {}] }
      ];

      const sorted = sortGroupsByPerspectiveLabels(mockGroups, viLabels);

      expect(sorted[0].label).toBe("AI & Assistants");
      expect(sorted[1].label).toBe("Social Media");
      expect(sorted[2].label).toBe("Media & Entertainment");
    });

    test("getPerspectiveDisplayLabels preserves custom user-arranged tag order across language switches", () => {
      // User rearranged topic template tags in Vietnamese:
      // User placed "Mạng xã hội" first, then "AI & Trợ lý ảo", then "Công việc & Năng suất"
      const p = {
        id: "topic",
        templateId: "topic",
        name: "Topic",
        labels: [
          { name: "Mạng xã hội", description: "Bảng tin xã hội", color: "blue" },
          { name: "AI & Trợ lý ảo", description: "Trợ lý AI", color: "purple" },
          { name: "Công việc & Năng suất", description: "Ứng dụng văn phòng", color: "blue" },
          { name: "Khác", description: "", color: "" }
        ]
      };

      // When switching language to English:
      const enLabels = getPerspectiveDisplayLabels(p, "en");

      // The returned array MUST preserve the user's arranged sequence:
      // 0: Social Media, 1: AI & Assistants, 2: Work & Productivity, 3: Other
      expect(enLabels.map((l: any) => l.name)).toEqual([
        "Social Media",
        "AI & Assistants",
        "Work & Productivity",
        "Other"
      ]);
    });

    test("renderStaticDashboard groups cached Vietnamese labels into active English display labels and orders cards by tag order", async () => {
      // Mock minimal DOM
      const mockElements: Record<string, any> = {};
      const createElement = (id: string) => {
        const el: any = {
          id, style: {}, textContent: "", children: [],
          set innerHTML(val: string) { this._innerHTML = val; this.children = val ? [{ text: val }] : []; },
          get innerHTML() { return this._innerHTML || ""; },
          querySelectorAll: () => [], querySelector: () => null,
          setAttribute: () => {}, dataset: {}
        };
        mockElements[id] = el;
        return el;
      };
      createElement("greeting");
      createElement("dateDisplay");
      createElement("heroSubtitle");
      createElement("perspectiveTagsBar");
      createElement("perspectiveList");
      createElement("openTabsMissions");
      createElement("openTabsHeaderActions");
      createElement("openTabsSection");
      createElement("openTabsSectionTitle");
      createElement("openTabsSectionCount");

      const origDoc = (globalThis as any).document;
      const origChrome = (globalThis as any).chrome;
      const origT = (globalThis as any).t;
      const origI18n = (globalThis as any).TabOutI18n;

      (globalThis as any).document = {
        hidden: false,
        getElementById: (id: string) => mockElements[id] || null,
        querySelector: () => null,
        querySelectorAll: () => []
      };

      const origActivePid = app.activePerspectiveId;
      const origPerspectives = app.currentPerspectives;
      const origKey = app.openRouterApiKey;
      const origCache = app.tabClassificationCache;
      const origFilter = app.activeCategoryFilter;

      try {
        app.activePerspectiveId = "topic";
        app.activeCategoryFilter = null;
        app.openRouterApiKey = "mock-api-key";
        const viTopicTpl = app.getPerspectiveTemplate("topic", "vi");
        app.currentPerspectives = [
          { id: "domain", name: "Domain", isSystem: true },
          { id: "topic", templateId: "topic", name: "Topic", labels: viTopicTpl.labels }
        ];

        // Active locale is English
        (globalThis as any).TabOutI18n = {
          getLanguage: () => "en",
          t: (k: string) => k
        };
        (globalThis as any).t = (k: string) => k;

        // Tabs cached in Vietnamese (media_1790362128025.png situation)
        app.tabClassificationCache = {
          topic: {
            "https://facebook.com/1": { label: "Mạng xã hội", source: "ai" },
            "https://facebook.com/2": { label: "Mạng xã hội", source: "ai" },
            "https://instagram.com/1": { label: "Mạng xã hội", source: "ai" },
            "https://x.com/home": { label: "Mạng xã hội", source: "ai" },
            "https://youtube.com/watch1": { label: "Giải trí / Media", source: "ai" },
            "https://youtube.com/watch2": { label: "Giải trí / Media", source: "ai" },
            "https://claude.ai/chat": { label: "AI & Trợ lý ảo", source: "ai" },
            "https://chatgpt.com/": { label: "AI & Trợ lý ảo", source: "ai" }
          }
        };

        (globalThis as any).chrome = {
          ...(origChrome || {}),
          runtime: {
            id: "test-extension-id",
            getURL: (p: string) => `chrome-extension://test-extension-id/${p}`
          },
          tabs: {
            query: async () => [
              { id: 1, url: "https://facebook.com/1", title: "Facebook 1", incognito: false },
              { id: 2, url: "https://facebook.com/2", title: "Facebook 2", incognito: false },
              { id: 3, url: "https://instagram.com/1", title: "Instagram", incognito: false },
              { id: 4, url: "https://x.com/home", title: "X", incognito: false },
              { id: 5, url: "https://youtube.com/watch1", title: "YouTube 1", incognito: false },
              { id: 6, url: "https://youtube.com/watch2", title: "YouTube 2", incognito: false },
              { id: 7, url: "https://claude.ai/chat", title: "Claude", incognito: false },
              { id: 8, url: "https://chatgpt.com/", title: "ChatGPT", incognito: false }
            ]
          }
        };

        if (typeof app.resetRenderCache === "function") app.resetRenderCache();
        await app.renderStaticDashboard();

        // Verify that cards follow tag order in English:
        // Tag #4: AI & Assistants, Tag #6: Social Media, Tag #7: Media & Entertainment
        const renderedGroups = app.domainGroups;
        expect(renderedGroups.map((g: any) => g.label)).toEqual([
          "AI & Assistants",
          "Social Media",
          "Media & Entertainment"
        ]);
      } finally {
        app.activePerspectiveId = origActivePid;
        app.currentPerspectives = origPerspectives;
        app.openRouterApiKey = origKey;
        app.tabClassificationCache = origCache;
        app.activeCategoryFilter = origFilter;
        (globalThis as any).document = origDoc;
        (globalThis as any).chrome = origChrome;
        (globalThis as any).t = origT;
        (globalThis as any).TabOutI18n = origI18n;
        if (typeof app.resetRenderCache === "function") app.resetRenderCache();
      }
    });
  });

  describe("renderDomainCard - tag color localization (TDD)", () => {
    const origActivePid = app.activePerspectiveId;
    const origPerspectives = app.currentPerspectives;
    const origI18n = (globalThis as any).TabOutI18n;

    test("renders tag color dot and data-tag-color when card label is Vietnamese and perspective labels are defined in English", () => {
      try {
        app.activePerspectiveId = "default_ai_workflow";
        app.currentPerspectives = [
          {
            id: "default_ai_workflow",
            name: "AI & Research",
            labels: [
              { name: "Coding & Dev", description: "Development", color: "blue" },
              { name: "Research & Reading", description: "Papers", color: "emerald" },
              { name: "Writing & Docs", description: "Documentation", color: "amber" },
              { name: "AI & Assistants", description: "AI tools", color: "purple" },
              { name: "Reference", description: "Docs", color: "cyan" },
              { name: "Khác", description: "Other", color: "" }
            ]
          }
        ];

        (globalThis as any).TabOutI18n = {
          getLanguage: () => "vi"
        };

        const group = {
          domain: "perspective:ai",
          label: "AI & Trợ lý ảo",
          isSemantic: true,
          tabs: [{ id: 1, url: "https://claude.ai", title: "Claude" }]
        };

        const cardHtml = app.renderDomainCard(group);

        expect(cardHtml).toContain('data-tag-color="purple"');
        expect(cardHtml).toContain('style="--tag-color: #a855f7;"');
        expect(cardHtml).toContain('<span class="card-tag-dot" style="background-color: #a855f7;" aria-hidden="true"></span>');
      } finally {
        app.activePerspectiveId = origActivePid;
        app.currentPerspectives = origPerspectives;
        if (origI18n !== undefined) (globalThis as any).TabOutI18n = origI18n;
        else delete (globalThis as any).TabOutI18n;
      }
    });

    test("renders tag color dot and data-tag-color when card label is English and matches perspective label", () => {
      try {
        app.activePerspectiveId = "default_ai_workflow";
        app.currentPerspectives = [
          {
            id: "default_ai_workflow",
            name: "AI & Research",
            labels: [
              { name: "AI & Assistants", description: "AI tools", color: "purple" },
              { name: "Khác", description: "Other", color: "" }
            ]
          }
        ];

        (globalThis as any).TabOutI18n = {
          getLanguage: () => "en"
        };

        const group = {
          domain: "perspective:ai",
          label: "AI & Assistants",
          isSemantic: true,
          tabs: [{ id: 1, url: "https://claude.ai", title: "Claude" }]
        };

        const cardHtml = app.renderDomainCard(group);

        expect(cardHtml).toContain('data-tag-color="purple"');
        expect(cardHtml).toContain('style="--tag-color: #a855f7;"');
        expect(cardHtml).toContain('<span class="card-tag-dot" style="background-color: #a855f7;" aria-hidden="true"></span>');
      } finally {
        app.activePerspectiveId = origActivePid;
        app.currentPerspectives = origPerspectives;
        if (origI18n !== undefined) (globalThis as any).TabOutI18n = origI18n;
        else delete (globalThis as any).TabOutI18n;
      }
    });

    test("does not render tag color or dot for fallback label (Khác / Other)", () => {
      try {
        app.activePerspectiveId = "default_ai_workflow";
        app.currentPerspectives = [
          {
            id: "default_ai_workflow",
            name: "AI & Research",
            labels: [
              { name: "AI & Assistants", description: "AI tools", color: "purple" },
              { name: "Khác", description: "Other", color: "" }
            ]
          }
        ];

        (globalThis as any).TabOutI18n = {
          getLanguage: () => "vi"
        };

        const group = {
          domain: "perspective:khac",
          label: "Khác",
          isSemantic: true,
          tabs: [{ id: 9, url: "https://unknown.org", title: "Unknown" }]
        };

        const cardHtml = app.renderDomainCard(group);

        expect(cardHtml).not.toContain('data-tag-color=');
        expect(cardHtml).not.toContain('card-tag-dot');
      } finally {
        app.activePerspectiveId = origActivePid;
        app.currentPerspectives = origPerspectives;
        if (origI18n !== undefined) (globalThis as any).TabOutI18n = origI18n;
        else delete (globalThis as any).TabOutI18n;
      }
    });

    test("renders tag color dot and data-tag-color for custom perspective with raw hex color", () => {
      try {
        app.activePerspectiveId = "custom_workflow";
        app.currentPerspectives = [
          {
            id: "custom_workflow",
            name: "My Workflow",
            labels: [
              { name: "Urgent Bug", description: "Hotfix", color: "#f43f5e" },
              { name: "Khác", description: "Other", color: "" }
            ]
          }
        ];

        const group = {
          domain: "perspective:urgent",
          label: "Urgent Bug",
          isSemantic: true,
          tabs: [{ id: 11, url: "https://bugtracker.com/123", title: "Bug 123" }]
        };

        const cardHtml = app.renderDomainCard(group);

        expect(cardHtml).toContain('data-tag-color="rose"');
        expect(cardHtml).toContain('style="--tag-color: #f43f5e;"');
        expect(cardHtml).toContain('<span class="card-tag-dot" style="background-color: #f43f5e;" aria-hidden="true"></span>');
      } finally {
        app.activePerspectiveId = origActivePid;
        app.currentPerspectives = origPerspectives;
      }
    });

    test("does not render tag color when activePerspectiveId is 'domain'", () => {
      try {
        app.activePerspectiveId = "domain";
        const group = {
          domain: "github.com",
          label: "GitHub",
          isSemantic: false,
          tabs: [{ id: 10, url: "https://github.com", title: "GitHub" }]
        };

        const cardHtml = app.renderDomainCard(group);

        expect(cardHtml).not.toContain('data-tag-color=');
        expect(cardHtml).not.toContain('card-tag-dot');
      } finally {
        app.activePerspectiveId = origActivePid;
        app.currentPerspectives = origPerspectives;
      }
    });
  });
});

