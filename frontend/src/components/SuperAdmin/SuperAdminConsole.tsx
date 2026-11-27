// frontend/src/components/SuperAdmin/SuperAdminConsole.tsx
// Separate Platform Admin Shell (Step 4):
// - Banner: "Platform admin: no tenant business data is shown here."
// - Navigation & action buttons strictly driven by GET /api/v2/admin/me (allowedNav & allowedActions)
// - Shared accessible dialogs for Confirm-With-Reason, Step-Up Re-Auth, and Four-Eyes Approval
// - Pseudonymous & masked tenant principals only (every view audited)
// - Preview sector packs strictly labelled "preview, not enabled" and non-selectable
// - Release Dossier is strictly read-only (zero ratify action)
// - Zero synchronous setState inside useEffect (passes oxlint react(set-state-in-effect) cleanly)

import { useState, useEffect, useCallback, type FormEvent } from "react";
import {
  ApiError,
  fetchAdminMe,
  fetchAdminOverview,
  fetchAdminTenants,
  createAdminTenant,
  updateAdminTenant,
  setAdminTenantState,
  requestAdminTenantOffboard,
  setAdminTenantSectorPack,
  fetchAdminTenantPrincipals,
  assignAdminMembership,
  revokeAdminMembership,
  fetchAdminPlatformUsers,
  createAdminPlatformUser,
  updateAdminPlatformUserRole,
  disableAdminPlatformUser,
  fetchAdminApprovals,
  decideAdminApproval,
  fetchAdminGovernance,
  fetchAdminFeatureFlags,
  setAdminFeatureFlag,
  fetchAdminEntitlements,
  setAdminEntitlement,
  fetchAdminAiQuota,
  setAdminTenantAiQuota,
  requestAdminKillSwitch,
  fetchAdminOperations,
  fetchAdminAudit,
  exportAdminAudit,
  verifyAdminStepUp,
  requestSuperAdminToken,
  fetchKillSwitchesOps,
  fetchOpsJobs,
  replayDeadLetter,
  fetchReleaseDossier,
  lookupOpsRequest,
  fetchOpsErrors,
  type AdminMeProfile,
  type AdminOverview,
  type AdminTenantRecord,
  type AdminPrincipalMembership,
  type AdminPlatformUser,
  type AdminApprovalRequestRecord,
  type AdminGovernancePack,
  type AdminFeatureFlagRecord,
  type AdminEntitlementRecord,
  type AdminAiQuotaRecord,
  type AdminOperationsOverview,
  type AdminPlatformAuditEvent,
  type KillSwitchRecord,
  type OpsJobsOverview,
  type OpsRequestRecord,
  type SafeErrorLogEntry
} from "../../api/client";
import { StateView, type ViewState } from "../StateView";
import {
  ConfirmWithReasonDialog,
  StepUpAuthDialog,
  FourEyesApprovalDialog
} from "../Admin/AdminDialogs";

interface SuperAdminConsoleProps {
  adminToken: string;
  operator: string;
  devTokenEnabled?: boolean;
  onUpdateSession?: (nextToken: string, nextOperator: string) => void;
  onSignOut: () => void;
}

type AdminSection =
  | "overview"
  | "tenants"
  | "platform_users"
  | "approvals"
  | "users"
  | "governance"
  | "entitlements"
  | "operations"
  | "audit"
  | "evidence";

type Feedback = { kind: "success" | "error" | "conflict"; title: string; message: string } | null;

interface ConfirmDialogSpec {
  title: string;
  impactText: string;
  confirmLabel: string;
  minLength?: number;
  destructive?: boolean;
  onConfirm: (reason: string) => Promise<void>;
}

const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toISOString().slice(0, 19).replace("T", " ") + " UTC" : "—";

