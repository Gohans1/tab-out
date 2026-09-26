import { expect, test, describe, beforeEach, afterEach } from "bun:test";

// The Jev message channel is covered by jev-worker.test.ts; this suite covers the rest of the worker.
const { setupContextMenus, handleContextMenuClick } = require("../extension/background.js");

describe("Background Service Worker — Context Menu", () => {
  let originalChrome: any;

  beforeEach(() => {
    originalChrome = (globalThis as any).chrome;
    (globalThis as any).chrome = {
      runtime: { id: "test-extension-id" },
      contextMenus: {
        removeAll: (cb: () => void) => cb(),
        create: (_opts: any, cb?: () => void) => { if (cb) cb(); }
      },
      tabs: { create: async (opts: any) => opts }
    };
  });

  afterEach(() => {
    (globalThis as any).chrome = originalChrome;
  });

  test("setupContextMenus registers context menu entry with title, contexts and id", () => {
    let createdMenu: any = null;
    (globalThis as any).chrome.contextMenus = {
      removeAll: (cb: () => void) => cb(),
      create: (opts: any, cb?: () => void) => {
        createdMenu = opts;
        if (cb) cb();
      }
    };

    expect(() => setupContextMenus()).not.toThrow();
    expect(createdMenu).toBeDefined();
    expect(createdMenu.id).toBe("tabout-open-new-tab");
    expect(createdMenu.title).toBe("New Tab");
    expect(createdMenu.contexts).toEqual(["all"]);
  });

  test("setupContextMenus safely no-ops without throwing when chrome.contextMenus API is unavailable", () => {
    delete (globalThis as any).chrome.contextMenus;
    expect(() => setupContextMenus()).not.toThrow();
  });

  test("handleContextMenuClick creates new tab on menu selection", async () => {
    let createdTabOpts: any = null;
    (globalThis as any).chrome.tabs = {
      create: async (opts: any) => { createdTabOpts = opts; }
    };

    handleContextMenuClick({ menuItemId: "tabout-open-new-tab" }, {});
    expect(createdTabOpts).toEqual({});
  });

  test("handleContextMenuClick ignores unknown menu item IDs", () => {
    let tabCreated = false;
    (globalThis as any).chrome.tabs = {
      create: async () => { tabCreated = true; }
    };

    handleContextMenuClick({ menuItemId: "unknown-menu-id" }, {});
    expect(tabCreated).toBe(false);
  });
});
