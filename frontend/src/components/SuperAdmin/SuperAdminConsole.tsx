// frontend/src/components/SuperAdmin/SuperAdminConsole.tsx
import { useState, useEffect, useCallback, type FormEvent } from "react";
import {
  fetchAdminOverview,
  fetchAdminTenants,
  createAdminTenant,
  updateAdminTenant,
  setAdminTenantState,
  setAdminTenantSectorPack,
  fetchAdminTenantPrincipals,
  assignAdminMembership,
  revokeAdminMembership,
  fetchAdminGovernance,
  fetchAdminFeatureFlags,
  setAdminFeatureFlag,
  fetchAdminAudit,
  fetchKillSwitchesOps,
  setKillSwitch,
  fetchOpsJobs,
  replayDeadLetter,
  fetchReleaseDossier,
  lookupOpsRequest,
  fetchOpsErrors,
  type AdminOverview,
  type AdminTenantRecord,
  type AdminPrincipalMembership,
  type AdminGovernancePack,
  type AdminFeatureFlagRecord,
  type AdminPlatformAuditEvent,
  type KillSwitchRecord,
  type OpsJobsOverview,
  type OpsRequestRecord,
  type SafeErrorLogEntry
} from "../../api/client";
import { StateView } from "../StateView";

interface SuperAdminConsoleProps {
  adminToken: string;
  operator: string;
  onSignOut: () => void;
}

type AdminSection = "overview" | "tenants" | "users" | "governance" | "operations" | "evidence";
type Feedback = { kind: "success" | "error"; title: string; message: string } | null;

const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toISOString().slice(0, 19).replace("T", " ") + " UTC" : "—";

