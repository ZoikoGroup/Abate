// frontend/src/components/Tabs/HazardControlTab.tsx
import { useState, useEffect } from "react";
import {
  ApiError,
  type Hazard,
  type ControlDetailView,
  type HazardDetail,
  type EvidencePackage,
  fetchHazards,
  fetchHazardDetail,
  fetchRelease,
  queryRelease,
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
  fetchSectorWorkItems,
  checkSectorFatigue,
  type SectorWorkItemView,
  type SectorFatigueAssessmentView,
  type TenantSectorProfile,
  PRESET_TENANTS,
  BASELINE_RELEASE_ID
} from "../../api/client";
import { getSectorUi, getSectorVocabulary, isSectorPackActive, labelFor } from "../../utils/vocabulary";
import { StateView } from "../StateView";
import { HazardWorkspaceCard } from "./hazards/HazardWorkspaceCard";
import { HazardCausesCard } from "./hazards/HazardCausesCard";
import { HazardControlLifecycleCard } from "./hazards/HazardControlLifecycleCard";
import { HazardVerificationCard, type VerificationOutcome } from "./hazards/HazardVerificationCard";
import { HazardEvidenceExportCard } from "./hazards/HazardEvidenceExportCard";
import { HazardRefusalLabCard } from "./hazards/HazardRefusalLabCard";

function fmtHazardErr(err: unknown): string {
  if (err instanceof ApiError) {
    return `${err.message} (Request ID: ${err.requestId})`;
  }
  return err instanceof Error ? err.message : "Operation failed.";
}

interface HazardControlTabProps {
  currentTenant: typeof PRESET_TENANTS[0];
  token: string | null;
  sectorProfile?: TenantSectorProfile | null;
}

