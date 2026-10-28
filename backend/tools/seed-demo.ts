// backend/tools/seed-demo.ts
import { loadConfig, assertNotProduction } from "../src/platform/config";
import { seedTwoTenants } from "../src/fixtures/seed";

console.log("\x1b[36m=== Abate Task Runner: seed-demo ===\x1b[0m");

const cfg = loadConfig();

try {
  // Production guard enforced here
  assertNotProduction("seed-demo");
  const clock = new Date(cfg.fixedClock);
  
  seedTwoTenants({ clock }).then((seeded) => {
    console.log(`  [OK] Seeded Tenant A: ${seeded.tenantA.tenant.name} (${seeded.tenantA.tenant.id})`);
    console.log(`  [OK] Seeded Tenant B: ${seeded.tenantB.tenant.name} (${seeded.tenantB.tenant.id})`);
    console.log(`  [OK] Fixed clock pinned to: ${clock.toISOString()}`);
    console.log("\x1b[32m[SUCCESS] Demo dataset seeded with synthetic fixtures (ABATE-GOLDEN-01 skeleton).\x1b[0m");
  });
} catch (err: any) {
  console.error(`\x1b[31m[SEED ERROR]\x1b[0m ${err.message}`);
  process.exit(1);
}

