// frontend/src/components/Tabs/AuditVerifierTab.tsx
// Browser Offline Evidence Bundle Verifier & Merkle Inclusion Viewer
// Explicitly reminds users: Hashes prove files are unchanged, NOT that claims are true.

import React, { useCallback, useEffect, useState } from "react";
import { api, PRESET_TENANTS } from "../../api/client";

interface AuditVerifierTabProps {
  currentTenant: typeof PRESET_TENANTS[0];
  token: string | null;
}

interface MerkleProofStep {
  sibling: string;
  position: "left" | "right";
}

interface MerkleTreeResult {
  root: string;
  levels: string[][];
}

interface VerificationReport {
  valid: boolean;
  manifestHashExpected: string | null;
  manifestHashActual: string | null;
  manifestMatch: boolean;
  merkleRootExpected: string;
  merkleRootActual: string | null;
  merkleMatch: boolean;
  levels: string[][];
  itemResults: Array<{
    type: string;
    id: string;
    version: number;
    expectedSha256: string;
    computedSha256: string | null;
    status: "VERIFIED" | "MISMATCH" | "NO_BYTES_INLINE";
    proof: MerkleProofStep[];
  }>;
  errors: string[];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

async function sha256HexBrowser(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await window.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function buildBrowserMerkleTree(itemSha256s: string[]): Promise<MerkleTreeResult> {
  if (itemSha256s.length === 0) {
    const emptyRoot = await sha256HexBrowser("abate.merkle.empty.v1");
    return { root: emptyRoot, levels: [[emptyRoot]] };
  }

  const leaves = await Promise.all(
    itemSha256s.map((sha) => sha256HexBrowser(`abate.merkle.leaf.v1:${sha}`))
  );
  const levels: string[][] = [leaves];

  let current = leaves;
  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = current[i + 1] ?? current[i];
      next.push(await sha256HexBrowser(`abate.merkle.node.v1:${left}:${right}`));
    }
    levels.push(next);
    current = next;
  }

  return { root: levels[levels.length - 1][0], levels };
}

function computeProofFromLevels(levels: string[][], leafIndex: number): MerkleProofStep[] {
  const proof: MerkleProofStep[] = [];
  let idx = leafIndex;
  for (let lvl = 0; lvl < levels.length - 1; lvl++) {
    const layer = levels[lvl];
    const isRightNode = idx % 2 === 1;
    const siblingIdx = isRightNode ? idx - 1 : idx + 1;
    const sibling = layer[siblingIdx] ?? layer[idx];
    proof.push({ sibling, position: isRightNode ? "left" : "right" });
    idx = Math.floor(idx / 2);
  }
  return proof;
}

async function verifyBundleInBrowser(rawText: string): Promise<VerificationReport> {
  const pkg = JSON.parse(rawText);
  const manifest = pkg?.manifest ? pkg.manifest : pkg;
  const errors: string[] = [];

  if (!manifest || !Array.isArray(manifest.items) || !manifest.manifestHash) {
    throw new Error("Bundle must contain a manifest with 'items' array and 'manifestHash'.");
  }

  const normalized = manifest.items.map((it: any) => ({
    type: String(it.type ?? it.itemType ?? "unknown"),
    id: String(it.id ?? it.itemId ?? "unknown"),
    version: Number(it.version ?? it.itemVersion ?? 1),
    sha256: String(it.sha256 ?? ""),
    objectKey: it.objectKey ? String(it.objectKey) : undefined
  }));

  const tree = await buildBrowserMerkleTree(normalized.map((it: any) => it.sha256));
  const itemResults: VerificationReport["itemResults"] = [];

  for (let i = 0; i < normalized.length; i++) {
    const item = normalized[i];
    const proof = computeProofFromLevels(tree.levels, i);
    let computedSha256: string | null = null;
    let status: "VERIFIED" | "MISMATCH" | "NO_BYTES_INLINE" = "NO_BYTES_INLINE";

    if (pkg.itemsFiles && item.objectKey && pkg.itemsFiles[item.objectKey]) {
      computedSha256 = await sha256HexBrowser(pkg.itemsFiles[item.objectKey]);
      status = computedSha256 === item.sha256 ? "VERIFIED" : "MISMATCH";
    } else if (pkg.artifacts && pkg.artifacts[`${item.type}:${item.id}`]) {
      computedSha256 = await sha256HexBrowser(canonicalJson(pkg.artifacts[`${item.type}:${item.id}`]));
      status = computedSha256 === item.sha256 ? "VERIFIED" : "MISMATCH";
    }

    if (status === "MISMATCH") {
      errors.push(`Artifact SHA-256 mismatch at ${item.type}:${item.id}`);
    }

    itemResults.push({
      type: item.type,
      id: item.id,
      version: item.version,
      expectedSha256: item.sha256,
      computedSha256,
      status,
      proof
    });
  }

  const merkleRootActual = manifest.merkleRoot ? String(manifest.merkleRoot) : null;
  const merkleMatch = merkleRootActual ? merkleRootActual === tree.root : true;
  if (merkleRootActual && !merkleMatch) {
    errors.push(`Merkle root mismatch: expected ${tree.root}, got ${merkleRootActual}`);
  }

  let manifestHashExpected: string | null = null;
  if (pkg.manifest) {
    const base: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(pkg.manifest)) {
      if (k !== "manifestHash" && k !== "merkleProofs") {
        base[k] = v;
      }
    }
    manifestHashExpected = await sha256HexBrowser(canonicalJson(base));
  } else {
    const base: Record<string, unknown> = {
      schema: manifest.schema || "abate.evidence.v1",
      cutoff: manifest.cutoff,
      issuer: manifest.issuerPrincipalId || manifest.issuer,
      classification: manifest.classification,
      items: normalized.map((it: any) => ({
        type: it.type,
        id: it.id,
        version: it.version,
        sha256: it.sha256
      }))
    };
    if (merkleRootActual) {
      base.merkleRoot = merkleRootActual;
    }
    manifestHashExpected = await sha256HexBrowser(canonicalJson(base));
  }

  const manifestHashActual = String(manifest.manifestHash);
  const manifestMatch = manifestHashExpected === manifestHashActual;
  if (!manifestMatch) {
    errors.push(`Manifest hash mismatch: expected ${manifestHashExpected}, got ${manifestHashActual}`);
  }

  return {
    valid: errors.length === 0,
    manifestHashExpected,
    manifestHashActual,
    manifestMatch,
    merkleRootExpected: tree.root,
    merkleRootActual,
    merkleMatch,
    levels: tree.levels,
    itemResults,
    errors
  };
}

