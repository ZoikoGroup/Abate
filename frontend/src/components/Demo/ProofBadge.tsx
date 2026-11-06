// frontend/src/components/Demo/ProofBadge.tsx
import React from "react";

export interface ProofBadgeProps {
  status: "PASS" | "FAIL" | "IDLE" | "RUNNING";
  reason?: string;
  metric?: string;
}

export const ProofBadge: React.FC<ProofBadgeProps> = ({ status, reason, metric }) => {
  if (status === "IDLE") {
    return (
      <div className="proof-badge-container proof-idle" role="status">
        <span className="proof-indicator">○</span>
        <span className="proof-title">READY TO VERIFY</span>
        <span className="proof-reason">Press run to execute against live backend</span>
      </div>
    );
  }

  if (status === "RUNNING") {
    return (
      <div className="proof-badge-container proof-running" role="status">
        <span className="proof-spinner" aria-hidden="true" />
        <span className="proof-title">EXECUTING...</span>
        <span className="proof-reason">Evaluating constitutional gates in real time</span>
      </div>
    );
  }

  const isPass = status === "PASS";

  return (
    <div
      className={`proof-badge-container ${isPass ? "proof-pass" : "proof-fail"}`}
      role="status"
      aria-label={`Proof status: ${status}. ${reason || ""}`}
    >
      <div className="proof-header">
        <span className="proof-tag">{isPass ? "✔ PASS" : "✖ FAIL"}</span>
        {metric && <span className="proof-metric">{metric}</span>}
      </div>
      {reason && <p className="proof-reason">{reason}</p>}
    </div>
  );
};

