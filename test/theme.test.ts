import { expect, test, describe, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const indexPath = resolve(__dirname, "../extension/index.html");
const i18nPath = resolve(__dirname, "../extension/i18n.js");
const appPath = resolve(__dirname, "../extension/app.js");
const stylePath = resolve(__dirname, "../extension/style.css");
const vercelBrandPath = resolve(__dirname, "../extension/vercel-brand.css");

describe("Theme System — Light Mode & Default Dark Mode (TDD)", () => {

  describe("Pillar 1: HTML & Default Dark State", () => {
    test("index.html body element has class 'vbg-report' and data-theme='dark' by default", () => {
      const html = readFileSync(indexPath, "utf-8");
      // Must have data-theme="dark" on body to prevent FOUT (Flash of Unstyled Theme)
      const bodyTagMatch = html.match(/<body[^>]*>/);
      expect(bodyTagMatch).not.toBeNull();
      const bodyTag = bodyTagMatch![0];
      expect(bodyTag).toContain('class="vbg-report"');
      expect(bodyTag).toContain('data-theme="dark"');
    });

    test("index.html contains #themeToggleBtn with data-action='toggle-theme'", () => {
      const html = readFileSync(indexPath, "utf-8");
      expect(html).toContain('id="themeToggleBtn"');
      expect(html).toContain('data-action="toggle-theme"');
    });
  });

  describe("Pillar 2: Bilingual i18n Localization for Themes", () => {
    function getI18nInstance() {
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

    test("i18n defines theme translation keys for both English and Vietnamese", () => {
      const i18n = getI18nInstance();

      // English keys
      i18n.setLanguage("en");
      expect(i18n.t("theme.toggle_light")).toBeTruthy();
      expect(i18n.t("theme.toggle_dark")).toBeTruthy();
      expect(i18n.t("theme.dark")).toBe("Dark");
      expect(i18n.t("theme.light")).toBe("Light");

      // Vietnamese keys
      i18n.setLanguage("vi");
      expect(i18n.t("theme.toggle_light")).toBeTruthy();
      expect(i18n.t("theme.toggle_dark")).toBeTruthy();
      expect(i18n.t("theme.dark")).toBe("Tối");
      expect(i18n.t("theme.light")).toBe("Sáng");
    });
  });

  describe("Pillar 3: Theme Management Logic in app.js", () => {
    let mockStorage: Record<string, any> = {};
    let mockBodyAttributes: Record<string, string> = {};
    let mockBtnAttributes: Record<string, string> = {};
    let mockBtnInnerHTML = "";

    beforeEach(() => {
      mockStorage = {};
      mockBodyAttributes = { "data-theme": "dark" };
      mockBtnAttributes = {};
      mockBtnInnerHTML = "";

      (globalThis as any).chrome = {
        storage: {
          local: {
            get: async (keys: any) => {
              if (typeof keys === "string") return { [keys]: mockStorage[keys] };
              if (Array.isArray(keys)) {
                const res: Record<string, any> = {};
                for (const k of keys) res[k] = mockStorage[k];
                return res;
              }
              if (typeof keys === "object" && keys !== null) {
                const res: Record<string, any> = {};
                for (const k of Object.keys(keys)) {
                  res[k] = mockStorage[k] !== undefined ? mockStorage[k] : keys[k];
                }
                return res;
              }
              return mockStorage;
            },
            set: async (obj: any) => {
              Object.assign(mockStorage, obj);
            }
          }
        }
      };

      (globalThis as any).document = {
        addEventListener: () => {},
        removeEventListener: () => {},
        body: {
          getAttribute: (attr: string) => mockBodyAttributes[attr] || null,
          setAttribute: (attr: string, val: string) => { mockBodyAttributes[attr] = String(val); },
          removeAttribute: (attr: string) => { delete mockBodyAttributes[attr]; }
        },
        querySelectorAll: () => [],
        getElementById: (id: string) => {
          if (id === "themeToggleBtn") {
            return {
              id: "themeToggleBtn",
              setAttribute: (attr: string, val: string) => { mockBtnAttributes[attr] = String(val); },
              getAttribute: (attr: string) => mockBtnAttributes[attr] || null,
              get innerHTML() { return mockBtnInnerHTML; },
              set innerHTML(val: string) { mockBtnInnerHTML = val; }
            };
          }
          return null;
        }
      };
    });

    test("initTheme defaults to 'dark' when no theme is stored in storage", async () => {
      const app = require("../extension/app.js");
      expect(typeof app.initTheme).toBe("function");

      await app.initTheme();
      expect(mockBodyAttributes["data-theme"]).toBe("dark");
      expect(app.getTheme()).toBe("dark");
    });

    test("initTheme loads 'light' from storage if previously saved", async () => {
      mockStorage.tabout_theme = "light";
      const app = require("../extension/app.js");

      await app.initTheme();
      expect(mockBodyAttributes["data-theme"]).toBe("light");
      expect(app.getTheme()).toBe("light");
    });

    test("setTheme switches theme, updates body attribute and writes to chrome.storage.local", async () => {
      const app = require("../extension/app.js");

      await app.setTheme("light");
      expect(mockBodyAttributes["data-theme"]).toBe("light");
      expect(mockStorage.tabout_theme).toBe("light");
      expect(app.getTheme()).toBe("light");

      await app.setTheme("dark");
      expect(mockBodyAttributes["data-theme"]).toBe("dark");
      expect(mockStorage.tabout_theme).toBe("dark");
      expect(app.getTheme()).toBe("dark");
    });

    test("setTheme safely falls back to 'dark' if invalid theme argument is passed", async () => {
      const app = require("../extension/app.js");

      await app.setTheme("invalid-theme" as any);
      expect(mockBodyAttributes["data-theme"]).toBe("dark");
      expect(mockStorage.tabout_theme).toBe("dark");
      expect(app.getTheme()).toBe("dark");
    });

    test("toggleTheme flips between dark and light smoothly", async () => {
      const app = require("../extension/app.js");

      await app.setTheme("dark");
      expect(app.getTheme()).toBe("dark");

      await app.toggleTheme();
      expect(app.getTheme()).toBe("light");
      expect(mockBodyAttributes["data-theme"]).toBe("light");
      expect(mockStorage.tabout_theme).toBe("light");

      await app.toggleTheme();
      expect(app.getTheme()).toBe("dark");
      expect(mockBodyAttributes["data-theme"]).toBe("dark");
      expect(mockStorage.tabout_theme).toBe("dark");
    });

    test("updateThemeToggleUI updates button aria-label, title, icon SVG, and data-i18n attributes", async () => {
      const app = require("../extension/app.js");

      await app.setTheme("dark");
      expect(mockBtnAttributes["aria-label"]).toBeTruthy();
      expect(mockBtnAttributes["title"]).toBeTruthy();
      expect(mockBtnAttributes["data-i18n-title"]).toBe("theme.toggle_light");
      expect(mockBtnAttributes["data-i18n-aria-label"]).toBe("theme.toggle_light");
      // In dark mode, icon should be Sun (hinting: switch to light mode)
      expect(mockBtnInnerHTML).toContain("<svg");

      await app.setTheme("light");
      expect(mockBtnAttributes["aria-label"]).toBeTruthy();
      expect(mockBtnAttributes["title"]).toBeTruthy();
      expect(mockBtnAttributes["data-i18n-title"]).toBe("theme.toggle_dark");
      expect(mockBtnAttributes["data-i18n-aria-label"]).toBe("theme.toggle_dark");
      // In light mode, icon should be Moon (hinting: switch to dark mode)
      expect(mockBtnInnerHTML).toContain("<svg");
    });

    test("handleStorageOnChanged synchronizes theme changes across open tabs", async () => {
      const app = require("../extension/app.js");

      await app.setTheme("dark");
      expect(app.getTheme()).toBe("dark");

      await app.handleStorageOnChanged(
        { tabout_theme: { oldValue: "dark", newValue: "light" } },
        "local"
      );

      expect(app.getTheme()).toBe("light");
      expect(mockBodyAttributes["data-theme"]).toBe("light");
    });
  });

  describe("Pillar 4: CSS Tokens and Styling Integrity", () => {
    test("vercel-brand.css contains official [data-theme='light'] and [data-theme='dark'] selectors", () => {
      const css = readFileSync(vercelBrandPath, "utf-8");
      expect(css).toContain('[data-theme="light"]');
      expect(css).toContain('[data-theme="dark"]');
    });

    test("style.css contains dedicated styling for .theme-toggle-btn", () => {
      const css = readFileSync(stylePath, "utf-8");
      expect(css).toContain(".theme-toggle-btn");
    });

    test("style.css recent-sidebar-item uses theme-aware text tokens instead of hardcoded white", () => {
      const css = readFileSync(stylePath, "utf-8");
      // Must not have hardcoded white text for decay-rank-1 or hover that breaks in light mode
      const decayRank1Match = css.match(/\.recent-sidebar-item\.decay-rank-1\s*\{([^}]+)\}/);
      expect(decayRank1Match).not.toBeNull();
      expect(decayRank1Match![1]).toContain("var(--vbg-text-primary)");
      expect(decayRank1Match![1]).not.toContain("color: #ffffff");

      const hoverMatch = css.match(/\.recent-sidebar-item:hover\s*\{([^}]+)\}/);
      expect(hoverMatch).not.toBeNull();
      expect(hoverMatch![1]).toContain("var(--vbg-text-primary)");
      expect(hoverMatch![1]).not.toContain("color: #ffffff");
    });

    test("chip-title-btn and chip-action are protected from foundation button gray background pollution", () => {
      const appCode = readFileSync(appPath, "utf-8");
      // All rendered chip-title-btn must have data-variant="tertiary"
      expect(appCode).toContain('class="chip-title-btn" data-variant="tertiary"');

      // style.css must explicitly enforce transparent background and zero border with high specificity
      const css = readFileSync(stylePath, "utf-8");
      expect(css).toContain("button.chip-title-btn");
      expect(css).toContain("background: transparent !important");
    });

    test("style.css provides comprehensive high-specificity overrides preventing button gray pollution and 36px stretching", () => {
      const css = readFileSync(stylePath, "utf-8");

      // Must reset min-height: 0 so compact buttons don't get stretched to 36px
      expect(css).toContain("min-height: 0");

      // Must explicitly guard against unwanted gray box background on custom buttons
      const protectedButtons = [
        "theme-toggle-btn",
        "perspective-add-btn",
        "perspective-edit-header-btn",
        "action-btn",
        "perspective-tag-pill",
        "archive-toggle",
        "quick-return-btn",
        "quick-return-dismiss",
        "telemetry-config-btn",
        "perspective-tab-edit-btn",
        "lang-btn",
        "btn-template",
        "btn-add-tag",
        "perspective-modal-close",
        "recent-sidebar-item"
      ];

      for (const btnClass of protectedButtons) {
        expect(css).toContain(btnClass);
      }
    });

    test("HTML and dynamic templates assign appropriate data-variant attributes to quiet buttons", () => {
      const html = readFileSync(indexPath, "utf-8");
      const appCode = readFileSync(appPath, "utf-8");

      // Header theme toggle button must have data-variant="tertiary"
      expect(html).toMatch(/id="themeToggleBtn"[^>]*data-variant="tertiary"/);

      // New perspective button must have data-variant="tertiary"
      expect(html).toMatch(/class="perspective-add-btn"[^>]*data-variant="tertiary"/);

      // Archive toggle button must have data-variant="tertiary"
      expect(html).toMatch(/id="archiveToggle"[^>]*data-variant="tertiary"/);

      // Perspective edit header button in app.js must have data-variant="tertiary"
      expect(appCode).toContain('class="perspective-edit-header-btn" data-variant="tertiary"');

      // Perspective tag pills in app.js must have data-variant="tertiary"
      expect(appCode).toContain('perspective-tag-pill');
      expect(appCode).toContain('data-variant="tertiary"');

      // Modal primary submit buttons must have data-variant="primary"
      expect(html).toMatch(/id="perspectiveSubmitBtn"[^>]*data-variant="primary"/);
    });
  });
});