async function createSampleBundleJson(tenantId: string): Promise<string> {
  const artHazard = {
    id: "00000000-0000-4000-a007-000000000001",
    title: "Out-of-hours filing overload (Sample Verification Artifact)",
    version: 1
  };
  const artCause = {
    id: "00000000-0000-4000-a007-000000000002",
    statement: "Unbuffered matter assignment cadence in litigation sprint",
    version: 1
  };
  const artControl = {
    id: "00000000-0000-4000-a007-000000000003",
    scope: "Corporate Litigation Practice",
    objective: "Enforce 48h triage handoff",
    version: 2
  };
  const shaH = await sha256HexBrowser(canonicalJson(artHazard));
  const shaC = await sha256HexBrowser(canonicalJson(artCause));
  const shaI = await sha256HexBrowser(canonicalJson(artControl));
  const tree = await buildBrowserMerkleTree([shaH, shaC, shaI]);
  const manifestBase = {
    packageId: "sample-pkg-be007-v1",
    hazardId: artHazard.id,
    tenantId,
    cutoff: "2026-11-14T00:00:00.000Z",
    issuer: "verifier-ui-sample",
    classification: "RESTRICTED",
    items: [
      { type: "hazard", id: artHazard.id, version: 1, sha256: shaH },
      { type: "cause", id: artCause.id, version: 1, sha256: shaC },
      { type: "intervention", id: artControl.id, version: 2, sha256: shaI }
    ],
    merkleRoot: tree.root
  };
  const manifestHash = await sha256HexBrowser(canonicalJson(manifestBase));
  const sample = {
    manifest: { ...manifestBase, manifestHash },
    artifacts: {
      [`hazard:${artHazard.id}`]: artHazard,
      [`cause:${artCause.id}`]: artCause,
      [`intervention:${artControl.id}`]: artControl
    }
  };
  return JSON.stringify(sample, null, 2);
}

