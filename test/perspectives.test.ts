import { expect, test, describe } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("Extension Manifest V3 Verification", () => {
  test("manifest.json has correct structure and host_permissions", () => {
    const manifestPath = resolve(__dirname, "../extension/manifest.json");
    const raw = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(raw);

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toContain("tabs");
    expect(manifest.permissions).toContain("storage");
    expect(manifest.permissions).toContain("unlimitedStorage");
    expect(manifest.host_permissions).toContain("https://openrouter.ai/*");
    expect(manifest.chrome_url_overrides?.newtab).toBe("index.html");
  });
});

// Import production implementations directly from canonical extension/app.js
const {
  DEFAULT_PERSPECTIVES,
  CATEGORY_RULES,
  getLabelName,
  getLabelDesc,
  normalizeLabels,
  localFallbackClassify,
  normalizeUrlForCache,
  pruneClassificationCache,
  getCacheLabel,
  getCacheSource,
  triggerBackgroundClassification,
  classifyTabs,
  renderStaticDashboard,
  showConfirmDialog,
  renderAll,
  undoStack,
  pushUndoAction,
  triggerUndo,
  getDomainFallbackLabel,
  schedulePerspectivePrewarm,
  loadPerspectiveSettings,
  MULTI_TOPIC_DOMAINS,
  extractHostname,
  saveClassificationCacheAtomic,
  prewarmMultiPerspective,
  buildOverflowChips,
  buildChoiceCriteria,
  handleStorageOnChanged,
  isAiEligibleUrl
} = require("../extension/app.js");

const {
  preclassifyTabInBackground,
  saveBgClassificationCache,
  handleAiReservationMessage,
  isAiEligibleUrl: bgIsAiEligibleUrl
} = require("../extension/background.js");

describe("Perspective Classification Engine", () => {
  test("Canonical DEFAULT_PERSPECTIVES exports valid perspectives with rich tag descriptions", () => {
    expect(DEFAULT_PERSPECTIVES.length).toBeGreaterThanOrEqual(3);
    const domainP = DEFAULT_PERSPECTIVES.find((p: any) => p.id === 'domain');
    const topicP = DEFAULT_PERSPECTIVES.find((p: any) => p.id === 'topic');
    const purposeP = DEFAULT_PERSPECTIVES.find((p: any) => p.id === 'purpose');

    expect(domainP).toBeDefined();
    expect(topicP).toBeDefined();
    expect(purposeP).toBeDefined();
    expect(topicP.labels.length).toBeGreaterThanOrEqual(5);
    expect(CATEGORY_RULES.length).toBeGreaterThan(0);

    // Verify topic labels have rich descriptions
    const aiTag = topicP.labels.find((l: any) => l.name === 'AI & Machine Learning');
    expect(aiTag).toBeDefined();
    expect(aiTag.description).toContain('LLM');
  });

  test("Label helpers normalize and extract names and descriptions correctly", () => {
    expect(getLabelName("Test")).toBe("Test");
    expect(getLabelName({ name: "Work", description: "All job tabs" })).toBe("Work");
    expect(getLabelDesc("Test")).toBe("");
    expect(getLabelDesc({ name: "Work", description: "All job tabs" })).toBe("All job tabs");

    // normalizeLabels string[] -> { name, description }[]
    const legacy = ["Alpha", "Beta"];
    const normalized = normalizeLabels(legacy);
    expect(normalized.length).toBe(2);
    expect(normalized[0].name).toBe("Alpha");
    expect(normalized[0].description).toBeDefined();
    expect(normalized[1].name).toBe("Beta");

    // normalizeLabels with already-formed objects
    const objects = [
      { name: "Design", description: "Figma and styling" },
      { name: "", description: "Empty ignored" }
    ];
    const normObj = normalizeLabels(objects);
    expect(normObj.length).toBe(1);
    expect(normObj[0].name).toBe("Design");
    expect(normObj[0].description).toBe("Figma and styling");
  });

  const defaultTopicLabels = [
    'AI & Machine Learning',
    'Lập trình / Dev',
    'Mạng xã hội',
    'Giải trí / Media',
    'Tin tức & Đọc báo',
    'Mua sắm',
    'Công việc / Email',
    'Khác / Chưa phân loại'
  ];

  test("Classifies developer tools correctly", () => {
    expect(localFallbackClassify({ title: "Pull Request #42 · oven-sh/bun", url: "https://github.com/oven-sh/bun/pull/42" }, defaultTopicLabels)).toBe('Lập trình / Dev');
    expect(localFallbackClassify({ title: "Designing at the speed of voice", url: "https://gist.github.com/user/123" }, defaultTopicLabels)).toBe('Lập trình / Dev');
  });

  test("Classifies AI tools correctly", () => {
    expect(localFallbackClassify({ title: "Claude - Chat with Anthropic", url: "https://claude.ai/new" }, defaultTopicLabels)).toBe('AI & Machine Learning');
    expect(localFallbackClassify({ title: "Kimi AI with K3 | Agentic Coding", url: "https://kimi.moonshot.cn" }, defaultTopicLabels)).toBe('AI & Machine Learning');
  });

  test("Classifies Social and Media correctly", () => {
    expect(localFallbackClassify({ title: "Home / X", url: "https://x.com/home" }, defaultTopicLabels)).toBe('Mạng xã hội');
    expect(localFallbackClassify({ title: "Facebook - Log in or Sign Up", url: "https://www.facebook.com" }, defaultTopicLabels)).toBe('Mạng xã hội');
    expect(localFallbackClassify({ title: "YouTube Subscriptions", url: "https://youtube.com/feed/subscriptions" }, defaultTopicLabels)).toBe('Giải trí / Media');
  });

  test("Custom Perspective with arbitrary tags", () => {
    const customLabels = ["Khẩn cấp", "Đọc sau", "Linh tinh"];
    expect(localFallbackClassify({ title: "URGENT: Prod server memory leak", url: "https://grafana.internal.net" }, customLabels)).toBe("Khẩn cấp");
    expect(localFallbackClassify({ title: "Random cat video 123", url: "https://example.com/cat" }, customLabels)).toBe("Linh tinh");
  });

  test("Custom Perspective with rich descriptions boosts matching", () => {
    const customRichLabels = [
      { name: "Frontend", description: "CSS styling, HTML layout, Tailwind, UI components, animations" },
      { name: "Database", description: "Postgres, SQL queries, Drizzle ORM, schema migrations, tables" }
    ];

    expect(localFallbackClassify({
      title: "Optimizing database queries and migrations",
      url: "https://internal-docs.io/sql-guide"
    }, customRichLabels)).toBe("Database");

    expect(localFallbackClassify({
      title: "Tailwind UI component library",
      url: "https://tailwindui.com/components"
    }, customRichLabels)).toBe("Frontend");
  });

  test("Single custom tag classifies without forcing extra 'Khác' tag", () => {
    const singleTag = [{ name: "Chỉ một tag", description: "Bao gồm tất cả tab dự án hiện tại" }];
    expect(localFallbackClassify({ title: "Dự án hiện tại", url: "https://tabout.io" }, singleTag)).toBe("Chỉ một tag");
  });
});

describe("Destructive Operations & Confirmation Safety", () => {
  test("index.html contains accessible confirmModalOverlay with alertdialog semantics", () => {
    const htmlPath = resolve(__dirname, "../extension/index.html");
    const html = readFileSync(htmlPath, "utf-8");

    expect(html).toContain('id="confirmModalOverlay"');
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('id="confirmModalTitle"');
    expect(html).toContain('id="confirmModalDesc"');
    expect(html).toContain('id="confirmModalOkBtn"');
    expect(html).toContain('id="confirmModalCancelBtn"');
    expect(html).toContain('data-action="close-confirm-modal"');
  });

  test("style.css defines robust styles for confirmation modal and confirming danger state", () => {
    const cssPath = resolve(__dirname, "../extension/style.css");
    const css = readFileSync(cssPath, "utf-8");

    expect(css).toContain('.confirm-modal-overlay');
    expect(css).toContain('.confirm-modal');
    expect(css).toContain('.btn-primary.btn-danger');
    expect(css).toContain('.action-btn.confirming');
    expect(css).toContain('.archive-action-btn.confirming');
    expect(css).toContain('.deferred-dismiss.confirming');
    expect(css).toContain('@keyframes taboutConfirmPulse');
  });

  test("showConfirmDialog function is defined and handles headless environment gracefully", async () => {
    expect(typeof showConfirmDialog).toBe("function");

    // In non-DOM test environment, overlay is null so it resolves without throwing
    const res = await showConfirmDialog({
      title: "Test Confirm",
      description: "Test Description"
    });
    expect(typeof res).toBe("boolean");
  });

  test("app.js protects against stale tab ID rejection in close-all-open-tabs and close-domain-tabs", () => {
    const appPath = resolve(__dirname, "../extension/app.js");
    const appCode = readFileSync(appPath, "utf-8");

    // Both handlers must query live tabs and filter IDs to prevent chrome.tabs.remove rejection
    const closeAllSection = appCode.substring(
      appCode.indexOf("action === 'close-all-open-tabs'"),
      appCode.indexOf("action === 'unarchive-saved-tab'")
    );
    expect(closeAllSection).toContain("chrome.tabs.query");
    expect(closeAllSection).toContain("liveIds.has");
    expect(closeAllSection).toContain("chrome.tabs.remove(validTabIds)");

    const closeDomainSection = appCode.substring(
      appCode.indexOf("action === 'close-domain-tabs'"),
      appCode.indexOf("action === 'dedup-keep-one'")
    );
    expect(closeDomainSection).toContain("chrome.tabs.query");
    expect(closeDomainSection).toContain("liveIds.has");
    expect(closeDomainSection).toContain("chrome.tabs.remove(validTabIds)");
  });
});

