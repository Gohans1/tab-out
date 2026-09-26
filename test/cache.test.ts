import { expect, test, describe } from "bun:test";

const {
  pruneClassificationCache,
  isAiEligibleUrl
} = require("../extension/app.js");

describe("pruneClassificationCache — LRU Bounds", () => {
  test("returns unchanged cache when entry count is within limit", () => {
    const cache = {
      "https://site1.com": { label: "Dev", timestamp: 100 },
      "https://site2.com": { label: "AI", timestamp: 200 }
    };
    const pruned = pruneClassificationCache(cache, 10);
    expect(Object.keys(pruned).length).toBe(2);
    expect(pruned).toEqual(cache);
  });

  test("prunes oldest entries based on timestamp descending", () => {
    const cache = {
      "https://oldest.com": { label: "Dev", timestamp: 10 },
      "https://newest.com": { label: "AI", timestamp: 100 },
      "https://middle.com": { label: "Work", timestamp: 50 }
    };
    const pruned = pruneClassificationCache(cache, 2);

    expect(Object.keys(pruned).length).toBe(2);
    expect(pruned["https://newest.com"]).toBeDefined();
    expect(pruned["https://middle.com"]).toBeDefined();
    expect(pruned["https://oldest.com"]).toBeUndefined();
  });

  test("handles empty, null, or undefined cache safely", () => {
    expect(pruneClassificationCache(null as any)).toEqual({});
    expect(pruneClassificationCache(undefined as any)).toEqual({});
    expect(pruneClassificationCache({})).toEqual({});
  });
});

describe("isAiEligibleUrl — AI Request Gateway", () => {
  test("accepts public and local HTTP/HTTPS URLs", () => {
    expect(isAiEligibleUrl("https://example.com")).toBe(true);
    expect(isAiEligibleUrl("http://localhost:3000")).toBe(true);
  });

  test("rejects local file and internal browser schemes", () => {
    expect(isAiEligibleUrl("file:///C:/Users/file.html")).toBe(false);
    expect(isAiEligibleUrl("chrome://settings")).toBe(false);
    expect(isAiEligibleUrl("chrome-extension://abcdef/index.html")).toBe(false);
    expect(isAiEligibleUrl("about:blank")).toBe(false);
    expect(isAiEligibleUrl("data:text/html,test")).toBe(false);
    expect(isAiEligibleUrl("")).toBe(false);
    expect(isAiEligibleUrl(null as any)).toBe(false);
  });

  test("rejects cloud metadata endpoints and URLs with embedded credentials", () => {
    expect(isAiEligibleUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAiEligibleUrl("https://admin:supersecret@example.com/api")).toBe(false);
    expect(isAiEligibleUrl("http://[fd00:ec2::254]/latest/meta-data/")).toBe(false);
    expect(isAiEligibleUrl("http://[::ffff:a9fe:a9fe]/latest/meta-data/")).toBe(false);
    expect(isAiEligibleUrl("http://[::ffff:100.100.100.200]/latest/meta-data/")).toBe(false);
    expect(isAiEligibleUrl("http://[::ffff:6464:64c8]/latest/meta-data/")).toBe(false);
    expect(isAiEligibleUrl("http://[fe80::1]/api")).toBe(false);
    expect(isAiEligibleUrl("http://[feb0::1]/api")).toBe(false);
    expect(isAiEligibleUrl("http://metadata.google.internal./computeMetadata/v1/")).toBe(false);
    expect(isAiEligibleUrl("http://metadata./computeMetadata/v1/")).toBe(false);
    expect(isAiEligibleUrl("http://169.254.169.254./latest/meta-data/")).toBe(false);
  });
});

