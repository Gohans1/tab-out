import { expect, test, describe } from "bun:test";

const {
  DEFAULT_PERSPECTIVES,
  CATEGORY_RULES,
  localFallbackClassify,
  isFallbackLabel,
  buildChoiceCriteria
} = require("../extension/app.js");

describe("DEFAULT_PERSPECTIVES & Category Rules", () => {
  test("DEFAULT_PERSPECTIVES exports domain as default system perspective", () => {
    expect(Array.isArray(DEFAULT_PERSPECTIVES)).toBe(true);
    expect(DEFAULT_PERSPECTIVES.length).toBe(1);

    const domainP = DEFAULT_PERSPECTIVES.find((p: any) => p.id === "domain");
    expect(domainP).toBeDefined();
    expect(domainP.isSystem).toBe(true);
    expect(CATEGORY_RULES.length).toBeGreaterThan(0);
  });
});

describe("localFallbackClassify — Behavior & Rule Matching", () => {
  const defaultTopicLabels = [
    "AI & Machine Learning",
    "Lập trình / Dev",
    "Mạng xã hội",
    "Giải trí / Media",
    "Tin tức & Đọc báo",
    "Mua sắm",
    "Công việc / Email",
    "Khác / Chưa phân loại"
  ];

  test("classifies developer tools and repositories correctly", () => {
    expect(localFallbackClassify({ title: "Pull Request #42 · oven-sh/bun", url: "https://github.com/oven-sh/bun/pull/42" }, defaultTopicLabels)).toBe("Lập trình / Dev");
    expect(localFallbackClassify({ title: "Gist snippet", url: "https://gist.github.com/user/123" }, defaultTopicLabels)).toBe("Lập trình / Dev");
    expect(localFallbackClassify({ title: "GitLab Merge Request", url: "https://gitlab.com/project/merge_requests/1" }, defaultTopicLabels)).toBe("Lập trình / Dev");
    expect(localFallbackClassify({ title: "Stack Overflow - How to mock chrome API", url: "https://stackoverflow.com/questions/12345" }, defaultTopicLabels)).toBe("Lập trình / Dev");
  });

  test("classifies AI tools and platforms correctly", () => {
    expect(localFallbackClassify({ title: "ChatGPT", url: "https://chatgpt.com/c/uuid" }, defaultTopicLabels)).toBe("AI & Machine Learning");
    expect(localFallbackClassify({ title: "Claude AI", url: "https://claude.ai/chat/1" }, defaultTopicLabels)).toBe("AI & Machine Learning");
    expect(localFallbackClassify({ title: "Hugging Face - Models", url: "https://huggingface.co/models" }, defaultTopicLabels)).toBe("AI & Machine Learning");
    expect(localFallbackClassify({ title: "OpenRouter Dashboard", url: "https://openrouter.ai/keys" }, defaultTopicLabels)).toBe("AI & Machine Learning");
  });

  test("classifies social media correctly", () => {
    expect(localFallbackClassify({ title: "Home / X", url: "https://x.com/home" }, defaultTopicLabels)).toBe("Mạng xã hội");
    expect(localFallbackClassify({ title: "Reddit: Dive into anything", url: "https://reddit.com/r/programming" }, defaultTopicLabels)).toBe("Mạng xã hội");
    expect(localFallbackClassify({ title: "Facebook Feed", url: "https://facebook.com" }, defaultTopicLabels)).toBe("Mạng xã hội");
  });

  test("classifies entertainment and media correctly", () => {
    expect(localFallbackClassify({ title: "YouTube - Music Video", url: "https://youtube.com/watch?v=123" }, defaultTopicLabels)).toBe("Giải trí / Media");
    expect(localFallbackClassify({ title: "Netflix - Watch Movies", url: "https://netflix.com/browse" }, defaultTopicLabels)).toBe("Giải trí / Media");
    expect(localFallbackClassify({ title: "Spotify Web Player", url: "https://open.spotify.com" }, defaultTopicLabels)).toBe("Giải trí / Media");
  });

  test("classifies shopping platforms correctly", () => {
    expect(localFallbackClassify({ title: "Amazon.com: Deals", url: "https://amazon.com/dp/B000" }, defaultTopicLabels)).toBe("Mua sắm");
    expect(localFallbackClassify({ title: "Shopee Việt Nam", url: "https://shopee.vn/product/123" }, defaultTopicLabels)).toBe("Mua sắm");
  });

  test("classifies work and email tools correctly", () => {
    expect(localFallbackClassify({ title: "Gmail - Inbox", url: "https://mail.google.com/mail/u/0" }, defaultTopicLabels)).toBe("Công việc / Email");
    expect(localFallbackClassify({ title: "Slack | Engineering", url: "https://app.slack.com/client/T1/C1" }, defaultTopicLabels)).toBe("Công việc / Email");
    expect(localFallbackClassify({ title: "Notion Workspace", url: "https://notion.so/workspace" }, defaultTopicLabels)).toBe("Công việc / Email");
    expect(localFallbackClassify({ title: "Jira Dashboard", url: "https://jira.atlassian.com/browse/PROJ-1" }, defaultTopicLabels)).toBe("Công việc / Email");
  });

  test("matches custom perspective tags with rich descriptions", () => {
    const customPerspective = [
      { name: "Frontend", description: "React, CSS, Vite, HTML, Next.js" },
      { name: "Backend", description: "Database, PostgreSQL, Bun, Go, API" },
      { name: "Khác", description: "" }
    ];

    expect(localFallbackClassify({ title: "Next.js 15 Documentation", url: "https://nextjs.org/docs" }, customPerspective)).toBe("Frontend");
    expect(localFallbackClassify({ title: "PostgreSQL Tutorial", url: "https://postgresqltutorial.com" }, customPerspective)).toBe("Backend");
  });

  test("unmatched tabs fall back to isolated 'Khác' tag", () => {
    const perspectiveTags = [
      { name: "Công Nghệ & AI", description: "Trí tuệ nhân tạo, LLM, OpenAI, Claude" },
      { name: "Khác", description: "" }
    ];

    expect(localFallbackClassify({ title: "Cooking Recipe", url: "https://recipes.org/soup" }, perspectiveTags)).toBe("Khác");
    expect(localFallbackClassify({ title: "Motor Tuning", url: "https://motor.org/engine" }, perspectiveTags)).toBe("Khác");
  });

  test("safely handles null, undefined, or empty tab objects without throwing", () => {
    expect(localFallbackClassify(null, defaultTopicLabels)).toBe("Khác");
    expect(localFallbackClassify(undefined, defaultTopicLabels)).toBe("Khác");
    expect(localFallbackClassify({} as any, defaultTopicLabels)).toBe("Khác / Chưa phân loại");
    expect(localFallbackClassify({ title: "", url: "" }, defaultTopicLabels)).toBe("Khác / Chưa phân loại");
  });
});

