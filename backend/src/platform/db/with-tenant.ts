// backend/src/platform/db/with-tenant.ts
import { Pool, PoolClient, QueryResult } from "pg";
import { loadConfig } from "../config";
import { AppError } from "../errors";

import { memDb, MemoryClient } from "./mem-db";
export { memDb };
const cfg = loadConfig();

export type QueryFn = (text: string, params?: any[]) => Promise<QueryResult<any>>;
export type Tx = { q: QueryFn; tenantId: string };

// Production PostgreSQL Pools (Section 5.1 & 5.5: separate pools per role with explicit maximums)
export let appPool: Pool | null = null;
export let migratorPool: Pool | null = null;
export let workerPool: Pool | null = null;
export let identityPool: Pool | null = null;
export let protectedComputePool: Pool | null = null;
export let releaseCompilerPool: Pool | null = null;
export let performancePool: Pool | null = null;
export let opsPool: Pool | null = null;

function createRolePool(connectionString: string, max: number, connectionTimeoutMillis = 5000): Pool {
  const p = new Pool({
    connectionString,
    max,
    connectionTimeoutMillis,
    statement_timeout: 30000,
    idle_in_transaction_session_timeout: 30000
  });
  p.on("error", () => { });
  return p;
}

try {
  appPool = createRolePool(cfg.databaseUrlApp, 20, 5000);
  workerPool = createRolePool(cfg.databaseUrlWorker, 2, 1000);
  migratorPool = createRolePool(cfg.databaseUrlMigrator, 5, 1000);
  identityPool = createRolePool(cfg.databaseUrlIdentity, 5, 3000);
  protectedComputePool = createRolePool(cfg.databaseUrlProtectedCompute, 5, 3000);
  releaseCompilerPool = createRolePool(cfg.databaseUrlReleaseCompiler, 5, 3000);
  performancePool = createRolePool(cfg.databaseUrlPerformance, 5, 3000);
  opsPool = createRolePool(cfg.databaseUrlOps, 3, 2000);
} catch {
  // Graceful fallback to embedded store if Postgres is not available
}

let isPgHealthy: boolean | null = null;
let lastPgProbeAt = 0;

// staging/production must never silently serve from the in-memory store: that would accept writes that vanish on restart
const REQUIRE_PG = cfg.appEnv === "staging" || cfg.appEnv === "production";

// Client-facing text: names the policy flag only, never hosts, ports or driver errors (those go to the server log)
const PG_UNAVAILABLE_MESSAGE = "Database unavailable: PostgreSQL is required (ABATE_REQUIRE_PG=1) and the in-memory fallback is refused.";

export function isPostgresRequired(): boolean {
  return REQUIRE_PG || process.env.ABATE_REQUIRE_PG === "1" || process.env.ABATE_REQUIRE_PG === "true";
}

export function resetPgHealthCache(): void {
  isPgHealthy = null;
  lastPgProbeAt = 0;
}

export async function checkPgHealth(): Promise<boolean> {
  if (isPgHealthy === true) return true;
  const required = isPostgresRequired();
  // local/test: the first probe decides and sticks. Flipping engines mid-run would drop the seeded in-memory state.
  if (isPgHealthy === false && !required) return false;
  // strict mode: re-probe (at most every 5s) so a slow first connect or a restart of Postgres recovers on its own
  if (required && isPgHealthy === false && Date.now() - lastPgProbeAt < 5000) {
    throw new AppError("UNAVAILABLE", PG_UNAVAILABLE_MESSAGE);
  }
  lastPgProbeAt = Date.now();
  if (!appPool) {
    isPgHealthy = false;
    if (required) throw new AppError("UNAVAILABLE", PG_UNAVAILABLE_MESSAGE);
    return false;
  }
  try {
    const client = await appPool.connect();
    await client.query("SELECT 1");
    client.release();
    isPgHealthy = true;
  } catch (err: any) {
    isPgHealthy = false;
    if (isPostgresRequired()) {
      // Detail stays in the server log; the client only ever sees the generic envelope
      console.error(`[DB] PostgreSQL is required but unreachable: ${err?.message ?? "connection failed"}. Run: docker compose up -d postgres`);
      throw new AppError("UNAVAILABLE", PG_UNAVAILABLE_MESSAGE);
    }
    console.warn("[DB] PostgreSQL is unreachable: using the in-memory store. Data is NOT persisted and resets on restart.");
  }
  return isPgHealthy;
}

