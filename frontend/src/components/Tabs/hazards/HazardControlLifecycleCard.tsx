// frontend/src/components/Tabs/hazards/HazardControlLifecycleCard.tsx
import type { ControlDetailView } from "../../../api/client";

export interface HazardControlLifecycleCardProps {
  selectedControl: ControlDetailView | null;
  loading: boolean;
  newImplementationKind: string;
  newEvidenceRef: string;
  editScope: string;
  editObjective: string;
  onChangeImplementationKind: (value: string) => void;
  onChangeEvidenceRef: (value: string) => void;
  onChangeEditScope: (value: string) => void;
  onChangeEditObjective: (value: string) => void;
  onApproveControl: () => void;
  onRecordImplementation: () => void;
  onPinVerification: () => void;
  onMaterialEdit: () => void;
}

export function HazardControlLifecycleCard({
  selectedControl,
  loading,
  newImplementationKind,
  newEvidenceRef,
  editScope,
  editObjective,
  onChangeImplementationKind,
  onChangeEvidenceRef,
  onChangeEditScope,
  onChangeEditObjective,
  onApproveControl,
  onRecordImplementation,
  onPinVerification,
  onMaterialEdit
}: HazardControlLifecycleCardProps) {
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3>Control Intervention &amp; Version-Bound Approval</h3>
          <p className="card-desc">Enforces version-bound approval: v4 approval cannot approve v5.</p>
        </div>
        {selectedControl && (
          <span className={`badge ${selectedControl.state === "APPROVED" || selectedControl.state === "IMPLEMENTED" || selectedControl.state === "CLOSED" ? "badge-success" : "badge-coral"}`}>
            {selectedControl.state}
          </span>
        )}
      </div>

      {selectedControl ? (
        <div>
          {/* Control Metadata */}
          <div style={{ background: "var(--ivory)", padding: "1rem", borderRadius: "8px", marginBottom: "1rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.25rem" }}>
              <span style={{ fontWeight: 700 }}>Version {selectedControl.version}</span>
              <span className="monospace" style={{ fontSize: "0.8rem", color: "var(--muted-text)" }}>
                Hash: {(selectedControl.materialHash || "").slice(0, 16)}...
              </span>
            </div>
            <div style={{ fontSize: "0.85rem", marginBottom: "0.5rem" }}>
              <strong>Scope:</strong> {selectedControl.scope}
            </div>
            <div style={{ fontSize: "0.85rem", marginBottom: "0.5rem" }}>
              <strong>Objective:</strong> {selectedControl.objective}
            </div>
            <div style={{ fontSize: "0.8rem", color: "var(--muted-text)" }}>
              Due Date: {selectedControl.dueDate} | ETag: <code className="monospace">{selectedControl.etag}</code>
            </div>
          </div>

          {/* Material Changes Diff */}
          {selectedControl.materialChanges && selectedControl.materialChanges.length > 0 && (
            <div style={{ background: "var(--warning-bg)", padding: "0.75rem", borderRadius: "6px", marginBottom: "1rem", border: "1px solid #FCD34D" }}>
              <div style={{ fontWeight: 700, fontSize: "0.85rem", color: "var(--warning)", marginBottom: "0.25rem" }}>
                ⚠ Material Changes Detected Since Prior Approval
              </div>
              {selectedControl.materialChanges.map((c, i) => (
                <div key={i} style={{ fontSize: "0.8rem" }}>
                  <strong>{c.field}:</strong> {c.from} &rarr; <span style={{ color: "var(--danger)" }}>{c.to}</span>
                </div>
              ))}
            </div>
          )}

          {/* Action Bar for Control */}
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
            {(selectedControl.state === "PROPOSED" || selectedControl.state === "APPROVAL_REQUIRED") && (
              <button
                type="button"
                onClick={onApproveControl}
                disabled={loading}
                className="btn btn-success"
              >
                ✔ Approve Control (If-Match: v{selectedControl.version})
              </button>
            )}

            {selectedControl.state === "APPROVED" && (
              <div style={{ background: "var(--ivory)", padding: "0.75rem", borderRadius: "6px", width: "100%", marginBottom: "0.5rem" }}>
                <div style={{ fontSize: "0.8rem", fontWeight: 700, marginBottom: "0.5rem" }}>Record Attributable Implementation Evidence</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <div>
                    <label htmlFor="hazard-impl-kind" className="form-label" style={{ fontSize: "0.75rem" }}>Implementation Kind</label>
                    <select
                      id="hazard-impl-kind"
                      value={newImplementationKind}
                      onChange={e => onChangeImplementationKind(e.target.value)}
                      className="select-control"
                      style={{ width: "100%", background: "#FFFFFF", fontSize: "0.8rem" }}
                    >
                      <option value="MANUAL">MANUAL (Organizational Policy / Workflow)</option>
                      <option value="INTEGRATED">INTEGRATED (Tool / System Configuration)</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="hazard-evidence-ref" className="form-label" style={{ fontSize: "0.75rem" }}>Evidence Reference</label>
                    <input
                      id="hazard-evidence-ref"
                      type="text"
                      value={newEvidenceRef}
                      onChange={e => onChangeEvidenceRef(e.target.value)}
                      className="text-control monospace"
                      style={{ width: "100%", fontSize: "0.8rem" }}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onRecordImplementation}
                  disabled={loading}
                  className="btn btn-primary"
                  style={{ width: "100%" }}
                >
                  ✔ Commit Implementation Receipt
                </button>
              </div>
            )}

            {selectedControl.state === "IMPLEMENTED" && (
              <button
                type="button"
                onClick={onPinVerification}
                disabled={loading}
                className="btn btn-aubergine"
              >
                📌 Pin Verification Plan
              </button>
            )}
          </div>

          {/* Material Edit Box (To demonstrate v4 cannot approve v5) */}
          <div style={{ borderTop: "1px solid var(--card-border)", paddingTop: "1rem" }}>
            <div style={{ fontSize: "0.85rem", fontWeight: 700, marginBottom: "0.5rem" }}>
              Material Modification (Tests Automatic Approval Invalidation)
            </div>
            <input
              aria-label="Updated intervention scope"
              type="text"
              value={editScope}
              onChange={e => onChangeEditScope(e.target.value)}
              placeholder="Updated Scope"
              className="text-control"
              style={{ width: "100%", marginBottom: "0.5rem" }}
            />
            <input
              aria-label="Updated intervention objective"
              type="text"
              value={editObjective}
              onChange={e => onChangeEditObjective(e.target.value)}
              placeholder="Updated Objective"
              className="text-control"
              style={{ width: "100%", marginBottom: "0.5rem" }}
            />
            <button
              type="button"
              onClick={onMaterialEdit}
              disabled={loading}
              className="btn btn-sm btn-secondary"
            >
              Apply Material Edit (Bumps version &amp; resets approval)
            </button>
          </div>
        </div>
      ) : (
        <div style={{ color: "var(--muted-text)", fontStyle: "italic", fontSize: "0.85rem" }}>
          No control intervention drafted yet. Propose and accept an organizational cause on the left to anchor a control.
        </div>
      )}
    </div>
  );
}
