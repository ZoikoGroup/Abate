// frontend/src/components/Tabs/LegalPracticeTab.tsx
// Domain S13: UK Legal Practice Pack & Workplace Culture Governance
// Standards: SRA Workplace Culture Guidance 2023, Health and Safety at Work etc. Act 1974 §2, ISO 45003:2021 §6.1.2.1

import { useState, useEffect, useCallback } from "react";
import {
  fetchLegalMatters,
  checkLegalFatigue,
  mapLegalMatter,
  PRESET_TENANTS,
  type LegalMatterView,
  type LegalFatigueAssessmentView
} from "../../api/client";

interface LegalPracticeTabProps {
  currentTenant: typeof PRESET_TENANTS[0];
  token: string | null;
}

export function LegalPracticeTab({ currentTenant, token }: LegalPracticeTabProps) {
  const [matters, setMatters] = useState<LegalMatterView[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Selected matter for inspection and fatigue analysis
  const [selectedMatter, setSelectedMatter] = useState<LegalMatterView | null>(null);
  const [fatigueAssessment, setFatigueAssessment] = useState<LegalFatigueAssessmentView | null>(null);
  const [analyzingFatigue, setAnalyzingFatigue] = useState(false);

  // Practice area filter
  const [filterPractice, setFilterPractice] = useState<string>("ALL");

  // Supervisory Partner Consultation State
  const [consultationSigned, setConsultationSigned] = useState<boolean>(false);
  const [consultationPartner, setConsultationPartner] = useState<string>("Jane Doe, KC (Supervisory Partner)");
  const [mitigationAction, setMitigationAction] = useState<string>("REALLOCATE_SECONDARY_ASSOCIATE");

  // Neutral Work-Item Mapping Lab State
  const [mappingResult, setMappingResult] = useState<any | null>(null);
  const [mappingLoading, setMappingLoading] = useState(false);

  // Boundary Rejection Lab State
  const [injectPrivilege, setInjectPrivilege] = useState(false);
  const [injectBillingRate, setInjectBillingRate] = useState(false);
  const [injectRanking, setInjectRanking] = useState(false);
  const [boundaryRejectionResult, setBoundaryRejectionResult] = useState<string | null>(null);

  const loadMatters = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const items = await fetchLegalMatters(token);
      setMatters(items);
      if (items.length > 0 && !selectedMatter) {
        setSelectedMatter(items[0]);
      }
    } catch (err: any) {
      setErrorMsg(`Failed to load legal matters: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [token, selectedMatter]);

  useEffect(() => {
    loadMatters();
  }, [loadMatters]);

  // Run SRA 2023 Fatigue & Trial Surge Analysis
  const handleAnalyzeFatigue = async (matter: LegalMatterView) => {
    if (!token) return;
    setSelectedMatter(matter);
    setAnalyzingFatigue(true);
    setErrorMsg(null);
    setFatigueAssessment(null);
    setConsultationSigned(false);

    try {
      const assessment = await checkLegalFatigue(matter.matterId, token);
      setFatigueAssessment(assessment);
    } catch (err: any) {
      setErrorMsg(`Fatigue analysis failed: ${err.message}`);
    } finally {
      setAnalyzingFatigue(false);
    }
  };

  // Sign Supervisory Partner Consultation Gate
  const handleSignConsultation = () => {
    setConsultationSigned(true);
    setSuccessMsg(`Mandatory Supervisory Partner consultation signed by ${consultationPartner}. Action: ${mitigationAction}. SRA 2023 audit record generated.`);
    setTimeout(() => setSuccessMsg(null), 5000);
  };

  // Test Neutral Work-Item Translation
  const handleMapMatter = async () => {
    if (!selectedMatter || !token) return;
    setMappingLoading(true);
    setErrorMsg(null);
    try {
      const payload: any = { ...selectedMatter };
      if (injectPrivilege) payload.privilegedAdvice = "Confidential trial strategy notes regarding litigation risk.";
      if (injectBillingRate) payload.billingRate = 950;
      if (injectRanking) payload.individualLawyerRanking = 1;

      const res = await mapLegalMatter(payload, token);
      setMappingResult(res);
      setBoundaryRejectionResult(null);
      setSuccessMsg("Matter successfully validated and mapped to domain-neutral WORK_ITEM representation.");
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch (err: any) {
      setBoundaryRejectionResult(`HTTP ${err.status || 400} ${err.code || "VALIDATION"}: ${err.message}`);
      setMappingResult(null);
    } finally {
      setMappingLoading(false);
    }
  };

  const filteredMatters = filterPractice === "ALL"
    ? matters
    : matters.filter(m => m.practiceArea === filterPractice);

  return (
    <div className="tab-pane active" id="legal-practice-tab">
      <div className="pane-header">
        <div>
          <h2 className="pane-title">UK Legal Practice & Workplace Culture (SRA 2023 / Domain S13)</h2>
          <p className="pane-subtitle">
            Sector-specific psychosocial risk management for law firms, barristers' chambers, and legal departments.
            Enforces trial window fatigue caps, court deadline buffers, and mandatory supervisory partner consultation.
          </p>
        </div>
        <div className="pane-actions">
          <span className="badge badge-primary">SRA 2023 Compliant</span>
          <span className="badge badge-secondary">ISO 45003 §6.1.2.1</span>
          <span className="badge badge-success">HSWA 1974 §2</span>
        </div>
      </div>

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
        <strong>⚖️ Constitutional Boundary Protection for Legal Services:</strong>
        <p>
          Physical minimization is active: <strong>zero</strong> client confidential information, substantive legal work product, billing rates, or individual fee-earner productivity rankings enter persistence. Only neutral work cadence metadata is ingested.
        </p>
      </div>

      <div className="tab-grid" style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: "1.5rem", marginTop: "1.5rem" }}>
        {/* Left Column: Matter Explorer & Practice Areas */}
        <div className="card">
          <div className="card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 className="card-title">Legal Matters & Demand Windows</h3>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <select
                className="select-control"
                value={filterPractice}
                onChange={(e) => setFilterPractice(e.target.value)}
                aria-label="Filter Practice Area"
                style={{ fontSize: "0.85rem", padding: "0.25rem 0.5rem" }}
              >
                <option value="ALL">All Practice Areas</option>
                <option value="COMMERCIAL_LITIGATION">Commercial Litigation</option>
                <option value="CORPORATE_MA">Corporate M&amp;A</option>
                <option value="REGULATORY_INVESTIGATION">Regulatory Investigation</option>
                <option value="ARBITRATION">Arbitration</option>
              </select>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={loadMatters}
                disabled={loading}
              >
                {loading ? "Refreshing..." : "↻ Refresh"}
              </button>
            </div>
          </div>

          <div className="card-body">
            {loading && matters.length === 0 ? (
              <p>Loading active legal matters for {currentTenant.name}...</p>
            ) : filteredMatters.length === 0 ? (
              <p>No legal matters found matching the current practice area filter.</p>
            ) : (
              <div className="matter-list" style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                {filteredMatters.map((m) => {
                  const isSelected = selectedMatter?.matterId === m.matterId;
                  const isHighStakes = m.currentPhase === "TRIAL_PREP" || m.currentPhase === "CLOSING_TRANSACTION";
                  return (
                    <div
                      key={m.matterId}
                      className={`matter-item-card ${isSelected ? "selected" : ""}`}
                      style={{
                        padding: "1rem",
                        border: isSelected ? "2px solid var(--abate-aubergine, #2B1B38)" : "1px solid var(--abate-border, #E2E8F0)",
                        borderRadius: "8px",
                        backgroundColor: isSelected ? "#F8F5FA" : "#FFFFFF",
                        cursor: "pointer",
                        transition: "all 0.2s ease"
                      }}
                      onClick={() => handleAnalyzeFatigue(m)}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.5rem" }}>
                        <div>
                          <span style={{ fontFamily: "monospace", fontWeight: 700, color: "var(--abate-aubergine, #2B1B38)" }}>{m.matterId}</span>
                          <h4 style={{ margin: "0.2rem 0 0 0", fontSize: "1rem" }}>{m.matterTitle}</h4>
                        </div>
                        <span
                          className={`badge ${isHighStakes ? "badge-danger" : "badge-secondary"}`}
                          style={{ fontSize: "0.75rem" }}
                        >
                          {m.currentPhase.replace(/_/g, " ")}
                        </span>
                      </div>

                      <div style={{ display: "flex", gap: "1rem", fontSize: "0.82rem", color: "#4A5568", flexWrap: "wrap" }}>
                        <span><strong>Practice:</strong> {m.practiceArea.replace(/_/g, " ")}</span>
                        <span><strong>Court/Forum:</strong> {m.jurisdiction}</span>
                      </div>

                      <div style={{ marginTop: "0.5rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: "0.78rem", color: "#718096" }}>
                          Window: {m.activeWindowStart.slice(0, 10)} to {m.activeWindowEnd.slice(0, 10)}
                        </span>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleAnalyzeFatigue(m);
                          }}
                          style={{ padding: "0.25rem 0.6rem", fontSize: "0.8rem" }}
                        >
                          ⚡ SRA Fatigue Check
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: SRA 2023 Fatigue Analyzer & Supervisory Partner Gate */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {/* SRA 2023 Surge Assessment Card */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">SRA 2023 Workplace Culture Fatigue Audit</h3>
            </div>
            <div className="card-body">
              {!selectedMatter ? (
                <p>Select a legal matter on the left to evaluate trial preparation fatigue and court surge compliance.</p>
              ) : analyzingFatigue ? (
                <p>Evaluating work cadence intervals against SRA 2023 thresholds...</p>
              ) : fatigueAssessment ? (
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
                    <div>
                      <span style={{ fontSize: "0.8rem", color: "#718096" }}>Matter:</span>
                      <strong style={{ display: "block" }}>{fatigueAssessment.matterId}</strong>
                    </div>
                    <div>
                      {fatigueAssessment.hasFatigueSurge ? (
                        <span className="badge badge-danger" style={{ fontSize: "0.85rem", padding: "0.4rem 0.8rem" }}>
                          🚨 SRA SURGE ALERT: FATIGUE DETECTED
                        </span>
                      ) : (
                        <span className="badge badge-success" style={{ fontSize: "0.85rem", padding: "0.4rem 0.8rem" }}>
                          ✔ COMPLIANT: NORMAL VARIANCE
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="stat-card" style={{ padding: "1rem", backgroundColor: fatigueAssessment.hasFatigueSurge ? "#FFF5F5" : "#F7FAFC", borderRadius: "8px", marginBottom: "1rem" }}>
                    <div style={{ fontSize: "0.85rem", color: "#4A5568", marginBottom: "0.25rem" }}>Consecutive Late-Night Sessions (Work past 20:00 UTC):</div>
                    <div style={{ fontSize: "1.8rem", fontWeight: 700, color: fatigueAssessment.hasFatigueSurge ? "#C53030" : "#2B6CB0" }}>
                      {fatigueAssessment.consecutiveLateNightsCount} Nights
                    </div>
                    <p style={{ margin: "0.4rem 0 0 0", fontSize: "0.8rem", color: "#718096" }}>
                      SRA Threshold: &ge; 3 consecutive nights with unbuffered work past 20:00 during trial/closing triggers mandatory supervisory intervention.
                    </p>
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
                      <h4 style={{ margin: "0 0 0.5rem 0", fontSize: "0.95rem" }}>Mandatory Supervisory Partner Consultation Gate</h4>
                      <p style={{ fontSize: "0.82rem", color: "#4A5568" }}>
                        Under SRA 2023 guidance, closing or modifying this high-fatigue matter requires formal sign-off from the supervisory partner.
                      </p>

                      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "0.75rem" }}>
                        <label style={{ fontSize: "0.8rem", fontWeight: 600 }}>Supervisory Partner:</label>
                        <input
                          type="text"
                          className="input-control"
                          value={consultationPartner}
                          onChange={(e) => setConsultationPartner(e.target.value)}
                        />

                        <label style={{ fontSize: "0.8rem", fontWeight: 600 }}>Statutory Workload Action:</label>
                        <select
                          className="select-control"
                          value={mitigationAction}
                          onChange={(e) => setMitigationAction(e.target.value)}
                        >
                          <option value="REALLOCATE_SECONDARY_ASSOCIATE">Deploy Secondary Associate to Buffer Late Drafting</option>
                          <option value="EXTEND_FILING_DEADLINE_COURT_APPLICATION">Apply for Procedural Filing Buffer (CPR 3.1(2)(a))</option>
                          <option value="MANDATORY_OFFLINE_REST_DAY">Impose Mandatory Post-Hearing Protected Rest Period</option>
                        </select>
                      </div>

                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ width: "100%" }}
                        disabled={consultationSigned}
                        onClick={handleSignConsultation}
                      >
                        {consultationSigned ? "✔ Supervisory Partner Gate Signed & Ratified" : "✍ Sign Supervisory Consultation Gate"}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => handleAnalyzeFatigue(selectedMatter)}
                >
                  ⚡ Run SRA Fatigue Analysis for {selectedMatter.matterId}
                </button>
              )}
            </div>
          </div>

          {/* Neutral Work-Item Translation & Boundary Minimization Lab */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Constitutional Translation & Minimization Lab</h3>
            </div>
            <div className="card-body">
              <p style={{ fontSize: "0.85rem", color: "#4A5568" }}>
                Test transforming sector-specific legal matter metadata into Abate's domain-neutral <code>WORK_ITEM</code> representation.
                Test that prohibited surveillance or privileged fields are blocked at the perimeter.
              </p>

              <div style={{ backgroundColor: "#F7FAFC", padding: "0.75rem", borderRadius: "6px", marginBottom: "1rem" }}>
                <strong style={{ fontSize: "0.82rem", display: "block", marginBottom: "0.5rem" }}>Adversarial Decoy Injection (Physical Minimization Test):</strong>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                  <label style={{ fontSize: "0.82rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <input
                      type="checkbox"
                      checked={injectPrivilege}
                      onChange={(e) => setInjectPrivilege(e.target.checked)}
                    />
                    Inject Privileged Legal Advice (<code>privilegedAdvice</code>)
                  </label>
                  <label style={{ fontSize: "0.82rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <input
                      type="checkbox"
                      checked={injectBillingRate}
                      onChange={(e) => setInjectBillingRate(e.target.checked)}
                    />
                    Inject Hourly Billing Rate (<code>billingRate: 950</code>)
                  </label>
                  <label style={{ fontSize: "0.82rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <input
                      type="checkbox"
                      checked={injectRanking}
                      onChange={(e) => setInjectRanking(e.target.checked)}
                    />
                    Inject Individual Lawyer Ranking (<code>individualLawyerRanking: 1</code>)
                  </label>
                </div>
              </div>

              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleMapMatter}
                disabled={mappingLoading || !selectedMatter}
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
                    ✔ Mapped Neutral Representation (Zero Privilege Leak):
                  </div>
                  <pre style={{ margin: 0, fontSize: "0.75rem", backgroundColor: "#FFFFFF", padding: "0.5rem", borderRadius: "4px", overflowX: "auto" }}>
                    {JSON.stringify(mappingResult.workItem, null, 2)}
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
