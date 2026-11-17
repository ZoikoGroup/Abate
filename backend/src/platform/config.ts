// backend/src/platform/config.ts
import fs from "node:fs";
import path from "node:path";
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
  pseudonymSecret: string;
  supportAuthSecret: string;
  fixedClock: string;
  disableDevToken: boolean;
  oidcJwksUri: string;
  oidcJwksJson: string;
  oidcPublicKeyPem: string;
  oidcAuthorizationEndpoint: string;
  oidcTokenEndpoint: string;
  oidcClientId: string;
  oidcTenantClaim: string;
  oidcRoleClaim: string;
  structuredLogs: boolean;
  metricsAuthToken: string;
  alertWebhookUrl: string;
  cookieSecure: boolean;
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

export function isDevTokenEnabled(cfg: Pick<AppConfig, "appEnv" | "disableDevToken">): boolean {
  return (cfg.appEnv === "local" || cfg.appEnv === "test") && !cfg.disableDevToken;
}

interface ResolvedSecretEnv {
  env: NodeJS.ProcessEnv;
  errors: string[];
}

function resolveSecretEnv(inputEnv: NodeJS.ProcessEnv): ResolvedSecretEnv {
  const effective: NodeJS.ProcessEnv = { ...inputEnv };
  const errors: string[] = [];

  if (inputEnv.ABATE_SECRETS_FILE) {
    try {
      const raw = fs.readFileSync(inputEnv.ABATE_SECRETS_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        errors.push("ABATE_SECRETS_FILE must contain a JSON object");
      } else {
        for (const [key, val] of Object.entries(parsed)) {
          if (/^[A-Z][A-Z0-9_]*$/.test(key) && val !== null && val !== undefined && !effective[key]) {
            effective[key] = typeof val === "string" ? val : JSON.stringify(val);
          }
        }
      }
    } catch {
      errors.push("ABATE_SECRETS_FILE could not be read or parsed as JSON");
    }
  }

  if (inputEnv.ABATE_SECRETS_DIR) {
    try {
      const entries = fs.readdirSync(inputEnv.ABATE_SECRETS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !/^[A-Z][A-Z0-9_]*$/.test(entry.name)) continue;
        if (effective[entry.name]) continue;
        const val = fs.readFileSync(path.join(inputEnv.ABATE_SECRETS_DIR, entry.name), "utf-8").trim();
        if (val) {
          effective[entry.name] = val;
        }
      }
    } catch {
      errors.push("ABATE_SECRETS_DIR could not be read");
    }
  }

  return { env: effective, errors };
}

function normalizePem(raw: string | undefined): string {
  return raw ? raw.replace(/\\n/g, "\n").trim() : "";
}

function resolveObjectStoreMode(appEnv: AppEnv, env: NodeJS.ProcessEnv): ObjectStoreMode {
  const raw = (env.OBJECT_STORE_MODE || "").toLowerCase();
  if (raw === "memory" || raw === "s3") {
    return raw;
  }
  // Durable storage is the default wherever evidence must survive a restart
  return isHardenedEnv(appEnv) ? "s3" : "memory";
}

export function buildConfig(inputEnv: NodeJS.ProcessEnv): AppConfig {
  const { env } = resolveSecretEnv(inputEnv);
  // NODE_ENV=production with APP_ENV unset used to silently run as "local" (dev token minting, seeded fixtures)
  if (env.NODE_ENV === "production" && !env.APP_ENV) {
    throw new Error("APP_ENV must be set explicitly when NODE_ENV=production.");
  }
  const appEnv = (env.APP_ENV || "local") as AppEnv;
  const clientUrl = env.CLIENT_URL || "http://localhost:5173";
  const hardened = isHardenedEnv(appEnv);

  return {
    port: parseInt(env.PORT || "5000", 10),
    nodeEnv: env.NODE_ENV || "development",
    appEnv,
    clientUrl,
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
    // Key material for subject pseudonyms and erasure tombstones, kept apart from the JWT secret so rotating or leaking
    // the login key neither re-identifies pseudonyms nor breaks erasure/dedupe. Falls back to AUTH_SECRET only in
    // local/test so seeded data keeps resolving; staging/production must set it (see validateRuntimeConfig).
    pseudonymSecret: env.PSEUDONYM_SECRET || env.AUTH_SECRET || DEV_DEFAULTS.authSecret,
    actionGrantSecret: env.ACTION_GRANT_SECRET || DEV_DEFAULTS.actionGrantSecret,
    supportAuthSecret: env.SUPPORT_AUTH_SECRET || DEV_DEFAULTS.supportAuthSecret,
    fixedClock: env.FIXED_CLOCK || DEV_DEFAULTS.fixedClock,
    disableDevToken:
      env.ABATE_DISABLE_DEV_TOKEN === "1" ||
      env.ABATE_DISABLE_DEV_TOKEN === "true" ||
      hardened,
    oidcJwksUri: env.OIDC_JWKS_URI || "",
    oidcJwksJson: env.OIDC_JWKS_JSON || "",
    oidcPublicKeyPem: normalizePem(env.OIDC_PUBLIC_KEY_PEM),
    oidcAuthorizationEndpoint: env.OIDC_AUTHORIZATION_ENDPOINT || "",
    oidcTokenEndpoint: env.OIDC_TOKEN_ENDPOINT || "",
    oidcClientId: env.OIDC_CLIENT_ID || "",
    oidcTenantClaim: env.OIDC_TENANT_CLAIM || "tenant_id",
    oidcRoleClaim: env.OIDC_ROLE_CLAIM || "role",
    structuredLogs:
      env.ABATE_STRUCTURED_LOGS === "1" ||
      env.ABATE_STRUCTURED_LOGS === "true" ||
      hardened,
    metricsAuthToken: env.METRICS_AUTH_TOKEN || "",
    alertWebhookUrl: env.ALERT_WEBHOOK_URL || "",
    cookieSecure: clientUrl.startsWith("https://") || appEnv === "production"
  };
}

