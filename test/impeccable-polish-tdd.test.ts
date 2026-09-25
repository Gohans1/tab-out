import { expect, test, describe } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const appPath = resolve(__dirname, "../extension/app.js");
const i18nPath = resolve(__dirname, "../extension/i18n.js");
const indexPath = resolve(__dirname, "../extension/index.html");
const cssPath = resolve(__dirname, "../extension/style.css");

function getI18n() {
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
  return context.TabOutI18n;
}

describe("TDD — Pillar 1: Pure Vietnamese Localization ('Thẻ' & 'Nhãn', zero 'tab' or 'tag' in VI UI)", () => {
  test("Vietnamese translation uses 'Thẻ' and completely eliminates 'tab' in user-facing texts", () => {
    const i18n = getI18n();
    i18n.setLanguage("vi");

    // Modal fallback hint must use 'thẻ' not 'tab'
    const fallbackHint = i18n.t("modal.perspective.fallback_hint");
    expect(fallbackHint).toContain("thẻ");
    expect(fallbackHint).not.toContain("tab");

    // API key help in modal settings
    const apiHelp = i18n.t("modal.settings.api_key_help");
    expect(apiHelp).toContain("thẻ");
    expect(apiHelp).not.toContain("tab");

    // Chip recent tooltip
    const recentTooltip = i18n.t("chip.recent_title");
    expect(recentTooltip).toContain("Thẻ");
    expect(recentTooltip).not.toContain("Tab");
  });

  test("Vietnamese translation uses 'Nhãn' and completely eliminates 'tag' in user-facing perspective modal", () => {
    const i18n = getI18n();
    i18n.setLanguage("vi");

    expect(i18n.t("modal.perspective.add_tag")).toBe("Thêm nhãn");
    expect(i18n.t("modal.perspective.delete_tag")).toBe("Xóa nhãn");
    expect(i18n.t("modal.perspective.tag_color")).toBe("Chọn màu nhãn");
    expect(i18n.t("modal.perspective.drag_tag")).toContain("nhãn");
    expect(i18n.t("modal.perspective.drag_tag")).not.toContain("tag");
    expect(i18n.t("modal.perspective.fallback_hint")).toContain("Nhãn \"Khác\"");
    expect(i18n.t("modal.perspective.fallback_hint")).not.toContain("Tag \"Khác\"");
  });

  test("Column 3 is cleanly translated as 'Đã lưu' in Vietnamese and 'Saved for later' in English", () => {
    const i18n = getI18n();
    i18n.setLanguage("vi");
    expect(i18n.t("saved.title")).toBe("Đã lưu");

    i18n.setLanguage("en");
    expect(i18n.t("saved.title")).toBe("Saved for later");
  });

  test("Column 3 Empty State defines rich title and actionable micro-copy in both languages", () => {
    const i18n = getI18n();
    i18n.setLanguage("vi");
    expect(i18n.t("saved.empty_title")).toBe("Chưa có thẻ nào được lưu");
    expect(i18n.t("saved.empty_hint")).toBe("Bấm biểu tượng lưu trên thẻ để cất vào đây xem lại sau");

    i18n.setLanguage("en");
    expect(i18n.t("saved.empty_title")).toBe("Nothing saved yet");
    expect(i18n.t("saved.empty_hint")).toBe("Click the save icon on any tab to keep it here for later");
  });

  test("Modal input placeholders are concise, informative and do not truncate", () => {
    const i18n = getI18n();
    i18n.setLanguage("vi");
    expect(i18n.t("modal.perspective.tag_name_placeholder")).toBe("vd: Công việc, Dự án");
    expect(i18n.t("modal.perspective.tag_instruct_placeholder")).toBe("Mô tả cho AI phân loại (tùy chọn)");

    i18n.setLanguage("en");
    expect(i18n.t("modal.perspective.tag_name_placeholder")).toBe("e.g. Work, Research");
    expect(i18n.t("modal.perspective.tag_instruct_placeholder")).toBe("Instructions for AI classification (optional)");
  });
});

describe("TDD — Pillar 2: Priority Template & Data Sanitization", () => {
  test("Priority template in app.js does not contain vulgar words ('rác rưởi')", () => {
    const { getPerspectiveTemplate } = require("../extension/app.js");
    const priorityVi = getPerspectiveTemplate("priority", "vi");
    expect(priorityVi).toBeDefined();
    const canCloseLabel = priorityVi.labels.find((l: any) => l.name === "Có thể đóng luôn");
    expect(canCloseLabel).toBeDefined();
    expect(canCloseLabel.description).not.toContain("rác rưởi");
    expect(canCloseLabel.description).toContain("tạm thời");
  });
});

describe("TDD — Pillar 3: HTML Cleanliness & Layout Boundaries", () => {
  test("Sidebar header removes duplicated '+' icon button and keeps only the list add button", () => {
    const html = readFileSync(indexPath, "utf-8");
    expect(html).not.toContain('class="perspective-add-icon-btn"');
    expect(html).toContain('class="perspective-add-btn"');
  });

  test("Empty state in column 3 has SVG bookmark icon, title and hint elements", () => {
    const html = readFileSync(indexPath, "utf-8");
    expect(html).toContain('data-i18n="saved.empty_title"');
    expect(html).toContain('data-i18n="saved.empty_hint"');
  });

  test("Tags system fallback hint does not contain rogue bullet span", () => {
    const html = readFileSync(indexPath, "utf-8");
    expect(html).not.toContain('class="fallback-dot"');
  });
});

