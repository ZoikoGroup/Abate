// frontend/src/components/Tabs/AuditTab.tsx
import { type AuditEvent, PRESET_TENANTS } from "../../api/client";

interface AuditTabProps {
  currentTenant: typeof PRESET_TENANTS[0];
  auditEvents: AuditEvent[];
  onRefresh: () => void;
}

export function AuditTab({ currentTenant, auditEvents, onRefresh }: AuditTabProps) {
  return (
    <div className="tab-pane">
      <div className="card">
        <div className="card-header">
          <div>
            <h3>Append-Only Audit Trail (Domain S01 / S10)</h3>
            <p className="card-desc">
              Every state mutation records an immutable audit log entry in the identical transaction as the business change.
            </p>
          </div>
          <span className="badge badge-aubergine">APPEND-ONLY DB ROLE</span>
        </div>

        <div className="callout-info">
          <strong>Database Role Hardening:</strong> In migration <code>0011_reliability.sql</code>, the application role is explicitly revoked from updating or deleting rows:
          <pre className="inline-code">REVOKE UPDATE, DELETE ON audit_event FROM abate_app;</pre>
          Audit records can never be mutated, backdated, or purged by the application runtime.
        </div>

        <div className="table-header-bar">
          <h4>Tenant Audit Records ({auditEvents.length} Events)</h4>
          <button 
            type="button" 
            className="btn btn-secondary btn-sm"
            onClick={onRefresh}
          >
            ↻ Refresh Log
          </button>
        </div>

        {auditEvents.length === 0 ? (
          <p className="empty-text">No audit events recorded yet for {currentTenant.name}. Create an organization or run a command to produce audit receipts.</p>
        ) : (
          <div className="table-responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Event ID</th>
                  <th>Occurred At</th>
                  <th>Command</th>
                  <th>Purpose</th>
                  <th>Resource Type & ID</th>
                  <th>Result</th>
                  <th>Evidence Refs</th>
                </tr>
              </thead>
              <tbody>
                {auditEvents.map((evt) => (
                  <tr key={evt.id}>
                    <td className="monospace text-sm">#{evt.id}</td>
                    <td className="text-sm">{new Date(evt.occurred_at).toLocaleTimeString()}</td>
                    <td><span className="command-pill">{evt.command}</span></td>
                    <td className="text-sm">{evt.purpose}</td>
                    <td className="monospace text-sm">
                      {evt.resource_type} / {evt.resource_id.slice(0, 8)}...
                    </td>
                    <td>
                      <span className={`status-pill ${evt.result === "SUCCESS" ? "status-live" : "status-error"}`}>
                        {evt.result}
                      </span>
                    </td>
                    <td className="text-sm monospace">
                      {Array.isArray(evt.evidence_refs) ? evt.evidence_refs.join(", ") : JSON.stringify(evt.evidence_refs)}
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
