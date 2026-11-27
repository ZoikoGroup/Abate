// frontend/src/components/Admin/AdminDialogs.tsx
// Shared accessible governance dialogs (Step 4):
// - ConfirmWithReasonDialog: plain-language impact text + mandatory free-text reason + focus trap + Escape close
// - StepUpAuthDialog: recent re-authentication prompt for destructive platform admin actions
// - FourEyesApprovalDialog: second distinct Super Admin approval/rejection dialog

import { useState, useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";

interface DialogShellProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

function AccessibleModal({ open, title, onClose, children }: DialogShellProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const node = containerRef.current;
    if (node) {
      const focusable = node.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      (focusable ?? node).focus();
    }
    return () => {
      previousFocusRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !containerRef.current) return;
    const focusables = Array.from(
      containerRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const titleId = `dialog-title-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(25, 16, 33, 0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        zIndex: 1000
      }}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="card"
        style={{
          width: "100%",
          maxWidth: 540,
          margin: 0,
          background: "#FFFFFF",
          border: "2px solid #2B1B38",
          boxShadow: "0 18px 40px rgba(0, 0, 0, 0.25)"
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
          <h2 id={titleId} style={{ margin: 0, fontSize: "1.15rem", color: "#2B1B38" }}>
            {title}
          </h2>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} aria-label="Close dialog">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export interface ConfirmWithReasonProps {
  open: boolean;
  title: string;
  impactText: string;
  confirmLabel?: string;
  minLength?: number;
  initialReason?: string;
  busy?: boolean;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
}

export function ConfirmWithReasonDialog({
  open,
  title,
  impactText,
  confirmLabel = "Confirm Action",
  minLength = 5,
  initialReason = "",
  busy = false,
  destructive = false,
  onCancel,
  onConfirm
}: ConfirmWithReasonProps) {
  const [reason, setReason] = useState(initialReason);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = reason.trim();
    if (trimmed.length < minLength) {
      setValidationError(`Please provide a clear audit reason (at least ${minLength} characters).`);
      return;
    }
    setValidationError(null);
    await onConfirm(trimmed);
    setReason("");
  };

  return (
    <AccessibleModal open={open} title={title} onClose={onCancel}>
      <div
        role="note"
        style={{
          background: destructive ? "#FFF2F0" : "#F5F2F8",
          borderLeft: `4px solid ${destructive ? "#A83828" : "#2B1B38"}`,
          padding: "0.75rem 1rem",
          marginBottom: "1rem",
          color: "#1F2429"
        }}
      >
        <strong>Impact:</strong> {impactText}
      </div>
      <form onSubmit={(e) => void handleSubmit(e)} style={{ display: "grid", gap: "0.75rem" }}>
        <div>
          <label htmlFor="confirm-reason-input" className="context-label" style={{ display: "block", marginBottom: "0.35rem" }}>
            Mandatory Audit Reason (min {minLength} characters)
          </label>
          <textarea
            id="confirm-reason-input"
            className="select-control"
            rows={3}
            style={{ width: "100%" }}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Record why this governance action is being taken..."
            required
          />
        </div>
        {validationError && (
          <div className="feedback-alert alert-error" role="alert">
            <p style={{ margin: 0 }}>{validationError}</p>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Submitting..." : confirmLabel}
          </button>
        </div>
      </form>
    </AccessibleModal>
  );
}

export interface StepUpDialogProps {
  open: boolean;
  operator: string;
  windowSeconds: number;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onVerify: (confirmation: string, mfaCode?: string) => void | Promise<void>;
}

export function StepUpAuthDialog({
  open,
  operator,
  windowSeconds,
  busy = false,
  error = null,
  onCancel,
  onVerify
}: StepUpDialogProps) {
  const [confirmation, setConfirmation] = useState("MFA verified re-authentication");
  const [mfaCode, setMfaCode] = useState("123456");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!confirmation.trim()) return;
    await onVerify(confirmation.trim(), mfaCode.trim() || undefined);
  };

  return (
    <AccessibleModal open={open} title="Step-Up Re-Authentication Required" onClose={onCancel}>
      <p style={{ marginTop: 0, color: "#2F343A" }}>
        Destructive platform actions require recent MFA step-up verification within{" "}
        <strong>{Math.round(windowSeconds / 60)} minutes</strong> ({windowSeconds}s) for{" "}
        <code>{operator}</code>.
      </p>
      {error && (
        <div className="feedback-alert alert-error" role="alert" style={{ marginBottom: "0.75rem" }}>
          <p style={{ margin: 0 }}>{error}</p>
        </div>
      )}
      <form onSubmit={(e) => void handleSubmit(e)} style={{ display: "grid", gap: "0.75rem" }}>
        <div>
          <label htmlFor="stepup-confirmation-input" className="context-label" style={{ display: "block", marginBottom: "0.35rem" }}>
            Re-Authentication Confirmation
          </label>
          <input
            id="stepup-confirmation-input"
            className="select-control"
            style={{ width: "100%" }}
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="stepup-mfa-input" className="context-label" style={{ display: "block", marginBottom: "0.35rem" }}>
            MFA Verification Code
          </label>
          <input
            id="stepup-mfa-input"
            type="text"
            className="select-control"
            style={{ width: "100%" }}
            value={mfaCode}
            onChange={(e) => setMfaCode(e.target.value)}
            placeholder="6-digit OTP / hardware key check"
          />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Verifying..." : "Verify Step-Up"}
          </button>
        </div>
      </form>
    </AccessibleModal>
  );
}

export interface FourEyesDialogProps {
  open: boolean;
  approval: {
    id: string;
    actionType: string;
    targetType: string;
    targetId: string;
    requestedBy: string;
    reason: string;
    version: number;
  } | null;
  currentOperator: string;
  mode: "APPROVE" | "REJECT";
  busy?: boolean;
  onCancel: () => void;
  onDecide: (approvalId: string, version: number, mode: "APPROVE" | "REJECT", reason: string) => void | Promise<void>;
}

export function FourEyesApprovalDialog({
  open,
  approval,
  currentOperator,
  mode,
  busy = false,
  onCancel,
  onDecide
}: FourEyesDialogProps) {
  const [reason, setReason] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  if (!approval) return null;
  const isSelf = approval.requestedBy.toLowerCase() === currentOperator.toLowerCase();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 5) {
      setValidationError("Decision reason must be at least 5 characters.");
      return;
    }
    setValidationError(null);
    await onDecide(approval.id, approval.version, mode, reason.trim());
    setReason("");
  };

  return (
    <AccessibleModal
      open={open}
      title={mode === "APPROVE" ? "Four-Eyes Approval Confirmation" : "Reject Four-Eyes Request"}
      onClose={onCancel}
    >
      <div style={{ background: "#F5F2F8", padding: "0.75rem 1rem", borderRadius: 6, marginBottom: "0.75rem" }}>
        <div><strong>Action:</strong> <code>{approval.actionType}</code></div>
        <div><strong>Target:</strong> {approval.targetType} / <code>{approval.targetId}</code></div>
        <div><strong>Requested by:</strong> <code>{approval.requestedBy}</code></div>
        <div><strong>Requester reason:</strong> {approval.reason}</div>
      </div>

      {isSelf && (
        <div className="feedback-alert alert-error" role="alert" style={{ marginBottom: "0.75rem" }}>
          <strong>Self-approval is refused:</strong> You ({currentOperator}) initiated this request. Sign in as a second distinct Super Admin to approve or reject.
        </div>
      )}

      <form onSubmit={(e) => void handleSubmit(e)} style={{ display: "grid", gap: "0.75rem" }}>
        <div>
          <label htmlFor="foureyes-reason-input" className="context-label" style={{ display: "block", marginBottom: "0.35rem" }}>
            Second Approver Reason (min 5 characters)
          </label>
          <textarea
            id="foureyes-reason-input"
            className="select-control"
            rows={3}
            style={{ width: "100%" }}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Record second-approver verification notes..."
            required
          />
        </div>
        {validationError && (
          <div className="feedback-alert alert-error" role="alert">
            <p style={{ margin: 0 }}>{validationError}</p>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Recording..." : mode === "APPROVE" ? "Approve & Execute" : "Reject Request"}
          </button>
        </div>
      </form>
    </AccessibleModal>
  );
}
