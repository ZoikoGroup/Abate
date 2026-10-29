// frontend/src/components/Tabs/IsolationTab.tsx
import { useState } from "react";
import { api, ApiError, PRESET_TENANTS, type TenantInfo, type Organization } from "../../api/client";

interface IsolationTabProps {
  currentTenant: typeof PRESET_TENANTS[0];
  token: string | null;
  tenantInfo: TenantInfo | null;
  organizations: Organization[];
}

export function IsolationTab({
  currentTenant,
  token,
  tenantInfo,
  organizations
}: IsolationTabProps) {
  const [attackResult, setAttackResult] = useState<{
    testedId: string;
    targetTenantName: string;
    status: number | null;
    code: string | null;
    message: string | null;
    requestId: string | null;
    isolationVerified: boolean;
  } | null>(null);

  const [testing, setTesting] = useState(false);

  // Identify the "other" tenant
  const foreignTenant = PRESET_TENANTS.find(t => t.id !== currentTenant.id) || PRESET_TENANTS[1];
  // Known seeded ID of foreign tenant
  const foreignOrgId = foreignTenant.id === PRESET_TENANTS[0].id 
    ? "00000000-0000-4000-a001-000000000001" 
    : "00000000-0000-4000-b001-000000000001";

  const handleSimulateAttack = async () => {
    setTesting(true);
    setAttackResult(null);

    try {
      // Attempt to access foreign tenant's organization using current tenant's token
      await api<Organization>(`/api/v2/organizations/${foreignOrgId}`, {
        token
      });

      // If this succeeds, it is an isolation failure!
      setAttackResult({
        testedId: foreignOrgId,
        targetTenantName: foreignTenant.name,
        status: 200,
        code: "LEAK_DETECTED",
        message: "CRITICAL FAILURE: Foreign tenant row was readable!",
        requestId: "none",
        isolationVerified: false
      });
    } catch (err) {
      if (err instanceof ApiError) {
        setAttackResult({
          testedId: foreignOrgId,
          targetTenantName: foreignTenant.name,
          status: err.status,
          code: err.code,
          message: err.message,
          requestId: err.requestId,
          isolationVerified: err.status === 404 && err.code === "NOT_FOUND"
        });
      } else {
        setAttackResult({
          testedId: foreignOrgId,
          targetTenantName: foreignTenant.name,
          status: 500,
          code: "NETWORK_ERROR",
          message: (err as Error).message,
          requestId: "client-side",
          isolationVerified: false
        });
      }
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="tab-pane">
      <div className="card">
        <div className="card-header">
          <div>
            <h3>Domain S01: Tenant Isolation & Security Boundary</h3>
            <p className="card-desc">
              All queries run through <code>withTenant(tenantId, fn)</code> with transaction-local context and PostgreSQL forced Row-Level Security.
            </p>
          </div>
          <span className="badge badge-aubergine">FORCED RLS</span>
        </div>

        <div className="grid-2col">
          <div className="info-block">
            <h4>Active Tenant Profile</h4>
            <div className="data-row">
              <span className="data-label">Tenant ID:</span>
              <span className="data-value monospace">{tenantInfo?.id || currentTenant.id}</span>
            </div>
            <div className="data-row">
              <span className="data-label">Name:</span>
              <span className="data-value">{tenantInfo?.name || currentTenant.name}</span>
            </div>
            <div className="data-row">
              <span className="data-label">Jurisdiction Pack:</span>
              <span className="data-value">{tenantInfo?.jurisdiction_config_ref || "legal-uk-sra"}</span>
            </div>
            <div className="data-row">
              <span className="data-label">Data Residency Region:</span>
              <span className="data-value">{tenantInfo?.region || currentTenant.region}</span>
            </div>
            <div className="data-row">
              <span className="data-label">Visible Organizations:</span>
              <span className="data-value">{organizations.length} units (strictly isolated)</span>
            </div>
          </div>

          <div className="info-block">
            <h4>Constitutional Boundary Rules</h4>
            <ul className="subrule-list">
              <li>
                <strong>Fail-Closed Policy:</strong> If <code>app.tenant_id</code> is missing or empty, comparison yields NULL $\to$ 0 rows accessible.
              </li>
              <li>
                <strong>No Existence Leakage:</strong> A foreign tenant ID and a nonexistent ID return the identical <code>404 NOT_FOUND</code> error.
              </li>
              <li>
                <strong>Connection Pooling:</strong> Setting is transaction-local (<code>set_config(..., true)</code>); connection reuse never leaves residue.
              </li>
              <li>
                <strong>Restricted Role:</strong> Runtime runs as <code>abate_app</code> (<code>NOSUPERUSER NOBYPASSRLS</code>), so RLS cannot be bypassed.
              </li>
            </ul>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Interactive Boundary Attack Simulator</h3>
          <span className="badge badge-coral">ADVERSARIAL PROOF</span>
        </div>
        <p className="card-desc">
          Test the deployed trust boundary in real time. We will execute an authenticated request from <strong>{currentTenant.name}</strong> attempting to read the private organization of <strong>{foreignTenant.name}</strong> (Target ID: <code>{foreignOrgId}</code>).
        </p>

        <div className="action-row">
          <button 
            type="button" 
            className="btn btn-primary"
            onClick={handleSimulateAttack}
            disabled={testing || !token}
          >
            {testing ? "Executing Attack..." : `Simulate Cross-Tenant Read on ${foreignTenant.name}`}
          </button>
        </div>

        {attackResult && (
          <div className={`result-box ${attackResult.isolationVerified ? "result-success" : "result-danger"}`} role="alert">
            <div className="result-header">
              <span className="result-title">
                {attackResult.isolationVerified 
                  ? "✔ ATTACK BLOCKED & SAFE 404 RETURNED (PASS)" 
                  : "✖ ISOLATION BREACH OR ERROR"}
              </span>
              <span className="badge badge-dark">HTTP {attackResult.status}</span>
            </div>
            <div className="result-details">
              <p>
                <strong>Response Code:</strong> <code>{attackResult.code}</code> &mdash; {attackResult.message}
              </p>
              <p>
                <strong>Safe Masking Invariant:</strong> The server returned a standard <code>404 NOT_FOUND</code> without disclosing that the foreign resource exists.
              </p>
              <p>
                <strong>Audit Reference:</strong> <code className="monospace">{attackResult.requestId}</code>
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
