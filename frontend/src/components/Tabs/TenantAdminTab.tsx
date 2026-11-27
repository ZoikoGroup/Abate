// frontend/src/components/Tabs/TenantAdminTab.tsx
// Tenant Admin Console (Step 3 & Step 4):
// Scoped strictly to the caller's own tenant via /api/v2/tenant-admin/* + tenant routes:
// 1. Users & Roles (effective dates, recheck approver authority, deactivate/reactivate)
// 2. OIDC Invitations (create, list masked emails, revoke)
// 3. Organization Structure (create & edit/reparent units/teams)
// 4. Connections (create, Suspend, Resume, Disconnect permanently with confirm dialog, receipts)
// 5. Sector Settings (vocabulary & demand windows view; preview packs disabled)
// 6. Data Lifecycle (retention classes with placeholder labels, legal holds, rights requests, evidence packages)
// 7. Own Audit Log (searchable/filterable) & Usage (AI quota, entitlements, connector health)

import { useState, useEffect, useCallback, type FormEvent } from "react";
import {
  api,
  ApiError,
  fetchTenantAdminUsers,
  assignTenantAdminMembership,
  endTenantAdminMembership,
  setTenantAdminUserStatus,
  fetchTenantInvitations,
  createTenantInvitation,
  revokeTenantInvitation,
  updateTenantOrganization,
  fetchTenantAdminAudit,
  fetchTenantAdminRightsRequests,
  fetchTenantAdminUsage,
  fetchSourceContracts,
  fetchConnections,
  registerConnection,
  setConnectionState,
  fetchRetentionState,
  placeLegalHold,
  releaseLegalHold,
  submitRightsRequest,
  PRESET_TENANTS,
  type Organization,
  type AuditEvent,
  type TenantSectorProfile,
  type TenantAdminUserRecord,
  type TenantInvitationRecord,
  type TenantUsageOverview,
  type SourceContract,
  type Connection,
  type RetentionState
} from "../../api/client";
import { StateView, type ViewState } from "../StateView";
import { SectorPackSelector } from "../SectorPackSelector";
import { ConfirmWithReasonDialog } from "../Admin/AdminDialogs";

interface TenantAdminTabProps {
  currentTenant: typeof PRESET_TENANTS[0];
  token: string | null;
  organizations: Organization[];
  sectorProfile?: TenantSectorProfile | null;
  allowedActions?: string[];
  onSectorProfileChange?: (profile: TenantSectorProfile) => void;
  onRefresh: () => void | Promise<void>;
}

type TenantAdminSection =
  | "users"
  | "invitations"
  | "organizations"
  | "connections"
  | "sector"
  | "lifecycle"
  | "audit"
  | "usage";

type Feedback = { kind: "success" | "error" | "conflict"; title: string; message: string } | null;

const DOMAIN_ROLES = [
  "EMPLOYER_ADMIN",
  "RISK_OWNER",
  "CONTROL_OWNER",
  "APPROVER",
  "REVIEWER",
  "IMPLEMENTATION_OWNER",
  "DPO",
  "PRIVACY_OFFICER",
  "VIEWER",
  "WORKER_REP"
] as const;

const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toISOString().slice(0, 19).replace("T", " ") + " UTC" : "—";
const newKey = () => `idem-${crypto.randomUUID()}`;

