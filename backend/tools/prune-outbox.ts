// backend/tools/prune-outbox.ts
import { prunePublishedOutbox } from "../src/worker/outbox-publisher";

console.log("\x1b[36m=== Abate Task Runner: prune-outbox (Section 5.5 Maintenance) ===\x1b[0m");

async function main() {
  const hoursArg = process.argv.find((a) => a.startsWith("--hours="));
  const batchArg = process.argv.find((a) => a.startsWith("--batch="));

  const hours = hoursArg ? Number(hoursArg.split("=")[1]) : 168; // 7 days default
  const batch = batchArg ? Number(batchArg.split("=")[1]) : 500;

  console.log(`Pruning published outbox events older than ${hours} hours (batch size: ${batch})...`);
  const result = await prunePublishedOutbox(hours, batch);
  console.log(`\x1b[32m[SUCCESS] Pruned ${result.prunedCount} published outbox events (threshold: ${hours}h).\x1b[0m`);
}

main().catch((err) => {
  console.error("\x1b[31m[ERROR]\x1b[0m", err?.message || err);
  process.exit(1);
});
