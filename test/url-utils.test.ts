import { expect, test, describe } from "bun:test";

const {
  extractHostname,
  normalizeUrlForCache,
  stripUrlQueryParams,
  isRealTabUrl,
  smartTitle,
  getFaviconUrl,
  stripTitleNoise
} = require("../extension/app.js");

describe("extractHostname", () => {
  test("extracts clean hostname from standard URLs", () => {
    expect(extractHostname("https://example.com/path")).toBe("example.com");
    expect(extractHostname("http://sub.domain.co.uk/page?q=1")).toBe("sub.domain.co.uk");
    expect(extractHostname("https://www.google.com/")).toBe("google.com");
    expect(extractHostname("http://localhost:3000/api")).toBe("localhost");
  });

  test("handles IPv6 bracketed hosts without truncation or URIError", () => {
    expect(extractHostname("http://[2001:db8::1]:8080/index.html")).toBe("[2001:db8::1]");
    expect(extractHostname("https://[::1]/test")).toBe("[::1]");
  });

  test("returns empty string or fallback for invalid, non-http, or empty URLs", () => {
    expect(extractHostname("")).toBe("");
    expect(extractHostname(null)).toBe("");
    expect(extractHostname(undefined)).toBe("");
    expect(extractHostname("not-a-valid-url")).toBe("");
  });
});

describe("normalizeUrlForCache — Privacy & Canonicalization", () => {
  test("strips tracking parameters and sorts remaining query parameters", () => {
    const raw = "https://example.com/item?utm_source=twitter&b=2&utm_medium=cpc&a=1&fbclid=xyz#heading";
    const normalized = normalizeUrlForCache(raw);

    expect(normalized).toBe("https://example.com/item?a=1&b=2");
    expect(normalized).not.toContain("utm_source");
    expect(normalized).not.toContain("fbclid");
    expect(normalized).not.toContain("#heading");
  });

  test("strips basic auth credentials to prevent credential leaks in cache", () => {
    const raw = "https://admin:secret123@gitlab.example.com/org/repo";
    const normalized = normalizeUrlForCache(raw);

    expect(normalized).toBe("https://gitlab.example.com/org/repo");
    expect(normalized).not.toContain("admin");
    expect(normalized).not.toContain("secret123");
  });

  test("returns empty string or safe fallback on corrupt input", () => {
    expect(normalizeUrlForCache("")).toBe("");
    expect(normalizeUrlForCache(null)).toBe("");
  });
});

describe("stripUrlQueryParams — LLM Privacy Guard", () => {
  test("strips all query parameters from URL payload", () => {
    expect(stripUrlQueryParams("https://api.example.com/v1/search?token=secret&q=antigravity")).toBe("https://api.example.com/v1/search");
  });

  test("strips user credentials from URL", () => {
    expect(stripUrlQueryParams("https://bob:hunter2@example.com/dashboard?view=all")).toBe("https://example.com/dashboard");
  });

  test("handles URLs with no query string cleanly", () => {
    expect(stripUrlQueryParams("https://example.com/about")).toBe("https://example.com/about");
  });
});

describe("isRealTabUrl — Protocol Whitelist", () => {
  test("accepts valid web protocols", () => {
    expect(isRealTabUrl("https://github.com")).toBe(true);
    expect(isRealTabUrl("http://localhost:8080")).toBe(true);
  });

  test("rejects internal browser schemes and non-web protocols", () => {
    expect(isRealTabUrl("chrome://settings")).toBe(false);
    expect(isRealTabUrl("chrome://newtab")).toBe(false);
    expect(isRealTabUrl("chrome-extension://abcdefg/index.html")).toBe(false);
    expect(isRealTabUrl("devtools://devtools/bundled/inspector.html")).toBe(false);
    expect(isRealTabUrl("data:text/html,<h1>Hello</h1>")).toBe(false);
    expect(isRealTabUrl("about:blank")).toBe(false);
    expect(isRealTabUrl("edge://settings")).toBe(false);
    expect(isRealTabUrl("")).toBe(false);
    expect(isRealTabUrl(null)).toBe(false);
  });
});

describe("smartTitle — Title Formatting", () => {
  test("formats GitHub branch root cleanly as repo (branch)", () => {
    expect(smartTitle("repo/branch/", "https://github.com/org/repo/tree/branch/")).toBe("org/repo (branch)");
  });

  test("generates readable post label for X/Twitter URLs when title is generic", () => {
    expect(smartTitle("", "https://x.com/antigravity/status/123456")).toBe("Post by @antigravity");
  });

  test("returns original title when title is already descriptive", () => {
    expect(smartTitle("Antigravity AI 2.0 Release", "https://example.com/release")).toBe("Antigravity AI 2.0 Release");
  });
});