export function TenantAdminTab({
  currentTenant,
  token,
  organizations,
  sectorProfile,
  allowedActions,
  onSectorProfileChange,
  onRefresh
}: TenantAdminTabProps) {
  const [section, setSection] = useState<TenantAdminSection>("users");
  const [viewState, setViewState] = useState<ViewState>({ kind: "loading", message: "Loading Tenant Admin workspace..." });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const [users, setUsers] = useState<TenantAdminUserRecord[]>([]);
  const [invitations, setInvitations] = useState<TenantInvitationRecord[]>([]);
  const [contracts, setContracts] = useState<SourceContract[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [retention, setRetention] = useState<RetentionState | null>(null);
  const [rightsHistory, setRightsHistory] = useState<any[]>([]);
  const [auditItems, setAuditItems] = useState<AuditEvent[]>([]);
  const [usage, setUsage] = useState<TenantUsageOverview | null>(null);

  // Confirm dialog state
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    impactText: string;
    confirmLabel: string;
    destructive?: boolean;
    onConfirm: (reason: string) => Promise<void>;
  } | null>(null);

  // Role assignment form
  const [roleSubject, setRoleSubject] = useState("");
  const [roleOrgId, setRoleOrgId] = useState(organizations[0]?.id || "");
  const [roleName, setRoleName] = useState<string>("REVIEWER");
  const [roleValidFrom, setRoleValidFrom] = useState("");
  const [roleValidTo, setRoleValidTo] = useState("");
  const [roleReason, setRoleReason] = useState("");

  // OIDC invitation form
  const [invEmail, setInvEmail] = useState("");
  const [invOrgId, setInvOrgId] = useState(organizations[0]?.id || "");
  const [invRole, setInvRole] = useState<string>("REVIEWER");
  const [invDays, setInvDays] = useState("7");
  const [invReason, setInvReason] = useState("");

  // Org structure form
  const [newOrgName, setNewOrgName] = useState("");
  const [newOrgParentId, setNewOrgParentId] = useState("");
  const [editingOrg, setEditingOrg] = useState<{ id: string; name: string; parentId: string; version: number } | null>(null);
  const [editOrgReason, setEditOrgReason] = useState("");

  // Connection form
  const [selectedContractId, setSelectedContractId] = useState("");

  // Lifecycle forms
  const [holdRef, setHoldRef] = useState("");
  const [holdReason, setHoldReason] = useState("");
  const [rightsSubjectRef, setRightsSubjectRef] = useState("");

  // Audit search filters
  const [auditQuery, setAuditQuery] = useState("");
  const [auditCommand, setAuditCommand] = useState("");

  const canManageUsers = !allowedActions || allowedActions.includes("tenant.users.manage");
  const canManageInvites = !allowedActions || allowedActions.includes("tenant.invitations.manage");
  const canManageOrgs = !allowedActions || allowedActions.includes("tenant.organization.manage") || allowedActions.includes("organization.create");

  const loadAll = useCallback(async (tok: string) => {
    const [uRes, invRes, ctrRes, connRes, retRes, rrRes, audRes, useRes] = await Promise.all([
      fetchTenantAdminUsers(tok),
      fetchTenantInvitations(tok),
      fetchSourceContracts(tok).catch(() => []),
      fetchConnections(tok).catch(() => []),
      fetchRetentionState(tok).catch(() => null),
      fetchTenantAdminRightsRequests(tok).catch(() => ({ tenantId: "", items: [] })),
      fetchTenantAdminAudit(tok),
      fetchTenantAdminUsage(tok).catch(() => null)
    ]);
    return { uRes, invRes, ctrRes, connRes, retRes, rrRes, audRes, useRes };
  }, []);

  const applyAll = useCallback(
    (data: Awaited<ReturnType<typeof loadAll>>) => {
      setUsers(data.uRes.items);
      setInvitations(data.invRes.items);
      setContracts(data.ctrRes);
      setConnections(data.connRes);
      setRetention(data.retRes);
      setRightsHistory(data.rrRes.items);
      setAuditItems(data.audRes.items);
      setUsage(data.useRes);
      setViewState({ kind: "ok" });
    },
    []
  );

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      const data = await loadAll(token);
      applyAll(data);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 401 || err.status === 403) {
          setViewState({ kind: "unauthorized" });
        } else {
          setViewState({ kind: "failed", requestId: err.requestId, message: err.message });
        }
      } else {
        setViewState({ kind: "failed", requestId: "client-error", message: "Could not load Tenant Admin data." });
      }
    }
  }, [token, loadAll, applyAll]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void loadAll(token)
      .then((data) => {
        if (!cancelled) applyAll(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError) {
          if (err.status === 401 || err.status === 403) {
            setViewState({ kind: "unauthorized" });
          } else {
            setViewState({ kind: "failed", requestId: err.requestId, message: err.message });
          }
        } else {
          setViewState({ kind: "failed", requestId: "client-error", message: "Could not load Tenant Admin data." });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, loadAll, applyAll]);

  const effectiveOrgId = roleOrgId || organizations[0]?.id || "";
  const effectiveInvOrgId = invOrgId || organizations[0]?.id || "";

  const runAction = async (title: string, fn: () => Promise<string>) => {
    setBusy(true);
    try {
      const message = await fn();
      setFeedback({ kind: "success", title, message });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setFeedback({
            kind: "conflict",
            title: "Conflict (409) — Reload and retry",
            message: `${err.message} Reload latest state before retrying. (Request ID: ${err.requestId})`
          });
        } else {
          setFeedback({
            kind: "error",
            title: `Refused [${err.code}]`,
            message: `${err.message} (Request ID: ${err.requestId})`
          });
        }
      } else {
        setFeedback({
          kind: "error",
          title: "Action Failed",
          message: err instanceof Error ? err.message : "Unexpected error."
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleAssignRole = (e: FormEvent) => {
    e.preventDefault();
    if (!token || !roleSubject.trim() || !effectiveOrgId || roleReason.trim().length < 5) return;
    void runAction("Role membership assigned", async () => {
      const res = await assignTenantAdminMembership(
        {
          externalSubject: roleSubject.trim(),
          organizationId: effectiveOrgId,
          domainRole: roleName,
          validFrom: roleValidFrom ? new Date(roleValidFrom).toISOString() : undefined,
          validTo: roleValidTo ? new Date(roleValidTo).toISOString() : null,
          reason: roleReason.trim()
        },
        newKey(),
        token
      );
      setRoleSubject("");
      setRoleReason("");
      await reload();
      return `Assigned ${res.domainRole} to ${res.externalSubject} effective ${fmt(res.validFrom)} (approver authority: ${res.grantsApproverAuthority ? "YES" : "NO"}).`;
    });
  };

  const handleCreateInvitation = (e: FormEvent) => {
    e.preventDefault();
    if (!token || !invEmail.trim() || !effectiveInvOrgId || invReason.trim().length < 5) return;
    void runAction("OIDC invitation created", async () => {
      const inv = await createTenantInvitation(
        {
          email: invEmail.trim(),
          organizationId: effectiveInvOrgId,
          domainRole: invRole,
          expiresInDays: Number(invDays) || 7,
          reason: invReason.trim()
        },
        newKey(),
        token
      );
      setInvEmail("");
      setInvReason("");
      await reload();
      return `Created OIDC invitation for ${inv.maskedEmail} as ${inv.domainRole} (expires ${fmt(inv.expiresAt)}).`;
    });
  };

  const handleCreateOrg = (e: FormEvent) => {
    e.preventDefault();
    if (!token || !newOrgName.trim()) return;
    void runAction("Organization unit created", async () => {
      const res = await api<Organization>("/api/v2/organizations", {
        method: "POST",
        token,
        idempotencyKey: newKey(),
        body: JSON.stringify({
          name: newOrgName.trim(),
          ...(newOrgParentId ? { parentId: newOrgParentId } : {})
        })
      });
      setNewOrgName("");
      await Promise.resolve(onRefresh());
      await reload();
      return `Created unit "${res.name}" (${res.id.slice(0, 8)}...).`;
    });
  };

  const handleSaveOrgEdit = (e: FormEvent) => {
    e.preventDefault();
    if (!token || !editingOrg || editOrgReason.trim().length < 5) return;
    void runAction("Organization updated", async () => {
      const res = await updateTenantOrganization(
        editingOrg.id,
        {
          name: editingOrg.name.trim(),
          parentId: editingOrg.parentId || null,
          reason: editOrgReason.trim()
        },
        newKey(),
        token,
        editingOrg.version
      );
      setEditingOrg(null);
      setEditOrgReason("");
      await Promise.resolve(onRefresh());
      await reload();
      return `Updated organization "${res.name}" to v${res.version}.`;
    });
  };

  const handleConnectionTransition = (c: Connection, action: "suspend" | "resume" | "disconnect") => {
    if (!token) return;
    const isTerminal = action === "disconnect";
    setConfirmDialog({
      title: isTerminal ? `Disconnect Permanently: ${c.source}` : `${action === "suspend" ? "Suspend" : "Resume"} Connection: ${c.source}`,
      impactText: isTerminal
        ? "Disconnecting permanently is terminal and cannot be undone. Existing ledger records remain governed by retention and legal holds."
        : action === "suspend"
          ? "Suspending pauses ingestion batches until resumed."
          : "Resuming re-enables ingestion on this connection.",
      confirmLabel: isTerminal ? "Disconnect Permanently" : action === "suspend" ? "Suspend" : "Resume",
      destructive: isTerminal,
      onConfirm: async () => {
        setConfirmDialog(null);
        await runAction(`Connection ${action}`, async () => {
          await setConnectionState(c.id, action, token);
          await reload();
          return `Connection ${c.source} (${c.id.slice(0, 8)}...) transitioned via ${action}.`;
        });
      }
    });
  };

  const handleSearchAudit = (e: FormEvent) => {
    e.preventDefault();
    if (!token) return;
    void runAction("Tenant audit log filtered", async () => {
      const res = await fetchTenantAdminAudit(token, {
        q: auditQuery.trim() || undefined,
        command: auditCommand.trim() || undefined
      });
      setAuditItems(res.items);
      return `Found ${res.items.length} audit event(s) for ${currentTenant.name}.`;
    });
  };

  return (
    <div className="tab-pane">
      <div className="card">
        <div className="card-header">
          <div>
            <h2>Tenant Admin Console — {currentTenant.name}</h2>
            <p className="card-desc">
              Customer administration strictly isolated to your tenant. Cannot see other tenants, cannot change the privacy floor, and does not grant hazard or control approval authority from the admin role alone.
            </p>
          </div>
          <span className="badge badge-aubergine">TENANT ISOLATED (FORCE RLS)</span>
        </div>

        <div className="tabs-navigation" role="tablist" aria-label="Tenant Admin Sections" style={{ marginBottom: "1rem", padding: 0 }}>
          {([
            ["users", "Users & Roles"],
            ["invitations", "OIDC Invitations"],
            ["organizations", "Organization Structure"],
            ["connections", "Connections"],
            ["sector", "Sector Settings"],
            ["lifecycle", "Data Lifecycle"],
            ["audit", "Own Audit Log"],
            ["usage", "Usage & Quotas"]
          ] as Array<[TenantAdminSection, string]>).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={section === key}
              className={`tab-button ${section === key ? "active" : ""}`}
              onClick={() => setSection(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {feedback && (
          <div
            className={`feedback-alert ${feedback.kind === "success" ? "alert-success" : "alert-error"}`}
            role={feedback.kind === "success" ? "status" : "alert"}
            style={{ marginBottom: "1rem" }}
          >
            <strong>{feedback.title}:</strong> {feedback.message}
          </div>
        )}

        <StateView state={viewState}>
          {section === "users" && (
            <section>
              <h3>Tenant Users &amp; Effective-Dated Role Memberships</h3>
              {!canManageUsers && (
                <div className="callout-info" style={{ marginBottom: "1rem" }}>
                  Read-only view: switch to <code>EMPLOYER_ADMIN</code> to assign or end memberships or deactivate users.
                </div>
              )}

              {canManageUsers && (
                <form onSubmit={handleAssignRole} style={{ display: "grid", gridTemplateColumns: "1.5fr 1.2fr 1fr 1fr 1fr 1.5fr auto", gap: "0.5rem", alignItems: "end", marginBottom: "1.25rem" }}>
                  <div>
                    <label htmlFor="ta-role-subject" className="context-label">Principal Subject</label>
                    <input id="ta-role-subject" className="select-control" style={{ width: "100%" }} value={roleSubject} onChange={(e) => setRoleSubject(e.target.value)} placeholder="auth0|user-approver" required />
                  </div>
                  <div>
                    <label htmlFor="ta-role-org" className="context-label">Unit / Team</label>
                    <select id="ta-role-org" className="select-control" style={{ width: "100%" }} value={effectiveOrgId} onChange={(e) => setRoleOrgId(e.target.value)}>
                      {organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="ta-role-name" className="context-label">Role</label>
                    <select id="ta-role-name" className="select-control" style={{ width: "100%" }} value={roleName} onChange={(e) => setRoleName(e.target.value)}>
                      {DOMAIN_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="ta-role-from" className="context-label">Effective From</label>
                    <input id="ta-role-from" type="datetime-local" className="select-control" style={{ width: "100%" }} value={roleValidFrom} onChange={(e) => setRoleValidFrom(e.target.value)} />
                  </div>
                  <div>
                    <label htmlFor="ta-role-to" className="context-label">Effective Until</label>
                    <input id="ta-role-to" type="datetime-local" className="select-control" style={{ width: "100%" }} value={roleValidTo} onChange={(e) => setRoleValidTo(e.target.value)} />
                  </div>
                  <div>
                    <label htmlFor="ta-role-reason" className="context-label">Reason (min 5)</label>
                    <input id="ta-role-reason" className="select-control" style={{ width: "100%" }} value={roleReason} onChange={(e) => setRoleReason(e.target.value)} minLength={5} required />
                  </div>
                  <button type="submit" className="btn btn-primary" disabled={busy}>Assign Role</button>
                </form>
              )}

              <table className="data-table">
                <thead>
                  <tr><th>Subject</th><th>Account Status</th><th>Approval Authority</th><th>Effective-Dated Memberships</th><th>Account Action</th></tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.principalId}>
                      <td className="monospace-badge">{u.externalSubject}<br /><small>{u.kind} · v{u.version}</small></td>
                      <td><span className={`badge ${u.active ? "badge-success" : "badge-dark"}`}>{u.active ? "ACTIVE" : "DEACTIVATED"}</span></td>
                      <td>
                        <span className={`badge ${u.hasApprovalAuthorityNow ? "badge-aubergine" : "badge-dark"}`}>
                          {u.hasApprovalAuthorityNow ? `YES (${u.activeApproverRoles.join(", ")})` : "NO"}
                        </span>
                      </td>
                      <td>
                        {u.memberships.map((m) => (
                          <div key={m.membershipId} style={{ display: "flex", gap: "0.4rem", alignItems: "center", marginBottom: "0.25rem", flexWrap: "wrap" }}>
                            <code>{m.domainRole}</code>
                            <small>({fmt(m.validFrom)} → {m.validTo ? fmt(m.validTo) : "open"})</small>
                            {canManageUsers && m.activeNow && (
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() =>
                                  setConfirmDialog({
                                    title: `End Role Membership (${m.domainRole})`,
                                    impactText: `Ends ${m.domainRole} for ${u.externalSubject} immediately and rechecks remaining control/hazard approver authority.`,
                                    confirmLabel: "End Membership",
                                    destructive: true,
                                    onConfirm: async (reason) => {
                                      setConfirmDialog(null);
                                      if (!token) return;
                                      await runAction("Membership ended", async () => {
                                        const res = await endTenantAdminMembership(m.membershipId, { reason }, newKey(), token, m.version);
                                        await reload();
                                        return `Ended ${res.endedRole} (remaining approval authority: ${res.retainsApprovalAuthorityAfterEnd ? "YES" : "NO"}).`;
                                      });
                                    }
                                  })
                                }
                                disabled={busy}
                              >
                                End Role
                              </button>
                            )}
                          </div>
                        ))}
                      </td>
                      <td>
                        {canManageUsers && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() =>
                              setConfirmDialog({
                                title: u.active ? `Deactivate User: ${u.externalSubject}` : `Reactivate User: ${u.externalSubject}`,
                                impactText: u.active
                                  ? "Deactivating blocks future sign-ins for this user while retaining immutable audit attribution."
                                  : "Reactivating restores sign-in access for active memberships.",
                                confirmLabel: u.active ? "Deactivate User" : "Reactivate User",
                                destructive: u.active,
                                onConfirm: async (reason) => {
                                  setConfirmDialog(null);
                                  if (!token) return;
                                  await runAction(u.active ? "User deactivated" : "User reactivated", async () => {
                                    const res = await setTenantAdminUserStatus(
                                      u.principalId,
                                      u.active ? "deactivate" : "reactivate",
                                      reason,
                                      newKey(),
                                      token,
                                      u.version
                                    );
                                    await reload();
                                    return `User ${u.externalSubject} is now ${res.active ? "ACTIVE" : "DEACTIVATED"} (v${res.version}).`;
                                  });
                                }
                              })
                            }
                            disabled={busy}
                          >
                            {u.active ? "Deactivate" : "Reactivate"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {section === "invitations" && (
            <section>
              <h3>OIDC Invitations</h3>
              {canManageInvites && (
                <form onSubmit={handleCreateInvitation} style={{ display: "grid", gridTemplateColumns: "1.5fr 1.2fr 1fr 0.7fr 1.5fr auto", gap: "0.5rem", alignItems: "end", marginBottom: "1.25rem" }}>
                  <div>
                    <label htmlFor="inv-email" className="context-label">Invitee Work Email</label>
                    <input id="inv-email" type="email" className="select-control" style={{ width: "100%" }} value={invEmail} onChange={(e) => setInvEmail(e.target.value)} placeholder="alex.patel@example.org" required />
                  </div>
                  <div>
                    <label htmlFor="inv-org" className="context-label">Organization Unit</label>
                    <select id="inv-org" className="select-control" style={{ width: "100%" }} value={effectiveInvOrgId} onChange={(e) => setInvOrgId(e.target.value)}>
                      {organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="inv-role" className="context-label">Assigned Role</label>
                    <select id="inv-role" className="select-control" style={{ width: "100%" }} value={invRole} onChange={(e) => setInvRole(e.target.value)}>
                      {DOMAIN_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="inv-days" className="context-label">Expiry (Days)</label>
                    <input id="inv-days" type="number" min={1} max={30} className="select-control" style={{ width: "100%" }} value={invDays} onChange={(e) => setInvDays(e.target.value)} />
                  </div>
                  <div>
                    <label htmlFor="inv-reason" className="context-label">Reason (min 5)</label>
                    <input id="inv-reason" className="select-control" style={{ width: "100%" }} value={invReason} onChange={(e) => setInvReason(e.target.value)} minLength={5} required />
                  </div>
                  <button type="submit" className="btn btn-primary" disabled={busy}>Send OIDC Invite</button>
                </form>
              )}

              <StateView state={invitations.length === 0 ? { kind: "empty", reason: "No OIDC invitations created for this tenant yet." } : { kind: "ok" }}>
                <table className="data-table">
                  <thead>
                    <tr><th>Masked Email</th><th>Role</th><th>Status</th><th>Expires</th><th>Action</th></tr>
                  </thead>
                  <tbody>
                    {invitations.map((inv) => (
                      <tr key={inv.id}>
                        <td className="monospace-badge">{inv.maskedEmail}</td>
                        <td><code>{inv.domainRole}</code></td>
                        <td><span className={`badge ${inv.status === "PENDING" ? "badge-warning" : inv.status === "ACCEPTED" ? "badge-success" : "badge-dark"}`}>{inv.status}</span></td>
                        <td>{fmt(inv.expiresAt)}</td>
                        <td>
                          {canManageInvites && inv.status === "PENDING" && (
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() =>
                                setConfirmDialog({
                                  title: `Revoke Invitation (${inv.maskedEmail})`,
                                  impactText: "Revoking invalidates this pending OIDC invitation immediately.",
                                  confirmLabel: "Revoke Invitation",
                                  destructive: true,
                                  onConfirm: async (reason) => {
                                    setConfirmDialog(null);
                                    if (!token) return;
                                    await runAction("Invitation revoked", async () => {
                                      await revokeTenantInvitation(inv.id, reason, newKey(), token, inv.version);
                                      await reload();
                                      return `Revoked OIDC invitation for ${inv.maskedEmail}.`;
                                    });
                                  }
                                })
                              }
                              disabled={busy}
                            >
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </StateView>
            </section>
          )}

          {section === "organizations" && (
            <section>
              <h3>Organization Structure (Units &amp; Teams)</h3>
              {canManageOrgs && (
                <form onSubmit={handleCreateOrg} style={{ display: "grid", gridTemplateColumns: "2fr 1.5fr auto", gap: "0.75rem", alignItems: "end", marginBottom: "1rem" }}>
                  <div>
                    <label htmlFor="ta-org-name" className="context-label">New Unit / Team Name</label>
                    <input id="ta-org-name" className="select-control" style={{ width: "100%" }} value={newOrgName} onChange={(e) => setNewOrgName(e.target.value)} placeholder="Operations Delivery Team" required />
                  </div>
                  <div>
                    <label htmlFor="ta-org-parent" className="context-label">Parent Unit (Optional)</label>
                    <select id="ta-org-parent" className="select-control" style={{ width: "100%" }} value={newOrgParentId} onChange={(e) => setNewOrgParentId(e.target.value)}>
                      <option value="">Top-Level Unit</option>
                      {organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  </div>
                  <button type="submit" className="btn btn-primary" disabled={busy}>Create Unit</button>
                </form>
              )}

              {editingOrg && (
                <form onSubmit={handleSaveOrgEdit} className="card" style={{ background: "#F8F6FA", marginBottom: "1rem" }}>
                  <h4>Edit Unit (v{editingOrg.version})</h4>
                  <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1.2fr 1.5fr auto auto", gap: "0.5rem", alignItems: "end" }}>
                    <div>
                      <label htmlFor="ta-edit-org-name" className="context-label">Name</label>
                      <input id="ta-edit-org-name" className="select-control" value={editingOrg.name} onChange={(e) => setEditingOrg({ ...editingOrg, name: e.target.value })} required />
                    </div>
                    <div>
                      <label htmlFor="ta-edit-org-parent" className="context-label">Parent</label>
                      <select id="ta-edit-org-parent" className="select-control" value={editingOrg.parentId} onChange={(e) => setEditingOrg({ ...editingOrg, parentId: e.target.value })}>
                        <option value="">Top-Level Unit</option>
                        {organizations.filter((o) => o.id !== editingOrg.id).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="ta-edit-org-reason" className="context-label">Reason (min 5)</label>
                      <input id="ta-edit-org-reason" className="select-control" value={editOrgReason} onChange={(e) => setEditOrgReason(e.target.value)} minLength={5} required />
                    </div>
                    <button type="submit" className="btn btn-primary" disabled={busy}>Save</button>
                    <button type="button" className="btn btn-secondary" onClick={() => setEditingOrg(null)}>Cancel</button>
                  </div>
                </form>
              )}

              <table className="data-table">
                <thead><tr><th>Unit / Team Name</th><th>Parent Unit</th><th>ID</th><th>Action</th></tr></thead>
                <tbody>
                  {organizations.map((o: any) => {
                    const parent = organizations.find((p) => p.id === o.parent_id);
                    return (
                      <tr key={o.id}>
                        <td><strong>{o.name}</strong></td>
                        <td>{parent ? parent.name : "Root"}</td>
                        <td className="monospace-badge">{o.id.slice(0, 12)}...</td>
                        <td>
                          {canManageOrgs && (
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => {
                                setEditingOrg({ id: o.id, name: o.name, parentId: o.parent_id || "", version: Number(o.version || 1) });
                                setEditOrgReason("Unit structure alignment");
                              }}
                            >
                              Edit
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}

          {section === "connections" && (
            <section>
              <h3>Source Connections &amp; Freshness</h3>
              <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem", alignItems: "end" }}>
                <div>
                  <label htmlFor="ta-conn-source" className="context-label">Approved Source Contract</label>
                  <select
                    id="ta-conn-source"
                    className="select-control"
                    value={selectedContractId || contracts[0]?.id || ""}
                    onChange={(e) => setSelectedContractId(e.target.value)}
                  >
                    {contracts.map((ct) => (
                      <option key={ct.id} value={ct.id}>
                        {ct.source} ({ct.version})
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    const effectiveContractId = selectedContractId || contracts[0]?.id || "";
                    const contract = contracts.find((ct) => ct.id === effectiveContractId);
                    if (!token || !contract) return;
                    void runAction("Connection registered", async () => {
                      const created = await registerConnection(
                        { source: contract.source, contractId: contract.id, expectedCadenceSeconds: 3600 },
                        newKey(),
                        token
                      );
                      await reload();
                      return `Registered ${created.source} connection (${created.id.slice(0, 8)}...).`;
                    });
                  }}
                  disabled={busy || contracts.length === 0}
                >
                  Register Connection
                </button>
              </div>

              <table className="data-table">
                <thead><tr><th>Source</th><th>State</th><th>Last Sync</th><th>Actions</th></tr></thead>
                <tbody>
                  {connections.map((c) => (
                    <tr key={c.id}>
                      <td><strong>{c.source}</strong><br /><small className="monospace-badge">{c.id.slice(0, 12)}...</small></td>
                      <td><span className={`badge ${c.state === "ACTIVE" || c.state === "RESUMED" ? "badge-success" : "badge-dark"}`}>{c.state}</span></td>
                      <td>{fmt(c.last_success_at)}</td>
                      <td style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                        {c.state !== "DISCONNECTED" && c.state !== "REVOKED" && (
                          <>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleConnectionTransition(c, "suspend")} disabled={busy}>Suspend</button>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleConnectionTransition(c, "resume")} disabled={busy}>Resume</button>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleConnectionTransition(c, "disconnect")} disabled={busy}>Disconnect Permanently</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {section === "sector" && (
            <section>
              <h3>Sector Vocabulary &amp; Demand Windows</h3>
              <SectorPackSelector
                token={token}
                sectorProfile={sectorProfile}
                onChanged={(p) => onSectorProfileChange?.(p)}
              />
              {sectorProfile && (
                <div className="card" style={{ background: "#F8F6FA" }}>
                  <h4>Active Pack Vocabulary ({sectorProfile.displayName})</h4>
                  <ul>
                    <li><strong>Work Item:</strong> {sectorProfile.vocabulary.workItem} ({sectorProfile.vocabulary.workItems})</li>
                    <li><strong>Unit Label:</strong> {sectorProfile.vocabulary.unit}</li>
                    <li><strong>Demand Window Label:</strong> {sectorProfile.vocabulary.demandWindow}</li>
                    <li><strong>Supervisor Role Label:</strong> {sectorProfile.vocabulary.supervisor}</li>
                    <li><strong>Demand Windows:</strong> {sectorProfile.demandWindows.join(", ")}</li>
                    <li><strong>High-Demand Windows:</strong> {(sectorProfile.highDemandWindows ?? []).join(", ")}</li>
                  </ul>
                </div>
              )}
            </section>
          )}

          {section === "lifecycle" && (
            <section>
              <h3>Data Lifecycle: Retention, Legal Holds &amp; Rights Requests</h3>
              <div className="callout-info" style={{ marginBottom: "1rem" }}>
                <strong>Placeholder Retention Notice:</strong> Default retention bounds (90–730 days) remain labelled as synthetic placeholders until formal legal &amp; DPO sign-off.
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>
                <form
                  className="card"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!token || !holdRef.trim() || holdReason.trim().length < 5) return;
                    void runAction("Legal hold placed", async () => {
                      await placeLegalHold({ dataCategory: "WORK_FACT", caseRef: holdRef.trim(), reason: holdReason.trim() }, newKey(), token);
                      setHoldRef("");
                      setHoldReason("");
                      await reload();
                      return `Placed legal hold for reference ${holdRef.trim()}.`;
                    });
                  }}
                >
                  <h4>Place Legal Hold</h4>
                  <label htmlFor="ta-hold-ref" className="context-label">Case / Reference ID</label>
                  <input id="ta-hold-ref" className="select-control" style={{ width: "100%", marginBottom: "0.5rem" }} value={holdRef} onChange={(e) => setHoldRef(e.target.value)} required />
                  <label htmlFor="ta-hold-reason" className="context-label">Reason (min 5)</label>
                  <input id="ta-hold-reason" className="select-control" style={{ width: "100%", marginBottom: "0.5rem" }} value={holdReason} onChange={(e) => setHoldReason(e.target.value)} minLength={5} required />
                  <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Place Hold</button>
                </form>

                <form
                  className="card"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!token || !rightsSubjectRef.trim()) return;
                    void runAction("Rights request submitted", async () => {
                      await submitRightsRequest(rightsSubjectRef.trim(), newKey(), token);
                      setRightsSubjectRef("");
                      await reload();
                      return `Submitted erasure rights request.`;
                    });
                  }}
                >
                  <h4>Submit Data Subject Rights Request</h4>
                  <label htmlFor="ta-rr-psn" className="context-label">Subject Pseudonym Reference</label>
                  <input id="ta-rr-psn" className="select-control" style={{ width: "100%", marginBottom: "0.5rem" }} value={rightsSubjectRef} onChange={(e) => setRightsSubjectRef(e.target.value)} placeholder="psn-..." required />
                  <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Submit Erasure Request</button>
                </form>
              </div>

              <h4>Active Legal Holds ({retention?.holds?.length ?? 0})</h4>
              <table className="data-table" style={{ marginBottom: "1rem" }}>
                <thead><tr><th>Reference</th><th>Category</th><th>Placed At</th><th>Action</th></tr></thead>
                <tbody>
                  {(retention?.holds ?? []).map((h) => (
                    <tr key={h.id}>
                      <td><code>{h.case_ref || h.id.slice(0, 8)}</code></td>
                      <td>{h.data_category}</td>
                      <td>{fmt(h.placed_at)}</td>
                      <td>
                        {!h.released_at && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() =>
                              setConfirmDialog({
                                title: `Release Legal Hold (${h.case_ref || h.id.slice(0, 8)})`,
                                impactText: "Releasing this hold allows eligible expired records to follow standard retention rules.",
                                confirmLabel: "Release Hold",
                                onConfirm: async (reason) => {
                                  setConfirmDialog(null);
                                  if (!token) return;
                                  await runAction("Legal hold released", async () => {
                                    await releaseLegalHold(h.id, reason, newKey(), token);
                                    await reload();
                                    return `Released legal hold ${h.id.slice(0, 8)}...`;
                                  });
                                }
                              })
                            }
                          >
                            Release Hold
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h4>Rights Requests History ({rightsHistory.length})</h4>
              <StateView state={rightsHistory.length === 0 ? { kind: "empty", reason: "No rights requests recorded for this tenant." } : { kind: "ok" }}>
                <table className="data-table">
                  <thead><tr><th>ID</th><th>Type</th><th>Status</th><th>Created</th></tr></thead>
                  <tbody>
                    {rightsHistory.map((rr: any) => (
                      <tr key={rr.id}>
                        <td className="monospace-badge">{String(rr.id).slice(0, 12)}...</td>
                        <td>{rr.request_type || "ERASURE"}</td>
                        <td>{rr.status || "COMPLETED"}</td>
                        <td>{fmt(rr.created_at || rr.requested_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </StateView>
            </section>
          )}

          {section === "audit" && (
            <section>
              <h3>Own Tenant Audit Log (Strictly Tenant-Scoped)</h3>
              <form onSubmit={handleSearchAudit} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "end", marginBottom: "1rem" }}>
                <div>
                  <label htmlFor="ta-audit-q" className="context-label">Search</label>
                  <input id="ta-audit-q" className="select-control" value={auditQuery} onChange={(e) => setAuditQuery(e.target.value)} placeholder="command, resource, evidence..." />
                </div>
                <div>
                  <label htmlFor="ta-audit-cmd" className="context-label">Command Filter</label>
                  <input id="ta-audit-cmd" className="select-control" value={auditCommand} onChange={(e) => setAuditCommand(e.target.value)} placeholder="tenant.membership..." />
                </div>
                <button type="submit" className="btn btn-secondary" disabled={busy}>Search Own Audit</button>
              </form>

              <StateView state={auditItems.length === 0 ? { kind: "empty", reason: "No matching audit records for this tenant." } : { kind: "ok" }}>
                <table className="data-table">
                  <thead><tr><th>ID</th><th>Occurred</th><th>Command</th><th>Resource</th><th>Result</th></tr></thead>
                  <tbody>
                    {auditItems.map((e) => (
                      <tr key={e.id}>
                        <td className="monospace-badge">#{e.id}</td>
                        <td>{fmt(e.occurred_at)}</td>
                        <td><code>{e.command}</code></td>
                        <td className="monospace-badge">{e.resource_type} / {e.resource_id.slice(0, 8)}...</td>
                        <td><span className="badge badge-success">{e.result}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </StateView>
            </section>
          )}

          {section === "usage" && (
            <section>
              <h3>Tenant Usage, AI Quota &amp; Connector Freshness</h3>
              {usage ? (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "1rem", marginBottom: "1rem" }}>
                    <div className="metric-card">
                      <div className="metric-label">AI Monthly Budget Cap</div>
                      <div className="metric-value">{usage.aiQuota.totalBudgetMinor}</div>
                      <small>Spent: {usage.aiQuota.totalSpentMinor} · Remaining: {usage.aiQuota.totalRemainingMinor}</small>
                    </div>
                    <div className="metric-card">
                      <div className="metric-label">AI Kill Switch</div>
                      <div className="metric-value">{usage.aiQuota.allAiDisabled ? "PAUSED" : "NORMAL"}</div>
                      <small>Reset: {fmt(usage.aiQuota.resetAt)}</small>
                    </div>
                    <div className="metric-card">
                      <div className="metric-label">Connections</div>
                      <div className="metric-value">{usage.connections.length}</div>
                      <small>{usage.connections.filter((c) => c.health === "FRESH").length} fresh</small>
                    </div>
                  </div>

                  <h4>Connector Freshness</h4>
                  <table className="data-table" style={{ marginBottom: "1rem" }}>
                    <thead><tr><th>Source</th><th>State</th><th>Health</th><th>Last Sync</th></tr></thead>
                    <tbody>
                      {usage.connections.map((c) => (
                        <tr key={c.id}>
                          <td>{c.source}</td>
                          <td>{c.state}</td>
                          <td><span className={`badge ${c.health === "FRESH" ? "badge-success" : "badge-dark"}`}>{c.health}</span></td>
                          <td>{fmt(c.lastSuccessAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <h4>Platform Entitlement Overrides</h4>
                  <table className="data-table">
                    <thead><tr><th>Feature Key</th><th>Enabled</th><th>Notes</th></tr></thead>
                    <tbody>
                      {usage.platformEntitlements.length === 0 ? (
                        <tr><td colSpan={3} className="muted">Using standard tenant tier entitlements.</td></tr>
                      ) : (
                        usage.platformEntitlements.map((e) => (
                          <tr key={e.featureKey}>
                            <td><code>{e.featureKey}</code></td>
                            <td>{e.enabled ? "ENABLED" : "OFF"}</td>
                            <td>{e.notes || "—"}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </>
              ) : (
                <StateView state={{ kind: "empty", reason: "Usage summary unavailable." }} />
              )}
            </section>
          )}
        </StateView>
      </div>

      <ConfirmWithReasonDialog
        open={Boolean(confirmDialog)}
        title={confirmDialog?.title || ""}
        impactText={confirmDialog?.impactText || ""}
        confirmLabel={confirmDialog?.confirmLabel}
        destructive={confirmDialog?.destructive}
        busy={busy}
        onCancel={() => setConfirmDialog(null)}
        onConfirm={(reason) => confirmDialog?.onConfirm(reason)}
      />
    </div>
  );
}
