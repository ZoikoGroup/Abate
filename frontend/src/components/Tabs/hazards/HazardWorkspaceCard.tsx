// frontend/src/components/Tabs/hazards/HazardWorkspaceCard.tsx
import type { FormEvent } from "react";
import { AiPanel } from "../../AiPanel";
import { BASELINE_RELEASE_ID, type Hazard, type HazardDetail } from "../../../api/client";

export interface HazardWorkspaceCardProps {
  hazards: Hazard[];
  selectedHazardId: string | null;
  hazardDetail: HazardDetail | null;
  token: string | null;
  loading: boolean;
  newHazardTitle: string;
  newOriginatingReleaseId: string;
  onSelectHazard: (hazardId: string) => void;
  onChangeTitle: (value: string) => void;
  onChangeReleaseId: (value: string) => void;
  onCreateHazard: (e: FormEvent) => void;
  onDraftAccepted: () => void;
}

export function HazardWorkspaceCard({
  hazards,
  selectedHazardId,
  hazardDetail,
  token,
  loading,
  newHazardTitle,
  newOriginatingReleaseId,
  onSelectHazard,
  onChangeTitle,
  onChangeReleaseId,
  onCreateHazard,
  onDraftAccepted
}: HazardWorkspaceCardProps) {
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3>Hazard Workspace</h3>
          <p className="card-desc">Authoritative hazards rooted in privacy-released cohort evidence.</p>
        </div>
        <span className="badge badge-coral">{hazards.length} HAZARDS</span>
      </div>

      {/* Selector */}
      <div className="form-group" style={{ marginBottom: "1rem" }}>
        <label htmlFor="active-hazard-select" className="form-label">Active Hazard</label>
        <select
          id="active-hazard-select"
          value={selectedHazardId || ""}
          onChange={e => onSelectHazard(e.target.value)}
          className="select-control"
          style={{ width: "100%", background: "#FFFFFF" }}
        >
          {hazards.map(h => (
            <option key={h.id} value={h.id}>
              {h.title} [{h.disposition}] (v{h.version})
            </option>
          ))}
        </select>
      </div>

      {/* Selected Hazard Summary */}
      {hazardDetail && (
        <div style={{ background: "var(--ivory)", padding: "1rem", borderRadius: "8px", border: "1px solid var(--card-border)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
            <span style={{ fontWeight: 700, fontSize: "0.95rem" }}>{hazardDetail.hazard.title}</span>
            <span className={`badge ${hazardDetail.hazard.disposition === "CONTROLLED" ? "badge-success" : "badge-coral"}`}>
              {hazardDetail.hazard.disposition}
            </span>
          </div>
          <div style={{ fontSize: "0.8rem", color: "var(--muted-text)", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <div>Originating Release: <code className="monospace">{hazardDetail.hazard.originating_release_id}</code></div>
            <div>Owner Principal: <code className="monospace">{hazardDetail.hazard.owner_principal_id}</code></div>
            <div>Causes: {hazardDetail.causes.length} | Controls: {hazardDetail.controls.length}</div>
          </div>
          {hazardDetail.hazard.originating_release_id && (
            <AiPanel
              releaseId={hazardDetail.hazard.originating_release_id}
              hazardId={hazardDetail.hazard.id}
              token={token}
              onDraftAccepted={onDraftAccepted}
            />
          )}
        </div>
      )}

      {/* Create New Hazard Form */}
      <form onSubmit={onCreateHazard} style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid var(--card-border)" }}>
        <div style={{ fontSize: "0.85rem", fontWeight: 700, marginBottom: "0.5rem" }}>Register New Hazard</div>
        <div className="form-group">
          <input
            aria-label="New hazard title"
            type="text"
            value={newHazardTitle}
            onChange={e => onChangeTitle(e.target.value)}
            placeholder="Hazard Title"
            className="text-control"
            style={{ width: "100%", marginBottom: "0.5rem" }}
            required
          />
          <input
            aria-label="Originating release ID"
            type="text"
            value={newOriginatingReleaseId}
            onChange={e => onChangeReleaseId(e.target.value)}
            placeholder="Originating Release ID"
            className="text-control monospace"
            style={{ width: "100%", marginBottom: "0.25rem" }}
            required
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
            <small style={{ color: "var(--muted)", fontSize: "0.75rem" }}>
              Must reference an approved cohort release ID.
            </small>
            <button
              type="button"
              onClick={() => onChangeReleaseId(BASELINE_RELEASE_ID)}
              style={{ background: "none", border: "none", color: "var(--coral)", cursor: "pointer", fontSize: "0.75rem", padding: 0, textDecoration: "underline" }}
            >
              Use Seeded Baseline
            </button>
          </div>
        </div>
        <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: "100%" }}>
          + Register Authoritative Hazard
        </button>
      </form>
    </div>
  );
}
