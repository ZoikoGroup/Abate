// frontend/src/App.tsx
import { useState, useEffect, useCallback, lazy, Suspense } from "react";
import {
  api,
  requestToken,
  PRESET_TENANTS,
  type SystemHealth,
  type SystemInfo,
  type TenantInfo,
  type Organization,
  type AuditEvent
} from "./api/client";
import { Navbar } from "./components/Navbar";
import { OrganizationsTab } from "./components/Tabs/OrganizationsTab";
import "./index.css";

// Code-split: each workspace tab (and the demo console) loads on first use. OrganizationsTab is the default tab, so it stays eager.
const ConstitutionalTab = lazy(() => import("./components/Tabs/ConstitutionalTab").then((m) => ({ default: m.ConstitutionalTab })));
const IsolationTab = lazy(() => import("./components/Tabs/IsolationTab").then((m) => ({ default: m.IsolationTab })));
const IngestionTab = lazy(() => import("./components/Tabs/IngestionTab").then((m) => ({ default: m.IngestionTab })));
const CohortAnalyticsTab = lazy(() => import("./components/Tabs/CohortAnalyticsTab").then((m) => ({ default: m.CohortAnalyticsTab })));
const HazardControlTab = lazy(() => import("./components/Tabs/HazardControlTab").then((m) => ({ default: m.HazardControlTab })));
const RetentionTab = lazy(() => import("./components/Tabs/RetentionTab").then((m) => ({ default: m.RetentionTab })));
const BoundedAiTab = lazy(() => import("./components/Tabs/BoundedAiTab").then((m) => ({ default: m.BoundedAiTab })));
const OutcomesAiChangeTab = lazy(() => import("./components/Tabs/OutcomesAiChangeTab").then((m) => ({ default: m.OutcomesAiChangeTab })));
const LegalPracticeTab = lazy(() => import("./components/Tabs/LegalPracticeTab").then((m) => ({ default: m.LegalPracticeTab })));
const OperationsTab = lazy(() => import("./components/Tabs/OperationsTab").then((m) => ({ default: m.OperationsTab })));
const OutboxTab = lazy(() => import("./components/Tabs/OutboxTab").then((m) => ({ default: m.OutboxTab })));
const AuditTab = lazy(() => import("./components/Tabs/AuditTab").then((m) => ({ default: m.AuditTab })));
const LiveDemoConsole = lazy(() => import("./components/Demo/LiveDemoConsole").then((m) => ({ default: m.LiveDemoConsole })));

const PaneFallback = () => (
  <div role="status" aria-live="polite" style={{ padding: "2rem", textAlign: "center", color: "var(--muted-text)" }}>
    Loading workspace…
  </div>
);

type TabKey = "constitutional" | "isolation" | "organizations" | "ingestion" | "analytics" | "hazards" | "retention" | "ai" | "outcomes" | "legal" | "operations" | "outbox" | "audit";

export default function App() {
  const [activeTenantId, setActiveTenantId] = useState(PRESET_TENANTS[0].id);
  const [activeRole, setActiveRole] = useState("RISK_OWNER");
  const [activeTab, setActiveTab] = useState<TabKey>("organizations");

  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [tenantInfo, setTenantInfo] = useState<TenantInfo | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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

  // Load system-level metadata (health & info)
  const fetchSystemMetadata = useCallback(async () => {
    try {
      const [h, i] = await Promise.all([
        api<SystemHealth>("/api/health"),
        api<SystemInfo>("/api/info")
      ]);
      setHealth(h);
      setInfo(i);
      setErrorMsg(null);
    } catch (err: any) {
      console.warn("Could not reach backend health endpoint:", err.message);
      setHealth(null);
      setErrorMsg("Backend server appears offline at http://localhost:5000. Start backend to view live data.");
    }
  }, []);

  // Authenticate and load tenant-scoped data
  const fetchTenantData = useCallback(async (tenantId: string, role: string) => {
    setLoading(true);
    const tenantPreset = PRESET_TENANTS.find(t => t.id === tenantId) || PRESET_TENANTS[0];

    try {
      // 1. Issue signed token for this tenant and principal
      const tokenResp = await requestToken(tenantPreset.id, tenantPreset.subject, role);
      setToken(tokenResp.token);

      // 2. Query tenant-scoped endpoints using the Bearer token
      const [currTenant, orgs, audits] = await Promise.all([
        api<TenantInfo>("/api/v2/tenants/current", { token: tokenResp.token }),
        api<Organization[]>("/api/v2/organizations", { token: tokenResp.token }),
        api<AuditEvent[]>("/api/v2/audit-events", { token: tokenResp.token })
      ]);

      setTenantInfo(currTenant);
      setOrganizations(orgs);
      setAuditEvents(audits);
      setErrorMsg(null);
    } catch (err: any) {
      console.error("Error loading tenant data:", err);
      setErrorMsg(`Failed to load tenant data: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchSystemMetadata();
    fetchTenantData(activeTenantId, activeRole);
  }, [fetchSystemMetadata, fetchTenantData, activeTenantId, activeRole]);

  const handleSelectTenant = (tenantId: string) => {
    setActiveTenantId(tenantId);
  };

  const handleSelectRole = (role: string) => {
    setActiveRole(role);
  };

  const handleRefreshAll = () => {
    fetchSystemMetadata();
    fetchTenantData(activeTenantId, activeRole);
  };

  if (showDemoConsole) {
    return (
      <div className="app-container">
        <Suspense fallback={<PaneFallback />}>
          <LiveDemoConsole onClose={() => handleToggleDemo(false)} />
        </Suspense>
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
        onOpenDemo={() => handleToggleDemo(true)}
      />

      <nav className="tabs-navigation" aria-label="Abate Workspaces">
        <button
          type="button"
          className="tab-button demo-tab-btn"
          onClick={() => handleToggleDemo(true)}
          style={{ borderColor: "var(--abate-coral, #E26D5A)", color: "#E26D5A", fontWeight: 700 }}
        >
          ✨ Live Demo Console
        </button>
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

        <Suspense fallback={<PaneFallback />}>
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
            token={token}
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
        </Suspense>
      </main>

      <footer className="app-footer">
        <p>
          Zoiko Abate &copy; 2026 &bull; Architecture Specification ZAB-ENG-001 v1.0 &bull; Two-Plane Separation Verified &bull; Synthetic Baseline ABATE-GOLDEN-01
        </p>
      </footer>
    </div>
  );
}
