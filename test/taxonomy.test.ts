import { expect, test, describe } from "bun:test";

const {
  PERSPECTIVE_TEMPLATES,
  getPerspectiveTemplate,
  localFallbackClassify,
  CATEGORY_RULES
} = require("../extension/app.js");

describe("Taxonomy Redesign — Target Audience Alignment (TDD)", () => {
  describe("Topic Perspective Template", () => {
    test("defines Education & Study for academic and student needs (EN & VI)", () => {
      const topicEn = getPerspectiveTemplate("topic", "en");
      const eduEn = topicEn.labels.find((l: any) => l.name === "Education & Study");
      expect(eduEn).toBeDefined();
      expect(eduEn.description.length).toBeGreaterThan(15);
      expect(eduEn.description.toLowerCase()).toContain("coursework");

      const topicVi = getPerspectiveTemplate("topic", "vi");
      const eduVi = topicVi.labels.find((l: any) => l.name === "Giáo dục & Học tập");
      expect(eduVi).toBeDefined();
      expect(eduVi.description.length).toBeGreaterThan(15);
    });

    test("updates Work & Email to modern Work & Productivity (EN & VI)", () => {
      const topicEn = getPerspectiveTemplate("topic", "en");
      expect(topicEn.labels.some((l: any) => l.name === "Work & Email")).toBe(false);
      const workEn = topicEn.labels.find((l: any) => l.name === "Work & Productivity");
      expect(workEn).toBeDefined();
      expect(workEn.description.length).toBeGreaterThan(15);

      const topicVi = getPerspectiveTemplate("topic", "vi");
      expect(topicVi.labels.some((l: any) => l.name === "Công việc / Email")).toBe(false);
      const workVi = topicVi.labels.find((l: any) => l.name === "Công việc & Năng suất");
      expect(workVi).toBeDefined();
      expect(workVi.description.length).toBeGreaterThan(15);
    });

    test("modernizes AI tag to AI & Assistants covering chat/search tools (EN & VI)", () => {
      const topicEn = getPerspectiveTemplate("topic", "en");
      const aiEn = topicEn.labels.find((l: any) => l.name === "AI & Assistants");
      expect(aiEn).toBeDefined();
      expect(aiEn.description.length).toBeGreaterThan(15);

      const topicVi = getPerspectiveTemplate("topic", "vi");
      const aiVi = topicVi.labels.find((l: any) => l.name === "AI & Trợ lý ảo");
      expect(aiVi).toBeDefined();
      expect(aiVi.description.length).toBeGreaterThan(15);
    });

    test("includes Shopping & Finance to cover online purchases and banking/finances", () => {
      const topicEn = getPerspectiveTemplate("topic", "en");
      const shopEn = topicEn.labels.find((l: any) => l.name === "Shopping & Finance");
      expect(shopEn).toBeDefined();
      expect(shopEn.description.length).toBeGreaterThan(15);

      const topicVi = getPerspectiveTemplate("topic", "vi");
      const shopVi = topicVi.labels.find((l: any) => l.name === "Mua sắm & Tài chính");
      expect(shopVi).toBeDefined();
      expect(shopVi.description.length).toBeGreaterThan(15);
    });

    test("every topic label provides a descriptive rubric for LLM classification", () => {
      const topicEn = getPerspectiveTemplate("topic", "en");
      for (const label of topicEn.labels) {
        if (label.name !== "Other") {
          expect(label.description).toBeDefined();
          expect(label.description.trim().length).toBeGreaterThan(10);
        }
      }

      const topicVi = getPerspectiveTemplate("topic", "vi");
      for (const label of topicVi.labels) {
        if (label.name !== "Khác") {
          expect(label.description).toBeDefined();
          expect(label.description.trim().length).toBeGreaterThan(10);
        }
      }
    });
  });

  describe("Purpose Perspective Template", () => {
    test("replaces Temporary with Study & Learning (EN & VI)", () => {
      const purposeEn = getPerspectiveTemplate("purpose", "en");
      expect(purposeEn.labels.some((l: any) => l.name === "Temporary")).toBe(false);
      const studyEn = purposeEn.labels.find((l: any) => l.name === "Study & Learning");
      expect(studyEn).toBeDefined();
      expect(studyEn.description.length).toBeGreaterThan(15);

      const purposeVi = getPerspectiveTemplate("purpose", "vi");
      expect(purposeVi.labels.some((l: any) => l.name === "Tạm thời")).toBe(false);
      const studyVi = purposeVi.labels.find((l: any) => l.name === "Học tập & Nghiên cứu");
      expect(studyVi).toBeDefined();
      expect(studyVi.description.length).toBeGreaterThan(15);
    });

    test("all purpose labels have meaningful descriptions for AI intent recognition", () => {
      const purposeEn = getPerspectiveTemplate("purpose", "en");
      for (const label of purposeEn.labels) {
        if (label.name !== "Other") {
          expect(label.description.trim().length).toBeGreaterThan(10);
        }
      }
    });
  });

  describe("Local Heuristic & Category Rules Integration", () => {
    test("classifies academic papers and university tools to Education & Study", () => {
      const topicEn = getPerspectiveTemplate("topic", "en");
      const arxivTab = { title: "Attention Is All You Need - Paper", url: "https://arxiv.org/abs/1706.03762" };
      const scholarTab = { title: "Google Scholar Profile", url: "https://scholar.google.com/citations?user=123" };
      const wikiTab = { title: "Photosynthesis - Wikipedia", url: "https://en.wikipedia.org/wiki/Photosynthesis" };
      const canvasTab = { title: "CS101 Assignment 2 - Canvas LMS", url: "https://canvas.instructure.com/courses/1" };

      expect(localFallbackClassify(arxivTab, topicEn.labels)).toBe("Education & Study");
      expect(localFallbackClassify(scholarTab, topicEn.labels)).toBe("Education & Study");
      expect(localFallbackClassify(wikiTab, topicEn.labels)).toBe("Education & Study");
      expect(localFallbackClassify(canvasTab, topicEn.labels)).toBe("Education & Study");
    });

    test("classifies work and productivity tools to Work & Productivity", () => {
      const topicEn = getPerspectiveTemplate("topic", "en");
      const notionTab = { title: "Q3 Sprint Planning - Notion", url: "https://notion.so/workspace/sprint-q3" };
      const slackTab = { title: "General | Slack", url: "https://slack.com/client/T01/C02" };
      const linearTab = { title: "LIN-102 Fix modal glitch - Linear", url: "https://linear.app/team/issue/LIN-102" };

      expect(localFallbackClassify(notionTab, topicEn.labels)).toBe("Work & Productivity");
      expect(localFallbackClassify(slackTab, topicEn.labels)).toBe("Work & Productivity");
      expect(localFallbackClassify(linearTab, topicEn.labels)).toBe("Work & Productivity");
    });

    test("classifies AI assistants to AI & Assistants", () => {
      const topicEn = getPerspectiveTemplate("topic", "en");
      const gptTab = { title: "ChatGPT - Research assistant", url: "https://chatgpt.com/c/abc-123" };
      const claudeTab = { title: "Claude AI chat", url: "https://claude.ai/chat/abc" };
      const perplexityTab = { title: "Perplexity AI search", url: "https://perplexity.ai/search?q=query" };

      expect(localFallbackClassify(gptTab, topicEn.labels)).toBe("AI & Assistants");
      expect(localFallbackClassify(claudeTab, topicEn.labels)).toBe("AI & Assistants");
      expect(localFallbackClassify(perplexityTab, topicEn.labels)).toBe("AI & Assistants");
    });

    test("classifies tabs accurately under Vietnamese topic template (Song ngữ VI)", () => {
      const topicVi = getPerspectiveTemplate("topic", "vi");
      const arxivTab = { title: "Deep Learning Research Paper", url: "https://arxiv.org/abs/2101.0001" };
      const slackTab = { title: "Slack Meeting Channel", url: "https://app.slack.com/client/T1/C2" };
      const chatGptTab = { title: "ChatGPT Tra cứu", url: "https://chatgpt.com/c/123" };
      const shopeeTab = { title: "Shopee Mua Sắm Online", url: "https://shopee.vn/product/99" };

      expect(localFallbackClassify(arxivTab, topicVi.labels)).toBe("Giáo dục & Học tập");
      expect(localFallbackClassify(slackTab, topicVi.labels)).toBe("Công việc & Năng suất");
      expect(localFallbackClassify(chatGptTab, topicVi.labels)).toBe("AI & Trợ lý ảo");
      expect(localFallbackClassify(shopeeTab, topicVi.labels)).toBe("Mua sắm & Tài chính");
    });
  });
});
