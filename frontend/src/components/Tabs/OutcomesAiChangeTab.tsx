// frontend/src/components/Tabs/OutcomesAiChangeTab.tsx
import { useState, useEffect } from "react";
import {
  PRESET_TENANTS,
  type OutcomeDefinitionView,
  type OutcomeEvaluationView,
  type AiWorkDesignAssessmentView,
  type AiChangeStage,
  fetchFeatureFlags,
  setFeatureFlag,
  fetchOutcomeDefinitions,
  evaluateOutcome,
  fetchOutcomeEvaluations,
  createAiChange,
  fetchAiAssessments,
  advanceAiAssessment,
  BASELINE_RELEASE_ID
} from "../../api/client";
import { PlaneBadge } from "../PlaneBadge";
import { PermittedClaims } from "../PermittedClaims";

interface OutcomesAiChangeTabProps {
  currentTenant: typeof PRESET_TENANTS[0];
  token: string | null;
}

const STAGES: AiChangeStage[] = [
  "REGISTERED",
  "BASELINE",
  "DETECT",
  "ATTRIBUTE",
  "CONTROL",
  "VERIFY",
  "PERFORMANCE_REVIEW",
  "CLOSED"
];

export function OutcomesAiChangeTab({ currentTenant, token }: OutcomesAiChangeTabProps) {
  // Feature flags
  const [planeBEnabled, setPlaneBEnabled] = useState(false);
  const [loadingFlags, setLoadingFlags] = useState(false);

  // Outcomes state
  const [outcomeDefs, setOutcomeDefs] = useState<OutcomeDefinitionView[]>([]);
  const [evaluations, setEvaluations] = useState<OutcomeEvaluationView[]>([]);
  const [selectedOutcomeId, setSelectedOutcomeId] = useState("OUTCOME_WORKLOAD_SUSTAINABILITY");
  const [evalReleaseId, setEvalReleaseId] = useState(BASELINE_RELEASE_ID);
  const [claimText, setClaimText] = useState("Observed 18% improvement in protected focus blocks across litigation associates.");
  const [evalConfidence, setEvalConfidence] = useState<"HIGH" | "MEDIUM" | "LOW">("MEDIUM");

  // AI Change state
  const [assessments, setAssessments] = useState<AiWorkDesignAssessmentView[]>([]);
  const [activeAssessmentId, setActiveAssessmentId] = useState<string | null>(null);

  // New Profile Form
  const [profileTitle, setProfileTitle] = useState("Litigation Research & Synthesis Agent");
  const [affectedRoles, setAffectedRoles] = useState("Associate, Paralegal");
  const [affectedTasks, setAffectedTasks] = useState("Precedent synthesis, citation cross-checking");
  const [automationMode, setAutomationMode] = useState<"ASSIST" | "AUTOMATE_WITH_REVIEW" | "AUTONOMOUS_BOUNDED">("ASSIST");
  const [decisionRights, setDecisionRights] = useState("Supervising Partner retains sole filing authority");

  // Lab & Feedback
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "warning" | "error" | "info";
    title: string;
    details: string;
  } | null>(null);

  // Initial load
  useEffect(() => {
    if (!token) return;
    loadAll();
  }, [token, currentTenant.id]);

  const loadAll = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [flags, defs, evals, assms] = await Promise.all([
        fetchFeatureFlags(token).catch(() => ({ outcomes_plane_b: false })),
        fetchOutcomeDefinitions(token).catch(() => []),
        fetchOutcomeEvaluations(token).catch(() => []),
        fetchAiAssessments(token).catch(() => [])
      ]);
      setPlaneBEnabled(Boolean(flags.outcomes_plane_b));
      setOutcomeDefs(defs);
      if (defs.length > 0 && !selectedOutcomeId) {
        setSelectedOutcomeId(defs[0].outcomeId);
      }
      setEvaluations(evals);
      setAssessments(assms);
      if (assms.length > 0 && !activeAssessmentId) {
        setActiveAssessmentId(assms[0].id);
      }
    } catch (err: any) {
      console.warn("Error loading Phase 7 data:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleFlag = async () => {
    if (!token) return;
    setLoadingFlags(true);
    try {
      const next = !planeBEnabled;
      await setFeatureFlag("outcomes_plane_b", next, token);
      setPlaneBEnabled(next);
      setFeedback({
        type: "success",
        title: `✔ Feature Flag 'outcomes_plane_b' ${next ? "ENABLED" : "DISABLED"}`,
        details: next
          ? "Plane B (Work-Design Outcomes) operations are now active for this tenant."
          : "Plane B writes are disabled. Fail-closed gates active."
      });
      await loadAll();
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: "✖ Failed to toggle feature flag",
        details: err.message
      });
    } finally {
      setLoadingFlags(false);
    }
  };

  const handleEvaluateOutcome = async () => {
    if (!token) return;
    setLoading(true);
    setFeedback(null);
    try {
      const res = await evaluateOutcome(
        {
          outcomeId: selectedOutcomeId,
          outcomeVersion: 1,
          releaseId: evalReleaseId,
          comparisonBasis: { method: "PRE_POST_INTERVENTION", windowDays: 28 },
          confounders: { seasonalCourtFilingDeadline: false },
          seriesBreak: false,
          outcomeConfidence: evalConfidence,
          permittedClaims: [claimText],
          evidenceRefs: ["evidence:eval-synthetic-01"]
        },
        token
      );
      setFeedback({
        type: "success",
        title: "✔ PLANE B OUTCOME EVALUATION RECORDED",
        details: `Evaluation ID: ${res.id}. Strict Plane B isolation maintained. Cannot alter Plane A assurance records.`
      });
      await loadAll();
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: "✖ EVALUATION REJECTED",
        details: err.message
      });
    } finally {
      setLoading(false);
    }
  };

  const handleCreateAiChange = async () => {
    if (!token) return;
    setLoading(true);
    setFeedback(null);
    try {
      const res = await createAiChange(
        {
          title: profileTitle,
          affectedRoles: affectedRoles.split(",").map(s => s.trim()).filter(Boolean),
          affectedTasks: affectedTasks.split(",").map(s => s.trim()).filter(Boolean),
          automationMode,
          decisionRights,
          humanOverride: "Any associate can dismiss AI generation or file an objection",
          monitoringChanges: "Weekly time-budget and review audit",
          throughputAssumptions: "Target 15% reduction in brief review cycle time",
          rolloutDate: "2026-06-01",
          trainingSupport: "Mandatory human-in-the-loop review calibration"
        },
        token
      );
      setFeedback({
        type: "success",
        title: "✔ AI CHANGE PROFILE & ASSESSMENT REGISTERED",
        details: `Profile: ${res.profile.title} (v${res.profile.version}). Initial stage: ${res.assessment.stage}.`
      });
      await loadAll();
      setActiveAssessmentId(res.assessment.id);
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: "✖ PROFILE CREATION FAILED",
        details: err.message
      });
    } finally {
      setLoading(false);
    }
  };

  const handleAdvanceStage = async (targetStage: AiChangeStage) => {
    if (!token || !activeAssessmentId) return;
    const current = assessments.find(a => a.id === activeAssessmentId);
    if (!current) return;

    setLoading(true);
    setFeedback(null);
    try {
      const payload: any = {};
      if (targetStage === "BASELINE") {
        // No extra payload required
      } else if (targetStage === "DETECT") {
        payload.baselineReleaseIds = [BASELINE_RELEASE_ID];
      } else if (targetStage === "ATTRIBUTE") {
        payload.hazardIds = current.hazardIds.length > 0 ? current.hazardIds : ["00000000-0000-4000-a006-000000000001"];
      } else if (targetStage === "CONTROL") {
        payload.controlIds = current.controlIds.length > 0 ? current.controlIds : ["00000000-0000-4000-a007-000000000001"];
      } else if (targetStage === "VERIFY") {
        payload.verificationRefs = ["evidence:post-rollout-audit-2026"];
      }

      const res = await advanceAiAssessment(
        current.id,
        targetStage,
        current.version,
        payload,
        token
      );
      setFeedback({
        type: "success",
        title: `✔ STAGE ADVANCED TO ${res.stage}`,
        details: `Assessment version is now ${res.version}. Stage guards verified.`
      });
      await loadAll();
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: `✖ STAGE TRANSITION REJECTED (${targetStage})`,
        details: err.message
      });
    } finally {
      setLoading(false);
    }
  };

  // Adversarial Lab Handlers
  const handleAdversarialProhibitedClaim = async () => {
    if (!token) return;
    setLoading(true);
    setFeedback(null);
    try {
      await evaluateOutcome(
        {
          outcomeId: selectedOutcomeId,
          outcomeVersion: 1,
          releaseId: evalReleaseId,
          comparisonBasis: { method: "TEST" },
          confounders: {},
          seriesBreak: false,
          outcomeConfidence: "HIGH",
          permittedClaims: ["This AI tool reduces employee stress and mitigates boundary intrusion hazard."],
          evidenceRefs: []
        },
        token
      );
      setFeedback({
        type: "error",
        title: "SECURITY FAILURE: PROHIBITED CLAIM ACCEPTED",
        details: "The system should have rejected claims asserting employee resilience or hazard mitigation."
      });
    } catch (err: any) {
      setFeedback({
        type: "success",
        title: "✔ LAB 2 PASSED: PROHIBITED CLAIM REJECTED (FAIL-CLOSED)",
        details: `Under ZAB-ENG-001, performance outcomes cannot claim hazard mitigation. Rejected: "${err.message}"`
      });
    } finally {
      setLoading(false);
    }
  };

  const handleAdversarialPrematureClosure = async () => {
    if (!token || !activeAssessmentId) return;
    const current = assessments.find(a => a.id === activeAssessmentId);
    if (!current) return;
    setLoading(true);
    setFeedback(null);
    try {
      await advanceAiAssessment(current.id, "CLOSED", current.version, {}, token);
      setFeedback({
        type: "error",
        title: "SECURITY FAILURE: PREMATURE ASSESSMENT CLOSURE",
        details: "Assessment was closed while stage prerequisites were not met."
      });
    } catch (err: any) {
      setFeedback({
        type: "success",
        title: "✔ LAB 5 PASSED: STAGE GUARD INTEGRITY ENFORCED",
        details: `Assessment workflow rejected premature transition to CLOSED: "${err.message}"`
      });
    } finally {
      setLoading(false);
    }
  };

  const activeAssessment = assessments.find(a => a.id === activeAssessmentId);

  return (
    <div className="tab-pane">
      {/* Executive Header Card */}
      <div className="card">
        <div className="card-header">
          <div>
            <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", alignItems: "center" }}>
              <span className="badge badge-coral">PHASE 7 CERTIFIED</span>
              <span className="badge badge-aubergine">DOMAINS S13 & S14</span>
              <PlaneBadge plane="A" />
              <PlaneBadge plane="B" />
              <span className="monospace-badge">{currentTenant.name}</span>
            </div>
            <h3>Work-Design Outcomes & Governed AI Change (Package B7)</h3>
            <p className="card-desc">
              Strict authority separation: Plane B performance outcomes are measured and evaluated in isolation.
              Output and productivity metrics do not substitute for Plane A risk assurance obligations.
            </p>
          </div>

          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.4rem 0.8rem",
                background: planeBEnabled ? "rgba(13, 148, 136, 0.1)" : "rgba(226, 109, 90, 0.1)",
                border: `1px solid ${planeBEnabled ? "#0D9488" : "#E26D5A"}`,
                borderRadius: "6px"
              }}
            >
              <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--graphite)" }}>
                Feature Flag: <code>outcomes_plane_b</code>
              </span>
              <button
                type="button"
                onClick={handleToggleFlag}
                disabled={loadingFlags || !token}
                className={`btn btn-sm ${planeBEnabled ? "btn-primary" : "btn-secondary"}`}
                style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
              >
                {planeBEnabled ? "ENABLED" : "DISABLED"}
              </button>
            </div>
            <button
              type="button"
              onClick={loadAll}
              disabled={loading}
              className="btn btn-secondary btn-sm"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Two-Plane Invariant Architecture Card */}
      <div
        style={{
          background: "#FFFFFF",
          border: "1px solid #E2E8F0",
          borderRadius: "8px",
          padding: "1rem 1.25rem",
          marginBottom: "1.25rem",
          boxShadow: "0 1px 3px rgba(0,0,0,0.05)"
        }}
      >
        <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: "min(280px, 100%)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.4rem" }}>
              <PlaneBadge plane="A" />
              <strong style={{ fontSize: "0.875rem", color: "#1E293B" }}>Assurance & Legal Duty Plane</strong>
            </div>
            <p style={{ fontSize: "0.8rem", color: "#64748B", lineHeight: 1.45, margin: 0 }}>
              Statutory psychosocial risk duties, authoritative hazards, organizational causes, version-bound controls,
              and tamper-evident cryptographic evidence packages. <strong>Only Plane A can close an assurance obligation.</strong>
            </p>
          </div>

          <div style={{ width: "1px", background: "#E2E8F0" }}></div>

          <div style={{ flex: 1, minWidth: "min(280px, 100%)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.4rem" }}>
              <PlaneBadge plane="B" />
              <strong style={{ fontSize: "0.875rem", color: "#1E293B" }}>Work-Design & Performance Plane</strong>
            </div>
            <p style={{ fontSize: "0.8rem", color: "#64748B", lineHeight: 1.45, margin: 0 }}>
              Workload sustainability, focus fragmentation, and AI tool adoption. Governed by feature flags and
              permitted-claim filters. <strong>Plane B output metrics never substitute for hazard elimination.</strong>
            </p>
          </div>
        </div>
      </div>

      {/* Feedback Banner */}
      {feedback && (
        <div
          className={`callout-${feedback.type === "success" ? "success" : feedback.type === "warning" ? "alert" : "error"}`}
          style={{ marginBottom: "1.25rem" }}
        >
          <strong>{feedback.title}</strong>
          <p style={{ marginTop: "0.35rem", fontSize: "0.825rem" }}>{feedback.details}</p>
        </div>
      )}

      {/* Phase 7 Adversarial Verification Lab Banner */}
      <div className="lab-banner" style={{ marginBottom: "1.25rem" }}>
        <div className="lab-header">
          <div className="lab-title">
            <span style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", background: "#38BDF8", boxShadow: "0 0 8px #38BDF8" }}></span>
            <span>Plane Authority Separation & Claim Safeguard Lab (Package B7)</span>
          </div>
          <span className="lab-badge">ZAB-ENG-001 Invariant Enforcement</span>
        </div>
        <p style={{ fontSize: "0.825rem", color: "#CBD5E1", lineHeight: 1.5, margin: "0.25rem 0 1rem 0" }}>
          Verify the architectural boundaries between Plane A and Plane B. Test prohibited claim rejection and ensure
          AI Change workflows cannot be closed without prerequisite assurance evidence.
        </p>

        <div className="lab-grid">
          <button
            type="button"
            onClick={handleAdversarialProhibitedClaim}
            disabled={loading || !token || !planeBEnabled}
            className="lab-card-btn border-rose"
          >
            <div className="lab-btn-title" style={{ color: "#FCA5A5" }}>
              1. Prohibited Claim Injection
            </div>
            <div className="lab-btn-desc">
              Submit evaluation claiming "reduces employee stress and mitigates hazard". Blocked fail-closed.
            </div>
          </button>

          <button
            type="button"
            onClick={handleAdversarialPrematureClosure}
            disabled={loading || !token || !activeAssessmentId}
            className="lab-card-btn border-amber"
          >
            <div className="lab-btn-title" style={{ color: "#FCD34D" }}>
              2. Premature AI Closure Attack
            </div>
            <div className="lab-btn-desc">
              Advance AI Change to CLOSED without required verification receipts. Stage guard blocks transition.
            </div>
          </button>
        </div>
      </div>

      {/* Main Grid: Section 1 (Outcomes) & Section 2 (AI Change) */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(360px, 100%), 1fr))", gap: "1.25rem" }}>
        {/* Left Column: Domain S13 Outcomes */}
        <div className="card">
          <div className="card-header">
            <div>
              <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", marginBottom: "0.3rem" }}>
                <PlaneBadge plane="B" showLabel={false} />
                <h4 style={{ margin: 0 }}>Work-Design Outcome Evaluations</h4>
              </div>
              <p className="card-desc">
                Evaluate cohort operational performance without claiming individual employee resilience.
              </p>
            </div>
          </div>

          {!planeBEnabled ? (
            <div
              style={{
                padding: "1.5rem",
                background: "#FEF2F2",
                border: "1px dashed #FCA5A5",
                borderRadius: "6px",
                textAlign: "center",
                color: "#991B1B"
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: "0.5rem" }}>Plane B Feature Flag Disabled</div>
              <div style={{ fontSize: "0.8rem", marginBottom: "1rem" }}>
                To evaluate work-design outcomes or access Plane B metrics, enable the <code>outcomes_plane_b</code> feature flag above.
              </div>
              <button
                type="button"
                onClick={handleToggleFlag}
                disabled={loadingFlags}
                className="btn btn-primary btn-sm"
              >
                Enable Plane B Now
              </button>
            </div>
          ) : (
            <div>
              {/* Form to submit Outcome Evaluation */}
              <div className="form-group" style={{ marginBottom: "0.75rem" }}>
                <label className="form-label">Outcome Metric Definition</label>
                <select
                  value={selectedOutcomeId}
                  onChange={e => setSelectedOutcomeId(e.target.value)}
                  className="select-control"
                  style={{ width: "100%" }}
                >
                  {outcomeDefs.map(d => (
                    <option key={d.outcomeId} value={d.outcomeId}>
                      {d.outcomeId} ({d.family}) - {d.unit}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group" style={{ marginBottom: "0.75rem" }}>
                <label className="form-label">Originating Release Evidence ID</label>
                <input
                  type="text"
                  value={evalReleaseId}
                  onChange={e => setEvalReleaseId(e.target.value)}
                  className="text-control monospace"
                  style={{ width: "100%" }}
                />
              </div>

              <div className="form-group" style={{ marginBottom: "0.75rem" }}>
                <label className="form-label">Permitted Performance Claim</label>
                <textarea
                  value={claimText}
                  onChange={e => setClaimText(e.target.value)}
                  rows={2}
                  className="text-control"
                  style={{ width: "100%", fontSize: "0.825rem" }}
                  placeholder="State operational hypothesis or outcome (cannot claim hazard mitigation)"
                />
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <label className="form-label" style={{ margin: 0 }}>Confidence:</label>
                  <select
                    value={evalConfidence}
                    onChange={e => setEvalConfidence(e.target.value as any)}
                    className="select-control"
                    style={{ fontSize: "0.8rem" }}
                  >
                    <option value="HIGH">HIGH</option>
                    <option value="MEDIUM">MEDIUM</option>
                    <option value="LOW">LOW</option>
                  </select>
                </div>

                <button
                  type="button"
                  onClick={handleEvaluateOutcome}
                  disabled={loading}
                  className="btn btn-primary btn-sm"
                >
                  + Record Evaluation (Plane B)
                </button>
              </div>

              {/* Recent Evaluations List */}
              <h5 style={{ fontSize: "0.85rem", color: "var(--graphite)", marginTop: "1rem", marginBottom: "0.5rem" }}>
                Recorded Evaluations ({evaluations.length})
              </h5>
              {evaluations.length === 0 ? (
                <div style={{ fontSize: "0.8rem", color: "#94A3B8", fontStyle: "italic" }}>
                  No Plane B evaluations recorded yet.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxHeight: "350px", overflowY: "auto" }}>
                  {evaluations.map(ev => (
                    <div
                      key={ev.id}
                      style={{
                        background: "#F8FAFC",
                        border: "1px solid #E2E8F0",
                        borderRadius: "6px",
                        padding: "0.75rem"
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontWeight: 600, fontSize: "0.8rem" }}>{ev.outcomeId}</span>
                        <PlaneBadge plane="B" showLabel={false} />
                      </div>
                      <div style={{ fontSize: "0.75rem", color: "#64748B", marginTop: "0.25rem" }}>
                        Release: <code className="monospace">{ev.releaseId.slice(0, 8)}...</code> | Created: {ev.createdAt.slice(0, 10)}
                      </div>
                      <PermittedClaims claims={ev.permittedClaims} confidence={ev.outcomeConfidence as any} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Column: Domain S14 Governed AI Change Workflow */}
        <div className="card">
          <div className="card-header">
            <div>
              <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", marginBottom: "0.3rem" }}>
                <span className="badge badge-coral">DOMAIN S14</span>
                <h4 style={{ margin: 0 }}>Governed AI Work-Design Assessment</h4>
              </div>
              <p className="card-desc">
                8-stage staged lifecycle tracking AI introductions from baseline to verification.
              </p>
            </div>
          </div>

          {/* Stepper Display for Active Assessment */}
          {activeAssessment ? (
            <div style={{ marginBottom: "1.25rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                <span style={{ fontWeight: 600, fontSize: "0.85rem", color: "#1E293B" }}>
                  {activeAssessment.profile?.title || "AI Change Assessment"}
                </span>
                <span className="badge badge-aubergine">Stage: {activeAssessment.stage}</span>
              </div>

              {/* Progress Steps */}
              <div
                style={{
                  display: "flex",
                  gap: "0.25rem",
                  background: "#F1F5F9",
                  padding: "0.35rem",
                  borderRadius: "6px",
                  overflowX: "auto"
                }}
              >
                {STAGES.map((s, idx) => {
                  const currentIdx = STAGES.indexOf(activeAssessment.stage);
                  const isPast = idx <= currentIdx;
                  const isCurrent = idx === currentIdx;
                  return (
                    <div
                      key={s}
                      style={{
                        flex: 1,
                        minWidth: "70px",
                        textAlign: "center",
                        padding: "0.3rem 0.2rem",
                        borderRadius: "4px",
                        fontSize: "0.65rem",
                        fontWeight: isCurrent ? 700 : 500,
                        background: isCurrent ? "var(--coral)" : isPast ? "#0D9488" : "#E2E8F0",
                        color: isPast ? "#FFFFFF" : "#64748B"
                      }}
                    >
                      {s}
                    </div>
                  );
                })}
              </div>

              {/* Stage Transition Control Panel */}
              <div
                style={{
                  marginTop: "1rem",
                  padding: "0.75rem",
                  background: "#F8FAFC",
                  border: "1px solid #E2E8F0",
                  borderRadius: "6px"
                }}
              >
                <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "#475569", marginBottom: "0.4rem" }}>
                  Next Stage Guard Requirements:
                </div>
                {activeAssessment.stage === "REGISTERED" && (
                  <button
                    type="button"
                    onClick={() => handleAdvanceStage("BASELINE")}
                    disabled={loading}
                    className="btn btn-primary btn-sm"
                  >
                    Advance to BASELINE
                  </button>
                )}
                {activeAssessment.stage === "BASELINE" && (
                  <button
                    type="button"
                    onClick={() => handleAdvanceStage("DETECT")}
                    disabled={loading}
                    className="btn btn-primary btn-sm"
                  >
                    Advance to DETECT (Pin Baseline Release)
                  </button>
                )}
                {activeAssessment.stage === "DETECT" && (
                  <button
                    type="button"
                    onClick={() => handleAdvanceStage("ATTRIBUTE")}
                    disabled={loading}
                    className="btn btn-primary btn-sm"
                  >
                    Advance to ATTRIBUTE (Link Authoritative Hazard)
                  </button>
                )}
                {activeAssessment.stage === "ATTRIBUTE" && (
                  <button
                    type="button"
                    onClick={() => handleAdvanceStage("CONTROL")}
                    disabled={loading}
                    className="btn btn-primary btn-sm"
                  >
                    Advance to CONTROL (Requires Accepted Cause)
                  </button>
                )}
                {activeAssessment.stage === "CONTROL" && (
                  <button
                    type="button"
                    onClick={() => handleAdvanceStage("VERIFY")}
                    disabled={loading}
                    className="btn btn-primary btn-sm"
                  >
                    Advance to VERIFY (Requires Implemented Control)
                  </button>
                )}
                {activeAssessment.stage === "VERIFY" && (
                  <button
                    type="button"
                    onClick={() => handleAdvanceStage("PERFORMANCE_REVIEW")}
                    disabled={loading}
                    className="btn btn-primary btn-sm"
                  >
                    Advance to PERFORMANCE_REVIEW
                  </button>
                )}
                {activeAssessment.stage === "PERFORMANCE_REVIEW" && (
                  <button
                    type="button"
                    onClick={() => handleAdvanceStage("CLOSED")}
                    disabled={loading}
                    className="btn btn-primary btn-sm"
                  >
                    Close Assessment (Enforces All Hazards Controlled)
                  </button>
                )}
                {activeAssessment.stage === "CLOSED" && (
                  <div style={{ color: "#059669", fontWeight: 600, fontSize: "0.8rem" }}>
                    ✔ Assessment Fully Verified and Closed.
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: "0.8rem", color: "#64748B", marginBottom: "1rem" }}>
              No active AI Work-Design Assessment. Create a profile below to initialize.
            </div>
          )}

          {/* Create New AI Change Profile */}
          <div style={{ borderTop: "1px solid #E2E8F0", paddingTop: "1rem" }}>
            <h5 style={{ fontSize: "0.85rem", color: "var(--graphite)", marginBottom: "0.75rem" }}>
              Register New AI Change Profile
            </h5>

            <div className="form-group" style={{ marginBottom: "0.5rem" }}>
              <label className="form-label">System / Agent Title</label>
              <input
                type="text"
                value={profileTitle}
                onChange={e => setProfileTitle(e.target.value)}
                className="text-control"
                style={{ width: "100%" }}
              />
            </div>

            <div className="resp-grid-2" style={{ gap: "0.5rem", marginBottom: "0.5rem" }}>
              <div className="form-group">
                <label className="form-label">Affected Roles</label>
                <input
                  type="text"
                  value={affectedRoles}
                  onChange={e => setAffectedRoles(e.target.value)}
                  className="text-control"
                  style={{ width: "100%" }}
                  placeholder="Associate, Paralegal"
                />
              </div>

              <div className="form-group">
                <label className="form-label">Automation Mode</label>
                <select
                  value={automationMode}
                  onChange={e => setAutomationMode(e.target.value as any)}
                  className="select-control"
                  style={{ width: "100%" }}
                >
                  <option value="ASSIST">ASSIST (Human Active)</option>
                  <option value="AUTOMATE_WITH_REVIEW">AUTOMATE_WITH_REVIEW</option>
                  <option value="AUTONOMOUS_BOUNDED">AUTONOMOUS_BOUNDED</option>
                </select>
              </div>
            </div>

            <div className="form-group" style={{ marginBottom: "0.75rem" }}>
              <label className="form-label">Affected Tasks</label>
              <input
                type="text"
                value={affectedTasks}
                onChange={e => setAffectedTasks(e.target.value)}
                className="text-control"
                style={{ width: "100%" }}
              />
            </div>

            <div className="form-group" style={{ marginBottom: "0.75rem" }}>
              <label className="form-label">Decision Rights Boundary</label>
              <input
                type="text"
                value={decisionRights}
                onChange={e => setDecisionRights(e.target.value)}
                className="text-control"
                style={{ width: "100%" }}
              />
            </div>

            <button
              type="button"
              onClick={handleCreateAiChange}
              disabled={loading}
              className="btn btn-primary btn-sm"
              style={{ width: "100%" }}
            >
              + Register AI Profile & Start 8-Stage Assessment
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

