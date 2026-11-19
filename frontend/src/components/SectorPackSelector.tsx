// frontend/src/components/SectorPackSelector.tsx
// Lets an admin choose which sector pack applies to the tenant. The list comes from the backend
// registry through the sector profile, so a newly registered sector appears with no frontend change.
import { useState } from "react";
import { ApiError, updateTenantSectorProfile, type TenantSectorProfile } from "../api/client";

interface SectorPackSelectorProps {
  token: string | null;
  sectorProfile?: TenantSectorProfile | null;
  onChanged: (profile: TenantSectorProfile) => void;
}

/** Extra wording shown beside a sector in the list, so a preview or test pack is never mistaken for a launched one. */
const STATUS_NOTE: Record<string, string> = {
  PREVIEW: " (preview, pending policy review)",
  FIXTURE: " (test fixture, not a launched pack)"
};

export function SectorPackSelector({ token, sectorProfile, onChanged }: SectorPackSelectorProps) {
  const sectors = sectorProfile?.availableSectors ?? [];
  const [choice, setChoice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  if (!sectorProfile || sectors.length === 0) return null;

  const selectedKey = choice ?? sectorProfile.sectorKey;
  const selected = sectors.find(s => s.sectorKey === selectedKey);
  const unchanged = selectedKey === sectorProfile.sectorKey;

  const handleApply = async () => {
    if (!token || !selected) return;
    setSaving(true);
    setFeedback(null);
    try {
      const updated = await updateTenantSectorProfile(
        { sectorKey: selected.sectorKey, packKey: selected.packKey },
        `idem-${crypto.randomUUID().slice(0, 8)}`,
        token
      );
      onChanged(updated);
      setChoice(null);
      setFeedback({ type: "success", message: `Sector pack set to ${updated.displayName ?? updated.sectorKey}.` });
    } catch (err) {
      const message = err instanceof ApiError
        ? `[${err.code}] ${err.message} (Request ID: ${err.requestId})`
        : err instanceof Error ? err.message : "Could not update the sector pack.";
      setFeedback({ type: "error", message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: "1.5rem" }}>
      <div className="card-header">
        <div>
          <h3>Sector Pack</h3>
          <p className="card-desc">
            Chooses the vocabulary, demand windows and sector rules for this tenant. The neutral core always applies, and no pack can lower the privacy floor or expand AI authority.
          </p>
        </div>
        <span className="badge badge-secondary">{sectorProfile.displayName ?? sectorProfile.sectorKey}</span>
      </div>

      <div className="form-group" style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 260px" }}>
          <label htmlFor="sector-pack-select" className="form-label">Active Sector Pack:</label>
          <select
            id="sector-pack-select"
            className="select-control"
            style={{ width: "100%" }}
            value={selectedKey}
            onChange={(e) => { setChoice(e.target.value); setFeedback(null); }}
          >
            {sectors.map(s => (
              <option key={s.sectorKey} value={s.sectorKey}>
                {s.displayName}{STATUS_NOTE[s.status] ?? ""}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleApply}
          disabled={saving || unchanged || !token}
        >
          {saving ? "Saving..." : "Apply Sector Pack"}
        </button>
      </div>

      <p className="card-desc" style={{ marginTop: "0.5rem" }}>{sectorProfile.claimScope}</p>

      {feedback && (
        <div
          className={`feedback-alert ${feedback.type === "success" ? "alert-success" : "alert-error"}`}
          role={feedback.type === "success" ? "status" : "alert"}
          style={{ marginTop: "0.75rem" }}
        >
          <p style={{ margin: 0 }}>{feedback.message}</p>
        </div>
      )}
    </div>
  );
}