describe("getFaviconUrl — MV3 Favicon Protocol", () => {
  test("generates native MV3 favicon URL using chrome.runtime.getURL", () => {
    const origChrome = (globalThis as any).chrome;
    try {
      (globalThis as any).chrome = {
        runtime: {
          getURL: (path: string) => `chrome-extension://test-ext-id${path}`
        }
      };

      const favicon = getFaviconUrl("https://example.com/blog/article?token=abc#comments");
      expect(favicon).toContain("chrome-extension://test-ext-id/_favicon/?pageUrl=");
      // Verifies token and hash are stripped from the requested favicon URL
      expect(favicon).not.toContain("token=abc");
      expect(favicon).not.toContain("#comments");
    } finally {
      (globalThis as any).chrome = origChrome;
    }
  });

  test("returns empty string when chrome runtime API is unavailable", () => {
    const origChrome = (globalThis as any).chrome;
    try {
      delete (globalThis as any).chrome;
      expect(getFaviconUrl("https://example.com")).toBe("");
    } finally {
      (globalThis as any).chrome = origChrome;
    }
  });
});

describe("stripTitleNoise — Title Sanitizer sent to Jev", () => {
  test("strips unread counts and notifications from title", () => {
    expect(stripTitleNoise("(5) Inbox - Work Email")).toBe("Inbox - Work Email");
    expect(stripTitleNoise("(99+) Notifications / Feed")).toBe("Notifications / Feed");
  });

  test("sanitizes email addresses to prevent PII leakage to LLMs", () => {
    expect(stripTitleNoise("Gmail - user.name+tag@example.com - Inbox")).toBe("Gmail - Inbox");
    expect(stripTitleNoise("Account for ceo@corp.com")).toBe("Account for");
  });

  test("sanitizes trailing X / Twitter brand suffixes", () => {
    expect(stripTitleNoise("Breaking Tech News on X: Revolutionary Model / X")).toBe("Breaking Tech News: Revolutionary Model");
  });
});

describe("safeUrl — Protocol Whitelist & XSS Defense", () => {
  const { safeUrl } = require("../extension/app.js");

  test("accepts valid http and https web URLs", () => {
    expect(safeUrl("https://example.com/page")).toBe("https://example.com/page");
    expect(safeUrl("http://localhost:8080/dashboard")).toBe("http://localhost:8080/dashboard");
  });

  test("rejects non-web, local file, and internal browser schemes with safe fallback", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("#");
    expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBe("#");
    expect(safeUrl("file:///C:/Users/passwords.txt")).toBe("#");
    expect(safeUrl("chrome://settings")).toBe("#");
    expect(safeUrl("chrome-extension://xyz/options.html")).toBe("#");
    expect(safeUrl("")).toBe("#");
    expect(safeUrl(null as any)).toBe("#");
  });

  test("strips cleartext HTTP Basic Auth credentials from valid URLs", () => {
    expect(safeUrl("https://admin:superSecret123@gitlab.corp/repo")).toBe("https://gitlab.corp/repo");
    expect(safeUrl("http://user:pass@localhost:3000/")).toBe("http://localhost:3000/");
    expect(safeUrl("https://user:pass@example.com/api?key=1#section")).toBe("https://example.com/api?key=1#section");
  });
});

describe("stripCredentialsFromUrl — Sensitive Credential Scrubber", () => {
  const { stripCredentialsFromUrl } = require("../extension/app.js");

  test("strips user:pass from URLs with and without paths", () => {
    expect(stripCredentialsFromUrl("https://admin:SecretPassword@gitlab.internal")).toBe("https://gitlab.internal");
    expect(stripCredentialsFromUrl("https://admin:SecretPassword@gitlab.internal/")).toBe("https://gitlab.internal/");
    expect(stripCredentialsFromUrl("https://admin:SecretPassword@gitlab.internal/project/app")).toBe("https://gitlab.internal/project/app");
  });

  test("leaves clean URLs unaltered", () => {
    expect(stripCredentialsFromUrl("https://youtube.com")).toBe("https://youtube.com");
    expect(stripCredentialsFromUrl("https://youtube.com/watch?v=123")).toBe("https://youtube.com/watch?v=123");
  });

  test("strips user:pass from malformed URLs where new URL throws", () => {
    // Malformed percent-encoding causes new URL() to throw URIError
    const malformed = "https://user:pass@invalid%domain:999999/path";
    expect(stripCredentialsFromUrl(malformed)).toBe("https://invalid%domain:999999/path");
  });

  test("isolates authority correctly so @ in path or query is preserved in malformed URLs", () => {
    const malformedWithPathAt = "https://invalid%domain:999999/profile/@alice";
    expect(stripCredentialsFromUrl(malformedWithPathAt)).toBe("https://invalid%domain:999999/profile/@alice");

    const malformedWithQueryAt = "https://invalid%domain:999999/search?q=@antigravity";
    expect(stripCredentialsFromUrl(malformedWithQueryAt)).toBe("https://invalid%domain:999999/search?q=@antigravity");
  });

  test("strips credentials even when password itself contains @ symbol in malformed URLs", () => {
    const malformedComplexPass = "https://user:p@ssword123@invalid%domain:999999/resource";
    expect(stripCredentialsFromUrl(malformedComplexPass)).toBe("https://invalid%domain:999999/resource");
  });
});


