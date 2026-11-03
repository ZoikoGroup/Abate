// backend/src/domains/aichange/assistant.ts
// AI-change assistant (Phase 7 / Domain S14)
// Reuses the Phase 6 gateway; draft-only, reads released evidence only; output is strictly a proposal.
import { Tx } from "../../platform/db/with-tenant";
import { Actor } from "../../platform/command";
import { runAiUseCase } from "../ai/run";
import { AiRunView } from "../../contracts/ai";

/**
 * suggestAiChangeHazards: Suggests candidate hazards to examine for an AI change profile.
 * Reads only released evidence and approved knowledge.
 */
export async function suggestAiChangeHazards(
  tx: Tx,
  actor: Actor,
  profileId: string,
  baselineReleaseId: string
): Promise<AiRunView> {
  return await runAiUseCase(tx, actor, "ai_change_suggest", {
    contextRefs: [{ type: "RELEASE", id: baselineReleaseId }],
    question: `Examine work-design hazard risks introduced by AI change profile ${profileId}. Suggest candidate hazards for assurance review.`
  });
}
