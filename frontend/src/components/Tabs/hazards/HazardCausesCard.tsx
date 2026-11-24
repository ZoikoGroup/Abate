// frontend/src/components/Tabs/hazards/HazardCausesCard.tsx
import type { FormEvent } from "react";
import type { Cause } from "../../../api/client";

export interface HazardCausesCardProps {
  causes: Cause[];
  selectedHazardId: string | null;
  loading: boolean;
  newControlScope: string;
  newControlObjective: string;
  newControlDueDate: string;
  newCauseStatement: string;
  onChangeControlScope: (value: string) => void;
  onChangeControlObjective: (value: string) => void;
  onChangeControlDueDate: (value: string) => void;
  onChangeCauseStatement: (value: string) => void;
  onReviewCause: (causeId: string, status: "REVIEWED_ACCEPTED" | "REVIEWED_REJECTED") => void;
  onDraftControl: (causeId: string) => void;
  onProposeCause: (e: FormEvent) => void;
}

export function HazardCausesCard({
  causes,
  selectedHazardId,
  loading,
  newControlScope,
  newControlObjective,
  newControlDueDate,
  newCauseStatement,
  onChangeControlScope,
  onChangeControlObjective,
  onChangeControlDueDate,
  onChangeCauseStatement,
  onReviewCause,
  onDraftControl,
  onProposeCause
}: HazardCausesCardProps) {
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3>Organizational Causes</h3>
          <p className="card-desc">Work-design factors (routing, pacing, staffing). No individual worker blame.</p>
        </div>
        <span className="badge badge-aubergine">{causes.length} CAUSES</span>
      </div>

      {/* Cause List */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginBottom: "1rem" }}>
        {causes.map(c => (
          <div
            key={c.id}
            style={{
              padding: "0.75rem",
              borderRadius: "6px",
              border: "1px solid var(--card-border)",
              background: c.status === "REVIEWED_ACCEPTED" ? "var(--success-bg)" : "#FFFFFF"
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.25rem" }}>
              <div style={{ fontSize: "0.88rem", fontWeight: 600 }}>{c.statement}</div>
              <span className={`badge ${c.status === "REVIEWED_ACCEPTED" ? "badge-success" : c.status === "REVIEWED_REJECTED" ? "badge-secondary" : "badge-coral"}`}>
                {c.status}
              </span>
            </div>
            <div style={{ fontSize: "0.75rem", color: "var(--muted-text)", marginBottom: "0.5rem" }}>
              Cause ID: <span className="monospace">{c.id.slice(0, 8)}</span> | Version: {c.version}
            </div>
            {c.status === "PROPOSED" && (
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  type="button"
                  onClick={() => onReviewCause(c.id, "REVIEWED_ACCEPTED")}
                  className="btn btn-sm btn-success"
                >
                  ✔ Accept Cause
                </button>
                <button
                  type="button"
                  onClick={() => onReviewCause(c.id, "REVIEWED_REJECTED")}
                  className="btn btn-sm btn-secondary"
                >
                  ✖ Reject
                </button>
              </div>
            )}
            {c.status === "REVIEWED_ACCEPTED" && (
              <div style={{ marginTop: "0.5rem", borderTop: "1px dashed var(--card-border)", paddingTop: "0.5rem" }}>
                <div style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--graphite)", marginBottom: "0.25rem" }}>
                  Configure Intervention Parameters:
                </div>
                <input
                  aria-label="Intervention scope"
                  type="text"
                  value={newControlScope}
                  onChange={e => onChangeControlScope(e.target.value)}
                  placeholder="Scope"
                  className="text-control"
                  style={{ width: "100%", fontSize: "0.8rem", marginBottom: "0.25rem" }}
                />
                <input
                  aria-label="Intervention objective"
                  type="text"
                  value={newControlObjective}
                  onChange={e => onChangeControlObjective(e.target.value)}
                  placeholder="Objective"
                  className="text-control"
                  style={{ width: "100%", fontSize: "0.8rem", marginBottom: "0.25rem" }}
                />
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.5rem" }}>
                  <span style={{ fontSize: "0.75rem", color: "var(--muted-text)" }}>Due:</span>
                  <input
                    aria-label="Intervention review due date"
                    type="date"
                    value={newControlDueDate}
                    onChange={e => onChangeControlDueDate(e.target.value)}
                    className="text-control monospace"
                    style={{ fontSize: "0.8rem" }}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => onDraftControl(c.id)}
                  className="btn btn-sm btn-primary"
                  style={{ width: "100%" }}
                >
                  + Commit Control Draft on Accepted Cause
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Propose Cause Form */}
      <form onSubmit={onProposeCause} style={{ borderTop: "1px solid var(--card-border)", paddingTop: "1rem" }}>
        <div style={{ fontSize: "0.85rem", fontWeight: 700, marginBottom: "0.5rem" }}>Propose Work-Design Cause</div>
        <input
          aria-label="Operational root cause statement"
          type="text"
          value={newCauseStatement}
          onChange={e => onChangeCauseStatement(e.target.value)}
          placeholder="Operational root cause statement"
          className="text-control"
          style={{ width: "100%", marginBottom: "0.5rem" }}
          required
        />
        <button type="submit" disabled={loading || !selectedHazardId} className="btn btn-secondary" style={{ width: "100%" }}>
          Propose Cause
        </button>
      </form>
    </div>
  );
}
