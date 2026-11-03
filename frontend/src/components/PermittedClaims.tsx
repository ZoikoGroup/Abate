// frontend/src/components/PermittedClaims.tsx
import React from "react";

interface PermittedClaimsProps {
  claims: string[];
  confidence?: "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT_DATA";
}

export const PermittedClaims: React.FC<PermittedClaimsProps> = ({ claims, confidence = "MEDIUM" }) => {
  const confidenceColor = {
    HIGH: "#059669",
    MEDIUM: "#D97706",
    LOW: "#DC2626",
    INSUFFICIENT_DATA: "#6B7280"
  }[confidence];

  return (
    <div
      style={{
        background: "#F8FAFC",
        border: "1px solid #E2E8F0",
        borderLeft: "4px solid #0D9488",
        borderRadius: "6px",
        padding: "0.85rem 1rem",
        marginTop: "0.75rem"
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ fontWeight: 600, fontSize: "0.8rem", color: "#1E293B", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Permitted Performance Claims
          </span>
          <span
            style={{
              fontSize: "0.7rem",
              fontWeight: 600,
              padding: "0.15rem 0.45rem",
              borderRadius: "4px",
              background: `${confidenceColor}15`,
              color: confidenceColor,
              border: `1px solid ${confidenceColor}40`
            }}
          >
            Confidence: {confidence}
          </span>
        </div>
        <span style={{ fontSize: "0.7rem", color: "#64748B", fontStyle: "italic" }}>
          Plane B Evaluation Scope
        </span>
      </div>

      <ul style={{ margin: "0 0 0.75rem 1.25rem", padding: 0, fontSize: "0.825rem", color: "#334155", lineHeight: 1.5 }}>
        {claims.length > 0 ? (
          claims.map((claim, idx) => (
            <li key={idx} style={{ marginBottom: "0.25rem" }}>
              {claim}
            </li>
          ))
        ) : (
          <li style={{ color: "#94A3B8", fontStyle: "italic" }}>No specific claims permitted for this evaluation.</li>
        )}
      </ul>

      {/* Mandatory ZAB-ENG-001 §11 Legal Notice */}
      <div
        style={{
          background: "#FFFBEB",
          border: "1px solid #FDE68A",
          borderRadius: "4px",
          padding: "0.45rem 0.65rem",
          fontSize: "0.75rem",
          color: "#92400E",
          display: "flex",
          alignItems: "flex-start",
          gap: "0.4rem"
        }}
      >
        <span style={{ fontWeight: 700, flexShrink: 0 }}>⚠ STATUTORY NOTICE:</span>
        <span>
          Does <strong>not</strong> prove hazard control or employee resilience. Plane B performance claims cannot be cited
          to fulfill Plane A statutory duty-of-care obligations or close open workplace hazard determinations.
        </span>
      </div>
    </div>
  );
};

