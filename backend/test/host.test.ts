import { describe, expect, it } from "vitest";
import { appZone, isAppHost, isValidHostname, normalizeHost } from "../src/domains/host";

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

describe("isValidHostname", () => {
  it("accepts full domains and subdomains", () => {
    expect(isValidHostname("docs.kaushikrb.com")).toBe(true);
    expect(isValidHostname("help.docs.acme-corp.io")).toBe(true);
    expect(isValidHostname("a1.b2.c3")).toBe(true);
  });

  it("rejects bare labels, schemes, paths and junk", () => {
    expect(isValidHostname("docs")).toBe(false); // needs at least one dot
    expect(isValidHostname("https://docs.acme.com")).toBe(false);
    expect(isValidHostname("docs.acme.com/help")).toBe(false);
    expect(isValidHostname("-docs.acme.com")).toBe(false);
    expect(isValidHostname("docs..acme.com")).toBe(false);
    expect(isValidHostname("docs .acme.com")).toBe(false);
    expect(isValidHostname("")).toBe(false);
    expect(isValidHostname(`${"a".repeat(260)}.com`)).toBe(false);
  });
});

describe("appZone", () => {
  it("reduces the app host to its registrable zone", () => {
    expect(appZone("https://sp.hyugorix.com")).toBe("hyugorix.com");
    expect(appZone("http://localhost:8787")).toBe("localhost");
  });
});
