// tests/playwright.config.ts
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_TEST_BASE_URL || "http://127.0.0.1:5173";
const skipWebServer = process.env.PLAYWRIGHT_SKIP_WEBSERVER === "1";

export default defineConfig({
  testDir: ".",
  testMatch: ["e2e/**/*.spec.ts", "a11y/**/*.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: skipWebServer
    ? undefined
    : [
        {
          command: "npm --prefix ../backend run serve",
          url: "http://127.0.0.1:5000/api/health",
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
          env: {
            ...process.env,
            APP_ENV: process.env.APP_ENV || "test",
            PORT: "5000"
          }
        },
        {
          command: "npm --prefix ../frontend run dev -- --host 127.0.0.1 --port 5173 --strictPort",
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000
        }
      ]
});
