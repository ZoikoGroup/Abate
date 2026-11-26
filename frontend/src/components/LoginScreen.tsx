// frontend/src/components/LoginScreen.tsx
import { useState, type FormEvent } from "react";
import { PRESET_TENANTS, type OidcConfig, type SystemHealth } from "../api/client";

interface LoginScreenProps {
  devTokenEnabled: boolean;
  oidcConfig: OidcConfig | null;
  health: SystemHealth | null;
  loading: boolean;
  error: string | null;
  onTenantSignIn: (tenantId: string, role: string, subject?: string) => Promise<void>;
  onSuperAdminSignIn: (operator: string) => Promise<void>;
  onStartPkceLogin: () => Promise<void>;
  onExchangeOidcJwt: (jwt: string) => Promise<void>;
  onExchangeSuperAdminJwt?: (jwt: string) => Promise<void>;
  onOpenDemo?: () => void;
}

export function LoginScreen({
  devTokenEnabled,
  oidcConfig,
  health,
  loading,
  error,
  onTenantSignIn,
  onSuperAdminSignIn,
  onStartPkceLogin,
  onExchangeOidcJwt,
  onExchangeSuperAdminJwt,
  onOpenDemo
}: LoginScreenProps) {
  const [loginMode, setLoginMode] = useState<"TENANT" | "SUPER_ADMIN">("TENANT");
  const [selectedTenantId, setSelectedTenantId] = useState(PRESET_TENANTS[0].id);
  const [selectedRole, setSelectedRole] = useState("RISK_OWNER");
  const [subjectInput, setSubjectInput] = useState(PRESET_TENANTS[0].subject);
  const [operatorInput, setOperatorInput] = useState("superadmin@zoikoabate.dev");
  const [oidcJwtInput, setOidcJwtInput] = useState("");

  const handleTenantChange = (id: string) => {
    setSelectedTenantId(id);
    const preset = PRESET_TENANTS.find((t) => t.id === id);
    if (preset) setSubjectInput(preset.subject);
  };

  const handleDevTenantSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await onTenantSignIn(selectedTenantId, selectedRole, subjectInput.trim() || undefined);
  };

  const handleDevSuperAdminSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!operatorInput.trim()) return;
    await onSuperAdminSignIn(operatorInput.trim());
  };

  const handleOidcSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const raw = oidcJwtInput.trim();
    if (!raw) return;
    if (loginMode === "SUPER_ADMIN" && onExchangeSuperAdminJwt) {
      await onExchangeSuperAdminJwt(raw);
    } else {
      await onExchangeOidcJwt(raw);
    }
    setOidcJwtInput("");
  };

  return (
    <main className="main-content" style={{ maxWidth: 760, margin: "2rem auto" }}>
      <section className="card" aria-labelledby="login-heading">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.75rem", marginBottom: "1rem" }}>
          <div>
            <h1 id="login-heading" style={{ color: "#2B1B38", margin: 0 }}>
              {devTokenEnabled ? "Sign in to Zoiko Abate" : "Sign in with your Identity Provider"}
            </h1>
            <p style={{ margin: "0.25rem 0 0", color: "#2F343A", fontSize: "0.95rem" }}>
              Organizational work-design & psychosocial-risk assurance. <strong>Change the work. Not the worker.</strong>
            </p>
          </div>
          <span className={`badge ${health ? "badge-success" : "badge-coral"}`}>
            {health ? `API Connected (v${health.version})` : "API Unreachable"}
          </span>
        </div>

        <div className="tabs-navigation" role="tablist" aria-label="Authentication Portal Mode" style={{ marginBottom: "1.25rem", padding: 0, borderBottom: "1px solid #D9D2DD" }}>
          <button
            type="button"
            role="tab"
            aria-selected={loginMode === "TENANT"}
            className={`tab-button ${loginMode === "TENANT" ? "active" : ""}`}
            onClick={() => setLoginMode("TENANT")}
          >
            Tenant / Customer Workspace
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={loginMode === "SUPER_ADMIN"}
            className={`tab-button ${loginMode === "SUPER_ADMIN" ? "active" : ""}`}
            onClick={() => setLoginMode("SUPER_ADMIN")}
          >
            Super Admin / Platform Console
          </button>
        </div>

        {error && (
          <div className="error-banner" role="alert" style={{ marginBottom: "1rem" }}>
            <span>{error}</span>
          </div>
        )}

        {devTokenEnabled ? (
          loginMode === "TENANT" ? (
            <form onSubmit={(e) => void handleDevTenantSubmit(e)} style={{ display: "grid", gap: "1rem" }}>
              <div>
                <label htmlFor="login-tenant-select" className="context-label" style={{ display: "block", marginBottom: "0.35rem" }}>
                  Tenant Workspace
                </label>
                <select
                  id="login-tenant-select"
                  className="select-control"
                  style={{ width: "100%" }}
                  value={selectedTenantId}
                  onChange={(e) => handleTenantChange(e.target.value)}
                >
                  {PRESET_TENANTS.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} [{t.region}]
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="login-role-select" className="context-label" style={{ display: "block", marginBottom: "0.35rem" }}>
                  Authorized Domain Role
                </label>
                <select
                  id="login-role-select"
                  className="select-control"
                  style={{ width: "100%" }}
                  value={selectedRole}
                  onChange={(e) => setSelectedRole(e.target.value)}
                >
                  <option value="RISK_OWNER">Risk Owner (S05/S07 Hazards & Controls)</option>
                  <option value="CONTROL_OWNER">Control Owner (Implementation & Evidence)</option>
                  <option value="REVIEWER">Reviewer (Verification & Audit)</option>
                  <option value="EMPLOYER_ADMIN">Employer Admin (Org, Ingestion & Governance)</option>
                </select>
              </div>

              <div>
                <label htmlFor="login-subject-input" className="context-label" style={{ display: "block", marginBottom: "0.35rem" }}>
                  Principal Subject Identity
                </label>
                <input
                  id="login-subject-input"
                  type="text"
                  className="select-control"
                  style={{ width: "100%" }}
                  value={subjectInput}
                  onChange={(e) => setSubjectInput(e.target.value)}
                  required
                />
              </div>

              <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
                <button type="submit" className="btn btn-primary" disabled={loading}>
                  {loading ? "Signing in..." : "Sign In to Tenant Workspace"}
                </button>
                {onOpenDemo && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={onOpenDemo}
                    style={{ borderColor: "#A83828", color: "#A83828", fontWeight: 600 }}
                  >
                    ✨ Launch Guided Live Demo (12 Steps)
                  </button>
                )}
              </div>
            </form>
          ) : (
            <form onSubmit={(e) => void handleDevSuperAdminSubmit(e)} style={{ display: "grid", gap: "1rem" }}>
              <div className="info-banner" style={{ background: "#F5F2F8", borderLeft: "4px solid #2B1B38", padding: "0.75rem 1rem" }}>
                <strong>Zero-Impersonation Perimeter:</strong> Super Admin manages platform infrastructure, tenant lifecycle,
                role memberships, governance packs, feature flags, and kill switches. It cannot view workforce facts or bypass Privacy Release.
              </div>
              <div>
                <label htmlFor="login-operator-input" className="context-label" style={{ display: "block", marginBottom: "0.35rem" }}>
                  Platform Super Admin Identity
                </label>
                <input
                  id="login-operator-input"
                  type="text"
                  className="select-control"
                  style={{ width: "100%" }}
                  value={operatorInput}
                  onChange={(e) => setOperatorInput(e.target.value)}
                  placeholder="superadmin@zoikoabate.dev"
                  required
                />
              </div>
              <div>
                <button type="submit" className="btn btn-primary" disabled={loading || !operatorInput.trim()}>
                  {loading ? "Authenticating..." : "Sign In as Super Admin"}
                </button>
              </div>
            </form>
          )
        ) : (
          <div style={{ display: "grid", gap: "1rem" }}>
            <p style={{ margin: 0, color: "#2F343A" }}>
              Development token issuance is disabled. Authenticate via OIDC to establish an HttpOnly session.
            </p>
            {loginMode === "TENANT" && oidcConfig?.authorizationEndpoint && oidcConfig?.clientId && (
              <div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void onStartPkceLogin()}
                  disabled={loading}
                >
                  Continue with OIDC Provider (PKCE)
                </button>
              </div>
            )}
            <form onSubmit={(e) => void handleOidcSubmit(e)} style={{ display: "grid", gap: "0.75rem" }}>
              <div>
                <label htmlFor="oidc-jwt-input" className="context-label" style={{ display: "block", marginBottom: "0.35rem" }}>
                  {loginMode === "SUPER_ADMIN"
                    ? "Verified Super Admin OIDC Bearer JWT (audience: abate-api:support, scope: platform-super-admin)"
                    : "Verified OIDC ID / Access JWT (Pilot Session Exchange)"}
                </label>
                <input
                  id="oidc-jwt-input"
                  type="password"
                  className="select-control"
                  style={{ width: "100%" }}
                  value={oidcJwtInput}
                  onChange={(e) => setOidcJwtInput(e.target.value)}
                  placeholder="eyJhbGciOiJSUzI1NiIs..."
                  autoComplete="off"
                />
              </div>
              <button type="submit" className="btn btn-secondary" disabled={loading || !oidcJwtInput.trim()}>
                {loading ? "Verifying..." : loginMode === "SUPER_ADMIN" ? "Sign In as Super Admin" : "Exchange OIDC JWT for Session Cookie"}
              </button>
            </form>
          </div>
        )}
      </section>
    </main>
  );
}
