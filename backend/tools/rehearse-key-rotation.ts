// backend/tools/rehearse-key-rotation.ts
// Completion Plan Section 9 & T-23 / G-09:
// Rehearses zero-downtime key rotation across OIDC JWKS (RS256 kid rollover),
// ACTION_GRANT_SECRET, and CONNECTOR_WEBHOOK_SECRET, confirming zero secret leakage into telemetry.

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";
import { buildConfig, resetConfigCache } from "../src/platform/config";
import { verifyOidcJwt, resetOidcKeyCache } from "../src/platform/oidc";
import { mintGrant, verifyGrant, paramHashOf } from "../src/domains/actions";
import { signConnectorWebhook, verifyConnectorWebhookRequest, clearWebhookReplayCache } from "../src/domains/ingest/webhook-auth";
import { telemetry } from "../src/platform/telemetry";
import { GOLDEN_01 } from "../src/fixtures/golden01";

async function main() {
  console.log("\x1b[36m=== Abate Key Rotation Rehearsal (T-23 / G-09) ===\x1b[0m\n");
  const checks: Array<{ name: string; status: "PASS" }> = [];

  // 1. OIDC RS256 JWKS Zero-Downtime Rollover (kid-v1 -> dual JWKS [kid-v1, kid-v2] -> kid-v2 only)
  const kp1 = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kp2 = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk1 = { ...(kp1.publicKey.export({ format: "jwk" }) as Record<string, any>), kid: "abate-key-v1", use: "sig", alg: "RS256" };
  const jwk2 = { ...(kp2.publicKey.export({ format: "jwk" }) as Record<string, any>), kid: "abate-key-v2", use: "sig", alg: "RS256" };

  const issuer = "https://idp.example.abate.test";
  const audience = "abate-api";
  const signOidc = (privateKey: crypto.KeyObject, kid: string) =>
    jwt.sign(
      { sub: "auth0|rotation-user", tenant_id: GOLDEN_01.tenantA.id, role: "RISK_OWNER" },
      privateKey,
      { algorithm: "RS256", keyid: kid, issuer, audience, expiresIn: "5m" }
    );

  const tokV1 = signOidc(kp1.privateKey, "abate-key-v1");
  const tokV2 = signOidc(kp2.privateKey, "abate-key-v2");

  // Stage A: Dual-key JWKS accepts both v1 and v2 seamlessly
  resetOidcKeyCache();
  const dualCfg = buildConfig({
    APP_ENV: "production",
    NODE_ENV: "production",
    AUTH_ISSUER: issuer,
    AUTH_AUDIENCE: audience,
    OIDC_JWKS_JSON: JSON.stringify({ keys: [jwk1, jwk2] })
  });
  const claims1 = await verifyOidcJwt(tokV1, { cfg: dualCfg });
  const claims2 = await verifyOidcJwt(tokV2, { cfg: dualCfg });
  assert.strictEqual(claims1.sub, "auth0|rotation-user");
  assert.strictEqual(claims2.sub, "auth0|rotation-user");

  // Stage B: Retire v1 from JWKS -> v1 rejected, v2 still passes
  resetOidcKeyCache();
  const rotatedCfg = buildConfig({
    APP_ENV: "production",
    NODE_ENV: "production",
    AUTH_ISSUER: issuer,
    AUTH_AUDIENCE: audience,
    OIDC_JWKS_JSON: JSON.stringify({ keys: [jwk2] })
  });
  await assert.rejects(() => verifyOidcJwt(tokV1, { cfg: rotatedCfg }), /No matching signing key/i);
  const claims2After = await verifyOidcJwt(tokV2, { cfg: rotatedCfg });
  assert.strictEqual(claims2After.sub, "auth0|rotation-user");
  checks.push({ name: "OIDC RS256 JWKS zero-downtime rollover (v1 -> dual -> v2)", status: "PASS" });
  console.log("  ✔ OIDC RS256 JWKS zero-downtime rollover (v1 -> dual -> v2)");

  // 2. ACTION_GRANT_SECRET Rotation
  const prevGrantSecret = process.env.ACTION_GRANT_SECRET;
  const secretOld = "rotation_canary_grant_secret_v1_minimum_32_characters";
  const secretNew = "rotation_canary_grant_secret_v2_minimum_32_characters";
  try {
    process.env.ACTION_GRANT_SECRET = secretOld;
    resetConfigCache();
    const params = { channel: "ops-alerts", message: "Rotation drill" };
    const attemptId = crypto.randomUUID();
    const grantClaims = {
      tenantId: GOLDEN_01.tenantA.id,
      tool: "ticket_notification",
      target: "ops-alerts",
      paramHash: paramHashOf(params),
      approvalRef: GOLDEN_01.approvedControl.approvalId,
      attemptId,
      actor: "00000000-0000-4000-a002-000000000001",
      resourceVersion: 1
    };
    const oldGrantToken = mintGrant(grantClaims);
    const verifiedOld = verifyGrant(oldGrantToken, {
      tool: grantClaims.tool,
      target: grantClaims.target,
      params,
      tenantId: grantClaims.tenantId,
      attemptId: grantClaims.attemptId,
      approvalRef: grantClaims.approvalRef,
      resourceVersion: grantClaims.resourceVersion
    });
    assert.strictEqual(verifiedOld.tool, "ticket_notification");

    // Rotate secret -> old grant fails verification, new grant passes
    process.env.ACTION_GRANT_SECRET = secretNew;
    resetConfigCache();
    assert.throws(
      () => verifyGrant(oldGrantToken, { tool: grantClaims.tool, target: grantClaims.target, params }),
      /invalid|signature|expired|forged/i
    );

    const newGrantToken = mintGrant(grantClaims);
    assert.strictEqual(
      verifyGrant(newGrantToken, { tool: grantClaims.tool, target: grantClaims.target, params }).tool,
      "ticket_notification"
    );
  } finally {
    if (prevGrantSecret === undefined) delete process.env.ACTION_GRANT_SECRET;
    else process.env.ACTION_GRANT_SECRET = prevGrantSecret;
    resetConfigCache();
  }
  checks.push({ name: "ACTION_GRANT_SECRET rotation invalidates prior signing key", status: "PASS" });
  console.log("  ✔ ACTION_GRANT_SECRET rotation invalidates prior signing key");

  // 3. CONNECTOR_WEBHOOK_SECRET Rotation
  clearWebhookReplayCache();
  const whOld = "rotation_canary_webhook_secret_v1_minimum_32_characters";
  const whNew = "rotation_canary_webhook_secret_v2_minimum_32_characters";
  const nowSec = Math.floor(Date.now() / 1000);
  const body = { batchId: "rot-batch-1", items: [] };
  const sigOld = signConnectorWebhook({ secret: whOld, timestampSec: nowSec, nonce: "rot-n1", body });
  verifyConnectorWebhookRequest({ secret: whOld, signatureHeader: sigOld, body });

  const sigOldRetry = signConnectorWebhook({ secret: whOld, timestampSec: nowSec, nonce: "rot-n2", body });
  assert.throws(() => verifyConnectorWebhookRequest({ secret: whNew, signatureHeader: sigOldRetry, body }), /signature/i);

  const sigNew = signConnectorWebhook({ secret: whNew, timestampSec: nowSec, nonce: "rot-n3", body });
  verifyConnectorWebhookRequest({ secret: whNew, signatureHeader: sigNew, body });
  clearWebhookReplayCache();
  checks.push({ name: "CONNECTOR_WEBHOOK_SECRET rotation rejects old HMAC and accepts new HMAC", status: "PASS" });
  console.log("  ✔ CONNECTOR_WEBHOOK_SECRET rotation rejects old HMAC and accepts new HMAC");

  // 4. Verify zero secret canary values appear in telemetry or error logs
  const telemetryDump = JSON.stringify({ records: telemetry.snapshot(), errors: telemetry.errorLog });
  for (const canary of [secretOld, secretNew, whOld, whNew]) {
    assert.ok(!telemetryDump.includes(canary), "Secret canary leaked into telemetry or error logs!");
  }
  checks.push({ name: "Zero secret material leaked into telemetry or error logs", status: "PASS" });
  console.log("  ✔ Zero secret material leaked into telemetry or error logs");

  const report = {
    schema: "abate.key-rotation-rehearsal.v1",
    generatedAt: new Date().toISOString(),
    checksPassed: checks.length,
    totalChecks: checks.length,
    checks,
    secretLeaksDetected: 0,
    passed: true
  };
  const outPath = path.resolve(__dirname, "../../evidence/key-rotation-rehearsal-report.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`\n\x1b[32m✔ Key Rotation Rehearsal PASSED (${checks.length}/${checks.length}) -> ${outPath}\x1b[0m\n`);
}

main().catch((err) => {
  console.error("\x1b[31m[KEY ROTATION REHEARSAL FAILED]\x1b[0m", err);
  process.exit(1);
});
