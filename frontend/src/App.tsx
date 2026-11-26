// frontend/src/App.tsx
import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import {
  api,
  ApiError,
  requestToken,
  fetchOidcConfig,
  fetchCurrentPrincipal,
  fetchTenants,
  fetchTenantSectorProfile,
  exchangeOidcAuth,
  logoutSession,
  createPkceAuthorizationParams,
  requestSuperAdminToken,
  COOKIE_SESSION_TOKEN,
  PRESET_TENANTS,
  type OidcConfig,
  type TenantSectorProfile,
  type TenantWorkspaceItem,
  type SystemHealth,
  type SystemInfo,
  type TenantInfo,
  type Organization,
  type AuditEvent
} from "./api/client";
import { Navbar } from "./components/Navbar";
import { LoginScreen } from "./components/LoginScreen";
import { StateView } from "./components/StateView";
import { OrganizationsTab } from "./components/Tabs/OrganizationsTab";
import { getSectorUi, isSectorPackActive } from "./utils/vocabulary";
import "./index.css";

const SuperAdminConsole = lazy(() => import("./components/SuperAdmin/SuperAdminConsole").then((m) => ({ default: m.SuperAdminConsole })));

const DashboardTab = lazy(() => import("./components/Tabs/DashboardTab").then((m) => ({ default: m.DashboardTab })));
const ConstitutionalTab = lazy(() => import("./components/Tabs/ConstitutionalTab").then((m) => ({ default: m.ConstitutionalTab })));
const IsolationTab = lazy(() => import("./components/Tabs/IsolationTab").then((m) => ({ default: m.IsolationTab })));
const IngestionTab = lazy(() => import("./components/Tabs/IngestionTab").then((m) => ({ default: m.IngestionTab })));
const CohortAnalyticsTab = lazy(() => import("./components/Tabs/CohortAnalyticsTab").then((m) => ({ default: m.CohortAnalyticsTab })));
const HazardControlTab = lazy(() => import("./components/Tabs/HazardControlTab").then((m) => ({ default: m.HazardControlTab })));
const RetentionTab = lazy(() => import("./components/Tabs/RetentionTab").then((m) => ({ default: m.RetentionTab })));
const BoundedAiTab = lazy(() => import("./components/Tabs/BoundedAiTab").then((m) => ({ default: m.BoundedAiTab })));
const OutcomesAiChangeTab = lazy(() => import("./components/Tabs/OutcomesAiChangeTab").then((m) => ({ default: m.OutcomesAiChangeTab })));
const SectorPackTab = lazy(() => import("./components/Tabs/SectorPackTab").then((m) => ({ default: m.SectorPackTab })));
const OperationsTab = lazy(() => import("./components/Tabs/OperationsTab").then((m) => ({ default: m.OperationsTab })));
const OutboxTab = lazy(() => import("./components/Tabs/OutboxTab").then((m) => ({ default: m.OutboxTab })));
const AuditTab = lazy(() => import("./components/Tabs/AuditTab").then((m) => ({ default: m.AuditTab })));
const AuditVerifierTab = lazy(() => import("./components/Tabs/AuditVerifierTab").then((m) => ({ default: m.AuditVerifierTab })));
const LiveDemoConsole = lazy(() => import("./components/Demo/LiveDemoConsole").then((m) => ({ default: m.LiveDemoConsole })));

type TabKey = "dashboard" | "constitutional" | "isolation" | "organizations" | "ingestion" | "analytics" | "hazards" | "retention" | "ai" | "outcomes" | "sector" | "operations" | "outbox" | "audit" | "verifier";

const VALID_TAB_KEYS: readonly TabKey[] = [
  "dashboard",
  "constitutional",
  "isolation",
  "organizations",
  "ingestion",
  "analytics",
  "hazards",
  "retention",
  "ai",
  "outcomes",
  "sector",
  "operations",
  "outbox",
  "audit",
  "verifier"
];

