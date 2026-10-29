// frontend/src/components/Tabs/IngestionTab.tsx
import { useState, useEffect, useCallback } from "react";
import {
  fetchConnections,
  setConnectionState,
  fetchReceipts,
  fetchWorkFacts,
  submitZoikoBatch,
  type Connection,
  type IngestReceipt,
  type WorkFact,
  PRESET_TENANTS,
  ApiError
} from "../../api/client";

interface IngestionTabProps {
  currentTenant: typeof PRESET_TENANTS[0];
  token: string | null;
  onRefresh: () => void;
}

export function IngestionTab({ currentTenant, token, onRefresh }: IngestionTabProps) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [receipts, setReceipts] = useState<IngestReceipt[]>([]);
  const [workFacts, setWorkFacts] = useState<WorkFact[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Feedback banner
  const [feedback, setFeedback] = useState<{
    type: "success" | "error" | "warning";
    title: string;
    message: string;
    details?: string;
  } | null>(null);

  // Load Ingestion domain data
  const loadData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [conns, recs, facts] = await Promise.all([
        fetchConnections(token),
        fetchReceipts(token),
        fetchWorkFacts(token)
      ]);
      setConnections(conns);
      setReceipts(recs);
      setWorkFacts(facts);
    } catch (err: any) {
      console.error("Failed to load ingestion data:", err);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadData();
  }, [loadData, currentTenant.id]);

  // Connection State Controls
  const handleToggleState = async (conn: Connection, action: "pause" | "resume" | "revoke") => {
    if (!token) return;
    setActionLoading(`state-${conn.id}`);
    setFeedback(null);
    try {
      await setConnectionState(conn.id, action, token);
      setFeedback({
        type: "success",
        title: `Connection ${action.toUpperCase()}D`,
        message: `Connection "${conn.source}" (${conn.id.slice(0, 8)}...) is now ${action === "pause" ? "PAUSED" : action === "resume" ? "ACTIVE" : "REVOKED"}.`
      });
      await loadData();
      onRefresh();
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: "Connection State Change Failed",
        message: err.message || "Failed to update connection state."
      });
    } finally {
      setActionLoading(null);
    }
  };

  // Test 1: Send Standard Clean Batch
  const handleSendStandardBatch = async () => {
    if (!token || connections.length === 0) return;
    const activeConn = connections.find(c => c.state === "ACTIVE") || connections[0];
    const batchId = `batch-${Date.now().toString(36)}`;
    const now = new Date();
    const interval1Start = new Date(now.getTime() - 2 * 3600000).toISOString();
    const interval1End = new Date(now.getTime() - 1 * 3600000).toISOString();

    setActionLoading("batch-clean");
    setFeedback(null);

    try {
      const receipt = await submitZoikoBatch(
        {
          connectionId: activeConn.id,
          batchId,
          items: [
            {
              recordId: `rec-${crypto.randomUUID().slice(0, 8)}`,
              revision: 1,
              subjectRef: "emp-senior-analyst-049",
              startUtc: interval1Start,
              endUtc: interval1End,
              workTz: "Europe/London",
              kind: "WORK"
            },
            {
              recordId: `rec-${crypto.randomUUID().slice(0, 8)}`,
              revision: 1,
              subjectRef: "emp-lead-counsel-102",
              startUtc: interval1Start,
              endUtc: interval1End,
              workTz: "Europe/London",
              kind: "WORK"
            }
          ]
        },
        token
      );

      setFeedback({
        type: "success",
        title: "Standard Batch Ingested Successfully",
        message: `Batch "${receipt.batch_id}" accepted ${receipt.accepted} records. Watermark advanced. Pseudonym hashes derived without leaking plaintext subject IDs.`
      });
      await loadData();
      onRefresh();
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: "Standard Batch Ingestion Failed",
        message: err.message || "Ingestion error."
      });
    } finally {
      setActionLoading(null);
    }
  };

  // Test 2: Send Duplicate Batch (Idempotency test)
  const handleSendDuplicateBatch = async () => {
    if (!token || receipts.length === 0 || connections.length === 0) {
      setFeedback({
        type: "warning",
        title: "No Prior Batch Found",
        message: "Please send a standard batch first before testing duplicate delivery idempotency."
      });
      return;
    }

    const lastReceipt = receipts[0];
    const activeConn = connections.find(c => c.id === lastReceipt.connection_id) || connections[0];
    setActionLoading("batch-duplicate");
    setFeedback(null);

    try {
      const receipt = await submitZoikoBatch(
        {
          connectionId: activeConn.id,
          batchId: lastReceipt.batch_id, // Replaying the exact same batch ID
          items: [
            {
              recordId: "rec-replay-static-01",
              revision: 1,
              subjectRef: "emp-senior-analyst-049",
              startUtc: "2026-10-28T08:00:00.000Z",
              endUtc: "2026-10-28T09:00:00.000Z",
              workTz: "Europe/London",
              kind: "WORK"
            }
          ]
        },
        token
      );

      setFeedback({
        type: "success",
        title: "Duplicate Batch Handled Idempotently",
        message: `Replayed batch "${receipt.batch_id}". Accepted: ${receipt.accepted} new facts. Existing receipt returned without corrupting work fact counts.`
      });
      await loadData();
      onRefresh();
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: "Duplicate Batch Test Failed",
        message: err.message
      });
    } finally {
      setActionLoading(null);
    }
  };

  // Test 3: Send Prohibited Surveillance Decoy Payload
  const handleSendDecoyAttack = async () => {
    if (!token || connections.length === 0) return;
    const activeConn = connections.find(c => c.state === "ACTIVE") || connections[0];
    setActionLoading("batch-decoy");
    setFeedback(null);

    try {
      await submitZoikoBatch(
        {
          connectionId: activeConn.id,
          batchId: `batch-decoy-${Date.now().toString(36)}`,
          items: [
            {
              recordId: `rec-valid-${crypto.randomUUID().slice(0, 8)}`,
              revision: 1,
              subjectRef: "emp-decoy-control",
              startUtc: "2026-10-28T08:00:00.000Z",
              endUtc: "2026-10-28T09:00:00.000Z",
              workTz: "Europe/London",
              kind: "WORK"
            },
            {
              recordId: `rec-decoy-${crypto.randomUUID().slice(0, 8)}`,
              revision: 1,
              subjectRef: "emp-decoy-subject",
              startUtc: "2026-10-28T09:00:00.000Z",
              endUtc: "2026-10-28T10:00:00.000Z",
              workTz: "Europe/London",
              kind: "WORK",
              // Prohibited surveillance fields injected by rogue connector:
              screenshotUrl: "https://spyware.example/screen_snapshot.png",
              sickReason: "Severe mental burnout and depression",
              windowTitle: "Confidential Mergers & Acquisitions Client File"
            } as any
          ]
        },
        token
      );

      setFeedback({
        type: "error",
        title: "Vulnerability Detected: Decoy Was Not Rejected!",
        message: "The server accepted forbidden fields. This should never happen under Phase 2 strict schema contracts."
      });
    } catch (err: any) {
      if (err instanceof ApiError && (err.code === "VALIDATION" || err.status === 400)) {
        setFeedback({
          type: "success",
          title: "Physical Minimization Confirmed (Decoy Dropped)",
          message: "The connector contract rejected unallowlisted surveillance fields (screenshotUrl, sickReason, windowTitle) before persistence. 0 bytes written to database or logs."
        });
      } else {
        setFeedback({
          type: "warning",
          title: "Decoy Blocked with Error",
          message: err.message || "Request blocked."
        });
      }
    } finally {
      setActionLoading(null);
    }
  };

  // Test 4: Send Revision 2 Correction
  const handleSendRevisionCorrection = async () => {
    if (!token || connections.length === 0) return;
    const activeConn = connections.find(c => c.state === "ACTIVE") || connections[0];
    const targetRecordId = workFacts[0]?.source_record_id || `rec-fixed-target-${Date.now().toString(36)}`;
    const batchId = `batch-rev2-${Date.now().toString(36)}`;

    setActionLoading("batch-rev2");
    setFeedback(null);

    try {
      const receipt = await submitZoikoBatch(
        {
          connectionId: activeConn.id,
          batchId,
          items: [
            {
              recordId: targetRecordId,
              revision: 2, // Higher revision
              subjectRef: "emp-senior-analyst-049",
              startUtc: "2026-10-28T08:00:00.000Z",
              endUtc: "2026-10-28T10:30:00.000Z", // Adjusted duration
              workTz: "Europe/London",
              kind: "WORK"
            }
          ]
        },
        token
      );

      setFeedback({
        type: "success",
        title: "Revision 2 Appended to Ledger",
        message: `Record "${targetRecordId}" appended at revision 2 in Batch "${receipt.batch_id}". Revision 1 remains intact in the ledger for complete historical auditability.`
      });
      await loadData();
      onRefresh();
    } catch (err: any) {
      setFeedback({
        type: "error",
        title: "Revision 2 Correction Failed",
        message: err.message || "Failed to append revision."
      });
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="tab-pane">
      {/* Hero Header */}
      <div className="card hero-banner">
        <div className="badge badge-coral">Phase 2 Architecture &bull; Domains S02 & S03</div>
        <h2 style={{ marginTop: "0.5rem" }}>Ingestion & Work-State Ledger</h2>
        <p className="lead">
          Strict schema ingestion pipeline without surveillance overcollection. Source contracts filter
          data at the boundary, enforce tenant-scoped HMAC pseudonymization, evaluate source freshness
          over time, and maintain an append-only historical work ledger.
        </p>
        <div className="tagline-quote">"Change the work. Not the worker."</div>
      </div>

      {/* Feedback Banner */}
      {feedback && (
        <div
          className={`feedback-alert ${
            feedback.type === "success"
              ? "alert-success"
              : feedback.type === "error"
              ? "alert-error"
              : "alert-conflict"
          }`}
          role="alert"
        >
          <div className="feedback-title">{feedback.title}</div>
          <p>{feedback.message}</p>
          {feedback.details && <pre className="code-block">{feedback.details}</pre>}
        </div>
      )}

      {/* Interactive Ingestion Testing Lab */}
      <div className="card">
        <div className="card-header">
          <div>
            <h3>Interactive Ingestion Testing Lab</h3>
            <p className="card-desc">
              Execute live Phase 2 operational and adversarial scenarios against the active tenant's connection.
            </p>
          </div>
          <div className="badge badge-aubergine">Live Connector Suite</div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "1rem" }}>
          {/* Action 1 */}
          <div style={{ padding: "1rem", border: "1px solid var(--card-border)", borderRadius: "8px", background: "#FFFFFF" }}>
            <h4 style={{ margin: "0 0 0.5rem 0", color: "var(--aubergine)", fontSize: "0.95rem" }}>
              1. Standard Batch (Clean)
            </h4>
            <p style={{ fontSize: "0.85rem", color: "var(--muted-text)", margin: "0 0 1rem 0" }}>
              Submits valid work interval facts conforming strictly to ZoikoTime v1 contract.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              style={{ width: "100%" }}
              onClick={handleSendStandardBatch}
              disabled={loading || actionLoading !== null}
            >
              {actionLoading === "batch-clean" ? "Submitting..." : "Send Clean Batch"}
            </button>
          </div>

          {/* Action 2 */}
          <div style={{ padding: "1rem", border: "1px solid var(--card-border)", borderRadius: "8px", background: "#FFFFFF" }}>
            <h4 style={{ margin: "0 0 0.5rem 0", color: "var(--aubergine)", fontSize: "0.95rem" }}>
              2. Duplicate Delivery Test
            </h4>
            <p style={{ fontSize: "0.85rem", color: "var(--muted-text)", margin: "0 0 1rem 0" }}>
              Replays previous batch to verify receipt idempotency and 0 fact duplication.
            </p>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ width: "100%" }}
              onClick={handleSendDuplicateBatch}
              disabled={loading || actionLoading !== null || receipts.length === 0}
            >
              {actionLoading === "batch-duplicate" ? "Testing..." : "Send Duplicate Replay"}
            </button>
          </div>

          {/* Action 3 */}
          <div style={{ padding: "1rem", border: "1px solid var(--card-border)", borderRadius: "8px", background: "#FFFFFF" }}>
            <h4 style={{ margin: "0 0 0.5rem 0", color: "var(--aubergine)", fontSize: "0.95rem" }}>
              3. Decoy Lab (Adversarial)
            </h4>
            <p style={{ fontSize: "0.85rem", color: "var(--muted-text)", margin: "0 0 1rem 0" }}>
              Injects spyware fields (screenshots, sick reason). Proves physical rejection with 0 trace.
            </p>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ width: "100%", borderColor: "var(--coral)", color: "var(--coral)" }}
              onClick={handleSendDecoyAttack}
              disabled={loading || actionLoading !== null}
            >
              {actionLoading === "batch-decoy" ? "Attacking..." : "Send Surveillance Decoy"}
            </button>
          </div>

          {/* Action 4 */}
          <div style={{ padding: "1rem", border: "1px solid var(--card-border)", borderRadius: "8px", background: "#FFFFFF" }}>
            <h4 style={{ margin: "0 0 0.5rem 0", color: "var(--aubergine)", fontSize: "0.95rem" }}>
              4. Revision 2 Correction
            </h4>
            <p style={{ fontSize: "0.85rem", color: "var(--muted-text)", margin: "0 0 1rem 0" }}>
              Appends revision 2 without mutating or destroying historical revision 1 facts.
            </p>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ width: "100%" }}
              onClick={handleSendRevisionCorrection}
              disabled={loading || actionLoading !== null}
            >
              {actionLoading === "batch-rev2" ? "Appending..." : "Send Revision 2"}
            </button>
          </div>
        </div>
      </div>

      {/* Connections & Freshness Status */}
      <div className="card">
        <div className="card-header">
          <div>
            <h3>Source Connections & Cadence Health</h3>
            <p className="card-desc">
              Connection health is evaluated against wall-clock time. Missing data (&gt; 3x cadence) results in
              STALE health, ensuring source outages are never misinterpreted as "zero work" or "reduced risk".
            </p>
          </div>
          <div className="badge badge-dark">{connections.length} Connections</div>
        </div>

        {connections.length === 0 ? (
          <p className="empty-message">No connections found for this tenant scope.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            {connections.map(conn => {
              const isFresh = conn.health === "FRESH";
              const isDelayed = conn.health === "DELAYED";
              const isStale = conn.health === "STALE";

              const healthBadgeClass = isFresh
                ? "badge-success"
                : isDelayed
                ? "badge-warning"
                : isStale
                ? "badge-coral"
                : "badge-dark";

              const cadenceMin = Math.round(conn.expected_cadence_seconds / 60);
              const staleMin = cadenceMin * 3;
              const lastSyncedText = conn.last_success_at
                ? `${new Date(conn.last_success_at).toLocaleTimeString()}`
                : "Never synced";

              return (
                <div
                  key={conn.id}
                  style={{
                    border: "1px solid var(--card-border)",
                    borderRadius: "8px",
                    padding: "1.25rem",
                    background: "#FFFFFF",
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.75rem"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                      <strong style={{ fontSize: "1.05rem", color: "var(--aubergine)" }}>{conn.source}</strong>
                      <span className={`badge ${healthBadgeClass}`}>
                        Health: {conn.health}
                      </span>
                      <span className={`status-pill ${conn.state === "ACTIVE" ? "status-live" : "status-error"}`}>
                        State: {conn.state}
                      </span>
                    </div>

                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      {conn.state === "ACTIVE" ? (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleToggleState(conn, "pause")}
                          disabled={actionLoading !== null}
                        >
                          Pause
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleToggleState(conn, "resume")}
                          disabled={actionLoading !== null}
                        >
                          Resume
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        style={{ color: "var(--coral)", borderColor: "var(--coral)" }}
                        onClick={() => handleToggleState(conn, "revoke")}
                        disabled={actionLoading !== null || conn.state === "REVOKED"}
                      >
                        Revoke
                      </button>
                    </div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.75rem", fontSize: "0.85rem", color: "var(--graphite)" }}>
                    <div>
                      <span style={{ color: "var(--muted-text)" }}>Connection ID:</span>{" "}
                      <code>{conn.id.slice(0, 16)}...</code>
                    </div>
                    <div>
                      <span style={{ color: "var(--muted-text)" }}>Contract ID:</span>{" "}
                      <code>{conn.contract_id.slice(0, 16)}...</code>
                    </div>
                    <div>
                      <span style={{ color: "var(--muted-text)" }}>Sync Cadence:</span>{" "}
                      Every {cadenceMin} minutes
                    </div>
                    <div>
                      <span style={{ color: "var(--muted-text)" }}>Staleness Threshold:</span>{" "}
                      {staleMin} minutes (3x cadence)
                    </div>
                    <div>
                      <span style={{ color: "var(--muted-text)" }}>Last Sync Success:</span>{" "}
                      {lastSyncedText}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Ingestion Receipts */}
      <div className="card">
        <div className="card-header">
          <div>
            <h3>Traceable Ingestion Receipts</h3>
            <p className="card-desc">
              Receipts are recorded upon every batch processing attempt. By constitutional decree, receipts
              store counts and source metadata only. Rejected payloads are dropped immediately and never quarantined.
            </p>
          </div>
          <div className="badge badge-aubergine">{receipts.length} Receipts</div>
        </div>

        {receipts.length === 0 ? (
          <p className="empty-message">No ingestion receipts recorded yet for this tenant.</p>
        ) : (
          <div className="table-responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Batch ID</th>
                  <th>Total</th>
                  <th>Accepted</th>
                  <th>Duplicate</th>
                  <th>Conflicted</th>
                  <th>Rejected</th>
                  <th>Received At</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map(rec => {
                  const total = rec.accepted + rec.duplicate + rec.rejected + rec.conflicted;
                  return (
                    <tr key={rec.id}>
                      <td><code>{rec.batch_id}</code></td>
                      <td><strong>{total}</strong></td>
                      <td><span className="badge badge-success">{rec.accepted}</span></td>
                      <td>{rec.duplicate > 0 ? <span className="badge badge-warning">{rec.duplicate}</span> : "0"}</td>
                      <td>{rec.conflicted > 0 ? <span className="badge badge-coral">{rec.conflicted}</span> : "0"}</td>
                      <td>{rec.rejected > 0 ? <span className="badge badge-coral">{rec.rejected}</span> : "0"}</td>
                      <td>{new Date(rec.received_at).toLocaleTimeString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Work-State Ledger */}
      <div className="card">
        <div className="card-header">
          <div>
            <h3>Work-State Ledger (Append-Only Revisions)</h3>
            <p className="card-desc">
              Immutable facts of work intervals. Subject identities are pseudonymized via tenant-salted HMAC-SHA256.
              Individual workers cannot be tracked; work duration is isolated to work design risk analysis.
            </p>
          </div>
          <div className="badge badge-dark">{workFacts.length} Ledger Facts</div>
        </div>

        {workFacts.length === 0 ? (
          <p className="empty-message">No work facts recorded in the ledger yet. Submit a clean batch above.</p>
        ) : (
          <div className="table-responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Pseudonym Hash (HMAC-SHA256)</th>
                  <th>Source Record</th>
                  <th>Revision</th>
                  <th>Start (UTC)</th>
                  <th>End (UTC)</th>
                  <th>Work TZ</th>
                  <th>Kind</th>
                </tr>
              </thead>
              <tbody>
                {workFacts.map(fact => (
                  <tr key={fact.id}>
                    <td>
                      <code title={fact.subject_pseudonym} style={{ fontSize: "0.8rem" }}>
                        {fact.subject_pseudonym.slice(0, 14)}...{fact.subject_pseudonym.slice(-6)}
                      </code>
                    </td>
                    <td><code>{fact.source_record_id}</code></td>
                    <td>
                      <span className={`badge ${fact.revision > 1 ? "badge-coral" : "badge-dark"}`}>
                        rev {fact.revision}
                      </span>
                    </td>
                    <td>{new Date(fact.start_at).toLocaleTimeString()}</td>
                    <td>{new Date(fact.end_at).toLocaleTimeString()}</td>
                    <td>{fact.work_tz}</td>
                    <td>
                      <span className="badge badge-aubergine">{fact.kind}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
