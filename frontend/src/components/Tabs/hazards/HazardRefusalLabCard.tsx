// frontend/src/components/Tabs/hazards/HazardRefusalLabCard.tsx

interface HazardRefusalLabCardProps {
  onTestStateRejection: () => void;
  onTestVersionBoundRejection: () => void;
  onTestTransferOfRisk: () => void;
}

export function HazardRefusalLabCard({
  onTestStateRejection,
  onTestVersionBoundRejection,
  onTestTransferOfRisk
}: HazardRefusalLabCardProps) {
  return (
    <div className="card" style={{ background: "var(--aubergine)", color: "#FFFFFF" }}>
      <div className="card-header" style={{ borderBottom: "1px solid rgba(255,255,255,0.15)" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
            <span className="pulse-indicator"></span>
            <h3 style={{ color: "#FFFFFF" }}>Phase 4 Governance &amp; Refusal Lab (Adversarial Gates)</h3>
          </div>
          <p className="card-desc" style={{ color: "#D1D5DB" }}>
            Playbook B4 §8 verification: State machine transitions, version-bound approval invalidation, and transfer-of-risk detection.
          </p>
        </div>
        <span className="badge badge-coral">ZAB-ENG-001 §8</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1rem", marginTop: "1rem" }}>
        <button
          type="button"
          onClick={onTestStateRejection}
          className="lab-card-btn border-rose"
        >
          <div className="lab-btn-title" style={{ color: "#FCA5A5" }}>
            1. Skip Approval Attack
          </div>
          <div className="lab-btn-desc">
            Attempts PROPOSED &rarr; IMPLEMENTING jump directly. State machine enforces strict approval gate.
          </div>
        </button>

        <button
          type="button"
          onClick={onTestVersionBoundRejection}
          className="lab-card-btn border-amber"
        >
          <div className="lab-btn-title" style={{ color: "#FCD34D" }}>
            2. &ldquo;v4 Cannot Approve v5&rdquo;
          </div>
          <div className="lab-btn-desc">
            Sends If-Match with stale target version. Rejects with 409 CONFLICT on version mismatch.
          </div>
        </button>

        <button
          type="button"
          onClick={onTestTransferOfRisk}
          className="lab-card-btn border-cyan"
        >
          <div className="lab-btn-title" style={{ color: "#7DD3FC" }}>
            3. Transfer of Risk Flag (Simulation)
          </div>
          <div className="lab-btn-desc">
            Simulation preview: illustrates adjacent cohort degradation &gt; tolerance blocking clean EFFECTIVE conclusion.
          </div>
        </button>
      </div>
    </div>
  );
}
