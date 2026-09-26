import { expect, test, describe } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

describe("i18n Internationalization Subsystem", () => {
  const extensionDir = resolve(__dirname, "../extension");
  const manifestPath = resolve(extensionDir, "manifest.json");
  const enLocalePath = resolve(extensionDir, "_locales/en/messages.json");
  const viLocalePath = resolve(extensionDir, "_locales/vi/messages.json");
  const i18nScriptPath = resolve(extensionDir, "i18n.js");
  const indexPath = resolve(extensionDir, "index.html");

  describe("Manifest & Native _locales Outer Shell", () => {
    test("manifest.json specifies default_locale and __MSG_ keys", () => {
      const raw = readFileSync(manifestPath, "utf-8");
      const manifest = JSON.parse(raw);

      expect(manifest.default_locale).toBe("en");
      expect(manifest.name).toBe("__MSG_appName__");
      expect(manifest.description).toBe("__MSG_appDesc__");
    });

    test("_locales/en/messages.json exists and defines appName and appDesc", () => {
      expect(existsSync(enLocalePath)).toBe(true);
      const en = JSON.parse(readFileSync(enLocalePath, "utf-8"));
      expect(en.appName?.message).toBe("Tab Out");
      expect(typeof en.appDesc?.message).toBe("string");
      expect(en.appDesc.message.length).toBeGreaterThan(5);
    });

    test("_locales/vi/messages.json exists and defines appName and appDesc in Vietnamese", () => {
      expect(existsSync(viLocalePath)).toBe(true);
      const vi = JSON.parse(readFileSync(viLocalePath, "utf-8"));
      expect(vi.appName?.message).toBe("Tab Out");
      expect(typeof vi.appDesc?.message).toBe("string");
      expect(vi.appDesc.message.length).toBeGreaterThan(5);
    });
  });

  describe("In-App i18n Core Engine (i18n.js)", () => {
    test("i18n.js file exists in extension directory", () => {
      expect(existsSync(i18nScriptPath)).toBe(true);
    });

    function instantiateI18n() {
      const i18nCode = readFileSync(i18nScriptPath, "utf-8");
      const mockStorage: Record<string, any> = {};
      const mockDocument = {
        querySelectorAll: () => []
      };

      const context: Record<string, any> = {
        window: {},
        navigator: { language: "en-US" },
        document: mockDocument,
        chrome: {
          storage: {
            local: {
              get: (keys: any, cb: (res: any) => void) => cb(mockStorage),
              set: (obj: any, cb?: () => void) => {
                Object.assign(mockStorage, obj);
                if (cb) cb();
              }
            }
          }
        }
      };
      context.window = context;

      const runFn = new Function("window", "navigator", "document", "chrome", i18nCode);
      runFn(context, context.navigator, context.document, context.chrome);

      return context.TabOutI18n || context.window.TabOutI18n;
    }

    test("i18n module provides core API methods", () => {
      const i18n = instantiateI18n();
      expect(i18n).toBeDefined();
      expect(typeof i18n.t).toBe("function");
      expect(typeof i18n.setLanguage).toBe("function");
      expect(typeof i18n.getLanguage).toBe("function");
      expect(typeof i18n.applyI18n).toBe("function");
      expect(typeof i18n.formatDate).toBe("function");
      expect(typeof i18n.formatNumber).toBe("function");
      expect(typeof i18n.formatRelativeTime).toBe("function");
      expect(typeof i18n.TRANSLATIONS).toBe("object");
    });

    test("language switching updates active language and translations", () => {
      const i18n = instantiateI18n();

      i18n.setLanguage("en");
      expect(i18n.getLanguage()).toBe("en");
      expect(i18n.t("header.active_tabs")).toBe("Active tabs");

      i18n.setLanguage("vi");
      expect(i18n.getLanguage()).toBe("vi");
      expect(i18n.t("header.active_tabs")).toBe("Thẻ đang hoạt động");
    });

    test("settings modal labels reflect Jev API as core requirement without 'Optional'", () => {
      const i18n = instantiateI18n();
      i18n.setLanguage("en");
      expect(i18n.t("modal.settings.api_key_label")).not.toContain("Optional");
      i18n.setLanguage("vi");
      expect(i18n.t("modal.settings.api_key_label")).not.toContain("Tùy chọn");
    });

    test("parameter interpolation and safe prototype isolation", () => {
      const i18n = instantiateI18n();
      i18n.setLanguage("en");

      // Valid parameters
      expect(i18n.t("header.open_tabs_count", { count: 12 })).toBe("12 open tabs");

      // Inherited prototype properties are safely ignored
      const protoObj = Object.create({ count: 999 });
      expect(i18n.t("header.open_tabs_count", protoObj)).toBe("{count} open tabs");
    });

    test("fallback mechanism returns English when Vietnamese key is missing, or key when both are missing", () => {
      const i18n = instantiateI18n();

      // Temporarily inject test key only into English dictionary
      i18n.TRANSLATIONS.en["test.only_in_en"] = "English Only Feature";
      delete i18n.TRANSLATIONS.vi["test.only_in_en"];

      i18n.setLanguage("vi");
      // Must fall back to English
      expect(i18n.t("test.only_in_en")).toBe("English Only Feature");

      // Missing in both returns raw key
      expect(i18n.t("completely.nonexistent.key")).toBe("completely.nonexistent.key");

      // Clean up test key
      delete i18n.TRANSLATIONS.en["test.only_in_en"];
    });

    test("applyI18n accurately translates textContent, placeholder, title, and aria-label", () => {
      const i18n = instantiateI18n();
      i18n.setLanguage("vi");

      const attributesMap: Record<string, string> = {
        "text-el": "",
        "placeholder-el": "",
        "title-el": "",
        "aria-el": ""
      };

      const textEl = {
        id: "text-el",
        getAttribute: (attr: string) => attr === "data-i18n" ? "header.active_tabs" : null,
        textContent: "Old Text"
      };

      const placeholderEl = {
        id: "placeholder-el",
        getAttribute: (attr: string) => attr === "data-i18n-placeholder" ? "tabs.search_placeholder" : null,
        setAttribute: (attr: string, val: string) => { attributesMap["placeholder-el"] = val; }
      };

      const titleEl = {
        id: "title-el",
        getAttribute: (attr: string) => attr === "data-i18n-title" ? "rail.openrouter_config" : null,
        setAttribute: (attr: string, val: string) => { attributesMap["title-el"] = val; }
      };

      const ariaEl = {
        id: "aria-el",
        getAttribute: (attr: string) => attr === "data-i18n-aria-label" ? "rail.openrouter_config" : null,
        setAttribute: (attr: string, val: string) => { attributesMap["aria-el"] = val; }
      };

      const mockDoc = {
        querySelectorAll: (selector: string) => {
          if (selector === "[data-i18n]") return [textEl];
          if (selector === "[data-i18n-placeholder]") return [placeholderEl];
          if (selector === "[data-i18n-title]") return [titleEl];
          if (selector === "[data-i18n-aria-label]") return [ariaEl];
          return [];
        }
      };

      i18n.applyI18n(mockDoc);

      expect(textEl.textContent).toBe("Thẻ đang hoạt động");
      expect(attributesMap["placeholder-el"]).toBe("Tìm kiếm thẻ...");
      expect(attributesMap["title-el"]).toBe("Cài đặt khóa API OpenRouter");
      expect(attributesMap["aria-el"]).toBe("Cài đặt khóa API OpenRouter");
    });

    test("applyI18n() without arguments defaults to global document", () => {
      const i18n = instantiateI18n();
      i18n.setLanguage("vi");
      // Does not throw and safely no-ops or uses mock document
      expect(() => i18n.applyI18n()).not.toThrow();
    });

    test("formatters (formatDate, formatNumber, formatRelativeTime) behave consistently", () => {
      const i18n = instantiateI18n();

      i18n.setLanguage("en");
      const fixedDate = new Date("2026-09-25T12:00:00Z");
      const formattedDateEn = i18n.formatDate(fixedDate);
      expect(formattedDateEn).toBeDefined();
      expect(typeof formattedDateEn).toBe("string");

      const numStrEn = i18n.formatNumber(1234567);
      expect(numStrEn).toBeDefined();

      const justNowEn = i18n.formatRelativeTime(Date.now() - 5000);
      expect(justNowEn).toBe("just now");

      i18n.setLanguage("vi");
      const justNowVi = i18n.formatRelativeTime(Date.now() - 5000);
      expect(justNowVi).toBe("vừa xong");

      // Relative time for days, months, and years
      const oneMonthAgo = Date.now() - (35 * 24 * 60 * 60 * 1000);
      const oneYearAgo = Date.now() - (400 * 24 * 60 * 60 * 1000);

      i18n.setLanguage("en");
      expect(i18n.formatRelativeTime(oneMonthAgo)).toMatch(/last month|1 month ago|1mo ago/);
      expect(i18n.formatRelativeTime(oneYearAgo)).toMatch(/last year|1 year ago|1y ago/);
    });

    test("init() asynchronously bootstraps language from chrome storage", async () => {
      const i18nCode = readFileSync(i18nScriptPath, "utf-8");
      const mockStorage: Record<string, any> = { tabout_language: "vi" };
      const mockDocument = {
        querySelectorAll: () => []
      };

      const context: Record<string, any> = {
        window: {},
        navigator: { language: "en-US" },
        document: mockDocument,
        chrome: {
          storage: {
            local: {
              get: (keys: any, cb: (res: any) => void) => {
                setTimeout(() => cb(mockStorage), 5);
              },
              set: (obj: any, cb?: () => void) => {
                Object.assign(mockStorage, obj);
                if (cb) cb();
              }
            }
          }
        }
      };
      context.window = context;

      const runFn = new Function("window", "navigator", "document", "chrome", i18nCode);
      runFn(context, context.navigator, context.document, context.chrome);

      const i18n = context.TabOutI18n;
      expect(typeof i18n.init).toBe("function");

      const resolvedLang = await i18n.init();
      expect(resolvedLang).toBe("vi");
      expect(i18n.getLanguage()).toBe("vi");
    });
  });

  describe("Dictionary Parity & HTML Attribute Completeness", () => {
    const i18nModule = require(i18nScriptPath);
    const { en, vi } = i18nModule.TRANSLATIONS;

    test("100% key parity between English and Vietnamese dictionaries", () => {
      const enKeys = Object.keys(en).sort();
      const viKeys = Object.keys(vi).sort();

      const missingInVi = enKeys.filter(k => !(k in vi));
      const missingInEn = viKeys.filter(k => !(k in en));

      expect(missingInVi).toEqual([]);
      expect(missingInEn).toEqual([]);
      expect(enKeys.length).toBe(viKeys.length);
    });

    test("100% of data-i18n* attributes in index.html exist in dictionaries", () => {
      const htmlContent = readFileSync(indexPath, "utf-8");

      const regex = /data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g;
      const foundKeys = new Set<string>();
      let match: RegExpExecArray | null;

      while ((match = regex.exec(htmlContent)) !== null) {
        foundKeys.add(match[1]);
      }

      expect(foundKeys.size).toBeGreaterThan(0);

      const missingKeysInEn: string[] = [];
      const missingKeysInVi: string[] = [];

      for (const key of foundKeys) {
        if (!(key in en)) missingKeysInEn.push(key);
        if (!(key in vi)) missingKeysInVi.push(key);
      }

      expect(missingKeysInEn).toEqual([]);
      expect(missingKeysInVi).toEqual([]);
    });

    test("100% of t() keys in app.js exist in dictionaries", () => {
      const appPath = resolve(extensionDir, "app.js");
      const appContent = readFileSync(appPath, "utf-8");

      const regex = /\bt\(\s*['"]([^'"]+)['"]/g;
      const foundKeys = new Set<string>();
      let match: RegExpExecArray | null;

      while ((match = regex.exec(appContent)) !== null) {
        foundKeys.add(match[1]);
      }

      expect(foundKeys.size).toBeGreaterThan(0);

      const missingKeysInEn: string[] = [];
      const missingKeysInVi: string[] = [];

      for (const key of foundKeys) {
        if (!(key in en)) missingKeysInEn.push(key);
        if (!(key in vi)) missingKeysInVi.push(key);
      }

      expect(missingKeysInEn).toEqual([]);
      expect(missingKeysInVi).toEqual([]);
    });

    test("static data-i18n* keys in index.html do not contain un-interpolated parameter tokens", () => {
      const htmlContent = readFileSync(indexPath, "utf-8");
      const regex = /data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(htmlContent)) !== null) {
        const key = match[1];
        const enVal = en[key];
        const viVal = vi[key];
        expect(enVal).not.toMatch(/\{\w+\}/);
        expect(viVal).not.toMatch(/\{\w+\}/);
      }
    });
  });
});