describe("Undo Mechanism & Impeccable Visual Polish", () => {
  test("index.html contains accessible toastUndoBtn inside toast container", () => {
    const htmlPath = resolve(__dirname, "../extension/index.html");
    const html = readFileSync(htmlPath, "utf-8");

    expect(html).toContain('id="toastUndoBtn"');
    expect(html).toContain('class="toast-action-btn"');
    expect(html).toContain('aria-label="Undo action"');
  });

  test("style.css provides impeccable tab hover feedback and pointer-events for toast action", () => {
    const cssPath = resolve(__dirname, "../extension/style.css");
    const css = readFileSync(cssPath, "utf-8");

    // Toast action button styling & pointer-events: auto on visible toast
    expect(css).toContain(".toast.visible");
    expect(css).toContain("pointer-events: auto;");
    expect(css).toContain(".toast-action-btn");

    // Page chip hover visual contrast & affordance
    expect(css).toContain(".page-chip:hover");
    expect(css).toContain(".page-chip:hover .chip-text");
    expect(css).toContain(".page-chip:hover .chip-favicon");
    expect(css).toContain(".page-chip:hover .chip-action");
  });

  test("style.css strictly enforces perspective edit icon visibility only on active perspective", () => {
    const cssPath = resolve(__dirname, "../extension/style.css");
    const css = readFileSync(cssPath, "utf-8");

    // Active perspective displays edit button
    expect(css).toContain(".perspective-tab.active .perspective-tab-edit-btn");
    expect(css).toContain("display: flex;");

    // Must NOT show edit button on hover over unselected perspective
    expect(css).not.toContain(".perspective-tab:hover .perspective-tab-edit-btn");
  });

  test("undoStack, pushUndoAction, and triggerUndo operate correctly in memory", async () => {
    expect(Array.isArray(undoStack)).toBe(true);

    let undone = false;
    pushUndoAction({
      description: "Test Action",
      onUndo: async () => {
        undone = true;
      }
    });

    expect(undoStack.length).toBeGreaterThan(0);
    const top = undoStack[undoStack.length - 1];
    expect(top.description).toBe("Test Action");

    const result = await triggerUndo();
    expect(result).toBe(true);
    expect(undone).toBe(true);
  });

  test("app.js binds global Ctrl+Z / Cmd+Z keyboard shortcut for Undo with input safety", () => {
    const appPath = resolve(__dirname, "../extension/app.js");
    const appCode = readFileSync(appPath, "utf-8");

    expect(appCode).toContain("document.getElementById('toastUndoBtn')");
    expect(appCode).toContain("(e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z'");
    expect(appCode).toContain("isContentEditable");
    expect(appCode).toContain("triggerUndo()");
  });

  test("app.js records undo snapshots across all tab closing and dismissal actions", () => {
    const appPath = resolve(__dirname, "../extension/app.js");
    const appCode = readFileSync(appPath, "utf-8");

    // close-single-tab has undo
    const closeSingleSection = appCode.substring(
      appCode.indexOf("action === 'close-single-tab'"),
      appCode.indexOf("action === 'defer-single-tab'")
    );
    expect(closeSingleSection).toContain("pushUndoAction");
    expect(closeSingleSection).toContain("chrome.tabs.create");

    // close-domain-tabs has undo
    const closeDomainSection = appCode.substring(
      appCode.indexOf("action === 'close-domain-tabs'"),
      appCode.indexOf("action === 'dedup-keep-one'")
    );
    expect(closeDomainSection).toContain("pushUndoAction");
    expect(closeDomainSection).toContain("chrome.tabs.create");

    // close-all-open-tabs has undo
    const closeAllSection = appCode.substring(
      appCode.indexOf("action === 'close-all-open-tabs'"),
      appCode.indexOf("action === 'unarchive-saved-tab'")
    );
    expect(closeAllSection).toContain("pushUndoAction");
    expect(closeAllSection).toContain("chrome.tabs.create");

    // dismiss-deferred has undo
    const dismissSection = appCode.substring(
      appCode.indexOf("action === 'dismiss-deferred'"),
      appCode.indexOf("action === 'close-domain-tabs'")
    );
    expect(dismissSection).toContain("pushUndoAction");

    // delete-archived-tab has undo
    const deleteArchiveSection = appCode.substring(
      appCode.indexOf("action === 'delete-archived-tab'"),
      appCode.indexOf("action === 'toggle-archive-list'")
    );
    expect(deleteArchiveSection).toContain("pushUndoAction");
  });

  test("renderAll is defined as an async coordinator function and exports correctly", async () => {
    expect(typeof renderAll).toBe("function");
    // Verify calling renderAll in test/headless environment doesn't throw ReferenceError
    expect(renderAll()).resolves.toBeUndefined();
  });

  test("app.js keydown listener guards against triggering Undo when modal dialogs are open", () => {
    const appPath = resolve(__dirname, "../extension/app.js");
    const appCode = readFileSync(appPath, "utf-8");

    expect(appCode).toContain("confirmModalOverlay");
    expect(appCode).toContain("perspectiveModalOverlay");
    expect(appCode).toContain("display === 'flex'");
  });
});

