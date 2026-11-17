// frontend/src/App.tsx
import { useState, useEffect, useCallback, useRef, type FormEvent } from "react";
import {
  api,
  ApiError,
  requestToken,
  fetchOidcConfig,
  fetchCurrentPrincipal,
  exchangeOidcAuth,
  logoutSession,
  createPkceAuthorizationParams,
  COOKIE_SESSION_TOKEN,
  PRESET_TENANTS,
  type OidcConfig,
  type SystemHealth,
  type SystemInfo,
  type TenantInfo,
  type Organization,
  type AuditEvent
} from "./api/client";
import { Navbar } from "./components/Navbar";
import { ConstitutionalTab } from "./components/Tabs/ConstitutionalTab";
import { IsolationTab } from "./components/Tabs/IsolationTab";
import { OrganizationsTab } from "./components/Tabs/OrganizationsTab";
import { IngestionTab } from "./components/Tabs/IngestionTab";
import { CohortAnalyticsTab } from "./components/Tabs/CohortAnalyticsTab";
import { HazardControlTab } from "./components/Tabs/HazardControlTab";
import { RetentionTab } from "./components/Tabs/RetentionTab";
import { BoundedAiTab } from "./components/Tabs/BoundedAiTab";
import { OutcomesAiChangeTab } from "./components/Tabs/OutcomesAiChangeTab";
import { LegalPracticeTab } from "./components/Tabs/LegalPracticeTab";
import { OperationsTab } from "./components/Tabs/OperationsTab";
import { OutboxTab } from "./components/Tabs/OutboxTab";
import { AuditTab } from "./components/Tabs/AuditTab";
import { AuditVerifierTab } from "./components/Tabs/AuditVerifierTab";
import { LiveDemoConsole } from "./components/Demo/LiveDemoConsole";
import "./index.css";

type TabKey = "constitutional" | "isolation" | "organizations" | "ingestion" | "analytics" | "hazards" | "retention" | "ai" | "outcomes" | "legal" | "operations" | "outbox" | "audit" | "verifier";

