// frontend/src/components/StateView.tsx
import React from "react";

export type ViewState =
  | { kind: "loading" }
  | { kind: "empty"; reason: string }
  | { kind: "stale"; asOf: string }
  | { kind: "partial"; note: string }
  | { kind: "suppressed" } // NOTE: carries no count, ever per constitutional privacy rule
  | { kind: "unauthorized" }
  | { kind: "conflict"; hint: string }
  | { kind: "failed"; requestId: string; message?: string }
  | { kind: "ok" };

interface StateViewProps {
  state: ViewState;
  children?: React.ReactNode;
}

export function StateView({ state, children }: StateViewProps) {
  switch (state.kind) {
    case "loading":
      return (
        <div className="state-box state-loading" role="status" aria-live="polite">
          <div className="spinner" aria-hidden="true" />
          <p>Loading secure tenant data...</p>
        </div>
      );

    case "empty":
      return (
        <div className="state-box state-empty" role="status">
          <span className="state-badge">EMPTY</span>
          <p>{state.reason}</p>
        </div>
      );

    case "suppressed":
      return (
        <div className="state-box state-suppressed" role="status">
          <span className="state-badge badge-suppressed">PRIVACY SUPPRESSED</span>
          <p><strong>Not available for this selection.</strong></p>
          <small>Suppressed under constitutional privacy rule (insufficient cohort size or overlap risk). Counts are never exposed.</small>
        </div>
      );

    case "unauthorized":
      return (
        <div className="state-box state-unauthorized" role="alert">
          <span className="state-badge badge-danger">ACCESS DENIED</span>
          <p>You do not have access to this resource.</p>
        </div>
      );

    case "conflict":
      return (
        <div className="state-box state-conflict" role="alert">
          <span className="state-badge badge-warning">CONFLICT (409)</span>
          <p><strong>Version or Idempotency Conflict:</strong> {state.hint}</p>
          <small>This changed or the idempotency key was reused with different payload content.</small>
        </div>
      );

    case "failed":
      return (
        <div className="state-box state-failed" role="alert">
          <span className="state-badge badge-danger">REQUEST FAILED</span>
          <p>{state.message || "Something went wrong."}</p>
          <small className="monospace">Audit Reference: {state.requestId}</small>
        </div>
      );

    case "stale":
      return (
        <div className="state-stale-wrapper">
          <div className="stale-banner" role="status">
            <span>Data as of {state.asOf}. Downstream updates in progress.</span>
          </div>
          {children}
        </div>
      );

    case "partial":
      return (
        <div className="state-partial-wrapper">
          <div className="partial-banner" role="status">
            <span>Partial dataset: {state.note}</span>
          </div>
          {children}
        </div>
      );

    case "ok":
    default:
      return <>{children}</>;
  }
}

