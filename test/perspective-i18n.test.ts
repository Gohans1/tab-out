import { expect, test, describe, afterAll } from "bun:test";

// Load real i18n module
const TabOutI18n = require("../extension/i18n.js");

const {
  PERSPECTIVE_TEMPLATES,
  getPerspectiveTemplate,
  getPerspectiveDisplayName,
  getPerspectiveDisplayLabels,
  isUnmodifiedTemplateLabels,
  resolvePerspectiveTemplateKey,
  getFallbackLabelName,
  isFallbackLabel
} = require("../extension/app.js");

describe("Perspective Template & i18n Alignment (TDD & Quality Verified)", () => {
  const origTabOutI18n = (globalThis as any).TabOutI18n;
  const origT = (globalThis as any).t;

  afterAll(() => {
    if (typeof TabOutI18n !== 'undefined' && TabOutI18n.setLanguage) {
      TabOutI18n.setLanguage('en');
    }
    if (origTabOutI18n !== undefined) {
      (globalThis as any).TabOutI18n = origTabOutI18n;
    } else {
      delete (globalThis as any).TabOutI18n;
    }
    if (origT !== undefined) {
      (globalThis as any).t = origT;
    } else {
      delete (globalThis as any).t;
    }
  });

  describe("Prototype Security & Hardening", () => {
    test("getPerspectiveTemplate safely returns null for Object prototype property keys", () => {
      expect(getPerspectiveTemplate("toString")).toBeNull();
      expect(getPerspectiveTemplate("valueOf")).toBeNull();
      expect(getPerspectiveTemplate("constructor")).toBeNull();
      expect(getPerspectiveTemplate("__proto__")).toBeNull();
      expect(getPerspectiveTemplate(null as any)).toBeNull();
      expect(getPerspectiveTemplate(undefined as any)).toBeNull();
      expect(getPerspectiveTemplate(123 as any)).toBeNull();
    });

    test("getPerspectiveDisplayName safely handles malicious prototype templateId without crashing", () => {
      const maliciousPerspective = {
        id: "p_evil",
        templateId: "toString",
        name: "My Custom Perspective",
        labels: []
      };
      // Should not throw TypeError and should fallback safely to p.name
      expect(() => getPerspectiveDisplayName(maliciousPerspective)).not.toThrow();
      expect(getPerspectiveDisplayName(maliciousPerspective)).toBe("My Custom Perspective");
    });
  });

  describe("Real i18n Integration & Perspective Display Names", () => {
    test("getPerspectiveDisplayName translates domain perspective using real i18n dictionaries", () => {
      const pDomain = { id: "domain", name: "Domain", labels: [] };

      TabOutI18n.setLanguage("en");
      expect(getPerspectiveDisplayName(pDomain)).toBe("Domain");

      TabOutI18n.setLanguage("vi");
      expect(getPerspectiveDisplayName(pDomain)).toBe("Tên miền");
    });

    test("getPerspectiveDisplayName translates priority template perspective to current locale", () => {
      const pPriority = { id: "priority", name: "Priority", labels: [] };

      TabOutI18n.setLanguage("en");
      expect(getPerspectiveDisplayName(pPriority)).toBe("Priority");

      TabOutI18n.setLanguage("vi");
      expect(getPerspectiveDisplayName(pPriority)).toBe("Ưu tiên");

      // Perspective originally saved with Vietnamese name switches correctly when language is EN
      const pPriorityVi = { id: "priority", name: "Ưu tiên", labels: [] };
      TabOutI18n.setLanguage("en");
      expect(getPerspectiveDisplayName(pPriorityVi)).toBe("Priority");
    });

    test("getPerspectiveDisplayName translates perspectives that have a templateId", () => {
      TabOutI18n.setLanguage("en");
      const customTopic = { id: "p_12345", templateId: "topic", name: "Chủ đề", labels: [] };
      expect(getPerspectiveDisplayName(customTopic)).toBe("Topic");

      TabOutI18n.setLanguage("vi");
      const customPriority = { id: "p_67890", templateId: "priority", name: "Priority", labels: [] };
      expect(getPerspectiveDisplayName(customPriority)).toBe("Ưu tiên");

      const customPurpose = { id: "p_11111", templateId: "purpose", name: "Purpose", labels: [] };
      expect(getPerspectiveDisplayName(customPurpose)).toBe("Mục đích");
    });

    test("getPerspectiveDisplayName preserves custom user-renamed perspective names", () => {
      TabOutI18n.setLanguage("en");
      const customRenamed = { id: "p_99999", templateId: "topic", name: "My Special Coding Projects", labels: [] };
      expect(getPerspectiveDisplayName(customRenamed)).toBe("My Special Coding Projects");

      TabOutI18n.setLanguage("vi");
      expect(getPerspectiveDisplayName(customRenamed)).toBe("My Special Coding Projects");
    });
  });

  describe("Fallback Label Alignment with Selected Language", () => {
    test("getFallbackLabelName returns 'Other' for EN and 'Khác' for VI", () => {
      expect(typeof getFallbackLabelName).toBe("function");
      expect(getFallbackLabelName("en")).toBe("Other");
      expect(getFallbackLabelName("vi")).toBe("Khác");
    });

    test("isFallbackLabel accepts both 'Other' and 'Khác' (case-insensitive)", () => {
      expect(isFallbackLabel("Other")).toBe(true);
      expect(isFallbackLabel("Khác")).toBe(true);
      expect(isFallbackLabel("other")).toBe(true);
      expect(isFallbackLabel("khác")).toBe(true);
      expect(isFallbackLabel("Custom Tag")).toBe(false);
      expect(isFallbackLabel("")).toBe(false);
    });
  });

  describe("Perspective Reset & Localized Template Loading", () => {
    test("getPerspectiveTemplate returns localized names and labels for topic, purpose, priority", () => {
      const enTopic = getPerspectiveTemplate("topic", "en");
      expect(enTopic.name).toBe("Topic");
      expect(enTopic.labels.some((l: any) => l.name === "Work & Productivity")).toBe(true);

      const viTopic = getPerspectiveTemplate("topic", "vi");
      expect(viTopic.name).toBe("Chủ đề");
      expect(viTopic.labels.some((l: any) => l.name === "Công việc & Năng suất")).toBe(true);

      const enPriority = getPerspectiveTemplate("priority", "en");
      expect(enPriority.name).toBe("Priority");
      expect(enPriority.labels.some((l: any) => l.name === "Urgent / Immediate")).toBe(true);

      const viPriority = getPerspectiveTemplate("priority", "vi");
      expect(viPriority.name).toBe("Ưu tiên");
      expect(viPriority.labels.some((l: any) => l.name === "Khẩn cấp / Làm ngay")).toBe(true);

      const enPurpose = getPerspectiveTemplate("purpose", "en");
      expect(enPurpose.name).toBe("Purpose");
      expect(enPurpose.labels.some((l: any) => l.name === "Focus Work")).toBe(true);

      const viPurpose = getPerspectiveTemplate("purpose", "vi");
      expect(viPurpose.name).toBe("Mục đích");
      expect(viPurpose.labels.some((l: any) => l.name === "Làm việc tập trung")).toBe(true);
    });
  });

  describe("Edit Perspective Modal Tag Localization (Unmodified Template Sync)", () => {
    test("isUnmodifiedTemplateLabels recognizes both EN and VI default template tag sets", () => {
      expect(typeof isUnmodifiedTemplateLabels).toBe("function");
      const enTopicTpl = getPerspectiveTemplate("topic", "en");
      const viTopicTpl = getPerspectiveTemplate("topic", "vi");

      expect(isUnmodifiedTemplateLabels(enTopicTpl.labels, "topic")).toBe(true);
      expect(isUnmodifiedTemplateLabels(viTopicTpl.labels, "topic")).toBe(true);

      // Modified tag list should return false
      const modifiedLabels = [...enTopicTpl.labels, { name: "Custom Project Tag", description: "" }];
      expect(isUnmodifiedTemplateLabels(modifiedLabels, "topic")).toBe(false);

      // Prototype property safety
      expect(isUnmodifiedTemplateLabels(enTopicTpl.labels, "toString")).toBe(false);
      expect(isUnmodifiedTemplateLabels(enTopicTpl.labels, "valueOf")).toBe(false);
    });

    test("getPerspectiveDisplayLabels switches unmodified template tags dynamically to active locale", () => {
      expect(typeof getPerspectiveDisplayLabels).toBe("function");
      // Perspective created in Vietnamese (just like user's screenshot!)
      const viTopicTpl = getPerspectiveTemplate("topic", "vi");
      const pSavedInVi = {
        id: "p_user_123",
        templateId: "topic",
        name: "Topic",
        labels: viTopicTpl.labels
      };

      // When app is in English, tags dynamically resolve to English
      TabOutI18n.setLanguage("en");
      const enLabels = getPerspectiveDisplayLabels(pSavedInVi, "en");
      expect(enLabels.some((l: any) => l.name === "Work & Productivity")).toBe(true);
      expect(enLabels.some((l: any) => l.name === "Công việc & Năng suất")).toBe(false);

      // When app is in Vietnamese, tags dynamically resolve to Vietnamese
      TabOutI18n.setLanguage("vi");
      const viLabels = getPerspectiveDisplayLabels(pSavedInVi, "vi");
      expect(viLabels.some((l: any) => l.name === "Công việc & Năng suất")).toBe(true);
      expect(viLabels.some((l: any) => l.name === "Work & Productivity")).toBe(false);
    });

    test("getPerspectiveDisplayLabels preserves custom user-modified tags without overwriting", () => {
      const customPerspective = {
        id: "p_custom_456",
        templateId: "topic",
        name: "My Custom Workflow",
        labels: [
          { name: "My Startup", description: "All tabs related to my new startup", color: "blue" },
          { name: "Personal Tax", description: "Tax filings", color: "amber" },
          { name: "Other", description: "", color: "" }
        ]
      };

      TabOutI18n.setLanguage("vi");
      const resultVi = getPerspectiveDisplayLabels(customPerspective, "vi");
      expect(resultVi.some((l: any) => l.name === "My Startup")).toBe(true);
      expect(resultVi.some((l: any) => l.name === "Công việc & Năng suất")).toBe(false);

      TabOutI18n.setLanguage("en");
      const resultEn = getPerspectiveDisplayLabels(customPerspective, "en");
      expect(resultEn.some((l: any) => l.name === "My Startup")).toBe(true);
    });

    test("resolvePerspectiveTemplateKey and legacy perspectives without templateId", () => {
      expect(typeof resolvePerspectiveTemplateKey).toBe("function");

      // Prototype pollution safety
      expect(resolvePerspectiveTemplateKey({ templateId: "toString" } as any)).toBeNull();
      expect(resolvePerspectiveTemplateKey({ id: "valueOf" } as any)).toBeNull();
      expect(resolvePerspectiveTemplateKey(null)).toBeNull();

      // Legacy perspective without templateId (stored before templateId was introduced)
      const legacyTopic = {
        id: "p_legacy_999",
        name: "Topic",
        labels: getPerspectiveTemplate("topic", "en").labels
      };

      // Successfully infers "topic" from unmodified labels/name
      expect(resolvePerspectiveTemplateKey(legacyTopic)).toBe("topic");

      // Dynamic localization works cleanly on legacy perspective
      TabOutI18n.setLanguage("vi");
      expect(getPerspectiveDisplayName(legacyTopic)).toBe("Chủ đề");
      const labelsVi = getPerspectiveDisplayLabels(legacyTopic, "vi");
      expect(labelsVi.some((l: any) => l.name === "Công việc & Năng suất")).toBe(true);

      TabOutI18n.setLanguage("en");
      expect(getPerspectiveDisplayName(legacyTopic)).toBe("Topic");
      const labelsEn = getPerspectiveDisplayLabels(legacyTopic, "en");
      expect(labelsEn.some((l: any) => l.name === "Work & Productivity")).toBe(true);
    });
  });
});

