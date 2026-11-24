// frontend/src/components/Tabs/DashboardTab.tsx
// Completion Plan §7.2: Dedicated Dashboard screen mapped to /api/v2/me allowedNav "DASHBOARD".
// Displays system health badge, system info, active sector profile, and server-authorized workspace tiles.

import {
  type SystemHealth,
  type SystemInfo,
  type TenantInfo,
  type TenantSectorProfile
} from "../../api/client";
import { StateView, type ViewState } from "../StateView";
import { getSectorUi, isSectorPackActive } from "../../utils/vocabulary";

interface DashboardTabProps {
  health: SystemHealth | null;
  info: SystemInfo | null;
  tenantInfo: TenantInfo | null;
  sectorProfile: TenantSectorProfile | null;
  allowedNav: string[] | null;
  organizationCount: number;
  auditCount: number;
  loading: boolean;
  errorMsg: string | null;
  devTokenEnabled: boolean;
  onNavigate: (tab: string) => void;
}

interface TileConfig {
  navKey: string;
  tab: string;
  title: string;
  description: string;
  badge: string;
  devOnly?: boolean;
}

const WORKSPACE_TILES: TileConfig[] = [
  {
    navKey: "ORGANIZATIONS",
    tab: "organizations",
    title: "Organizations & Sector Settings",
    description: "Manage tenant units, idempotent commands, and active sector pack selection.",
    badge: "S01 Tenancy"
  },
  {
    navKey: "INGESTION",
    tab: "ingestion",
    title: "Connections & Work-State Ledger",
    description: "Manage allowlisted connectors, Suspend/Resume/Disconnect lifecycle, and minimization receipts.",
    badge: "S02 / S03"
  },
  {
    navKey: "COHORT_ANALYTICS",
    tab: "analytics",
    title: "Cohort Analytics & Privacy Release",
    description: "Compile k>=10 privacy-gated cohort releases and export CSVs through the single read path.",
    badge: "S04 / S06"
  },
  {
    navKey: "HAZARD_CONTROL",
    tab: "hazards",
    title: "Hazards & Control Verification",
    description: "Track hazards, reviewed causes, version-bound approvals, implementation evidence, and closure.",
    badge: "Plane A · S05/S07"
  },
  {
    navKey: "RETENTION",
    tab: "retention",
    title: "Retention, Holds & Rights",
    description: "Inspect jurisdiction packs, configure retention classes, legal holds, and subject erasure.",
    badge: "S10–S12"
  },
  {
    navKey: "BOUNDED_AI",
    tab: "ai",
    title: "Bounded AI & Action Proposals",
    description: "Generate citation-verified drafts with per-tenant quota guards; manual cycle always works offline.",
    badge: "S08 / S09"
  },
  {
    navKey: "OUTCOMES",
    tab: "outcomes",
    title: "Work-Design Outcomes & AI Change",
    description: "Evaluate Plane B work-design outcomes and 8-stage AI change assessments without touching Plane A.",
    badge: "Plane B"
  },
  {
    navKey: "OPS",
    tab: "operations",
    title: "Operations & Support Console",
    description: "Content-free diagnostic receipts, SLO telemetry, worker queue lag, and five independent kill switches.",
    badge: "B8 Ops"
  },
  {
    navKey: "VERIFIER",
    tab: "verifier",
    title: "Evidence & Merkle Verifier",
    description: "Issue and independently verify SHA-256 manifests and Merkle proofs in the browser.",
    badge: "Evidence"
  }
];

