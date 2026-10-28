// frontend/src/components/Tabs/OrganizationsTab.tsx
import { useState } from "react";
import { api, ApiError, type Organization, PRESET_TENANTS } from "../../api/client";

interface OrganizationsTabProps {
  currentTenant: typeof PRESET_TENANTS[0];
  token: string | null;
  organizations: Organization[];
  onRefresh: () => void;
}

export function OrganizationsTab({
  currentTenant,
  token,
  organizations,
  onRefresh
}: OrganizationsTabProps) {
  const [orgName, setOrgName] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(`idem-${crypto.randomUUID().slice(0, 8)}`);
  const [injectProhibitedField, setInjectProhibitedField] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lastSubmission, setLastSubmission] = useState<{
    orgName: string;
    key: string;
    response: any;
  } | null>(null);
  const [feedback, setFeedback] = useState<{
    type: "success" | "conflict" | "error";
    message: string;
    details?: string;
  } | null>(null);

  const handleGenerateKey = () => {
    setIdempotencyKey(`idem-${crypto.randomUUID().slice(0, 8)}`);
  };

  const handleCreate = async (customPayload?: any, customKey?: string) => {
    setSubmitting(true);
    setFeedback(null);

    const keyToUse = customKey || idempotencyKey;
    const basePayload = { name: orgName || "Strategic Advisory Practice" };
    const payload = customPayload || (injectProhibitedField
      ? { ...basePayload, keystroke_tracker_payload: "ILLEGAL_SURVEILLANCE_FIELD" }
      : basePayload);

    try {
      const res = await api<Organization>("/api/v2/organizations", {
        method: "POST",
        token,
        idempotencyKey: keyToUse,
        body: JSON.stringify(payload)
      });

      setLastSubmission({
        orgName: payload.name,
        key: keyToUse,
        response: res
      });

      setFeedback({
        type: "success",
        message: `Successfully processed command via runCommand pipeline!`,
        details: `Org ID: ${res.id} | Name: "${res.name}" | Idempotency Key: "${keyToUse}"`
      });

      setOrgName("");
      onRefresh();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "CONFLICT") {
          setFeedback({
            type: "conflict",
            message: `409 CONFLICT: Idempotency Key collision with modified payload.`,
            details: `The server detected request hash mutation for key "${keyToUse}". Last-write-wins is strictly forbidden.`
          });
        } else if (err.code === "VALIDATION") {
          setFeedback({
            type: injectProhibitedField ? "success" : "error",
            message: injectProhibitedField
              ? `✔ CONSTITUTIONAL BOUNDARY DEFENDED (HTTP 400 VALIDATION)`
              : `400 VALIDATION ERROR: Schema rejected invalid/prohibited fields!`,
            details: `Schema strictly rejected unknown/prohibited fields (${injectProhibitedField ? "keystroke_tracker" : "invalid payload"}). Surveillance and keystroke tracking cannot enter persistence, staging, or logs.`
          });
        } else {
          setFeedback({
            type: "error",
            message: `[${err.code}] ${err.message}`,
            details: `Audit Request ID: ${err.requestId}`
          });
        }
      } else {
        setFeedback({
          type: "error",
          message: (err as Error).message
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Replay exact request with same key and same body
  const handleReplayExact = async () => {
    if (!lastSubmission) return;
    await handleCreate({ name: lastSubmission.orgName }, lastSubmission.key);
  };

  // Tamper request: send different body with same key to trigger 409 CONFLICT
  const handleTamperCollision = async () => {
    if (!lastSubmission) return;
    await handleCreate({ name: `${lastSubmission.orgName} [TAMPERED]` }, lastSubmission.key);
  };

  return (
    <div className="tab-pane">
      <div className="card">
        <div className="card-header">
          <div>
            <h3>Create Organization Unit (Domain S01)</h3>
            <p className="card-desc">
              Executes through the <code>runCommand</code> pipeline with strict Zod parsing, atomic idempotency claim, and transactional outbox emission.
            </p>
          </div>
          <span className="badge badge-aubergine">IDEMPOTENT PIPELINE</span>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleCreate();
          }}
          className="form-grid"
        >
          <div className="form-group">
            <label htmlFor="org-name" className="form-label">Organization / Practice Name:</label>
            <input
              id="org-name"
              type="text"
              className="text-control"
              placeholder="e.g. Commercial Litigation Group"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <div className="label-with-action">
              <label htmlFor="idempotency-key" className="form-label">Idempotency-Key Header:</label>
              <button
                type="button"
                className="btn-link"
                onClick={handleGenerateKey}
              >
                ⟳ Generate New Key
              </button>
            </div>
            <input
              id="idempotency-key"
              type="text"
              className="text-control monospace"
              value={idempotencyKey}
              onChange={(e) => setIdempotencyKey(e.target.value)}
              required
            />
          </div>

          <div className="form-checkbox-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={injectProhibitedField}
                onChange={(e) => setInjectProhibitedField(e.target.checked)}
              />
              <span><strong>Adversarial Test:</strong> Inject prohibited field (<code>keystroke_tracker</code>) to test Zod strict rejection</span>
            </label>
          </div>

          <div className="form-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting || !token}
            >
              {submitting ? "Executing Command..." : "Create Organization via runCommand"}
            </button>
          </div>
        </form>

        {feedback && (
          <div className={`feedback-alert alert-${feedback.type}`} role="alert">
            <div className="feedback-title">
              {feedback.type === "success" && "✔ COMMAND COMPLETED (SUCCESS)"}
              {feedback.type === "conflict" && "⚠ CONFLICT DETECTED (SAFE BEHAVIOR)"}
              {feedback.type === "error" && "✖ VALIDATION OR SECURITY REJECTION"}
            </div>
            <p>{feedback.message}</p>
            {feedback.details && <p className="feedback-details monospace">{feedback.details}</p>}
          </div>
        )}

        {lastSubmission && (
          <div className="idempotency-demo-panel">
            <h4>Live Idempotency Verification Controls:</h4>
            <p>
              Last submitted key: <code className="monospace">{lastSubmission.key}</code> for unit &ldquo;<strong>{lastSubmission.orgName}</strong>&rdquo;.
            </p>
            <div className="button-group">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleReplayExact}
                disabled={submitting}
              >
                ⟲ Replay Exact Same Request (Expect 200 Cached)
              </button>
              <button
                type="button"
                className="btn btn-warning btn-sm"
                onClick={handleTamperCollision}
                disabled={submitting}
              >
                ⚠ Tamper Payload with Same Key (Expect 409 Conflict)
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Active Tenant Organizations ({currentTenant.name})</h3>
          <span className="badge badge-dark">{organizations.length} Units</span>
        </div>
        <p className="card-desc">
          Only organizations belonging to <code>{currentTenant.name}</code> are listed below, guaranteed by PostgreSQL Row-Level Security.
        </p>

        {organizations.length === 0 ? (
          <p className="empty-text">No organization units registered yet for this tenant.</p>
        ) : (
          <div className="table-responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Unit Name</th>
                  <th>Organization ID</th>
                  <th>Tenant ID</th>
                  <th>Parent ID</th>
                </tr>
              </thead>
              <tbody>
                {organizations.map((org) => (
                  <tr key={org.id}>
                    <td><strong>{org.name}</strong></td>
                    <td className="monospace text-sm">{org.id}</td>
                    <td className="monospace text-sm">{org.tenant_id}</td>
                    <td className="monospace text-sm">{org.parent_id || "None (Root)"}</td>
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
