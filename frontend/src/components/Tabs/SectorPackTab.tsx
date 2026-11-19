// frontend/src/components/Tabs/SectorPackTab.tsx
// Sector Pack tab: work items, demand windows, fatigue audit and the constitutional boundary lab
// for the tenant's active sector pack. All wording, units and decoy fields come from the pack
// through the sector profile, so this component holds no sector-specific text.

import { useState, useEffect, useCallback } from "react";
import {
  ApiError,
  fetchSectorWorkItems,
  checkSectorFatigue,
  mapSectorWorkItem,
  PRESET_TENANTS,
  type SectorWorkItemView,
  type SectorFatigueAssessmentView,
  type TenantSectorProfile
} from "../../api/client";
import { getSectorUi, getSectorVocabulary, labelFor } from "../../utils/vocabulary";
import { StateView } from "../StateView";

function fmtSectorErr(err: unknown): string {
  if (err instanceof ApiError) {
    return `${err.message} (Request ID: ${err.requestId})`;
  }
  return err instanceof Error ? err.message : "Request failed.";
}

interface SectorPackTabProps {
  currentTenant: typeof PRESET_TENANTS[0];
  token: string | null;
  sectorProfile: TenantSectorProfile;
}

export function SectorPackTab({ currentTenant, token, sectorProfile }: SectorPackTabProps) {
  const ui = getSectorUi(sectorProfile);
  const vocab = getSectorVocabulary(sectorProfile);
  const workItemsLower = vocab.workItems.toLowerCase();
  const highDemand = sectorProfile.highDemandWindows ?? [];
  const unitOptions = sectorProfile.workItemUnits ?? [];

  const [items, setItems] = useState<SectorWorkItemView[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Selected work item for inspection and fatigue analysis
  const [selected, setSelected] = useState<SectorWorkItemView | null>(null);
  const [fatigueAssessment, setFatigueAssessment] = useState<SectorFatigueAssessmentView | null>(null);
  const [analyzingFatigue, setAnalyzingFatigue] = useState(false);

  // Unit filter
  const [filterUnit, setFilterUnit] = useState<string>("ALL");

  // Accountable reviewer consultation gate (simulation, client-side only)
  const [consultationSigned, setConsultationSigned] = useState<boolean>(false);
  const [consultationSigner, setConsultationSigner] = useState<string>(ui.consultationSignerDefault);
  const [mitigationAction, setMitigationAction] = useState<string>(ui.consultationActions[0]?.value ?? "");

  // Neutral work-item mapping lab
  const [mappingResult, setMappingResult] = useState<any | null>(null);
  const [mappingLoading, setMappingLoading] = useState(false);

  // Boundary rejection lab: which decoy fields to inject
  const [injected, setInjected] = useState<Record<string, boolean>>({});
  const [boundaryRejectionResult, setBoundaryRejectionResult] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const loaded = await fetchSectorWorkItems(token);
      setItems(loaded);
      if (loaded.length > 0 && !selected) {
        setSelected(loaded[0]);
      }
    } catch (err: any) {
      setErrorMsg(`Failed to load ${workItemsLower}: ${fmtSectorErr(err)}`);
    } finally {
      setLoading(false);
    }
  }, [token, selected, workItemsLower]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void fetchSectorWorkItems(token)
      .then((loaded) => {
        if (cancelled) return;
        setItems(loaded);
        if (loaded.length > 0) {
          setSelected((prev) => prev || loaded[0]);
        }
      })
      .catch((err: any) => {
        if (!cancelled) {
          setErrorMsg(`Failed to load ${workItemsLower}: ${fmtSectorErr(err)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, workItemsLower]);

  // Run the pack's fatigue and demand-window analysis
  const handleAnalyzeFatigue = async (item: SectorWorkItemView) => {
    if (!token) return;
    setSelected(item);
    setAnalyzingFatigue(true);
    setErrorMsg(null);
    setFatigueAssessment(null);
    setConsultationSigned(false);

    try {
      const assessment = await checkSectorFatigue(item.externalRef, token);
      setFatigueAssessment(assessment);
    } catch (err: any) {
      setErrorMsg(`Fatigue analysis failed: ${fmtSectorErr(err)}`);
    } finally {
      setAnalyzingFatigue(false);
    }
  };

  // Sign the consultation gate (simulation preview, client-side state only)
  const handleSignConsultation = () => {
    setConsultationSigned(true);
    setErrorMsg(null);
    setSuccessMsg(
      `Simulation: Client-side ${ui.consultationSignerLabel} consultation preview signed by ${consultationSigner.trim()} (Action: ${mitigationAction}). Backend consultation persistence is not enabled in this preview.`
    );
  };

  // Test neutral work-item translation, optionally with forbidden decoy fields injected
  const handleMapItem = async () => {
    if (!selected || !token) return;
    setMappingLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    const activeDecoys = ui.decoyFields.filter(d => injected[d.field]);
    const expectsRefusal = activeDecoys.length > 0;
    try {
      const payload: any = { ...selected };
      for (const d of activeDecoys) payload[d.field] = d.value;

      const res = await mapSectorWorkItem(payload, token);
      setMappingResult(res);
      setBoundaryRejectionResult(null);
      if (expectsRefusal) {
        setErrorMsg("Constitutional warning: injected decoy fields were not rejected by the boundary validator.");
      } else {
        setSuccessMsg(`${vocab.workItem} successfully validated and mapped to domain-neutral WORK_ITEM representation.`);
      }
    } catch (err: unknown) {
      setMappingResult(null);
      if (expectsRefusal && err instanceof ApiError && (err.status === 400 || err.code === "VALIDATION")) {
        setBoundaryRejectionResult(`Expected HTTP ${err.status} ${err.code}: ${fmtSectorErr(err)}`);
      } else {
        setBoundaryRejectionResult(null);
        setErrorMsg(`Boundary mapping failed: ${fmtSectorErr(err)}`);
      }
    } finally {
      setMappingLoading(false);
    }
  };

  const filteredItems = filterUnit === "ALL" ? items : items.filter(i => i.unit === filterUnit);

  return (
    <div className="tab-pane active" id="sector-pack-tab">
      <div className="pane-header">
        <div>
          <h2 className="pane-title">{ui.heading}</h2>
          <p className="pane-subtitle">{ui.subtitle}</p>
        </div>
        <div className="pane-actions">
          {ui.badges.map((b, i) => (
            <span key={b} className={`badge ${["badge-primary", "badge-secondary", "badge-success"][i % 3]}`}>{b}</span>
          ))}
        </div>
      </div>

      {!token && <StateView state={{ kind: "unauthorized" }} />}
      {loading && items.length === 0 && <StateView state={{ kind: "loading" }} />}

      {errorMsg && (
        <div className="feedback-alert alert-error" role="alert">
          <div className="feedback-title">Error</div>
          <p>{errorMsg}</p>
        </div>
      )}

      {successMsg && (
        <div className="feedback-alert alert-success" role="status">
          <div className="feedback-title">Success</div>
          <p>{successMsg}</p>
        </div>
      )}

      <div className="constitutional-guard-banner">
        <strong>⚖️ {ui.boundaryTitle}:</strong>
        <p>{ui.boundaryText}</p>
      </div>

      <div className="tab-grid" style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: "1.5rem", marginTop: "1.5rem" }}>
        {/* Left column: work item explorer */}
        <div className="card">
          <div className="card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 className="card-title">{ui.listTitle}</h3>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              {unitOptions.length > 0 && (
                <select
                  className="select-control"
                  value={filterUnit}
                  onChange={(e) => setFilterUnit(e.target.value)}
                  aria-label={ui.unitFilterLabel}
                  style={{ fontSize: "0.85rem", padding: "0.25rem 0.5rem" }}
                >
                  <option value="ALL">{ui.allUnitsLabel}</option>
                  {unitOptions.map((u) => (
                    <option key={u} value={u}>{labelFor(u, ui.unitLabels)}</option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={loadItems}
                disabled={loading}
              >
                {loading ? "Refreshing..." : "↻ Refresh"}
              </button>
            </div>
          </div>

          <div className="card-body">
            {loading && items.length === 0 ? (
              <p>Loading active {workItemsLower} for {currentTenant.name}...</p>
            ) : filteredItems.length === 0 ? (
              <p>No {workItemsLower} found matching the current {vocab.unit.toLowerCase()} filter.</p>
            ) : (
              <div className="work-item-list" style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                {filteredItems.map((m) => {
                  const isSelected = selected?.externalRef === m.externalRef;
                  const isHighStakes = highDemand.includes(m.demandWindow);
                  return (
                    <div
                      key={m.externalRef}
                      className={`work-item-card ${isSelected ? "selected" : ""}`}
                      style={{
                        padding: "1rem",
                        border: isSelected ? "2px solid var(--abate-aubergine, #2B1B38)" : "1px solid var(--abate-border, #E2E8F0)",
                        borderRadius: "8px",
                        backgroundColor: isSelected ? "#F8F5FA" : "#FFFFFF",
                        transition: "all 0.2s ease"
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.5rem" }}>
                        <div>
                          <span style={{ fontFamily: "monospace", fontWeight: 700, color: "var(--abate-aubergine, #2B1B38)" }}>{m.externalRef}</span>
                          <h4 style={{ margin: "0.2rem 0 0 0", fontSize: "1rem" }}>{m.title}</h4>
                        </div>
                        <span
                          className={`badge ${isHighStakes ? "badge-danger" : "badge-secondary"}`}
                          style={{ fontSize: "0.75rem" }}
                        >
                          {m.demandWindow.replace(/_/g, " ")}
                        </span>
                      </div>

                      <div style={{ display: "flex", gap: "1rem", fontSize: "0.82rem", color: "#4A5568", flexWrap: "wrap" }}>
                        <span><strong>{vocab.unit}:</strong> {labelFor(m.unit, ui.unitLabels)}</span>
                        {m.jurisdiction && <span><strong>Jurisdiction:</strong> {m.jurisdiction}</span>}
                      </div>

                      <div style={{ marginTop: "0.5rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: "0.78rem", color: "#4A5568" }}>
                          Window: {m.activeWindowStart.slice(0, 10)} to {m.activeWindowEnd.slice(0, 10)}
                        </span>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => handleAnalyzeFatigue(m)}
                          style={{ padding: "0.25rem 0.6rem", fontSize: "0.8rem" }}
                        >
                          ⚡ {ui.fatigueButtonLabel}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right column: fatigue analyzer, consultation gate and boundary lab */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">{ui.fatigueCardTitle}</h3>
            </div>
            <div className="card-body">
              {!selected ? (
                <p>Select a {vocab.workItem.toLowerCase()} on the left to evaluate fatigue and {vocab.demandWindow.toLowerCase()} compliance.</p>
              ) : analyzingFatigue ? (
                <p>Evaluating work cadence intervals against the {sectorProfile.displayName ?? "sector"} thresholds...</p>
              ) : fatigueAssessment ? (
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
                    <div>
                      <span style={{ fontSize: "0.8rem", color: "#4A5568" }}>{vocab.workItem}:</span>
                      <strong style={{ display: "block" }}>{fatigueAssessment.workItemId}</strong>
                    </div>
                    <div>
                      {fatigueAssessment.hasFatigueSurge ? (
                        <span className="badge badge-danger" style={{ fontSize: "0.85rem", padding: "0.4rem 0.8rem" }}>
                          🚨 {ui.surgeBadge}
                        </span>
                      ) : (
                        <span className="badge badge-success" style={{ fontSize: "0.85rem", padding: "0.4rem 0.8rem" }}>
                          ✔ {ui.compliantBadge}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="stat-card" style={{ padding: "1rem", backgroundColor: fatigueAssessment.hasFatigueSurge ? "#FFF5F5" : "#F7FAFC", borderRadius: "8px", marginBottom: "1rem" }}>
                    <div style={{ fontSize: "0.85rem", color: "#4A5568", marginBottom: "0.25rem" }}>Consecutive Late-Night Sessions:</div>
                    <div style={{ fontSize: "1.8rem", fontWeight: 700, color: fatigueAssessment.hasFatigueSurge ? "#C53030" : "#2B6CB0" }}>
                      {fatigueAssessment.consecutiveLateNightsCount} Nights
                    </div>
                    <p style={{ margin: "0.4rem 0 0 0", fontSize: "0.8rem", color: "#4A5568" }}>{ui.thresholdNote}</p>
                  </div>

                  <div style={{ marginBottom: "1rem" }}>
                    <strong style={{ fontSize: "0.85rem", display: "block", marginBottom: "0.25rem" }}>Statutory Authority:</strong>
                    <div style={{ fontSize: "0.85rem", fontFamily: "monospace", color: "#2B1B38" }}>
                      {fatigueAssessment.statutoryReference}
                    </div>
                  </div>

                  <div style={{ marginBottom: "1rem" }}>
                    <strong style={{ fontSize: "0.85rem", display: "block", marginBottom: "0.25rem" }}>Regulatory Notice:</strong>
                    <div style={{ fontSize: "0.85rem", padding: "0.75rem", backgroundColor: "#EDF2F7", borderRadius: "6px", lineHeight: "1.4" }}>
                      {fatigueAssessment.regulatoryNotice}
                    </div>
                  </div>

                  {fatigueAssessment.hasFatigueSurge && (
                    <div style={{ borderTop: "1px solid #E2E8F0", paddingTop: "1rem", marginTop: "1rem" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", margin: "0 0 0.5rem 0" }}>
                        <h4 style={{ margin: 0, fontSize: "0.95rem" }}>{ui.consultationTitle}</h4>
                        <span className="badge badge-secondary">Simulation</span>
                      </div>
                      <p style={{ fontSize: "0.82rem", color: "#4A5568" }}>
                        Simulation preview: demonstrates the formal sign-off workflow for the {ui.consultationSignerLabel.toLowerCase()} (client-side state only).
                      </p>

                      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "0.75rem" }}>
                        <label htmlFor="sector-consultation-signer" style={{ fontSize: "0.8rem", fontWeight: 600 }}>{ui.consultationSignerLabel}:</label>
                        <input
                          id="sector-consultation-signer"
                          type="text"
                          className="input-control"
                          placeholder={`Name of ${ui.consultationSignerLabel.toLowerCase()}`}
                          value={consultationSigner}
                          onChange={(e) => setConsultationSigner(e.target.value)}
                        />

                        <label htmlFor="sector-mitigation-action" style={{ fontSize: "0.8rem", fontWeight: 600 }}>Workload Action:</label>
                        <select
                          id="sector-mitigation-action"
                          className="select-control"
                          value={mitigationAction}
                          onChange={(e) => setMitigationAction(e.target.value)}
                        >
                          {ui.consultationActions.map((a) => (
                            <option key={a.value} value={a.value}>{a.label}</option>
                          ))}
                        </select>
                      </div>

                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ width: "100%" }}
                        disabled={consultationSigned || consultationSigner.trim().length === 0}
                        onClick={handleSignConsultation}
                      >
                        {consultationSigned ? "✔ Simulation Consultation Preview Signed" : `✍ Sign ${ui.consultationSignerLabel} Consultation Gate (Simulation)`}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => handleAnalyzeFatigue(selected)}
                >
                  ⚡ Run {ui.fatigueButtonLabel} for {selected.externalRef}
                </button>
              )}
            </div>
          </div>

          {/* Neutral work-item translation and boundary minimization lab */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Constitutional Translation &amp; Minimization Lab</h3>
            </div>
            <div className="card-body">
              <p style={{ fontSize: "0.85rem", color: "#4A5568" }}>
                Test transforming sector-specific {vocab.workItem.toLowerCase()} metadata into Abate's domain-neutral <code>WORK_ITEM</code> representation.
                Test that prohibited surveillance or confidential fields are blocked at the perimeter.
              </p>

              <div style={{ backgroundColor: "#F7FAFC", padding: "0.75rem", borderRadius: "6px", marginBottom: "1rem" }}>
                <strong style={{ fontSize: "0.82rem", display: "block", marginBottom: "0.5rem" }}>Adversarial Decoy Injection (Physical Minimization Test):</strong>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                  {ui.decoyFields.map((d) => (
                    <label key={d.field} htmlFor={`inject-${d.field}-check`} style={{ fontSize: "0.82rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <input
                        id={`inject-${d.field}-check`}
                        type="checkbox"
                        checked={!!injected[d.field]}
                        onChange={(e) => setInjected((prev) => ({ ...prev, [d.field]: e.target.checked }))}
                      />
                      {d.label} (<code>{typeof d.value === "number" ? `${d.field}: ${d.value}` : d.field}</code>)
                    </label>
                  ))}
                </div>
              </div>

              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleMapItem}
                disabled={mappingLoading || !selected}
                style={{ width: "100%" }}
              >
                {mappingLoading ? "Validating & Translating..." : "Execute Translation & Boundary Gate"}
              </button>

              {boundaryRejectionResult && (
                <div className="feedback-alert alert-error" style={{ marginTop: "1rem" }}>
                  <div className="feedback-title">🛡️ Constitutional Boundary Defended</div>
                  <p style={{ fontSize: "0.82rem", margin: 0 }}>{boundaryRejectionResult}</p>
                </div>
              )}

              {mappingResult && (
                <div style={{ marginTop: "1rem", backgroundColor: "#F8F5FA", padding: "0.75rem", borderRadius: "6px" }}>
                  <div style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--abate-aubergine, #2B1B38)", marginBottom: "0.25rem" }}>
                    ✔ Mapped Neutral Representation (Zero Confidential Leak):
                  </div>
                  <pre style={{ margin: 0, fontSize: "0.75rem", backgroundColor: "#FFFFFF", padding: "0.5rem", borderRadius: "4px", overflowX: "auto" }}>
                    {JSON.stringify(mappingResult.neutralWorkItem ?? mappingResult.workItem, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
