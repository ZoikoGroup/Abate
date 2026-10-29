// frontend/src/components/Tabs/OperationsTab.tsx
import { useState } from "react";
import {
  PRESET_TENANTS,
  requestSupportToken,
  fetchSloReport,
  fetchOpsErrors,
  lookupOpsRequest,
  issueDiagnosticReceipt,
  verifyDiagnosticReceipt,
  type SloReport,
  type SloStatus,
  type SafeErrorLogEntry,
  type OpsRequestRecord,
  type DiagnosticReceipt
} from "../../api/client";

interface OperationsTabProps {
  currentTenant: typeof PRESET_TENANTS[0];
  token: string | null;
}

type Feedback = { kind: "success" | "error"; title: string; message: string } | null;

const STATUS_BADGE: Record<SloStatus, string> = {
  MET: "badge badge-success",
  BREACHED: "badge badge-coral",
  NO_DATA: "badge badge-dark"
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 19).replace("T", " ") + " UTC" : "—");

export function OperationsTab({ currentTenant, token }: OperationsTabProps) {
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);

  // Tenant side
  const [receipt, setReceipt] = useState<DiagnosticReceipt | null>(null);

  // Support console (separate credential; never a tenant token)
  const [operator, setOperator] = useState("ops.oncall");
  const [supportToken, setSupportToken] = useState<string | null>(null);
  const [report, setReport] = useState<SloReport | null>(null);
  const [errors, setErrors] = useState<SafeErrorLogEntry[]>([]);
  const [requestId, setRequestId] = useState("");
  const [requestRecord, setRequestRecord] = useState<OpsRequestRecord | null>(null);
  const [receiptText, setReceiptText] = useState("");

  const act = async (title: string, fn: () => Promise<string>) => {
    setBusy(true);
    try {
      setFeedback({ kind: "success", title, message: await fn() });
    } catch (err: any) {
      setFeedback({ kind: "error", title: `Refused [${err.code ?? "ERROR"}]`, message: err.requestId ? `${err.message} (requestId ${err.requestId})` : err.message });
    } finally {
      setBusy(false);
    }
  };

  const refreshOps = async (t: string) => {
    const [r, e] = await Promise.all([fetchSloReport(t), fetchOpsErrors(t)]);
    setReport(r);
    setErrors(e);
    return r;
  };

  const handleSignIn = () => act("Support session started", async () => {
    const res = await requestSupportToken(operator);
    setSupportToken(res.token);
    const r = await refreshOps(res.token);
    return `Signed in as ${res.operator}. This credential has no tenant and cannot read tenant data. SLO overall: ${r.overall}.`;
  });

  const handleRefresh = () => act("SLO report refreshed", async () => {
    const r = await refreshOps(supportToken!);
    return `${r.window.requests} requests in window; overall ${r.overall}.`;
  });

  const handleIssue = () => act("Diagnostic receipt issued", async () => {
    const r = await issueDiagnosticReceipt(`idem-${crypto.randomUUID()}`, token!);
    setReceipt(r);
    setReceiptText(JSON.stringify(r, null, 2));
    return `Receipt ${r.receiptId} signed for ${currentTenant.name}. Hand it to support; they verify it without database access.`;
  });

  const handleLookup = () => act("Request located", async () => {
    const rec = await lookupOpsRequest(requestId.trim(), supportToken!);
    setRequestRecord(rec);
    return `${rec.method} ${rec.route} → ${rec.status}${rec.errorCode ? ` (${rec.errorCode})` : ""} in ${rec.durationMs.toFixed(1)} ms.`;
  });

  const handleVerify = () => act("Receipt checked", async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(receiptText);
    } catch {
      throw Object.assign(new Error("Pasted text is not valid JSON."), { code: "VALIDATION" });
    }
    const v = await verifyDiagnosticReceipt(parsed, supportToken!);
    if (!v.valid) {
      throw Object.assign(new Error("The receipt was edited after issue or was not issued by this platform."), { code: "INVALID_SIGNATURE" });
    }
    return `VALID: receipt ${v.receiptId} issued by tenant ${v.tenantId} at ${fmt(v.generatedAt)}.`;
  });

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
            <h3>Tenant: Diagnostic Receipt for Support</h3>
            <p className="card-desc">
              Support never logs in as you and never queries your data. Instead you issue a server-signed snapshot of states and counts: connection health, ingest receipts, outbox backlog, releases by status and retention status. You send it to support yourself.
            </p>
          </div>
          <span className="badge badge-aubergine">ZERO IMPERSONATION</span>
        </div>
        <button type="button" className="btn btn-primary" disabled={busy || !token} onClick={handleIssue}>Issue diagnostic receipt</button>
        {receipt && (
          <>
            <p className="text-sm">Deliberately excluded: {receipt.excluded.join(", ")}.</p>
            <pre className="code-block">{JSON.stringify(receipt, null, 2)}</pre>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <h3>Support Console: SLOs (B8 Targets)</h3>
            <p className="card-desc">
              Support signs in with a separate operator credential (development issuance shown here). It is refused on every tenant endpoint, and tenant tokens are refused here.
            </p>
          </div>
          {report && <span className={STATUS_BADGE[report.overall]}>OVERALL {report.overall}</span>}
        </div>

        <div className="button-group">
          <input className="text-control" aria-label="Support operator" value={operator} onChange={e => setOperator(e.target.value)} />
          <button type="button" className="btn btn-secondary" disabled={busy || operator.trim().length < 3} onClick={handleSignIn}>
            {supportToken ? "Re-issue support token" : "Sign in as support operator"}
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy || !supportToken} onClick={handleRefresh}>Refresh</button>
        </div>

        {report && (
          <>
            <div className="table-responsive">
              <table className="data-table">
                <thead><tr><th>Class</th><th>p95</th><th>Target</th><th>Requests</th><th>Status</th></tr></thead>
                <tbody>
                  {report.latency.map(l => (
                    <tr key={l.routeClass}>
                      <td className="monospace">{l.routeClass}</td>
                      <td>{l.p95Ms === null ? "—" : `${l.p95Ms} ms`}</td>
                      <td>≤ {l.targetP95Ms} ms</td>
                      <td>{l.requests}</td>
                      <td><span className={STATUS_BADGE[l.status]}>{l.status}</span></td>
                    </tr>
                  ))}
                  <tr>
                    <td className="monospace">AVAILABILITY</td>
                    <td>{report.availability.ratio === null ? "—" : `${(report.availability.ratio * 100).toFixed(3)}%`}</td>
                    <td>≥ {report.availability.target * 100}%</td>
                    <td>{report.availability.requests} ({report.availability.serverErrors} 5xx; budget left {report.availability.errorBudget.remaining})</td>
                    <td><span className={STATUS_BADGE[report.availability.status]}>{report.availability.status}</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-sm">{report.scope}</p>

            {report.slowestRoutes.length > 0 && (
              <div className="table-responsive">
                <table className="data-table">
                  <thead><tr><th>Slowest routes (template)</th><th>Class</th><th>p95</th><th>Requests</th></tr></thead>
                  <tbody>
                    {report.slowestRoutes.map(r => (
                      <tr key={`${r.method} ${r.route}`}>
                        <td className="monospace">{r.method} {r.route}</td>
                        <td>{r.routeClass}</td>
                        <td>{r.p95Ms} ms</td>
                        <td>{r.requests}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {supportToken && (
        <div className="card">
          <div className="card-header">
            <div>
              <h3>Support Console: Requests, Safe Error Log &amp; Receipt Verification</h3>
              <p className="card-desc">
                Every error response carries a <code>requestId</code>. Looking it up shows the route template, status and timing. Internal errors are logged as a fingerprint only, never their message or stack.
              </p>
            </div>
            <span className="badge badge-dark">{errors.length} INTERNAL ERRORS</span>
          </div>

          <div className="form-grid">
            <div className="form-group">
              <label className="form-label" htmlFor="ops-request-id">Request ID reported by a tenant</label>
              <input id="ops-request-id" className="text-control monospace" value={requestId} onChange={e => setRequestId(e.target.value)} placeholder="e.g. from an error message" />
            </div>
          </div>
          <button type="button" className="btn btn-secondary" disabled={busy || !requestId.trim()} onClick={handleLookup}>Look up request</button>
          {requestRecord && <pre className="code-block">{JSON.stringify(requestRecord, null, 2)}</pre>}

          {errors.length > 0 && (
            <div className="table-responsive">
              <table className="data-table">
                <thead><tr><th>At</th><th>Request</th><th>Error class</th><th>Fingerprint</th></tr></thead>
                <tbody>
                  {errors.map(e => (
                    <tr key={e.requestId}>
                      <td>{fmt(e.at)}</td>
                      <td className="monospace text-sm">{e.requestId}</td>
                      <td>{e.errorName}</td>
                      <td className="monospace">{e.fingerprint}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="form-group">
            <label className="form-label" htmlFor="ops-receipt">Diagnostic receipt received from a tenant (JSON)</label>
            <textarea id="ops-receipt" className="text-control monospace" rows={8} value={receiptText} onChange={e => setReceiptText(e.target.value)} />
          </div>
          <button type="button" className="btn btn-primary" disabled={busy || !receiptText.trim()} onClick={handleVerify}>Verify signature</button>
        </div>
      )}
    </div>
  );
}
