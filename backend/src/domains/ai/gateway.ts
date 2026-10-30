// backend/src/domains/ai/gateway.ts
import { AppError } from "../../platform/errors";

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelProvider {
  name: string;
  region: string;
  generate(req: {
    model: string;
    system: string;
    messages: ModelMessage[];
    schema?: any;
    maxOutputTokens: number;
    signal: AbortSignal;
  }): Promise<{ text: string; usage: { tokensIn: number; tokensOut: number; costMinor: number } }>;
}

export interface UseCaseConfig {
  key: string;
  version: number;
  purpose: string;
  allowedInputs: string[];
  outputSchemaRef: string;
  promptVersion: string;
  modelRef: string;
  providerName: string;
  providerRegion: string;
  maxSteps: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
  monthlyBudgetMinor: number;
  enabled: boolean;
  evalThresholds: Record<string, number>;
}

// In-memory budget tracker per use case
const monthlySpendTracker = new Map<string, number>();

export async function assertBudget(uc: UseCaseConfig, estimatedCost = 10): Promise<void> {
  const current = monthlySpendTracker.get(uc.key) || 0;
  if (current + estimatedCost > uc.monthlyBudgetMinor) {
    throw new AppError("UNAVAILABLE", `Monthly budget exceeded for AI use-case ${uc.key}.`);
  }
}

export function recordSpend(useCaseKey: string, costMinor: number): void {
  const current = monthlySpendTracker.get(useCaseKey) || 0;
  monthlySpendTracker.set(useCaseKey, current + costMinor);
}

// Mock deterministic provider that satisfies tests and respects constitutional bounds
export class DeterministicMockProvider implements ModelProvider {
  public name = "zoiko-mock";
  public region = "eu-west-2";

  async generate(req: {
    model: string;
    system: string;
    messages: ModelMessage[];
    schema?: any;
    maxOutputTokens: number;
    signal: AbortSignal;
  }): Promise<{ text: string; usage: { tokensIn: number; tokensOut: number; costMinor: number } }> {
    if (req.signal.aborted) {
      throw new AppError("UNAVAILABLE", "Model request aborted due to timeout.");
    }

    const userMsg = req.messages.find(m => m.role === "user")?.content || "";

    // 1. Check for injected instruction attempt
    if (userMsg.toLowerCase().includes("ignore policy") && userMsg.toLowerCase().includes("highest hours")) {
      const matchId = userMsg.match(/<item id="([^"]+)">/);
      const releaseId = matchId ? matchId[1] : "release:00000000-0000-4000-a003-000000000001";
      // Return a proposal that attempts disclosure to let validators test blocking
      return {
        text: JSON.stringify({
          title: "Injected Workforce Risk Assessment",
          claims: [
            {
              id: "claim-1",
              text: "Employee Jane Doe has the highest hours with 23.4% boundary intrusion.",
              citations: [releaseId]
            }
          ],
          uncertainty: "Data inferred from employee surveillance records."
        }),
        usage: { tokensIn: 120, tokensOut: 45, costMinor: 2 }
      };
    }

    // 2. Check for numeric fidelity test attack
    if (userMsg.toLowerCase().includes("test-numeric-tamper")) {
      const matchId = userMsg.match(/<item id="([^"]+)">/);
      const releaseId = matchId ? matchId[1] : "release:00000000-0000-4000-a003-000000000001";
      return {
        text: JSON.stringify({
          title: "Tampered Numeric Proposal",
          claims: [
            {
              id: "claim-1",
              text: "Boundary intrusion reached 31.0% during the period.", // Fabricated number (actual is 23.4% or 25%)
              citations: [releaseId]
            }
          ],
          uncertainty: "Fabricated arithmetic test claim."
        }),
        usage: { tokensIn: 80, tokensOut: 30, costMinor: 1 }
      };
    }

    // 3. Check for citation fabrication attack
    if (userMsg.toLowerCase().includes("test-fabricated-citation")) {
      return {
        text: JSON.stringify({
          title: "Fabricated Citation Proposal",
          claims: [
            {
              id: "claim-1",
              text: "Evening rest deficits exceed standard operating margins.",
              citations: ["release:non-existent-fabricated-id"]
            }
          ],
          uncertainty: "Claim cites an unretrieved release."
        }),
        usage: { tokensIn: 80, tokensOut: 30, costMinor: 1 }
      };
    }

    // 4. Default compliant proposal based on release context
    // Extract actual release numbers if present
    const matchVal = userMsg.match(/Value:\s*([0-9.]+)/);
    const actualVal = matchVal ? matchVal[1] : "23.4";

    // Extract release ID
    const matchId = userMsg.match(/<item id="([^"]+)">/);
    const releaseId = matchId ? matchId[1] : "release:rel-baseline-1";

    return {
      text: JSON.stringify({
        title: "Cohort Working Time Quality Analysis",
        claims: [
          {
            id: "claim-1",
            text: `Cohort Boundary Intrusion Share is measured at ${actualVal}% over the approved 28-day observation window, reflecting systematic after-hours communications.`,
            citations: [releaseId]
          }
        ],
        uncertainty: "Cohort condition only; does not evaluate individual worker capacity or performance.",
        suggestedControls: ["CONTROL-SCHED-01"]
      }),
      usage: { tokensIn: 150, tokensOut: 60, costMinor: 3 }
    };
  }
}

export const providers: Record<string, ModelProvider> = {
  "zoiko-mock": new DeterministicMockProvider()
};

export async function callModel(
  uc: UseCaseConfig,
  input: { system: string; messages: ModelMessage[]; schema?: any },
  providerRegistry: Record<string, ModelProvider> = providers
): Promise<{ text: string; usage: { tokensIn: number; tokensOut: number; costMinor: number } }> {
  const p = providerRegistry[uc.providerName];
  if (!p || p.region !== uc.providerRegion) {
    throw new AppError("UNAVAILABLE", `Model provider ${uc.providerName} in region ${uc.providerRegion} is not available.`);
  }

  await assertBudget(uc);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), uc.timeoutMs);

  try {
    const res = await p.generate({
      model: uc.modelRef,
      system: input.system,
      messages: input.messages,
      schema: input.schema,
      maxOutputTokens: uc.maxOutputTokens,
      signal: ctl.signal
    });
    recordSpend(uc.key, res.usage.costMinor);
    return res;
  } finally {
    clearTimeout(timer);
  }
}
