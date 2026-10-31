// backend/src/platform/config.ts
import dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  port: number;
  nodeEnv: string;
  appEnv: "local" | "test" | "staging" | "production";
  clientUrl: string;
  databaseUrlMigrator: string;
  databaseUrlApp: string;
  databaseUrlWorker: string;
  objectStoreEndpoint: string;
  authIssuer: string;
  authAudience: string;
  authSecret: string;
  actionGrantSecret: string;
  supportAuthSecret: string;
  fixedClock: string;
}

export function loadConfig(): AppConfig {
  const appEnv = (process.env.APP_ENV || "local") as AppConfig["appEnv"];

  return {
    port: parseInt(process.env.PORT || "5000", 10),
    nodeEnv: process.env.NODE_ENV || "development",
    appEnv,
    clientUrl: process.env.CLIENT_URL || "http://localhost:5173",
    databaseUrlMigrator: process.env.DATABASE_URL_MIGRATOR || "postgres://abate_migrator:migrator_pw@localhost:5432/abate",
    databaseUrlApp: process.env.DATABASE_URL_APP || "postgres://abate_app:app_pw@localhost:5432/abate",
    databaseUrlWorker: process.env.DATABASE_URL_WORKER || "postgres://abate_worker:worker_pw@localhost:5432/abate",
    objectStoreEndpoint: process.env.OBJECT_STORE_ENDPOINT || "http://localhost:9000",
    authIssuer: process.env.AUTH_ISSUER || "http://localhost:5000/auth",
    authAudience: process.env.AUTH_AUDIENCE || "abate-api",
    authSecret: process.env.AUTH_SECRET || "dev_secret_key_abate_foundation_do_not_use_in_prod_min_32_chars!",
    actionGrantSecret: process.env.ACTION_GRANT_SECRET || "dev_action_grant_key_abate_do_not_use_in_prod_min_32_chars!",
    supportAuthSecret: process.env.SUPPORT_AUTH_SECRET || "dev_support_auth_key_abate_do_not_use_in_prod_min_32_chars!",
    fixedClock: process.env.FIXED_CLOCK || "2026-03-02T09:00:00Z"
  };
}

export function assertNotProduction(action: string): void {
  const cfg = loadConfig();
  if (cfg.appEnv === "production" || cfg.appEnv === "staging") {
    throw new Error(`${action} refuses to run in APP_ENV=${cfg.appEnv}. Synthetic data and destructive actions prohibited.`);
  }
}

