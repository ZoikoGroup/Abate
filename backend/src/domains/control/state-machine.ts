// backend/src/domains/control/state-machine.ts
import { ControlState } from "../../contracts/control";

export type Role =
  | "RISK_OWNER"
  | "CONTROL_OWNER"
  | "APPROVER"
  | "REVIEWER"
  | "MEMBER"
  | "INGESTION_OPERATOR";

export interface TransitionRule {
  from: ControlState;
  to: ControlState;
  role: Role;
  guardName: string;
}

/**
 * State machine as data: Playbook B4 §3.
 * Encodes all valid transitions between control lifecycle states.
 * Invalid transitions fail closed with CONFLICT.
 */
export const RULES: TransitionRule[] = [
  {
    from: "DRAFT",
    to: "PROPOSED",
    role: "RISK_OWNER",
    guardName: "hasHazardAndAcceptedCause"
  },
  {
    from: "PROPOSED",
    to: "APPROVAL_REQUIRED",
    role: "RISK_OWNER",
    guardName: "policyResolved"
  },
  {
    from: "APPROVAL_REQUIRED",
    to: "APPROVED",
    role: "APPROVER",
    guardName: "approvalBindsCurrentVersion"
  },
  {
    from: "APPROVED",
    to: "IMPLEMENTING",
    role: "CONTROL_OWNER",
    guardName: "authorityStillValid"
  },
  {
    from: "IMPLEMENTING",
    to: "IMPLEMENTED",
    role: "CONTROL_OWNER",
    guardName: "implementationEvidenceExists"
  },
  {
    from: "IMPLEMENTED",
    to: "VERIFYING",
    role: "RISK_OWNER",
    guardName: "observationWindowReady"
  },
  {
    from: "VERIFYING",
    to: "CLOSED",
    role: "REVIEWER",
    guardName: "reviewerConclusionRecorded"
  },
  {
    from: "CLOSED",
    to: "REOPENED",
    role: "RISK_OWNER",
    guardName: "recurrenceEvidence"
  }
];

export function canTransition(from: ControlState, to: ControlState): boolean {
  return RULES.some((r) => r.from === from && r.to === to);
}

/**
 * computeAllowedActions: Server-computed UI contract.
 * The server computes what the actor may do based on role, state, and current version.
 * The frontend renders these; it never decides permissions.
 */
export function computeAllowedActions(
  state: ControlState,
  role: string,
  options: {
    isOwner: boolean;
    hasApproval: boolean;
    hasReceipt: boolean;
    hasEvaluation: boolean;
  }
): string[] {
  const actions: string[] = [];

  switch (state) {
    case "DRAFT":
      actions.push("submit", "edit");
      break;

    case "PROPOSED":
      actions.push("request_approval", "edit");
      break;

    case "APPROVAL_REQUIRED":
      if (role === "APPROVER" || role === "RISK_OWNER") {
        actions.push("approve", "request_changes");
      }
      actions.push("edit");
      break;

    case "APPROVED":
      if (options.hasApproval) {
        actions.push("start_implementation");
      }
      actions.push("edit");
      break;

    case "IMPLEMENTING":
      actions.push("record_implementation", "edit");
      break;

    case "IMPLEMENTED":
      actions.push("pin_plan", "start_verification", "edit");
      break;

    case "VERIFYING":
      if (role === "REVIEWER" || role === "RISK_OWNER") {
        actions.push("conclude");
      }
      actions.push("reopen");
      break;

    case "CLOSED":
      actions.push("reopen");
      break;

    default:
      break;
  }

  return actions;
}

