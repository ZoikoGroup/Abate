// frontend/src/App.tsx
import { useState, useEffect, useCallback } from "react";
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
import { ConstitutionalTab } from "./components/Tabs/ConstitutionalTab";
import { IsolationTab } from "./components/Tabs/IsolationTab";
import { OrganizationsTab } from "./components/Tabs/OrganizationsTab";
import { IngestionTab } from "./components/Tabs/IngestionTab";
import { CohortAnalyticsTab } from "./components/Tabs/CohortAnalyticsTab";
import { HazardControlTab } from "./components/Tabs/HazardControlTab";
import { OutboxTab } from "./components/Tabs/OutboxTab";
import { AuditTab } from "./components/Tabs/AuditTab";
import "./index.css";

type TabKey = "constitutional" | "isolation" | "organizations" | "ingestion" | "analytics" | "hazards" | "outbox" | "audit";

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
      />

      <nav className="tabs-navigation" aria-label="Abate Workspaces">
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
      </main>

      <footer className="app-footer">
        <p>
          Zoiko Abate &copy; 2026 &bull; Architecture Specification ZAB-ENG-001 v1.0 &bull; Two-Plane Separation Verified &bull; Synthetic Baseline ABATE-GOLDEN-01
        </p>
      </footer>
    </div>
  );
}