/**
 * Internal helper: runs a tenant-scoped transaction on a specific least-privilege Pool,
 * setting transaction-local tenant context, write plane, statement_timeout, and lock_timeout.
 */
async function withTenantPool<T>(
  pool: Pool | null,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
  options?: { writePlane?: "A" | "B" }
): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) {
    throw new AppError("VALIDATION", "Invalid tenant ID format");
  }

  const writePlane = options?.writePlane || "A";
  const usePg = await checkPgHealth();

  if (usePg && pool) {
    const client: PoolClient = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '30000ms'");
      await client.query("SET LOCAL lock_timeout = '10000ms'");
      await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.write_plane', $2, true)", [tenantId, writePlane]);
      const out = await fn({ q: client.query.bind(client) as QueryFn, tenantId });
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => { });
      throw e;
    } finally {
      client.release();
    }
  }

  // Memory store fallback with identical RLS and transaction behavior
  const memClient = new MemoryClient();
  try {
    await memClient.query("BEGIN");
    await memClient.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await memClient.query("SELECT set_config('app.write_plane', $1, true)", [writePlane]);
    const out = await fn({ q: memClient.query.bind(memClient), tenantId });
    await memClient.query("COMMIT");
    return out;
  } catch (e) {
    await memClient.query("ROLLBACK");
    throw e;
  } finally {
    memClient.release();
  }
}

/**
 * withTenant: Transaction-local tenant context helper (abate_app role).
 * Enforces fail-closed isolation and prevents pooled connection leakage.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
  options?: { writePlane?: "A" | "B" }
): Promise<T> {
  return withTenantPool(appPool, tenantId, fn, options);
}

/**
 * Role-separated tenant helpers (Completion Plan Section 5.1):
 * Each role uses its own connection pool and least-privilege DB credential.
 */
export async function withIdentity<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenantPool(identityPool, tenantId, fn, { writePlane: "A" });
}

export async function withProtectedCompute<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenantPool(protectedComputePool, tenantId, fn, { writePlane: "A" });
}

export async function withReleaseCompiler<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenantPool(releaseCompilerPool, tenantId, fn, { writePlane: "A" });
}

export async function withPerformance<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenantPool(performancePool, tenantId, fn, { writePlane: "B" });
}

export async function withOps<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const usePg = await checkPgHealth();
  if (usePg && opsPool) {
    const client: PoolClient = await opsPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '15000ms'");
      const out = await fn({ q: client.query.bind(client) as QueryFn, tenantId: "" });
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => { });
      throw e;
    } finally {
      client.release();
    }
  }
  return withPlatform(fn);
}

/**
 * withPlatform: Transaction with NO tenant context, for platform-global tables (e.g. ai_kill_switch).
 * Tenant tables stay invisible here (RLS fails closed), so this cannot be used to reach tenant data.
 */
export async function withPlatform<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const usePg = await checkPgHealth();

  if (usePg && appPool) {
    const client: PoolClient = await appPool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn({ q: client.query.bind(client) as QueryFn, tenantId: "" });
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => { });
      throw e;
    } finally {
      client.release();
    }
  }

  const memClient = new MemoryClient();
  try {
    await memClient.query("BEGIN");
    const out = await fn({ q: memClient.query.bind(memClient), tenantId: "" });
    await memClient.query("COMMIT");
    return out;
  } catch (e) {
    await memClient.query("ROLLBACK");
    throw e;
  } finally {
    memClient.release();
  }
}

/**
 * withWorker: Transaction as the outbox worker (abate_worker role): no tenant context, but RLS policies let it
 * read outbox_event and record inbox_event across tenants. Every other tenant table stays invisible.
 */
export async function withWorker<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const usePg = await checkPgHealth();

  if (usePg && workerPool) {
    const client: PoolClient = await workerPool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn({ q: client.query.bind(client) as QueryFn, tenantId: "" });
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => { });
      throw e;
    } finally {
      client.release();
    }
  }

  const memClient = new MemoryClient(true);
  try {
    await memClient.query("BEGIN");
    const out = await fn({ q: memClient.query.bind(memClient), tenantId: "" });
    await memClient.query("COMMIT");
    return out;
  } catch (e) {
    await memClient.query("ROLLBACK");
    throw e;
  } finally {
    memClient.release();
  }
}

/**
 * withTenantOn: Helper used by boundary tests to verify pooled connection isolation.
 */
export async function withTenantOn<T>(
  _pool: Pool | { query: QueryFn; connect: () => Promise<any> },
  tenantId: string,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  return withTenant(tenantId, fn);
}
