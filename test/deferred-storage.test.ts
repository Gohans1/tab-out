import { expect, test, describe } from "bun:test";

const {
  mutateDeferred,
  unarchiveSavedTab,
  deleteSavedTab,
  dismissSavedTab,
  getSavedTabs
} = require("../extension/app.js");

describe("Deferred Storage — Bound Limits & Mutation Consistency", () => {
  test("mutateDeferred bounds archived tabs to max 500 while preserving all active items", async () => {
    let mockStorage: Record<string, any> = { deferred: [] };
    const originalChrome = (globalThis as any).chrome;

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ deferred: mockStorage[key] || [] }),
          set: async (obj: any) => {
            mockStorage = { ...mockStorage, ...obj };
          }
        }
      }
    };

    try {
      // Create 50 active tabs and 600 completed (archived) tabs with timestamps
      const initialItems: any[] = [];
      for (let i = 0; i < 50; i++) {
        initialItems.push({
          id: `active-${i}`,
          url: `https://active-${i}.com`,
          title: `Active ${i}`,
          completed: false,
          savedAt: new Date(1000000 + i * 1000).toISOString()
        });
      }
      for (let i = 0; i < 600; i++) {
        initialItems.push({
          id: `archived-${i}`,
          url: `https://archived-${i}.com`,
          title: `Archived ${i}`,
          completed: true,
          completedAt: new Date(2000000 + i * 1000).toISOString()
        });
      }

      await mutateDeferred(() => initialItems);

      const saved = mockStorage.deferred;
      expect(Array.isArray(saved)).toBe(true);

      const active = saved.filter((t: any) => !t.completed);
      const archived = saved.filter((t: any) => Boolean(t.completed));

      // All 50 active items must be preserved
      expect(active.length).toBe(50);
      // Archived items must be capped at 500
      expect(archived.length).toBe(500);
      // The newest archived items (higher completedAt timestamps) should be kept
      expect(archived.some((t: any) => t.id === "archived-599")).toBe(true);
      expect(archived.some((t: any) => t.id === "archived-0")).toBe(false);
    } finally {
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("unarchiveSavedTab returns item snapshot and sets completed = false", async () => {
    let mockStorage: Record<string, any> = {
      deferred: [
        { id: "tab-1", title: "Test Tab", url: "https://test.com", completed: true, completedAt: "2026-01-01T00:00:00Z" }
      ]
    };
    const originalChrome = (globalThis as any).chrome;

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ deferred: mockStorage[key] || [] }),
          set: async (obj: any) => {
            mockStorage = { ...mockStorage, ...obj };
          }
        }
      }
    };

    try {
      const restored = await unarchiveSavedTab("tab-1");
      expect(restored).toBeDefined();
      expect(restored.id).toBe("tab-1");
      expect(restored.title).toBe("Test Tab");

      const saved = mockStorage.deferred;
      expect(saved[0].completed).toBe(false);
      expect(saved[0].completedAt).toBeUndefined();
    } finally {
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("deleteSavedTab returns deleted snapshot and permanently removes item", async () => {
    let mockStorage: Record<string, any> = {
      deferred: [
        { id: "tab-to-delete", title: "Delete Me", url: "https://delete.com", completed: true }
      ]
    };
    const originalChrome = (globalThis as any).chrome;

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ deferred: mockStorage[key] || [] }),
          set: async (obj: any) => {
            mockStorage = { ...mockStorage, ...obj };
          }
        }
      }
    };

    try {
      const deleted = await deleteSavedTab("tab-to-delete");
      expect(deleted).toBeDefined();
      expect(deleted.id).toBe("tab-to-delete");

      const saved = mockStorage.deferred;
      expect(saved.length).toBe(0);
    } finally {
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("dismissSavedTab returns dismissed snapshot and permanently removes item", async () => {
    let mockStorage: Record<string, any> = {
      deferred: [
        { id: "tab-to-dismiss", title: "Dismiss Me", url: "https://dismiss.com", completed: false }
      ]
    };
    const originalChrome = (globalThis as any).chrome;

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ deferred: mockStorage[key] || [] }),
          set: async (obj: any) => {
            mockStorage = { ...mockStorage, ...obj };
          }
        }
      }
    };

    try {
      const dismissed = await dismissSavedTab("tab-to-dismiss");
      expect(dismissed).toBeDefined();
      expect(dismissed.id).toBe("tab-to-dismiss");

      const saved = mockStorage.deferred;
      expect(saved.length).toBe(0);
    } finally {
      (globalThis as any).chrome = originalChrome;
    }
  });
});