/**
 * validateRuntimeConfig: Fails closed outside local and test.
 * Returns the full list of problems (empty when valid); assertRuntimeConfig throws on any.
 * Never echoes secret values, only the variable names that are wrong.
 */
export function validateRuntimeConfig(cfg: AppConfig, inputEnv: NodeJS.ProcessEnv = process.env): string[] {
  const { env, errors: secretErrors } = resolveSecretEnv(inputEnv);
  const problems: string[] = [...secretErrors];

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
    ["PSEUDONYM_SECRET", cfg.pseudonymSecret, DEV_DEFAULTS.authSecret],
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

  // Pilot OIDC & TLS hygiene: outside local/test, dev tokens are off so asymmetric OIDC keys are mandatory
  if (!cfg.oidcJwksUri && !cfg.oidcJwksJson && !cfg.oidcPublicKeyPem) {
    problems.push("OIDC_JWKS_URI, OIDC_JWKS_JSON, or OIDC_PUBLIC_KEY_PEM must be configured outside local/test");
  }

  if (cfg.appEnv === "production") {
    if (!cfg.clientUrl.startsWith("https://")) {
      problems.push("CLIENT_URL must use https:// in production");
    }
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(cfg.authIssuer)) {
      problems.push("AUTH_ISSUER must not use localhost in production");
    }
  }

  return problems;
}

export function assertRuntimeConfig(cfg: AppConfig, env: NodeJS.ProcessEnv = process.env): void {
  const problems = validateRuntimeConfig(cfg, env);
  if (problems.length > 0) {
    throw new Error(`Refusing to start in APP_ENV=${cfg.appEnv}: ${problems.join("; ")}`);
  }
}

let cachedConfig: { key: string; cfg: AppConfig } | null = null;
let cachedSecretEnv: { key: string; resolved: ResolvedSecretEnv } | null = null;

export function resetConfigCache(): void {
  cachedConfig = null;
  cachedSecretEnv = null;
}

export function loadConfig(): AppConfig {
  const key = [
    process.env.APP_ENV || "",
    process.env.ABATE_DISABLE_DEV_TOKEN || "",
    process.env.ABATE_SECRETS_FILE || "",
    process.env.ABATE_SECRETS_DIR || "",
    process.env.OIDC_JWKS_URI || "",
    process.env.OIDC_JWKS_JSON || "",
    process.env.OIDC_PUBLIC_KEY_PEM || "",
    process.env.OIDC_AUTHORIZATION_ENDPOINT || "",
    process.env.OIDC_TOKEN_ENDPOINT || "",
    process.env.OIDC_CLIENT_ID || "",
    process.env.AUTH_ISSUER || "",
    process.env.AUTH_AUDIENCE || "",
    process.env.CLIENT_URL || "",
    process.env.ABATE_STRUCTURED_LOGS || "",
    process.env.METRICS_AUTH_TOKEN || ""
  ].join("|");

  if (cachedConfig && cachedConfig.key === key) {
    return cachedConfig.cfg;
  }

  const secretKey = `${process.env.ABATE_SECRETS_FILE || ""}|${process.env.ABATE_SECRETS_DIR || ""}`;
  let effectiveInput = process.env;
  if (process.env.ABATE_SECRETS_FILE || process.env.ABATE_SECRETS_DIR) {
    if (!cachedSecretEnv || cachedSecretEnv.key !== secretKey) {
      cachedSecretEnv = { key: secretKey, resolved: resolveSecretEnv(process.env) };
    }
    effectiveInput = { ...cachedSecretEnv.resolved.env, ...process.env };
  }

  const cfg = buildConfig(effectiveInput);
  // Fail closed at every entry point, not only at server boot
  assertRuntimeConfig(cfg, effectiveInput);
  cachedConfig = { key, cfg };
  return cfg;
}

export function assertNotProduction(action: string): void {
  const cfg = loadConfig();
  if (cfg.appEnv === "production" || cfg.appEnv === "staging") {
    throw new Error(`${action} refuses to run in APP_ENV=${cfg.appEnv}. Synthetic data and destructive actions prohibited.`);
  }
}
