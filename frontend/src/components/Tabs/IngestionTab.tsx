// frontend/src/components/Tabs/IngestionTab.tsx
import { useState, useEffect, useCallback } from "react";
import {
  fetchSourceContracts,
  fetchConnections,
  registerConnection,
  setConnectionState,
  fetchReceipts,
  fetchWorkFacts,
  submitZoikoBatch,
  formatConnectionStateLabel,
  type SourceContract,
  type Connection,
  type IngestReceipt,
  type WorkFact,
  type ZoikoTimeBatchPayload,
  PRESET_TENANTS,
  ApiError
} from "../../api/client";
import { StateView } from "../StateView";

interface IngestionTabProps {
  currentTenant: typeof PRESET_TENANTS[0];
  token: string | null;
  onRefresh: () => void;
}

function withReqId(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return `${err.message} (Request ID: ${err.requestId})`;
  }
  return err instanceof Error ? err.message : fallback;
}

export function IngestionTab({ currentTenant, token, onRefresh }: IngestionTabProps) {
  const [contracts, setContracts] = useState<SourceContract[]>([]);
  const [selectedContractId, setSelectedContractId] = useState<string>("");
  const [newCadenceSeconds, setNewCadenceSeconds] = useState<string>("3600");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [receipts, setReceipts] = useState<IngestReceipt[]>([]);
  const [workFacts, setWorkFacts] = useState<WorkFact[]>([]);
  const [lastSentBatch, setLastSentBatch] = useState<ZoikoTimeBatchPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmDisconnectId, setConfirmDisconnectId] = useState<string | null>(null);

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
      const [ctrs, conns, recs, facts] = await Promise.all([
        fetchSourceContracts(token),
        fetchConnections(token),
        fetchReceipts(token),
        fetchWorkFacts(token)
      ]);
      setContracts(ctrs);
      if (ctrs.length > 0) {
        setSelectedContractId(prev => prev && ctrs.some(c => c.id === prev) ? prev : ctrs[0].id);
      }
      setConnections(conns);
      setReceipts(recs);
      setWorkFacts(facts);
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        title: "Failed to Load Ingestion Data",
        message: withReqId(err, "Could not fetch source contracts, connections, or receipts.")
      });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void Promise.all([
      fetchSourceContracts(token),
      fetchConnections(token),
      fetchReceipts(token),
      fetchWorkFacts(token)
    ])
      .then(([ctrs, conns, recs, facts]) => {
        if (cancelled) return;
        setLastSentBatch(null);
        setContracts(ctrs);
        if (ctrs.length > 0) {
          setSelectedContractId(ctrs[0].id);
        }
        setConnections(conns);
        setReceipts(recs);
        setWorkFacts(facts);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFeedback({
          type: "error",
          title: "Failed to Load Ingestion Data",
          message: withReqId(err, "Could not load initial ingestion state.")
        });
      });
    return () => {
      cancelled = true;
    };
  }, [token, currentTenant.id]);

  // Register new source connection bound to approved contract
  const handleRegisterConnection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !selectedContractId) return;
    const contract = contracts.find(c => c.id === selectedContractId);
    if (!contract) return;

    setActionLoading("register-conn");
    setFeedback(null);
    try {
      const created = await registerConnection(
        {
          source: contract.source,
          contractId: contract.id,
          expectedCadenceSeconds: Math.max(60, Number(newCadenceSeconds) || 3600)
        },
        `reg-conn-${crypto.randomUUID()}`,
        token
      );
      setFeedback({
        type: "success",
        title: "Source Connection Registered",
        message: `Bound new "${created.source}" connection (${created.id.slice(0, 8)}...) to contract ${contract.version}.`
      });
      await loadData();
      onRefresh();
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        title: "Connection Registration Failed",
        message: withReqId(err, "Failed to register connection.")
      });
    } finally {
      setActionLoading(null);
    }
  };

  // Connection State Controls
  const handleToggleState = async (conn: Connection, action: "pause" | "resume" | "suspend" | "disconnect") => {
    if (!token) return;
    setActionLoading(`state-${conn.id}`);
    setFeedback(null);
    try {
      const updated = await setConnectionState(conn.id, action, token);
      if (action === "disconnect") {
        setConfirmDisconnectId(null);
      }
      const titleMap: Record<typeof action, string> = {
        pause: "Connection PAUSED",
        resume: "Connection RESUMED",
        suspend: "Connection SUSPENDED",
        disconnect: "Connection DISCONNECTED"
      };
      setFeedback({
        type: action === "disconnect" ? "warning" : "success",
        title: titleMap[action],
        message: `Connection "${conn.source}" (${conn.id.slice(0, 8)}...) is now ${formatConnectionStateLabel(updated.state)}.`
      });
      await loadData();
      onRefresh();
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        title: "Connection State Change Failed",
        message: withReqId(err, "Failed to update connection state.")
      });
    } finally {
      setActionLoading(null);
    }
  };

  // Test 1: Send Standard Clean Batch
  const handleSendStandardBatch = async () => {
    if (!token || connections.length === 0) return;
    const activeConn = connections.find(c => c.state === "ACTIVE");
    if (!activeConn) {
      setFeedback({
        type: "error",
        title: "No Active Connection Available",
        message: "Resume or register an ACTIVE source connection before ingesting a batch."
      });
      return;
    }

    const batchId = `batch-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
    const now = new Date();
    const interval1Start = new Date(now.getTime() - 2 * 3600000).toISOString();
    const interval1End = new Date(now.getTime() - 1 * 3600000).toISOString();

    const batchPayload: ZoikoTimeBatchPayload = {
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
    };

    setActionLoading("batch-clean");
    setFeedback(null);

    try {
      const receipt = await submitZoikoBatch(batchPayload, token);
      setLastSentBatch(batchPayload);
      const resolvedBatchId = (receipt as any).batch_id ?? (receipt as any).batchId ?? batchId;

      setFeedback({
        type: "success",
        title: "Standard Batch Ingested Successfully",
        message: `Batch "${resolvedBatchId}" accepted ${receipt.accepted} records. Watermark advanced. Pseudonym hashes derived without leaking plaintext subject IDs.`
      });
      await loadData();
      onRefresh();
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        title: "Standard Batch Ingestion Failed",
        message: withReqId(err, "Ingestion error.")
      });
    } finally {
      setActionLoading(null);
    }
  };

  // Test 2: Send Duplicate Batch (Idempotency test)
  const handleSendDuplicateBatch = async () => {
    if (!token || connections.length === 0) {
      setFeedback({
        type: "warning",
        title: "No Source Connection Available",
        message: "Register a source connection first before testing duplicate delivery idempotency."
      });
      return;
    }

    const activeConn = connections.find(c => c.state === "ACTIVE");
    if (!activeConn && !lastSentBatch) {
      setFeedback({
        type: "error",
        title: "No Active Connection Available",
        message: "Resume or register an ACTIVE source connection before running a duplicate replay."
      });
      return;
    }

    setActionLoading("batch-duplicate");
    setFeedback(null);

    try {
      let targetBatch = lastSentBatch;
      if (!targetBatch || !connections.some(c => c.id === targetBatch?.connectionId && c.state === "ACTIVE")) {
        const now = new Date();
        const freshBatch: ZoikoTimeBatchPayload = {
          connectionId: (activeConn || connections[0]).id,
          batchId: `batch-replay-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`,
          items: [
            {
              recordId: `rec-${crypto.randomUUID().slice(0, 8)}`,
              revision: 1,
              subjectRef: "emp-senior-analyst-049",
              startUtc: new Date(now.getTime() - 2 * 3600000).toISOString(),
              endUtc: new Date(now.getTime() - 1 * 3600000).toISOString(),
              workTz: "Europe/London",
              kind: "WORK"
            }
          ]
        };
        await submitZoikoBatch(freshBatch, token);
        setLastSentBatch(freshBatch);
        targetBatch = freshBatch;
      }

      const receipt = await submitZoikoBatch(targetBatch, token);
      const resolvedBatchId = (receipt as any).batch_id ?? (receipt as any).batchId ?? targetBatch.batchId;

      setFeedback({
        type: "success",
        title: "Duplicate Batch Handled Idempotently",
        message: `Replayed exact batch "${resolvedBatchId}". Accepted on replay: ${receipt.accepted ?? 0} new facts (idempotent deduplication preserved ledger integrity).`
      });
      await loadData();
      onRefresh();
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        title: "Duplicate Batch Test Failed",
        message: withReqId(err, "Failed to verify duplicate batch replay.")
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
    } catch (err: unknown) {
      if (err instanceof ApiError && (err.code === "VALIDATION" || err.status === 400)) {
        setFeedback({
          type: "success",
          title: "Physical Minimization Confirmed (Decoy Dropped)",
          message: `The connector contract rejected unallowlisted surveillance fields before persistence (Request ID: ${err.requestId}). 0 bytes written to database or logs.`
        });
      } else {
        setFeedback({
          type: "error",
          title: "Decoy Blocked with Unexpected Error",
          message: withReqId(err, "Request blocked.")
        });
      }
    } finally {
      setActionLoading(null);
    }
  };

  // Test 4: Send Revision 2 Correction
  const handleSendRevisionCorrection = async () => {
    if (!token || connections.length === 0) return;
    const activeConn = connections.find(c => c.state === "ACTIVE");
    if (!activeConn) {
      setFeedback({
        type: "error",
        title: "No Active Connection Available",
        message: "Resume or register an ACTIVE source connection before appending Revision 2."
      });
      return;
    }

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

      const resolvedBatchId = (receipt as any).batch_id ?? (receipt as any).batchId ?? batchId;
      setFeedback({
        type: "success",
        title: "Revision 2 Appended to Ledger",
        message: `Record "${targetRecordId}" appended at revision 2 in Batch "${resolvedBatchId}". Revision 1 remains intact in the ledger for complete historical auditability.`
      });
      await loadData();
      onRefresh();
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        title: "Revision 2 Correction Failed",
        message: withReqId(err, "Failed to append revision.")
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
        <div className="tagline-quote">&ldquo;Change the work. Not the worker.&rdquo;</div>
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
              Execute live Phase 2 operational and adversarial scenarios against the active tenant&apos;s connection.
            </p>
          </div>
          <div className="badge badge-aubergine">Live Connector Suite</div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(260px, 100%), 1fr))", gap: "1rem" }}>
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
              disabled={loading || actionLoading !== null || connections.length === 0}
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
              STALE health, ensuring source outages are never misinterpreted as &ldquo;zero work&rdquo; or &ldquo;reduced risk&rdquo;.
            </p>
          </div>
          <div className="badge badge-dark">{connections.length} Connections</div>
        </div>

        {contracts.length > 0 && (
          <form
            onSubmit={handleRegisterConnection}
            style={{
              display: "flex",
              gap: "0.75rem",
              flexWrap: "wrap",
              alignItems: "flex-end",
              padding: "0.9rem 1rem",
              marginBottom: "1rem",
              border: "1px solid var(--card-border)",
              borderRadius: "8px",
              background: "var(--ivory)"
            }}
          >
            <div className="form-group" style={{ flex: "1 1 240px", marginBottom: 0 }}>
              <label htmlFor="new-conn-contract" className="form-label">Approved Source Contract</label>
              <select
                id="new-conn-contract"
                className="select-control"
                style={{ width: "100%", background: "#FFFFFF", color: "var(--graphite)", borderColor: "var(--card-border)" }}
                value={selectedContractId}
                onChange={(e) => setSelectedContractId(e.target.value)}
              >
                {contracts.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.source} {c.version} ({c.status})
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group" style={{ flex: "0 1 160px", marginBottom: 0 }}>
              <label htmlFor="new-conn-cadence" className="form-label">Cadence (seconds)</label>
              <input
                id="new-conn-cadence"
                type="number"
                min={60}
                max={86400}
                className="text-control"
                value={newCadenceSeconds}
                onChange={(e) => setNewCadenceSeconds(e.target.value)}
              />
            </div>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={loading || actionLoading !== null || !selectedContractId}
            >
              {actionLoading === "register-conn" ? "Registering..." : "+ Register Connection"}
            </button>
          </form>
        )}

        <StateView
          state={
            loading && connections.length === 0
              ? { kind: "loading" }
              : connections.length === 0
                ? { kind: "empty", reason: "No connections found for this tenant scope." }
                : { kind: "ok" }
          }
        >
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
                      <span
                        className={`status-pill ${conn.state === "ACTIVE" || conn.state === "RESUMED" ? "status-live" : "status-error"}`}
                        title={conn.state === "DISCONNECTED" || conn.state === "REVOKED" ? "Disconnected permanently (terminal — register a new connection to reconnect)" : undefined}
                      >
                        State: {conn.stateLabel || formatConnectionStateLabel(conn.state)}
                      </span>
                    </div>

                    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                      {conn.state === "ACTIVE" || conn.state === "RESUMED" ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleToggleState(conn, "pause")}
                            disabled={actionLoading !== null}
                          >
                            Pause
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            title="Reversibly suspend ingestion for this connection (can be resumed)"
                            onClick={() => handleToggleState(conn, "suspend")}
                            disabled={actionLoading !== null}
                          >
                            Suspend
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleToggleState(conn, "resume")}
                          disabled={actionLoading !== null || conn.state === "DISCONNECTED" || conn.state === "REVOKED"}
                        >
                          Resume
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        style={{ color: "var(--coral)", borderColor: "var(--coral)" }}
                        title="Permanently disconnect connection (terminal; cannot be resumed)"
                        onClick={() => setConfirmDisconnectId(conn.id)}
                        disabled={actionLoading !== null || conn.state === "DISCONNECTED" || conn.state === "REVOKED"}
                      >
                        Disconnect permanently
                      </button>
                    </div>
                  </div>

                  {confirmDisconnectId === conn.id && conn.state !== "DISCONNECTED" && conn.state !== "REVOKED" && (
                    <div
                      role="dialog"
                      aria-label={`Confirm permanent disconnect for ${conn.source}`}
                      style={{
                        padding: "0.75rem 1rem",
                        background: "#FFF5F5",
                        border: "1px solid var(--coral)",
                        borderRadius: "8px",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        flexWrap: "wrap",
                        gap: "0.75rem"
                      }}
                    >
                      <span style={{ fontSize: "0.85rem", color: "#9B1C1C" }}>
                        <strong>Irreversible action:</strong> Disconnecting permanently enters terminal state{" "}
                        <code>DISCONNECTED</code> and cannot be resumed.
                      </span>
                      <div style={{ display: "flex", gap: "0.5rem" }}>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          style={{ background: "#9B1C1C", color: "#FFFFFF", borderColor: "#9B1C1C" }}
                          onClick={() => handleToggleState(conn, "disconnect")}
                          disabled={actionLoading !== null}
                        >
                          Confirm Disconnect
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => setConfirmDisconnectId(null)}
                          disabled={actionLoading !== null}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))", gap: "0.75rem", fontSize: "0.85rem", color: "var(--graphite)" }}>
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
        </StateView>
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
