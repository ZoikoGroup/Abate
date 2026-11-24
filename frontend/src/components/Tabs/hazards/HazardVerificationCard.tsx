// frontend/src/components/Tabs/hazards/HazardVerificationCard.tsx
import type { ControlDetailView } from "../../../api/client";

export type VerificationOutcome = "EFFECTIVE" | "PARTIALLY_EFFECTIVE" | "NOT_EFFECTIVE" | "INCONCLUSIVE";

export interface HazardVerificationCardProps {
  selectedControl: ControlDetailView | null;
  loading: boolean;
  concludeOutcome: VerificationOutcome;
  concludeResidualRisk: string;
  onChangeOutcome: (value: VerificationOutcome) => void;
  onChangeResidualRisk: (value: string) => void;
  onConcludeVerification: () => void;
}

export function HazardVerificationCard({
  selectedControl,
  loading,
  concludeOutcome,
  concludeResidualRisk,
  onChangeOutcome,
  onChangeResidualRisk,
  onConcludeVerification
}: HazardVerificationCardProps) {
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3>Verification &amp; Transfer of Risk</h3>
          <p className="card-desc">Guards against risk transfer to adjacent cohorts and requires named human review.</p>
        </div>
        {selectedControl?.evaluation && (
          <span className="badge badge-aubergine">
            {selectedControl.evaluation.outcome || "PENDING EVALUATION"}
          </span>
        )}
      </div>

      {selectedControl?.state === "VERIFYING" || selectedControl?.evaluation ? (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>
            <div style={{ background: "var(--ivory)", padding: "0.75rem", borderRadius: "6px" }}>
              <div style={{ fontSize: "0.75rem", color: "var(--muted-text)" }}>TARGET CRITERIA (PINNED PLAN)</div>
              <div style={{ fontSize: "1.25rem", fontWeight: 700 }}>
                -{selectedControl.verificationPlan?.criteria ?? 10}%
              </div>
              <div style={{ fontSize: "0.75rem" }}>
                {selectedControl.verificationPlan?.direction || "DECREASE"} BOUNDARY_INTRUSION_SHARE
              </div>
            </div>
            <div style={{ background: "var(--success-bg)", padding: "0.75rem", borderRadius: "6px" }}>
              <div style={{ fontSize: "0.75rem", color: "var(--muted-text)" }}>EVALUATION OUTCOME</div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--success)" }}>
                {selectedControl.evaluation?.outcome || "AWAITING CONCLUSION"}
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--success)" }}>
                Pre-analysis plan locked
              </div>
            </div>
          </div>

          {/* Transfer of Risk Indicator */}
          <div style={{ background: "#F0FDF4", border: "1px solid #BBF7D0", padding: "0.75rem", borderRadius: "6px", marginBottom: "1rem" }}>
            <div style={{ fontWeight: 700, fontSize: "0.85rem", color: "#166534" }}>
              Adjacent Cohort Guard (Tolerance &le; {selectedControl.verificationPlan?.adjacentTolerance ?? 5}%)
            </div>
            <div style={{ fontSize: "0.8rem", color: "#15803D" }}>
              {selectedControl.evaluation?.residualRisk
                ? selectedControl.evaluation.residualRisk
                : "Pending human reviewer evaluation conclusion."}
            </div>
          </div>

          {/* Human Reviewer Conclusion Form */}
          {selectedControl.state === "VERIFYING" && (
            <div style={{ borderTop: "1px solid var(--card-border)", paddingTop: "1rem" }}>
              <div style={{ fontSize: "0.85rem", fontWeight: 700, marginBottom: "0.5rem" }}>
                Conclude Verification (Named Human Reviewer)
              </div>
              <div className="form-group" style={{ marginBottom: "0.5rem" }}>
                <label htmlFor="hazard-conclude-outcome" className="form-label">Reviewer Outcome</label>
                <select
                  id="hazard-conclude-outcome"
                  value={concludeOutcome}
                  onChange={e => onChangeOutcome(e.target.value as VerificationOutcome)}
                  className="select-control"
                  style={{ width: "100%", background: "#FFFFFF" }}
                >
                  <option value="EFFECTIVE">EFFECTIVE (Target met, no transfer of risk)</option>
                  <option value="PARTIALLY_EFFECTIVE">PARTIALLY_EFFECTIVE (Partial reduction or transferred risk)</option>
                  <option value="NOT_EFFECTIVE">NOT_EFFECTIVE (Did not meet target)</option>
                  <option value="INCONCLUSIVE">INCONCLUSIVE (Series break or insufficient window)</option>
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: "0.5rem" }}>
                <label htmlFor="hazard-conclude-residual" className="form-label">Residual Risk Statement</label>
                <input
                  id="hazard-conclude-residual"
                  type="text"
                  value={concludeResidualRisk}
                  onChange={e => onChangeResidualRisk(e.target.value)}
                  className="text-control"
                  style={{ width: "100%" }}
                />
              </div>
              <button
                type="button"
                onClick={onConcludeVerification}
                disabled={loading}
                className="btn btn-primary"
                style={{ width: "100%" }}
              >
                Commit Reviewer Conclusion (Closes Intervention)
              </button>
            </div>
          )}
        </div>
      ) : (
        <div style={{ color: "var(--muted-text)", fontStyle: "italic", fontSize: "0.85rem" }}>
          Intervention must reach IMPLEMENTED state before pinning verification plan.
        </div>
      )}
    </div>
  );
}
