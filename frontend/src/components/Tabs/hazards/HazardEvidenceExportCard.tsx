// frontend/src/components/Tabs/hazards/HazardEvidenceExportCard.tsx
import type { EvidencePackage } from "../../../api/client";

interface HazardEvidenceExportCardProps {
  loading: boolean;
  selectedHazardId: string | null;
  evidencePackage: EvidencePackage | null;
  onExportEvidence: () => void;
  onDownloadPackageJson: () => void;
}

export function HazardEvidenceExportCard({
  loading,
  selectedHazardId,
  evidencePackage,
  onExportEvidence,
  onDownloadPackageJson
}: HazardEvidenceExportCardProps) {
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3>Cryptographic Evidence Package</h3>
          <p className="card-desc">Verifiable SHA-256 package allowing external audit of the entire risk slice.</p>
        </div>
      </div>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button
          type="button"
          onClick={onExportEvidence}
          disabled={loading || !selectedHazardId}
          className="btn btn-primary"
        >
          📦 Export Evidence Package
        </button>
        {evidencePackage && (
          <button
            type="button"
            onClick={onDownloadPackageJson}
            className="btn btn-secondary"
          >
            Download JSON
          </button>
        )}
      </div>

      {evidencePackage && (
        <div style={{ background: "var(--aubergine)", color: "#FFFFFF", padding: "1rem", borderRadius: "8px", fontSize: "0.8rem" }}>
          <div style={{ marginBottom: "0.5rem", fontWeight: 700, color: "var(--coral)" }}>
            MANIFEST SHA-256: {evidencePackage.manifest.manifestHash}
          </div>
          <div style={{ marginBottom: "0.5rem", color: "#D1D5DB" }}>
            Package ID: {evidencePackage.manifest.packageId} | Items: {evidencePackage.artifacts.length}
          </div>
          <div style={{ maxHeight: "150px", overflowY: "auto", borderTop: "1px solid rgba(255,255,255,0.2)", paddingTop: "0.5rem" }}>
            {evidencePackage.artifacts.map((a, i) => (
              <div key={i} style={{ marginBottom: "0.25rem", display: "flex", justifyContent: "space-between" }}>
                <span>[{a.type}] {a.id.slice(0, 8)}...</span>
                <span className="monospace" style={{ color: "var(--sage)" }}>{a.sha256.slice(0, 16)}...</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
