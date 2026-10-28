// frontend/src/components/Tabs/OutboxTab.tsx
import { useState } from "react";
import { api, type OutboxDrainReport, PRESET_TENANTS } from "../../api/client";

interface OutboxTabProps {
  currentTenant: typeof PRESET_TENANTS[0];
  onRefresh: () => void;
}

export function OutboxTab({ currentTenant, onRefresh }: OutboxTabProps) {
  const [draining, setDraining] = useState(false);
  const [drainReport, setDrainReport] = useState<OutboxDrainReport | null>(null);

  const handleDrain = async () => {
    setDraining(true);
    try {
      const res = await api<OutboxDrainReport>("/api/v2/outbox/drain", {
        method: "POST"
      });
      setDrainReport(res);
      onRefresh();
    } catch (err: any) {
      alert(`Outbox drain error: ${err.message}`);
    } finally {
      setDraining(false);
    }
  };

  return (
    <div className="tab-pane">
      <div className="card">
        <div className="card-header">
          <div>
            <h3>Transactional Outbox & Worker Pipeline</h3>
            <p className="card-desc">
              Route handlers never publish events directly to external queues or buses. After database commit, a process could crash before delivery. Instead, business state and outbox events commit together atomically in PostgreSQL.
            </p>
          </div>
          <span className="badge badge-aubergine">AT-LEAST-ONCE DELIVERY</span>
        </div>

        <div className="grid-2col">
          <div className="info-block">
            <h4>Outbox Guarantees</h4>
            <ul className="subrule-list">
              <li>
                <strong>Atomic Persistence:</strong> The <code>outbox_event</code> row is written inside the identical database transaction as the business change.
              </li>
              <li>
                <strong>Non-Blocking Workers:</strong> Worker repeatedly executes <code>SELECT ... FOR UPDATE SKIP LOCKED</code> so concurrent workers never deadlock or double-process rows.
              </li>
              <li>
                <strong>Consumer Inbox Deduplication:</strong> Downstream consumers write to <code>inbox_event (consumer, event_id)</code> with a primary key constraint to ensure idempotent handling.
              </li>
            </ul>
          </div>

          <div className="info-block">
            <h4>Trigger Outbox Worker</h4>
            <p>
              Simulate the background worker drain loop. The worker will select unpublished events, publish them across the event bus, and update <code>published_at = now()</code>.
            </p>
            <button 
              type="button" 
              className="btn btn-primary"
              onClick={handleDrain}
              disabled={draining}
            >
              {draining ? "Draining Outbox..." : "⟳ Trigger Worker Drain Loop"}
            </button>
          </div>
        </div>

        {drainReport && (
          <div className="feedback-alert alert-success" role="status">
            <div className="feedback-title">✔ DRAIN LOOP EXECUTED</div>
            <p>
              Drained <strong>{drainReport.report.drained}</strong> events. Successfully published <strong>{drainReport.report.published}</strong> events to downstream consumer inbox.
            </p>
            <p className="text-sm monospace">Completed at: {drainReport.timestamp}</p>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Event Envelope Specification</h3>
          <span className="badge badge-dark">CANONICAL CONTRACT</span>
        </div>
        <p className="card-desc">
          Every event emitted follows the canonical versioned <code>EventEnvelope</code> format, transmitting safe resource references without sensitive raw workforce data:
        </p>
        <pre className="code-block">
{`{
  "eventId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "tenantId": "${currentTenant.id}",
  "aggregate": "organization",
  "aggregateVersion": 1,
  "eventType": "organization.created",
  "schemaVersion": "v1.0",
  "purpose": "WORKPLACE_RISK_ASSESSMENT",
  "refs": ["organization/00000000-0000-4000-a001-000000000001"]
}`}
        </pre>
      </div>
    </div>
  );
}