describe("TDD — Pillar 4: CSS Paired Inputs & 620px Modal Width", () => {
  test("Modal max-width is expanded to 620px", () => {
    const css = readFileSync(cssPath, "utf-8");
    expect(css).toMatch(/\.perspective-modal\s*\{[^}]*max-width:\s*620px/);
  });

  test("Tag name input width is widened to at least 170px", () => {
    const css = readFileSync(cssPath, "utf-8");
    expect(css).toMatch(/\.tag-field-name\s*\{[^}]*flex:\s*0\s+0\s+(17[0-9]|180)px/);
  });

  test("Tag name and description inputs enforce 34px min-height parity against vbg 36px default", () => {
    const css = readFileSync(cssPath, "utf-8");
    // .tag-field-name must declare min-height: 34px !important so vercel-brand :where(input) 36px does not misalign it
    expect(css).toMatch(/\.tag-field-name\s*\{[^}]*min-height:\s*34px\s*!important/);
    expect(css).toMatch(/\.tag-field-desc\s*\{[^}]*min-height:\s*34px/);
  });

  test("Tag description focusout reset height is 34px", () => {
    const appJs = readFileSync(appPath, "utf-8");
    expect(appJs).toMatch(/textarea\.style\.height\s*=\s*'34px'/);
    expect(appJs).not.toMatch(/textarea\.style\.height\s*=\s*'32px'/);
  });

  test("Tag name and description inputs are independently spaced with gap and distinct borders", () => {
    const css = readFileSync(cssPath, "utf-8");
    expect(css).toMatch(/\.tag-row-inputs\s*\{[^}]*gap:\s*var\(--vbg-space-2\)/);
    expect(css).not.toMatch(/\.tag-row-inputs\s*\{[^}]*gap:\s*0/);
    expect(css).toMatch(/\.tag-field-name\s*\{[^}]*border:\s*1px solid var\(--vbg-border-subtle\)/);
    expect(css).toMatch(/\.tag-field-desc\s*\{[^}]*border:\s*1px solid var\(--vbg-border-subtle\)/);
  });
});

describe("TDD — Pillar 5 & Review Quality Gates: Behavioral & Hygiene", () => {
  test("renderDeferredColumn sets empty state display to 'flex', preserving flexbox layout", async () => {
    const appJs = require("../extension/app.js");
    expect(typeof appJs.renderDeferredColumn).toBe("function");

    // Mock DOM elements
    const columnEl = { style: { display: "" } };
    const emptyEl = { style: { display: "" } };
    const listEl = { style: { display: "" }, innerHTML: "" };
    const countEl = { textContent: "" };
    const archiveEl = { style: { display: "" } };
    const archiveListEl = { style: { display: "" }, innerHTML: "" };
    const archiveCountEl = { textContent: "" };

    const domMap: Record<string, any> = {
      deferredColumn: columnEl,
      deferredEmpty: emptyEl,
      deferredList: listEl,
      deferredCount: countEl,
      deferredArchive: archiveEl,
      deferredArchiveList: archiveListEl,
      deferredArchiveCount: archiveCountEl,
      archiveSearch: { value: "" }
    };

    // Save globals
    const origDoc = globalThis.document;
    const origChrome = (globalThis as any).chrome;

    try {
      (globalThis as any).document = {
        getElementById: (id: string) => domMap[id] || null,
        querySelectorAll: () => []
      };
      (globalThis as any).chrome = {
        storage: {
          local: {
            get: (_k: any, cb?: (r: any) => void) => {
              const res = { deferred: [] };
              if (typeof cb === "function") cb(res);
              return Promise.resolve(res);
            }
          }
        }
      };

      await appJs.renderDeferredColumn();
      expect(emptyEl.style.display).toBe("flex");
      expect(emptyEl.style.display).not.toBe("block");

      // Verify catch fallback also sets flex
      (globalThis as any).chrome = {
        storage: {
          local: {
            get: () => Promise.reject(new Error("Storage failure"))
          }
        }
      };
      emptyEl.style.display = "";
      await appJs.renderDeferredColumn();
      expect(emptyEl.style.display).toBe("flex");
      expect(emptyEl.style.display).not.toBe("block");
    } finally {
      globalThis.document = origDoc;
      (globalThis as any).chrome = origChrome;
    }
  });

  test("Empty state icon and hint have defensive auto-centering margins", () => {
    const css = readFileSync(cssPath, "utf-8");
    expect(css).toMatch(/\.deferred-empty-icon\s*\{[^}]*margin-inline:\s*auto/);
    expect(css).toMatch(/\.deferred-empty-hint\s*\{[^}]*margin:\s*0\s+auto/);
  });

  test("Dead CSS selectors and dead i18n keys are cleanly removed", () => {
    const css = readFileSync(cssPath, "utf-8");
    expect(css).not.toContain(".perspective-add-icon-btn");
    expect(css).not.toContain(".tags-system-fallback-hint .fallback-dot");

    const i18nCode = readFileSync(i18nPath, "utf-8");
    expect(i18nCode).not.toContain("'rail.add_perspective'");
  });
});
