import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // Serialized: several tests hold live WebSocket connections with tight (5-10s) timing
  // assertions against a shared WorkspaceHub DO — running them concurrently introduces
  // resource-contention flakiness that isn't representative of a real bug.
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:8787",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
