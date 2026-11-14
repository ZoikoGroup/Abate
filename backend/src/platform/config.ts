// backend/src/platform/config.ts
import dotenv from "dotenv";

dotenv.config();

export type AppEnv = "local" | "test" | "staging" | "production";
export type ObjectStoreMode = "memory" | "s3";

export interface AppConfig {
  port: number;
  nodeEnv: string;
  appEnv: AppEnv;
  clientUrl: string;
  databaseUrlMigrator: string;
  databaseUrlApp: string;
  databaseUrlWorker: string;
  objectStoreEndpoint: string;
  objectStoreBucket: string;
  objectStoreRegion: string;
  objectStoreAccessKey: string;
  objectStoreSecretKey: string;
  objectStoreMode: ObjectStoreMode;
  authIssuer: string;
  authAudience: string;
  authSecret: string;
  actionGrantSecret: string;
  supportAuthSecret: string;
  fixedClock: string;
}

// Development-only fallbacks. These exact values are refused outside local and test.
export const DEV_DEFAULTS = {
  databaseUrlMigrator: "postgres://abate_migrator:migrator_pw@localhost:5432/abate",
  databaseUrlApp: "postgres://abate_app:app_pw@localhost:5432/abate",
  databaseUrlWorker: "postgres://abate_worker:worker_pw@localhost:5432/abate",
  objectStoreEndpoint: "http://localhost:9000",
  objectStoreBucket: "abate-artifacts",
  objectStoreAccessKey: "minioadmin",
  objectStoreSecretKey: "minioadmin_dev_only",
  authSecret: "dev_secret_key_abate_foundation_do_not_use_in_prod_min_32_chars!",
  actionGrantSecret: "dev_action_grant_key_abate_do_not_use_in_prod_min_32_chars!",
  supportAuthSecret: "dev_support_auth_key_abate_do_not_use_in_prod_min_32_chars!",
  fixedClock: "2026-03-02T09:00:00Z"
} as const;

export const MIN_SECRET_LENGTH = 32;
const KNOWN_ENVS: AppEnv[] = ["local", "test", "staging", "production"];

export function isHardenedEnv(appEnv: string): boolean {
  return appEnv === "staging" || appEnv === "production";
}

function resolveObjectStoreMode(appEnv: AppEnv, env: NodeJS.ProcessEnv): ObjectStoreMode {
  const raw = (env.OBJECT_STORE_MODE || "").toLowerCase();
  if (raw === "memory" || raw === "s3") {
    return raw;
  }
  // Durable storage is the default wherever evidence must survive a restart
  return isHardenedEnv(appEnv) ? "s3" : "memory";
}

export function buildConfig(env: NodeJS.ProcessEnv): AppConfig {
  const appEnv = (env.APP_ENV || "local") as AppEnv;

  return {
    port: parseInt(env.PORT || "5000", 10),
    nodeEnv: env.NODE_ENV || "development",
    appEnv,
    clientUrl: env.CLIENT_URL || "http://localhost:5173",
    databaseUrlMigrator: env.DATABASE_URL_MIGRATOR || DEV_DEFAULTS.databaseUrlMigrator,
    databaseUrlApp: env.DATABASE_URL_APP || DEV_DEFAULTS.databaseUrlApp,
    databaseUrlWorker: env.DATABASE_URL_WORKER || DEV_DEFAULTS.databaseUrlWorker,
    objectStoreEndpoint: env.OBJECT_STORE_ENDPOINT || DEV_DEFAULTS.objectStoreEndpoint,
    objectStoreBucket: env.OBJECT_STORE_BUCKET || DEV_DEFAULTS.objectStoreBucket,
    objectStoreRegion: env.OBJECT_STORE_REGION || "us-east-1",
    objectStoreAccessKey: env.OBJECT_STORE_ACCESS_KEY || DEV_DEFAULTS.objectStoreAccessKey,
    objectStoreSecretKey: env.OBJECT_STORE_SECRET_KEY || DEV_DEFAULTS.objectStoreSecretKey,
    objectStoreMode: resolveObjectStoreMode(appEnv, env),
    authIssuer: env.AUTH_ISSUER || "http://localhost:5000/auth",
    authAudience: env.AUTH_AUDIENCE || "abate-api",
    authSecret: env.AUTH_SECRET || DEV_DEFAULTS.authSecret,
    actionGrantSecret: env.ACTION_GRANT_SECRET || DEV_DEFAULTS.actionGrantSecret,
    supportAuthSecret: env.SUPPORT_AUTH_SECRET || DEV_DEFAULTS.supportAuthSecret,
    fixedClock: env.FIXED_CLOCK || DEV_DEFAULTS.fixedClock
  };
}

