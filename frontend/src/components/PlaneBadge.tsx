// frontend/src/components/PlaneBadge.tsx
import React from "react";

interface PlaneBadgeProps {
  plane: "A" | "B";
  showLabel?: boolean;
}

export const PlaneBadge: React.FC<PlaneBadgeProps> = ({ plane, showLabel = true }) => {
  if (plane === "A") {
    return (
      <span
        className="badge"
        style={{
          background: "linear-gradient(135deg, #4A154B 0%, #E26D5A 100%)",
          color: "#FFFFFF",
          fontWeight: 600,
          letterSpacing: "0.04em",
          padding: "0.25rem 0.6rem",
          borderRadius: "4px",
          display: "inline-flex",
          alignItems: "center",
          gap: "0.35rem",
          fontSize: "0.75rem"
        }}
        title="Plane A (Assurance): Authoritative risk, cause, intervention, verification, and legal-compliance records. Fail-closed."
      >
        <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#FDE68A" }}></span>
        Plane A: Assurance
        {showLabel && <span style={{ opacity: 0.85, fontWeight: 400 }}>(Risk & Legal Duty)</span>}
      </span>
    );
  }

  return (
    <span
      className="badge"
      style={{
        background: "linear-gradient(135deg, #1E3A8A 0%, #0D9488 100%)",
        color: "#FFFFFF",
        fontWeight: 600,
        letterSpacing: "0.04em",
        padding: "0.25rem 0.6rem",
        borderRadius: "4px",
        display: "inline-flex",
        alignItems: "center",
        gap: "0.35rem",
        fontSize: "0.75rem"
      }}
      title="Plane B (Outcomes): Work-design outcomes, productivity, and AI performance. Never substitutes for Plane A assurance."
    >
      <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#67E8F9" }}></span>
      Plane B: Work-Design
      {showLabel && <span style={{ opacity: 0.85, fontWeight: 400 }}>(Outcomes & Performance)</span>}
    </span>
  );
};

