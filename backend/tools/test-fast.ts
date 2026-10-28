// backend/tools/test-fast.ts
import assert from "node:assert";
import { CreateOrganizationBody, ErrorBody } from "../src/contracts";
import { createDevToken, authenticate } from "../src/domains/tenant/auth";
import { computeRequestHash } from "../src/platform/command";
import { AppError } from "../src/platform/errors";
import { GOLDEN_01 } from "../src/fixtures/golden01";

console.log("\x1b[36m=== Abate Task Runner: test-fast (Unit & Policy Invariants) ===\x1b[0m");

let passed = 0;

function it(name: string, fn: () => void | Promise<void>) {
  try {
    const res = fn();
    if (res instanceof Promise) {
      return res.then(() => {
        console.log(`  \x1b[32m✔\x1b[0m ${name}`);
        passed++;
      }).catch((err) => {
        console.error(`  \x1b[31m✖\x1b[0m ${name}: ${err.message}`);
        process.exit(1);
      });
    }
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  \x1b[31m✖\x1b[0m ${name}: ${err.message}`);
    process.exit(1);
  }
}

async function runTests() {
  it("Zod schema strictly rejects unknown / prohibited fields", () => {
    // Normal payload succeeds
    const valid = CreateOrganizationBody.parse({ name: "Litigation Practice" });
    assert.strictEqual(valid.name, "Litigation Practice");

    // Prohibited / injected fields must throw Zod validation error
    assert.throws(() => {
      CreateOrganizationBody.parse({
        name: "Tax Group",
        keystroke_log: "sensitive_keystrokes_prohibited" // Constitutional boundary violation
      });
    });
  });

  it("Canonical request hash is deterministic regardless of key order", () => {
    const hash1 = computeRequestHash({ name: "Practice A", parentId: "123" });
    const hash2 = computeRequestHash({ parentId: "123", name: "Practice A" });
    assert.strictEqual(hash1, hash2);
  });

  it("AppError formats safe codes and safe status codes", () => {
    const err = new AppError("NOT_FOUND");
    assert.strictEqual(err.statusCode, 404);
    assert.strictEqual(err.code, "NOT_FOUND");
    assert.strictEqual(err.message, "Not found.");
  });

  await it("JWT creation and authentication binds tenant identity strictly", async () => {
    const token = createDevToken({
      tenantId: GOLDEN_01.tenantA.id,
      subject: "auth0|user-fast-test",
      role: "RISK_OWNER"
    });

    const identity = await authenticate(`Bearer ${token}`);
    assert.strictEqual(identity.tenantId, GOLDEN_01.tenantA.id);
    assert.strictEqual(identity.subject, "auth0|user-fast-test");
    assert.strictEqual(identity.role, "RISK_OWNER");
  });

  await it("Authentication fails closed on missing or forged token", async () => {
    await assert.rejects(async () => {
      await authenticate("Bearer forged.or.malformed.token");
    });
    await assert.rejects(async () => {
      await authenticate(null);
    });
  });

  console.log(`\x1b[32m[SUCCESS] ${passed} fast unit and policy tests passed.\x1b[0m`);
}

runTests();