describe("isDangerousKey — Prototype Pollution Defense", () => {
  const { isDangerousKey } = require("../extension/app.js");
  const bg = require("../extension/background.js");

  test("rejects prototype pollution keys with whitespace padding", () => {
    expect(isDangerousKey("  __proto__  ")).toBe(true);
    expect(isDangerousKey("\tconstructor\n")).toBe(true);
    expect(isDangerousKey("toString")).toBe(true);
    expect(isDangerousKey("  ")).toBe(true);
    expect(isDangerousKey("")).toBe(true);
    expect(isDangerousKey(null as any)).toBe(true);

    expect(bg.isDangerousKey("  __proto__  ")).toBe(true);
    expect(bg.isDangerousKey("constructor")).toBe(true);
  });

  test("allows safe perspective and URL cache keys", () => {
    expect(isDangerousKey("topic")).toBe(false);
    expect(isDangerousKey("domain")).toBe(false);
    expect(isDangerousKey("https://example.com")).toBe(false);
    expect(bg.isDangerousKey("topic")).toBe(false);
  });
});

describe("saveClassificationCacheAtomic (service worker) — Storage Resilience & Dirty Checks", () => {
  const { saveClassificationCacheAtomic } = require("../extension/background.js");

  test("skips storage.set when no actual changes occur (dirty check)", async () => {
    let setCalled = false;
    const originalChrome = (globalThis as any).chrome;
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (keys: string[]) => ({
            tabClassificationCache_topic: {
              "https://example.com": { label: "Work", source: "ai", confidence: 0.9, timestamp: 1000 }
            },
            perspectives: [{ id: "topic", name: "Topic", labels: [] }]
          }),
          set: async () => {
            setCalled = true;
          }
        }
      }
    };

    try {
      await saveClassificationCacheAtomic("topic", {
        "https://example.com": { label: "Work", source: "ai", confidence: 0.9, timestamp: 1000 }
      });
      expect(setCalled).toBe(false);
    } finally {
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("recovers gracefully from corrupted Array storage partition without silent wipe", async () => {
    let savedData: any = null;
    const originalChrome = (globalThis as any).chrome;
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (keys: string[]) => ({
            tabClassificationCache_topic: [], // Corrupted array in storage
            perspectives: [{ id: "topic", name: "Topic", labels: [] }]
          }),
          set: async (obj: any) => {
            savedData = obj;
          }
        }
      }
    };

    try {
      await saveClassificationCacheAtomic("topic", {
        "https://newsite.com": { label: "Tech", source: "ai", confidence: 0.95 }
      });
      expect(savedData).toBeDefined();
      expect(Array.isArray(savedData.tabClassificationCache_topic)).toBe(false);
      expect(typeof savedData.tabClassificationCache_topic).toBe("object");
      expect(savedData.tabClassificationCache_topic["https://newsite.com"].label).toBe("Tech");
    } finally {
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("normalizes legacy string entries into structured objects instead of character-spreading", async () => {
    let savedData: any = null;
    const originalChrome = (globalThis as any).chrome;
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => ({
            tabClassificationCache_topic: {},
            perspectives: [{ id: "topic", name: "Topic", labels: [] }]
          }),
          set: async (obj: any) => {
            savedData = obj;
          }
        }
      }
    };

    try {
      await saveClassificationCacheAtomic("topic", {
        "https://legacy.com": "Work" as any
      });
      expect(savedData).toBeDefined();
      const entry = savedData.tabClassificationCache_topic["https://legacy.com"];
      expect(entry.label).toBe("Work");
      expect(entry.source).toBe("ai");
      expect((entry as any)["0"]).toBeUndefined(); // Must NOT spread characters
    } finally {
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("an AI answer already stored is never replaced by a local fallback", async () => {
    let savedData: any = null;
    const originalChrome = (globalThis as any).chrome;
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => ({
            tabClassificationCache_topic: {
              "https://answered.com": { label: "Tech", source: "ai", confidence: 0.95, timestamp: 200 }
            },
            perspectives: [{ id: "topic", name: "Topic", labels: [] }]
          }),
          set: async (obj: any) => {
            savedData = obj;
          }
        }
      }
    };

    try {
      await saveClassificationCacheAtomic("topic", {
        "https://answered.com": { label: "Other", source: "local", lastAiAttempt: 300, timestamp: 300 },
        "https://newitem.com": { label: "Work", source: "ai", timestamp: 150 }
      });
      expect(savedData).toBeDefined();
      const entry = savedData.tabClassificationCache_topic["https://answered.com"];
      expect(entry.source).toBe("ai");
      expect(entry.label).toBe("Tech");
    } finally {
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("pruning to 1000 entries drops the oldest answer", async () => {
    let savedData: any = null;
    const originalChrome = (globalThis as any).chrome;

    // Simulate disk holding an old key that was present initially
    const initialDisk: Record<string, any> = {
      "https://pruned.com": { label: "Old", source: "local", timestamp: 1 }
    };

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => ({
            tabClassificationCache_topic: { ...initialDisk },
            perspectives: [{ id: "topic", name: "Topic", labels: [] }]
          }),
          set: async (obj: any) => {
            savedData = obj;
          }
        }
      }
    };

    try {
      // We pass an empty or new entry, but manually simulate that initialDisk had a key that
      // is newly populated with 1001 items so the old item gets pruned.
      // Alternatively, pass 1001 items so "https://pruned.com" gets pruned by pruneClassificationCache:
      const bulkEntries: Record<string, any> = {};
      for (let i = 0; i < 1001; i++) {
        bulkEntries[`https://item-${i}.com`] = { label: "Work", source: "ai", timestamp: 1000 + i };
      }

      await saveClassificationCacheAtomic("topic", bulkEntries);
      expect(savedData).toBeDefined();
      // "https://pruned.com" had timestamp 1, so it must be pruned and NOT resurrected
      expect(savedData.tabClassificationCache_topic["https://pruned.com"]).toBeUndefined();
      expect(Object.keys(savedData.tabClassificationCache_topic).length).toBeLessThanOrEqual(1000);
    } finally {
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("does not write a partition for a perspective that was deleted", async () => {
    let savedData: any = null;
    const originalChrome = (globalThis as any).chrome;

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => ({
            // Perspective "deleted_pid" is NOT in perspectives list
            perspectives: [{ id: "domain", name: "Domain", labels: [] }],
            tabClassificationCache_deleted_pid: {}
          }),
          set: async (obj: any) => {
            savedData = obj;
          }
        }
      }
    };

    try {
      await saveClassificationCacheAtomic("deleted_pid", {
        "https://test.com": { label: "Tech", source: "ai", timestamp: 100 }
      });
      // Should not write anything to storage because perspective was deleted
      expect(savedData).toBeNull();
    } finally {
      (globalThis as any).chrome = originalChrome;
    }
  });

  test("handles malformed perspectives arrays with null/undefined elements gracefully", async () => {
    let savedData: any = null;
    const originalChrome = (globalThis as any).chrome;

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => ({
            // Malformed perspectives array containing null, undefined, and numbers
            perspectives: [null, undefined, 123, { id: "topic", name: "Topic" }, {}],
            tabClassificationCache_topic: {}
          }),
          set: async (obj: any) => {
            savedData = obj;
          }
        }
      }
    };

    try {
      await saveClassificationCacheAtomic("topic", {
        "https://test.com": { label: "Tech", source: "ai", timestamp: 100 }
      });
      expect(savedData).not.toBeNull();
      expect(savedData.tabClassificationCache_topic["https://test.com"].label).toBe("Tech");
    } finally {
      (globalThis as any).chrome = originalChrome;
    }
  });
});

describe("isAiEligibleUrl — IPv6 & Cloud Metadata Gateway", () => {
  test("rejects AWS IMDSv2 IPv6 and IPv4-mapped IPv6 metadata endpoints", () => {
    expect(isAiEligibleUrl("http://[fd00:ec2::254]/latest/meta-data/")).toBe(false);
    expect(isAiEligibleUrl("http://[::ffff:a9fe:a9fe]/")).toBe(false);
    expect(isAiEligibleUrl("http://[::ffff:169.254.169.254]/")).toBe(false);
    expect(isAiEligibleUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
  });
});


