// frontend/src/components/Tabs/RetentionTab.tsx
import { useState, useEffect, useCallback } from "react";
import {
  PRESET_TENANTS,
  fetchRetentionState,
  fetchPackVersions,
  fetchConnections,
  previewRetention,
  setRetentionClass,
  runRetention,
  placeLegalHold,
  releaseLegalHold,
  submitZoikoBatch,
  type RetentionState,
  type RetentionPreview,
  type JurisdictionPack,
  type Connection,
  type RetentionRunStatus
} from "../../api/client";

interface RetentionTabProps {
  currentTenant: typeof PRESET_TENANTS[0];
  token: string | null;
}

type Feedback = { kind: "success" | "error"; title: string; message: string } | null;

const fmt = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—");
const newKey = () => `idem-${crypto.randomUUID()}`;
const DAY_MS = 24 * 3600 * 1000;

const STATUS_BADGE: Record<RetentionRunStatus, string> = {
  COMPLETED: "badge badge-success",
  NO_POLICY: "badge badge-dark",
  BLOCKED: "badge badge-warning"
};

export function RetentionTab({ currentTenant, token }: RetentionTabProps) {
  const [state, setState] = useState<RetentionState | null>(null);
  const [versions, setVersions] = useState<JurisdictionPack[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [preview, setPreview] = useState<RetentionPreview | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);

  const [retentionDays, setRetentionDays] = useState("365");
  const [basis, setBasis] = useState("");
  const [matterRef, setMatterRef] = useState("");
  const [holdReason, setHoldReason] = useState("");
  const [holdScope, setHoldScope] = useState("");
  const [releaseReasons, setReleaseReasons] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [s, v, c] = await Promise.all([fetchRetentionState(token), fetchPackVersions(token), fetchConnections(token)]);
      setState(s);
      setVersions(v.versions);
      setConnections(c);
    } catch (err: any) {
      setFeedback({ kind: "error", title: "Could not load retention state", message: err.message });
    }
  }, [token]);

  useEffect(() => {
    setPreview(null);
    setFeedback(null);
    load();
  }, [load, currentTenant.id]);

  // Every action follows the same shape: run, report, reload
  const act = async (title: string, fn: () => Promise<string>) => {
    if (!token) return;
    setBusy(true);
    try {
      const message = await fn();
      setFeedback({ kind: "success", title, message });
      await load();
    } catch (err: any) {
      setFeedback({ kind: "error", title: `Refused [${err.code ?? "ERROR"}]`, message: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleSetClass = () => act("Retention class saved", async () => {
    const res = await setRetentionClass({ dataCategory: "WORK_FACT", retentionDays: Number(retentionDays), basis }, newKey(), token!);
    setBasis("");
    return `WORK_FACT now retained ${res.retentionDays} days (class v${res.version}, validated against ${res.packId} v${res.packVersion}).`;
  });

  const handlePlaceHold = () => act("Legal hold placed", async () => {
    await placeLegalHold({
      dataCategory: "WORK_FACT",
      matterRef,
      reason: holdReason,
      ...(holdScope ? { scopeConnectionId: holdScope } : {})
    }, newKey(), token!);
    setMatterRef("");
    setHoldReason("");
    return `Matter ${matterRef}: ${holdScope ? "facts from one connection" : "all work facts"} are now exempt from purge.`;
  });

  const handleReleaseHold = (holdId: string) => act("Legal hold released", async () => {
    await releaseLegalHold(holdId, releaseReasons[holdId] ?? "", newKey(), token!);
    return "Held facts become eligible on the next retention run.";
  });

  const handlePreview = () => act("Preview computed", async () => {
    const p = await previewRetention(token!);
    setPreview(p);
    return p.status === "COMPLETED"
      ? `${p.purgeable} fact(s) would be purged, ${p.held} retained under legal hold.`
      : p.blockedReason ?? "No retention class configured: nothing would be deleted.";
  });

  const handleRun = () => act("Retention run recorded", async () => {
    const r = await runRetention(newKey(), token!);
    setPreview(null);
    if (r.status !== "COMPLETED") return `Status ${r.status}: ${r.blockedReason ?? "no retention class configured"}. Nothing was deleted.`;
    return `Eligible ${r.eligible} = purged ${r.purged} + held ${r.held}. Verified tombstones: ${r.verified}.`;
  });

  const handleSeedExpired = () => act("Sample facts ingested", async () => {
    const conn = connections.find(c => c.state === "ACTIVE");
    if (!conn) throw new Error("No ACTIVE connection to ingest through.");
    const at = (daysAgo: number, hour: number) => {
      const d = new Date(Date.now() - daysAgo * DAY_MS);
      d.setUTCHours(hour, 0, 0, 0);
      return d.toISOString();
    };
    const suffix = crypto.randomUUID().slice(0, 8);
    const items = [200, 150, 5].map((age, i) => ({
      recordId: `ret-sample-${suffix}-${i}`,
      revision: 1,
      subjectRef: `emp-ret-${i}`,
      startUtc: at(age, 9),
      endUtc: at(age, 17),
      workTz: "Europe/London",
      kind: "WORK" as const
    }));
    const receipt = await submitZoikoBatch({ connectionId: conn.id, batchId: `batch-ret-sample-${suffix}`, items }, token!);
    return `Accepted ${receipt.accepted} facts ending 200, 150 and 5 days ago via ${conn.source}.`;
  });

  if (!token) {
    return <div className="tab-pane"><div className="card"><p className="empty-text">Authenticating…</p></div></div>;
  }

  const coverage = state?.coverage;
  const activeClass = state?.classes.find(c => c.status === "ACTIVE") ?? null;
  const bounds = coverage?.status === "COVERED" ? coverage.pack.content.retention.WORK_FACT : undefined;
  const isSynthetic = coverage?.status === "COVERED" && /SYNTHETIC/i.test(coverage.pack.content.title);
  const activeHolds = state?.holds.filter(h => !h.released_at) ?? [];

  return (
    <div className="tab-pane">
      {feedback && (
        <div className={`feedback-alert ${feedback.kind === "success" ? "alert-success" : "alert-error"}`} role="status">
          <div className="feedback-title">{feedback.title}</div>
          <p>{feedback.message}</p>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <div>
            <h3>Jurisdiction Pack in Effect</h3>
            <p className="card-desc">
              The tenant's pack is resolved by date over <code>[effective_from, effective_to)</code>. Packs are authored by the Legal &amp; Policy Lead and are read-only here. Without a pack in effect, retention cannot be configured and purges are blocked.
            </p>
          </div>
          {coverage && (
            <span className={coverage.status === "COVERED" ? "badge badge-success" : "badge badge-coral"}>{coverage.status}</span>
          )}
        </div>

        {coverage?.status === "NOT_COVERED" && (
          <div className="feedback-alert alert-error" role="alert">
            <div className="feedback-title">Fails closed</div>
            <p>No approved version of <code>{coverage.packId ?? "(no pack assigned)"}</code> is in effect. Retention configuration is refused and no data will be purged.</p>
          </div>
        )}

        {coverage?.status === "COVERED" && (
          <>
            {isSynthetic && (
              <div className="callout-info">This is a synthetic test pack. Its durations and citations are fixtures, not legal content.</div>
            )}
            <div className="grid-2col">
              <div className="info-block">
                <div className="data-row"><span className="data-label">Pack</span><span className="data-value monospace">{coverage.pack.packId} v{coverage.pack.version}</span></div>
                <div className="data-row"><span className="data-label">Title</span><span className="data-value">{coverage.pack.content.title}</span></div>
                <div className="data-row"><span className="data-label">Jurisdiction / sector</span><span className="data-value">{coverage.pack.jurisdiction} / {coverage.pack.sector}</span></div>
                <div className="data-row"><span className="data-label">Effective</span><span className="data-value">{fmt(coverage.pack.effectiveFrom)} → {coverage.pack.effectiveTo ? fmt(coverage.pack.effectiveTo) : "open"}</span></div>
              </div>
              <div className="info-block">
                <div className="data-row"><span className="data-label">WORK_FACT floor</span><span className="data-value">{bounds?.floor ? `${bounds.floor.days} days (${bounds.floor.citation})` : "not constrained"}</span></div>
                <div className="data-row"><span className="data-label">WORK_FACT ceiling</span><span className="data-value">{bounds?.ceiling ? `${bounds.ceiling.days} days (${bounds.ceiling.citation})` : "not constrained"}</span></div>
                <div className="data-row"><span className="data-label">Content hash</span><span className="data-value monospace text-sm">{coverage.pack.contentHash.slice(0, 24)}…</span></div>
              </div>
            </div>
          </>
        )}

        {versions.length > 0 && (
          <div className="table-responsive">
            <table className="data-table">
              <thead><tr><th>Version</th><th>Status</th><th>Effective from</th><th>Effective to</th><th>Approved by</th></tr></thead>
              <tbody>
                {versions.map(v => (
                  <tr key={v.version}>
                    <td className="monospace">v{v.version}</td>
                    <td>{v.status}</td>
                    <td>{fmt(v.effectiveFrom)}</td>
                    <td>{v.effectiveTo ? fmt(v.effectiveTo) : "open"}</td>
                    <td>{v.approvedBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <h3>Retention Schedule (Tenant-Configured)</h3>
            <p className="card-desc">
              There is no built-in default duration. Until a class is set, retention runs delete nothing. A new class supersedes the old one, and the old one is kept.
            </p>
          </div>
          <span className={activeClass ? "badge badge-aubergine" : "badge badge-dark"}>
            {activeClass ? `${activeClass.retention_days} DAYS · v${activeClass.version}` : "NOT CONFIGURED"}
          </span>
        </div>

        <div className="form-grid">
          <div className="form-group">
            <label className="form-label" htmlFor="ret-days">Retention for WORK_FACT (days)</label>
            <input id="ret-days" className="text-control" type="number" min={1} value={retentionDays} onChange={e => setRetentionDays(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="ret-basis">Basis / citation</label>
            <input id="ret-basis" className="text-control" value={basis} onChange={e => setBasis(e.target.value)} placeholder="e.g. Records policy RP-7 §3" />
          </div>
        </div>
        <button type="button" className="btn btn-primary" disabled={busy || !basis.trim()} onClick={handleSetClass}>Save retention class</button>

        {state && state.classes.length > 0 && (
          <div className="table-responsive">
            <table className="data-table">
              <thead><tr><th>Version</th><th>Days</th><th>Status</th><th>Validated against</th><th>Basis</th><th>Set</th></tr></thead>
              <tbody>
                {state.classes.map(c => (
                  <tr key={c.id}>
                    <td className="monospace">v{c.version}</td>
                    <td>{c.retention_days}</td>
                    <td>{c.status}</td>
                    <td className="monospace">{c.pack_id} v{c.pack_version}</td>
                    <td>{c.basis}</td>
                    <td>{fmt(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <h3>Legal Holds</h3>
            <p className="card-desc">
              An active hold overrides retention. Held facts are never purged, and the database refuses the delete even if application code tries it.
            </p>
          </div>
          <span className={activeHolds.length ? "badge badge-coral" : "badge badge-dark"}>{activeHolds.length} ACTIVE</span>
        </div>

        <div className="form-grid">
          <div className="form-group">
            <label className="form-label" htmlFor="hold-matter">Matter reference</label>
            <input id="hold-matter" className="text-control" value={matterRef} onChange={e => setMatterRef(e.target.value)} placeholder="MATTER-2026-014" />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="hold-scope">Scope</label>
            <select id="hold-scope" className="select-control" value={holdScope} onChange={e => setHoldScope(e.target.value)}>
              <option value="">All work facts</option>
              {connections.map(c => <option key={c.id} value={c.id}>{c.source} · {c.id.slice(-12)}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="hold-reason">Reason</label>
            <input id="hold-reason" className="text-control" value={holdReason} onChange={e => setHoldReason(e.target.value)} placeholder="Preservation notice received" />
          </div>
        </div>
        <button type="button" className="btn btn-warning" disabled={busy || !matterRef.trim() || holdReason.trim().length < 5} onClick={handlePlaceHold}>Place legal hold</button>

        {state && state.holds.length > 0 && (
          <div className="table-responsive">
            <table className="data-table">
              <thead><tr><th>Matter</th><th>Scope</th><th>Reason</th><th>Placed</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {state.holds.map(h => (
                  <tr key={h.id}>
                    <td className="monospace">{h.matter_ref}</td>
                    <td>{h.scope_connection_id ? `connection …${h.scope_connection_id.slice(-12)}` : "all work facts"}</td>
                    <td>{h.reason}</td>
                    <td>{fmt(h.placed_at)}</td>
                    <td>{h.released_at ? `Released ${fmt(h.released_at)}` : "ACTIVE"}</td>
                    <td>
                      {!h.released_at && (
                        <div className="button-group">
                          <input
                            className="text-control"
                            aria-label={`Release reason for ${h.matter_ref}`}
                            placeholder="Release reason"
                            value={releaseReasons[h.id] ?? ""}
                            onChange={e => setReleaseReasons(r => ({ ...r, [h.id]: e.target.value }))}
                          />
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={busy || (releaseReasons[h.id] ?? "").trim().length < 5}
                            onClick={() => handleReleaseHold(h.id)}
                          >
                            Release
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <h3>Retention Run &amp; Verified Tombstones</h3>
            <p className="card-desc">
              Each purged fact gets a tombstone first, then the row is deleted and re-read to confirm it's gone. Tombstones keep only digests, never a pseudonym or source record ID. If the source re-sends a purged record, it is counted as a duplicate and not stored again.
            </p>
          </div>
          {state && <span className="badge badge-aubergine">{state.tombstones.verified}/{state.tombstones.total} VERIFIED</span>}
        </div>

        <div className="button-group">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={handleSeedExpired}>Ingest sample expired facts</button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={handlePreview}>Preview (dry run)</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={handleRun}>Run retention now</button>
        </div>

        {preview && (
          <div className="callout-info">
            Preview: <strong>{preview.status === "COMPLETED" ? "ready" : preview.status}</strong>
            {preview.cutoff && <> · cutoff {fmt(preview.cutoff)}</>} · eligible {preview.eligible} · would purge {preview.purgeable} · held {preview.held}
            {preview.blockedReason && <> · {preview.blockedReason}</>}
          </div>
        )}

        {state && state.runs.length > 0 ? (
          <div className="table-responsive">
            <table className="data-table">
              <thead><tr><th>Completed</th><th>Status</th><th>Class</th><th>Cutoff</th><th>Eligible</th><th>Purged</th><th>Held</th><th>Verified</th></tr></thead>
              <tbody>
                {state.runs.map(r => (
                  <tr key={r.id}>
                    <td>{fmt(r.completed_at)}</td>
                    <td><span className={STATUS_BADGE[r.status]} title={r.blocked_reason ?? undefined}>{r.status}</span></td>
                    <td>{r.retention_class_version ? `v${r.retention_class_version}` : "—"}</td>
                    <td>{fmt(r.cutoff)}</td>
                    <td>{r.eligible}</td>
                    <td>{r.purged}</td>
                    <td>{r.held}</td>
                    <td>{r.verified}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-text">No retention runs recorded for {currentTenant.name}.</p>
        )}

        {state && state.tombstones.recent.length > 0 && (
          <div className="table-responsive">
            <table className="data-table">
              <thead><tr><th>Record digest (SHA-256)</th><th>Deleted</th><th>Verified</th></tr></thead>
              <tbody>
                {state.tombstones.recent.map(t => (
                  <tr key={t.id}>
                    <td className="monospace text-sm">{t.recordDigest.slice(0, 32)}…</td>
                    <td>{fmt(t.deletedAt)}</td>
                    <td>{t.verifiedAt ? fmt(t.verifiedAt) : "PENDING"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
