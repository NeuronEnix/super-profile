import { describe, expect, it } from "vitest";
import { isAppHost, normalizeHost } from "../src/domains/host";

const APP_URL = "https://sp.hyugorix.com";

describe("normalizeHost", () => {
  it("lowercases and strips the port", () => {
    expect(normalizeHost("Docs.Kaushikrb.com:443")).toBe("docs.kaushikrb.com");
    expect(normalizeHost("localhost:8787")).toBe("localhost");
  });

  it("handles missing header", () => {
    expect(normalizeHost(undefined)).toBe("");
    expect(normalizeHost("  ")).toBe("");
  });
});

describe("isAppHost", () => {
  it("recognizes the app origin, localhost and workers.dev", () => {
    expect(isAppHost("sp.hyugorix.com", APP_URL)).toBe(true);
    expect(isAppHost("localhost", APP_URL)).toBe(true);
    expect(isAppHost("127.0.0.1", APP_URL)).toBe(true);
    expect(isAppHost("super-profile.foo.workers.dev", APP_URL)).toBe(true);
    expect(isAppHost("", APP_URL)).toBe(true); // no Host header is never a customer domain
  });

  it("treats customer domains as non-app hosts", () => {
    expect(isAppHost("docs.kaushikrb.com", APP_URL)).toBe(false);
    expect(isAppHost("hyugorix.com", APP_URL)).toBe(false);
    expect(isAppHost("evil-sp.hyugorix.com.attacker.dev", APP_URL)).toBe(false);
  });
});