export function AuditVerifierTab({ currentTenant, token }: AuditVerifierTabProps) {
  const [bundleJson, setBundleJson] = useState<string>("");
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [selectedLeafIdx, setSelectedLeafIdx] = useState<number>(0);
  const [packages, setPackages] = useState<any[]>([]);
  const [loadingLive, setLoadingLive] = useState<boolean>(false);

  const runVerification = useCallback(async (raw: string) => {
    setParseError(null);
    try {
      const res = await verifyBundleInBrowser(raw);
      setReport(res);
      setSelectedLeafIdx(0);
    } catch (err: any) {
      setReport(null);
      setParseError(err?.message || "Invalid evidence JSON");
    }
  }, []);

  const loadSampleBundle = useCallback(async () => {
    const formatted = await createSampleBundleJson(currentTenant.id);
    setBundleJson(formatted);
    await runVerification(formatted);
  }, [currentTenant.id, runVerification]);

  useEffect(() => {
    let cancelled = false;
    createSampleBundleJson(currentTenant.id)
      .then(async (formatted) => {
        const res = await verifyBundleInBrowser(formatted);
        if (cancelled) return;
        setBundleJson(formatted);
        setReport(res);
        setParseError(null);
        setSelectedLeafIdx(0);
      })
      .catch((err: any) => {
        if (!cancelled) setParseError(err?.message || "Failed to load sample bundle");
      });
    return () => {
      cancelled = true;
    };
  }, [currentTenant.id]);

  const handleLoadServerPackages = async () => {
    if (!token) return;
    setLoadingLive(true);
    try {
      const list = await api<any[]>("/api/v2/evidence-packages", { token });
      setPackages(Array.isArray(list) ? list : []);
    } catch (err: any) {
      setParseError(err?.message || "Failed to list evidence packages");
    } finally {
      setLoadingLive(false);
    }
  };

  const handleIssueLivePackage = async () => {
    if (!token) return;
    setLoadingLive(true);
    try {
      const pkg = await api<any>("/api/v2/evidence-packages", {
        method: "POST",
        token,
        body: JSON.stringify({})
      });
      const formatted = JSON.stringify(pkg, null, 2);
      setBundleJson(formatted);
      await runVerification(formatted);
      await handleLoadServerPackages();
    } catch (err: any) {
      setParseError(err?.message || "Failed to issue live evidence package");
    } finally {
      setLoadingLive(false);
    }
  };

  const handleSimulateTamper = async () => {
    if (!bundleJson) return;
    try {
      const parsed = JSON.parse(bundleJson);
      if (parsed.artifacts) {
        const firstKey = Object.keys(parsed.artifacts)[0];
        if (firstKey) {
          parsed.artifacts[firstKey] = {
            ...parsed.artifacts[firstKey],
            tamperedNote: "UNAUTHORIZED_POST_EXPORT_EDIT"
          };
        }
      } else if (parsed.items && parsed.items[0]) {
        parsed.items[0].sha256 = "f".repeat(64);
      }
      const nextRaw = JSON.stringify(parsed, null, 2);
      setBundleJson(nextRaw);
      await runVerification(nextRaw);
    } catch (err: any) {
      setParseError(err?.message || "Cannot tamper invalid JSON");
    }
  };

  const handleFileUpload = (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const txt = String(reader.result || "");
      setBundleJson(txt);
      await runVerification(txt);
    };
    reader.readAsText(file);
  };

  const selectedLeaf = report?.itemResults[selectedLeafIdx] || null;

  return (
    <div className="tab-pane">
      <div className="card">
        <div className="card-header">
          <div>
            <h3>Cryptographic Evidence Verifier &amp; Merkle Tree Explorer</h3>
            <p className="card-desc">
              Independently recomputes canonical SHA-256 artifact digests, Merkle inclusion proofs, and manifest hashes directly inside your browser via WebCrypto.
            </p>
          </div>
          <span className="badge badge-aubergine">ZERO-TRUST BROWSER VERIFIER</span>
        </div>

        <div className="callout-info" style={{ borderLeft: "4px solid #E26D5A" }}>
          <strong>Epistemic Boundary Notice:</strong>{" "}
          <span>
            Cryptographic hashes and Merkle proofs prove files are unchanged since export, NOT that the underlying claims are true.
          </span>
        </div>

        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", margin: "1rem 0" }}>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void runVerification(bundleJson)}>
            Re-Verify Bundle (WebCrypto SHA-256)
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadSampleBundle()}>
            Load Clean Sample Bundle
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void handleSimulateTamper()}>
            Simulate Artifact Tamper
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!token || loadingLive}
            onClick={() => void handleIssueLivePackage()}
          >
            {loadingLive ? "Issuing..." : "Issue & Verify Live Package"}
          </button>
          <label className="btn btn-secondary btn-sm" style={{ cursor: "pointer", display: "inline-flex", alignItems: "center" }}>
            Upload Evidence JSON
            <input type="file" accept=".json,application/json" style={{ display: "none" }} onChange={handleFileUpload} />
          </label>
        </div>

        {packages.length > 0 && (
          <p className="text-sm" style={{ opacity: 0.8, marginBottom: "0.75rem" }}>
            Tenant {currentTenant.name} stored packages: {packages.length}
          </p>
        )}

        {parseError && (
          <div className="feedback-alert alert-error" role="alert">
            <div className="feedback-title">Verification Error</div>
            <p>{parseError}</p>
          </div>
        )}

        {report && (
          <div
            className={`feedback-alert ${report.valid ? "alert-success" : "alert-error"}`}
            role="status"
            style={{ marginBottom: "1rem" }}
          >
            <div className="feedback-title">
              {report.valid
                ? "VERIFIED: Manifest Hash, Artifact SHA-256 Digests, and Merkle Root Match"
                : "TAMPER OR MISMATCH DETECTED"}
            </div>
            {!report.valid && (
              <ul style={{ margin: "0.5rem 0 0 1.2rem" }}>
                {report.errors.map((e, idx) => (
                  <li key={idx}>{e}</li>
                ))}
              </ul>
            )}
            <div className="text-sm monospace" style={{ marginTop: "0.5rem", wordBreak: "break-all" }}>
              <div>Manifest Hash Actual: {report.manifestHashActual}</div>
              <div>Manifest Hash Computed: {report.manifestHashExpected} ({report.manifestMatch ? "MATCH" : "MISMATCH"})</div>
              <div>Merkle Root Computed: {report.merkleRootExpected}</div>
              {report.merkleRootActual && (
                <div>Merkle Root Manifest: {report.merkleRootActual} ({report.merkleMatch ? "MATCH" : "MISMATCH"})</div>
              )}
            </div>
          </div>
        )}

        {report && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>
            <div>
              <h4>Evidence Items &amp; Leaves ({report.itemResults.length})</h4>
              <div className="table-responsive">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Artifact</th>
                      <th>SHA-256 (prefix)</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.itemResults.map((item, idx) => (
                      <tr
                        key={`${item.type}-${item.id}-${idx}`}
                        onClick={() => setSelectedLeafIdx(idx)}
                        style={{
                          cursor: "pointer",
                          background: selectedLeafIdx === idx ? "rgba(49, 46, 129, 0.08)" : undefined
                        }}
                      >
                        <td className="monospace text-sm">{idx}</td>
                        <td className="text-sm">
                          <strong>{item.type}</strong> v{item.version}
                          <div className="monospace" style={{ fontSize: "0.75rem", opacity: 0.75 }}>
                            {item.id.slice(0, 14)}...
                          </div>
                        </td>
                        <td className="monospace text-sm">{item.expectedSha256.slice(0, 12)}...</td>
                        <td>
                          <span
                            className={`status-pill ${item.status === "MISMATCH" ? "status-error" : "status-live"
                              }`}
                          >
                            {item.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <h4>Merkle Inclusion Proof Path (Leaf #{selectedLeafIdx})</h4>
              <div className="callout-info">
                {selectedLeaf ? (
                  <div className="monospace text-sm" style={{ wordBreak: "break-all" }}>
                    <div style={{ marginBottom: "0.5rem" }}>
                      <strong>Target Item SHA-256:</strong> {selectedLeaf.expectedSha256}
                    </div>
                    {selectedLeaf.proof.length === 0 ? (
                      <div>Single-leaf tree (leaf hash hashes directly to root).</div>
                    ) : (
                      selectedLeaf.proof.map((step, i) => (
                        <div key={i} style={{ marginBottom: "0.35rem" }}>
                          Step {i + 1}: combine with <strong>{step.position.toUpperCase()}</strong> sibling{" "}
                          <code>{step.sibling.slice(0, 24)}...</code>
                        </div>
                      ))
                    )}
                    <div style={{ marginTop: "0.5rem" }}>
                      <strong>Merkle Root:</strong> {report.merkleRootExpected}
                    </div>
                  </div>
                ) : (
                  <p>Select a leaf row to inspect its Merkle inclusion path.</p>
                )}
              </div>

              <h4 style={{ marginTop: "0.75rem" }}>Merkle Layers ({report.levels.length})</h4>
              <div className="monospace text-sm" style={{ background: "#f8fafc", padding: "0.5rem", borderRadius: "6px" }}>
                {report.levels.map((lvl, lIdx) => (
                  <div key={lIdx} style={{ marginBottom: "0.25rem" }}>
                    Level {lIdx}: {lvl.length} node(s) — [{lvl.map((h) => h.slice(0, 8)).join(", ")}]
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div>
          <h4>Raw Evidence Bundle JSON</h4>
          <textarea
            aria-label="Evidence Bundle JSON Input"
            value={bundleJson}
            onChange={(e) => setBundleJson(e.target.value)}
            rows={10}
            style={{
              width: "100%",
              fontFamily: "monospace",
              fontSize: "0.8rem",
              padding: "0.75rem",
              borderRadius: "6px",
              border: "1px solid #cbd5e1"
            }}
          />
        </div>
      </div>
    </div>
  );
}