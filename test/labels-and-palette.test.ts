import { expect, test, describe } from "bun:test";

const {
  getLabelName,
  getLabelDesc,
  normalizeLabels,
  TAG_PALETTE,
  resolveTagColor,
  getLabelColor
} = require("../extension/app.js");

describe("Label Helpers — Normalization & Metadata Extraction", () => {
  test("getLabelName extracts name correctly from strings and objects", () => {
    expect(getLabelName("Simple Tag")).toBe("Simple Tag");
    expect(getLabelName({ name: "Work", description: "Job tabs" })).toBe("Work");
    expect(getLabelName({ name: "", description: "Empty" })).toBe("");
    expect(getLabelName(null)).toBe("");
    expect(getLabelName(undefined)).toBe("");
  });

  test("getLabelDesc extracts description or returns empty string", () => {
    expect(getLabelDesc("Simple Tag")).toBe("");
    expect(getLabelDesc({ name: "Work", description: "All job tabs" })).toBe("All job tabs");
    expect(getLabelDesc({ name: "Work" })).toBe("");
    expect(getLabelDesc(null)).toBe("");
  });

  test("normalizeLabels transforms legacy string arrays into structured objects", () => {
    const legacy = ["Alpha", "Beta"];
    const normalized = normalizeLabels(legacy);

    expect(normalized.length).toBe(2);
    expect(normalized[0]).toEqual({ name: "Alpha", description: "", color: "" });
    expect(normalized[1]).toEqual({ name: "Beta", description: "", color: "" });
  });

  test("normalizeLabels preserves color property and drops empty names", () => {
    const raw = [
      { name: "Design", description: "Figma and styling", color: "violet" },
      { name: "", description: "Should be dropped", color: "rose" },
      { name: "Dev", description: "Coding", color: "emerald" }
    ];
    const normalized = normalizeLabels(raw);

    expect(normalized.length).toBe(2);
    expect(normalized[0].name).toBe("Design");
    expect(normalized[0].color).toBe("violet");
    expect(normalized[1].name).toBe("Dev");
    expect(normalized[1].color).toBe("emerald");
  });

  test("normalizeLabels is resilient against null, undefined, or corrupt items", () => {
    const messy = [null, undefined, "Valid", { name: "Another" }, 42 as any];
    const normalized = normalizeLabels(messy);

    expect(normalized.length).toBe(2);
    expect(normalized[0].name).toBe("Valid");
    expect(normalized[1].name).toBe("Another");
  });
});

describe("Tag Color Accents & Curated Palette", () => {
  test("TAG_PALETTE contains curated accessible dark-mode tuned colors", () => {
    expect(typeof TAG_PALETTE).toBe("object");
    const colors = Object.values(TAG_PALETTE) as any[];
    expect(colors.length).toBeGreaterThanOrEqual(5);

    for (const color of colors) {
      expect(typeof color.id).toBe("string");
      expect(color.id.length).toBeGreaterThan(0);
      expect(typeof color.name).toBe("string");
      expect(color.name.length).toBeGreaterThan(0);
      expect(color.hex).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  test("resolveTagColor retrieves color definition by ID and returns null for invalid IDs", () => {
    const emerald = resolveTagColor("emerald");
    expect(emerald).toBeDefined();
    expect(emerald?.id).toBe("emerald");
    expect(emerald?.hex).toBeDefined();

    expect(resolveTagColor("non-existent-color")).toBeNull();
    expect(resolveTagColor("")).toBeNull();
    expect(resolveTagColor(null)).toBeNull();
  });

  test("getLabelColor extracts tag color from structured label object", () => {
    expect(getLabelColor({ name: "AI", color: "sky" })).toBe("sky");
    expect(getLabelColor({ name: "AI" })).toBe("");
    expect(getLabelColor("AI")).toBe("");
  });
});
