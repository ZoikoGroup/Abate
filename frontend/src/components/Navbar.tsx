// frontend/src/components/Navbar.tsx
import { PRESET_TENANTS, type SystemHealth, type TenantWorkspaceItem } from "../api/client";

interface NavbarProps {
  currentTenantId: string;
  onSelectTenant: (tenantId: string) => void;
  currentRole: string;
  onSelectRole: (role: string) => void;
  health: SystemHealth | null;
  onRefresh: () => void;
  loading: boolean;
  onOpenDemo?: () => void;
  onOpenSuperAdmin?: () => void;
  devTokenEnabled?: boolean;
  authenticatedSubject?: string | null;
  onSignOut?: () => void;
  availableTenants?: TenantWorkspaceItem[];
  activeTenantName?: string | null;
}

export function Navbar({
  currentTenantId,
  onSelectTenant,
  currentRole,
  onSelectRole,
  health,
  onRefresh,
  loading,
  onOpenDemo,
  onOpenSuperAdmin,
  devTokenEnabled = true,
  authenticatedSubject = null,
  onSignOut,
  availableTenants = [],
  activeTenantName = null
}: NavbarProps) {
  const currentTenant = PRESET_TENANTS.find(t => t.id === currentTenantId) || PRESET_TENANTS[0];
  const tenantOptions = availableTenants.length > 0
    ? availableTenants.map((t) => ({ id: t.id, name: t.name, region: t.region }))
    : PRESET_TENANTS.map((t) => ({ id: t.id, name: t.name, region: t.region }));

  return (
    <header className="app-header">
      <div className="header-top">
        <div className="brand-group">
          <div className="brand-logo">
            <span className="logo-symbol">Ω</span>
          </div>
          <div>
            <div className="brand-title">ZOIKO ABATE</div>
            <div className="brand-subtitle">Workplace Psychosocial-Risk & Design Infrastructure</div>
          </div>
          <div className="mission-pill" title="Core Constitutional Philosophy">
            <span>Change the work. Not the worker.</span>
          </div>
        </div>

        <div className="header-status">
          {devTokenEnabled && onOpenDemo && (
            <button
              type="button"
              className="btn btn-primary btn-sm demo-launch-btn"
              onClick={onOpenDemo}
              aria-label="Launch Guided Live Demo Console"
              style={{ backgroundColor: "#A83828", color: "#FFFFFF", fontWeight: "bold" }}
            >
              ✨ Live Demo Console
            </button>
          )}
          {devTokenEnabled && onOpenSuperAdmin && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onOpenSuperAdmin}
              aria-label="Open Super Admin Console"
              style={{ borderColor: "#2B1B38", color: "#2B1B38", fontWeight: 600 }}
            >
              🛡️ Super Admin
            </button>
          )}
          {authenticatedSubject && onSignOut && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onSignOut}
              aria-label="Sign out of session"
            >
              Sign Out
            </button>
          )}
          <div className={`health-indicator ${health ? "online" : "offline"}`}>
            <span className="dot" />
            <span>{health ? `Backend Connected (v${health.version})` : "Backend Disconnected"}</span>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh live data"
          >
            {loading ? "Refreshing..." : "↻ Refresh"}
          </button>
        </div>
      </div>

      <div className="header-context-bar">
        {devTokenEnabled ? (
          <>
            <div className="context-item">
              <label htmlFor="tenant-select" className="context-label">Active Tenant Scope:</label>
              <select
                id="tenant-select"
                className="select-control"
                value={currentTenantId}
                onChange={(e) => onSelectTenant(e.target.value)}
              >
                {tenantOptions.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.name} [{t.region}]
                  </option>
                ))}
              </select>
            </div>

            <div className="context-item">
              <label htmlFor="role-select" className="context-label">Effective Domain Role:</label>
              <select
                id="role-select"
                className="select-control"
                value={currentRole}
                onChange={(e) => onSelectRole(e.target.value)}
              >
                <option value="RISK_OWNER">Risk Owner (S05/S07)</option>
                <option value="CONTROL_OWNER">Control Owner</option>
                <option value="REVIEWER">Reviewer</option>
                <option value="EMPLOYER_ADMIN">Employer Admin</option>
              </select>
            </div>

            <div className="context-item context-info">
              <span className="context-label">Principal Identity:</span>
              <span className="monospace-badge">{currentTenant.subject}</span>
            </div>
          </>
        ) : (
          <>
            <div className="context-item context-info">
              <span className="context-label">Active Tenant Scope:</span>
              {availableTenants.length > 1 ? (
                <select
                  id="oidc-tenant-select"
                  className="select-control"
                  value={currentTenantId}
                  onChange={(e) => onSelectTenant(e.target.value)}
                  aria-label="Switch active tenant workspace"
                >
                  {availableTenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} [{t.region}]
                    </option>
                  ))}
                </select>
              ) : (
                <span className="monospace-badge">{activeTenantName || currentTenantId || "Unauthenticated"}</span>
              )}
            </div>
            <div className="context-item context-info">
              <span className="context-label">Effective Domain Role:</span>
              <span className="monospace-badge">{currentRole || "None"}</span>
            </div>
            <div className="context-item context-info">
              <span className="context-label">OIDC Principal:</span>
              <span className="monospace-badge">{authenticatedSubject || "Not signed in"}</span>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