export function SuperAdminConsole({ adminToken, operator, onSignOut }: SuperAdminConsoleProps) {
  const [section, setSection] = useState<AdminSection>("overview");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [tenants, setTenants] = useState<AdminTenantRecord[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<string>("");
  const [principals, setPrincipals] = useState<AdminPrincipalMembership[]>([]);
  const [governancePacks, setGovernancePacks] = useState<AdminGovernancePack[]>([]);
  const [featureFlags, setFeatureFlags] = useState<AdminFeatureFlagRecord[]>([]);
  const [auditEvents, setAuditEvents] = useState<AdminPlatformAuditEvent[]>([]);
  const [killSwitches, setKillSwitches] = useState<KillSwitchRecord[]>([]);
  const [opsJobs, setOpsJobs] = useState<OpsJobsOverview | null>(null);
  const [opsErrors, setOpsErrors] = useState<SafeErrorLogEntry[]>([]);
  const [dossier, setDossier] = useState<any | null>(null);

  // Tenant forms
  const [tenantSearch, setTenantSearch] = useState("");
  const [newTenantName, setNewTenantName] = useState("");
  const [newTenantRegion, setNewTenantRegion] = useState("eu-west-2");
  const [newTenantSector, setNewTenantSector] = useState("LEGAL");
  const [editingTenant, setEditingTenant] = useState<AdminTenantRecord | null>(null);
  const [editName, setEditName] = useState("");
  const [editRegion, setEditRegion] = useState("");
  const [editJurisdiction, setEditJurisdiction] = useState("");

  // Membership form
  const [newSubject, setNewSubject] = useState("");
  const [newKind, setNewKind] = useState<"USER" | "WORKLOAD">("USER");
  const [newRole, setNewRole] = useState<"RISK_OWNER" | "CONTROL_OWNER" | "REVIEWER" | "EMPLOYER_ADMIN">("RISK_OWNER");

  // Feature flag form
  const [flagTenantId, setFlagTenantId] = useState<string>("");
  const [flagName, setFlagName] = useState<"planeBOutcomes" | "aiWorkDesign" | "aiProposals">("planeBOutcomes");
  const [flagEnabled, setFlagEnabled] = useState(true);
  const [flagReason, setFlagReason] = useState("Super Admin configuration update");

  // Kill switch & DLQ confirmation
  const [pendingSwitch, setPendingSwitch] = useState<{ scope: string; nextActive: boolean } | null>(null);
  const [switchReason, setSwitchReason] = useState("");
  const [pendingReplayId, setPendingReplayId] = useState<string | null>(null);
  const [replayReason, setReplayReason] = useState("Operator verified downstream consumer health");
  const [lookupReqId, setLookupReqId] = useState("");
  const [lookupRecord, setLookupRecord] = useState<OpsRequestRecord | null>(null);

  const act = async (title: string, fn: () => Promise<string>) => {
    setBusy(true);
    try {
      const msg = await fn();
      setFeedback({ kind: "success", title, message: msg });
    } catch (err: any) {
      setFeedback({
        kind: "error",
        title: `Refused [${err.code ?? "ERROR"}]`,
        message: err.requestId ? `${err.message} (requestId ${err.requestId})` : err.message
      });
    } finally {
      setBusy(false);
    }
  };

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      const [ov, ts, gov, ff, aud, ks, oj, errs, dos] = await Promise.all([
        fetchAdminOverview(adminToken),
        fetchAdminTenants(adminToken),
        fetchAdminGovernance(adminToken),
        fetchAdminFeatureFlags(adminToken),
        fetchAdminAudit(adminToken),
        fetchKillSwitchesOps(adminToken).catch(() => []),
        fetchOpsJobs(adminToken).catch(() => null),
        fetchOpsErrors(adminToken).catch(() => []),
        fetchReleaseDossier()
      ]);
      setOverview(ov);
      setTenants(ts.items);
      setGovernancePacks(gov.sectorPacks);
      setFeatureFlags(ff.items);
      setAuditEvents(aud.items);
      setKillSwitches(ks);
      setOpsJobs(oj);
      setOpsErrors(errs);
      setDossier(dos);
      if (!selectedTenantId && ts.items.length > 0) {
        setSelectedTenantId(ts.items[0].id);
        setFlagTenantId(ts.items[0].id);
      }
    } catch (err: any) {
      setFeedback({ kind: "error", title: "Failed to load Super Admin console", message: err.message });
    } finally {
      setLoading(false);
    }
  }, [adminToken, selectedTenantId]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!selectedTenantId) return;
    void fetchAdminTenantPrincipals(selectedTenantId, adminToken)
      .then((res) => setPrincipals(res.items))
      .catch(() => setPrincipals([]));
  }, [selectedTenantId, adminToken]);

  const handleCreateTenant = (e: FormEvent) => {
    e.preventDefault();
    if (!newTenantName.trim()) return;
    void act("Tenant created", async () => {
      const created = await createAdminTenant(
        { name: newTenantName.trim(), region: newTenantRegion.trim(), sectorKey: newTenantSector },
        adminToken
      );
      setNewTenantName("");
      await refreshAll();
      setSelectedTenantId(created.id);
      return `Created tenant "${created.name}" (${created.id.slice(0, 8)}...) in ${created.region} with ${created.sectorKey} pack.`;
    });
  };

  const handleSaveEditTenant = (e: FormEvent) => {
    e.preventDefault();
    if (!editingTenant) return;
    void act("Tenant updated", async () => {
      await updateAdminTenant(
        editingTenant.id,
        { name: editName.trim(), region: editRegion.trim(), jurisdictionConfigRef: editJurisdiction.trim() || null },
        adminToken
      );
      setEditingTenant(null);
      await refreshAll();
      return `Updated metadata for tenant ${editName}.`;
    });
  };

  const handleToggleTenantState = (t: AdminTenantRecord) => {
    const nextState = t.state === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
    void act(`Tenant ${nextState.toLowerCase()}`, async () => {
      await setAdminTenantState(t.id, nextState, `Super Admin toggled tenant to ${nextState}`, adminToken);
      await refreshAll();
      return `Tenant "${t.name}" is now ${nextState}.`;
    });
  };

  const handleAssignMembership = (e: FormEvent) => {
    e.preventDefault();
    if (!selectedTenantId || !newSubject.trim()) return;
    void act("Role membership assigned", async () => {
      const created = await assignAdminMembership(
        selectedTenantId,
        { externalSubject: newSubject.trim(), kind: newKind, domainRole: newRole },
        adminToken
      );
      setNewSubject("");
      const res = await fetchAdminTenantPrincipals(selectedTenantId, adminToken);
      setPrincipals(res.items);
      const aud = await fetchAdminAudit(adminToken);
      setAuditEvents(aud.items);
      return `Assigned ${created.domainRole} to ${created.externalSubject}.`;
    });
  };

  const handleRevokeMembership = (membershipId: string) => {
    if (!selectedTenantId) return;
    void act("Membership revoked", async () => {
      await revokeAdminMembership(selectedTenantId, membershipId, "Revoked via Super Admin Console", adminToken);
      const res = await fetchAdminTenantPrincipals(selectedTenantId, adminToken);
      setPrincipals(res.items);
      const aud = await fetchAdminAudit(adminToken);
      setAuditEvents(aud.items);
      return `Revoked membership ${membershipId.slice(0, 8)}...`;
    });
  };

  const handleSetFeatureFlag = (e: FormEvent) => {
    e.preventDefault();
    void act("Feature flag updated", async () => {
      await setAdminFeatureFlag(
        { tenantId: flagTenantId || null, flag: flagName, enabled: flagEnabled, reason: flagReason },
        adminToken
      );
      await refreshAll();
      return `Flag '${flagName}' set to ${flagEnabled ? "ENABLED" : "DISABLED"} for ${flagTenantId || "global"}.`;
    });
  };

  const handleConfirmKillSwitch = () => {
    if (!pendingSwitch || switchReason.trim().length < 5) return;
    const { scope, nextActive } = pendingSwitch;
    void act(`Kill switch updated: ${scope}`, async () => {
      await setKillSwitch(scope, nextActive, adminToken, switchReason.trim());
      setPendingSwitch(null);
      setSwitchReason("");
      await refreshAll();
      return `Kill switch '${scope}' is now ${nextActive ? "ACTIVE" : "INACTIVE"}.`;
    });
  };

  const handleConfirmReplay = () => {
    if (!pendingReplayId || replayReason.trim().length < 5) return;
    const id = pendingReplayId;
    void act(`Dead-letter replayed (${id.slice(0, 8)}...)`, async () => {
      const res = await replayDeadLetter(id, replayReason.trim(), adminToken);
      setPendingReplayId(null);
      await refreshAll();
      return `Replayed ${res.deadLetterId.slice(0, 8)}... back to PENDING outbox.`;
    });
  };

  const filteredTenants = tenants.filter(
    (t) =>
      t.name.toLowerCase().includes(tenantSearch.toLowerCase()) ||
      t.region.toLowerCase().includes(tenantSearch.toLowerCase()) ||
      t.id.toLowerCase().includes(tenantSearch.toLowerCase())
  );

  const alertList = overview
    ? (Array.isArray(overview.alerts) ? overview.alerts : ((overview.alerts as any)?.alerts ?? []))
    : [];

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-top">
          <div className="brand-group">
            <div className="brand-logo"><span className="logo-symbol">Ω</span></div>
            <div>
              <h1 className="brand-title" style={{ margin: 0 }}>ZOIKO ABATE — SUPER ADMIN</h1>
              <div className="brand-subtitle">Platform Operations, Tenant Lifecycle & Governance Console</div>
            </div>
            <div className="mission-pill"><span>Zero-Impersonation Perimeter</span></div>
          </div>
          <div className="header-status">
            <span className="monospace-badge">{operator} [SUPER_ADMIN]</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refreshAll()} disabled={loading || busy}>
              {loading ? "Refreshing..." : "↻ Refresh"}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onSignOut}>
              Sign Out
            </button>
          </div>
        </div>
      </header>

      <nav className="tabs-navigation" aria-label="Super Admin Sections">
        {([
          ["overview", "Platform Overview"],
          ["tenants", "Tenant Management"],
          ["users", "Users & Access"],
          ["governance", "Governance & Flags"],
          ["operations", "Worker & Kill Switches"],
          ["evidence", "Evidence & Dossier"]
        ] as Array<[AdminSection, string]>).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`tab-button ${section === key ? "active" : ""}`}
            onClick={() => setSection(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="main-content">
        {feedback && (
          <div className={feedback.kind === "error" ? "error-banner" : "success-banner"} role="status" style={{ marginBottom: "1rem" }}>
            <strong>{feedback.title}:</strong> {feedback.message}
          </div>
        )}

        {loading && !overview ? (
          <StateView state={{ kind: "loading", message: "Loading Super Admin telemetry..." }} />
        ) : null}

        {section === "overview" && overview && (
          <section className="card">
            <h2>Platform Overview</h2>
            <p className="muted">
              Perimeter: <strong>{overview.perimeter}</strong> — Super Admin manages platform metadata only and cannot query tenant workforce or protected measurement tables.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "1rem", marginTop: "1rem" }}>
              <div className="stat-box"><strong>Total Tenants</strong><div>{overview.counts.totalTenants} ({overview.counts.activeTenants} active / {overview.counts.suspendedTenants} suspended)</div></div>
              <div className="stat-box"><strong>Database</strong><div>{overview.system.databaseOk ? "PostgreSQL Connected" : "In-Memory Fallback"}</div></div>
              <div className="stat-box"><strong>Object Store</strong><div>{overview.system.objectStoreOk ? `Healthy (${overview.system.objectStoreMode})` : "Degraded"}</div></div>
              <div className="stat-box"><strong>Worker Queue</strong><div>{overview.system.workerState} · {overview.counts.pendingOutbox} pending · {overview.counts.deadLetterCount} DLQ</div></div>
              <div className="stat-box"><strong>SLO Window</strong><div>{overview.slo.overall} ({overview.slo.window.requests} reqs)</div></div>
              <div className="stat-box"><strong>Admin Audit Events</strong><div>{overview.counts.platformAuditCount} immutable entries</div></div>
            </div>

            <h3 style={{ marginTop: "1.5rem" }}>Active Operational Alerts</h3>
            {alertList.length === 0 ? (
              <p className="muted">No active operational alerts.</p>
            ) : (
              <table className="data-table">
                <thead><tr><th>Rule</th><th>Severity</th><th>State</th><th>Detail</th></tr></thead>
                <tbody>
                  {alertList.map((a: any, idx: number) => {
                    const sev = String(a.severity || "").toUpperCase();
                    const stateText = a.state ?? (a.firing ? "FIRING" : "OK");
                    const detail = a.summary ?? a.message ?? "";
                    return (
                      <tr key={a.id ?? idx}>
                        <td>{a.id}</td>
                        <td><span className={`badge ${sev === "CRITICAL" ? "badge-coral" : "badge-dark"}`}>{sev}</span></td>
                        <td>{stateText}</td>
                        <td>{detail}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        )}

        {section === "tenants" && (
          <section className="card">
            <h2>Tenant Management</h2>
            <form onSubmit={handleCreateTenant} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr auto", gap: "0.75rem", alignItems: "end", marginBottom: "1.5rem" }}>
              <div>
                <label htmlFor="admin-new-tenant-name" className="context-label">New Tenant Name</label>
                <input id="admin-new-tenant-name" className="select-control" style={{ width: "100%" }} value={newTenantName} onChange={(e) => setNewTenantName(e.target.value)} placeholder="Acme Legal LLP" required />
              </div>
              <div>
                <label htmlFor="admin-new-tenant-region" className="context-label">Region</label>
                <input id="admin-new-tenant-region" className="select-control" style={{ width: "100%" }} value={newTenantRegion} onChange={(e) => setNewTenantRegion(e.target.value)} required />
              </div>
              <div>
                <label htmlFor="admin-new-tenant-sector" className="context-label">Sector Pack</label>
                <select id="admin-new-tenant-sector" className="select-control" style={{ width: "100%" }} value={newTenantSector} onChange={(e) => setNewTenantSector(e.target.value)}>
                  <option value="LEGAL">Legal</option>
                  <option value="GENERIC">Generic (Core)</option>
                  <option value="ACCOUNTING">Accounting</option>
                </select>
              </div>
              <button type="submit" className="btn btn-primary" disabled={busy}>Create Tenant</button>
            </form>

            {editingTenant && (
              <form onSubmit={handleSaveEditTenant} className="card" style={{ background: "#F8F6FA", marginBottom: "1rem" }}>
                <h3>Edit Tenant: {editingTenant.name}</h3>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto auto", gap: "0.5rem", alignItems: "end" }}>
                  <div>
                    <label htmlFor="admin-edit-name" className="context-label">Name</label>
                    <input id="admin-edit-name" className="select-control" value={editName} onChange={(e) => setEditName(e.target.value)} required />
                  </div>
                  <div>
                    <label htmlFor="admin-edit-region" className="context-label">Region</label>
                    <input id="admin-edit-region" className="select-control" value={editRegion} onChange={(e) => setEditRegion(e.target.value)} required />
                  </div>
                  <div>
                    <label htmlFor="admin-edit-jurisdiction" className="context-label">Jurisdiction Ref</label>
                    <input id="admin-edit-jurisdiction" className="select-control" value={editJurisdiction} onChange={(e) => setEditJurisdiction(e.target.value)} />
                  </div>
                  <button type="submit" className="btn btn-primary" disabled={busy}>Save</button>
                  <button type="button" className="btn btn-secondary" onClick={() => setEditingTenant(null)}>Cancel</button>
                </div>
              </form>
            )}

            <div style={{ marginBottom: "0.75rem" }}>
              <input
                type="search"
                className="select-control"
                placeholder="Search tenants by name, region, or ID..."
                value={tenantSearch}
                onChange={(e) => setTenantSearch(e.target.value)}
                style={{ width: "100%", maxWidth: 360 }}
              />
            </div>

            <table className="data-table">
              <thead>
                <tr><th>Tenant Name</th><th>Region</th><th>State</th><th>Sector Pack</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {filteredTenants.map((t) => (
                  <tr key={t.id}>
                    <td><strong>{t.name}</strong><br /><small className="monospace-badge">{t.id}</small></td>
                    <td>{t.region}</td>
                    <td><span className={`badge ${t.state === "ACTIVE" ? "badge-success" : "badge-coral"}`}>{t.state}</span></td>
                    <td>
                      <select
                        className="select-control"
                        value={t.sectorKey}
                        aria-label={`Sector pack for ${t.name}`}
                        onChange={(e) => {
                          const val = e.target.value;
                          void act("Sector pack updated", async () => {
                            await setAdminTenantSectorPack(t.id, val, adminToken);
                            await refreshAll();
                            return `Set ${t.name} sector pack to ${val}.`;
                          });
                        }}
                      >
                        <option value="LEGAL">LEGAL</option>
                        <option value="GENERIC">GENERIC</option>
                        <option value="ACCOUNTING">ACCOUNTING</option>
                      </select>
                    </td>
                    <td style={{ display: "flex", gap: "0.5rem" }}>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          setEditingTenant(t);
                          setEditName(t.name);
                          setEditRegion(t.region);
                          setEditJurisdiction(t.jurisdictionConfigRef || "");
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleToggleTenantState(t)}
                        disabled={busy}
                      >
                        {t.state === "ACTIVE" ? "Suspend" : "Activate"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {section === "users" && (
          <section className="card">
            <h2>Users, Principals & Role Memberships</h2>
            <div style={{ marginBottom: "1rem" }}>
              <label htmlFor="admin-user-tenant-select" className="context-label">Select Tenant: </label>
              <select id="admin-user-tenant-select" className="select-control" value={selectedTenantId} onChange={(e) => setSelectedTenantId(e.target.value)}>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name} [{t.region}]</option>)}
              </select>
            </div>

            <form onSubmit={handleAssignMembership} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr auto", gap: "0.75rem", alignItems: "end", marginBottom: "1.25rem" }}>
              <div>
                <label htmlFor="admin-new-subject" className="context-label">Subject Identifier</label>
                <input id="admin-new-subject" className="select-control" style={{ width: "100%" }} value={newSubject} onChange={(e) => setNewSubject(e.target.value)} placeholder="auth0|user-new-reviewer" required />
              </div>
              <div>
                <label htmlFor="admin-new-kind" className="context-label">Kind</label>
                <select id="admin-new-kind" className="select-control" style={{ width: "100%" }} value={newKind} onChange={(e) => setNewKind(e.target.value as "USER" | "WORKLOAD")}>
                  <option value="USER">USER</option>
                  <option value="WORKLOAD">WORKLOAD</option>
                </select>
              </div>
              <div>
                <label htmlFor="admin-new-role" className="context-label">Domain Role</label>
                <select id="admin-new-role" className="select-control" style={{ width: "100%" }} value={newRole} onChange={(e) => setNewRole(e.target.value as any)}>
                  <option value="RISK_OWNER">RISK_OWNER</option>
                  <option value="CONTROL_OWNER">CONTROL_OWNER</option>
                  <option value="REVIEWER">REVIEWER</option>
                  <option value="EMPLOYER_ADMIN">EMPLOYER_ADMIN</option>
                </select>
              </div>
              <button type="submit" className="btn btn-primary" disabled={busy}>Assign Role</button>
            </form>

            <table className="data-table">
              <thead><tr><th>Subject</th><th>Kind</th><th>Role</th><th>Status</th><th>Valid From</th><th>Action</th></tr></thead>
              <tbody>
                {principals.map((p) => (
                  <tr key={p.membershipId}>
                    <td className="monospace-badge">{p.externalSubject}</td>
                    <td>{p.kind}</td>
                    <td><strong>{p.domainRole}</strong></td>
                    <td><span className={`badge ${p.active ? "badge-success" : "badge-dark"}`}>{p.active ? "ACTIVE" : "REVOKED"}</span></td>
                    <td>{fmt(p.validFrom)}</td>
                    <td>
                      {p.active && (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleRevokeMembership(p.membershipId)} disabled={busy}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3 style={{ marginTop: "1.5rem" }}>Immutable Platform Audit Log</h3>
            <table className="data-table">
              <thead><tr><th>Time</th><th>Operator</th><th>Action</th><th>Target</th><th>Reason</th></tr></thead>
              <tbody>
                {auditEvents.map((a) => (
                  <tr key={a.id}>
                    <td>{fmt(a.occurred_at)}</td>
                    <td>{a.operator}</td>
                    <td><code>{a.action}</code></td>
                    <td>{a.target_type}: {a.target_id.slice(0, 18)}</td>
                    <td>{a.reason || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {section === "governance" && (
          <section className="card">
            <h2>Governance Packs & Feature Flags</h2>
            <h3>Registered Sector & Jurisdiction Packs</h3>
            <table className="data-table" style={{ marginBottom: "1.5rem" }}>
              <thead><tr><th>Sector Key</th><th>Display Name</th><th>Status</th><th>Review Status</th><th>Version</th></tr></thead>
              <tbody>
                {governancePacks.map((gp) => (
                  <tr key={gp.sectorKey}>
                    <td><code>{gp.sectorKey}</code></td>
                    <td>{gp.displayName}</td>
                    <td>{gp.status}</td>
                    <td><span className="badge badge-dark">{gp.reviewStatus}</span></td>
                    <td>{gp.version}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>Tenant Feature Flags</h3>
            <form onSubmit={handleSetFeatureFlag} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr auto", gap: "0.75rem", alignItems: "end", marginBottom: "1rem" }}>
              <div>
                <label htmlFor="admin-flag-tenant" className="context-label">Tenant</label>
                <select id="admin-flag-tenant" className="select-control" style={{ width: "100%" }} value={flagTenantId} onChange={(e) => setFlagTenantId(e.target.value)}>
                  {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="admin-flag-name" className="context-label">Flag</label>
                <select id="admin-flag-name" className="select-control" style={{ width: "100%" }} value={flagName} onChange={(e) => setFlagName(e.target.value as any)}>
                  <option value="planeBOutcomes">planeBOutcomes</option>
                  <option value="aiWorkDesign">aiWorkDesign</option>
                  <option value="aiProposals">aiProposals</option>
                </select>
              </div>
              <div>
                <label htmlFor="admin-flag-state" className="context-label">State</label>
                <select id="admin-flag-state" className="select-control" style={{ width: "100%" }} value={flagEnabled ? "true" : "false"} onChange={(e) => setFlagEnabled(e.target.value === "true")}>
                  <option value="true">ENABLED</option>
                  <option value="false">DISABLED</option>
                </select>
              </div>
              <div>
                <label htmlFor="admin-flag-reason" className="context-label">Reason</label>
                <input id="admin-flag-reason" className="select-control" style={{ width: "100%" }} value={flagReason} onChange={(e) => setFlagReason(e.target.value)} required />
              </div>
              <button type="submit" className="btn btn-primary" disabled={busy}>Apply Flag</button>
            </form>

            <table className="data-table">
              <thead><tr><th>Tenant</th><th>Flag</th><th>Enabled</th><th>Changed By</th><th>Updated</th></tr></thead>
              <tbody>
                {featureFlags.map((f, i) => (
                  <tr key={i}>
                    <td className="monospace-badge">{f.tenant_id || "GLOBAL"}</td>
                    <td><code>{f.flag}</code></td>
                    <td><span className={`badge ${f.enabled ? "badge-success" : "badge-dark"}`}>{f.enabled ? "ON" : "OFF"}</span></td>
                    <td>{f.changed_by || "—"}</td>
                    <td>{fmt(f.changed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {section === "operations" && (
          <section className="card">
            <h2>Platform Operations, Kill Switches & Safe Diagnostics</h2>
            <h3>Five Independent Kill Switches</h3>
            {pendingSwitch && (
              <div className="card" style={{ background: "#FFF4F2", borderColor: "#A83828", marginBottom: "1rem" }}>
                <strong>Confirm Kill Switch Change: {pendingSwitch.scope}</strong>
                <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                  <input className="select-control" style={{ flex: 1 }} value={switchReason} onChange={(e) => setSwitchReason(e.target.value)} placeholder="Operator reason (min 5 chars)" />
                  <button type="button" className="btn btn-primary" onClick={handleConfirmKillSwitch} disabled={busy || switchReason.trim().length < 5}>Confirm</button>
                  <button type="button" className="btn btn-secondary" onClick={() => setPendingSwitch(null)}>Cancel</button>
                </div>
              </div>
            )}
            <table className="data-table" style={{ marginBottom: "1.5rem" }}>
              <thead><tr><th>Scope</th><th>Status</th><th>Updated By</th><th>Reason</th><th>Action</th></tr></thead>
              <tbody>
                {killSwitches.map((ks) => (
                  <tr key={ks.scope}>
                    <td><code>{ks.scope}</code></td>
                    <td><span className={`badge ${ks.active ? "badge-coral" : "badge-success"}`}>{ks.active ? "ACTIVE (STOPPED)" : "INACTIVE (NORMAL)"}</span></td>
                    <td>{ks.changed_by || "—"}</td>
                    <td>{ks.reason || "—"}</td>
                    <td>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setPendingSwitch({ scope: ks.scope, nextActive: !ks.active }); setSwitchReason(""); }}>
                        {ks.active ? "Deactivate" : "Activate"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>Outbox & Dead-Letter Queue</h3>
            {pendingReplayId && (
              <div className="card" style={{ background: "#F8F6FA", marginBottom: "1rem" }}>
                <strong>Confirm Dead-Letter Replay ({pendingReplayId.slice(0, 8)}...)</strong>
                <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                  <input className="select-control" style={{ flex: 1 }} value={replayReason} onChange={(e) => setReplayReason(e.target.value)} />
                  <button type="button" className="btn btn-primary" onClick={handleConfirmReplay} disabled={busy}>Replay</button>
                  <button type="button" className="btn btn-secondary" onClick={() => setPendingReplayId(null)}>Cancel</button>
                </div>
              </div>
            )}
            <p className="muted">Pending Queue Depth: {opsJobs?.queueDepth ?? 0} · Dead-Letter: {opsJobs?.totalDeadLetters ?? 0}</p>
            {opsJobs && opsJobs.items.length > 0 && (
              <table className="data-table" style={{ marginBottom: "1.5rem" }}>
                <thead><tr><th>ID</th><th>Type</th><th>State</th><th>Attempts</th><th>Action</th></tr></thead>
                <tbody>
                  {opsJobs.items.map((j) => (
                    <tr key={j.id}>
                      <td className="monospace-badge">{j.id.slice(0, 12)}...</td>
                      <td>{j.type}</td>
                      <td>{j.state}</td>
                      <td>{j.attempts}</td>
                      <td>
                        {j.state === "DEAD_LETTER" && (
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPendingReplayId(j.id)}>Replay</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h3>Safe Request Lookup & Recent Error Fingerprints</h3>
            <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
              <input className="select-control" placeholder="Enter requestId..." value={lookupReqId} onChange={(e) => setLookupReqId(e.target.value)} />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void act("Request located", async () => {
                  const r = await lookupOpsRequest(lookupReqId.trim(), adminToken);
                  setLookupRecord(r);
                  return `${r.method} ${r.route} -> ${r.status}`;
                })}
              >
                Lookup
              </button>
            </div>
            {lookupRecord && (
              <pre tabIndex={0} aria-label="Request lookup JSON" style={{ background: "#F5F2F8", padding: "0.75rem", borderRadius: 6, overflowX: "auto" }}>{JSON.stringify(lookupRecord, null, 2)}</pre>
            )}
            <table className="data-table">
              <thead><tr><th>Time</th><th>Request ID</th><th>Error Name</th><th>Fingerprint</th></tr></thead>
              <tbody>
                {opsErrors.slice(0, 10).map((e, i) => (
                  <tr key={i}>
                    <td>{fmt(e.at)}</td>
                    <td className="monospace-badge">{e.requestId}</td>
                    <td>{e.errorName}</td>
                    <td className="monospace-badge">{e.fingerprint}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {section === "evidence" && (
          <section className="card">
            <h2>Evidence & Release Dossier Readiness</h2>
            {dossier ? (
              <div>
                <p><strong>Dossier Status:</strong> <span className="badge badge-dark">{dossier.status}</span> · <strong>Commit:</strong> <code>{dossier.commitSha || "unknown"}</code></p>
                <p><strong>Checks Passing:</strong> {dossier.totalChecksPassed ?? "—"}</p>
                <pre tabIndex={0} aria-label="Release dossier JSON" style={{ background: "#F5F2F8", padding: "1rem", borderRadius: 6, overflowX: "auto", maxHeight: 420 }}>
                  {JSON.stringify(dossier, null, 2)}
                </pre>
              </div>
            ) : (
              <p className="muted">No release dossier artifact loaded.</p>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
