// frontend/src/components/CorrectionBanner.tsx
// Zoiko Abate Shared Component - Phase Build Guide Section F.6
import React from "react";

export interface CorrectionBannerProps {
  revisionNumber: number;
  supersededAt: string;
  reason?: string;
  auditRef?: string;
  onViewHistory?: () => void;
}

export const CorrectionBanner: React.FC<CorrectionBannerProps> = ({
  revisionNumber,
  supersededAt,
  reason,
  auditRef,
  onViewHistory
}) => {
  return (
    <div
      role="status"
      style={{
        background: "linear-gradient(135deg, rgba(226, 109, 90, 0.08) 0%, rgba(141, 154, 150, 0.12) 100%)",
        borderLeft: "4px solid #B84230",
        padding: "0.75rem 1rem",
        borderRadius: "4px",
        margin: "0.75rem 0",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: "1rem"
      }}
    >
      <div style={{ fontSize: "0.85rem", color: "#2F343A", lineHeight: 1.5 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
          <span
            style={{
              background: "#B84230",
              color: "#FFFFFF",
              fontSize: "0.68rem",
              fontWeight: 700,
              padding: "0.15rem 0.4rem",
              borderRadius: "3px",
              letterSpacing: "0.03em"
            }}
          >
            REVISION #{revisionNumber}
          </span>
          <strong style={{ color: "#2B1B38" }}>Historical Revision Active (Append-Only Ledger)</strong>
        </div>
        <div>
          This record supersedes previous state as of <strong>{new Date(supersededAt).toLocaleString()}</strong>.
          Under Section B.4, historical records are permanently preserved in the immutable event log and never overwritten.
        </div>
        {reason && (
          <div style={{ marginTop: "0.25rem", fontStyle: "italic", opacity: 0.9 }}>
            Reason: {reason}
          </div>
        )}
        {auditRef && (
          <div style={{ marginTop: "0.25rem", fontSize: "0.75rem", fontFamily: "monospace", opacity: 0.8 }}>
            Audit Reference: {auditRef}
          </div>
        )}
      </div>
      {onViewHistory && (
        <button
          onClick={onViewHistory}
          style={{
            background: "#2B1B38",
            color: "#FFFFFF",
            border: "none",
            borderRadius: "4px",
            padding: "0.35rem 0.75rem",
            fontSize: "0.75rem",
            fontWeight: 600,
            cursor: "pointer",
            whiteSpace: "nowrap"
          }}
        >
          View Audit Stream
        </button>
      )}
    </div>
  );
};