describe("isFallbackLabel — Fallback Detection", () => {
  test("identifies all Vietnamese and English fallback variations", () => {
    expect(isFallbackLabel("Khác")).toBe(true);
    expect(isFallbackLabel("khác")).toBe(true);
    expect(isFallbackLabel("Other")).toBe(true);
    expect(isFallbackLabel("other")).toBe(true);
    expect(isFallbackLabel("Khác / Chưa phân loại")).toBe(true);
    expect(isFallbackLabel("Other / Unclassified")).toBe(true);
    expect(isFallbackLabel("misc")).toBe(true);
    expect(isFallbackLabel("chưa phân loại")).toBe(true);
    expect(isFallbackLabel("linh tinh")).toBe(true);
  });

  test("rejects valid non-fallback labels", () => {
    expect(isFallbackLabel("Khách hàng")).toBe(false);
    expect(isFallbackLabel("Khác biệt")).toBe(false);
    expect(isFallbackLabel("Otherwise")).toBe(false);
    expect(isFallbackLabel("Lập trình / Dev")).toBe(false);
    expect(isFallbackLabel("Công Nghệ & AI")).toBe(false);
  });

  test("handles empty, null, or undefined gracefully", () => {
    expect(isFallbackLabel("")).toBe(false);
    expect(isFallbackLabel(null)).toBe(false);
    expect(isFallbackLabel(undefined)).toBe(false);
  });
});

describe("buildChoiceCriteria — Prompt Optimization & Security", () => {
  test("uses concise tag name when description is empty to optimize prompt tokens", () => {
    const criteria = buildChoiceCriteria({
      labels: [
        { name: "Dev", description: "" },
        { name: "Design", description: "" }
      ]
    });

    expect(criteria["Dev"]).toBe("Dev");
    expect(criteria["Design"]).toBe("Design");
  });

  test("uses full description when provided", () => {
    const criteria = buildChoiceCriteria({
      labels: [
        { name: "Dev", description: "Software development and coding" }
      ]
    });

    expect(criteria["Dev"]).toBe("Software development and coding");
  });

  test("supports structured rubric objects", () => {
    const rubricObj = { include: ["arxiv", "papers"], exclude: ["shopping"] };
    const criteria = buildChoiceCriteria({
      labels: [
        {
          name: "Research",
          description: "General research",
          rubric: rubricObj
        }
      ]
    });

    expect(criteria["Research"]).toEqual(rubricObj);
  });

  test("rejects prototype pollution keys", () => {
    const criteria = buildChoiceCriteria({
      labels: [
        { name: "__proto__", description: "malicious" },
        { name: "constructor", description: "malicious" },
        { name: "prototype", description: "malicious" },
        { name: "SafeTag", description: "clean" }
      ]
    });

    expect(criteria["__proto__"]).toBeUndefined();
    expect(criteria["constructor"]).toBeUndefined();
    expect(criteria["prototype"]).toBeUndefined();
    expect(criteria["SafeTag"]).toBe("clean");
  });
});

describe("classifyTabs — Incognito Privacy & Data Protection", () => {
  const { classifyTabs } = require("../extension/app.js");

  test("never includes incognito tabs in AI request batch", async () => {
    let fetchCalled = false;
    const originalFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ answers: {} }));
    };

    const originalChrome = (globalThis as any).chrome;
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => ({
            openRouterApiKey: "test-key",
            tabClassificationCache_topic: {},
            perspectives: [{ id: "topic", name: "Topic", labels: [{ name: "Dev" }] }]
          }),
          set: async () => {}
        }
      },
      runtime: {
        sendMessage: async () => ({ claimed: [] })
      }
    };

    try {
      const tabs = [
        { id: 1, url: "https://secret-site.com", title: "Secret Tab", incognito: true }
      ];
      const perspective = { id: "topic", labels: [{ name: "Dev" }] };

      const result = await classifyTabs(tabs, perspective, true);
      // Incognito tab must be classified locally in-memory without calling external AI
      expect(result["https://secret-site.com/"]).toBeDefined();
      expect(result["https://secret-site.com/"].source).toBe("local");
      expect(fetchCalled).toBe(false);
    } finally {
      (globalThis as any).fetch = originalFetch;
      (globalThis as any).chrome = originalChrome;
    }
  });
});

