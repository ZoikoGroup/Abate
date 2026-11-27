// tests/playwright.config.ts
import { defineConfig, devices } from "@playwright/test";

const isCi = Boolean(process.env.CI);
const backendPort = process.env.PLAYWRIGHT_BACKEND_PORT || (isCi ? "5000" : "5055");
const frontendPort = process.env.PLAYWRIGHT_FRONTEND_PORT || (isCi ? "5173" : "5174");
const baseURL = process.env.PLAYWRIGHT_TEST_BASE_URL || `http://127.0.0.1:${frontendPort}`;
if (!process.env.PLAYWRIGHT_TEST_BASE_URL) {
  process.env.PLAYWRIGHT_TEST_BASE_URL = baseURL;
}
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
        url: `http://127.0.0.1:${backendPort}/api/health`,
        reuseExistingServer: false,
        timeout: 60_000,
        env: {
          ...process.env,
          APP_ENV: process.env.APP_ENV || "test",
          ABATE_REQUIRE_PG: process.env.ABATE_REQUIRE_PG || "0",
          DATABASE_URL_MIGRATOR: process.env.DATABASE_URL_MIGRATOR || "postgres://disabled:disabled@127.0.0.1:1/abate",
          DATABASE_URL_APP: process.env.DATABASE_URL_APP || "postgres://disabled:disabled@127.0.0.1:1/abate",
          DATABASE_URL_WORKER: process.env.DATABASE_URL_WORKER || "postgres://disabled:disabled@127.0.0.1:1/abate",
          DATABASE_URL_PLATFORM_ADMIN: process.env.DATABASE_URL_PLATFORM_ADMIN || "postgres://disabled:disabled@127.0.0.1:1/abate",
          PORT: backendPort
        }
      },
      {
        command: `npm --prefix ../frontend run dev -- --host 127.0.0.1 --port ${frontendPort} --strictPort`,
        url: baseURL,
        reuseExistingServer: false,
        timeout: 60_000,
        env: {
          ...process.env,
          VITE_API_TARGET: `http://127.0.0.1:${backendPort}`,
          VITE_PORT: frontendPort
        }
      }
    ]
});
