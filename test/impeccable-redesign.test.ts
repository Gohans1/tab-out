import { expect, test, describe } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const appPath = resolve(__dirname, "../extension/app.js");
const i18nPath = resolve(__dirname, "../extension/i18n.js");
const indexPath = resolve(__dirname, "../extension/index.html");

const {
  DEFAULT_PERSPECTIVES,
  PERSPECTIVE_TEMPLATES,
  getPerspectiveTemplate
} = require("../extension/app.js");

describe("Impeccable Overhaul — Pillar 1: Clean Perspectives & Templates", () => {
  test("DEFAULT_PERSPECTIVES contains only domain by default (Pure Custom Mental Model)", () => {
    expect(Array.isArray(DEFAULT_PERSPECTIVES)).toBe(true);
    expect(DEFAULT_PERSPECTIVES.length).toBe(1);
    expect(DEFAULT_PERSPECTIVES[0].id).toBe("domain");
    expect(DEFAULT_PERSPECTIVES[0].isSystem).toBe(true);
  });

  test("PERSPECTIVE_TEMPLATES defines topic and purpose with bilingual tag sets", () => {
    expect(PERSPECTIVE_TEMPLATES).toBeDefined();
    expect(PERSPECTIVE_TEMPLATES.topic).toBeDefined();
    expect(PERSPECTIVE_TEMPLATES.purpose).toBeDefined();

    // Verify English templates have pure English tags
    const topicEn = getPerspectiveTemplate("topic", "en");
    expect(topicEn).toBeDefined();
    expect(topicEn.name).toBe("Topic");
    expect(topicEn.labels.some((l: any) => l.name === "Development")).toBe(true);
    expect(topicEn.labels.some((l: any) => l.name === "Lập trình / Dev")).toBe(false);

    // Verify Vietnamese templates have pure Vietnamese tags
    const topicVi = getPerspectiveTemplate("topic", "vi");
    expect(topicVi).toBeDefined();
    expect(topicVi.name).toBe("Chủ đề");
    expect(topicVi.labels.some((l: any) => l.name === "Lập trình / Dev")).toBe(true);
  });

  test("PERSPECTIVE_TEMPLATES defines priority template with bilingual sets", () => {
    expect(PERSPECTIVE_TEMPLATES.priority).toBeDefined();

    const priorityEn = getPerspectiveTemplate("priority", "en");
    expect(priorityEn).toBeDefined();
    expect(priorityEn.name).toBe("Priority");
    expect(priorityEn.labels.some((l: any) => l.name === "Urgent / Immediate")).toBe(true);

    const priorityVi = getPerspectiveTemplate("priority", "vi");
    expect(priorityVi).toBeDefined();
    expect(priorityVi.name).toBe("Ưu tiên");
    expect(priorityVi.labels.some((l: any) => l.name === "Khẩn cấp / Làm ngay")).toBe(true);
  });

  test("PERSPECTIVE_ICONS defines SVGs for all template icon keys including alert-circle", () => {
    const { PERSPECTIVE_ICONS } = require("../extension/app.js");
    expect(PERSPECTIVE_ICONS).toBeDefined();
    expect(PERSPECTIVE_ICONS["alert-circle"]).toBeDefined();
    expect(PERSPECTIVE_ICONS["alert-circle"]).toContain("<svg");
    expect(PERSPECTIVE_ICONS["tag"]).toBeDefined();
    expect(PERSPECTIVE_ICONS["target"]).toBeDefined();
  });
});

describe("Impeccable Overhaul — Pillar 3: Jargon Removal & Grammar Fixes", () => {
  test("i18n translations do NOT contain internal developer jargon", () => {
    const i18nCode = readFileSync(i18nPath, "utf-8");
    expect(i18nCode).not.toContain("~typesafe/jev-latest");
    expect(i18nCode).not.toContain("Decisions API");
    expect(i18nCode).not.toContain("OpenRouter Jev phân loại");
  });

  test("index.html does not contain hardcoded technical jargon or un-localized dupe banner text", () => {
    const html = readFileSync(indexPath, "utf-8");
    expect(html).not.toContain("~typesafe/jev-latest");
    expect(html).not.toContain("Decisions API");
  });

  test("English grammar supports proper singular for 1 open tab", () => {
    const i18nCode = readFileSync(i18nPath, "utf-8");
    const mockStorage: Record<string, any> = {};
    const context: Record<string, any> = {
      window: {},
      navigator: { language: "en-US" },
      document: { querySelectorAll: () => [] },
      chrome: {
        storage: {
          local: {
            get: (_k: any, cb: (r: any) => void) => cb(mockStorage),
            set: (o: any, cb?: () => void) => { Object.assign(mockStorage, o); if (cb) cb(); }
          }
        }
      }
    };
    context.window = context;
    const runFn = new Function("window", "navigator", "document", "chrome", i18nCode);
    runFn(context, context.navigator, context.document, context.chrome);
    const i18n = context.TabOutI18n;

    i18n.setLanguage("en");
    expect(i18n.t("tabs.open_tabs_count_single", { count: 1 })).toMatch(/1 open tab$/);
  });
});

describe("Impeccable Overhaul — Pillar 2: Uniform Card Action Affordance", () => {
  const { renderMissionCard } = require("../extension/app.js");

  test("renderMissionCard renders a bottom action button even for 1-tab groups", () => {
    const singleTabGroup = {
      domain: "youtube.com",
      tabs: [{ id: 1, url: "https://youtube.com/watch?v=1", title: "Video" }],
      isLanding: false,
      isSemantic: false
    };

    const html = renderMissionCard(singleTabGroup, { "https://youtube.com/watch?v=1": 1 }, false, null);
    expect(html).toContain('data-action="close-domain-tabs"');
    expect(html).toContain('class="action-btn close-tabs"');
  });
});
