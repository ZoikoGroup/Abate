// backend/src/domains/ai/validate.ts
import { AiProposal, AiProposalSchema, ValidatorReport } from "../../contracts/ai";
import { ContextItem } from "./retrieve";
import { UseCaseConfig } from "./gateway";

export const APPROVED_CONTROL_CATALOG = new Set([
  "CONTROL-SCHED-01",
  "CONTROL-ROUTING-02",
  "CONTROL-CAPACITY-03",
  "CONTROL-REST-04"
]);

const PROHIBITED_KEYWORDS = [
  "employee",
  "worker name",
  "individual score",
  "lazy",
  "burnout level",
  "depressed",
  "anxious",
  "performance review",
  "rank",
  "termination",
  "disciplinary",
  "sick leave reason",
  "jane doe",
  "john doe"
];

function extractNumbers(text: string): number[] {
  // Extract integers and floating point numbers from text (ignoring markdown formatting)
  const matches = text.match(/\b\d+(\.\d+)?\b/g);
  if (!matches) return [];
  return matches.map(Number);
}

function numberAllowed(num: number, ctx: ContextItem[]): boolean {
  // Check if number exists in retrieved release data or context items
  for (const item of ctx) {
    if (item.kind === "RELEASE" && item.data) {
      const relVal = Number(item.data.value);
      if (Math.abs(relVal - num) < 0.001) return true;
      if (Math.abs(num - 28) < 0.001) return true; // Standard 28-day window allowed
      if (Math.abs(num - 1) < 0.001 || Math.abs(num - 100) < 0.001) return true; // Standard percent/version numbers
    }
    // Allow numbers appearing verbatim in the item text
    const inText = extractNumbers(item.text);
    if (inText.some(n => Math.abs(n - num) < 0.001)) {
      return true;
    }
  }
  return false;
}

function mentionsIndividualOrMedical(text: string): boolean {
  const lower = text.toLowerCase();
  for (const kw of PROHIBITED_KEYWORDS) {
    if (lower.includes(kw)) {
      return true;
    }
  }
  return false;
}

export function validateOutput(
  rawJson: unknown,
  uc: UseCaseConfig,
  ctx: ContextItem[]
): { ok: boolean; value?: AiProposal; report: ValidatorReport } {
  // 1. Schema Validation (strict Zod)
  const parsed = AiProposalSchema.safeParse(rawJson);
  if (!parsed.success) {
    return {
      ok: false,
      report: {
        ok: false,
        failureCode: "SCHEMA",
        details: "Output did not conform to the strict proposal schema.",
        violations: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`)
      }
    };
  }

  const proposal = parsed.data;
  const retrievedIds = new Set(ctx.map(c => c.id));

  // 2. Prohibited Inference Validation (Constitutional Safety Gate)
  for (const claim of proposal.claims) {
    if (mentionsIndividualOrMedical(claim.text) || mentionsIndividualOrMedical(proposal.uncertainty)) {
      return {
        ok: false,
        report: {
          ok: false,
          failureCode: "PROHIBITED_INFERENCE",
          details: "Proposal contains prohibited inference regarding individual identity, performance, or health."
        }
      };
    }
  }

  // 3. Citation Validation: Every claim must cite an actually retrieved context ID
  for (const claim of proposal.claims) {
    if (!claim.citations || claim.citations.length === 0) {
      return {
        ok: false,
        report: {
          ok: false,
          failureCode: "CITATION",
          details: "Claim is missing citations."
        }
      };
    }
    const hasUnretrieved = claim.citations.some(citId => !retrievedIds.has(citId));
    if (hasUnretrieved) {
      return {
        ok: false,
        report: {
          ok: false,
          failureCode: "CITATION",
          details: "Claim cites an item ID that was not retrieved in the authorized context (fabricated citation rejected)."
        }
      };
    }

    // 4. Numeric Fidelity Validation: Every number must equal a released value
    const nums = extractNumbers(claim.text);
    for (const n of nums) {
      if (!numberAllowed(n, ctx)) {
        return {
          ok: false,
          report: {
            ok: false,
            failureCode: "NUMERIC_FIDELITY",
            details: `Number ${n} in claim text does not match any released value or authorized parameter.`
          }
        };
      }
    }
  }

  // 5. Control Eligibility Validation
  if (proposal.suggestedControls && proposal.suggestedControls.length > 0) {
    for (const ctrlId of proposal.suggestedControls) {
      if (!APPROVED_CONTROL_CATALOG.has(ctrlId)) {
        return {
          ok: false,
          report: {
            ok: false,
            failureCode: "CONTROL_ELIGIBILITY",
            details: `Suggested control ID ${ctrlId} does not exist in the approved control catalog.`
          }
        };
      }
    }
  }

  return {
    ok: true,
    value: proposal,
    report: {
      ok: true
    }
  };
}
