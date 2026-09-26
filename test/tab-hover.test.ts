import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("Tab Hover Affordance & Perimeter Border System (TDD)", () => {
  const stylePath = resolve(__dirname, "../extension/style.css");
  const css = readFileSync(stylePath, "utf-8");

  test("Pillar 1: .page-chip:hover has full-perimeter high-contrast border and removes the 2px left stripe", () => {
    // Locate the .page-chip:hover rule block
    const pageChipHoverMatch = css.match(/\.page-chip:hover\s*\{([^}]+)\}/);
    expect(pageChipHoverMatch).not.toBeNull();
    const rules = pageChipHoverMatch![1];

    // Must use --vbg-border-strong for clear high-contrast perimeter
    expect(rules).toContain("var(--vbg-border-strong)");
    expect(rules).toContain("inset 0 0 0 1px");
    // Must NOT have the unbalanced 2px left stripe on ordinary hover
    expect(rules).not.toContain("inset 2px 0 0 0 var(--vbg-text-primary)");

    // Active tab hover state must preserve accent stripe while using high-contrast perimeter
    const activeHoverMatch = css.match(/\.page-chip\.is-last-active:hover\s*\{([^}]+)\}/);
    expect(activeHoverMatch).not.toBeNull();
    const activeRules = activeHoverMatch![1];
    expect(activeRules).toContain("var(--vbg-border-strong)");
    expect(activeRules).toContain("inset 0 0 0 1px");
  });

  test("Pillar 2: .deferred-item has hover state with surface background and full-perimeter border", () => {
    // .deferred-item must support hover with background and high-contrast border
    const deferredHoverMatch = css.match(/\.deferred-item:hover\s*\{([^}]+)\}/);
    expect(deferredHoverMatch).not.toBeNull();
    const rules = deferredHoverMatch![1];

    expect(rules).toContain("var(--vbg-surface-secondary)");
    expect(rules).toContain("var(--vbg-border-strong)");
    expect(rules).toContain("inset 0 0 0 1px");
  });

  test("Pillar 3: .archive-item:hover has full-perimeter high-contrast border", () => {
    const archiveHoverMatch = css.match(/\.archive-item:hover\s*\{([^}]+)\}/);
    expect(archiveHoverMatch).not.toBeNull();
    const rules = archiveHoverMatch![1];

    expect(rules).toContain("var(--vbg-surface-secondary)");
    expect(rules).toContain("var(--vbg-border-strong)");
    expect(rules).toContain("inset 0 0 0 1px");
  });

  test("Pillar 4: .recently-closed-item:hover has high-contrast border", () => {
    const closedHoverMatch = css.match(/\.recently-closed-item:hover\s*\{([^}]+)\}/);
    expect(closedHoverMatch).not.toBeNull();
    const rules = closedHoverMatch![1];

    expect(rules).toContain("var(--vbg-surface-secondary)");
    expect(rules).toContain("var(--vbg-border-strong)");
  });

  test("Pillar 5: All tab items use official Vercel tokens and prevent layout shift", () => {
    // Must not use hardcoded #fff or #ffffff for any tab hover borders
    const hoverMatches = [
      css.match(/\.page-chip:hover\s*\{([^}]+)\}/),
      css.match(/\.page-chip\.is-last-active:hover\s*\{([^}]+)\}/),
      css.match(/\.deferred-item:hover\s*\{([^}]+)\}/),
      css.match(/\.archive-item:hover\s*\{([^}]+)\}/),
      css.match(/\.recently-closed-item:hover\s*\{([^}]+)\}/),
    ];

    for (const match of hoverMatches) {
      expect(match).not.toBeNull();
      expect(match![1]).not.toContain("#ffffff");
      expect(match![1]).not.toContain("#fff");
    }

    // .deferred-item must have border-radius for clean rounded border box
    const deferredBaseMatch = css.match(/\.deferred-item\s*\{([^}]+)\}/);
    expect(deferredBaseMatch).not.toBeNull();
    expect(deferredBaseMatch![1]).toContain("border-radius");
  });
});