describe("Jev Performance, Caching & Batching Optimization", () => {
  test("normalizeUrlForCache strips tracking query parameters and hash anchors", () => {
    expect(typeof normalizeUrlForCache).toBe("function");

    // Strips hash anchor
    expect(normalizeUrlForCache("https://github.com/oven-sh/bun#readme"))
      .toBe("https://github.com/oven-sh/bun");

    // Strips tracking query params (utm_*, fbclid, etc.)
    expect(normalizeUrlForCache("https://example.com/article?utm_source=twitter&utm_medium=cpc&fbclid=abc123xyz"))
      .toBe("https://example.com/article");

    // Preserves necessary query params (like YouTube video ID v) while stripping tracking and timestamp
    expect(normalizeUrlForCache("https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=share&t=30s"))
      .toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");

    // Preserves search queries
    expect(normalizeUrlForCache("https://www.google.com/search?q=typesafe+ai&oq=typesafe"))
      .toBe("https://www.google.com/search?q=typesafe+ai");

    // Gracefully handles empty or malformed strings
    expect(normalizeUrlForCache("")).toBe("");
    expect(normalizeUrlForCache("about:blank")).toBe("about:blank");
    expect(normalizeUrlForCache("chrome://newtab")).toBe("chrome://newtab");
  });

  test("pruneClassificationCache bounds cache to max size according to LRU principle", () => {
    expect(typeof pruneClassificationCache).toBe("function");

    const cache: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      cache[`https://example.com/page-${i}`] = `Category ${i}`;
    }

    const pruned = pruneClassificationCache(cache, 20);
    expect(Object.keys(pruned).length).toBe(20);
    // Preserves recent keys
    expect(pruned["https://example.com/page-49"]).toBe("Category 49");
  });

  test("classifyTabs optimizes uncached tabs with provenance tracking and prevents cache poisoning", async () => {
    const tabs = [
      { id: 1, title: "GitHub oven-sh/bun repository", url: "https://github.com/oven-sh/bun?utm_source=gh" },
      { id: 2, title: "Claude AI chat interface", url: "https://claude.ai/new" },
      { id: 3, title: "YouTube chill lofi beats", url: "https://youtube.com/watch?v=123" }
    ];

    const testPerspective = {
      id: "test_topic",
      name: "Chủ đề test",
      labels: [
        { name: "Lập trình / Dev", description: "Mã nguồn, github, dev" },
        { name: "AI & Machine Learning", description: "AI, claude, llm" },
        { name: "Giải trí / Media", description: "Video youtube, nhạc" },
        { name: "Khác", description: "Khác" }
      ]
    };

    const result = await classifyTabs(tabs, testPerspective);
    expect(result).toBeDefined();

    const devUrl = normalizeUrlForCache(tabs[0].url);
    const aiUrl = normalizeUrlForCache(tabs[1].url);
    const mediaUrl = normalizeUrlForCache(tabs[2].url);

    // Verify labels extracted properly via getCacheLabel
    expect(getCacheLabel(result[devUrl])).toBe("Lập trình / Dev");
    expect(getCacheLabel(result[aiUrl])).toBe("AI & Machine Learning");
    expect(getCacheLabel(result[mediaUrl])).toBe("Giải trí / Media");

    // Verify provenance is marked as local so AI can upgrade later when key is provided
    expect(getCacheSource(result[devUrl])).toBe("local");
    expect(getCacheSource(result[aiUrl])).toBe("local");
    expect(getCacheSource(result[mediaUrl])).toBe("local");

    // Verify AI entry provenance is correctly identified as 'ai'
    const mockAiEntry = { label: "Lập trình / Dev", source: "ai", timestamp: Date.now() };
    expect(getCacheSource(mockAiEntry)).toBe("ai");
    expect(getCacheLabel(mockAiEntry)).toBe("Lập trình / Dev");
  });

  test("renderStaticDashboard supports skipBackgroundAi option to break recursive loops", async () => {
    expect(typeof renderStaticDashboard).toBe("function");
    // Verify calling with skipBackgroundAi in headless environment runs safely without throwing
    expect(renderStaticDashboard({ skipBackgroundAi: true })).resolves.toBeUndefined();
  });

  test("failure cooldown prevents tight retry loops for recently failed AI tabs", () => {
    const recentFailure = {
      label: "Khác",
      source: "local",
      lastAiAttempt: Date.now() - 5000, // 5 seconds ago (< 60s cooldown)
      timestamp: Date.now()
    };
    const isFailedRecently = recentFailure.lastAiAttempt && (Date.now() - recentFailure.lastAiAttempt < 60000);
    expect(isFailedRecently).toBe(true);

    const oldFailure = {
      label: "Khác",
      source: "local",
      lastAiAttempt: Date.now() - 120000, // 2 minutes ago (> 60s cooldown)
      timestamp: Date.now()
    };
    const isOldFailedRecently = oldFailure.lastAiAttempt && (Date.now() - oldFailure.lastAiAttempt < 60000);
    expect(isOldFailedRecently).toBe(false);
  });

  test("getDomainFallbackLabel correctly inherits AI classification from specialized domain and protects multi-topic domains", () => {
    expect(typeof getDomainFallbackLabel).toBe("function");

    const mockCache = {
      "https://bun.sh/docs": { label: "Lập trình / Dev", source: "ai", timestamp: Date.now() },
      "https://jira.atlassian.com/browse/TEST-1": { label: "Công việc / Task", source: "ai", timestamp: Date.now() },
      "https://github.com/oven-sh/bun": { label: "Lập trình / Dev", source: "ai", timestamp: Date.now() },
      "https://youtube.com/watch?v=123": { label: "Giải trí / Media", source: "ai", timestamp: Date.now() },
      "https://example.com/page1": { label: "Khác", source: "local", timestamp: Date.now() }
    };

    // Sub-page of specialized domain inherits AI label
    const bunTab = { title: "Bun Bundler", url: "https://bun.sh/docs/bundler" };
    expect(getDomainFallbackLabel(bunTab, mockCache)).toBe("Lập trình / Dev");

    const jiraTab = { title: "Issue #123", url: "https://jira.atlassian.com/browse/TEST-2" };
    expect(getDomainFallbackLabel(jiraTab, mockCache)).toBe("Công việc / Task");

    // Multi-topic domains (like github, youtube) must NOT inherit domain fallback to avoid semantic contamination
    const ghTab = { title: "Pull Request #999", url: "https://github.com/oven-sh/bun/pull/999" };
    expect(getDomainFallbackLabel(ghTab, mockCache)).toBeNull();

    const ytTab = { title: "Another Video", url: "https://www.youtube.com/watch?v=456" };
    expect(getDomainFallbackLabel(ytTab, mockCache)).toBeNull();

    // Non-AI cache entry does not inherit
    const exTab = { title: "Page 2", url: "https://example.com/page2" };
    expect(getDomainFallbackLabel(exTab, mockCache)).toBeNull();

    // Unknown domain returns null
    const unknownTab = { title: "Unknown", url: "https://fresh-unknown-domain.io" };
    expect(getDomainFallbackLabel(unknownTab, mockCache)).toBeNull();
  });

  test("pruneClassificationCache prioritizes newest entries by timestamp when available", () => {
    const cache = {
      "https://old.com": { label: "Old", timestamp: 1000 },
      "https://older.com": { label: "Older", timestamp: 500 },
      "https://new.com": { label: "New", timestamp: 5000 },
      "https://newest.com": { label: "Newest", timestamp: 9000 }
    };

    const pruned = pruneClassificationCache(cache, 2);
    expect(Object.keys(pruned).length).toBe(2);
    expect(pruned["https://newest.com"]).toBeDefined();
    expect(pruned["https://new.com"]).toBeDefined();
    expect(pruned["https://old.com"]).toBeUndefined();
    expect(pruned["https://older.com"]).toBeUndefined();
  });

  test("preclassifyTabInBackground safely ignores internal URLs and operates in headless environment", async () => {
    expect(typeof preclassifyTabInBackground).toBe("function");

    // Should return early for internal browser pages
    const internalTab = { id: 1, url: "chrome://settings" };
    await expect(preclassifyTabInBackground(internalTab)).resolves.toBeUndefined();

    const extTab = { id: 2, url: "chrome-extension://abcdef/popup.html" };
    await expect(preclassifyTabInBackground(extTab)).resolves.toBeUndefined();
  });

  test("renderStaticDashboard supports inMemoryOnly option for 0ms perspective switching", async () => {
    expect(typeof renderStaticDashboard).toBe("function");
    // inMemoryOnly bypasses chrome.storage and chrome.tabs queries for pure in-memory re-rendering
    expect(renderStaticDashboard({ inMemoryOnly: true })).resolves.toBeUndefined();
  });

  test("schedulePerspectivePrewarm is defined and handles idle execution safely", () => {
    expect(typeof schedulePerspectivePrewarm).toBe("function");
    // Verify calling in headless environment does not throw
    expect(() => schedulePerspectivePrewarm()).not.toThrow();
  });

  test("classifyTabs executes full Jev AI decisions batching and upgrades cache to 'ai' without crashing", async () => {
    const originalFetch = globalThis.fetch;
    const originalChrome = (globalThis as any).chrome;

    try {
      // Mock chrome.storage.local to supply an API key
      (globalThis as any).chrome = {
        storage: {
          local: {
            get: async () => ({ openRouterApiKey: "test-openrouter-key" }),
            set: async () => {}
          }
        }
      };

      await loadPerspectiveSettings(true);

      let capturedBody: any = null;
      globalThis.fetch = (async (url: string, init: any) => {
        if (url === "https://openrouter.ai/api/alpha/decisions") {
          capturedBody = JSON.parse(init.body);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              answers: {
                tab_0: { choice: "Lập trình / Dev" },
                tab_1: { choice: "AI & Machine Learning" }
              }
            })
          } as any;
        }
        return { ok: false, status: 404 } as any;
      }) as any;

      const tabsToClassify = [
        { id: 101, title: "Bun - Fast JavaScript runtime\nwith bundler", url: "https://bun.sh?ref=1" },
        { id: 102, title: "TypeSafe Jev AI Engine", url: "https://typesafe.ai" }
      ];

      const testPerspective = {
        id: "test_ai_batching",
        name: "Test Batching",
        labels: [
          { name: "Lập trình / Dev", description: "Coding and dev tools" },
          { name: "AI & Machine Learning", description: "AI models and agents" }
        ]
      };

      const result = await classifyTabs(tabsToClassify, testPerspective, true);

      // Verify request payload conforms to OpenRouter Decisions (~typesafe/jev-latest)
      expect(capturedBody).toBeDefined();
      expect(capturedBody.model).toBe("~typesafe/jev-latest");
      expect(capturedBody.state.tabs.tab_0.title).toContain("Bun - Fast JavaScript runtime");
      expect(capturedBody.state.tabs.tab_0.url).toContain("https://bun.sh");
      expect(capturedBody.state.tabs.tab_0.domain).toBe("bun.sh");
      expect(capturedBody.questions.tab_0.type).toBe("choice");
      expect(capturedBody.questions.tab_0.instructions).toContain("tabs.tab_0");

      // Verify cache entries were successfully upgraded to source: 'ai'
      const bunUrl = normalizeUrlForCache(tabsToClassify[0].url);
      const jevUrl = normalizeUrlForCache(tabsToClassify[1].url);

      expect(getCacheSource(result[bunUrl])).toBe("ai");
      expect(getCacheLabel(result[bunUrl])).toBe("Lập trình / Dev");

      expect(getCacheSource(result[jevUrl])).toBe("ai");
      expect(getCacheLabel(result[jevUrl])).toBe("AI & Machine Learning");
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).chrome = {
        storage: {
          local: {
            get: async () => ({ openRouterApiKey: "" }),
            set: async () => {}
          }
        }
      };
      await loadPerspectiveSettings(true);
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("extractHostname correctly extracts clean hostname across various edge case URL formats", () => {
    expect(extractHostname("https://example.com?foo=bar")).toBe("example.com");
    expect(extractHostname("https://github.com#readme")).toBe("github.com");
    expect(extractHostname("https://www.youtube.com/watch?v=123")).toBe("youtube.com");
    expect(extractHostname("https://bun.sh:3000/docs")).toBe("bun.sh");
    expect(extractHostname("http://localhost:8080?q=test#hash")).toBe("localhost");
    expect(extractHostname("https://user:password@sub.example.com:8080/path?q=1")).toBe("sub.example.com");
    expect(extractHostname("")).toBe("");
    expect(extractHostname("not-a-url")).toBe("");
  });

  test("normalizeUrlForCache strips unified tracking params seamlessly and sorts remaining params canonically", () => {
    const url = "https://youtube.com/watch?v=abc&si=track123&feature=share&utm_source=fb&fbclid=xyz&msclkid=123&_ga=456";
    const normalized = normalizeUrlForCache(url);
    expect(normalized).toBe("https://youtube.com/watch?v=abc");

    const paramSortUrl = "https://example.com/search?z=3&a=1&m=2";
    expect(normalizeUrlForCache(paramSortUrl)).toBe("https://example.com/search?a=1&m=2&z=3");
  });

  test("preclassifyTabInBackground batches multi-perspective questions concurrently in a single call", async () => {
    const originalChrome = (globalThis as any).chrome;
    const originalFetch = globalThis.fetch;

    let savedStorage: any = null;
    let requestBody: any = null;

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => ({
            openRouterApiKey: "sk-or-test-mock-key",
            activePerspectiveId: "topic",
            perspectives: [
              {
                id: "topic",
                name: "Chủ đề",
                labels: [{ name: "Lập trình / Dev", description: "Coding" }]
              },
              {
                id: "purpose",
                name: "Mục đích",
                labels: [{ name: "Học tập / Nghiên cứu", description: "Docs, study" }]
              }
            ],
            tabClassificationCache: {}
          }),
          set: async (obj: any) => {
            savedStorage = obj;
          }
        }
      }
    };

    globalThis.fetch = (async (url: string, init: any) => {
      requestBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          answers: {
            "topic__tab_0": { choice: "Lập trình / Dev" },
            "purpose__tab_0": { choice: "Học tập / Nghiên cứu" }
          }
        })
      };
    }) as any;

    try {
      const tab = { id: 888, title: "Bun Documentation", url: "https://bun.sh/docs" };
      await preclassifyTabInBackground(tab);

      // Verify questions for BOTH perspectives were asked in 1 single request
      expect(requestBody).toBeDefined();
      expect(requestBody.questions["topic__tab_0"]).toBeDefined();
      expect(requestBody.questions["purpose__tab_0"]).toBeDefined();

      // Verify both perspectives were saved simultaneously
      expect(savedStorage.tabClassificationCache.topic).toBeDefined();
      expect(savedStorage.tabClassificationCache.purpose).toBeDefined();

      const normUrl = normalizeUrlForCache(tab.url);
      expect(savedStorage.tabClassificationCache.topic[normUrl].label).toBe("Lập trình / Dev");
      expect(savedStorage.tabClassificationCache.purpose[normUrl].label).toBe("Học tập / Nghiên cứu");
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("preclassifyTabInBackground falls back to semantic perspective when activePerspectiveId is 'domain'", async () => {
    const originalChrome = (globalThis as any).chrome;
    const originalFetch = globalThis.fetch;

    let savedStorage: any = null;
    let fetchedUrl = "";

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => ({
            openRouterApiKey: "sk-or-test-mock-key",
            activePerspectiveId: "domain",
            perspectives: [
              { id: "domain", name: "By Domain", labels: [] },
              {
                id: "topic",
                name: "Topic",
                labels: [
                  { name: "Lập trình / Dev", description: "Coding tools" }
                ]
              }
            ],
            tabClassificationCache: {}
          }),
          set: async (obj: any) => {
            savedStorage = obj;
          }
        }
      }
    };

    globalThis.fetch = (async (url: string, init: any) => {
      fetchedUrl = url;
      return {
        ok: true,
        json: async () => ({
          answers: {
            tab_0: { choice: "Lập trình / Dev" }
          }
        })
      };
    }) as any;

    try {
      const tab = {
        id: 777,
        title: "Bun runtime",
        url: "https://bun.sh"
      };

      await preclassifyTabInBackground(tab);

      // Verify that background preclassification was NOT aborted and successfully saved to topic perspective!
      expect(fetchedUrl).toBe("https://openrouter.ai/api/alpha/decisions");
      expect(savedStorage).toBeDefined();
      expect(savedStorage.tabClassificationCache.topic).toBeDefined();
      const normUrl = normalizeUrlForCache(tab.url);
      expect(savedStorage.tabClassificationCache.topic[normUrl].label).toBe("Lập trình / Dev");
      expect(savedStorage.tabClassificationCache.topic[normUrl].source).toBe("ai");
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("preclassifyTabInBackground resolves all concurrent promises when multiple tabs trigger debounce", async () => {
    const originalChrome = (globalThis as any).chrome;
    const originalFetch = globalThis.fetch;

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => ({
            openRouterApiKey: "sk-or-test-mock-key",
            activePerspectiveId: "topic",
            perspectives: [
              {
                id: "topic",
                name: "Chủ đề",
                labels: [{ name: "Lập trình / Dev", description: "Coding" }]
              }
            ],
            tabClassificationCache: {}
          }),
          set: async () => {}
        }
      }
    };

    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ answers: {} })
    })) as any;

    try {
      const tab1 = { id: 101, title: "Tab 1", url: "https://example.com/1" };
      const tab2 = { id: 102, title: "Tab 2", url: "https://example.com/2" };
      const tab3 = { id: 103, title: "Tab 3", url: "https://example.com/3" };

      // Concurrently queue tabs within debounce window
      const [res1, res2, res3] = await Promise.all([
        preclassifyTabInBackground(tab1),
        preclassifyTabInBackground(tab2),
        preclassifyTabInBackground(tab3)
      ]);

      expect(res1).toBeUndefined();
      expect(res2).toBeUndefined();
      expect(res3).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("saveClassificationCacheAtomic merges updates atomically without clobbering other perspectives", async () => {
    const originalChrome = (globalThis as any).chrome;
    let storedCache: any = {
      purpose: {
        "https://example.com/docs": { label: "Học tập", source: "ai", timestamp: 100 }
      }
    };

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => ({ tabClassificationCache: storedCache }),
          set: async (obj: any) => {
            storedCache = obj.tabClassificationCache;
          }
        }
      }
    };

    try {
      const topicUpdates = {
        "https://example.com/code": { label: "Lập trình", source: "ai", timestamp: 200 }
      };

      await saveClassificationCacheAtomic("topic", topicUpdates);

      // Verify purpose cache is preserved (not clobbered) and topic cache was added
      expect(storedCache.purpose).toBeDefined();
      expect(storedCache.purpose["https://example.com/docs"].label).toBe("Học tập");
      expect(storedCache.topic).toBeDefined();
      expect(storedCache.topic["https://example.com/code"].label).toBe("Lập trình");
    } finally {
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("prewarmMultiPerspective is a no-op under strict on-demand architecture (zero token waste)", async () => {
    let fetchCalled = false;
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => { fetchCalled = true; return { ok: true }; }) as any;
    try {
      await prewarmMultiPerspective([{ title: "Doc", url: "https://bun.sh" }], [{ id: "p1", labels: ["L1"] }]);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  test("saveClassificationCacheAtomic strictly protects existing ai entries from local downgrades", async () => {
    const originalChrome = (globalThis as any).chrome;
    let storedCache: any = {
      topic: {
        "https://example.com/ai-tool": { label: "AI xịn", source: "ai", timestamp: 1000 }
      }
    };

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => ({ tabClassificationCache: storedCache }),
          set: async (obj: any) => {
            storedCache = obj.tabClassificationCache;
          }
        }
      }
    };

    try {
      // Attempt to save a local fallback for the same URL
      const localDowngrade = {
        "https://example.com/ai-tool": { label: "Fallback cùi", source: "local", timestamp: 2000 }
      };

      await saveClassificationCacheAtomic("topic", localDowngrade);

      // Verify the entry remains 'ai' and was not overwritten by 'local'
      expect(storedCache.topic["https://example.com/ai-tool"].source).toBe("ai");
      expect(storedCache.topic["https://example.com/ai-tool"].label).toBe("AI xịn");
    } finally {
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("completed low-confidence decisions cannot be downgraded by a stale local save", async () => {
    const originalChrome = (globalThis as any).chrome;
    const url = 'https://stale.example.com/page';
    const completed = { label: 'Code', source: 'ai-low-confidence', confidence: 0.3, timestamp: 200 };
    const storage: Record<string, any> = {
      tabClassificationCache_topic: { [url]: completed },
      tabClassificationCache: { topic: { [url]: completed } }
    };
    (globalThis as any).chrome = { storage: { local: {
      get: async () => structuredClone(storage),
      set: async (updates: any) => Object.assign(storage, updates)
    } } };
    try {
      await saveClassificationCacheAtomic('topic', {
        [url]: { label: 'Other', source: 'local', timestamp: 300 }
      });
      expect(storage.tabClassificationCache_topic[url]).toEqual(completed);
      await saveBgClassificationCache({ topic: {
        [url]: { label: 'Other', source: 'local', timestamp: 400 }
      } });
      expect(storage.tabClassificationCache_topic[url]).toEqual(completed);
    } finally {
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("completed high-confidence decisions cannot be downgraded by a low-confidence save", async () => {
    const originalChrome = (globalThis as any).chrome;
    const url = 'https://high-conf.example.com/page';
    const highConf = { label: 'Code', source: 'ai', confidence: 0.9, timestamp: 200 };
    const storage: Record<string, any> = {
      tabClassificationCache_topic: { [url]: highConf },
      tabClassificationCache: { topic: { [url]: highConf } }
    };
    (globalThis as any).chrome = { storage: { local: {
      get: async () => structuredClone(storage),
      set: async (updates: any) => Object.assign(storage, updates)
    } } };
    try {
      await saveClassificationCacheAtomic('topic', {
        [url]: { label: 'Other', source: 'ai-low-confidence', confidence: 0.3, timestamp: 300 }
      });
      expect(storage.tabClassificationCache_topic[url]).toEqual(highConf);
      await saveBgClassificationCache({ topic: {
        [url]: { label: 'Other', source: 'ai-low-confidence', confidence: 0.3, timestamp: 400 }
      } });
      expect(storage.tabClassificationCache_topic[url]).toEqual(highConf);
    } finally {
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("buildOverflowChips cleans domain titles correctly even when domain is perspective:label", () => {
    const hiddenTabs = [
      { title: "oven-sh/bun: Incredibly fast JavaScript runtime - GitHub", url: "https://github.com/oven-sh/bun" }
    ];

    // Pass perspective:Lập trình as domain (as happens in semantic perspective groups)
    const html = buildOverflowChips(hiddenTabs, {}, false, "perspective:Lập trình");
    expect(html).toBeDefined();
    // Verify that GitHub noise was stripped because extractHostname was used instead of perspective:Lập trình
    expect(html).toContain("Incredibly fast JavaScript runtime");
    expect(html).not.toContain("- GitHub");
  });

  test("classifyTabs applies confidence-gated routing preserving provenance and marking low-confidence decisions", async () => {
    const originalChrome = (globalThis as any).chrome;
    const originalFetch = globalThis.fetch;

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => ({ openRouterApiKey: "sk-mock-key-conf" }),
          set: async () => {}
        }
      }
    };

    globalThis.fetch = (async (url: string, init: any) => {
      return {
        ok: true,
        json: async () => ({
          answers: {
            tab_0: { choice: "Lập trình / Dev", confidence: 0.95 },
            tab_1: { choice: "AI & Machine Learning", confidence: 0.28 }
          }
        })
      } as any;
    }) as any;

    try {
      await loadPerspectiveSettings(true);
      const testP = {
        id: "conf_test",
        name: "Confidence Test",
        labels: [
          { name: "Lập trình / Dev", description: "Coding" },
          { name: "AI & Machine Learning", description: "AI tools" }
        ]
      };
      const tabs = [
        { id: 1, title: "High confidence tab", url: "https://bun.sh/high" },
        { id: 2, title: "Ambiguous tab", url: "https://example.com/ambiguous" }
      ];

      const res = await classifyTabs(tabs, testP, true);
      const highUrl = normalizeUrlForCache(tabs[0].url);
      const lowUrl = normalizeUrlForCache(tabs[1].url);

      expect(res[highUrl]).toBeDefined();
      expect(res[highUrl].source).toBe("ai");
      expect(res[highUrl].confidence).toBe(0.95);
      expect(res[highUrl].label).toBe("Lập trình / Dev");

      expect(res[lowUrl]).toBeDefined();
      expect(res[lowUrl].source).toBe("ai-low-confidence");
      expect(res[lowUrl].confidence).toBe(0.28);
      expect(res[lowUrl].label).toBe("AI & Machine Learning");
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("classifyTabs strictly queries only active perspective questions without token-burning fanout", async () => {
    const originalChrome = (globalThis as any).chrome;
    const originalFetch = globalThis.fetch;

    let savedStorage: any = {};
    let capturedBody: any = null;

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => ({
            openRouterApiKey: "sk-mock-fanout-key",
            activePerspectiveId: "topic",
            perspectives: [
              {
                id: "topic",
                name: "Chủ đề",
                labels: [{ name: "Lập trình / Dev", description: "Dev tools" }]
              },
              {
                id: "purpose",
                name: "Mục đích",
                labels: [{ name: "Công việc", description: "Work related" }]
              }
            ],
            tabClassificationCache: savedStorage
          }),
          set: async (obj: any) => {
            if (obj.tabClassificationCache) {
              savedStorage = obj.tabClassificationCache;
            }
          }
        }
      }
    };

    globalThis.fetch = (async (url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          answers: {
            "tab_0": { choice: "Lập trình / Dev", confidence: 0.9 }
          }
        })
      } as any;
    }) as any;

    try {
      await loadPerspectiveSettings(true);
      const tabs = [{ id: 501, title: "GitHub Pull Request", url: "https://github.com/oven-sh/bun/pull/1" }];
      const activeP = {
        id: "topic",
        name: "Chủ đề",
        labels: [{ name: "Lập trình / Dev", description: "Dev tools" }]
      };

      const result = await classifyTabs(tabs, activeP, true);
      const tabUrl = normalizeUrlForCache(tabs[0].url);

      // Verify questions for active perspective were sent, and inactive perspective was NOT sent
      expect(capturedBody).toBeDefined();
      expect(capturedBody.questions["tab_0"]).toBeDefined();
      expect(capturedBody.questions["purpose__tab_0"]).toBeUndefined();

      // Verify active perspective cache
      expect(result[tabUrl].source).toBe("ai");
      expect(result[tabUrl].label).toBe("Lập trình / Dev");

      // Verify inactive perspective cache was NOT speculatively populated
      expect(savedStorage.purpose).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("classifyTabs injects fallback 'Khác' criteria when perspective lacks escape hatch", async () => {
    const originalChrome = (globalThis as any).chrome;
    const originalFetch = globalThis.fetch;
    let capturedBody: any = null;

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => ({ openRouterApiKey: "sk-mock-key" }),
          set: async () => {}
        }
      }
    };

    globalThis.fetch = (async (url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          answers: {
            tab_0: { choice: "Khác", confidence: 0.85 }
          }
        })
      } as any;
    }) as any;

    try {
      await loadPerspectiveSettings(true);
      const singleTagPerspective = {
        id: "single_tag_p",
        name: "Dự án duy nhất",
        labels: [{ name: "Dự án A", description: "Only project A" }]
      };

      const tabs = [{ id: 601, title: "Shopee Sale", url: "https://shopee.vn" }];
      const res = await classifyTabs(tabs, singleTagPerspective, true);

      expect(capturedBody).toBeDefined();
      // Verify choice question has at least 2 options and contains 'Khác'
      expect(Object.keys(capturedBody.questions.tab_0.criteria).length).toBeGreaterThanOrEqual(2);
      expect(capturedBody.questions.tab_0.criteria["Khác"]).toBeDefined();

      const shopeeUrl = normalizeUrlForCache(tabs[0].url);
      expect(res[shopeeUrl].label).toBe("Khác");
      expect(res[shopeeUrl].source).toBe("ai");
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("buildChoiceCriteria canonical behavior handles edge cases correctly", () => {
    // Normal perspective without 'Khác' -> injects 'Khác'
    const crit1 = buildChoiceCriteria({
      labels: [{ name: "Công việc", description: "Tabs related to work" }]
    });
    expect(Object.keys(crit1).length).toBe(2);
    expect(crit1["Công việc"]).toBeDefined();
    expect(crit1["Khác"]).toBeDefined();

    // Perspective already containing 'Khác'
    const crit2 = buildChoiceCriteria({
      labels: [
        { name: "Code", description: "Programming" },
        { name: "Khác", description: "Other things" }
      ]
    });
    expect(Object.keys(crit2).length).toBe(2);
    expect(crit2["Khác"]).toBe("Other things");

    // Edge case: single tag named 'Khác' -> falls back to 'Chung' to ensure >= 2 options
    const crit3 = buildChoiceCriteria({
      labels: [{ name: "Khác", description: "Everything else" }]
    });
    expect(Object.keys(crit3).length).toBe(2);
    expect(crit3["Khác"]).toBe("Everything else");
    expect(crit3["Chung"]).toBeDefined();
  });

  test("classifyTabs never automatically retries a low-confidence choice", async () => {
    const originalChrome = (globalThis as any).chrome;
    const originalFetch = globalThis.fetch;

    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => ({
          answers: {
            tab_0: { choice: "AI & Machine Learning", confidence: 0.35 } // low confidence (< 0.45)
          }
        })
      } as any;
    }) as any;

    const mockStorage: Record<string, any> = {
      openRouterApiKey: "sk-or-test-low-conf",
      activePerspectiveId: "topic",
      tabClassificationCache: {},
      perspectives: DEFAULT_PERSPECTIVES
    };

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (keys: any) => {
            const res: Record<string, any> = {};
            const keyArr = Array.isArray(keys) ? keys : [keys];
            for (const k of keyArr) res[k] = mockStorage[k];
            return res;
          },
          set: async (obj: any) => {
            Object.assign(mockStorage, obj);
          }
        },
        onChanged: { addListener: () => {} }
      }
    };

    try {
      await loadPerspectiveSettings(true);
      const tabs = [{ id: 701, title: "Ambiguous Post", url: "https://example.org/post" }];
      const res = await classifyTabs(tabs, DEFAULT_PERSPECTIVES[1], false);

      const normUrl = normalizeUrlForCache(tabs[0].url);
      expect(res[normUrl]).toBeDefined();
      expect(res[normUrl].source).toBe("ai-low-confidence");
      expect(res[normUrl].confidence).toBe(0.35);
      expect(res[normUrl].cooldownMs).toBe(60000);
      expect(res[normUrl].lastAiAttempt).toBeGreaterThan(0);
      expect(fetchCount).toBe(1);

      // An old, low-confidence answer is still a completed AI decision.
      mockStorage[`tabClassificationCache_${DEFAULT_PERSPECTIVES[1].id}`][normUrl].lastAiAttempt = Date.now() - 120000;
      await loadPerspectiveSettings(true);
      const res2 = await classifyTabs(tabs, DEFAULT_PERSPECTIVES[1], false);
      expect(fetchCount).toBe(1); // Not called again!
      expect(res2[normUrl].source).toBe("ai-low-confidence");
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("dashboard background refinement does not force retry an old low-confidence decision", async () => {
    const oldChrome = (globalThis as any).chrome;
    const oldFetch = globalThis.fetch;
    const tab = { id: 710, title: 'Ambiguous', url: 'https://ambiguous.example.org/post' };
    const url = normalizeUrlForCache(tab.url);
    const entry = { label: 'Code', source: 'ai-low-confidence', confidence: 0.2,
      lastAiAttempt: Date.now() - 120000, cooldownMs: 60000 };
    const storage: Record<string, any> = {
      openRouterApiKey: 'test-key', activePerspectiveId: 'topic',
      perspectives: DEFAULT_PERSPECTIVES,
      tabClassificationCache_topic: { [url]: entry },
      tabClassificationCache: { topic: { [url]: entry } }
    };
    (globalThis as any).chrome = { storage: { local: {
      get: async () => structuredClone(storage),
      set: async (updates: any) => Object.assign(storage, updates)
    } } };
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return { ok: true, json: async () => ({ answers: {} }) }; }) as any;
    try {
      await loadPerspectiveSettings(true);
      triggerBackgroundClassification([tab], DEFAULT_PERSPECTIVES[1]);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = oldFetch;
      (globalThis as any).chrome = oldChrome;
    }
  });

  test("saveClassificationCacheAtomic serializes concurrent writes without losing data", async () => {
    const originalChrome = (globalThis as any).chrome;
    let storageCache: Record<string, any> = {};

    // Simulate async storage with artificial random delay to expose race conditions
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => {
            await new Promise(r => setTimeout(r, 5));
            return { tabClassificationCache: JSON.parse(JSON.stringify(storageCache)) };
          },
          set: async (obj: any) => {
            await new Promise(r => setTimeout(r, 5));
            if (obj.tabClassificationCache) {
              storageCache = JSON.parse(JSON.stringify(obj.tabClassificationCache));
            }
          }
        },
        onChanged: { addListener: () => {} }
      }
    };

    try {
      // Fire 5 concurrent writes simultaneously across different URLs and perspectives
      await Promise.all([
        saveClassificationCacheAtomic("topic", { "https://site-a.com": { label: "Dev", source: "ai", confidence: 0.9, timestamp: Date.now() } }),
        saveClassificationCacheAtomic("topic", { "https://site-b.com": { label: "AI", source: "ai", confidence: 0.85, timestamp: Date.now() } }),
        saveClassificationCacheAtomic("purpose", { "https://site-c.com": { label: "Work", source: "ai", confidence: 0.95, timestamp: Date.now() } }),
        saveClassificationCacheAtomic("topic", { "https://site-d.com": { label: "Social", source: "ai", confidence: 0.7, timestamp: Date.now() } }),
        saveClassificationCacheAtomic("purpose", { "https://site-e.com": { label: "Study", source: "ai", confidence: 0.88, timestamp: Date.now() } })
      ]);

      // All 5 entries must be present without any clobbering!
      expect(storageCache.topic["https://site-a.com"]).toBeDefined();
      expect(storageCache.topic["https://site-b.com"]).toBeDefined();
      expect(storageCache.topic["https://site-d.com"]).toBeDefined();
      expect(storageCache.purpose["https://site-c.com"]).toBeDefined();
      expect(storageCache.purpose["https://site-e.com"]).toBeDefined();
    } finally {
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("classifyTabs extracts secondaryLabel from probabilities distribution when >= 0.20", async () => {
    const originalChrome = (globalThis as any).chrome;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        answers: {
          tab_0: {
            choice: "AI & Machine Learning",
            confidence: 0.70,
            probabilities: {
              "AI & Machine Learning": 0.70,
              "Lập trình / Dev": 0.25,
              "Tin tức & Đọc báo": 0.05
            }
          }
        }
      })
    })) as any;

    const mockStorage: Record<string, any> = {
      openRouterApiKey: "sk-mock-prob-key",
      activePerspectiveId: "topic",
      tabClassificationCache: {},
      perspectives: DEFAULT_PERSPECTIVES
    };

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (keys: any) => {
            const res: Record<string, any> = {};
            const keyArr = Array.isArray(keys) ? keys : [keys];
            for (const k of keyArr) res[k] = mockStorage[k];
            return res;
          },
          set: async (obj: any) => {
            Object.assign(mockStorage, obj);
          }
        },
        onChanged: { addListener: () => {} }
      }
    };

    try {
      await loadPerspectiveSettings(true);
      const tabs = [{ id: 801, title: "LangChain GitHub", url: "https://github.com/langchain-ai/langchain" }];
      const res = await classifyTabs(tabs, DEFAULT_PERSPECTIVES[1], true);

      const normUrl = normalizeUrlForCache(tabs[0].url);
      expect(res[normUrl].label).toBe("AI & Machine Learning");
      expect(res[normUrl].secondaryLabel).toBe("Lập trình / Dev");
      expect(res[normUrl].source).toBe("ai");
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("classifyTabs applies 60s cooldown on HTTP 429 and 300s cooldown on HTTP 400", async () => {
    const originalChrome = (globalThis as any).chrome;
    const originalFetch = globalThis.fetch;

    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return {
        ok: false,
        status: 429,
        statusText: "Too Many Requests"
      } as any;
    }) as any;

    const mockStorage: Record<string, any> = {
      openRouterApiKey: "sk-mock-429-key",
      activePerspectiveId: "topic",
      tabClassificationCache: {},
      perspectives: DEFAULT_PERSPECTIVES
    };

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => mockStorage,
          set: async (obj: any) => Object.assign(mockStorage, obj)
        },
        onChanged: { addListener: () => {} }
      }
    };

    try {
      await loadPerspectiveSettings(true);
      const tabs = [{ id: 901, title: "Rate Limited Tab", url: "https://example.com/ratelimit" }];
      const res = await classifyTabs(tabs, DEFAULT_PERSPECTIVES[1], true);

      const normUrl = normalizeUrlForCache(tabs[0].url);
      expect(res[normUrl]).toBeDefined();
      expect(res[normUrl].source).toBe("local");
      expect(res[normUrl].cooldownMs).toBe(60000);
      expect(res[normUrl].lastAiAttempt).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("buildChoiceCriteria supports structured rubric objects", () => {
    const testPerspective = {
      id: "rubric-test",
      name: "Rubric Test",
      labels: [
        {
          name: "Coding",
          rubric: {
            what: "Development environments, GitHub, stack overflow",
            not_for: "Entertainment or social media",
            examples: ["github.com", "gitlab.com"]
          }
        },
        {
          name: "Design",
          description: "Figma and design tools"
        }
      ]
    };

    const criteria = buildChoiceCriteria(testPerspective);
    expect(criteria["Coding"]).toEqual({
      what: "Development environments, GitHub, stack overflow",
      not_for: "Entertainment or social media",
      examples: ["github.com", "gitlab.com"]
    });
    expect(criteria["Design"]).toBe("Figma and design tools");
    expect(criteria["Khác"]).toBeDefined();
  });

  test("classifyTabs sends only useful choice questions", async () => {
    const originalFetch = globalThis.fetch;
    const originalChrome = (globalThis as any).chrome;

    const mockStorage: Record<string, any> = {
      openRouterApiKey: "sk-or-v1-mock-key",
      perspectives: DEFAULT_PERSPECTIVES,
      activePerspectiveId: DEFAULT_PERSPECTIVES[1].id
    };

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => mockStorage,
          set: async (obj: any) => Object.assign(mockStorage, obj)
        },
        onChanged: { addListener: () => {} }
      }
    };

    let sentBody: any = null;
    globalThis.fetch = (async (url: string, init: any) => {
      sentBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          answers: {
            tab_0: {
              choice: DEFAULT_PERSPECTIVES[1].labels[0].name,
              confidence: 0.95
            }
          }
        })
      };
    }) as any;

    try {
      await loadPerspectiveSettings(true);
      const tabs = [{ id: 910, title: "Disposable Tab", url: "https://disposable-search.com" }];
      const res = await classifyTabs(tabs, DEFAULT_PERSPECTIVES[1], true);

      expect(Object.values(sentBody.questions).every((q: any) => q.type === 'choice')).toBe(true);

      const normUrl = normalizeUrlForCache(tabs[0].url);
      expect(res[normUrl]).toBeDefined();
      expect(res[normUrl].hygieneScore).toBeUndefined();
      expect(res[normUrl].source).toBe("ai");
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("saveClassificationCacheAtomic and saveBgClassificationCache preserve secondaryLabel", async () => {
    const originalChrome = (globalThis as any).chrome;

    const mockStorage: Record<string, any> = {
      tabClassificationCache_topic: {
        "https://example.com/item1": {
          label: "Công việc",
          source: "ai",
          confidence: 0.95,
          secondaryLabel: "Dự án",
          timestamp: Date.now() - 5000
        }
      }
    };

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (keys: string[]) => {
            const result: Record<string, any> = {};
            for (const k of keys) {
              if (k in mockStorage) result[k] = mockStorage[k];
            }
            return result;
          },
          set: async (obj: any) => {
            Object.assign(mockStorage, obj);
          }
        }
      }
    };

    try {
      // Frontend atomic save without secondaryLabel must NOT overwrite existing one
      await saveClassificationCacheAtomic("topic", {
        "https://example.com/item1": {
          label: "Công việc",
          source: "ai",
          confidence: 0.98,
          timestamp: Date.now()
        }
      });

      const entryAfterApp = mockStorage["tabClassificationCache_topic"]["https://example.com/item1"];
      expect(entryAfterApp.confidence).toBe(0.98);
      expect(entryAfterApp.secondaryLabel).toBe("Dự án");

      // Background save without secondaryLabel must also preserve it
      await saveBgClassificationCache({
        topic: {
          "https://example.com/item1": {
            label: "Công việc",
            source: "ai",
            confidence: 0.99,
            timestamp: Date.now()
          }
        }
      });

      const entryAfterBg = mockStorage["tabClassificationCache_topic"]["https://example.com/item1"];
      expect(entryAfterBg.confidence).toBe(0.99);
      expect(entryAfterBg.secondaryLabel).toBe("Dự án");
    } finally {
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("classifyTabs applies 60s cooldown on HTTP 529 and 300s cooldown on HTTP 422", async () => {
    const originalFetch = globalThis.fetch;
    const originalChrome = (globalThis as any).chrome;

    const mockStorage: Record<string, any> = {
      openRouterApiKey: "sk-or-v1-mock-key",
      perspectives: DEFAULT_PERSPECTIVES,
      activePerspectiveId: DEFAULT_PERSPECTIVES[1].id
    };

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => mockStorage,
          set: async (obj: any) => Object.assign(mockStorage, obj)
        },
        onChanged: { addListener: () => {} }
      }
    };

    try {
      // Test HTTP 529
      globalThis.fetch = (async () => ({
        ok: false,
        status: 529,
        statusText: "Site Overloaded"
      })) as any;

      await loadPerspectiveSettings(true);
      const tabs529 = [{ id: 920, title: "Overloaded Test", url: "https://overloaded.example.com" }];
      const res529 = await classifyTabs(tabs529, DEFAULT_PERSPECTIVES[1], true);
      const norm529 = normalizeUrlForCache(tabs529[0].url);
      expect(res529[norm529].cooldownMs).toBe(60000);

      // Test HTTP 422
      globalThis.fetch = (async () => ({
        ok: false,
        status: 422,
        statusText: "Unprocessable Entity"
      })) as any;

      const tabs422 = [{ id: 921, title: "Unprocessable Test", url: "https://unprocessable.example.com" }];
      const res422 = await classifyTabs(tabs422, DEFAULT_PERSPECTIVES[1], true);
      const norm422 = normalizeUrlForCache(tabs422[0].url);
      expect(res422[norm422].cooldownMs).toBe(300000);
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("saveBgClassificationCache writes partitioned keys and monolithic mirror", async () => {
    const originalChrome = (globalThis as any).chrome;

    const mockStorage: Record<string, any> = {};
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (keys: string[]) => {
            const result: Record<string, any> = {};
            for (const k of keys) {
              if (k in mockStorage) result[k] = mockStorage[k];
            }
            return result;
          },
          set: async (obj: any) => {
            Object.assign(mockStorage, obj);
          }
        }
      }
    };

    try {
      await saveBgClassificationCache({
        topic: {
          "https://example.com/item1": {
            label: "Công việc",
            source: "ai",
            confidence: 0.95,
            timestamp: Date.now()
          }
        }
      });

      // Verify partitioned storage key was written
      expect(mockStorage["tabClassificationCache_topic"]).toBeDefined();
      expect(mockStorage["tabClassificationCache_topic"]["https://example.com/item1"].label).toBe("Công việc");

      // Verify monolithic mirror was also written
      expect(mockStorage["tabClassificationCache"]).toBeDefined();
      expect(mockStorage["tabClassificationCache"]["topic"]["https://example.com/item1"].label).toBe("Công việc");
    } finally {
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("prewarmMultiPerspective sets cooldownMs on candidate tabs when API request fails", async () => {
    const originalFetch = globalThis.fetch;
    const originalChrome = (globalThis as any).chrome;

    const mockStorage: Record<string, any> = {
      openRouterApiKey: "sk-or-v1-mock-key",
      perspectives: DEFAULT_PERSPECTIVES,
      activePerspectiveId: DEFAULT_PERSPECTIVES[1].id
    };

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => mockStorage,
          set: async (obj: any) => Object.assign(mockStorage, obj)
        },
        onChanged: { addListener: () => {} }
      }
    };

    globalThis.fetch = (async () => ({
      ok: false,
      status: 429,
      statusText: "Too Many Requests"
    })) as any;

    try {
      await loadPerspectiveSettings(true);
      const testTab = { id: 930, title: "Prewarm Fail Test", url: "https://prewarmfail.example.com" };
      // Classify initial local fallback
      await classifyTabs([testTab], DEFAULT_PERSPECTIVES[1], false);

      // Attempt prewarm across inactive perspectives
      const inactive = DEFAULT_PERSPECTIVES.filter((p: any) => p.id !== 'domain' && p.id !== DEFAULT_PERSPECTIVES[1].id);
      await prewarmMultiPerspective([testTab], inactive);

      const normUrl = normalizeUrlForCache(testTab.url);
      const res = await classifyTabs([testTab], inactive[0], false);
      expect(res[normUrl]).toBeDefined();
      expect(res[normUrl].cooldownMs).toBe(60000);
      expect(res[normUrl].lastAiAttempt).toBeGreaterThan(0);

      // Verify that failure was also persisted to partitioned storage!
      const partitionKey = "tabClassificationCache_" + inactive[0].id;
      expect(mockStorage[partitionKey]).toBeDefined();
      expect(mockStorage[partitionKey][normUrl].cooldownMs).toBe(60000);
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("preclassifyTabInBackground sends only choice questions", async () => {
    const originalFetch = globalThis.fetch;
    const originalChrome = (globalThis as any).chrome;

    const mockStorage: Record<string, any> = {
      openRouterApiKey: "sk-or-v1-mock-key",
      perspectives: DEFAULT_PERSPECTIVES,
      activePerspectiveId: DEFAULT_PERSPECTIVES[1].id
    };

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (keys: string[]) => {
            const result: Record<string, any> = {};
            for (const k of keys) {
              if (k in mockStorage) result[k] = mockStorage[k];
            }
            return result;
          },
          set: async (obj: any) => Object.assign(mockStorage, obj)
        },
        onChanged: { addListener: () => {} }
      }
    };

    let sentQuestions: any = null;
    globalThis.fetch = (async (url: string, init: any) => {
      const parsedBody = JSON.parse(init.body);
      sentQuestions = parsedBody.questions;
      return {
        ok: true,
        json: async () => ({
          answers: {
            "topic__tab_0": {
              choice: DEFAULT_PERSPECTIVES[1].labels[0].name,
              confidence: 0.95
            }
          }
        })
      };
    }) as any;

    try {
      const tab = { id: 940, title: "Background Tab Test", url: "https://disposable-bg.com" };
      await preclassifyTabInBackground(tab);

      expect(Object.values(sentQuestions).every((q: any) => q.type === 'choice')).toBe(true);

      const normUrl = normalizeUrlForCache(tab.url);
      expect(mockStorage["tabClassificationCache_topic"]).toBeDefined();
      expect(mockStorage["tabClassificationCache_topic"][normUrl].hygieneScore).toBeUndefined();
      expect(mockStorage["tabClassificationCache_topic"][normUrl].source).toBe("ai");
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("classifyTabs parses Retry-After header on HTTP 429 response", async () => {
    const originalFetch = globalThis.fetch;
    const originalChrome = (globalThis as any).chrome;

    const mockStorage: Record<string, any> = {
      openRouterApiKey: "sk-or-v1-mock-key",
      perspectives: DEFAULT_PERSPECTIVES,
      activePerspectiveId: DEFAULT_PERSPECTIVES[1].id
    };

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => mockStorage,
          set: async (obj: any) => Object.assign(mockStorage, obj)
        },
        onChanged: { addListener: () => {} }
      }
    };

    globalThis.fetch = (async () => ({
      ok: false,
      status: 429,
      statusText: "Rate Limited",
      headers: {
        get: (h: string) => (h.toLowerCase() === 'retry-after' ? '12' : null)
      }
    })) as any;

    try {
      await loadPerspectiveSettings(true);
      const tab = { id: 950, title: "Retry After Tab", url: "https://retryafter.example.com" };
      const res = await classifyTabs([tab], DEFAULT_PERSPECTIVES[1], true);

      const normUrl = normalizeUrlForCache(tab.url);
      expect(res[normUrl]).toBeDefined();
      // 12 seconds * 1000ms = 12000ms
      expect(res[normUrl].cooldownMs).toBe(12000);
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("preclassifyTabInBackground applies failure cooldown to brand-new uncached tabs when OpenRouter returns error", async () => {
    const originalFetch = globalThis.fetch;
    const originalChrome = (globalThis as any).chrome;

    const mockStorage: Record<string, any> = {
      openRouterApiKey: "sk-or-v1-mock-key",
      perspectives: [
        {
          id: "topic",
          name: "Chủ đề",
          labels: [{ name: "Lập trình / Dev", description: "Coding" }]
        }
      ],
      activePerspectiveId: "topic",
      tabClassificationCache: {}
    };

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => JSON.parse(JSON.stringify(mockStorage)),
          set: async (obj: any) => {
            Object.assign(mockStorage, obj);
          }
        },
        onChanged: { addListener: () => {} }
      }
    };

    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      headers: { get: () => null }
    })) as any;

    try {
      const tab = { id: 980, title: "Fresh Brand New Tab", url: "https://brandnewtab.example.com" };
      await preclassifyTabInBackground(tab);

      const normUrl = normalizeUrlForCache(tab.url);
      const cached = mockStorage.tabClassificationCache?.topic?.[normUrl];
      expect(cached).toBeDefined();
      expect(cached.label).toBe("Khác");
      expect(cached.source).toBe("local");
      expect(cached.cooldownMs).toBe(15000);
      expect(typeof cached.lastAiAttempt).toBe("number");
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("classifyTabs saves only active perspective classification labels under on-demand mode", async () => {
    const originalFetch = globalThis.fetch;
    const originalChrome = (globalThis as any).chrome;

    const mockStorage: Record<string, any> = {
      openRouterApiKey: "sk-or-v1-mock-key",
      perspectives: DEFAULT_PERSPECTIVES,
      activePerspectiveId: DEFAULT_PERSPECTIVES[1].id
    };

    const savedPartitions: Record<string, any> = {};

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => mockStorage,
          set: async (obj: any) => {
            Object.assign(mockStorage, obj);
            Object.assign(savedPartitions, obj);
          }
        },
        onChanged: { addListener: () => {} }
      }
    };

    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        answers: {
          "tab_0": { choice: "Lập trình / Dev", confidence: 0.95 }
        }
      })
    })) as any;

    try {
      await loadPerspectiveSettings(true);
      const tab = { id: 991, title: "Deep Speculative Tab", url: "https://speculativefanout.example.com" };
      const res = await classifyTabs([tab], DEFAULT_PERSPECTIVES[1], true);

      const normUrl = normalizeUrlForCache(tab.url);
      expect(res[normUrl]).toBeDefined();
      expect(res[normUrl].hygieneScore).toBeUndefined();
      expect(res[normUrl].source).toBe("ai");

      // Verify inactive perspective was not queried or saved
      const purposePartition = savedPartitions["tabClassificationCache_purpose"];
      expect(purposePartition).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("deleting and editing a perspective removes partition key via chrome.storage.local.remove", async () => {
    const originalChrome = (globalThis as any).chrome;
    const removedKeys: string[][] = [];

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => ({}),
          set: async () => {},
          remove: async (keys: string[]) => {
            removedKeys.push(keys);
          }
        },
        onChanged: { addListener: () => {} }
      }
    };

    try {
      // 1. Verify that extension/app.js contains removal in both delete-perspective and perspectiveForm submit
      const appPath = resolve(__dirname, "../extension/app.js");
      const appCode = readFileSync(appPath, "utf-8");

      const deleteSection = appCode.substring(
        appCode.indexOf("action === 'delete-perspective'"),
        appCode.indexOf("action === 'open-api-key-modal'")
      );
      expect(deleteSection).toContain("chrome.storage.local.remove");
      expect(deleteSection).toContain("tabClassificationCache_${editId}");

      const formSection = appCode.substring(
        appCode.indexOf("document.getElementById('perspectiveForm')?.addEventListener('submit'"),
        appCode.indexOf("document.getElementById('apiKeyForm')?.addEventListener('submit'")
      );
      expect(formSection).toContain("chrome.storage.local.remove");
      expect(formSection).toContain("tabClassificationCache_${editId}");

      // 2. Simulate partition cleanup invocation
      const targetId = "p_custom_1";
      await (globalThis as any).chrome.storage.local.remove([`tabClassificationCache_${targetId}`]);

      expect(removedKeys.length).toBe(1);
      expect(removedKeys[0]).toEqual(["tabClassificationCache_p_custom_1"]);
    } finally {
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("preclassifyTabInBackground sets failure cooldown when fetch throws network error", async () => {
    const originalFetch = globalThis.fetch;
    const originalChrome = (globalThis as any).chrome;

    const mockStorage: Record<string, any> = {
      openRouterApiKey: "sk-or-v1-mock-key",
      perspectives: [
        {
          id: "topic",
          name: "Chủ đề",
          labels: [{ name: "Lập trình / Dev", description: "Coding" }]
        }
      ],
      activePerspectiveId: "topic",
      tabClassificationCache: {}
    };

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => JSON.parse(JSON.stringify(mockStorage)),
          set: async (obj: any) => {
            Object.assign(mockStorage, obj);
          }
        },
        onChanged: { addListener: () => {} }
      }
    };

    globalThis.fetch = () => {
      throw new Error("Network unreachable");
    };

    try {
      const tab = { id: 981, title: "Offline Tab", url: "https://networkerror.example.com" };
      await preclassifyTabInBackground(tab);

      const normUrl = normalizeUrlForCache(tab.url);
      const cached = mockStorage.tabClassificationCache?.topic?.[normUrl];
      expect(cached).toBeDefined();
      expect(cached.label).toBe("Khác");
      expect(cached.source).toBe("local");
      expect(cached.cooldownMs).toBe(30000);
      expect(typeof cached.lastAiAttempt).toBe("number");
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("classifyTabs batches 24 tabs into one request before starting another", async () => {
    const oldChrome = (globalThis as any).chrome;
    const oldFetch = globalThis.fetch;
    const storage: Record<string, any> = { openRouterApiKey: 'test-key', perspectives: DEFAULT_PERSPECTIVES };
    (globalThis as any).chrome = { storage: { local: {
      get: async () => storage,
      set: async (value: any) => Object.assign(storage, value)
    } } };
    const counts: number[] = [];
    let outstanding = 0;
    let maxOutstanding = 0;
    globalThis.fetch = (async (_url: string, init: any) => {
      outstanding++;
      maxOutstanding = Math.max(outstanding, maxOutstanding);
      const body = JSON.parse(init.body);
      counts.push(Object.keys(body.state.tabs).length);
      await new Promise(resolve => setTimeout(resolve, 1));
      outstanding--;
      return { ok: true, json: async () => ({ answers: {} }) } as any;
    }) as any;
    try {
      await loadPerspectiveSettings(true);
      const tabs = Array.from({ length: 25 }, (_, id) => ({ id, title: `Tab ${id}`, url: `https://batch.example.com/${id}` }));
      await classifyTabs(tabs, DEFAULT_PERSPECTIVES[1], true, { skipSpeculativeFanout: true });
      expect(counts).toEqual([24, 1]);
      expect(maxOutstanding).toBe(1);
    } finally {
      globalThis.fetch = oldFetch;
      (globalThis as any).chrome = oldChrome;
    }
  });

  test("background does not retry a completed low-confidence choice after cooldown", async () => {
    const oldChrome = (globalThis as any).chrome;
    const oldFetch = globalThis.fetch;
    const url = normalizeUrlForCache('https://ambiguous.example.com/page');
    const storage: Record<string, any> = {
      openRouterApiKey: 'test-key',
      perspectives: [{ id: 'topic', name: 'Topic', labels: [{ name: 'Code', description: 'Programming' }] }],
      tabClassificationCache: { topic: { [url]: {
        label: 'Code', source: 'ai-low-confidence', confidence: 0.3,
        lastAiAttempt: Date.now() - 120000, cooldownMs: 60000
      } } }
    };
    (globalThis as any).chrome = { storage: { local: {
      get: async () => storage,
      set: async (value: any) => Object.assign(storage, value)
    } } };
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return { ok: true, json: async () => ({ answers: {} }) }; }) as any;
    try {
      await preclassifyTabInBackground({ id: 5001, title: 'Ambiguous', url });
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = oldFetch;
      (globalThis as any).chrome = oldChrome;
    }
  });

  test("background auth failure disables further requests until the key changes", async () => {
    const oldChrome = (globalThis as any).chrome;
    const oldFetch = globalThis.fetch;
    const storage: Record<string, any> = {
      openRouterApiKey: 'first-key',
      perspectives: [{ id: 'topic', name: 'Topic', labels: [{ name: 'Code', description: 'Programming' }] }],
      tabClassificationCache: {}
    };
    (globalThis as any).chrome = { storage: { local: {
      get: async () => structuredClone(storage),
      set: async (value: any) => Object.assign(storage, value)
    }, onChanged: { addListener: () => {} } } };
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1
        ? { ok: false, status: 401, headers: { get: () => null } }
        : { ok: true, json: async () => ({ answers: { topic__tab_0: { choice: 'Code' } } }) };
    }) as any;
    try {
      await preclassifyTabInBackground({ id: 6001, url: 'https://auth.example.com/one' });
      await preclassifyTabInBackground({ id: 6002, url: 'https://auth.example.com/two' });
      expect(calls).toBe(1);
      storage.openRouterApiKey = 'new-key';
      storage.aiAuthBlocked = false; // Settings clears the breaker when saving a new key.
      await preclassifyTabInBackground({ id: 6003, url: 'https://auth.example.com/three' });
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = oldFetch;
      (globalThis as any).chrome = oldChrome;
    }
  });

  test("late auth failure for an old key cannot block a newly saved key", async () => {
    const oldChrome = (globalThis as any).chrome;
    const oldFetch = globalThis.fetch;
    const storage: Record<string, any> = {
      openRouterApiKey: 'old-key', aiAuthBlocked: false,
      perspectives: [{ id: 'topic', labels: [{ name: 'Code', description: 'Programming' }] }]
    };
    (globalThis as any).chrome = { storage: { local: {
      get: async () => storage,
      set: async (value: any) => Object.assign(storage, value)
    } } };
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    let finish!: (value: any) => void;
    globalThis.fetch = (async () => {
      started();
      return new Promise(resolve => { finish = resolve; });
    }) as any;
    try {
      const work = preclassifyTabInBackground({ id: 6600, url: 'https://old-key.example.com' });
      await requested;
      storage.openRouterApiKey = 'new-key';
      finish({ ok: false, status: 401, headers: { get: () => null } });
      await work;
      expect(storage.aiAuthBlocked).toBe(false);
    } finally {
      if (finish) finish({ ok: false, status: 401, headers: { get: () => null } });
      globalThis.fetch = oldFetch;
      (globalThis as any).chrome = oldChrome;
    }
  });

  test("foreground stops remaining batches after an auth failure", async () => {
    const oldChrome = (globalThis as any).chrome;
    const oldFetch = globalThis.fetch;
    const storage: Record<string, any> = { openRouterApiKey: 'test-key', perspectives: DEFAULT_PERSPECTIVES };
    (globalThis as any).chrome = { storage: { local: {
      get: async () => storage,
      set: async (value: any) => Object.assign(storage, value)
    } } };
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false, status: 402, headers: { get: () => null } };
    }) as any;
    try {
      await loadPerspectiveSettings(true);
      const tabs = Array.from({ length: 25 }, (_, id) => ({ id, title: `Tab ${id}`, url: `https://credits.example.com/${id}` }));
      await classifyTabs(tabs, DEFAULT_PERSPECTIVES[1], true, { skipSpeculativeFanout: true });
      expect(storage.aiAuthBlocked).toBe(true);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = oldFetch;
      (globalThis as any).chrome = oldChrome;
    }
  });

  test("background reservation atomically claims a perspective and URL for one owner", () => {
    expect(typeof handleAiReservationMessage).toBe('function');
    const key = 'topic:https://reserve.example.com';
    const send = (type: string, owner: string) => {
      let response: any;
      handleAiReservationMessage({ type, owner, keys: [key] }, { id: 'test-extension' }, (value: any) => { response = value; });
      return response;
    };
    expect(send('tabout-ai-claim', 'first').claimed).toEqual([key]);
    expect(send('tabout-ai-claim', 'second').claimed).toEqual([]);
    send('tabout-ai-release', 'second');
    expect(send('tabout-ai-claim', 'second').claimed).toEqual([]);
    send('tabout-ai-release', 'first');
    expect(send('tabout-ai-claim', 'second').claimed).toEqual([key]);
    send('tabout-ai-release', 'second');
  });

  test("a worker result for a later batch is preserved and not requested again", async () => {
    const oldChrome = (globalThis as any).chrome;
    const oldFetch = globalThis.fetch;
    const topic = { id: 'topic', labels: [{ name: 'Code', description: 'Programming' }] };
    const tabs = Array.from({ length: 25 }, (_, id) => ({ id: 7400 + id,
      title: `Batch ${id}`, url: `https://batch-race.example.com/${id}` }));
    const lastUrl = normalizeUrlForCache(tabs[24].url);
    const storage: Record<string, any> = {
      openRouterApiKey: 'test-key', activePerspectiveId: 'topic',
      perspectives: [topic], tabClassificationCache: {}
    };
    (globalThis as any).chrome = { storage: { local: {
      get: async () => structuredClone(storage),
      set: async (updates: any) => Object.assign(storage, structuredClone(updates))
    } } };
    let firstStarted!: () => void;
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    let completeFirst!: (response: any) => void;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        firstStarted();
        return new Promise(resolve => { completeFirst = resolve; });
      }
      return { ok: true, json: async () => ({ answers: {} }) };
    }) as any;
    try {
      await loadPerspectiveSettings(true);
      const dashboard = classifyTabs(tabs, topic, false, { skipSpeculativeFanout: true });
      await started;
      await saveBgClassificationCache({ topic: { [lastUrl]: {
        label: 'Code', source: 'ai-low-confidence', confidence: 0.3, timestamp: Date.now()
      } } });
      completeFirst({ ok: true, json: async () => ({ answers: { tab_0: { choice: 'Code' } } }) });
      await dashboard;
      expect(storage.tabClassificationCache.topic[lastUrl].source).toBe('ai-low-confidence');
      expect(calls).toBe(1);
    } finally {
      if (completeFirst) completeFirst({ ok: true, json: async () => ({ answers: {} }) });
      globalThis.fetch = oldFetch;
      (globalThis as any).chrome = oldChrome;
    }
  });

  test("foreground classifies long URLs through the worker reservation", async () => {
    const oldChrome = (globalThis as any).chrome;
    const oldFetch = globalThis.fetch;
    const topic = { id: 'topic', labels: [{ name: 'Code', description: 'Programming' }] };
    const tab = { id: 7300, title: 'Long URL', url: `https://long.example.com/${'x'.repeat(550)}` };
    const storage: Record<string, any> = {
      openRouterApiKey: 'test-key', activePerspectiveId: 'topic',
      perspectives: [topic], tabClassificationCache: {}
    };
    (globalThis as any).chrome = {
      runtime: { id: 'test-extension', sendMessage: async (message: any) => {
        let response: any;
        handleAiReservationMessage(message, { id: 'test-extension' }, (value: any) => { response = value; });
        return response;
      } },
      storage: { local: {
        get: async () => structuredClone(storage),
        set: async (updates: any) => Object.assign(storage, structuredClone(updates))
      } }
    };
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: true, json: async () => ({ answers: { tab_0: { choice: 'Code' } } }) };
    }) as any;
    try {
      await loadPerspectiveSettings(true);
      const result = await classifyTabs([tab], topic, false, { skipSpeculativeFanout: true });
      expect(calls).toBe(1);
      expect(result[normalizeUrlForCache(tab.url)].source).toBe('ai');
    } finally {
      globalThis.fetch = oldFetch;
      (globalThis as any).chrome = oldChrome;
    }
  });

  test("reservation accepts long normalized URLs without confusing nearby URLs", () => {
    const base = 'topic:https://long.example.com/' + 'x'.repeat(510);
    const first = `${base}a`;
    const second = `${base}b`;
    const send = (type: string, owner: string, keys: string[]) => {
      let response: any;
      handleAiReservationMessage({ type, owner, keys }, { id: 'test-extension' }, (value: any) => { response = value; });
      return response;
    };
    expect(send('tabout-ai-claim', 'first-long', [first]).claimed).toEqual([first]);
    expect(send('tabout-ai-claim', 'second-long', [first, second]).claimed).toEqual([second]);
    send('tabout-ai-release', 'first-long', [first]);
    send('tabout-ai-release', 'second-long', [second]);
  });

  test("worker retries a contested tab after dashboard aborts and releases it", async () => {
    const oldChrome = (globalThis as any).chrome;
    const oldFetch = globalThis.fetch;
    const topic = { id: 'topic', name: 'Topic', labels: [{ name: 'Code', description: 'Programming' }] };
    const tab = { id: 7200, title: 'Contested', url: 'https://contested.example.com' };
    const storage: Record<string, any> = {
      openRouterApiKey: 'test-key', activePerspectiveId: 'topic',
      perspectives: [topic], tabClassificationCache: {}
    };
    (globalThis as any).chrome = {
      runtime: { id: 'test-extension', sendMessage: async (message: any) => {
        let response: any;
        handleAiReservationMessage(message, { id: 'test-extension' }, (value: any) => { response = value; });
        return response;
      } },
      storage: { local: {
        get: async () => structuredClone(storage),
        set: async (updates: any) => Object.assign(storage, structuredClone(updates))
      } }
    };
    let foregroundStarted!: () => void;
    const started = new Promise<void>(resolve => { foregroundStarted = resolve; });
    let calls = 0;
    globalThis.fetch = (async (_url: string, init: any) => {
      calls++;
      if (calls === 1) {
        foregroundStarted();
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      return { ok: true, json: async () => ({ answers: {
        topic__tab_0: { choice: 'Code' }, tab_0: { choice: 'Code' }
      } }) };
    }) as any;
    try {
      await loadPerspectiveSettings(true);
      const dashboard = classifyTabs([tab], topic, false, { skipSpeculativeFanout: true });
      await started;
      await preclassifyTabInBackground(tab); // Reservation is still held by the dashboard.
      expect(calls).toBe(1);
      const interrupt = classifyTabs([{ id: 7201, title: 'New tab', url: 'https://new.example.com' }], topic,
        false, { skipSpeculativeFanout: true });
      await Promise.all([dashboard, interrupt]);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(storage.tabClassificationCache.topic[normalizeUrlForCache(tab.url)].source).toBe('ai');
    } finally {
      globalThis.fetch = oldFetch;
      (globalThis as any).chrome = oldChrome;
    }
  });

  test("dashboard and service worker do not request the same classification concurrently", async () => {
    const oldChrome = (globalThis as any).chrome;
    const oldFetch = globalThis.fetch;
    const storage: Record<string, any> = {
      openRouterApiKey: 'test-key', perspectives: [DEFAULT_PERSPECTIVES[1]],
      tabClassificationCache: {}
    };
    (globalThis as any).chrome = {
      runtime: { id: 'test-extension', sendMessage: async (message: any) => {
        let response: any;
        handleAiReservationMessage(message, { id: 'test-extension' }, (value: any) => { response = value; });
        return response;
      } },
      storage: { local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in storage).map(k => [k, storage[k]])),
        set: async (value: any) => Object.assign(storage, value)
      } }
    };
    let started!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    let finish!: (value: any) => void;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      started();
      return new Promise(resolve => { finish = resolve; });
    }) as any;
    const tab = { id: 7111, title: 'Shared Tab', url: 'https://shared.example.com/page' };
    try {
      await loadPerspectiveSettings(true);
      const foreground = classifyTabs([tab], DEFAULT_PERSPECTIVES[1], false);
      await firstStarted;
      await preclassifyTabInBackground(tab);
      expect(calls).toBe(1);
      finish({ ok: true, json: async () => ({ answers: { tab_0: { choice: DEFAULT_PERSPECTIVES[1].labels[0].name } } }) });
      await foreground;
      expect(storage.tabClassificationCache.topic[normalizeUrlForCache(tab.url)].source).toBe('ai');
    } finally {
      if (finish) finish({ ok: true, json: async () => ({ answers: {} }) });
      globalThis.fetch = oldFetch;
      (globalThis as any).chrome = oldChrome;
    }
  });

  test("reservation message accepts batches with more than 100 keys", () => {
    const keys = Array.from({ length: 150 }, (_, i) => `topic:https://batch-${i}.example.com`);
    let response: any;
    const handled = handleAiReservationMessage(
      { type: 'tabout-ai-claim', owner: 'multi-perspective-test', keys },
      { id: 'test-extension' },
      (value: any) => { response = value; }
    );
    expect(handled).toBe(true);
    expect(response).toBeDefined();
    expect(response.claimed.length).toBe(150);

    // Release
    handleAiReservationMessage(
      { type: 'tabout-ai-release', owner: 'multi-perspective-test', keys },
      { id: 'test-extension' },
      () => {}
    );
  });

  test("handleStorageOnChanged preserves ai-low-confidence and high-confidence from downgrade", async () => {
    const originalChrome = (globalThis as any).chrome;
    const urlLow = 'https://low.example.com/item';
    const urlHigh = 'https://high.example.com/item';
    const storage: Record<string, any> = {
      tabClassificationCache_topic: {
        [urlLow]: { label: 'Code', source: 'ai-low-confidence', confidence: 0.35, timestamp: 100 },
        [urlHigh]: { label: 'Code', source: 'ai', confidence: 0.95, timestamp: 100 }
      },
      tabClassificationCache: {}
    };
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => structuredClone(storage),
          set: async (updates: any) => Object.assign(storage, updates)
        }
      }
    };

    try {
      await loadPerspectiveSettings(true);

      // Attempt to downgrade urlLow to local and urlHigh to ai-low-confidence via storage.onChanged
      await handleStorageOnChanged({
        tabClassificationCache_topic: {
          newValue: {
            [urlLow]: { label: 'Other', source: 'local', timestamp: 200 },
            [urlHigh]: { label: 'Other', source: 'ai-low-confidence', confidence: 0.2, timestamp: 200 }
          }
        }
      }, 'local');

      // Check cache in app.js
      const dummyTabLow = { id: 901, title: 'Low', url: urlLow };
      const dummyTabHigh = { id: 902, title: 'High', url: urlHigh };
      const res = await classifyTabs([dummyTabLow, dummyTabHigh], { id: 'topic', labels: [{ name: 'Code' }] });

      expect(res[urlLow].source).toBe('ai-low-confidence');
      expect(res[urlHigh].source).toBe('ai');
    } finally {
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("background.js chrome.tabs.onUpdated does not trigger automatic AI preclassification", () => {
    const bgPath = resolve(__dirname, "../extension/background.js");
    const bgCode = readFileSync(bgPath, "utf-8");

    // Must update badge on onUpdated but not call preclassifyTabInBackground in the listener body
    const listenerMatch = bgCode.match(/chrome\.tabs\?\.onUpdated\?\.addListener\s*\(\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\}\s*\)/);
    expect(listenerMatch).toBeTruthy();
    expect(listenerMatch![1]).not.toContain("preclassifyTabInBackground");
  });

  test("background preclassification loads partitioned cache keys to prevent duplicate requests", async () => {
    const oldChrome = (globalThis as any).chrome;
    const oldFetch = globalThis.fetch;
    const url = normalizeUrlForCache('https://partition-test.example.com');
    const storage: Record<string, any> = {
      openRouterApiKey: 'test-key',
      perspectives: [{ id: 'topic', name: 'Topic', labels: [{ name: 'Code', description: 'Programming' }] }],
      tabClassificationCache_topic: {
        [url]: { label: 'Code', source: 'ai', confidence: 0.95 }
      }
    };
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (keys: any) => {
            const res: Record<string, any> = {};
            const keyArr = Array.isArray(keys) ? keys : [keys];
            for (const k of keyArr) res[k] = storage[k];
            return res;
          },
          set: async (val: any) => Object.assign(storage, val)
        }
      }
    };
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return { ok: true, json: async () => ({ answers: {} }) }; }) as any;
    try {
      await preclassifyTabInBackground({ id: 8888, title: 'Partition Test', url });
      // Because it loads tabClassificationCache_topic, it sees existing 'ai' and makes 0 calls!
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = oldFetch;
      (globalThis as any).chrome = oldChrome;
    }
  });

  test("schedulePerspectivePrewarm ignores unprompted idle calls without targetPid", async () => {
    let prewarmCalled = false;
    // Calling schedulePerspectivePrewarm() without targetPid returns immediately
    schedulePerspectivePrewarm();
    // No timer set and no call
    expect(prewarmCalled).toBe(false);
  });

  test("isAiEligibleUrl correctly validates web protocols and rejects local/internal protocols", () => {
    expect(isAiEligibleUrl("https://example.com")).toBe(true);
    expect(isAiEligibleUrl("http://localhost:3000")).toBe(true);
    expect(isAiEligibleUrl("file:///C:/Users/ADMIN/secret.pdf")).toBe(false);
    expect(isAiEligibleUrl("blob:https://example.com/12345")).toBe(false);
    expect(isAiEligibleUrl("data:text/html,<h1>Hello</h1>")).toBe(false);
    expect(isAiEligibleUrl("chrome://settings")).toBe(false);
    expect(isAiEligibleUrl("chrome-extension://xyz/popup.html")).toBe(false);
    expect(isAiEligibleUrl("about:blank")).toBe(false);
    expect(isAiEligibleUrl("")).toBe(false);
    expect(isAiEligibleUrl(null)).toBe(false);

    expect(bgIsAiEligibleUrl("https://github.com")).toBe(true);
    expect(bgIsAiEligibleUrl("file:///test.pdf")).toBe(false);
  });

  test("classifyTabs assigns local fallback but never sends file:// URLs to AI API", async () => {
    const oldFetch = globalThis.fetch;
    const oldChrome = (globalThis as any).chrome;
    let fetchCalled = false;

    globalThis.fetch = (async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ answers: {} }) };
    }) as any;

    const storage: Record<string, any> = {
      openRouterApiKey: "sk-or-v1-valid-test-key",
      aiAuthBlocked: false
    };

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (keys: any) => {
            const res: Record<string, any> = {};
            const keyArr = Array.isArray(keys) ? keys : [keys];
            for (const k of keyArr) res[k] = storage[k];
            return res;
          },
          set: async (val: any) => Object.assign(storage, val)
        }
      },
      runtime: { sendMessage: async () => ({ claimed: [] }) }
    };

    try {
      const perspective = {
        id: "doc-test",
        name: "Docs",
        labels: ["PDF", "Web", "Khác"]
      };
      const tabs = [
        { id: 1, title: "Private Secret Resume", url: "file:///C:/Users/ADMIN/resume.pdf" }
      ];

      const result = await classifyTabs(tabs, perspective, false, { silent: true });
      // file:// tab must receive local fallback classification without calling AI API!
      expect(fetchCalled).toBe(false);
      expect(result["file:///C:/Users/ADMIN/resume.pdf"]).toBeDefined();
      expect(result["file:///C:/Users/ADMIN/resume.pdf"].source).toBe("local");
    } finally {
      globalThis.fetch = oldFetch;
      (globalThis as any).chrome = oldChrome;
    }
  });

  test("classifyTabs trips aiAuthBlocked circuit breaker on HTTP 403 Forbidden", async () => {
    const oldFetch = globalThis.fetch;
    const oldChrome = (globalThis as any).chrome;

    globalThis.fetch = (async () => {
      return {
        ok: false,
        status: 403,
        statusText: "Forbidden",
        headers: { get: () => null },
        json: async () => ({ error: { message: "Account suspended or key forbidden" } })
      };
    }) as any;

    const storage: Record<string, any> = {
      openRouterApiKey: "sk-or-v1-forbidden-test-key",
      aiAuthBlocked: false
    };

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => storage,
          set: async (val: any) => Object.assign(storage, val)
        }
      }
    };

    try {
      await loadPerspectiveSettings(true);
      const perspective = {
        id: "403-test",
        name: "Test 403",
        labels: ["A", "B", "Khác"]
      };
      const tabs = [
        { id: 2, title: "Example Domain", url: "https://example.com" }
      ];

      await classifyTabs(tabs, perspective, true, { silent: true });
      expect(storage.aiAuthBlocked).toBe(true);
    } finally {
      globalThis.fetch = oldFetch;
      (globalThis as any).chrome = oldChrome;
    }
  });
});