export function DashboardTab({
  health,
  info,
  tenantInfo,
  sectorProfile,
  allowedNav,
  organizationCount,
  auditCount,
  loading,
  errorMsg,
  devTokenEnabled,
  onNavigate
}: DashboardTabProps) {
  const isAllowed = (key: string) => !allowedNav || allowedNav.includes(key);

  const viewState: ViewState = loading && !health
    ? { kind: "loading" }
    : errorMsg && !health
      ? { kind: "failed", requestId: "health-check", message: errorMsg }
      : { kind: "ok" };

  const visibleTiles = WORKSPACE_TILES.filter(
    (t) => isAllowed(t.navKey) && (!t.devOnly || devTokenEnabled)
  );

  const sectorUi = getSectorUi(sectorProfile);

  return (
    <div className="tab-pane" id="dashboard-tab">
      <StateView state={viewState}>
        <div className="card">
          <div className="card-header">
            <div>
              <h2>Platform Dashboard</h2>
              <p className="card-desc">
                {info?.description || "Organizational work-design and psychosocial-risk infrastructure."}
              </p>
            </div>
            <span className={`badge ${health?.status === "ok" ? "badge-success" : "badge-coral"}`}>
              {health?.status === "ok" ? `SYSTEM HEALTHY · v${health.version}` : "SYSTEM DEGRADED"}
            </span>
          </div>

          <div
            className="stats-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))",
              gap: "1rem",
              marginTop: "0.75rem"
            }}
          >
            <div className="stat-card" style={{ padding: "0.85rem", border: "1px solid #E2E8F0", borderRadius: "6px" }}>
              <div className="text-sm text-muted">Active Tenant</div>
              <div style={{ fontWeight: 700, marginTop: "0.25rem" }}>{tenantInfo?.name || "Loading..."}</div>
              <div className="text-sm monospace">{tenantInfo?.region || "—"}</div>
            </div>
            <div className="stat-card" style={{ padding: "0.85rem", border: "1px solid #E2E8F0", borderRadius: "6px" }}>
              <div className="text-sm text-muted">Database &amp; Object Store</div>
              <div style={{ fontWeight: 700, marginTop: "0.25rem" }}>
                {health?.database?.mode === "postgres" ? "PostgreSQL (Forced RLS)" : "Sandbox Parity Store"}
              </div>
              <div className="text-sm monospace">
                Object store: {health?.objectStore?.mode?.toUpperCase() || "—"}
              </div>
            </div>
            <div className="stat-card" style={{ padding: "0.85rem", border: "1px solid #E2E8F0", borderRadius: "6px" }}>
              <div className="text-sm text-muted">Active Sector Pack</div>
              <div style={{ fontWeight: 700, marginTop: "0.25rem" }}>
                {isSectorPackActive(sectorProfile) ? sectorUi.navLabel : "Sector-Neutral Core (Generic)"}
              </div>
              <div className="text-sm monospace">{sectorProfile?.packKey || "generic-core"}</div>
            </div>
            <div className="stat-card" style={{ padding: "0.85rem", border: "1px solid #E2E8F0", borderRadius: "6px" }}>
              <div className="text-sm text-muted">Tenant Activity</div>
              <div style={{ fontWeight: 700, marginTop: "0.25rem" }}>{organizationCount} Organization(s)</div>
              <div className="text-sm monospace">{auditCount} Append-Only Audit Events</div>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop: "1rem" }}>
          <div className="card-header">
            <div>
              <h3>Authorized Workspaces</h3>
              <p className="card-desc">
                Navigation tiles are derived strictly from the server-computed principal profile (<code>GET /api/v2/me</code>).
              </p>
            </div>
            <span className="badge badge-aubergine">{visibleTiles.length} WORKSPACES</span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(min(270px, 100%), 1fr))",
              gap: "0.85rem",
              marginTop: "0.75rem"
            }}
          >
            {visibleTiles.map((tile) => (
              <button
                key={tile.tab}
                type="button"
                onClick={() => onNavigate(tile.tab)}
                style={{
                  textAlign: "left",
                  padding: "1rem",
                  borderRadius: "8px",
                  border: "1px solid #CBD5E1",
                  background: "#FFFFFF",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.4rem"
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", gap: "0.5rem" }}>
                  <strong style={{ color: "#1E1B4B", fontSize: "0.95rem" }}>{tile.title}</strong>
                  <span className="badge badge-dark">{tile.badge}</span>
                </div>
                <span style={{ fontSize: "0.82rem", color: "#475569", lineHeight: 1.4 }}>{tile.description}</span>
              </button>
            ))}
          </div>
        </div>
      </StateView>
    </div>
  );
}