function parseTabFromHash(): TabKey | null {
  if (typeof window === "undefined") return null;
  const match = window.location.hash.match(/^#tab=([a-z]+)$/i);
  if (!match) return null;
  const candidate = match[1].toLowerCase() as TabKey;
  return VALID_TAB_KEYS.includes(candidate) ? candidate : null;
}

export default function App() {
  const [activeTenantId, setActiveTenantId] = useState(PRESET_TENANTS[0].id);
  const [activeRole, setActiveRole] = useState("RISK_OWNER");
  const [activeTab, setActiveTabState] = useState<TabKey>(() => parseTabFromHash() || "organizations");

  const setActiveTab = useCallback((next: TabKey | ((prev: TabKey) => TabKey)) => {
    setActiveTabState((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      if (typeof window !== "undefined" && window.location.hash !== `#tab=${resolved}` && !window.location.pathname.startsWith("/demo")) {
        window.history.replaceState(null, "", `${window.location.pathname}#tab=${resolved}`);
      }
      return resolved;
    });
  }, []);

  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [oidcConfig, setOidcConfig] = useState<OidcConfig | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [authenticatedSubject, setAuthenticatedSubject] = useState<string | null>(null);
  const [requiresOidcLogin, setRequiresOidcLogin] = useState(false);
  const [explicitLoginScreen, setExplicitLoginScreen] = useState(() => {
    if (typeof window !== "undefined") {
      return window.location.pathname === "/login" || window.location.hash === "#login";
    }
    return false;
  });
  const [superAdminToken, setSuperAdminToken] = useState<string | null>(null);
  const [superAdminOperator, setSuperAdminOperator] = useState<string | null>(null);
  const [oidcLoginError, setOidcLoginError] = useState<string | null>(null);
  const [tenantInfo, setTenantInfo] = useState<TenantInfo | null>(null);
  const [availableTenants, setAvailableTenants] = useState<TenantWorkspaceItem[]>([]);
  const [sectorProfile, setSectorProfile] = useState<TenantSectorProfile | null>(null);
  const [allowedNav, setAllowedNav] = useState<string[] | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const oidcConfigRef = useRef<OidcConfig | null>(null);

  const devTokenEnabled = oidcConfig ? oidcConfig.devTokenEnabled : true;
  const isNavAllowed = (navKey: string): boolean => !allowedNav || allowedNav.includes(navKey);

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
      const fromHash = parseTabFromHash();
      if (fromHash) setActiveTabState(fromHash);
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("hashchange", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("hashchange", onPopState);
    };
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
    const [currTenant, orgs, audits, secProfile, me, tenantsList] = await Promise.all([
      api<TenantInfo>("/api/v2/tenants/current", { token: sessionToken }),
      api<Organization[]>("/api/v2/organizations", { token: sessionToken }),
      api<AuditEvent[]>("/api/v2/audit-events", { token: sessionToken }),
      fetchTenantSectorProfile(sessionToken).catch(() => null),
      fetchCurrentPrincipal(sessionToken).catch(() => null),
      fetchTenants(sessionToken).catch(() => [])
    ]);

    setTenantInfo(currTenant);
    setOrganizations(orgs);
    setAuditEvents(audits);
    setSectorProfile(secProfile);
    setAvailableTenants(tenantsList);
    setAllowedNav(Array.isArray(me?.allowedNav) ? me.allowedNav : null);
    if (secProfile && !isSectorPackActive(secProfile)) {
      setActiveTab(prev => (prev === "sector" ? "organizations" : prev));
    }
    setErrorMsg(null);
  }, [setActiveTab]);

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

  const handleOidcJwtExchange = async (rawJwt: string) => {
    const raw = rawJwt.trim();
    if (!raw) return;
    setLoading(true);
    setOidcLoginError(null);
    try {
      await exchangeOidcAuth({ idToken: raw });
      setExplicitLoginScreen(false);
      await fetchTenantData(activeTenantId, activeRole, oidcConfig);
    } catch (err: any) {
      setOidcLoginError(err?.message || "OIDC verification failed.");
    } finally {
      setLoading(false);
    }
  };

  const handleTenantSignIn = async (tenantId: string, role: string, subject?: string) => {
    setLoading(true);
    setOidcLoginError(null);
    try {
      const preset = PRESET_TENANTS.find((t) => t.id === tenantId) || PRESET_TENANTS[0];
      const tokenResp = await requestToken(tenantId, subject || preset.subject, role);
      setActiveTenantId(tenantId);
      setActiveRole(role);
      setToken(tokenResp.token);
      setAuthenticatedSubject(tokenResp.subject);
      setSuperAdminToken(null);
      setSuperAdminOperator(null);
      setExplicitLoginScreen(false);
      setRequiresOidcLogin(false);
      await loadTenantWorkspace(tokenResp.token);
    } catch (err: any) {
      setOidcLoginError(err?.message || "Tenant sign-in failed.");
    } finally {
      setLoading(false);
    }
  };

  const handleSuperAdminSignIn = async (operator: string) => {
    setLoading(true);
    setOidcLoginError(null);
    try {
      const resp = await requestSuperAdminToken(operator);
      setSuperAdminToken(resp.token);
      setSuperAdminOperator(resp.operator);
      setToken(null);
      setAuthenticatedSubject(null);
      setExplicitLoginScreen(false);
    } catch (err: any) {
      setOidcLoginError(err?.message || "Super Admin sign-in failed.");
    } finally {
      setLoading(false);
    }
  };

  const handleExchangeSuperAdminJwt = async (jwt: string) => {
    setSuperAdminToken(jwt.trim());
    setSuperAdminOperator("oidc-super-admin");
    setToken(null);
    setAuthenticatedSubject(null);
    setExplicitLoginScreen(false);
  };

  const handleSignOut = async () => {
    await logoutSession();
    setToken(null);
    setAuthenticatedSubject(null);
    setSuperAdminToken(null);
    setSuperAdminOperator(null);
    setTenantInfo(null);
    setOrganizations([]);
    setAuditEvents([]);
    setRequiresOidcLogin(true);
    setExplicitLoginScreen(true);
  };

  if (showDemoConsole && devTokenEnabled) {
    return (
      <div className="app-container">
        <Suspense fallback={<StateView state={{ kind: "loading", message: "Loading live demo console..." }} />}>
          <LiveDemoConsole onClose={() => handleToggleDemo(false)} />
        </Suspense>
      </div>
    );
  }

  if (superAdminToken && superAdminOperator) {
    return (
      <Suspense fallback={<StateView state={{ kind: "loading", message: "Loading Super Admin Console..." }} />}>
        <SuperAdminConsole
          adminToken={superAdminToken}
          operator={superAdminOperator}
          onSignOut={() => void handleSignOut()}
        />
      </Suspense>
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
        onOpenSuperAdmin={devTokenEnabled ? () => void handleSuperAdminSignIn("superadmin@zoikoabate.dev") : undefined}
        devTokenEnabled={devTokenEnabled}
        authenticatedSubject={authenticatedSubject}
        onSignOut={() => void handleSignOut()}
        availableTenants={availableTenants}
        activeTenantName={tenantInfo?.name || null}
      />

      {explicitLoginScreen || (!devTokenEnabled && requiresOidcLogin) ? (
        <LoginScreen
          devTokenEnabled={devTokenEnabled}
          oidcConfig={oidcConfig}
          health={health}
          loading={loading}
          error={oidcLoginError}
          onTenantSignIn={handleTenantSignIn}
          onSuperAdminSignIn={handleSuperAdminSignIn}
          onStartPkceLogin={handleStartPkceLogin}
          onExchangeOidcJwt={handleOidcJwtExchange}
          onExchangeSuperAdminJwt={handleExchangeSuperAdminJwt}
          onOpenDemo={devTokenEnabled ? () => handleToggleDemo(true) : undefined}
        />
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
            {isNavAllowed("DASHBOARD") && (
              <button
                type="button"
                className={`tab-button ${activeTab === "dashboard" ? "active" : ""}`}
                onClick={() => setActiveTab("dashboard")}
              >
                Dashboard
              </button>
            )}
            {isNavAllowed("ORGANIZATIONS") && (
              <button
                type="button"
                className={`tab-button ${activeTab === "organizations" ? "active" : ""}`}
                onClick={() => setActiveTab("organizations")}
              >
                {devTokenEnabled ? "Organizations & Idempotency" : "Organizations"}
              </button>
            )}
            {isNavAllowed("INGESTION") && (
              <button
                type="button"
                className={`tab-button ${activeTab === "ingestion" ? "active" : ""}`}
                onClick={() => setActiveTab("ingestion")}
              >
                {devTokenEnabled ? "Ingestion & Work Ledger (Phase 2)" : "Connections & Work Ledger"}
              </button>
            )}
            {isNavAllowed("COHORT_ANALYTICS") && (
              <button
                type="button"
                className={`tab-button ${activeTab === "analytics" ? "active" : ""}`}
                onClick={() => setActiveTab("analytics")}
              >
                {devTokenEnabled ? "Cohort Analytics & Privacy (Phase 3)" : "Cohort Analytics & Privacy"}
              </button>
            )}
            {isNavAllowed("HAZARD_CONTROL") && (
              <button
                type="button"
                className={`tab-button ${activeTab === "hazards" ? "active" : ""}`}
                onClick={() => setActiveTab("hazards")}
              >
                {devTokenEnabled ? "Hazards & Controls (Phase 4)" : "Hazards & Controls"}
              </button>
            )}
            {isNavAllowed("RETENTION") && (
              <button
                type="button"
                className={`tab-button ${activeTab === "retention" ? "active" : ""}`}
                onClick={() => setActiveTab("retention")}
              >
                {devTokenEnabled ? "Retention & Legal Hold (Phase 5)" : "Retention, Holds & Rights"}
              </button>
            )}
            {isNavAllowed("BOUNDED_AI") && (
              <button
                type="button"
                className={`tab-button ${activeTab === "ai" ? "active" : ""}`}
                onClick={() => setActiveTab("ai")}
              >
                {devTokenEnabled ? "Bounded AI & Actions (Phase 6)" : "Bounded AI & Actions"}
              </button>
            )}
            {isNavAllowed("OUTCOMES") && (
              <button
                type="button"
                className={`tab-button ${activeTab === "outcomes" ? "active" : ""}`}
                onClick={() => setActiveTab("outcomes")}
              >
                {devTokenEnabled ? "Outcomes & AI Change (Phase 7)" : "Work-Design Outcomes & AI Change"}
              </button>
            )}
            {isSectorPackActive(sectorProfile) && (isNavAllowed("SECTOR_PACK") || isNavAllowed("LEGAL_PRACTICE")) && (
              <button
                type="button"
                className={`tab-button ${activeTab === "sector" ? "active" : ""}`}
                onClick={() => setActiveTab("sector")}
              >
                {getSectorUi(sectorProfile).navLabel}
              </button>
            )}
            {isNavAllowed("OPS") && (
              <button
                type="button"
                className={`tab-button ${activeTab === "operations" ? "active" : ""}`}
                onClick={() => setActiveTab("operations")}
              >
                {devTokenEnabled ? "Operations & Support (B8)" : "Operations & Support"}
              </button>
            )}
            {devTokenEnabled && isNavAllowed("ISOLATION") && (
              <button
                type="button"
                className={`tab-button ${activeTab === "isolation" ? "active" : ""}`}
                onClick={() => setActiveTab("isolation")}
              >
                Tenant Isolation & Attack Lab
              </button>
            )}
            {devTokenEnabled && isNavAllowed("OUTBOX") && (
              <button
                type="button"
                className={`tab-button ${activeTab === "outbox" ? "active" : ""}`}
                onClick={() => setActiveTab("outbox")}
              >
                Transactional Outbox
              </button>
            )}
            {isNavAllowed("AUDIT") && (
              <button
                type="button"
                className={`tab-button ${activeTab === "audit" ? "active" : ""}`}
                onClick={() => setActiveTab("audit")}
              >
                Append-Only Audit Trail
              </button>
            )}
            {isNavAllowed("VERIFIER") && (
              <button
                type="button"
                className={`tab-button ${activeTab === "verifier" ? "active" : ""}`}
                onClick={() => setActiveTab("verifier")}
              >
                Audit Verifier &amp; Merkle
              </button>
            )}
            {isNavAllowed("CONSTITUTIONAL") && (
              <button
                type="button"
                className={`tab-button ${activeTab === "constitutional" ? "active" : ""}`}
                onClick={() => setActiveTab("constitutional")}
              >
                Constitutional Invariants
              </button>
            )}
          </nav>

          <main className="app-main" id="content">
            {errorMsg && (
              <div className="feedback-alert alert-error" role="alert">
                <div className="feedback-title">Notice</div>
                <p>{errorMsg}</p>
              </div>
            )}

            <Suspense fallback={<StateView state={{ kind: "loading", message: "Loading workspace view..." }} />}>
            {activeTab === "dashboard" && (
              <DashboardTab
                health={health}
                info={info}
                tenantInfo={tenantInfo}
                sectorProfile={sectorProfile}
                allowedNav={allowedNav}
                organizationCount={organizations.length}
                auditCount={auditEvents.length}
                loading={loading}
                errorMsg={errorMsg}
                devTokenEnabled={devTokenEnabled}
                onNavigate={(next) => setActiveTab(next as TabKey)}
              />
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
                sectorProfile={sectorProfile}
                onSectorProfileChange={setSectorProfile}
                onRefresh={() => fetchTenantData(activeTenantId, activeRole)}
              />
            )}

            {activeTab === "ingestion" && (
              <IngestionTab
                currentTenant={currentTenant}
                token={token}
                sectorProfile={sectorProfile}
                onRefresh={() => fetchTenantData(activeTenantId, activeRole)}
              />
            )}

            {activeTab === "analytics" && (
              <CohortAnalyticsTab
                currentTenant={currentTenant}
                token={token}
                sectorProfile={sectorProfile}
              />
            )}

            {activeTab === "hazards" && (
              <HazardControlTab
                currentTenant={currentTenant}
                token={token}
                sectorProfile={sectorProfile}
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
                devTokenEnabled={devTokenEnabled}
              />
            )}

            {activeTab === "outcomes" && (
              <OutcomesAiChangeTab
                currentTenant={currentTenant}
                token={token}
              />
            )}

            {activeTab === "sector" && sectorProfile && isSectorPackActive(sectorProfile) && (
              <SectorPackTab
                key={sectorProfile.sectorKey}
                currentTenant={currentTenant}
                token={token}
                sectorProfile={sectorProfile}
              />
            )}

            {activeTab === "operations" && (
              <OperationsTab
                currentTenant={currentTenant}
                token={token}
                devTokenEnabled={devTokenEnabled}
              />
            )}

            {activeTab === "outbox" && (
              <OutboxTab
                token={token}
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
            </Suspense>
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