export function SuperAdminConsole({
  adminToken,
  operator,
  devTokenEnabled = true,
  onUpdateSession,
  onSignOut
}: SuperAdminConsoleProps) {
  const [activeToken, setActiveToken] = useState(adminToken);
  const [activeOperator, setActiveOperator] = useState(operator);

  const [section, setSection] = useState<AdminSection>("overview");
  const [viewState, setViewState] = useState<ViewState>({ kind: "loading", message: "Loading Platform Admin Console..." });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const [me, setMe] = useState<AdminMeProfile | null>(null);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [tenants, setTenants] = useState<AdminTenantRecord[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<string>("");
  const [principals, setPrincipals] = useState<AdminPrincipalMembership[]>([]);
  const [platformUsers, setPlatformUsers] = useState<AdminPlatformUser[]>([]);
  const [approvals, setApprovals] = useState<AdminApprovalRequestRecord[]>([]);
  const [governancePacks, setGovernancePacks] = useState<AdminGovernancePack[]>([]);
  const [featureFlags, setFeatureFlags] = useState<AdminFeatureFlagRecord[]>([]);
  const [entitlements, setEntitlements] = useState<AdminEntitlementRecord[]>([]);
  const [aiQuotas, setAiQuotas] = useState<AdminAiQuotaRecord[]>([]);
  const [adminOps, setAdminOps] = useState<AdminOperationsOverview | null>(null);
  const [auditEvents, setAuditEvents] = useState<AdminPlatformAuditEvent[]>([]);
  const [killSwitches, setKillSwitches] = useState<KillSwitchRecord[]>([]);
  const [opsJobs, setOpsJobs] = useState<OpsJobsOverview | null>(null);
  const [opsErrors, setOpsErrors] = useState<SafeErrorLogEntry[]>([]);
  const [dossier, setDossier] = useState<any | null>(null);

  // Shared modal dialog states
  const [confirmSpec, setConfirmSpec] = useState<ConfirmDialogSpec | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const [pendingAfterStepUp, setPendingAfterStepUp] = useState<((upgradedToken: string) => Promise<void>) | null>(null);
  const [fourEyesDialog, setFourEyesDialog] = useState<{ approval: AdminApprovalRequestRecord; mode: "APPROVE" | "REJECT" } | null>(null);

  // Tenant forms
  const [tenantSearch, setTenantSearch] = useState("");
  const [newTenantName, setNewTenantName] = useState("");
  const [newTenantRegion, setNewTenantRegion] = useState("eu-west-2");
  const [newTenantSector, setNewTenantSector] = useState("LEGAL");
  const [newTenantReason, setNewTenantReason] = useState("Customer workspace onboarding approved");
  const [editingTenant, setEditingTenant] = useState<AdminTenantRecord | null>(null);
  const [editName, setEditName] = useState("");
  const [editRegion, setEditRegion] = useState("");
  const [editJurisdiction, setEditJurisdiction] = useState("");
  const [editReason, setEditReason] = useState("");

  // Platform user create form
  const [puSubject, setPuSubject] = useState("");
  const [puDisplayName, setPuDisplayName] = useState("");
  const [puRole, setPuRole] = useState<"SUPER_ADMIN" | "OPS_SUPPORT">("OPS_SUPPORT");
  const [puBreakGlass, setPuBreakGlass] = useState(false);
  const [puReason, setPuReason] = useState("");

  // Tenant Admin bootstrap membership form (EMPLOYER_ADMIN only)
  const [newSubject, setNewSubject] = useState("");
  const [newKind, setNewKind] = useState<"USER" | "WORKLOAD">("USER");
  const [newMembershipReason, setNewMembershipReason] = useState("Initial tenant administrator bootstrap");

  // Feature flag form
  const [flagTenantId, setFlagTenantId] = useState<string>("");
  const [flagName, setFlagName] = useState<"planeBOutcomes" | "aiWorkDesign" | "aiProposals">("planeBOutcomes");
  const [flagEnabled, setFlagEnabled] = useState(true);
  const [flagReason, setFlagReason] = useState("Pilot feature governance update");

  // Entitlement & AI Quota forms
  const [entTenantId, setEntTenantId] = useState<string>("");
  const [entFeatureKey, setEntFeatureKey] = useState("WORK_DESIGN_CORE");
  const [entEnabled, setEntEnabled] = useState(true);
  const [entNotes, setEntNotes] = useState("");
  const [entReason, setEntReason] = useState("");
  const [quotaEdits, setQuotaEdits] = useState<Record<string, string>>({});

  // Kill switch & DLQ & audit search
  const [ksScope, setKsScope] = useState("all_ai");
  const [ksActive, setKsActive] = useState(true);
  const [ksExpiry, setKsExpiry] = useState("");
  const [lookupReqId, setLookupReqId] = useState("");
  const [lookupRecord, setLookupRecord] = useState<OpsRequestRecord | null>(null);
  const [auditSearch, setAuditSearch] = useState("");
  const [auditActionFilter, setAuditActionFilter] = useState("");
  const [auditExportJson, setAuditExportJson] = useState<string | null>(null);

  const loadSnapshot = useCallback(async (tok: string) => {
    const [
      meRes,
      ov,
      ts,
      pu,
      ap,
      gov,
      ff,
      ent,
      aq,
      aOps,
      aud,
      ks,
      oj,
      errs,
      dos
    ] = await Promise.all([
      fetchAdminMe(tok),
      fetchAdminOverview(tok),
      fetchAdminTenants(tok),
      fetchAdminPlatformUsers(tok),
      fetchAdminApprovals(tok),
      fetchAdminGovernance(tok),
      fetchAdminFeatureFlags(tok),
      fetchAdminEntitlements(tok),
      fetchAdminAiQuota(tok),
      fetchAdminOperations(tok),
      fetchAdminAudit(tok),
      fetchKillSwitchesOps(tok).catch(() => []),
      fetchOpsJobs(tok).catch(() => null),
      fetchOpsErrors(tok).catch(() => []),
      fetchReleaseDossier()
    ]);

    return { meRes, ov, ts, pu, ap, gov, ff, ent, aq, aOps, aud, ks, oj, errs, dos };
  }, []);

  const applySnapshot = useCallback(
    (snap: Awaited<ReturnType<typeof loadSnapshot>>, preserveSelection = true) => {
      setMe(snap.meRes);
      setOverview(snap.ov);
      setTenants(snap.ts.items);
      setPlatformUsers(snap.pu.items);
      setApprovals(snap.ap.items);
      setGovernancePacks(snap.gov.sectorPacks);
      setFeatureFlags(snap.ff.items);
      setEntitlements(snap.ent.items);
      setAiQuotas(snap.aq.items);
      setAdminOps(snap.aOps);
      setAuditEvents(snap.aud.items);
      setKillSwitches(snap.ks);
      setOpsJobs(snap.oj);
      setOpsErrors(snap.errs);
      setDossier(snap.dos);
      setViewState({ kind: "ok" });

      if (snap.ts.items.length > 0) {
        setSelectedTenantId((prev) => (preserveSelection && prev ? prev : snap.ts.items[0].id));
        setFlagTenantId((prev) => (preserveSelection && prev ? prev : snap.ts.items[0].id));
        setEntTenantId((prev) => (preserveSelection && prev ? prev : snap.ts.items[0].id));
      }
    },
    []
  );

  const refreshAll = useCallback(
    async (tokenOverride?: string) => {
      const tok = tokenOverride ?? activeToken;
      try {
        const snap = await loadSnapshot(tok);
        applySnapshot(snap, true);
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          if (err.status === 401 || err.status === 403) {
            setViewState({ kind: "unauthorized" });
          } else {
            setViewState({ kind: "failed", requestId: err.requestId, message: err.message });
          }
        } else {
          setViewState({ kind: "failed", requestId: "client-error", message: err instanceof Error ? err.message : "Failed to load console." });
        }
      }
    },
    [activeToken, loadSnapshot, applySnapshot]
  );

  // Effect synchronizes with backend without synchronous setState calls
  useEffect(() => {
    let cancelled = false;
    void loadSnapshot(activeToken)
      .then((snap) => {
        if (!cancelled) applySnapshot(snap, true);
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
          setViewState({ kind: "failed", requestId: "client-error", message: err instanceof Error ? err.message : "Load failed." });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeToken, loadSnapshot, applySnapshot]);

  // Only load tenant principals when user explicitly enters the Users & Access section (every view is audited!)
  useEffect(() => {
    if (section !== "users" || !selectedTenantId) return;
    let cancelled = false;
    void fetchAdminTenantPrincipals(selectedTenantId, activeToken)
      .then((res) => {
        if (!cancelled) setPrincipals(res.items);
      })
      .catch(() => {
        if (!cancelled) setPrincipals([]);
      });
    return () => {
      cancelled = true;
    };
  }, [section, selectedTenantId, activeToken]);

  const act = async (title: string, fn: (tok: string) => Promise<string>, retryOnStepUp = true) => {
    setBusy(true);
    try {
      const msg = await fn(activeToken);
      setFeedback({ kind: "success", title, message: msg });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (retryOnStepUp && err.status === 401 && /step-up/i.test(err.message)) {
          setStepUpError(null);
          setPendingAfterStepUp(() => async (upgradedToken: string) => {
            setBusy(true);
            try {
              const msg = await fn(upgradedToken);
              setFeedback({ kind: "success", title, message: msg });
            } catch (retryErr: unknown) {
              if (retryErr instanceof ApiError) {
                setFeedback({
                  kind: retryErr.status === 409 ? "conflict" : "error",
                  title: retryErr.status === 409 ? "Conflict (409) — Reload Required" : `Refused [${retryErr.code}]`,
                  message: `${retryErr.message} (Request ID: ${retryErr.requestId})`
                });
              }
            } finally {
              setBusy(false);
            }
          });
          setStepUpOpen(true);
          return;
        }
        if (err.status === 409) {
          setFeedback({
            kind: "conflict",
            title: "Conflict (409) — Reload and retry",
            message: `${err.message} Reload latest resource state before retrying. (Request ID: ${err.requestId})`
          });
          return;
        }
        setFeedback({
          kind: "error",
          title: `Refused [${err.code}]`,
          message: `${err.message} (Request ID: ${err.requestId})`
        });
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

  const handleStepUpVerify = async (confirmation: string, mfaCode?: string) => {
    setBusy(true);
    setStepUpError(null);
    try {
      const res = await verifyAdminStepUp(confirmation, activeToken, mfaCode);
      setActiveToken(res.token);
      onUpdateSession?.(res.token, res.operator);
      setStepUpOpen(false);
      await refreshAll(res.token);
      if (pendingAfterStepUp) {
        const nextFn = pendingAfterStepUp;
        setPendingAfterStepUp(null);
        await nextFn(res.token);
      } else {
        setFeedback({
          kind: "success",
          title: "Step-Up Re-Authentication Verified",
          message: `Verified for ${res.operator} until ${fmt(res.stepUpExpiresAt)}.`
        });
      }
    } catch (err: unknown) {
      setStepUpError(err instanceof ApiError ? `${err.message} (Request ID: ${err.requestId})` : "Step-up verification failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleSwitchDevOperator = async (nextOperator: string) => {
    setBusy(true);
    try {
      const resp = await requestSuperAdminToken(nextOperator, false);
      setActiveToken(resp.token);
      setActiveOperator(resp.operator);
      onUpdateSession?.(resp.token, resp.operator);
      await refreshAll(resp.token);
      setFeedback({
        kind: "success",
        title: "Switched Platform Admin Operator",
        message: `Signed in as ${resp.operator} (distinct identity for four-eyes approval).`
      });
    } catch (err: unknown) {
      setFeedback({
        kind: "error",
        title: "Operator switch failed",
        message: err instanceof ApiError ? `${err.message} (Request ID: ${err.requestId})` : "Switch failed."
      });
    } finally {
      setBusy(false);
    }
  };

  const isNavVisible = (key: AdminSection): boolean => !me?.allowedNav || me.allowedNav.includes(key);
  const canAction = (actionKey: string): boolean => !me?.allowedActions || me.allowedActions.includes(actionKey);

  const handleCreateTenant = (e: FormEvent) => {
    e.preventDefault();
    if (!newTenantName.trim() || newTenantReason.trim().length < 5) return;
    void act("Tenant created", async (tok) => {
      const created = await createAdminTenant(
        {
          name: newTenantName.trim(),
          region: newTenantRegion.trim(),
          sectorKey: newTenantSector,
          reason: newTenantReason.trim()
        },
        tok
      );
      setNewTenantName("");
      await refreshAll(tok);
      setSelectedTenantId(created.id);
      return `Created tenant "${created.name}" (${created.id.slice(0, 8)}...) in ${created.region} with ${created.sectorKey} pack.`;
    });
  };

  const handleSaveEditTenant = (e: FormEvent) => {
    e.preventDefault();
    if (!editingTenant || editReason.trim().length < 5) return;
    void act("Tenant updated", async (tok) => {
      await updateAdminTenant(
        editingTenant.id,
        {
          name: editName.trim(),
          region: editRegion.trim(),
          jurisdictionConfigRef: editJurisdiction.trim() || null,
          reason: editReason.trim()
        },
        tok,
        editingTenant.version
      );
      setEditingTenant(null);
      setEditReason("");
      await refreshAll(tok);
      return `Updated metadata for "${editName.trim()}" (optimistic version guarded).`;
    });
  };

  const handleRequestTenantState = (t: AdminTenantRecord) => {
    const nextState: "ACTIVE" | "SUSPENDED" = t.state === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
    setConfirmSpec({
      title: nextState === "SUSPENDED" ? `Suspend Tenant: ${t.name}` : `Reactivate Tenant: ${t.name}`,
      impactText:
        nextState === "SUSPENDED"
          ? "Suspending stops tenant logins and ingestion while preserving all stored records. Requires recent step-up auth and a second distinct Super Admin approval (four-eyes)."
          : "Reactivating restores tenant logins and ingestion. Requires recent step-up auth.",
      confirmLabel: nextState === "SUSPENDED" ? "Submit Suspension Request (Four-Eyes)" : "Reactivate Tenant",
      destructive: nextState === "SUSPENDED",
      onConfirm: async (reason) => {
        setConfirmSpec(null);
        await act(nextState === "SUSPENDED" ? "Suspension queued for four-eyes" : "Tenant reactivated", async (tok) => {
          const res = await setAdminTenantState(t.id, nextState, reason, tok, t.version);
          await refreshAll(tok);
          if (res.status === "PENDING_APPROVAL" && res.approvalRequest) {
            return `Four-eyes approval request ${res.approvalRequest.id.slice(0, 8)}... created to suspend "${t.name}". A second distinct Super Admin must approve.`;
          }
          return `Tenant "${t.name}" state is now ${res.state}.`;
        });
      }
    });
  };

  const handleRequestOffboard = (t: AdminTenantRecord) => {
    setConfirmSpec({
      title: `Request Tenant Offboarding: ${t.name}`,
      impactText:
        "Offboarding NEVER hard-deletes data immediately. After four-eyes approval, the tenant enters retention, legal-hold verification, and cryptographic tombstone processing.",
      confirmLabel: "Submit Offboarding Request (Four-Eyes)",
      minLength: 10,
      destructive: true,
      onConfirm: async (reason) => {
        setConfirmSpec(null);
        await act("Offboarding request queued", async (tok) => {
          const res = await requestAdminTenantOffboard(t.id, reason, tok, t.version);
          await refreshAll(tok);
          return `Four-eyes approval request ${res.approvalRequest.id.slice(0, 8)}... queued for offboarding "${t.name}".`;
        });
      }
    });
  };

  const handleChangeTenantSector = (t: AdminTenantRecord, nextSector: string) => {
    setConfirmSpec({
      title: `Change Sector Pack for ${t.name} -> ${nextSector}`,
      impactText:
        nextSector === "GENERIC"
          ? "Reverting to Neutral Work-Design Core (GENERIC). Requires step-up verification."
          : `Enabling launched pack '${nextSector}' requires step-up auth and four-eyes approval by a second distinct Super Admin. Preview packs cannot be enabled.`,
      confirmLabel: nextSector === "GENERIC" ? "Apply Neutral Core" : "Submit Pack Request (Four-Eyes)",
      onConfirm: async (reason) => {
        setConfirmSpec(null);
        await act("Sector pack governance action", async (tok) => {
          const res = await setAdminTenantSectorPack(t.id, nextSector, reason, tok, t.version);
          await refreshAll(tok);
          if (res.status === "PENDING_APPROVAL" && res.approvalRequest) {
            return `Four-eyes approval request ${res.approvalRequest.id.slice(0, 8)}... created to enable ${nextSector} for "${t.name}".`;
          }
          return `Set "${t.name}" sector pack to ${res.sectorKey}.`;
        });
      }
    });
  };

  const handleBootstrapTenantAdmin = (e: FormEvent) => {
    e.preventDefault();
    if (!selectedTenantId || !newSubject.trim() || newMembershipReason.trim().length < 5) return;
    void act("Tenant Admin bootstrapped", async (tok) => {
      const m = await assignAdminMembership(
        selectedTenantId,
        {
          externalSubject: newSubject.trim(),
          kind: newKind,
          domainRole: "EMPLOYER_ADMIN",
          reason: newMembershipReason.trim()
        },
        tok
      );
      setNewSubject("");
      const refreshed = await fetchAdminTenantPrincipals(selectedTenantId, tok);
      setPrincipals(refreshed.items);
      await refreshAll(tok);
      return `Bootstrapped EMPLOYER_ADMIN for ${m.maskedSubject} (${m.pseudonymousId}). Workflow approval roles remain managed exclusively by Tenant Admin.`;
    });
  };

  const handleRevokeMembership = (m: AdminPrincipalMembership) => {
    setConfirmSpec({
      title: `Revoke Membership (${m.pseudonymousId})`,
      impactText: `Revoking ${m.domainRole} for ${m.maskedSubject} immediately ends this membership and records an immutable platform audit entry.`,
      confirmLabel: "Revoke Membership",
      destructive: true,
      onConfirm: async (reason) => {
        setConfirmSpec(null);
        await act("Membership revoked", async (tok) => {
          await revokeAdminMembership(selectedTenantId, m.membershipId, reason, tok, m.version);
          const refreshed = await fetchAdminTenantPrincipals(selectedTenantId, tok);
          setPrincipals(refreshed.items);
          await refreshAll(tok);
          return `Revoked ${m.domainRole} membership for ${m.pseudonymousId}.`;
        });
      }
    });
  };

  const handleCreatePlatformUser = (e: FormEvent) => {
    e.preventDefault();
    if (!puSubject.trim() || !puDisplayName.trim() || puReason.trim().length < 5) return;
    void act("Platform user action submitted", async (tok) => {
      const res = await createAdminPlatformUser(
        {
          subject: puSubject.trim(),
          displayName: puDisplayName.trim(),
          platformRole: puRole,
          breakGlass: puBreakGlass,
          reason: puReason.trim()
        },
        tok
      );
      setPuSubject("");
      setPuDisplayName("");
      setPuReason("");
      await refreshAll(tok);
      if (res.status === "PENDING_APPROVAL" && res.approvalRequest) {
        return `Four-eyes approval request ${res.approvalRequest.id.slice(0, 8)}... created to provision ${puRole}.`;
      }
      return `Created named platform account ${res.subject} (${res.platformRole}).`;
    });
  };

  const handleToggleFeatureFlag = (e: FormEvent) => {
    e.preventDefault();
    if (flagReason.trim().length < 5) return;
    void act("Feature flag governance action", async (tok) => {
      const res = await setAdminFeatureFlag(
        {
          tenantId: flagTenantId || null,
          flag: flagName,
          enabled: flagEnabled,
          reason: flagReason.trim()
        },
        tok
      );
      await refreshAll(tok);
      if (res.status === "PENDING_APPROVAL" && res.approvalRequest) {
        return `Four-eyes approval request ${res.approvalRequest.id.slice(0, 8)}... created to enable ${flagName}.`;
      }
      return `Set ${flagName} = ${String(flagEnabled)} (${flagTenantId ? "tenant" : "global"}).`;
    });
  };

  const handleSaveEntitlement = (e: FormEvent) => {
    e.preventDefault();
    if (!entTenantId || !entFeatureKey.trim() || entReason.trim().length < 5) return;
    void act("Tenant entitlement updated", async (tok) => {
      const existing = entitlements.find((x) => x.tenantId === entTenantId && x.featureKey === entFeatureKey.trim());
      const res = await setAdminEntitlement(
        {
          tenantId: entTenantId,
          featureKey: entFeatureKey.trim().toUpperCase(),
          enabled: entEnabled,
          notes: entNotes.trim() || undefined,
          reason: entReason.trim()
        },
        tok,
        existing?.version
      );
      setEntReason("");
      await refreshAll(tok);
      return `Updated entitlement ${res.featureKey}=${String(res.enabled)} (v${res.version}).`;
    });
  };

  const handleRequestKillSwitch = (e: FormEvent) => {
    e.preventDefault();
    setConfirmSpec({
      title: `Kill Switch Request: ${ksScope} -> ${ksActive ? "ACTIVE (DISABLE AI)" : "INACTIVE"}`,
      impactText:
        "Kill switches only disable AI or tool execution and never relax the privacy floor. Requires step-up auth and four-eyes approval by a second distinct Super Admin.",
      confirmLabel: "Submit Kill Switch Request (Four-Eyes)",
      destructive: true,
      onConfirm: async (reason) => {
        setConfirmSpec(null);
        await act("Kill switch queued for four-eyes", async (tok) => {
          const res = await requestAdminKillSwitch(
            {
              scope: ksScope.trim(),
              active: ksActive,
              reason,
              expiresAt: ksExpiry.trim() ? new Date(ksExpiry).toISOString() : null
            },
            tok
          );
          await refreshAll(tok);
          return `Four-eyes request ${res.approvalRequest.id.slice(0, 8)}... queued for kill switch '${ksScope}'.`;
        });
      }
    });
  };

  const handleDecideApproval = async (
    approvalId: string,
    version: number,
    mode: "APPROVE" | "REJECT",
    reason: string
  ) => {
    setFourEyesDialog(null);
    await act(mode === "APPROVE" ? "Four-eyes request approved & executed" : "Four-eyes request rejected", async (tok) => {
      const res = await decideAdminApproval(approvalId, mode, reason, tok, version);
      await refreshAll(tok);
      return `${mode === "APPROVE" ? "Executed" : "Rejected"} request ${res.id.slice(0, 8)}... (status: ${res.status}).`;
    });
  };

  const handleSearchAudit = (e: FormEvent) => {
    e.preventDefault();
    void act("Audit log filtered", async (tok) => {
      const res = await fetchAdminAudit(tok, {
        q: auditSearch.trim() || undefined,
        action: auditActionFilter.trim() || undefined
      });
      setAuditEvents(res.items);
      return `Loaded ${res.items.length} matching platform audit event(s).`;
    });
  };

  const handleExportAudit = (format: "json" | "csv") => {
    setConfirmSpec({
      title: `Export Platform Audit Log (${format.toUpperCase()})`,
      impactText: "Every audit export itself writes an immutable platform_audit_event record attributing who exported what and why.",
      confirmLabel: `Export ${format.toUpperCase()}`,
      onConfirm: async (reason) => {
        setConfirmSpec(null);
        await act("Platform audit exported", async (tok) => {
          const out = await exportAdminAudit(
            { format, reason, action: auditActionFilter.trim() || undefined },
            tok
          );
          setAuditExportJson(typeof out === "string" ? out : JSON.stringify(out, null, 2));
          await refreshAll(tok);
          return `Exported platform audit log (${format.toUpperCase()}) and recorded audit export receipt.`;
        });
      }
    });
  };

  const filteredTenants = tenants.filter((t) => {
    const q = tenantSearch.trim().toLowerCase();
    if (!q) return true;
    return t.name.toLowerCase().includes(q) || t.region.toLowerCase().includes(q) || t.id.toLowerCase().includes(q);
  });

  const pendingApprovalCount = approvals.filter((a) => a.status === "PENDING").length;

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-top">
          <div className="brand-group">
            <div className="brand-logo" style={{ background: "#2B1B38" }}>
              <span className="logo-symbol">Ω</span>
            </div>
            <div>
              <div className="brand-title">ZOIKO ABATE — SUPER ADMIN</div>
              <div className="brand-subtitle">Platform Governance, Lifecycle &amp; Operations Shell</div>
            </div>
            <div className="mission-pill" style={{ background: "#2B1B38", color: "#FFFFFF" }}>
              <span>{me?.banner || "Platform admin: no tenant business data is shown here."}</span>
            </div>
          </div>

          <div className="header-status">
            <span className="monospace-badge">{activeOperator}</span>
            <button
              type="button"
              className={`btn btn-sm ${me?.stepUpVerified ? "btn-secondary" : "btn-primary"}`}
              onClick={() => {
                setStepUpError(null);
                setPendingAfterStepUp(null);
                setStepUpOpen(true);
              }}
            >
              {me?.stepUpVerified ? "Step-Up Active" : "Verify Step-Up"}
            </button>
            {devTokenEnabled && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() =>
                  void handleSwitchDevOperator(
                    activeOperator === "superadmin@zoikoabate.dev"
                      ? "superadmin-2@zoikoabate.dev"
                      : "superadmin@zoikoabate.dev"
                  )
                }
                disabled={busy}
                aria-label="Switch Super Admin operator for four-eyes approval"
              >
                Switch to {activeOperator === "superadmin@zoikoabate.dev" ? "Admin #2" : "Admin #1"}
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void refreshAll()}
              disabled={busy}
            >
              Refresh
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={onSignOut}>
              Sign Out
            </button>
          </div>
        </div>
      </header>

      <nav className="tabs-navigation" aria-label="Super Admin Sections">
        {([
          ["overview", "Platform Overview"],
          ["tenants", "Tenant Management"],
          ["platform_users", "Platform Users"],
          ["approvals", `Four-Eyes Approvals (${pendingApprovalCount})`],
          ["users", "Users & Access"],
          ["governance", "Governance & Flags"],
          ["entitlements", "Entitlements & AI"],
          ["operations", "Worker & Kill Switches"],
          ["audit", "Platform Audit"],
          ["evidence", "Evidence & Dossier"]
        ] as Array<[AdminSection, string]>).map(([key, label]) =>
          isNavVisible(key) ? (
            <button
              key={key}
              type="button"
              className={`tab-button ${section === key ? "active" : ""}`}
              onClick={() => setSection(key)}
            >
              {label}
            </button>
          ) : null
        )}
      </nav>

      <main className="main-content">
        <div
          role="note"
          style={{
            background: "#F5F2F8",
            border: "1px solid #2B1B38",
            borderLeft: "5px solid #2B1B38",
            padding: "0.65rem 1rem",
            borderRadius: 6,
            marginBottom: "1rem",
            display: "flex",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "0.5rem"
          }}
        >
          <span>
            <strong>Platform admin: no tenant business data is shown here.</strong> DB role: <code>abate_platform_admin</code> (zero access to workforce, measurement, privacy, hazard, control, or AI-run tables).
          </span>
          <span className="monospace-badge">
            Session TTL: {me?.sessionExpiresAt ? fmt(me.sessionExpiresAt) : "15m"} · Step-Up: {me?.stepUpVerified ? "ACTIVE" : "REQUIRED FOR DESTRUCTIVE ACTIONS"}
          </span>
        </div>

        {feedback && (
          <div
            className={feedback.kind === "success" ? "success-banner" : "error-banner"}
            role={feedback.kind === "success" ? "status" : "alert"}
            style={{ marginBottom: "1rem" }}
          >
            <strong>{feedback.title}:</strong> {feedback.message}
          </div>
        )}

        <StateView state={viewState}>
          {section === "overview" && overview && (
            <section className="card">
              <h1>Platform Overview</h1>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))", gap: "1rem", marginBottom: "1.25rem" }}>
                <div className="metric-card">
                  <div className="metric-label">Total Tenants</div>
                  <div className="metric-value">{overview.counts.totalTenants}</div>
                  <small>{overview.counts.activeTenants} active · {overview.counts.suspendedTenants} suspended</small>
                </div>
                <div className="metric-card">
                  <div className="metric-label">Pending Four-Eyes</div>
                  <div className="metric-value">{overview.counts.pendingApprovals ?? pendingApprovalCount}</div>
                  <small>Awaiting second approver</small>
                </div>
                <div className="metric-card">
                  <div className="metric-label">Database &amp; Store</div>
                  <div className="metric-value">{overview.system.databaseOk ? "PostgreSQL" : "In-Memory"}</div>
                  <small>Store: {overview.system.objectStoreMode} ({overview.system.objectStoreOk ? "OK" : "Degraded"})</small>
                </div>
                <div className="metric-card">
                  <div className="metric-label">Worker &amp; Outbox</div>
                  <div className="metric-value">{overview.system.workerState}</div>
                  <small>{overview.counts.pendingOutbox} pending · {overview.counts.deadLetterCount} dead-letter</small>
                </div>
                <div className="metric-card">
                  <div className="metric-label">Platform Audit Events</div>
                  <div className="metric-value">{overview.counts.platformAuditCount}</div>
                  <small>Append-only trigger enforced</small>
                </div>
              </div>

              <h2>
                SLO Summary{" "}
                <span className="badge badge-dark">
                  {overview.sloEvidenceState === "MEASURED" ? "MEASURED (LIVE PG)" : "ASSUMPTION (LOCAL MEMORY)"}
                </span>
              </h2>
              <p className="muted">
                Overall Status: <strong>{overview.slo.overall}</strong> · Requests Observed: {overview.slo.window.requests} · Availability: {overview.slo.availability.ratio !== null ? `${(overview.slo.availability.ratio * 100).toFixed(2)}%` : "N/A"}
              </p>

              <h2>Operational Alerts</h2>
              {overview.alerts.length === 0 ? (
                <StateView state={{ kind: "empty", reason: "No active operational alerts." }} />
              ) : (
                <table className="data-table">
                  <thead>
                    <tr><th>Rule</th><th>Severity</th><th>State</th><th>Detail</th></tr>
                  </thead>
                  <tbody>
                    {overview.alerts.map((a, idx) => (
                      <tr key={a.id ?? idx}>
                        <td>{a.id}</td>
                        <td><span className={`badge ${String(a.severity).toUpperCase() === "CRITICAL" ? "badge-coral" : "badge-dark"}`}>{a.severity}</span></td>
                        <td>{a.state ?? (a.firing ? "FIRING" : "OK")}</td>
                        <td>{a.summary ?? a.message ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}

          {section === "tenants" && (
            <section className="card">
              <h1>Tenant Management</h1>
              <p className="muted">
                Only launched packs (<code>LEGAL</code>) and neutral core (<code>GENERIC</code>) may be enabled. Preview packs are disabled pending policy review.
              </p>

              {canAction("admin.tenant.create") && (
                <form onSubmit={handleCreateTenant} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 2fr auto", gap: "0.75rem", alignItems: "end", marginBottom: "1.5rem" }}>
                  <div>
                    <label htmlFor="admin-new-tenant-name" className="context-label">New Tenant Name</label>
                    <input id="admin-new-tenant-name" className="select-control" style={{ width: "100%" }} value={newTenantName} onChange={(e) => setNewTenantName(e.target.value)} placeholder="Acme Workspace Ltd" required />
                  </div>
                  <div>
                    <label htmlFor="admin-new-tenant-region" className="context-label">Region</label>
                    <input id="admin-new-tenant-region" className="select-control" style={{ width: "100%" }} value={newTenantRegion} onChange={(e) => setNewTenantRegion(e.target.value)} required />
                  </div>
                  <div>
                    <label htmlFor="admin-new-tenant-sector" className="context-label">Sector Pack</label>
                    <select id="admin-new-tenant-sector" className="select-control" style={{ width: "100%" }} value={newTenantSector} onChange={(e) => setNewTenantSector(e.target.value)}>
                      <option value="LEGAL">Legal (Launched)</option>
                      <option value="GENERIC">Generic (Neutral Core)</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="admin-new-tenant-reason" className="context-label">Audit Reason</label>
                    <input id="admin-new-tenant-reason" className="select-control" style={{ width: "100%" }} value={newTenantReason} onChange={(e) => setNewTenantReason(e.target.value)} minLength={5} required />
                  </div>
                  <button type="submit" className="btn btn-primary" disabled={busy}>Create Tenant</button>
                </form>
              )}

              {editingTenant && (
                <form onSubmit={handleSaveEditTenant} className="card" style={{ background: "#F8F6FA", marginBottom: "1rem" }}>
                  <h2>Edit Tenant: {editingTenant.name} (v{editingTenant.version})</h2>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1.5fr auto auto", gap: "0.5rem", alignItems: "end" }}>
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
                    <div>
                      <label htmlFor="admin-edit-reason" className="context-label">Reason (min 5 chars)</label>
                      <input id="admin-edit-reason" className="select-control" value={editReason} onChange={(e) => setEditReason(e.target.value)} minLength={5} required />
                    </div>
                    <button type="submit" className="btn btn-primary" disabled={busy}>Save</button>
                    <button type="button" className="btn btn-secondary" onClick={() => setEditingTenant(null)}>Cancel</button>
                  </div>
                </form>
              )}

              <div style={{ marginBottom: "0.75rem" }}>
                <label htmlFor="admin-tenant-search" className="context-label" style={{ display: "block", marginBottom: "0.25rem" }}>Search Tenants</label>
                <input
                  id="admin-tenant-search"
                  type="search"
                  className="select-control"
                  placeholder="Search tenants by name, region, or ID..."
                  value={tenantSearch}
                  onChange={(e) => setTenantSearch(e.target.value)}
                  style={{ width: "100%", maxWidth: 360 }}
                />
              </div>

              <StateView state={filteredTenants.length === 0 ? { kind: "empty", reason: "No tenants match your filter." } : { kind: "ok" }}>
                <table className="data-table">
                  <thead>
                    <tr><th>Tenant Name</th><th>Region</th><th>State / Version</th><th>Sector Pack</th><th>Actions</th></tr>
                  </thead>
                  <tbody>
                    {filteredTenants.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <strong>{t.name}</strong><br />
                          <small className="monospace-badge">{t.id}</small>
                          {t.offboardRequestedAt && (
                            <div><span className="badge badge-warning">OFFBOARDING QUEUED ({fmt(t.offboardRequestedAt)})</span></div>
                          )}
                        </td>
                        <td>{t.region}</td>
                        <td>
                          <span className={`badge ${t.state === "ACTIVE" ? "badge-success" : "badge-coral"}`}>{t.state}</span>{" "}
                          <small className="monospace-badge">v{t.version}</small>
                        </td>
                        <td>
                          <select
                            className="select-control"
                            value={t.sectorKey}
                            aria-label={`Sector pack for ${t.name}`}
                            onChange={(e) => handleChangeTenantSector(t, e.target.value)}
                          >
                            <option value="LEGAL">LEGAL (Launched)</option>
                            <option value="GENERIC">GENERIC (Core)</option>
                          </select>
                        </td>
                        <td style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => {
                              setEditingTenant(t);
                              setEditName(t.name);
                              setEditRegion(t.region);
                              setEditJurisdiction(t.jurisdictionConfigRef || "");
                              setEditReason("Tenant metadata update");
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleRequestTenantState(t)}
                            disabled={busy}
                          >
                            {t.state === "ACTIVE" ? "Suspend" : "Activate"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleRequestOffboard(t)}
                            disabled={busy || Boolean(t.offboardRequestedAt)}
                          >
                            Offboard Request
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </StateView>
            </section>
          )}

          {section === "platform_users" && (
            <section className="card">
              <h1>Platform Staff Accounts</h1>
              <p className="muted">Named individual accounts only (no shared credentials). Adding, promoting, or disabling a Super Admin requires step-up auth and four-eyes approval.</p>

              <form onSubmit={handleCreatePlatformUser} style={{ display: "grid", gridTemplateColumns: "1.5fr 1.5fr 1fr 1.5fr auto", gap: "0.75rem", alignItems: "end", marginBottom: "1.25rem" }}>
                <div>
                  <label htmlFor="pu-subject" className="context-label">Named Staff Email / Subject</label>
                  <input id="pu-subject" className="select-control" style={{ width: "100%" }} value={puSubject} onChange={(e) => setPuSubject(e.target.value)} placeholder="priya.sharma@zoikoabate.dev" required />
                </div>
                <div>
                  <label htmlFor="pu-display" className="context-label">Full Name</label>
                  <input id="pu-display" className="select-control" style={{ width: "100%" }} value={puDisplayName} onChange={(e) => setPuDisplayName(e.target.value)} placeholder="Priya Sharma" required />
                </div>
                <div>
                  <label htmlFor="pu-role" className="context-label">Platform Role</label>
                  <select id="pu-role" className="select-control" style={{ width: "100%" }} value={puRole} onChange={(e) => setPuRole(e.target.value as "SUPER_ADMIN" | "OPS_SUPPORT")}>
                    <option value="OPS_SUPPORT">OPS_SUPPORT</option>
                    <option value="SUPER_ADMIN">SUPER_ADMIN (Four-Eyes)</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="pu-reason" className="context-label">Audit Reason</label>
                  <input id="pu-reason" className="select-control" style={{ width: "100%" }} value={puReason} onChange={(e) => setPuReason(e.target.value)} placeholder="Security onboarding ticket..." minLength={5} required />
                </div>
                <button type="submit" className="btn btn-primary" disabled={busy}>Provision Staff</button>
              </form>

              <div style={{ marginBottom: "1rem" }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                  <input type="checkbox" checked={puBreakGlass} onChange={(e) => setPuBreakGlass(e.target.checked)} />
                  Break-glass emergency account (alerts on use; requires four-eyes approval)
                </label>
              </div>

              <table className="data-table">
                <thead>
                  <tr><th>Subject</th><th>Display Name</th><th>Role</th><th>Status</th><th>MFA / Break-Glass</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  {platformUsers.map((u) => (
                    <tr key={u.id}>
                      <td className="monospace-badge">{u.subject}</td>
                      <td>{u.displayName}</td>
                      <td><strong>{u.platformRole}</strong></td>
                      <td><span className={`badge ${u.status === "ACTIVE" ? "badge-success" : "badge-dark"}`}>{u.status}</span></td>
                      <td>{u.mfaEnforced ? "MFA Required" : "No MFA"}{u.breakGlass ? " · BREAK-GLASS" : ""}</td>
                      <td style={{ display: "flex", gap: "0.4rem" }}>
                        {u.status === "ACTIVE" && (
                          <>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => {
                                const nextRole = u.platformRole === "SUPER_ADMIN" ? "OPS_SUPPORT" : "SUPER_ADMIN";
                                setConfirmSpec({
                                  title: `Change Role: ${u.subject} -> ${nextRole}`,
                                  impactText:
                                    nextRole === "SUPER_ADMIN"
                                      ? "Promoting to SUPER_ADMIN requires step-up auth and four-eyes approval."
                                      : "Demoting to OPS_SUPPORT restricts access to read-only operational views.",
                                  confirmLabel: `Change to ${nextRole}`,
                                  onConfirm: async (reason) => {
                                    setConfirmSpec(null);
                                    await act("Platform user role update", async (tok) => {
                                      const res = await updateAdminPlatformUserRole(u.id, nextRole, reason, tok, u.version);
                                      await refreshAll(tok);
                                      return res.status === "PENDING_APPROVAL"
                                        ? `Four-eyes approval queued (${res.approvalRequest.id.slice(0, 8)}...) to promote ${u.subject}.`
                                        : `Updated ${u.subject} role to ${nextRole}.`;
                                    });
                                  }
                                });
                              }}
                              disabled={busy}
                            >
                              {u.platformRole === "SUPER_ADMIN" ? "Demote to Ops" : "Promote to Super Admin"}
                            </button>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() =>
                                setConfirmSpec({
                                  title: `Disable Platform Account: ${u.subject}`,
                                  impactText: "Disables platform access for this operator. Disabling a SUPER_ADMIN requires four-eyes approval.",
                                  confirmLabel: "Disable Account",
                                  destructive: true,
                                  onConfirm: async (reason) => {
                                    setConfirmSpec(null);
                                    await act("Platform user disable", async (tok) => {
                                      const res = await disableAdminPlatformUser(u.id, reason, tok, u.version);
                                      await refreshAll(tok);
                                      return res.status === "PENDING_APPROVAL"
                                        ? `Four-eyes approval queued (${res.approvalRequest.id.slice(0, 8)}...) to disable ${u.subject}.`
                                        : `Disabled ${u.subject}.`;
                                    });
                                  }
                                })
                              }
                              disabled={busy || u.subject.toLowerCase() === activeOperator.toLowerCase()}
                            >
                              Disable
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {section === "approvals" && (
            <section className="card">
              <h1>Four-Eyes Approval Queue</h1>
              <p className="muted">
                Destructive platform actions require a second, distinct Super Admin to approve. Self-approval is refused (403) and replayed approvals are refused (409).
              </p>

              <StateView state={approvals.length === 0 ? { kind: "empty", reason: "No four-eyes approval requests recorded yet." } : { kind: "ok" }}>
                <table className="data-table">
                  <thead>
                    <tr><th>Action</th><th>Target</th><th>Requested By</th><th>Reason</th><th>Status</th><th>Decision</th></tr>
                  </thead>
                  <tbody>
                    {approvals.map((a) => (
                      <tr key={a.id}>
                        <td><code>{a.actionType}</code></td>
                        <td className="monospace-badge">{a.targetType}: {a.targetId.slice(0, 18)}</td>
                        <td>{a.requestedBy}<br /><small>{fmt(a.requestedAt)}</small></td>
                        <td>{a.reason}</td>
                        <td>
                          <span className={`badge ${a.status === "EXECUTED" ? "badge-success" : a.status === "PENDING" ? "badge-warning" : "badge-dark"}`}>
                            {a.status}
                          </span>
                          {a.approvedBy && <div><small>by {a.approvedBy}</small></div>}
                        </td>
                        <td>
                          {a.status === "PENDING" ? (
                            <div style={{ display: "flex", gap: "0.4rem" }}>
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                onClick={() => setFourEyesDialog({ approval: a, mode: "APPROVE" })}
                                disabled={busy}
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => setFourEyesDialog({ approval: a, mode: "REJECT" })}
                                disabled={busy}
                              >
                                Reject
                              </button>
                            </div>
                          ) : (
                            <small>{a.decisionReason || "—"}</small>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </StateView>
            </section>
          )}

          {section === "users" && (
            <section className="card">
              <h1>Users, Principals &amp; Role Memberships</h1>
              <div className="callout-info" style={{ marginBottom: "1rem" }}>
                <strong>DPO Privacy Protection &amp; Role Separation:</strong> Tenant principals are shown strictly as pseudonymous IDs and masked identifiers, and every view is logged to <code>platform_audit_event</code>. Platform Super Admin can only bootstrap an initial <code>EMPLOYER_ADMIN</code> (never workflow approval roles or self-assignments).
              </div>

              <div style={{ marginBottom: "1rem" }}>
                <label htmlFor="admin-user-tenant-select" className="context-label">Select Tenant: </label>
                <select id="admin-user-tenant-select" className="select-control" value={selectedTenantId} onChange={(e) => setSelectedTenantId(e.target.value)}>
                  {tenants.map((t) => <option key={t.id} value={t.id}>{t.name} [{t.region}]</option>)}
                </select>
              </div>

              <form onSubmit={handleBootstrapTenantAdmin} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1.5fr 2fr auto", gap: "0.75rem", alignItems: "end", marginBottom: "1.25rem" }}>
                <div>
                  <label htmlFor="admin-new-subject" className="context-label">Tenant Admin Subject (OIDC)</label>
                  <input id="admin-new-subject" className="select-control" style={{ width: "100%" }} value={newSubject} onChange={(e) => setNewSubject(e.target.value)} placeholder="auth0|customer-tenant-admin" required />
                </div>
                <div>
                  <label htmlFor="admin-new-kind" className="context-label">Kind</label>
                  <select id="admin-new-kind" className="select-control" style={{ width: "100%" }} value={newKind} onChange={(e) => setNewKind(e.target.value as "USER" | "WORKLOAD")}>
                    <option value="USER">USER</option>
                    <option value="WORKLOAD">WORKLOAD</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="admin-new-role" className="context-label">Bootstrap Role</label>
                  <select id="admin-new-role" className="select-control" style={{ width: "100%" }} value="EMPLOYER_ADMIN" disabled>
                    <option value="EMPLOYER_ADMIN">EMPLOYER_ADMIN (Bootstrap Only)</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="admin-new-reason" className="context-label">Audit Reason</label>
                  <input id="admin-new-reason" className="select-control" style={{ width: "100%" }} value={newMembershipReason} onChange={(e) => setNewMembershipReason(e.target.value)} minLength={5} required />
                </div>
                <button type="submit" className="btn btn-primary" disabled={busy}>Bootstrap Tenant Admin</button>
              </form>

              <table className="data-table">
                <thead>
                  <tr><th>Pseudonymous ID</th><th>Masked Subject</th><th>Kind</th><th>Role</th><th>Status</th><th>Valid From</th><th>Action</th></tr>
                </thead>
                <tbody>
                  {principals.map((p) => (
                    <tr key={p.membershipId}>
                      <td className="monospace-badge">{p.pseudonymousId}</td>
                      <td className="monospace-badge">{p.maskedSubject}</td>
                      <td>{p.kind}</td>
                      <td><strong>{p.domainRole}</strong></td>
                      <td><span className={`badge ${p.active ? "badge-success" : "badge-dark"}`}>{p.active ? "ACTIVE" : "REVOKED"}</span></td>
                      <td>{fmt(p.validFrom)}</td>
                      <td>
                        {p.active && (
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleRevokeMembership(p)} disabled={busy}>
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {section === "governance" && (
            <section className="card">
              <h1>Governance Packs &amp; Feature Flags</h1>
              <h2>Registered Sector &amp; Jurisdiction Packs</h2>
              <table className="data-table" style={{ marginBottom: "1.5rem" }}>
                <thead>
                  <tr><th>Sector Key</th><th>Display Name</th><th>Status</th><th>Can Enable?</th><th>Restrictions</th></tr>
                </thead>
                <tbody>
                  {governancePacks.map((p) => (
                    <tr key={p.sectorKey}>
                      <td><code>{p.sectorKey}</code></td>
                      <td>{p.displayName}</td>
                      <td>
                        <span className={`badge ${p.enableable ? "badge-success" : "badge-dark"}`}>
                          {p.statusLabel || (p.enableable ? p.status : "preview, not enabled")}
                        </span>
                      </td>
                      <td>{p.enableable ? "Yes (Four-Eyes for Launched)" : "No — preview, not enabled"}</td>
                      <td>{p.restrictions.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h2>Feature Flags (All Defaults Off · Four-Eyes Required to Enable)</h2>
              <form onSubmit={handleToggleFeatureFlag} style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr 2fr auto", gap: "0.75rem", alignItems: "end", marginBottom: "1rem" }}>
                <div>
                  <label htmlFor="ff-tenant" className="context-label">Tenant Scope</label>
                  <select id="ff-tenant" className="select-control" style={{ width: "100%" }} value={flagTenantId} onChange={(e) => setFlagTenantId(e.target.value)}>
                    <option value="">Global (All Tenants)</option>
                    {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="ff-name" className="context-label">Flag</label>
                  <select id="ff-name" className="select-control" style={{ width: "100%" }} value={flagName} onChange={(e) => setFlagName(e.target.value as any)}>
                    <option value="planeBOutcomes">planeBOutcomes</option>
                    <option value="aiWorkDesign">aiWorkDesign</option>
                    <option value="aiProposals">aiProposals</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="ff-enabled" className="context-label">State</label>
                  <select id="ff-enabled" className="select-control" style={{ width: "100%" }} value={String(flagEnabled)} onChange={(e) => setFlagEnabled(e.target.value === "true")}>
                    <option value="true">Enable (Four-Eyes)</option>
                    <option value="false">Disable (Immediate)</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="ff-reason" className="context-label">Mandatory Reason</label>
                  <input id="ff-reason" className="select-control" style={{ width: "100%" }} value={flagReason} onChange={(e) => setFlagReason(e.target.value)} minLength={5} required />
                </div>
                <button type="submit" className="btn btn-primary" disabled={busy}>Submit Flag</button>
              </form>

              <table className="data-table">
                <thead><tr><th>Scope</th><th>Flag</th><th>Enabled</th><th>Changed By</th><th>Changed At</th></tr></thead>
                <tbody>
                  {featureFlags.map((f, i) => (
                    <tr key={`${f.tenant_id ?? "global"}-${f.flag}-${i}`}>
                      <td className="monospace-badge">{f.tenant_id ?? "GLOBAL"}</td>
                      <td><code>{f.flag}</code></td>
                      <td><span className={`badge ${f.enabled ? "badge-success" : "badge-dark"}`}>{f.enabled ? "ENABLED" : "OFF"}</span></td>
                      <td>{f.changed_by || "—"}</td>
                      <td>{fmt(f.changed_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {section === "entitlements" && (
            <section className="card">
              <h1>Commercial Entitlements &amp; AI Quota Controls</h1>
              <p className="muted">Entitlement AND Policy dual gate. Entitlements never accept or alter privacy-floor settings.</p>

              <form onSubmit={handleSaveEntitlement} style={{ display: "grid", gridTemplateColumns: "1.5fr 1.2fr 0.8fr 1.5fr auto", gap: "0.75rem", alignItems: "end", marginBottom: "1.25rem" }}>
                <div>
                  <label htmlFor="ent-tenant" className="context-label">Tenant</label>
                  <select id="ent-tenant" className="select-control" style={{ width: "100%" }} value={entTenantId} onChange={(e) => setEntTenantId(e.target.value)}>
                    {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="ent-key" className="context-label">Feature Key</label>
                  <input id="ent-key" className="select-control" style={{ width: "100%" }} value={entFeatureKey} onChange={(e) => setEntFeatureKey(e.target.value)} required />
                </div>
                <div>
                  <label htmlFor="ent-enabled" className="context-label">Enabled</label>
                  <select id="ent-enabled" className="select-control" style={{ width: "100%" }} value={String(entEnabled)} onChange={(e) => setEntEnabled(e.target.value === "true")}>
                    <option value="true">Enabled</option>
                    <option value="false">Disabled</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="ent-reason" className="context-label">Audit Reason</label>
                  <input id="ent-reason" className="select-control" style={{ width: "100%" }} value={entReason} onChange={(e) => setEntReason(e.target.value)} placeholder="Contract tier update..." minLength={5} required />
                </div>
                <button type="submit" className="btn btn-primary" disabled={busy}>Set Entitlement</button>
              </form>

              <div style={{ marginBottom: "1rem" }}>
                <label htmlFor="ent-notes" className="context-label">Optional Commercial Note: </label>
                <input id="ent-notes" className="select-control" value={entNotes} onChange={(e) => setEntNotes(e.target.value)} placeholder="Commercial order reference" style={{ width: 320 }} />
              </div>

              <table className="data-table" style={{ marginBottom: "1.5rem" }}>
                <thead><tr><th>Tenant</th><th>Feature Key</th><th>Enabled</th><th>Version</th><th>Updated By</th></tr></thead>
                <tbody>
                  {entitlements.length === 0 ? (
                    <tr><td colSpan={5} className="muted">No custom platform entitlements overridden yet.</td></tr>
                  ) : (
                    entitlements.map((e) => (
                      <tr key={`${e.tenantId}:${e.featureKey}`}>
                        <td className="monospace-badge">{e.tenantId.slice(0, 8)}...</td>
                        <td><code>{e.featureKey}</code></td>
                        <td><span className={`badge ${e.enabled ? "badge-success" : "badge-dark"}`}>{e.enabled ? "ENABLED" : "OFF"}</span></td>
                        <td>v{e.version}</td>
                        <td>{e.updatedBy || "—"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>

              <h2>Per-Tenant AI Monthly Quota Caps (Minor Units)</h2>
              <table className="data-table">
                <thead><tr><th>Tenant</th><th>State</th><th>Current Cap</th><th>New Cap</th><th>Action</th></tr></thead>
                <tbody>
                  {aiQuotas.map((q) => (
                    <tr key={q.tenantId}>
                      <td><strong>{q.tenantName}</strong></td>
                      <td>{q.tenantState}</td>
                      <td className="monospace-badge">{q.monthlyBudgetMinor} (v{q.version})</td>
                      <td>
                        <input
                          type="number"
                          aria-label={`Monthly AI budget cap for ${q.tenantName}`}
                          className="select-control"
                          value={quotaEdits[q.tenantId] ?? String(q.monthlyBudgetMinor)}
                          onChange={(e) => setQuotaEdits((prev) => ({ ...prev, [q.tenantId]: e.target.value }))}
                          min={0}
                          style={{ width: 130 }}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            const nextVal = Number(quotaEdits[q.tenantId] ?? q.monthlyBudgetMinor);
                            setConfirmSpec({
                              title: `Update AI Quota Cap: ${q.tenantName}`,
                              impactText: `Sets monthly AI spend budget cap to ${nextVal} minor units for ${q.tenantName}.`,
                              confirmLabel: "Save AI Quota Cap",
                              onConfirm: async (reason) => {
                                setConfirmSpec(null);
                                await act("AI quota updated", async (tok) => {
                                  const saved = await setAdminTenantAiQuota(q.tenantId, nextVal, reason, tok, q.version);
                                  await refreshAll(tok);
                                  return `Set AI monthly quota for ${q.tenantName} to ${saved.monthlyBudgetMinor} (v${saved.version}).`;
                                });
                              }
                            });
                          }}
                          disabled={busy}
                        >
                          Update Quota
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {section === "operations" && (
            <section className="card">
              <h1>Platform Operations, Kill Switches &amp; Diagnostics</h1>
              <p className="muted">Operational metadata only — zero tenant payloads. Kill switch changes require step-up auth and four-eyes approval.</p>

              <h2>Governed AI &amp; Tool Kill Switches</h2>
              <form onSubmit={handleRequestKillSwitch} style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1.5fr auto", gap: "0.75rem", alignItems: "end", marginBottom: "1rem" }}>
                <div>
                  <label htmlFor="ks-scope" className="context-label">Scope</label>
                  <select id="ks-scope" className="select-control" style={{ width: "100%" }} value={ksScope} onChange={(e) => setKsScope(e.target.value)}>
                    <option value="all_ai">all_ai (Global AI Off)</option>
                    <option value="use_case:EXPLAIN_RELEASE">use_case:EXPLAIN_RELEASE</option>
                    <option value="use_case:DRAFT_CAUSE">use_case:DRAFT_CAUSE</option>
                    <option value="use_case:DRAFT_CONTROL">use_case:DRAFT_CONTROL</option>
                    <option value="provider:default">provider:default</option>
                    <option value="tool:calendar_adjust">tool:calendar_adjust</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="ks-active" className="context-label">Target State</label>
                  <select id="ks-active" className="select-control" style={{ width: "100%" }} value={String(ksActive)} onChange={(e) => setKsActive(e.target.value === "true")}>
                    <option value="true">ACTIVE (Disable AI)</option>
                    <option value="false">INACTIVE (Resume)</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="ks-expiry" className="context-label">Optional Expiry (ISO / Local)</label>
                  <input id="ks-expiry" type="datetime-local" className="select-control" style={{ width: "100%" }} value={ksExpiry} onChange={(e) => setKsExpiry(e.target.value)} />
                </div>
                <button type="submit" className="btn btn-primary" disabled={busy}>Request Kill Switch</button>
              </form>

              <table className="data-table" style={{ marginBottom: "1.5rem" }}>
                <thead><tr><th>Scope</th><th>State</th><th>Changed By</th><th>Reason</th></tr></thead>
                <tbody>
                  {killSwitches.map((k) => (
                    <tr key={k.scope}>
                      <td><code>{k.scope}</code></td>
                      <td><span className={`badge ${k.active ? "badge-coral" : "badge-success"}`}>{k.active ? "ACTIVE (BLOCKED)" : "INACTIVE"}</span></td>
                      <td>{k.changed_by || "—"}</td>
                      <td>{k.reason || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h2>Worker Queue, Dead-Letters &amp; Connector Freshness</h2>
              {adminOps && (
                <p className="muted">
                  Worker: <strong>{adminOps.worker.state}</strong> · Heartbeat: {fmt(adminOps.worker.heartbeatAt)} · Queue Depth: {adminOps.queueDepth} · Dead Letters: {adminOps.deadLetterCount} · Connectors Tracked: {adminOps.connectors.length}
                </p>
              )}

              {opsJobs && opsJobs.items.filter((j) => j.state === "DEAD_LETTER").length > 0 && (
                <table className="data-table" style={{ marginBottom: "1.25rem" }}>
                  <thead><tr><th>Dead-Letter ID</th><th>Type</th><th>Attempts</th><th>Last Error</th><th>Action</th></tr></thead>
                  <tbody>
                    {opsJobs.items
                      .filter((j) => j.state === "DEAD_LETTER")
                      .map((d) => (
                        <tr key={d.id}>
                          <td className="monospace-badge">{d.id.slice(0, 12)}...</td>
                          <td>{d.type}</td>
                          <td>{d.attempts}</td>
                          <td>{d.lastError || "—"}</td>
                          <td>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() =>
                                setConfirmSpec({
                                  title: `Replay Dead-Letter Event`,
                                  impactText: "Re-queues this outbox event to PENDING while permanently preserving the dead-letter row with operator attribution and reason.",
                                  confirmLabel: "Approve Replay",
                                  onConfirm: async (reason) => {
                                    setConfirmSpec(null);
                                    await act("Dead-letter replayed", async (tok) => {
                                      await replayDeadLetter(d.id, reason, tok);
                                      await refreshAll(tok);
                                      return `Replayed dead-letter ${d.id.slice(0, 12)}...`;
                                    });
                                  }
                                })
                              }
                            >
                              Replay
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}

              <h2>Content-Free Request ID Lookup &amp; Safe Error Log</h2>
              <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
                <label htmlFor="ops-req-lookup" className="context-label" style={{ alignSelf: "center" }}>Request ID</label>
                <input id="ops-req-lookup" className="select-control" placeholder="Enter requestId..." value={lookupReqId} onChange={(e) => setLookupReqId(e.target.value)} />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    void act("Request located", async (tok) => {
                      const r = await lookupOpsRequest(lookupReqId.trim(), tok);
                      setLookupRecord(r);
                      return `${r.method} ${r.route} -> ${r.status}`;
                    })
                  }
                >
                  Lookup
                </button>
              </div>
              {lookupRecord && (
                <pre tabIndex={0} aria-label="Request lookup JSON" style={{ background: "#F5F2F8", padding: "0.75rem", borderRadius: 6, overflowX: "auto" }}>
                  {JSON.stringify(lookupRecord, null, 2)}
                </pre>
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

          {section === "audit" && (
            <section className="card">
              <h1>Immutable Platform Audit Log</h1>
              <form onSubmit={handleSearchAudit} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "end", marginBottom: "1rem" }}>
                <div>
                  <label htmlFor="audit-search-q" className="context-label">Search</label>
                  <input id="audit-search-q" className="select-control" value={auditSearch} onChange={(e) => setAuditSearch(e.target.value)} placeholder="operator, target, reason, requestId..." />
                </div>
                <div>
                  <label htmlFor="audit-search-action" className="context-label">Action Filter</label>
                  <input id="audit-search-action" className="select-control" value={auditActionFilter} onChange={(e) => setAuditActionFilter(e.target.value)} placeholder="tenant.suspend..." />
                </div>
                <button type="submit" className="btn btn-secondary" disabled={busy}>Filter</button>
                <button type="button" className="btn btn-secondary" onClick={() => handleExportAudit("json")} disabled={busy}>Export JSON (Audited)</button>
                <button type="button" className="btn btn-secondary" onClick={() => handleExportAudit("csv")} disabled={busy}>Export CSV (Audited)</button>
              </form>

              {auditExportJson && (
                <pre tabIndex={0} aria-label="Audited platform export output" style={{ background: "#F5F2F8", padding: "0.75rem", borderRadius: 6, maxHeight: 220, overflow: "auto", marginBottom: "1rem" }}>
                  {auditExportJson}
                </pre>
              )}

              <table className="data-table">
                <thead>
                  <tr><th>Time</th><th>Operator</th><th>Approver</th><th>Action</th><th>Target</th><th>Reason</th><th>Request ID</th></tr>
                </thead>
                <tbody>
                  {auditEvents.map((a) => (
                    <tr key={a.id}>
                      <td>{fmt(a.occurred_at)}</td>
                      <td>{a.operator}</td>
                      <td>{a.approver || "—"}</td>
                      <td><code>{a.action}</code></td>
                      <td className="monospace-badge">{a.target_type}: {a.target_id.slice(0, 18)}</td>
                      <td>{a.reason || "—"}</td>
                      <td className="monospace-badge">{a.request_id || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {section === "evidence" && (
            <section className="card">
              <h1>Evidence &amp; Release Dossier Readiness</h1>
              <p className="muted">
                Read-only view. Only the named Release Authority running offline <code>sign-dossier</code> can ratify a release dossier; no admin button may ratify it.
              </p>
              {dossier ? (
                <div>
                  <p>
                    <strong>Dossier Status:</strong> <span className="badge badge-dark">{dossier.status}</span> ·{" "}
                    <strong>Commit:</strong> <code>{dossier.commitSha || "unknown"}</code>
                  </p>
                  <p><strong>Checks Passing:</strong> {dossier.totalChecksPassed ?? "—"}</p>
                  <pre tabIndex={0} aria-label="Release dossier JSON" style={{ background: "#F5F2F8", padding: "1rem", borderRadius: 6, overflowX: "auto", maxHeight: 420 }}>
                    {JSON.stringify(dossier, null, 2)}
                  </pre>
                </div>
              ) : (
                <StateView state={{ kind: "empty", reason: "No release dossier artifact loaded." }} />
              )}
            </section>
          )}
        </StateView>
      </main>

      <ConfirmWithReasonDialog
        open={Boolean(confirmSpec)}
        title={confirmSpec?.title || ""}
        impactText={confirmSpec?.impactText || ""}
        confirmLabel={confirmSpec?.confirmLabel}
        minLength={confirmSpec?.minLength}
        destructive={confirmSpec?.destructive}
        busy={busy}
        onCancel={() => setConfirmSpec(null)}
        onConfirm={(reason) => confirmSpec?.onConfirm(reason)}
      />

      <StepUpAuthDialog
        open={stepUpOpen}
        operator={activeOperator}
        windowSeconds={me?.stepUpWindowSeconds ?? 300}
        busy={busy}
        error={stepUpError}
        onCancel={() => {
          setStepUpOpen(false);
          setPendingAfterStepUp(null);
        }}
        onVerify={handleStepUpVerify}
      />

      <FourEyesApprovalDialog
        open={Boolean(fourEyesDialog)}
        approval={fourEyesDialog?.approval ?? null}
        currentOperator={activeOperator}
        mode={fourEyesDialog?.mode ?? "APPROVE"}
        busy={busy}
        onCancel={() => setFourEyesDialog(null)}
        onDecide={handleDecideApproval}
      />
    </div>
  );
}
