// backend/src/domains/ai/retrieve.ts
import { Actor } from "../../platform/command";
import { ContextRef } from "../../contracts/ai";
import { getRelease } from "../../domains/privacy";
import { ReleaseView } from "../../contracts/release";

export interface ContextItem {
  id: string;
  kind: "RELEASE" | "KNOWLEDGE";
  trust: "DATA";
  text: string;
  data: any;
}

// In-memory approved knowledge base for versioned organizational policies
export const approvedKnowledgeBase = new Map<string, { id: string; tenantId: string; title: string; text: string }>();

export function seedApprovedKnowledge(item: { id: string; tenantId: string; title: string; text: string }): void {
  approvedKnowledgeBase.set(`${item.tenantId}:${item.id}`, item);
  approvedKnowledgeBase.set(item.id, item);
}

function renderReleaseForModel(r: ReleaseView & { status: "RELEASED" }): string {
  return [
    `Release ID: ${r.releaseId}`,
    `Metric: ${r.metricName} (${r.metricId} v${r.version})`,
    `Value: ${r.value} ${r.unit}`,
    `Window: ${r.periodStart} to ${r.periodEnd}`,
    `Quality: ${r.quality}`,
    `Freshness: ${r.freshness}`,
    `Interpretation: ${r.interpretation || "Cohort working pattern measurement."}`,
    `Limits: ${r.limits || "Not an individual score. Not a legal threshold."}`
  ].join("\n");
}

export async function retrieveContext(actor: Actor, refs: ContextRef[]): Promise<ContextItem[]> {
  const items: ContextItem[] = [];

  for (const r of refs) {
    if (r.type === "RELEASE") {
      try {
        const v = await getRelease(actor, r.id);
        // The one read path from Phase 3: suppressed, stale, or unavailable means model NEVER sees a value
        if (v.status !== "RELEASED") {
          continue;
        }
        items.push({
          id: `release:${r.id}`,
          kind: "RELEASE",
          trust: "DATA",
          text: renderReleaseForModel(v),
          data: v
        });
      } catch {
        // Safe skip if release not found or unauthenticated
        continue;
      }
    } else if (r.type === "KNOWLEDGE") {
      const kb = approvedKnowledgeBase.get(`${actor.tenantId}:${r.id}`) || approvedKnowledgeBase.get(r.id);
      if (kb) {
        items.push({
          id: `knowledge:${r.id}`,
          kind: "KNOWLEDGE",
          trust: "DATA",
          text: `Approved Guidance (${kb.title}):\n${kb.text}`,
          data: kb
        });
      }
    }
  }

  return items;
}
