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
  pseudonymSecret: string;
  supportAuthSecret: string;
  fixedClock: string;
}

const VALID_ENVS = ["local", "test", "staging", "production"];

function assertSecureConfig(appEnv: string): void {
  // NODE_ENV=production with APP_ENV unset used to silently run as "local" (dev token minting, seeded fixtures)
  if (process.env.NODE_ENV === "production" && !process.env.APP_ENV) {
    throw new Error("APP_ENV must be set explicitly when NODE_ENV=production.");
  }
  if (!VALID_ENVS.includes(appEnv)) {
    throw new Error(`Invalid APP_ENV '${appEnv}'. Expected one of: ${VALID_ENVS.join(", ")}.`);
  }
  if (appEnv === "staging" || appEnv === "production") {
    for (const name of ["AUTH_SECRET", "SUPPORT_AUTH_SECRET", "ACTION_GRANT_SECRET", "PSEUDONYM_SECRET"]) {
      const v = process.env[name];
      if (!v || v.length < 32 || v.includes("do_not_use")) {
        throw new Error(`${name} must be set to a real secret of at least 32 characters when APP_ENV=${appEnv}.`);
      }
    }
  }
}

export function loadConfig(): AppConfig {
  const appEnv = (process.env.APP_ENV || "local") as AppConfig["appEnv"];
  assertSecureConfig(appEnv);

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
    // Key material for subject pseudonyms and erasure tombstones. Kept apart from the JWT secret so rotating or leaking
    // the login key neither re-identifies pseudonyms nor breaks erasure/dedupe. Falls back to AUTH_SECRET only in
    // local/test so existing seeded data keeps resolving; staging/production must set it (see assertSecureConfig).
    pseudonymSecret: process.env.PSEUDONYM_SECRET || process.env.AUTH_SECRET || "dev_secret_key_abate_foundation_do_not_use_in_prod_min_32_chars!",
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

