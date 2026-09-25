import { expect, test, describe } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("Extension Manifest V3 Verification", () => {
  test("manifest.json defines required MV3 schema, permissions, and entrypoints", () => {
    const manifestPath = resolve(__dirname, "../extension/manifest.json");
    const raw = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(raw);

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBeDefined();
    expect(manifest.version).toBeDefined();

    // Verify required Chrome MV3 permissions
    expect(manifest.permissions).toContain("tabs");
    expect(manifest.permissions).toContain("storage");
    expect(manifest.permissions).toContain("unlimitedStorage");
    expect(manifest.permissions).toContain("sessions");
    expect(manifest.permissions).toContain("contextMenus");

    // Verify OpenRouter AI API host permission
    expect(manifest.host_permissions).toContain("https://openrouter.ai/*");

    // Verify CSP restrictions
    const csp = manifest.content_security_policy?.extension_pages;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("https://openrouter.ai");
    expect(csp).toContain("frame-src 'none'");

    // Verify newtab override
    expect(manifest.chrome_url_overrides?.newtab).toBe("index.html");
  });
});
