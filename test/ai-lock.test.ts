import { expect, test, describe, beforeEach, afterEach } from "bun:test";

const app = require("../extension/app.js");

describe("AI Lock & Smart Local Deactivation (TDD)", () => {
  const cleanup = () => {
    app.activePerspectiveId = "domain";
    app.openRouterApiKey = "";
    app.aiAuthBlocked = false;
    app.isLocalSettingUpdate = false;
    app.isPerspectivesLoaded = false;
    app.currentPerspectives = typeof app.cloneDefaultPerspectives === "function"
      ? app.cloneDefaultPerspectives()
      : [{ id: "domain", name: "Domain", isSystem: true, labels: [] }];
  };

  beforeEach(cleanup);
  afterEach(cleanup);

  describe("isJevActive() State Helper", () => {
    test("returns false when no OpenRouter API key is configured", () => {
      app.openRouterApiKey = "";
      app.aiAuthBlocked = false;
      expect(app.isJevActive()).toBe(false);
    });

    test("returns false when aiAuthBlocked is true regardless of key", () => {
      app.openRouterApiKey = "sk-or-v1-valid-key";
      app.aiAuthBlocked = true;
      expect(app.isJevActive()).toBe(false);
    });

    test("returns true only when key is present and auth is not blocked", () => {
      app.openRouterApiKey = "sk-or-v1-valid-key";
      app.aiAuthBlocked = false;
      expect(app.isJevActive()).toBe(true);
    });
  });

  describe("Perspective Switching — Enforcing Domain Only When AI Inactive", () => {
    test("allows switching to domain perspective at all times", async () => {
      app.openRouterApiKey = "";
      app.aiAuthBlocked = false;
      await app.switchPerspective("domain");
      expect(app.activePerspectiveId).toBe("domain");
    });

    test("blocks switching to non-domain perspectives when Jev is inactive", async () => {
      app.openRouterApiKey = "";
      app.aiAuthBlocked = false;
      app.activePerspectiveId = "domain";

      // Attempt to switch to custom perspective 'topic'
      await app.switchPerspective("topic");
      // Must remain locked to domain
      expect(app.activePerspectiveId).toBe("domain");
    });

    test("permits switching to non-domain perspectives when Jev is active", async () => {
      app.openRouterApiKey = "sk-or-v1-valid-key";
      app.aiAuthBlocked = false;

      // Add dummy perspective to currentPerspectives if not present
      if (!app.currentPerspectives.some((p: any) => p.id === "topic")) {
        app.currentPerspectives.push({ id: "topic", name: "Topic", labels: [{ name: "Dev" }] });
      }

      await app.switchPerspective("topic");
      expect(app.activePerspectiveId).toBe("topic");
    });
  });

  describe("Classification Deactivation — Zero Smart Local Guesses When AI Inactive", () => {
    test("classifyTabs returns empty object and does not run heuristic classification when Jev inactive", async () => {
      app.openRouterApiKey = "";
      app.aiAuthBlocked = false;

      const tabs = [
        { id: 1, title: "Getting the most out of Opus 5.5", url: "https://youtube.com/watch?v=123" },
        { id: 2, title: "The Future Of Agent Memory | Google AI Studio", url: "https://aistudio.google.com" }
      ];
      const perspective = {
        id: "custom_p",
        labels: [
          { name: "League Of Legends", description: "" },
          { name: "Technology", description: "AI & Technology" },
          { name: "Khác", description: "" }
        ]
      };

      const result = await app.classifyTabs(tabs, perspective);
      // When Jev is inactive, custom labels must NEVER be populated by local heuristics
      expect(Object.keys(result).length).toBe(0);
    });

    test("classifyTabs does not run heuristic classification even for incognito tabs when Jev inactive", async () => {
      app.openRouterApiKey = "";
      app.aiAuthBlocked = false;

      const incognitoTabs = [
        { id: 99, title: "Google Cloud Console", url: "https://console.cloud.google.com", incognito: true }
      ];
      const perspective = {
        id: "topic",
        labels: [
          { name: "Dev & Code", description: "Developer tools and cloud platforms" },
          { name: "Khác", description: "" }
        ]
      };

      const result = await app.classifyTabs(incognitoTabs, perspective);
      expect(Object.keys(result).length).toBe(0);
    });
  });

  describe("Settings Loading & Dashboard State Synchronization", () => {
    test("loadPerspectiveSettings resets activePerspectiveId to domain if AI is inactive", async () => {
      app.openRouterApiKey = "";
      app.aiAuthBlocked = false;

      const originalChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        storage: {
          local: {
            get: async () => ({
              openRouterApiKey: "",
              activePerspectiveId: "topic",
              perspectives: [
                { id: "domain", name: "Domain", isSystem: true, labels: [] },
                { id: "topic", name: "Topic", labels: [{ name: "Dev" }] }
              ]
            }),
            set: async () => {}
          }
        }
      };

      try {
        await app.loadPerspectiveSettings(true);
        expect(app.activePerspectiveId).toBe("domain");
      } finally {
        (globalThis as any).chrome = originalChrome;
      }
    });

    test("renderStaticDashboard normalizes activePerspectiveId back to domain when Jev is inactive", async () => {
      app.openRouterApiKey = "";
      app.aiAuthBlocked = false;
      app.activePerspectiveId = "topic";
      if (!app.currentPerspectives.some((p: any) => p.id === "topic")) {
        app.currentPerspectives.push({ id: "topic", name: "Topic", labels: [{ name: "Work" }] });
      }

      // Mock minimal DOM for renderStaticDashboard
      const mockElements: Record<string, any> = {};
      const createElement = (id: string) => {
        const el: any = {
          id, style: {}, textContent: "", children: [],
          set innerHTML(val: string) { this.children = val ? [{ text: val }] : []; },
          get innerHTML() { return ""; },
          querySelectorAll: () => [], querySelector: () => null
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

      const origDoc = (globalThis as any).document;
      (globalThis as any).document = {
        hidden: false,
        getElementById: (id: string) => mockElements[id] || null,
        querySelector: () => null,
        querySelectorAll: () => []
      };

      try {
        await app.renderStaticDashboard({ inMemoryOnly: true });
        expect(app.activePerspectiveId).toBe("domain");
      } finally {
        (globalThis as any).document = origDoc;
      }
    });
  });

  describe("Perspective Rail UI & Accessibility Locking", () => {
    test("marks non-domain perspective tabs as locked and aria-disabled when Jev is inactive", () => {
      app.openRouterApiKey = "";
      app.aiAuthBlocked = false;
      app.currentPerspectives = [
        { id: "domain", name: "Domain", isSystem: true, labels: [] },
        { id: "topic", name: "Topic", labels: [{ name: "Dev" }] }
      ];

      let innerHTMLContent = "";
      const listEl: any = {
        querySelectorAll: () => [],
        set innerHTML(val: string) { innerHTMLContent = val; },
        get innerHTML() { return innerHTMLContent; }
      };

      const origDoc = (globalThis as any).document;
      (globalThis as any).document = {
        getElementById: (id: string) => (id === "perspectiveList" ? listEl : null),
        querySelector: () => null,
        querySelectorAll: () => []
      };

      try {
        app.renderPerspectiveRail([]);
        expect(innerHTMLContent).toContain('data-perspective-id="domain"');
        expect(innerHTMLContent).toContain('data-perspective-id="topic"');

        // Extract the domain div tag
        const domainMatch = innerHTMLContent.match(/<div[^>]*data-perspective-id="domain"[^>]*>/);
        expect(domainMatch).not.toBeNull();
        expect(domainMatch![0]).toContain('aria-disabled="false"');
        expect(domainMatch![0]).not.toContain('locked');

        // Extract the topic div tag
        const topicMatch = innerHTMLContent.match(/<div[^>]*data-perspective-id="topic"[^>]*>/);
        expect(topicMatch).not.toBeNull();
        expect(topicMatch![0]).toContain('locked');
        expect(topicMatch![0]).toContain('aria-disabled="true"');
      } finally {
        (globalThis as any).document = origDoc;
      }
    });

    test("unmarks locked status and sets aria-disabled to false when Jev is active", () => {
      app.openRouterApiKey = "sk-or-v1-valid-key";
      app.aiAuthBlocked = false;
      app.currentPerspectives = [
        { id: "domain", name: "Domain", isSystem: true, labels: [] },
        { id: "topic", name: "Topic", labels: [{ name: "Dev" }] }
      ];

      let innerHTMLContent = "";
      const listEl: any = {
        querySelectorAll: () => [],
        set innerHTML(val: string) { innerHTMLContent = val; },
        get innerHTML() { return innerHTMLContent; }
      };

      const origDoc = (globalThis as any).document;
      (globalThis as any).document = {
        getElementById: (id: string) => (id === "perspectiveList" ? listEl : null),
        querySelector: () => null,
        querySelectorAll: () => []
      };

      try {
        app.renderPerspectiveRail([]);
        expect(innerHTMLContent).toContain('data-perspective-id="topic"');

        const topicMatch = innerHTMLContent.match(/<div[^>]*data-perspective-id="topic"[^>]*>/);
        expect(topicMatch).not.toBeNull();
        expect(topicMatch![0]).not.toContain('locked');
        expect(topicMatch![0]).toContain('aria-disabled="false"');
      } finally {
        (globalThis as any).document = origDoc;
      }
    });
  });
});

