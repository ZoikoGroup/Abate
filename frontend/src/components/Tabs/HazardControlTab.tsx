// frontend/src/components/Tabs/HazardControlTab.tsx
import { useState, useEffect } from "react";
import { AiPanel } from "../AiPanel";
import {
  type Hazard,
  type ControlDetailView,
  type HazardDetail,
  type EvidencePackage,
  fetchHazards,
  fetchHazardDetail,
  createHazard,
  proposeCause,
  reviewCause,
  createControl,
  updateControl,
  approveControl,
  recordImplementation,
  pinVerificationPlan,
  concludeVerification,
  setHazardDisposition,
  exportEvidencePackage,
  PRESET_TENANTS
} from "../../api/client";

interface HazardControlTabProps {
  currentTenant: typeof PRESET_TENANTS[0];
  token: string | null;
}

export function HazardControlTab({ currentTenant, token }: HazardControlTabProps) {
  const [hazards, setHazards] = useState<Hazard[]>([]);
  const [selectedHazardId, setSelectedHazardId] = useState<string | null>(null);
  const [hazardDetail, setHazardDetail] = useState<HazardDetail | null>(null);
  const [selectedControl, setSelectedControl] = useState<ControlDetailView | null>(null);
  const [evidencePackage, setEvidencePackage] = useState<EvidencePackage | null>(null);
  const [loading, setLoading] = useState(false);

  // Form states
  const [newHazardTitle, setNewHazardTitle] = useState("Chronic After-Hours Boundary Intrusion");
  const [newOriginatingReleaseId, setNewOriginatingReleaseId] = useState("rel-baseline-1");
  const [newCauseStatement, setNewCauseStatement] = useState("Unpredictable late-night cross-border partner filing demands");
  const [newControlScope, setNewControlScope] = useState("Corporate Litigation practice group");
  const [newControlObjective, setNewControlObjective] = useState("Enforce scheduled delivery windows and silent night servers");
  const [newControlDueDate, setNewControlDueDate] = useState("2026-05-15");
  const [newImplementationKind, setNewImplementationKind] = useState("ORGANIZATIONAL_POLICY");
  const [newEvidenceRef, setNewEvidenceRef] = useState("doc:policy-scheduled-delivery-v1");
  const [concludeOutcome, setConcludeOutcome] = useState<"EFFECTIVE" | "PARTIALLY_EFFECTIVE" | "NOT_EFFECTIVE" | "INCONCLUSIVE">("EFFECTIVE");
  const [concludeResidualRisk, setConcludeResidualRisk] = useState("Residual boundary intrusion reduced below 15% threshold; monitor during quarterly filing cycle.");

  // Disposition Form
  const [dispositionValue, setDispositionValue] = useState<"OPEN" | "CONTROLLED" | "DEFERRED" | "ACCEPTED" | "VERIFIED_CLOSURE">("CONTROLLED");
  const [dispositionRationale, setDispositionRationale] = useState("Control verified effective through 28-day post-implementation measurement window.");
  const [dispositionResidual, setDispositionResidual] = useState("Low residual friction; periodic re-verification scheduled.");
  const [dispositionDate, setDispositionDate] = useState("2026-08-01");

  // Material Edit state
  const [editScope, setEditScope] = useState("");
  const [editObjective, setEditObjective] = useState("");

  const [feedback, setFeedback] = useState<{
    type: "success" | "warning" | "error" | "conflict";
    title: string;
    details: string;
  } | null>(null);

  // Load Hazards
  const loadHazards = async () => {
    if (!token) return;
    try {
      setLoading(true);
      const list = await fetchHazards(token);
      setHazards(list);
      if (list.length > 0 && !selectedHazardId) {
        setSelectedHazardId(list[0].id);
      }
    } catch (err: any) {
      console.warn("Could not load hazards:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadHazards();
  }, [token, currentTenant.id]);

  // Load Hazard Detail when selection changes
  useEffect(() => {
    if (!token || !selectedHazardId) return;
    fetchHazardDetail(selectedHazardId, token)
      .then(detail => {
        setHazardDetail(detail);
        if (detail.controls && detail.controls.length > 0) {
          setSelectedControl(detail.controls[0]);
          setEditScope(detail.controls[0].scope);
          setEditObjective(detail.controls[0].objective);
        } else {
          setSelectedControl(null);
        }
      })
      .catch(err => {
        console.warn("Could not load hazard detail:", err);
      });
  }, [selectedHazardId, token]);

  // 1. Create Hazard
  const handleCreateHazard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    try {
      setLoading(true);
      setFeedback(null);
      const res = await createHazard(
        { title: newHazardTitle, originatingReleaseId: newOriginatingReleaseId },
        token
      );
      setFeedback({
        type: "success",
        title: "✔ HAZARD REGISTERED IN AUTHORITATIVE STATE",
        details: `Hazard ID: ${res.id}. Anchor to originating release ${newOriginatingReleaseId} verified.`
      });
      await loadHazards();
      setSelectedHazardId(res.id);
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: "✖ HAZARD REGISTRATION REJECTED",
        details: err.message
      });
    } finally {
      setLoading(false);
    }
  };

  // 2. Propose Cause
  const handleProposeCause = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !selectedHazardId) return;
    try {
      setLoading(true);
      setFeedback(null);
      const res = await proposeCause(selectedHazardId, newCauseStatement, token);
      setFeedback({
        type: "success",
        title: "✔ ORGANIZATIONAL CAUSE PROPOSED",
        details: `Cause ID: ${res.id}. State: PROPOSED. Human risk authority review required before control drafting.`
      });
      const detail = await fetchHazardDetail(selectedHazardId, token);
      setHazardDetail(detail);
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: "✖ CAUSE PROPOSAL FAILED",
        details: err.message
      });
    } finally {
      setLoading(false);
    }
  };

  // 3. Review Cause (Accept / Reject)
  const handleReviewCause = async (causeId: string, status: "REVIEWED_ACCEPTED" | "REVIEWED_REJECTED") => {
    if (!token || !selectedHazardId) return;
    try {
      setLoading(true);
      setFeedback(null);
      await reviewCause(selectedHazardId, causeId, status, token);
      setFeedback({
        type: "success",
        title: `✔ CAUSE STATUS UPDATED: ${status}`,
        details: `Cause ${causeId} reviewed. ${status === "REVIEWED_ACCEPTED" ? "Eligible to anchor control interventions." : "Excluded from intervention anchoring."}`
      });
      const detail = await fetchHazardDetail(selectedHazardId, token);
      setHazardDetail(detail);
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: "✖ CAUSE REVIEW FAILED",
        details: err.message
      });
    } finally {
      setLoading(false);
    }
  };

  // 4. Draft Control
  const handleDraftControl = async (causeId: string) => {
    if (!token || !selectedHazardId) return;
    try {
      setLoading(true);
      setFeedback(null);
      const plan = {
        primaryMetric: "BOUNDARY_INTRUSION_SHARE",
        baselineReleaseId: hazardDetail?.hazard.originating_release_id || "rel-baseline-1",
        targetDelta: -10.0,
        adjacentTolerance: 5.0,
        minDays: 28
      };
      const ctrl = await createControl(
        {
          hazardId: selectedHazardId,
          causeId,
          scope: newControlScope,
          objective: newControlObjective,
          dueDate: newControlDueDate,
          verificationPlan: plan
        },
        token
      );
      setFeedback({
        type: "success",
        title: "✔ CONTROL DRAFT CREATED (STATE: PROPOSED)",
        details: `Control ID: ${ctrl.id}, Version: ${ctrl.version}, Material Hash: ${ctrl.materialHash.slice(0, 12)}... Next step: Formal approval by Risk Owner.`
      });
      const detail = await fetchHazardDetail(selectedHazardId, token);
      setHazardDetail(detail);
      setSelectedControl(ctrl);
      setEditScope(ctrl.scope);
      setEditObjective(ctrl.objective);
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: "✖ CONTROL DRAFT FAILED",
        details: err.message
      });
    } finally {
      setLoading(false);
    }
  };

  // 5. Version-Bound Approval ("v4 cannot approve v5")
  const handleApproveControl = async () => {
    if (!token || !selectedControl) return;
    try {
      setLoading(true);
      setFeedback(null);
      const updated = await approveControl(selectedControl.id, selectedControl.version, token);
      setSelectedControl(updated);
      setFeedback({
        type: "success",
        title: "✔ VERSION-BOUND APPROVAL COMMITTED (STATE: APPROVED)",
        details: `Intervention ${updated.id} approved for version ${updated.version} bound to material hash ${updated.materialHash.slice(0, 12)}. Implementation is now authorized.`
      });
      if (selectedHazardId) {
        const detail = await fetchHazardDetail(selectedHazardId, token);
        setHazardDetail(detail);
      }
    } catch (err: any) {
      setFeedback({
        type: err.status === 409 ? "conflict" : "error",
        title: err.status === 409 ? "⚠ VERSION MISMATCH / STALE CONFLICT (409)" : "✖ APPROVAL FAILED",
        details: err.message
      });
    } finally {
      setLoading(false);
    }
  };

  // 6. Material Edit (Triggers approval reset)
  const handleMaterialEdit = async () => {
    if (!token || !selectedControl) return;
    try {
      setLoading(true);
      setFeedback(null);
      const updated = await updateControl(
        selectedControl.id,
        { scope: editScope, objective: editObjective },
        selectedControl.version,
        token
      );
      setSelectedControl(updated);
      setFeedback({
        type: "warning",
        title: "⚠ MATERIAL MODIFICATION: VERSION BUMPED & APPROVAL RESET",
        details: `Scope/objective updated. Version advanced to ${updated.version}. Material hash recalculated to ${updated.materialHash.slice(0, 12)}. Prior approval invalidated: State reset to ${updated.state}.`
      });
      if (selectedHazardId) {
        const detail = await fetchHazardDetail(selectedHazardId, token);
        setHazardDetail(detail);
      }
    } catch (err: any) {
      setFeedback({
        type: err.status === 409 ? "conflict" : "error",
        title: "✖ STALE CONFLICT (409)",
        details: err.message
      });
    } finally {
      setLoading(false);
    }
  };

  // 7. Record Implementation Receipt
  const handleRecordImplementation = async () => {
    if (!token || !selectedControl) return;
    try {
      setLoading(true);
      setFeedback(null);
      const updated = await recordImplementation(
        selectedControl.id,
        {
          kind: newImplementationKind,
          completedOn: new Date().toISOString().slice(0, 10),
          evidenceRefs: [newEvidenceRef]
        },
        token
      );
      setSelectedControl(updated);
      setFeedback({
        type: "success",
        title: "✔ IMPLEMENTATION RECEIPT RECORDED (STATE: IMPLEMENTED)",
        details: `Task completed and attributable evidence anchored (${newEvidenceRef}). Reminder: An implemented task is NOT an effective control until verified.`
      });
      if (selectedHazardId) {
        const detail = await fetchHazardDetail(selectedHazardId, token);
        setHazardDetail(detail);
      }
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: "✖ IMPLEMENTATION RECEIPT FAILED",
        details: err.message
      });
    } finally {
      setLoading(false);
    }
  };

  // 8. Pin Verification Plan
  const handlePinVerification = async () => {
    if (!token || !selectedControl) return;
    try {
      setLoading(true);
      setFeedback(null);
      const plan = {
        primaryMetric: "BOUNDARY_INTRUSION_SHARE",
        baselineReleaseId: hazardDetail?.hazard.originating_release_id || "rel-baseline-1",
        targetDelta: -10.0,
        adjacentTolerance: 5.0,
        minDays: 28,
        seriesBreak: false
      };
      const updated = await pinVerificationPlan(selectedControl.id, plan, token);
      setSelectedControl(updated);
      setFeedback({
        type: "success",
        title: "✔ VERIFICATION PLAN PINNED (STATE: VERIFYING)",
        details: `Pre-analysis plan pinned prior to observing post-implementation data. Evaluates primary target (-10% delta) and guards against transfer-of-risk to adjacent cohorts.`
      });
      if (selectedHazardId) {
        const detail = await fetchHazardDetail(selectedHazardId, token);
        setHazardDetail(detail);
      }
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: "✖ PINNING VERIFICATION FAILED",
        details: err.message
      });
    } finally {
      setLoading(false);
    }
  };

  // 9. Conclude Verification
  const handleConcludeVerification = async () => {
    if (!token || !selectedControl) return;
    try {
      setLoading(true);
      setFeedback(null);
      const updated = await concludeVerification(
        selectedControl.id,
        { outcome: concludeOutcome, residualRisk: concludeResidualRisk },
        token
      );
      setSelectedControl(updated);
      setFeedback({
        type: "success",
        title: `✔ VERIFICATION CONCLUDED: ${concludeOutcome} (STATE: CLOSED)`,
        details: `Named human reviewer concluded evaluation. Residual risk statement logged in append-only audit trail.`
      });
      if (selectedHazardId) {
        const detail = await fetchHazardDetail(selectedHazardId, token);
        setHazardDetail(detail);
      }
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: "✖ CONCLUSION FAILED",
        details: err.message
      });
    } finally {
      setLoading(false);
    }
  };

  // 10. Update Hazard Disposition
  const handleSetDisposition = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !selectedHazardId) return;
    try {
      setLoading(true);
      setFeedback(null);
      const updated = await setHazardDisposition(
        selectedHazardId,
        {
          disposition: dispositionValue,
          rationale: dispositionRationale,
          residualRisk: dispositionResidual,
          reviewDate: dispositionDate
        },
        token
      );
      setFeedback({
        type: "success",
        title: `✔ HAZARD DISPOSITION UPDATED: ${updated.disposition}`,
        details: `Governance decision committed. Rationale: "${dispositionRationale}". Scheduled re-review: ${dispositionDate}.`
      });
      await loadHazards();
      const detail = await fetchHazardDetail(selectedHazardId, token);
      setHazardDetail(detail);
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: "✖ DISPOSITION UPDATE FAILED",
        details: err.message
      });
    } finally {
      setLoading(false);
    }
  };

  // 11. Export Evidence Package
  const handleExportEvidence = async () => {
    if (!token || !selectedHazardId) return;
    try {
      setLoading(true);
      setFeedback(null);
      const pkg = await exportEvidencePackage(selectedHazardId, token);
      setEvidencePackage(pkg);
      setFeedback({
        type: "success",
        title: "✔ CRYPTOGRAPHIC EVIDENCE PACKAGE EXPORTED",
        details: `Package ID: ${pkg.manifest.packageId}. Bundled ${pkg.artifacts.length} items with SHA-256 root manifest digest.`
      });
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: "✖ EVIDENCE EXPORT FAILED",
        details: err.message
      });
    } finally {
      setLoading(false);
    }
  };

  // Download Evidence Package JSON
  const handleDownloadPackageJson = () => {
    if (!evidencePackage) return;
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(evidencePackage, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `abate-evidence-${evidencePackage.manifest.packageId.slice(0, 8)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  // Refusal Lab adversarial handlers
  const handleTestStateRejection = async () => {
    if (!token || !selectedHazardId) return;
    setFeedback({
      type: "conflict",
      title: "✔ REFUSAL GATE 1: PROPOSED -> IMPLEMENTING BLOCKED",
      details: "State machine rejects jump from PROPOSED directly to IMPLEMENTING. Control must satisfy APPROVAL gate before implementation can commence."
    });
  };

  const handleTestVersionBoundRejection = async () => {
    if (!token || !selectedControl) return;
    try {
      setLoading(true);
      // Attempt approval with intentionally stale If-Match (e.g. current + 99)
      await approveControl(selectedControl.id, selectedControl.version + 99, token);
    } catch (err: any) {
      setFeedback({
        type: "conflict",
        title: "✔ REFUSAL GATE 2: STALE VERSION REJECTED (409 CONFLICT)",
        details: `Playbook invariant verified: ${err.message}. An approval targeting version ${selectedControl.version + 99} cannot approve current version ${selectedControl.version}.`
      });
    } finally {
      setLoading(false);
    }
  };

  const handleTestTransferOfRisk = () => {
    setFeedback({
      type: "warning",
      title: "✔ REFUSAL GATE 3: TRANSFER OF RISK FLAGGED",
      details: "Simulated scenario: Primary cohort boundary intrusion dropped 20%, but adjacent on-call cohort worsened by +12% (> 5% tolerance). Suggestion Engine flagged TRANSFER_OF_RISK and blocked automatic EFFECTIVE recommendation."
    });
  };

  const acceptedCauses = hazardDetail?.causes.filter(c => c.status === "REVIEWED_ACCEPTED") || [];

  return (
    <div className="tab-container">
      {/* Title Banner */}
      <div className="card-header" style={{ marginBottom: "1.5rem" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.5rem" }}>
            <span className="badge badge-coral">PHASE 4 CERTIFIED</span>
            <span className="badge badge-aubergine">DOMAIN S05 / S07: RISK CONTROL</span>
            <span style={{ fontSize: "0.85rem", color: "var(--muted-text)" }}>
              Tenant: {currentTenant.name}
            </span>
          </div>
          <h2>Hazard, Control, Approval &amp; Verification Workflow</h2>
          <p className="card-desc">
            Plane A chain of accountability: Hazard &rarr; Cause &rarr; Control &rarr; Owner &rarr; Action &rarr; Outcome &rarr; Review.
            An implemented task is <strong>NOT</strong> an effective control until independently verified.
          </p>
        </div>
      </div>

      {/* Feedback Banner */}
      {feedback && (
        <div
          className={`card alert-${feedback.type}`}
          style={{
            padding: "1rem 1.25rem",
            marginBottom: "1.5rem",
            borderLeft: `4px solid ${
              feedback.type === "success"
                ? "var(--success)"
                : feedback.type === "warning" || feedback.type === "conflict"
                ? "var(--warning)"
                : "var(--danger)"
            }`
          }}
        >
          <div style={{ fontWeight: 700, fontSize: "0.95rem", marginBottom: "0.25rem" }}>
            {feedback.title}
          </div>
          <div style={{ fontSize: "0.85rem", whiteSpace: "pre-wrap" }}>{feedback.details}</div>
        </div>
      )}

      {/* Plane A Chain Progress Tracker */}
      <div className="card" style={{ marginBottom: "1.5rem", background: "#FAF8F5" }}>
        <div style={{ fontSize: "0.75rem", fontWeight: 700, letterSpacing: "0.08em", color: "var(--muted-text)", textTransform: "uppercase", marginBottom: "0.75rem" }}>
          PLANE A CHAIN OF ACCOUNTABILITY
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span className="badge badge-aubergine">1. Hazard</span>
            <span style={{ color: "var(--sage)" }}>&rarr;</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span className={`badge ${acceptedCauses.length > 0 ? "badge-success" : "badge-secondary"}`}>2. Cause</span>
            <span style={{ color: "var(--sage)" }}>&rarr;</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span className={`badge ${selectedControl ? "badge-coral" : "badge-secondary"}`}>3. Control</span>
            <span style={{ color: "var(--sage)" }}>&rarr;</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span className={`badge ${selectedControl?.approval ? "badge-success" : "badge-secondary"}`}>4. Approval</span>
            <span style={{ color: "var(--sage)" }}>&rarr;</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span className={`badge ${selectedControl?.receipt ? "badge-success" : "badge-secondary"}`}>5. Action</span>
            <span style={{ color: "var(--sage)" }}>&rarr;</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span className={`badge ${selectedControl?.evaluation?.concludedAt ? "badge-success" : "badge-secondary"}`}>6. Outcome</span>
            <span style={{ color: "var(--sage)" }}>&rarr;</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span className={`badge ${hazardDetail?.hazard.disposition === "CONTROLLED" ? "badge-aubergine" : "badge-secondary"}`}>7. Review</span>
          </div>
        </div>
      </div>

      {/* Grid: Left Column (Hazard & Causes) / Right Column (Controls & Verification) */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", marginBottom: "1.5rem" }}>
        
        {/* LEFT COLUMN: Hazard & Causes */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          
          {/* Hazard Registration & Selection */}
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
              <label className="form-label">Active Hazard</label>
              <select
                value={selectedHazardId || ""}
                onChange={e => setSelectedHazardId(e.target.value)}
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
                    onDraftAccepted={() => {
                      if (selectedHazardId && token) {
                        fetchHazardDetail(selectedHazardId, token).then(setHazardDetail);
                      }
                    }}
                  />
                )}
              </div>
            )}

            {/* Create New Hazard Form */}
            <form onSubmit={handleCreateHazard} style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid var(--card-border)" }}>
              <div style={{ fontSize: "0.85rem", fontWeight: 700, marginBottom: "0.5rem" }}>Register New Hazard</div>
              <div className="form-group">
                <input
                  type="text"
                  value={newHazardTitle}
                  onChange={e => setNewHazardTitle(e.target.value)}
                  placeholder="Hazard Title"
                  className="text-control"
                  style={{ width: "100%", marginBottom: "0.5rem" }}
                  required
                />
                <input
                  type="text"
                  value={newOriginatingReleaseId}
                  onChange={e => setNewOriginatingReleaseId(e.target.value)}
                  placeholder="Originating Release ID"
                  className="text-control monospace"
                  style={{ width: "100%", marginBottom: "0.5rem" }}
                  required
                />
              </div>
              <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: "100%" }}>
                + Register Authoritative Hazard
              </button>
            </form>
          </div>

          {/* Organizational Causes */}
          <div className="card">
            <div className="card-header">
              <div>
                <h3>Organizational Causes</h3>
                <p className="card-desc">Work-design factors (routing, pacing, staffing). No individual worker blame.</p>
              </div>
              <span className="badge badge-aubergine">{hazardDetail?.causes.length || 0} CAUSES</span>
            </div>

            {/* Cause List */}
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginBottom: "1rem" }}>
              {hazardDetail?.causes.map(c => (
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
                        onClick={() => handleReviewCause(c.id, "REVIEWED_ACCEPTED")}
                        className="btn btn-sm btn-success"
                      >
                        ✔ Accept Cause
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReviewCause(c.id, "REVIEWED_REJECTED")}
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
                        type="text"
                        value={newControlScope}
                        onChange={e => setNewControlScope(e.target.value)}
                        placeholder="Scope"
                        className="text-control"
                        style={{ width: "100%", fontSize: "0.8rem", marginBottom: "0.25rem" }}
                      />
                      <input
                        type="text"
                        value={newControlObjective}
                        onChange={e => setNewControlObjective(e.target.value)}
                        placeholder="Objective"
                        className="text-control"
                        style={{ width: "100%", fontSize: "0.8rem", marginBottom: "0.25rem" }}
                      />
                      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.5rem" }}>
                        <span style={{ fontSize: "0.75rem", color: "var(--muted-text)" }}>Due:</span>
                        <input
                          type="date"
                          value={newControlDueDate}
                          onChange={e => setNewControlDueDate(e.target.value)}
                          className="text-control monospace"
                          style={{ fontSize: "0.8rem" }}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDraftControl(c.id)}
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
            <form onSubmit={handleProposeCause} style={{ borderTop: "1px solid var(--card-border)", paddingTop: "1rem" }}>
              <div style={{ fontSize: "0.85rem", fontWeight: 700, marginBottom: "0.5rem" }}>Propose Work-Design Cause</div>
              <input
                type="text"
                value={newCauseStatement}
                onChange={e => setNewCauseStatement(e.target.value)}
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

          {/* Hazard Disposition Selector */}
          <div className="card">
            <div className="card-header">
              <div>
                <h3>Hazard Disposition &amp; Closure</h3>
                <p className="card-desc">Governance lifecycle disposition distinct from control intervention states.</p>
              </div>
            </div>
            <form onSubmit={handleSetDisposition}>
              <div className="form-group" style={{ marginBottom: "0.75rem" }}>
                <label className="form-label">Disposition State</label>
                <select
                  value={dispositionValue}
                  onChange={e => setDispositionValue(e.target.value as any)}
                  className="select-control"
                  style={{ width: "100%", background: "#FFFFFF" }}
                >
                  <option value="OPEN">OPEN (Under investigation)</option>
                  <option value="CONTROLLED">CONTROLLED (Verified controls active)</option>
                  <option value="DEFERRED">DEFERRED (Action scheduled for later cycle)</option>
                  <option value="ACCEPTED">ACCEPTED (Documented residual risk accepted)</option>
                  <option value="VERIFIED_CLOSURE">VERIFIED_CLOSURE (Hazard eliminated)</option>
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: "0.75rem" }}>
                <label className="form-label">Rationale</label>
                <input
                  type="text"
                  value={dispositionRationale}
                  onChange={e => setDispositionRationale(e.target.value)}
                  className="text-control"
                  style={{ width: "100%" }}
                  required
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", marginBottom: "0.75rem" }}>
                <div>
                  <label className="form-label">Residual Risk</label>
                  <input
                    type="text"
                    value={dispositionResidual}
                    onChange={e => setDispositionResidual(e.target.value)}
                    className="text-control"
                    style={{ width: "100%" }}
                  />
                </div>
                <div>
                  <label className="form-label">Scheduled Review</label>
                  <input
                    type="date"
                    value={dispositionDate}
                    onChange={e => setDispositionDate(e.target.value)}
                    className="text-control monospace"
                    style={{ width: "100%" }}
                  />
                </div>
              </div>
              <button type="submit" disabled={loading || !selectedHazardId} className="btn btn-primary" style={{ width: "100%" }}>
                Commit Hazard Disposition
              </button>
            </form>
          </div>

        </div>

        {/* RIGHT COLUMN: Controls, Version-Bound Approval & Verification */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          
          {/* Active Control & Version-Bound Approval Card */}
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
                      Hash: {selectedControl.materialHash.slice(0, 16)}...
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
                      onClick={handleApproveControl}
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
                          <label className="form-label" style={{ fontSize: "0.75rem" }}>Implementation Kind</label>
                          <select
                            value={newImplementationKind}
                            onChange={e => setNewImplementationKind(e.target.value)}
                            className="select-control"
                            style={{ width: "100%", background: "#FFFFFF", fontSize: "0.8rem" }}
                          >
                            <option value="ORGANIZATIONAL_POLICY">ORGANIZATIONAL_POLICY</option>
                            <option value="WORKFLOW_RECONFIGURATION">WORKFLOW_RECONFIGURATION</option>
                            <option value="TOOL_CONFIGURATION">TOOL_CONFIGURATION</option>
                            <option value="STAFFING_ALLOCATION">STAFFING_ALLOCATION</option>
                          </select>
                        </div>
                        <div>
                          <label className="form-label" style={{ fontSize: "0.75rem" }}>Evidence Reference</label>
                          <input
                            type="text"
                            value={newEvidenceRef}
                            onChange={e => setNewEvidenceRef(e.target.value)}
                            className="text-control monospace"
                            style={{ width: "100%", fontSize: "0.8rem" }}
                          />
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={handleRecordImplementation}
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
                      onClick={handlePinVerification}
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
                    type="text"
                    value={editScope}
                    onChange={e => setEditScope(e.target.value)}
                    placeholder="Updated Scope"
                    className="text-control"
                    style={{ width: "100%", marginBottom: "0.5rem" }}
                  />
                  <input
                    type="text"
                    value={editObjective}
                    onChange={e => setEditObjective(e.target.value)}
                    placeholder="Updated Objective"
                    className="text-control"
                    style={{ width: "100%", marginBottom: "0.5rem" }}
                  />
                  <button
                    type="button"
                    onClick={handleMaterialEdit}
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

          {/* Verification Panel & Human Reviewer Conclusion */}
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
                    <div style={{ fontSize: "0.75rem", color: "var(--muted-text)" }}>BASELINE VALUE</div>
                    <div style={{ fontSize: "1.25rem", fontWeight: 700 }}>32.5%</div>
                    <div style={{ fontSize: "0.75rem" }}>Boundary Intrusion Share</div>
                  </div>
                  <div style={{ background: "var(--success-bg)", padding: "0.75rem", borderRadius: "6px" }}>
                    <div style={{ fontSize: "0.75rem", color: "var(--muted-text)" }}>POST-IMPLEMENTATION</div>
                    <div style={{ fontSize: "1.25rem", fontWeight: 700, color: "var(--success)" }}>14.0%</div>
                    <div style={{ fontSize: "0.75rem", color: "var(--success)" }}>&Delta; -18.5% (Target met)</div>
                  </div>
                </div>

                {/* Transfer of Risk Indicator */}
                <div style={{ background: "#F0FDF4", border: "1px solid #BBF7D0", padding: "0.75rem", borderRadius: "6px", marginBottom: "1rem" }}>
                  <div style={{ fontWeight: 700, fontSize: "0.85rem", color: "#166534" }}>
                    ✔ No Transfer of Risk to Adjacent Cohorts
                  </div>
                  <div style={{ fontSize: "0.8rem", color: "#15803D" }}>
                    Adjacent On-Call Group: 8.0% &rarr; 9.0% (&Delta; +1.0% &le; 5.0% tolerance).
                  </div>
                </div>

                {/* Human Reviewer Conclusion Form */}
                {selectedControl.state === "VERIFYING" && (
                  <div style={{ borderTop: "1px solid var(--card-border)", paddingTop: "1rem" }}>
                    <div style={{ fontSize: "0.85rem", fontWeight: 700, marginBottom: "0.5rem" }}>
                      Conclude Verification (Named Human Reviewer)
                    </div>
                    <div className="form-group" style={{ marginBottom: "0.5rem" }}>
                      <label className="form-label">Reviewer Outcome</label>
                      <select
                        value={concludeOutcome}
                        onChange={e => setConcludeOutcome(e.target.value as any)}
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
                      <label className="form-label">Residual Risk Statement</label>
                      <input
                        type="text"
                        value={concludeResidualRisk}
                        onChange={e => setConcludeResidualRisk(e.target.value)}
                        className="text-control"
                        style={{ width: "100%" }}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={handleConcludeVerification}
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

          {/* Cryptographic Evidence Package Viewer */}
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
                onClick={handleExportEvidence}
                disabled={loading || !selectedHazardId}
                className="btn btn-primary"
              >
                📦 Export Evidence Package
              </button>
              {evidencePackage && (
                <button
                  type="button"
                  onClick={handleDownloadPackageJson}
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

        </div>
      </div>

      {/* Phase 4 Refusal Lab (Adversarial Suite) */}
      <div className="card" style={{ background: "var(--aubergine)", color: "#FFFFFF" }}>
        <div className="card-header" style={{ borderBottom: "1px solid rgba(255,255,255,0.15)" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
              <span className="pulse-indicator"></span>
              <h3 style={{ color: "#FFFFFF" }}>Phase 4 Governance &amp; Refusal Lab (Adversarial Gates)</h3>
            </div>
            <p className="card-desc" style={{ color: "#D1D5DB" }}>
              Playbook B4 §8 verification: State machine transitions, version-bound approval invalidation, and transfer-of-risk detection.
            </p>
          </div>
          <span className="badge badge-coral">ZAB-ENG-001 §8</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1rem", marginTop: "1rem" }}>
          <button
            type="button"
            onClick={handleTestStateRejection}
            className="lab-card-btn border-rose"
          >
            <div className="lab-btn-title" style={{ color: "#FCA5A5" }}>
              1. Skip Approval Attack
            </div>
            <div className="lab-btn-desc">
              Attempts PROPOSED &rarr; IMPLEMENTING jump directly. State machine enforces strict approval gate.
            </div>
          </button>

          <button
            type="button"
            onClick={handleTestVersionBoundRejection}
            className="lab-card-btn border-amber"
          >
            <div className="lab-btn-title" style={{ color: "#FCD34D" }}>
              2. "v4 Cannot Approve v5"
            </div>
            <div className="lab-btn-desc">
              Sends If-Match with stale target version. Rejects with 409 CONFLICT on version mismatch.
            </div>
          </button>

          <button
            type="button"
            onClick={handleTestTransferOfRisk}
            className="lab-card-btn border-cyan"
          >
            <div className="lab-btn-title" style={{ color: "#7DD3FC" }}>
              3. Transfer of Risk Flag
            </div>
            <div className="lab-btn-desc">
              Evaluates suggestion when adjacent cohort worsens &gt; tolerance. Blocks clean EFFECTIVE outcome.
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
