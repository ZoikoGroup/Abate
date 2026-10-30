// frontend/src/components/AiPanel.tsx
import { useState } from "react";
import {
  type AiRunView,
  explainReleaseAi,
  acceptAiRun,
  discardAiRun
} from "../api/client";

interface AiPanelProps {
  releaseId: string;
  hazardId?: string;
  token: string | null;
  onDraftAccepted?: (result: any) => void;
}

export function AiPanel({ releaseId, hazardId, token, onDraftAccepted }: AiPanelProps) {
  const [loading, setLoading] = useState(false);
  const [run, setRun] = useState<AiRunView | null>(null);
  const [question, setQuestion] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleExplain = async (customQ?: string) => {
    if (!token) return;
    setLoading(true);
    setErrorMsg(null);
    setNotice(null);

    try {
      const q = customQ !== undefined ? customQ : question;
      const res = await explainReleaseAi(releaseId, q || undefined, token);
      setRun(res);
      if (res.status === "REJECTED_BY_VALIDATOR") {
        setErrorMsg(
          `The AI suggestion was rejected by the safety validator (${res.validatorReport?.failureCode || "FAILED"}). ${res.validatorReport?.details || ""}`
        );
      }
    } catch (err: any) {
      if (err.status === 503 || err.code === "UNAVAILABLE") {
        setErrorMsg("AI assistance is disabled or not available right now. You can continue manually.");
      } else {
        setErrorMsg(err.message || "Failed to generate AI explanation.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleAccept = async () => {
    if (!token || !run) return;
    setLoading(true);
    try {
      const res = await acceptAiRun(
        run.id,
        hazardId ? { hazardId } : undefined,
        token
      );
      setNotice(`✔ Draft accepted as proposal. Registered decision reference: ${res.decisionRef}`);
      setRun(prev => prev ? { ...prev, status: "ACCEPTED" } : null);
      if (onDraftAccepted) onDraftAccepted(res);
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to accept AI draft.");
    } finally {
      setLoading(false);
    }
  };

  const handleDiscard = async () => {
    if (!token || !run) return;
    setLoading(true);
    try {
      await discardAiRun(run.id, token);
      setNotice("AI proposal discarded. The manual workflow is unaffected.");
      setRun(prev => prev ? { ...prev, status: "DISCARDED" } : null);
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to discard AI proposal.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section aria-label="AI assistance panel" className="ai-panel" style={{
      background: "#F8FAFC",
      border: "1px solid #E2E8F0",
      borderRadius: "8px",
      padding: "1rem",
      marginTop: "1rem"
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{
            display: "inline-block",
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: "#6366F1"
          }}></span>
          <span style={{ fontSize: "0.875rem", fontWeight: 700, color: "#1E293B" }}>
            Bounded AI Assistant (Domain S08)
          </span>
          <span className="badge badge-purple" style={{ fontSize: "0.7rem" }}>
            DRAFT-ONLY
          </span>
        </div>

        {run && (
          <span style={{
            fontSize: "0.75rem",
            fontWeight: 600,
            padding: "0.2rem 0.5rem",
            borderRadius: "4px",
            background: run.status === "PROPOSED" ? "#FEF3C7" : (run.status === "ACCEPTED" ? "#D1FAE5" : "#FEE2E2"),
            color: run.status === "PROPOSED" ? "#92400E" : (run.status === "ACCEPTED" ? "#065F46" : "#991B1B")
          }}>
            Status: {run.status === "PROPOSED" ? "Proposed (Not accepted)" : run.status}
          </span>
        )}
      </div>

      <p style={{ fontSize: "0.8rem", color: "#64748B", margin: "0 0 0.75rem 0", lineHeight: 1.4 }}>
        Explains released cohort evidence and drafts organizational hypotheses. AI never reads raw telemetry, never scores individuals, and has zero execution authority.
      </p>

      {/* Query Form */}
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
        <input
          type="text"
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="Ask a question about this release (e.g. explain evening spikes)..."
          className="text-control"
          style={{ flex: 1, fontSize: "0.85rem", padding: "0.4rem 0.6rem" }}
        />
        <button
          type="button"
          onClick={() => handleExplain()}
          disabled={loading || !token}
          className="btn btn-secondary btn-sm"
        >
          {loading ? "Evaluating..." : "Generate AI Explanation"}
        </button>
      </div>

      {/* Loading state */}
      {loading && (
        <p role="status" aria-live="polite" style={{ fontSize: "0.825rem", color: "#6366F1", margin: "0.5rem 0" }}>
          Analyzing released evidence through deterministic safety validators…
        </p>
      )}

      {/* Error or Fallback notification */}
      {errorMsg && (
        <div style={{
          background: "#FEF2F2",
          border: "1px solid #FCA5A5",
          borderRadius: "6px",
          padding: "0.6rem 0.8rem",
          margin: "0.5rem 0",
          fontSize: "0.825rem",
          color: "#991B1B"
        }}>
          <strong>Notice:</strong> {errorMsg}
        </div>
      )}

      {/* Success notice */}
      {notice && (
        <div style={{
          background: "#ECFDF5",
          border: "1px solid #6EE7B7",
          borderRadius: "6px",
          padding: "0.6rem 0.8rem",
          margin: "0.5rem 0",
          fontSize: "0.825rem",
          color: "#065F46"
        }}>
          {notice}
        </div>
      )}

      {/* Active Proposal View */}
      {run && run.status === "PROPOSED" && run.output && (
        <div style={{
          background: "#FFFFFF",
          border: "1px solid #CBD5E1",
          borderRadius: "6px",
          padding: "0.8rem",
          marginTop: "0.5rem"
        }}>
          <div style={{ fontSize: "0.9rem", fontWeight: 700, color: "#0F172A", marginBottom: "0.4rem" }}>
            {run.output.title}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "0.75rem" }}>
            {run.output.claims.map(claim => (
              <div key={claim.id} style={{ fontSize: "0.825rem", color: "#334155", lineHeight: 1.5 }}>
                <span>{claim.text}</span>
                <span style={{ marginLeft: "0.5rem" }}>
                  {claim.citations.map(cit => (
                    <span
                      key={cit}
                      tabIndex={0}
                      title={`Verified released source: ${cit}`}
                      style={{
                        display: "inline-block",
                        background: "#E0E7FF",
                        color: "#3730A3",
                        padding: "0.1rem 0.35rem",
                        borderRadius: "4px",
                        fontSize: "0.7rem",
                        marginRight: "0.25rem",
                        fontFamily: "monospace",
                        cursor: "help"
                      }}
                    >
                      [{cit.replace("release:", "rel:")}]
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>

          <p style={{
            fontSize: "0.75rem",
            color: "#64748B",
            fontStyle: "italic",
            borderTop: "1px dashed #E2E8F0",
            paddingTop: "0.4rem",
            margin: "0 0 0.75rem 0"
          }}>
            <strong>Uncertainty & Governance Limits:</strong> {run.output.uncertainty}
          </p>

          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={handleDiscard}
              disabled={loading}
              className="btn btn-secondary btn-sm"
              style={{ fontSize: "0.75rem" }}
            >
              Discard Proposal
            </button>
            <button
              type="button"
              onClick={handleAccept}
              disabled={loading}
              className="btn btn-primary btn-sm"
              style={{ fontSize: "0.75rem" }}
            >
              Use as Draft in Workflow
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