export default function App() {
  const [activeTenantId, setActiveTenantId] = useState(PRESET_TENANTS[0].id);
  const [activeRole, setActiveRole] = useState("RISK_OWNER");
  const [activeTab, setActiveTab] = useState<TabKey>("organizations");

  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [oidcConfig, setOidcConfig] = useState<OidcConfig | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [authenticatedSubject, setAuthenticatedSubject] = useState<string | null>(null);
  const [requiresOidcLogin, setRequiresOidcLogin] = useState(false);
  const [oidcJwtInput, setOidcJwtInput] = useState("");
  const [oidcLoginError, setOidcLoginError] = useState<string | null>(null);
  const [tenantInfo, setTenantInfo] = useState<TenantInfo | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const oidcConfigRef = useRef<OidcConfig | null>(null);

  const devTokenEnabled = oidcConfig ? oidcConfig.devTokenEnabled : true;

  const [showDemoConsole, setShowDemoConsole] = useState(() => {
    if (typeof window !== "undefined") {
      return window.location.pathname.startsWith("/demo") || window.location.hash === "#demo";
    }
    return false;
  });

  const handleToggleDemo = (open: boolean) => {
    setShowDemoConsole(open);
    if (typeof window !== "undefined") {
      const newPath = open ? "/demo" : "/";
      if (window.location.pathname !== newPath) {
        window.history.pushState(null, "", newPath);
      }
    }
  };

  useEffect(() => {
    const onPopState = () => {
      setShowDemoConsole(
        window.location.pathname.startsWith("/demo") || window.location.hash === "#demo"
      );
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const currentTenant = PRESET_TENANTS.find(t => t.id === activeTenantId) || PRESET_TENANTS[0];

  // Load system-level metadata (health, info, and OIDC auth mode)
  const fetchSystemMetadata = useCallback(async (): Promise<OidcConfig | null> => {
    try {
      const [h, i, authCfg] = await Promise.all([
        api<SystemHealth>("/api/health"),
        api<SystemInfo>("/api/info"),
        fetchOidcConfig().catch(() => null)
      ]);
      setHealth(h);
      setInfo(i);
      if (authCfg) {
        oidcConfigRef.current = authCfg;
        setOidcConfig(authCfg);
      }
      setErrorMsg(null);
      return authCfg;
    } catch (err: any) {
      const ref = err instanceof ApiError && err.requestId ? ` [Request ID: ${err.requestId}]` : "";
      console.warn("Could not reach backend health endpoint:", err?.code || err?.message);
      setHealth(null);
      setErrorMsg(`Backend server appears unavailable. Ensure backend is running.${ref}`);
      return null;
    }
  }, []);

  const loadTenantWorkspace = useCallback(async (sessionToken: string) => {
    const [currTenant, orgs, audits] = await Promise.all([
      api<TenantInfo>("/api/v2/tenants/current", { token: sessionToken }),
      api<Organization[]>("/api/v2/organizations", { token: sessionToken }),
      api<AuditEvent[]>("/api/v2/audit-events", { token: sessionToken })
    ]);

    setTenantInfo(currTenant);
    setOrganizations(orgs);
    setAuditEvents(audits);
    setErrorMsg(null);
  }, []);

  // Authenticate (dev token in local/test, or OIDC PKCE/HttpOnly session cookie outside local/test) and load tenant-scoped data
  const fetchTenantData = useCallback(async (tenantId: string, role: string, resolvedAuthCfg?: OidcConfig | null) => {
    setLoading(true);
    const tenantPreset = PRESET_TENANTS.find(t => t.id === tenantId) || PRESET_TENANTS[0];

    try {
      const effectiveCfg = resolvedAuthCfg ?? oidcConfigRef.current ?? (await fetchOidcConfig().catch(() => null));
      if (effectiveCfg && !oidcConfigRef.current) {
        oidcConfigRef.current = effectiveCfg;
        setOidcConfig(effectiveCfg);
      }

      if (!effectiveCfg || effectiveCfg.devTokenEnabled) {
        // Local/test dev mode: issue signed dev token for selected persona
        const tokenResp = await requestToken(tenantPreset.id, tenantPreset.subject, role);
        setToken(tokenResp.token);
        setAuthenticatedSubject(tokenResp.subject);
        setRequiresOidcLogin(false);
        await loadTenantWorkspace(tokenResp.token);
      } else {
        // Pilot/hardened OIDC mode: never call /api/v2/auth/token
        if (typeof window !== "undefined") {
          const params = new URLSearchParams(window.location.search);
          const code = params.get("code");
          const state = params.get("state");
          if (code && state) {
            const expectedState = sessionStorage.getItem("abate_pkce_state");
            const codeVerifier = sessionStorage.getItem("abate_pkce_verifier") || "";
            sessionStorage.removeItem("abate_pkce_state");
            sessionStorage.removeItem("abate_pkce_verifier");
            window.history.replaceState(null, "", window.location.pathname);
            if (!expectedState || state !== expectedState || !codeVerifier) {
              throw new Error("OIDC login state mismatch. Please retry sign-in.");
            }
            await exchangeOidcAuth({
              code,
              codeVerifier,
              redirectUri: window.location.origin
            });
          }
        }

        try {
          const me = await fetchCurrentPrincipal();
          setActiveTenantId(me.tenantId);
          setActiveRole(me.role);
          setAuthenticatedSubject(me.subject);
          setToken(COOKIE_SESSION_TOKEN);
          setRequiresOidcLogin(false);
          setOidcLoginError(null);
          await loadTenantWorkspace(COOKIE_SESSION_TOKEN);
        } catch (authErr: any) {
          if (authErr?.status === 401) {
            setToken(null);
            setAuthenticatedSubject(null);
            setRequiresOidcLogin(true);
            setErrorMsg(null);
          } else {
            throw authErr;
          }
        }
      }
    } catch (err: any) {
      const ref = err instanceof ApiError && err.requestId ? ` [Request ID: ${err.requestId}]` : "";
      console.error("Error loading tenant data:", err?.code || err?.message);
      setErrorMsg(`Failed to load tenant data: ${err?.message || "Unexpected error"}${ref}`);
    } finally {
      setLoading(false);
    }
  }, [loadTenantWorkspace]);

  // Initial load & persona change refresh (in OIDC mode, role/tenant selection comes from the IdP claim)
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      const authCfg = await fetchSystemMetadata();
      if (cancelled) return;
      await fetchTenantData(activeTenantId, activeRole, authCfg);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchSystemMetadata, fetchTenantData, activeTenantId, activeRole]);

  const handleSelectTenant = (tenantId: string) => {
    setActiveTenantId(tenantId);
  };

  const handleSelectRole = (role: string) => {
    setActiveRole(role);
  };

  const handleRefreshAll = async () => {
    const authCfg = await fetchSystemMetadata();
    await fetchTenantData(activeTenantId, activeRole, authCfg);
  };

  const handleStartPkceLogin = async () => {
    if (!oidcConfig?.authorizationEndpoint || !oidcConfig?.clientId) return;
    setOidcLoginError(null);
    const pkce = await createPkceAuthorizationParams();
    sessionStorage.setItem("abate_pkce_state", pkce.state);
    sessionStorage.setItem("abate_pkce_verifier", pkce.verifier);
    const authUrl = new URL(oidcConfig.authorizationEndpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", oidcConfig.clientId);
    authUrl.searchParams.set("redirect_uri", window.location.origin);
    authUrl.searchParams.set("scope", oidcConfig.scope || "openid profile email");
    authUrl.searchParams.set("code_challenge", pkce.challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", pkce.state);
    window.location.assign(authUrl.toString());
  };

  const handleOidcTokenExchange = async (e: FormEvent) => {
    e.preventDefault();
    const raw = oidcJwtInput.trim();
    if (!raw) return;
    setLoading(true);
    setOidcLoginError(null);
    try {
      await exchangeOidcAuth({ idToken: raw });
      setOidcJwtInput("");
      await fetchTenantData(activeTenantId, activeRole, oidcConfig);
    } catch (err: any) {
      setOidcLoginError(err?.message || "OIDC verification failed.");
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    await logoutSession();
    setToken(null);
    setAuthenticatedSubject(null);
    setTenantInfo(null);
    setOrganizations([]);
    setAuditEvents([]);
    setRequiresOidcLogin(true);
  };

  if (showDemoConsole && devTokenEnabled) {
    return (
      <div className="app-container">
        <LiveDemoConsole onClose={() => handleToggleDemo(false)} />
      </div>
    );
  }

  return (
    <div className="app-container">
      <Navbar
        currentTenantId={activeTenantId}
        onSelectTenant={handleSelectTenant}
        currentRole={activeRole}
        onSelectRole={handleSelectRole}
        health={health}
        onRefresh={handleRefreshAll}
        loading={loading}
        onOpenDemo={devTokenEnabled ? () => handleToggleDemo(true) : undefined}
        devTokenEnabled={devTokenEnabled}
        authenticatedSubject={authenticatedSubject}
        onSignOut={handleSignOut}
      />

      {!devTokenEnabled && requiresOidcLogin ? (
        <main className="main-content">
          <section className="card" aria-labelledby="oidc-signin-heading" style={{ maxWidth: 640, margin: "2rem auto" }}>
            <h1 id="oidc-signin-heading" style={{ color: "#2B1B38", marginBottom: "0.75rem" }}>
              Sign in with your Identity Provider
            </h1>
            <p style={{ marginBottom: "1rem", color: "#2F343A" }}>
              Development token issuance is disabled in this environment. Authenticate via OIDC to establish an HttpOnly session.
            </p>
            {oidcLoginError && (
              <div className="error-banner" role="alert" style={{ marginBottom: "1rem" }}>
                <span>{oidcLoginError}</span>
              </div>
            )}
            {oidcConfig?.authorizationEndpoint && oidcConfig?.clientId && (
              <div style={{ marginBottom: "1.5rem" }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleStartPkceLogin()}
                  disabled={loading}
                >
                  Continue with OIDC Provider (PKCE)
                </button>
              </div>
            )}
            <form onSubmit={(e) => void handleOidcTokenExchange(e)}>
              <div style={{ marginBottom: "0.75rem" }}>
                <label htmlFor="oidc-jwt-input" className="context-label" style={{ display: "block", marginBottom: "0.35rem" }}>
                  Verified OIDC ID / Access JWT (Pilot Session Exchange)
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
                {loading ? "Verifying..." : "Exchange OIDC JWT for Session Cookie"}
              </button>
            </form>
          </section>
        </main>
      ) : (
        <>
          <nav className="tabs-navigation" aria-label="Abate Workspaces">
            {devTokenEnabled && (
              <button
                type="button"
                className="tab-button demo-tab-btn"
                onClick={() => handleToggleDemo(true)}
                style={{ borderColor: "#A83828", color: "#A83828", fontWeight: 700 }}
              >
                ✨ Live Demo Console
              </button>
            )}
        <button
          type="button"
          className={`tab-button ${activeTab === "organizations" ? "active" : ""}`}
          onClick={() => setActiveTab("organizations")}
        >
          Organizations & Idempotency
        </button>
        <button
          type="button"
          className={`tab-button ${activeTab === "ingestion" ? "active" : ""}`}
          onClick={() => setActiveTab("ingestion")}
        >
          Ingestion & Work Ledger (Phase 2)
        </button>
        <button
          type="button"
          className={`tab-button ${activeTab === "analytics" ? "active" : ""}`}
          onClick={() => setActiveTab("analytics")}
        >
          Cohort Analytics & Privacy (Phase 3)
        </button>
        <button
          type="button"
          className={`tab-button ${activeTab === "hazards" ? "active" : ""}`}
          onClick={() => setActiveTab("hazards")}
        >
          Hazards &amp; Controls (Phase 4)
        </button>
        <button
          type="button"
          className={`tab-button ${activeTab === "retention" ? "active" : ""}`}
          onClick={() => setActiveTab("retention")}
        >
          Retention &amp; Legal Hold (Phase 5)
        </button>
        <button
          type="button"
          className={`tab-button ${activeTab === "ai" ? "active" : ""}`}
          onClick={() => setActiveTab("ai")}
        >
          Bounded AI &amp; Actions (Phase 6)
        </button>
        <button
          type="button"
          className={`tab-button ${activeTab === "outcomes" ? "active" : ""}`}
          onClick={() => setActiveTab("outcomes")}
        >
          Outcomes &amp; AI Change (Phase 7)
        </button>
        <button
          type="button"
          className={`tab-button ${activeTab === "legal" ? "active" : ""}`}
          onClick={() => setActiveTab("legal")}
        >
          Legal Sector Pack (SRA 2023)
        </button>
        <button
          type="button"
          className={`tab-button ${activeTab === "operations" ? "active" : ""}`}
          onClick={() => setActiveTab("operations")}
        >
          Operations &amp; Support (B8)
        </button>
        <button
          type="button"
          className={`tab-button ${activeTab === "isolation" ? "active" : ""}`}
          onClick={() => setActiveTab("isolation")}
        >
          Tenant Isolation & Attack Lab
        </button>
        <button
          type="button"
          className={`tab-button ${activeTab === "outbox" ? "active" : ""}`}
          onClick={() => setActiveTab("outbox")}
        >
          Transactional Outbox
        </button>
        <button
          type="button"
          className={`tab-button ${activeTab === "audit" ? "active" : ""}`}
          onClick={() => setActiveTab("audit")}
        >
          Append-Only Audit Trail
        </button>
        <button
          type="button"
          className={`tab-button ${activeTab === "verifier" ? "active" : ""}`}
          onClick={() => setActiveTab("verifier")}
        >
          Audit Verifier &amp; Merkle
        </button>
        <button
          type="button"
          className={`tab-button ${activeTab === "constitutional" ? "active" : ""}`}
          onClick={() => setActiveTab("constitutional")}
        >
          Constitutional Invariants
        </button>
      </nav>

      <main className="app-main" id="content">
        {errorMsg && (
          <div className="feedback-alert alert-error" role="alert">
            <div className="feedback-title">Notice</div>
            <p>{errorMsg}</p>
          </div>
        )}

        {activeTab === "constitutional" && (
          <ConstitutionalTab health={health} info={info} />
        )}

        {activeTab === "isolation" && (
          <IsolationTab
            currentTenant={currentTenant}
            token={token}
            tenantInfo={tenantInfo}
            organizations={organizations}
          />
        )}

        {activeTab === "organizations" && (
          <OrganizationsTab
            currentTenant={currentTenant}
            token={token}
            organizations={organizations}
            onRefresh={() => fetchTenantData(activeTenantId, activeRole)}
          />
        )}

        {activeTab === "ingestion" && (
          <IngestionTab
            currentTenant={currentTenant}
            token={token}
            onRefresh={() => fetchTenantData(activeTenantId, activeRole)}
          />
        )}

        {activeTab === "analytics" && (
          <CohortAnalyticsTab
            currentTenant={currentTenant}
            token={token}
          />
        )}

        {activeTab === "hazards" && (
          <HazardControlTab
            currentTenant={currentTenant}
            token={token}
          />
        )}

        {activeTab === "retention" && (
          <RetentionTab
            currentTenant={currentTenant}
            token={token}
          />
        )}

        {activeTab === "ai" && (
          <BoundedAiTab
            currentTenant={currentTenant}
            token={token}
          />
        )}

        {activeTab === "outcomes" && (
          <OutcomesAiChangeTab
            currentTenant={currentTenant}
            token={token}
          />
        )}

        {activeTab === "legal" && (
          <LegalPracticeTab
            currentTenant={currentTenant}
            token={token}
          />
        )}

        {activeTab === "operations" && (
          <OperationsTab
            currentTenant={currentTenant}
            token={token}
          />
        )}

        {activeTab === "outbox" && (
          <OutboxTab
            currentTenant={currentTenant}
            onRefresh={() => fetchTenantData(activeTenantId, activeRole)}
          />
        )}

        {activeTab === "audit" && (
          <AuditTab
            currentTenant={currentTenant}
            auditEvents={auditEvents}
            onRefresh={() => fetchTenantData(activeTenantId, activeRole)}
          />
        )}

        {activeTab === "verifier" && (
          <AuditVerifierTab
            currentTenant={currentTenant}
            token={token}
          />
        )}
      </main>
        </>
      )}

      <footer className="app-footer">
        <p>
          Zoiko Abate &copy; 2026 &bull; Architecture Specification ZAB-ENG-001 v1.0 &bull; Two-Plane Separation Verified &bull; Synthetic Baseline ABATE-GOLDEN-01
        </p>
      </footer>
    </div>
  );
}
