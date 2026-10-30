// frontend/src/components/Tabs/CohortAnalyticsTab.tsx
import { useState, useEffect } from "react";
import {
  type SemanticQuery,
  type ReleaseView,
  type MetricDefinition,
  queryRelease,
  fetchRelease,
  fetchMetricDefinitions,
  recalculateMetric,
  downloadReleaseCsv,
  PRESET_TENANTS
} from "../../api/client";

interface CohortAnalyticsTabProps {
  currentTenant: typeof PRESET_TENANTS[0];
  token: string | null;
}

export function CohortAnalyticsTab({ currentTenant, token }: CohortAnalyticsTabProps) {
  const [metricDefs, setMetricDefs] = useState<MetricDefinition[]>([]);
  const [selectedMetricId, setSelectedMetricId] = useState("BOUNDARY_INTRUSION_SHARE");
  const [cohortRef, setCohortRef] = useState("org:00000000-0000-4000-a001-000000000001");
  const [periodStart, setPeriodStart] = useState("2026-03-02T00:00:00.000Z");
  const [periodEnd, setPeriodEnd] = useState("2026-03-30T00:00:00.000Z"); // 28 days
  const [releaseClass, setReleaseClass] = useState<"CLASS_A" | "CLASS_B">("CLASS_B");

  const [loading, setLoading] = useState(false);
  const [activeRelease, setActiveRelease] = useState<ReleaseView | null>(null);
  const [lastReleaseId, setLastReleaseId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: "success" | "warning" | "error" | "conflict";
    title: string;
    details: string;
  } | null>(null);

  // Load metric definitions on mount
  useEffect(() => {
    if (!token) return;
    fetchMetricDefinitions(token)
      .then(rawDefs => {
        const defs = (Array.isArray(rawDefs) ? rawDefs : [])
          .map((d: any) => ({
            ...d,
            id: d.id || d.metric_id || "BOUNDARY_INTRUSION_SHARE",
            name: d.name || d.id || d.metric_id || "Boundary Intrusion Share"
          }))
          .filter(d => Boolean(d.id));

        if (defs.length === 0) {
          defs.push({
            id: "BOUNDARY_INTRUSION_SHARE",
            version: 1,
            name: "Boundary Intrusion Share",
            hazard_domain: "Working Time Quality & Rest Deficits",
            formula_id: "boundaryIntrusionShare",
            contributor_floor: 10,
            min_window_days: 28,
            created_at: new Date().toISOString()
          });
        }
        setMetricDefs(defs);
        setSelectedMetricId(prev => (prev && defs.some(d => d.id === prev)) ? prev : defs[0].id);
      })
      .catch(err => {
        console.warn("Could not fetch metric definitions:", err);
        const fallbackDefs = [{
          id: "BOUNDARY_INTRUSION_SHARE",
          version: 1,
          name: "Boundary Intrusion Share",
          hazard_domain: "Working Time Quality & Rest Deficits",
          formula_id: "boundaryIntrusionShare",
          contributor_floor: 10,
          min_window_days: 28,
          created_at: new Date().toISOString()
        }];
        setMetricDefs(fallbackDefs);
        setSelectedMetricId("BOUNDARY_INTRUSION_SHARE");
      });
  }, [token]);

  // Execute Semantic Query
  const handleQuery = async (customMembers?: string[], customQueryOverride?: Partial<SemanticQuery>) => {
    if (!token) return;
    setLoading(true);
    setFeedback(null);

    const finalStart = (customQueryOverride?.periodStart) || periodStart;
    const finalEnd = (customQueryOverride?.periodEnd) || periodEnd;
    const isoStart = finalStart.includes("T") ? finalStart : `${finalStart}T00:00:00.000Z`;
    const isoEnd = finalEnd.includes("T") ? finalEnd : `${finalEnd}T00:00:00.000Z`;

    const query: SemanticQuery = {
      metricId: (customQueryOverride?.metricId) || selectedMetricId || "BOUNDARY_INTRUSION_SHARE",
      metricVersion: 1,
      cohortRef: (customQueryOverride?.cohortRef) || cohortRef || "org:00000000-0000-4000-a001-000000000001",
      periodStart: isoStart,
      periodEnd: isoEnd,
      releaseClass: (customQueryOverride?.releaseClass) || releaseClass,
      ...customQueryOverride
    };

    try {
      const res = await queryRelease(query, customMembers, token);
      setActiveRelease(res);

      if (res.status === "RELEASED") {
        setLastReleaseId(res.releaseId);
        setFeedback({
          type: "success",
          title: "✔ PRIVACY COMPILER RELEASE APPROVED",
          details: `Release ID ${res.releaseId} compiled successfully. Value: ${res.value}%, Quality: ${res.quality}, Floor: n ≥ 10 passed, Window ≥ 28 days passed, Overlap & Residual gates passed.`
        });
      } else if (res.status === "STALE") {
        setFeedback({
          type: "warning",
          title: "⚠ RELEASE MARKED STALE / SUPERSEDED",
          details: res.reason
        });
      } else {
        setFeedback({
          type: "error",
          title: "✖ RELEASE SUPPRESSED (SAFE UNAVAILABLE)",
          details: `Under ZAB-ENG-001 v1.0, suppressed releases return uniform status UNAVAILABLE (code: ${res.code}) with zero contributor count or rule failure details leaked to callers.`
        });
      }
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: "✖ QUERY EXECUTION FAILED",
        details: err.message || "An error occurred during query execution."
      });
    } finally {
      setLoading(false);
    }
  };

  // Export CSV
  const handleExportCsv = async () => {
    if (!token || !lastReleaseId) return;
    try {
      const csvText = await downloadReleaseCsv(lastReleaseId, token);
      const blob = new Blob([csvText], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `release-${lastReleaseId.slice(0, 8)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(`Export failed: ${err.message}`);
    }
  };

  // Recalculate Metric
  const handleRecalculate = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await recalculateMetric(selectedMetricId, token);
      setFeedback({
        type: "warning",
        title: "⚠ METRIC RECALCULATION TRIGGERED",
        details: `Recalculated ${res.count ?? 0} release records. Existing releases are now marked SUPERSEDED / STALE.`
      });
      if (lastReleaseId) {
        const updated = await fetchRelease(lastReleaseId, token);
        setActiveRelease(updated);
      }
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: "✖ RECALCULATION FAILED",
        details: err.message
      });
    } finally {
      setLoading(false);
    }
  };

  // Reconstruction Attack Lab: Test n = 9 Floor Violation
  const handleTestNineSuppression = async () => {
    const nineMembers = Array.from({ length: 9 }, (_, i) => `emp-test-cohort-${i + 1}`);
    await handleQuery(nineMembers, { cohortRef: "org:test-cohort-9-floor" });
  };

  // Reconstruction Attack Lab: Test n = 10 Safe Release
  const handleTestTenRelease = async () => {
    const tenMembers = Array.from({ length: 10 }, (_, i) => `emp-test-cohort-${i + 1}`);
    await handleQuery(tenMembers, { cohortRef: "org:test-cohort-10-threshold" });
  };

  // Reconstruction Attack Lab: Test Overlap Differencing Attack (symmetric diff = 1 < 5)
  const handleTestOverlapDifferencing = async () => {
    const tenMembers = Array.from({ length: 10 }, (_, i) => `emp-test-cohort-${i + 1}`);
    const offByOneMembers = [...tenMembers.slice(0, 9), "emp-test-target-person"];
    await handleQuery(offByOneMembers, { cohortRef: "org:test-cohort-differencing-attack" });
  };

  // Reconstruction Attack Lab: Test Residual Differencing Attack (parent 14, child 10 -> residual 4)
  const handleTestResidualDifferencing = async () => {
    const childMembers = Array.from({ length: 10 }, (_, i) => `emp-synthetic-member-${i + 1}`);
    await handleQuery(childMembers, { cohortRef: "org:test-cohort-child-residual" });
  };

  return (
    <div className="tab-pane">
      {/* Executive Header Card */}
      <div className="card">
        <div className="card-header">
          <div>
            <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", alignItems: "center" }}>
              <span className="badge badge-coral">PHASE 3 CERTIFIED</span>
              <span className="badge badge-aubergine">DOMAIN S06: PRIVACY RELEASE</span>
              <span className="monospace-badge">{currentTenant.name}</span>
            </div>
            <h3>Deterministic Cohort Measurement & Privacy Release</h3>
            <p className="card-desc">
              Aggregate psychosocial hazard indicators computed strictly over intervals and guarded by
              differential-privacy compilation gates. Zero individual scoring. Zero surveillance telemetry.
            </p>
          </div>

          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={handleRecalculate}
              disabled={loading || !token}
              className="btn btn-secondary btn-sm"
            >
              Trigger Recalculation
            </button>
            {lastReleaseId && (
              <button
                type="button"
                onClick={handleExportCsv}
                className="btn btn-primary btn-sm"
              >
                Export Release CSV
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Reconstruction & Differencing Attack Suite (Adversarial Verification) */}
      <div className="lab-banner">
        <div className="lab-header">
          <div className="lab-title">
            <span style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", background: "#34D399", boxShadow: "0 0 8px #34D399" }}></span>
            <span>Privacy Compiler Reconstruction Lab (Adversarial Suite)</span>
          </div>
          <span className="lab-badge">ZAB-ENG-001 §7.3 Verification</span>
        </div>
        <p style={{ fontSize: "0.825rem", color: "#CBD5E1", lineHeight: 1.5, margin: "0.25rem 0 1rem 0" }}>
          Verify the four non-negotiable privacy release invariants: contributor floors, minimum observation windows,
          cross-query symmetric differencing, and parent/child residual protection. All rejections return safe{" "}
          <code style={{ background: "rgba(0,0,0,0.4)", padding: "0.15rem 0.4rem", borderRadius: "4px", color: "#FDE68A" }}>
            UNAVAILABLE
          </code>{" "}
          with zero contributor count hints leaked.
        </p>

        <div className="lab-grid">
          <button
            type="button"
            onClick={handleTestNineSuppression}
            disabled={loading || !token}
            className="lab-card-btn border-rose"
          >
            <div className="lab-btn-title" style={{ color: "#FCA5A5" }}>
              1. Test n = 9 Floor Violation
            </div>
            <div className="lab-btn-desc">
              Cohort size 9 &lt; 10 minimum floor. Evaluates floor gate and enforces uniform suppression.
            </div>
          </button>

          <button
            type="button"
            onClick={handleTestTenRelease}
            disabled={loading || !token}
            className="lab-card-btn border-emerald"
          >
            <div className="lab-btn-title" style={{ color: "#6EE7B7" }}>
              2. Test n = 10 Valid Release
            </div>
            <div className="lab-btn-desc">
              Cohort size 10 over 28-day window. Meets threshold and commits release artifact.
            </div>
          </button>

          <button
            type="button"
            onClick={handleTestOverlapDifferencing}
            disabled={loading || !token}
            className="lab-card-btn border-amber"
          >
            <div className="lab-btn-title" style={{ color: "#FCD34D" }}>
              3. Overlap Differencing Attack
            </div>
            <div className="lab-btn-desc">
              Submits cohort differing by 1 person (Δ &lt; 5). Blocked to prevent individual isolation.
            </div>
          </button>

          <button
            type="button"
            onClick={handleTestResidualDifferencing}
            disabled={loading || !token}
            className="lab-card-btn border-cyan"
          >
            <div className="lab-btn-title" style={{ color: "#7DD3FC" }}>
              4. Parent/Child Residual Attack
            </div>
            <div className="lab-btn-desc">
              Queries subset with residual 4 &lt; 5 against seeded parent. Blocked from subtraction.
            </div>
          </button>
        </div>
      </div>

      {/* Semantic Query Formulation */}
      <div className="card">
        <div className="card-header">
          <div>
            <h3>Semantic Query Formulation (Class B Reporting)</h3>
            <p className="card-desc">
              Define the cohort scope, hazard indicator, and time interval. Parameters are evaluated through the fail-closed compiler.
            </p>
          </div>
          <span className="badge badge-aubergine">COMPILER GATEWAY</span>
        </div>

        <div className="query-grid">
          <div className="form-group">
            <label className="form-label">Hazard Indicator</label>
            <select
              value={selectedMetricId}
              onChange={e => setSelectedMetricId(e.target.value)}
              className="select-control"
              style={{ width: "100%", background: "#FFFFFF", color: "var(--graphite)" }}
            >
              {metricDefs.length > 0 ? (
                metricDefs.map(d => (
                  <option key={d.id} value={d.id}>
                    {d.name || d.id || "Boundary Intrusion Share"} ({d.id || "BOUNDARY_INTRUSION_SHARE"})
                  </option>
                ))
              ) : (
                <option value="BOUNDARY_INTRUSION_SHARE">
                  Boundary Intrusion Share (BOUNDARY_INTRUSION_SHARE)
                </option>
              )}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">Cohort Reference</label>
            <input
              type="text"
              value={cohortRef}
              onChange={e => setCohortRef(e.target.value)}
              placeholder="org:uuid"
              className="text-control monospace"
            />
          </div>

          <div className="form-group">
            <label className="form-label">Observation Window (Min 28 Days)</label>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <input
                type="text"
                value={periodStart.slice(0, 10)}
                onChange={e => setPeriodStart(`${e.target.value}T00:00:00.000Z`)}
                className="text-control monospace"
                style={{ width: "50%" }}
              />
              <input
                type="text"
                value={periodEnd.slice(0, 10)}
                onChange={e => setPeriodEnd(`${e.target.value}T00:00:00.000Z`)}
                className="text-control monospace"
                style={{ width: "50%" }}
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Release Class</label>
            <select
              value={releaseClass}
              onChange={e => setReleaseClass(e.target.value as any)}
              className="select-control"
              style={{ width: "100%", background: "#FFFFFF", color: "var(--graphite)" }}
            >
              <option value="CLASS_B">Class B (Aggregated Public/Board View)</option>
              <option value="CLASS_A">Class A (Design Working Group)</option>
            </select>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={() => handleQuery()}
            disabled={loading || !token}
            className="btn btn-primary"
          >
            {loading ? "Compiling Differential Release..." : "Execute Semantic Query"}
          </button>
        </div>
      </div>

      {/* Feedback Alert Panel */}
      {feedback && (
        <div className={`feedback-alert alert-${feedback.type}`} role="alert">
          <div className="feedback-title">{feedback.title}</div>
          <p>{feedback.details}</p>
        </div>
      )}

      {/* Active Release View Card */}
      {activeRelease && (
        <div className="card">
          <div className="card-header">
            <div>
              <h3>Release Contract View</h3>
              <p className="card-desc">Authoritative release artifact delivered via the Single Read Path.</p>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <span
                className={`badge ${
                  activeRelease.status === "RELEASED"
                    ? "badge-success"
                    : activeRelease.status === "STALE"
                    ? "badge-warning"
                    : "badge-coral"
                }`}
              >
                STATUS: {activeRelease.status}
              </span>
              {activeRelease.status === "RELEASED" && (
                <span className="status-pill status-live">
                  Freshness: {activeRelease.freshness}
                </span>
              )}
            </div>
          </div>

          {activeRelease.status === "RELEASED" ? (
            <div className="release-grid">
              <div className="analytics-metric-box">
                <span className="context-label">CALCULATED INDICATOR</span>
                <div className="metric-big-value">
                  {activeRelease.value !== null ? `${activeRelease.value}%` : "N/A"}
                </div>
                <div style={{ margin: "0.5rem 0", display: "flex", gap: "0.35rem" }}>
                  <span className="status-pill status-live">Quality: {activeRelease.quality}</span>
                  <span className="command-pill">{activeRelease.unit}</span>
                </div>
                <div
                  style={{
                    marginTop: "0.75rem",
                    padding: "0.6rem 0.75rem",
                    background: "#E8ECEB",
                    borderRadius: "6px",
                    fontSize: "0.75rem",
                    color: "var(--aubergine)",
                    fontWeight: 600,
                    lineHeight: 1.4
                  }}
                >
                  {activeRelease.assuranceLabel}
                </div>
              </div>

              <div className="info-block">
                <h4>Release Metadata & Physical Minimization Guarantees</h4>
                <div className="data-row">
                  <span className="data-label">Release ID:</span>
                  <span className="data-value monospace">{activeRelease.releaseId}</span>
                </div>
                <div className="data-row">
                  <span className="data-label">Metric Name:</span>
                  <span className="data-value">{activeRelease.metricName}</span>
                </div>
                <div className="data-row">
                  <span className="data-label">Cohort Reference:</span>
                  <span className="data-value monospace">{activeRelease.cohortRef}</span>
                </div>
                <div className="data-row">
                  <span className="data-label">Measurement Interval:</span>
                  <span className="data-value monospace">
                    {activeRelease.periodStart.slice(0, 10)} to {activeRelease.periodEnd.slice(0, 10)}
                  </span>
                </div>
                <div className="data-row">
                  <span className="data-label">Released At:</span>
                  <span className="data-value monospace">{activeRelease.releasedAt}</span>
                </div>

                <div
                  style={{
                    marginTop: "1rem",
                    padding: "0.75rem",
                    background: "rgba(226, 109, 90, 0.08)",
                    borderLeft: "3px solid var(--coral)",
                    borderRadius: "4px",
                    fontSize: "0.8rem",
                    color: "var(--graphite)",
                    lineHeight: 1.4
                  }}
                >
                  <strong>Physical Minimization Assurance:</strong> This release artifact contains strictly the
                  aggregate mathematical interval result. Database row-level security and schema constraints
                  prevent contributor counts (n), individual employee pseudonyms, or micro-level timestamps
                  from being stored or emitted.
                </div>
              </div>
            </div>
          ) : activeRelease.status === "STALE" ? (
            <div className="callout-alert">
              <strong>Release Superseded:</strong> {activeRelease.reason}
              <div className="monospace" style={{ marginTop: "0.25rem", fontSize: "0.8rem" }}>
                Superseded At: {activeRelease.supersededAt}
              </div>
            </div>
          ) : (
            <div className="callout-info">
              <strong style={{ color: "var(--aubergine)" }}>Metric Suppressed: Safe Non-Disclosing Output</strong>
              <p style={{ marginTop: "0.4rem", lineHeight: 1.5 }}>
                The requested cohort did not meet the mandatory privacy release constraints (e.g. contributor
                floor n ≥ 10, observation window ≥ 28 days, symmetric difference ≥ 5, or
                residual threshold). To protect individual anonymity, the system returns uniform{" "}
                <code className="monospace-badge" style={{ color: "var(--aubergine)", background: "#E5E7EB" }}>
                  NOT_AVAILABLE
                </code>{" "}
                with zero diagnostic leakage.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Mandatory Ethical Disclosure Panel: What This Does NOT Mean */}
      <div className="ethical-callout">
        <h4>
          <span>MANDATORY ETHICAL SAFEGUARD §8.1</span>
          <span>&bull;</span>
          <span>Interpretive Notice: What This Metric Does NOT Mean</span>
        </h4>
        <p style={{ lineHeight: 1.5, fontSize: "0.85rem" }}>
          Under the Zoiko Abate Governance Standard (ZAB-ENG-001 v1.0), Boundary Intrusion Share measures{" "}
          <strong>operational workplace design friction, scheduling deficits, and boundary collapse</strong>.
        </p>
        <ul>
          <li>
            <strong>NOT an individual productivity score:</strong> This metric cannot be disaggregated to evaluate,
            rank, or compare individual employee output or dedication.
          </li>
          <li>
            <strong>NOT employee resilience assessment:</strong> High boundary intrusion indicates organizational
            design failure, under-staffing, or boundary intrusion by management—never personal time-management deficits.
          </li>
          <li>
            <strong>Prohibited in Performance Reviews:</strong> Utilizing these cohort statistics for individual
            compensation, disciplinary action, or promotion eligibility is strictly prohibited by architectural contract.
          </li>
        </ul>
      </div>
    </div>
  );
}