export function HazardControlTab({ currentTenant, token, sectorProfile }: HazardControlTabProps) {
  const sectorPackActive = isSectorPackActive(sectorProfile);
  const sectorUi = getSectorUi(sectorProfile);
  const sectorWorkItemsUpper = getSectorVocabulary(sectorProfile).workItems.toUpperCase();
  const [hazards, setHazards] = useState<Hazard[]>([]);
  const [selectedHazardId, setSelectedHazardId] = useState<string | null>(null);
  const [hazardDetail, setHazardDetail] = useState<HazardDetail | null>(null);
  const [selectedControl, setSelectedControl] = useState<ControlDetailView | null>(null);
  const [evidencePackage, setEvidencePackage] = useState<EvidencePackage | null>(null);
  const [loading, setLoading] = useState(false);

  // Form states
  const [newHazardTitle, setNewHazardTitle] = useState("Chronic After-Hours Boundary Intrusion");
  const [newOriginatingReleaseId, setNewOriginatingReleaseId] = useState(BASELINE_RELEASE_ID);
  const [newCauseStatement, setNewCauseStatement] = useState("Unbuffered late-evening escalations during high-demand periods");
  const [newControlScope, setNewControlScope] = useState("Affected Delivery Unit / Cohort");
  const [newControlObjective, setNewControlObjective] = useState("Enforce scheduled delivery windows and silent night servers");
  const [newControlDueDate, setNewControlDueDate] = useState("2026-05-15");
  const [newImplementationKind, setNewImplementationKind] = useState("MANUAL");
  const [newEvidenceRef, setNewEvidenceRef] = useState("doc:policy-scheduled-delivery-v1");
  const [concludeOutcome, setConcludeOutcome] = useState<VerificationOutcome>("EFFECTIVE");
  const [concludeResidualRisk, setConcludeResidualRisk] = useState("Residual boundary intrusion reduced below 15% threshold; monitor during quarterly filing cycle.");

  // Disposition Form
  const [dispositionValue, setDispositionValue] = useState<"OPEN" | "CONTROLLED" | "DEFERRED" | "ACCEPTED" | "VERIFIED_CLOSURE">("CONTROLLED");
  const [dispositionRationale, setDispositionRationale] = useState("Control verified effective through 28-day post-implementation measurement window.");
  const [dispositionResidual, setDispositionResidual] = useState("Low residual friction; periodic re-verification scheduled.");
  const [dispositionDate, setDispositionDate] = useState("2026-08-01");

  // Material Edit state
  const [editScope, setEditScope] = useState("");
  const [editObjective, setEditObjective] = useState("");

  // Sector pack state: work items and the fatigue assessment for the active sector
  const [sectorItems, setSectorItems] = useState<SectorWorkItemView[]>([]);
  const [selectedItemRef, setSelectedItemRef] = useState<string | null>(null);
  const [fatigueAssessment, setFatigueAssessment] = useState<SectorFatigueAssessmentView | null>(null);

  const [feedback, setFeedback] = useState<{
    type: "success" | "warning" | "error" | "conflict";
    title: string;
    details: string;
  } | null>(null);

  const handleSelectItem = async (externalRef: string) => {
    setSelectedItemRef(externalRef);
    if (!token) return;
    try {
      setLoading(true);
      const assessment = await checkSectorFatigue(externalRef, token);
      setFatigueAssessment(assessment);
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        title: "✖ FATIGUE ASSESSMENT FAILED",
        details: fmtHazardErr(err)
      });
    } finally {
      setLoading(false);
    }
  };

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
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        title: "✖ FAILED TO LOAD HAZARDS",
        details: fmtHazardErr(err)
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void fetchHazards(token)
      .then((list) => {
        if (cancelled) return;
        setHazards(list);
        if (list.length > 0) {
          setSelectedHazardId((prev) => prev || list[0].id);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFeedback({
          type: "error",
          title: "✖ FAILED TO LOAD HAZARDS",
          details: fmtHazardErr(err)
        });
      });
    if (sectorPackActive) {
      void fetchSectorWorkItems(token)
        .then(async (items) => {
          if (cancelled) return;
          setSectorItems(items);
          if (items.length > 0) {
            const first = items[0];
            setSelectedItemRef(first.externalRef);
            const assessment = await checkSectorFatigue(first.externalRef, token);
            if (!cancelled) setFatigueAssessment(assessment);
          } else {
            setSelectedItemRef(null);
            setFatigueAssessment(null);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setFeedback({
            type: "error",
            title: `✖ FAILED TO LOAD ${sectorWorkItemsUpper}`,
            details: fmtHazardErr(err)
          });
        });
    } else {
      void Promise.resolve().then(() => {
        if (cancelled) return;
        setSectorItems([]);
        setSelectedItemRef(null);
        setFatigueAssessment(null);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [token, currentTenant.id, sectorPackActive, sectorProfile?.sectorKey, sectorWorkItemsUpper]);

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
      .catch((err: unknown) => {
        setFeedback({
          type: "error",
          title: "✖ FAILED TO LOAD HAZARD DETAIL",
          details: fmtHazardErr(err)
        });
      });
  }, [selectedHazardId, token]);

  const ensureValidOriginatingReleaseId = async (candidateId: string): Promise<string> => {
    if (!token || candidateId !== BASELINE_RELEASE_ID) return candidateId;
    try {
      const existing = await fetchRelease(candidateId, token);
      if (existing && existing.status === "RELEASED") {
        return candidateId;
      }
    } catch {
      // Fallback below when the seeded baseline release was superseded (e.g., after metric recalculation)
    }
    const compiled = await queryRelease(
      {
        metricId: "BOUNDARY_INTRUSION_SHARE",
        metricVersion: 1,
        cohortRef: "org:hazard-baseline-recompiled",
        periodStart: "2026-01-01T00:00:00.000Z",
        periodEnd: "2026-02-05T00:00:00.000Z",
        releaseClass: "CLASS_B"
      },
      Array.from({ length: 10 }, (_, i) => `emp-hazard-baseline-${i + 1}`),
      token
    );
    if (compiled.status === "RELEASED") {
      setNewOriginatingReleaseId(compiled.releaseId);
      return compiled.releaseId;
    }
    return candidateId;
  };

  // 1. Create Hazard
  const handleCreateHazard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    try {
      setLoading(true);
      setFeedback(null);
      const originatingReleaseId = await ensureValidOriginatingReleaseId(newOriginatingReleaseId);
      const res = await createHazard(
        { title: newHazardTitle, originatingReleaseId },
        token
      );
      await loadHazards();
      setSelectedHazardId(res.id);
      const detail = await fetchHazardDetail(res.id, token);
      setHazardDetail(detail);
      setFeedback({
        type: "success",
        title: "✔ HAZARD REGISTERED IN AUTHORITATIVE STATE",
        details: `Hazard ID: ${res.id}. Anchor to originating release ${originatingReleaseId} verified.`
      });
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: "✖ HAZARD REGISTRATION REJECTED",
        details: fmtHazardErr(err)
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
        details: fmtHazardErr(err)
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
        details: fmtHazardErr(err)
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
        baselineReleaseId: hazardDetail?.hazard.originating_release_id || BASELINE_RELEASE_ID,
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
        details: fmtHazardErr(err)
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
        details: fmtHazardErr(err)
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
        title: err.status === 409 ? "✖ STALE CONFLICT (409)" : "✖ MATERIAL MODIFICATION FAILED",
        details: fmtHazardErr(err)
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
        details: fmtHazardErr(err)
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
        baselineReleaseId: hazardDetail?.hazard.originating_release_id || BASELINE_RELEASE_ID,
        direction: "DECREASE" as const,
        criteria: 10.0,
        adjacentTolerance: 5.0,
        seriesBreak: false
      };
      const updated = await pinVerificationPlan(selectedControl.id, plan, token);
      setSelectedControl(updated);
      setFeedback({
        type: "success",
        title: "✔ VERIFICATION PLAN PINNED (STATE: VERIFYING)",
        details: `Pre-analysis plan pinned prior to observing post-implementation data. Evaluates 10% target reduction and guards against transfer-of-risk to adjacent cohorts.`
      });
      if (selectedHazardId) {
        const detail = await fetchHazardDetail(selectedHazardId, token);
        setHazardDetail(detail);
      }
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: "✖ PINNING VERIFICATION FAILED",
        details: fmtHazardErr(err)
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
      const postReleaseId =
        selectedControl.verificationPlan?.postReleaseId ||
        selectedControl.verificationPlan?.baselineReleaseId ||
        hazardDetail?.hazard.originating_release_id ||
        BASELINE_RELEASE_ID;
      const updated = await concludeVerification(
        selectedControl.id,
        { outcome: concludeOutcome, residualRisk: concludeResidualRisk, postReleaseId },
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
        details: fmtHazardErr(err)
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
        details: fmtHazardErr(err)
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
        details: fmtHazardErr(err)
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
    try {
      setLoading(true);
      setFeedback(null);

      let targetCtrl = hazardDetail?.controls.find(
        c => c.state === "PROPOSED" || c.state === "APPROVAL_REQUIRED" || c.state === "DRAFT"
      );

      if (!targetCtrl) {
        const firstAccepted = hazardDetail?.causes.find(c => c.status === "REVIEWED_ACCEPTED");
        if (!firstAccepted) {
          setFeedback({
            type: "warning",
            title: "✖ PREREQUISITE MISSING",
            details: "Accept an organizational cause first so the lab can test skipping the approval gate on an unapproved control."
          });
          return;
        }
        targetCtrl = await createControl(
          {
            hazardId: selectedHazardId,
            causeId: firstAccepted.id,
            scope: newControlScope || "Unapproved Skip-Gate Probe",
            objective: newControlObjective || "Verify PROPOSED -> IMPLEMENTING refusal",
            dueDate: newControlDueDate,
            verificationPlan: {
              primaryMetric: "BOUNDARY_INTRUSION_SHARE",
              baselineReleaseId: hazardDetail?.hazard.originating_release_id || BASELINE_RELEASE_ID,
              targetDelta: -10.0,
              adjacentTolerance: 5.0,
              minDays: 28
            }
          },
          token
        );
        const refreshed = await fetchHazardDetail(selectedHazardId, token);
        setHazardDetail(refreshed);
      }

      await recordImplementation(
        targetCtrl.id,
        {
          kind: "MANUAL",
          completedOn: new Date().toISOString().slice(0, 10),
          evidenceRefs: ["doc:skip-approval-probe"]
        },
        token
      );

      setFeedback({
        type: "error",
        title: "SECURITY FAILURE: UNAPPROVED IMPLEMENTATION ACCEPTED",
        details: "Backend allowed implementation receipt without prior approval."
      });
    } catch (err: unknown) {
      if (err instanceof ApiError && (err.status === 409 || err.code === "CONFLICT")) {
        setFeedback({
          type: "conflict",
          title: "✔ REFUSAL GATE 1: PROPOSED -> IMPLEMENTING BLOCKED (409 CONFLICT)",
          details: `The backend refused this on purpose: ${fmtHazardErr(err)}`
        });
      } else {
        setFeedback({
          type: "error",
          title: "✖ REFUSAL GATE 1 TEST ERROR",
          details: fmtHazardErr(err)
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleTestVersionBoundRejection = async () => {
    if (!token || !selectedControl) {
      setFeedback({
        type: "warning",
        title: "✖ NO CONTROL SELECTED",
        details: "Create or select a control first to test version-bound If-Match conflict detection."
      });
      return;
    }
    try {
      setLoading(true);
      setFeedback(null);
      // Attempt approval with intentionally stale If-Match (current + 99)
      await approveControl(selectedControl.id, selectedControl.version + 99, token);
      setFeedback({
        type: "error",
        title: "SECURITY FAILURE: STALE VERSION APPROVAL SUCCEEDED",
        details: "Backend accepted stale If-Match version without 409 Conflict."
      });
    } catch (err: unknown) {
      if (err instanceof ApiError && (err.status === 409 || err.code === "CONFLICT")) {
        setFeedback({
          type: "conflict",
          title: "✔ REFUSAL GATE 2: STALE VERSION REJECTED (409 CONFLICT)",
          details: `The backend refused this on purpose (version ${selectedControl.version + 99} != ${selectedControl.version}): ${fmtHazardErr(err)}`
        });
      } else {
        setFeedback({
          type: "error",
          title: "✖ STALE VERSION TEST FAILED",
          details: fmtHazardErr(err)
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleTestTransferOfRisk = () => {
    setFeedback({
      type: "warning",
      title: "SIMULATION — REFUSAL GATE 3: TRANSFER OF RISK PREVIEW",
      details: "Simulation preview (client-side scenario): Primary cohort boundary intrusion dropped 20%, while adjacent on-call cohort worsened by +12% (> 5% tolerance). Demonstrates how TRANSFER_OF_RISK blocks an automatic EFFECTIVE conclusion."
    });
  };

  const acceptedCauses = hazardDetail?.causes.filter(c => c.status === "REVIEWED_ACCEPTED") || [];
  const vocab = getSectorVocabulary(sectorProfile);

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
            {" "}Active vocabulary: <strong>{vocab.workItem}</strong> &bull; <strong>{vocab.unit}</strong> &bull; <strong>{vocab.supervisor}</strong>.
          </p>
        </div>
      </div>

      {loading && hazards.length === 0 && <StateView state={{ kind: "loading" }} />}

      {/* Feedback Banner */}
      {feedback && (
        <div
          className={`card alert-${feedback.type}`}
          style={{
            padding: "1rem 1.25rem",
            marginBottom: "1.5rem",
            borderLeft: `4px solid ${feedback.type === "success"
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

      {/* Sector pack work-item surge panel (rendered only when a sector pack is active for the tenant) */}
      {sectorPackActive && (
      <div className="card" style={{ marginBottom: "1.5rem", borderLeft: "4px solid var(--aubergine)" }}>
        <div className="card-header" style={{ marginBottom: "0.75rem" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem", flexWrap: "wrap" }}>
              <span className="badge badge-aubergine">{sectorUi.sectorBadge}</span>
              {sectorUi.badges.map(b => (
                <span key={b} className="badge badge-coral">{b}</span>
              ))}
            </div>
            <h3 style={{ margin: 0 }}>{sectorUi.panelTitle}</h3>
            <p className="card-desc" style={{ marginTop: "0.25rem" }}>{sectorUi.panelDescription}</p>
          </div>
        </div>

        {sectorItems.length === 0 ? (
          <p className="text-muted" style={{ fontStyle: "italic" }}>No active {vocab.workItems.toLowerCase()} registered for this tenant.</p>
        ) : (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(280px, 100%), 1fr))", gap: "1rem", marginBottom: "1rem" }}>
              {sectorItems.map(m => {
                const isSelected = m.externalRef === selectedItemRef;
                return (
                  <button
                    key={m.externalRef}
                    type="button"
                    onClick={() => handleSelectItem(m.externalRef)}
                    style={{
                      textAlign: "left",
                      padding: "0.85rem",
                      borderRadius: "6px",
                      border: isSelected ? "2px solid var(--aubergine)" : "1px solid var(--border-color)",
                      background: isSelected ? "#FBF9F6" : "#FFFFFF",
                      cursor: "pointer",
                      transition: "all 0.15s ease"
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.35rem" }}>
                      <span className="monospace font-bold" style={{ fontSize: "0.85rem", color: "var(--aubergine)" }}>{m.externalRef}</span>
                      <span className="badge badge-sm badge-secondary">{m.demandWindow}</span>
                    </div>
                    <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.25rem" }}>{m.title}</div>
                    <div style={{ fontSize: "0.75rem", color: "var(--muted-text)" }}>
                      {vocab.unit}: <strong>{labelFor(m.unit, sectorUi.unitLabels)}</strong>
                      {m.jurisdiction && <> &bull; Jurisdiction: <strong>{m.jurisdiction}</strong></>}
                    </div>
                  </button>
                );
              })}
            </div>

            {fatigueAssessment && (
              <div
                style={{
                  padding: "0.9rem 1.1rem",
                  borderRadius: "6px",
                  background: fatigueAssessment.hasFatigueSurge ? "#FFF5F5" : "#F4FBF7",
                  border: `1px solid ${fatigueAssessment.hasFatigueSurge ? "var(--coral)" : "var(--success)"}`
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.35rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span className={`badge ${fatigueAssessment.hasFatigueSurge ? "badge-coral" : "badge-success"}`}>
                      {fatigueAssessment.hasFatigueSurge ? `⚠ ${sectorUi.surgeBadge}` : `✔ ${sectorUi.compliantBadge}`}
                    </span>
                    <span className="text-sm font-bold">{fatigueAssessment.statutoryReference}</span>
                  </div>
                  <span className="badge badge-dark">Gate: {fatigueAssessment.applicableGate}</span>
                </div>
                <div style={{ fontSize: "0.85rem", color: "var(--graphite)", marginBottom: "0.5rem" }}>
                  {fatigueAssessment.regulatoryNotice}
                </div>
                <div style={{ fontSize: "0.8rem", color: "var(--muted-text)" }}>
                  Consecutive late-night sessions: <strong>{fatigueAssessment.consecutiveLateNightsCount} days</strong>.
                  {fatigueAssessment.hasFatigueSurge && (
                    <span style={{ marginLeft: "0.5rem", color: "var(--coral)", fontWeight: 600 }}>
                      {sectorUi.mandatoryNote}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {/* Grid: Left Column (Hazard & Causes) / Right Column (Controls & Verification) */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", marginBottom: "1.5rem" }}>

        {/* LEFT COLUMN: Hazard & Causes */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>

          <HazardWorkspaceCard
            hazards={hazards}
            selectedHazardId={selectedHazardId}
            hazardDetail={hazardDetail}
            token={token}
            loading={loading}
            newHazardTitle={newHazardTitle}
            newOriginatingReleaseId={newOriginatingReleaseId}
            onSelectHazard={setSelectedHazardId}
            onChangeTitle={setNewHazardTitle}
            onChangeReleaseId={setNewOriginatingReleaseId}
            onCreateHazard={handleCreateHazard}
            onDraftAccepted={() => {
              if (selectedHazardId && token) {
                fetchHazardDetail(selectedHazardId, token)
                  .then(setHazardDetail)
                  .catch((err: unknown) => {
                    setFeedback({
                      type: "error",
                      title: "✖ FAILED TO REFRESH HAZARD DETAIL",
                      details: fmtHazardErr(err)
                    });
                  });
              }
            }}
          />

          <HazardCausesCard
            causes={hazardDetail?.causes || []}
            selectedHazardId={selectedHazardId}
            loading={loading}
            newControlScope={newControlScope}
            newControlObjective={newControlObjective}
            newControlDueDate={newControlDueDate}
            newCauseStatement={newCauseStatement}
            onChangeControlScope={setNewControlScope}
            onChangeControlObjective={setNewControlObjective}
            onChangeControlDueDate={setNewControlDueDate}
            onChangeCauseStatement={setNewCauseStatement}
            onReviewCause={handleReviewCause}
            onDraftControl={handleDraftControl}
            onProposeCause={handleProposeCause}
          />

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
                <label htmlFor="hazard-disposition-select" className="form-label">Disposition State</label>
                <select
                  id="hazard-disposition-select"
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
                <label htmlFor="hazard-disposition-rationale" className="form-label">Rationale</label>
                <input
                  id="hazard-disposition-rationale"
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
                  <label htmlFor="hazard-residual-risk" className="form-label">Residual Risk</label>
                  <input
                    id="hazard-residual-risk"
                    type="text"
                    value={dispositionResidual}
                    onChange={e => setDispositionResidual(e.target.value)}
                    className="text-control"
                    style={{ width: "100%" }}
                  />
                </div>
                <div>
                  <label htmlFor="hazard-scheduled-review" className="form-label">Scheduled Review</label>
                  <input
                    id="hazard-scheduled-review"
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

          <HazardControlLifecycleCard
            selectedControl={selectedControl}
            loading={loading}
            newImplementationKind={newImplementationKind}
            newEvidenceRef={newEvidenceRef}
            editScope={editScope}
            editObjective={editObjective}
            onChangeImplementationKind={setNewImplementationKind}
            onChangeEvidenceRef={setNewEvidenceRef}
            onChangeEditScope={setEditScope}
            onChangeEditObjective={setEditObjective}
            onApproveControl={handleApproveControl}
            onRecordImplementation={handleRecordImplementation}
            onPinVerification={handlePinVerification}
            onMaterialEdit={handleMaterialEdit}
          />

          <HazardVerificationCard
            selectedControl={selectedControl}
            loading={loading}
            concludeOutcome={concludeOutcome}
            concludeResidualRisk={concludeResidualRisk}
            onChangeOutcome={setConcludeOutcome}
            onChangeResidualRisk={setConcludeResidualRisk}
            onConcludeVerification={handleConcludeVerification}
          />

          <HazardEvidenceExportCard
            loading={loading}
            selectedHazardId={selectedHazardId}
            evidencePackage={evidencePackage}
            onExportEvidence={handleExportEvidence}
            onDownloadPackageJson={handleDownloadPackageJson}
          />

        </div>
      </div>

      <HazardRefusalLabCard
        onTestStateRejection={handleTestStateRejection}
        onTestVersionBoundRejection={handleTestVersionBoundRejection}
        onTestTransferOfRisk={handleTestTransferOfRisk}
      />
    </div>
  );
}
