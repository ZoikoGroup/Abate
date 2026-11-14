// backend/tools/sign-dossier.ts
// Explicit Named Human Sign-Off for Phase 8 Release Dossier.
// Binds signer identity, role, and timestamp to the cryptographic SHA-256 dossierHash.

import fs from "node:fs";
import path from "node:path";

function parseArg(flag: string): string | null {
  const prefix = `--${flag}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  if (!found) return null;
  return found.slice(prefix.length).trim() || null;
}

function main() {
  const signer = parseArg("signer");
  const role = parseArg("role") || "Accountable Release Authority";
  const notes = parseArg("notes") || "Verified test suites, operational drills, and constitutional gates.";

  if (!signer || signer.length < 3 || /^(auto|ci|bot|system)$/i.test(signer)) {
    console.error('ERROR: Explicit named human signer is required (e.g. --signer="Vishwajeet Singh" --role="Release Lead").');
    process.exit(1);
  }

  const evidencePath = path.resolve(__dirname, "../../evidence/release-dossier.json");
  const frontendPath = path.resolve(__dirname, "../../frontend/public/release-dossier.json");
  const signoffPath = path.resolve(__dirname, "../../evidence/dossier-signoff.json");

  if (!fs.existsSync(evidencePath)) {
    console.error("ERROR: Release dossier not found. Run `npm --prefix backend run build-dossier` first.");
    process.exit(1);
  }

  const dossier = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  if (dossier.decision?.outcome === "BLOCKED_FAILING_GATES") {
    console.error("ERROR: Cannot sign off a dossier with failing verification gates.");
    process.exit(1);
  }

  const dossierHash = dossier.signOff?.dossierHash;
  if (!dossierHash) {
    console.error("ERROR: Dossier missing cryptographic dossierHash. Rebuild dossier first.");
    process.exit(1);
  }

  const signOffRecord = {
    schema: "abate.dossier-signoff.v1",
    status: "RATIFIED",
    signedBy: signer,
    role,
    signedAt: new Date().toISOString(),
    dossierHash,
    notes
  };

  fs.writeFileSync(signoffPath, JSON.stringify(signOffRecord, null, 2));

  dossier.status = "RATIFIED";
  dossier.decision = {
    ...dossier.decision,
    outcome: "APPROVED",
    rationale: `Signed by ${signer} (${role}) against dossierHash ${dossierHash.slice(0, 12)}...`
  };
  dossier.signOff = signOffRecord;

  fs.writeFileSync(evidencePath, JSON.stringify(dossier, null, 2));
  if (fs.existsSync(path.dirname(frontendPath))) {
    fs.writeFileSync(frontendPath, JSON.stringify(dossier, null, 2));
  }

  console.log(`✔ Release Dossier RATIFIED by ${signer} (${role})`);
  console.log(`  Dossier Hash: ${dossierHash}`);
  console.log(`  Sign-off artifact: ${signoffPath}`);
}

main();