/**
 * validateRuntimeConfig: Fails closed outside local and test.
 * Returns the full list of problems (empty when valid); assertRuntimeConfig throws on any.
 * Never echoes secret values, only the variable names that are wrong.
 */
export function validateRuntimeConfig(cfg: AppConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];

  if (!KNOWN_ENVS.includes(cfg.appEnv)) {
    problems.push(`APP_ENV must be one of ${KNOWN_ENVS.join(", ")}`);
    return problems;
  }

  if (!isHardenedEnv(cfg.appEnv)) {
    return problems;
  }

  const secrets: Array<[string, string, string]> = [
    ["AUTH_SECRET", cfg.authSecret, DEV_DEFAULTS.authSecret],
    ["SUPPORT_AUTH_SECRET", cfg.supportAuthSecret, DEV_DEFAULTS.supportAuthSecret],
    ["ACTION_GRANT_SECRET", cfg.actionGrantSecret, DEV_DEFAULTS.actionGrantSecret],
    ["OBJECT_STORE_SECRET_KEY", cfg.objectStoreSecretKey, DEV_DEFAULTS.objectStoreSecretKey]
  ];
  for (const [name, value, devDefault] of secrets) {
    if (!env[name]) {
      problems.push(`${name} must be set explicitly`);
    } else if (value === devDefault) {
      problems.push(`${name} must not use the development default`);
    } else if (value.length < MIN_SECRET_LENGTH) {
      problems.push(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
    }
  }

  // Zero impersonation (B8): tenant, support, and grant keys must be three different keys
  const signingKeys = [cfg.authSecret, cfg.supportAuthSecret, cfg.actionGrantSecret];
  if (new Set(signingKeys).size !== signingKeys.length) {
    problems.push("AUTH_SECRET, SUPPORT_AUTH_SECRET and ACTION_GRANT_SECRET must all be different");
  }

  const urls: Array<[string, string, string]> = [
    ["DATABASE_URL_MIGRATOR", cfg.databaseUrlMigrator, DEV_DEFAULTS.databaseUrlMigrator],
    ["DATABASE_URL_APP", cfg.databaseUrlApp, DEV_DEFAULTS.databaseUrlApp],
    ["DATABASE_URL_WORKER", cfg.databaseUrlWorker, DEV_DEFAULTS.databaseUrlWorker],
    ["OBJECT_STORE_ENDPOINT", cfg.objectStoreEndpoint, DEV_DEFAULTS.objectStoreEndpoint]
  ];
  for (const [name, value, devDefault] of urls) {
    if (!env[name]) {
      problems.push(`${name} must be set explicitly`);
    } else if (value === devDefault) {
      problems.push(`${name} must not use the development default`);
    }
  }

  // Role separation: the runtime must never connect with the migrator's elevated role
  if (cfg.databaseUrlApp === cfg.databaseUrlMigrator) {
    problems.push("DATABASE_URL_APP must differ from DATABASE_URL_MIGRATOR");
  }
  if (cfg.databaseUrlWorker === cfg.databaseUrlMigrator || cfg.databaseUrlWorker === cfg.databaseUrlApp) {
    problems.push("DATABASE_URL_WORKER must be its own role");
  }

  if (env.ABATE_REQUIRE_PG !== "1") {
    problems.push("ABATE_REQUIRE_PG must be 1 so the app never falls back to the in-memory database");
  }

  if (!env.OBJECT_STORE_ACCESS_KEY || cfg.objectStoreAccessKey === DEV_DEFAULTS.objectStoreAccessKey) {
    problems.push("OBJECT_STORE_ACCESS_KEY must be set explicitly and differ from the development default");
  }

  if (cfg.objectStoreMode !== "s3") {
    problems.push("OBJECT_STORE_MODE must be s3 so evidence survives a restart");
  }

  if (env.FIXED_CLOCK) {
    problems.push("FIXED_CLOCK must not be set; a frozen clock is a time-travel hazard");
  }

  return problems;
}

export function assertRuntimeConfig(cfg: AppConfig, env: NodeJS.ProcessEnv = process.env): void {
  const problems = validateRuntimeConfig(cfg, env);
  if (problems.length > 0) {
    throw new Error(`Refusing to start in APP_ENV=${cfg.appEnv}: ${problems.join("; ")}`);
  }
}

export function loadConfig(): AppConfig {
  const cfg = buildConfig(process.env);
  // Fail closed at every entry point, not only at server boot
  assertRuntimeConfig(cfg, process.env);
  return cfg;
}

export function assertNotProduction(action: string): void {
  const cfg = loadConfig();
  if (cfg.appEnv === "production" || cfg.appEnv === "staging") {
    throw new Error(`${action} refuses to run in APP_ENV=${cfg.appEnv}. Synthetic data and destructive actions prohibited.`);
  }
}
