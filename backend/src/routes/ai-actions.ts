// backend/src/routes/ai-actions.ts
// Domain S08 & S09: Phase 6 Bounded AI & Safe Action Execution endpoints.
import type { Express, Request, Response } from "express";
import { toErrorResponse, AppError } from "../platform/errors";
import { runCommand, computeRequestHash } from "../platform/command";
import { withTenant, withPlatform } from "../platform/db/with-tenant";
import { authenticate, authorize, resolveActor } from "../domains/tenant/auth";
import { authenticateSupport } from "../domains/support";
import {
  ExplainReleaseInput,
  DraftCauseInput,
  DraftControlInput,
  ActionProposalInput
} from "../contracts";
import {
  runAiUseCase,
  acceptAiRun,
  discardAiRun,
  getKillSwitches,
  getAiQuotaStatus
} from "../domains/ai";
import { proposeAction, dispatchAction } from "../domains/actions";
import { GOLDEN_01 } from "../fixtures/golden01";

export interface AiActionRouteDeps {
  getHeader: (req: Request, name: string) => string | null;
  parseLimit: (req: Request, def: number, max: number) => number;
}

export function registerAiActionRoutes(app: Express, deps: AiActionRouteDeps): void {
  const { getHeader, parseLimit } = deps;

  async function executeAiEndpoint(
    req: Request,
    operation: string,
    useCaseKey: string,
    payloadForHash: unknown,
    fn: (tx: any, actor: any) => Promise<any>,
    actor: any,
    tenantId: string,
    purpose: string
  ): Promise<any> {
    const idempotencyKey = getHeader(req, "idempotency-key") || getHeader(req, "x-idempotency-key");
    if (!idempotencyKey) {
      return await withTenant(tenantId, async (tx) => fn(tx, actor));
    }
    const cmdRes = await runCommand({
      tenantId,
      operation,
      idempotencyKey,
      requestHash: computeRequestHash({ useCaseKey, ...(payloadForHash as object) }),
      actor,
      body: async (tx) => {
        const result = await fn(tx, actor);
        return {
          result,
          audit: {
            purpose,
            command: operation,
            resourceType: "ai_run",
            resourceId: result.id,
            resourceVersion: 1,
            result: "SUCCESS",
            evidenceRefs: [`ai_run/${result.id}`]
          },
          events: []
        };
      }
    });
    return cmdRes.body;
  }

  // AI Explain Release (Domain S08)
  app.post("/api/v2/ai/explain-release", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const input = ExplainReleaseInput.parse(req.body);

      const out = await executeAiEndpoint(
        req,
        "ai.explain_release",
        "explain_release",
        input,
        async (tx, resolvedActor) =>
          runAiUseCase(tx, resolvedActor, "explain_release", {
            contextRefs: [{ type: "RELEASE", id: input.releaseId }],
            question: input.question
          }),
        actor,
        who.tenantId,
        who.purpose
      );

      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // AI Draft Cause Hypotheses (Domain S08)
  app.post("/api/v2/ai/draft-cause", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const input = DraftCauseInput.parse(req.body);

      const out = await executeAiEndpoint(
        req,
        "ai.draft_cause",
        "draft_cause",
        input,
        async (tx, resolvedActor) => {
          const hRes = await tx.q("SELECT * FROM hazard WHERE id = $1 AND tenant_id = $2", [input.hazardId, who.tenantId]);
          if (!hRes.rowCount || hRes.rowCount === 0) {
            throw new AppError("NOT_FOUND", "Hazard not found for cause drafting.");
          }
          const hazard = hRes.rows[0];
          return await runAiUseCase(tx, resolvedActor, "draft_cause", {
            contextRefs: [{ type: "RELEASE", id: hazard.originating_release_id }],
            question: `Suggest organizational cause hypotheses for hazard: ${hazard.title}`
          });
        },
        actor,
        who.tenantId,
        who.purpose
      );

      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // AI Draft Control Parameters (Domain S08)
  app.post("/api/v2/ai/draft-control", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const input = DraftControlInput.parse(req.body);

      const out = await executeAiEndpoint(
        req,
        "ai.draft_control",
        "draft_control",
        input,
        async (tx, resolvedActor) => {
          const hRes = await tx.q("SELECT * FROM hazard WHERE id = $1 AND tenant_id = $2", [input.hazardId, who.tenantId]);
          if (!hRes.rowCount || hRes.rowCount === 0) {
            throw new AppError("NOT_FOUND", "Hazard not found for control drafting.");
          }
          const hazard = hRes.rows[0];
          return await runAiUseCase(tx, resolvedActor, "draft_control", {
            contextRefs: [{ type: "RELEASE", id: hazard.originating_release_id }],
            question: `Draft workplace risk controls for hazard: ${hazard.title}`
          });
        },
        actor,
        who.tenantId,
        who.purpose
      );

      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Accept AI Proposal (Domain S08)
  app.post("/api/v2/ai/runs/:id/accept", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);

      const out = await withTenant(who.tenantId, async (tx) => {
        return await acceptAiRun(tx, actor, String(req.params.id), req.body);
      });

      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Discard AI Proposal (Domain S08)
  app.post("/api/v2/ai/runs/:id/discard", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);

      const out = await withTenant(who.tenantId, async (tx) => {
        return await discardAiRun(tx, actor, String(req.params.id));
      });

      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // List AI Runs for Tenant
  app.get("/api/v2/ai/runs", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      authorize(await resolveActor(who.tenantId, who.subject, new Date(), who.role), "ai.run.read");
      const out = await withTenant(who.tenantId, async (tx) => {
        const result = await tx.q(
          `SELECT * FROM ai_run WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT ${parseLimit(req, 100, 500)}`,
          [who.tenantId]
        );
        return result.rows;
      });
      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Per-tenant AI Quota Status (usage, remaining budget, window reset, kill switches)
  app.get("/api/v2/ai/quota", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      authorize(await resolveActor(who.tenantId, who.subject, new Date(), who.role), "ai.run.read");
      const out = await withTenant(who.tenantId, async (tx) => getAiQuotaStatus(tx));
      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Support Ops: Per-tenant AI Quota Visibility across active tenants
  app.get("/api/v2/ops/ai-quota", async (req: Request, res: Response) => {
    try {
      await authenticateSupport(getHeader(req, "authorization"));
      const requestedTenantId =
        typeof req.query.tenantId === "string" && req.query.tenantId.trim() ? req.query.tenantId.trim() : null;
      const tenantIds = requestedTenantId ? [requestedTenantId] : [GOLDEN_01.tenantA.id, GOLDEN_01.tenantB.id];

      const items = [];
      for (const tId of tenantIds) {
        const q = await withTenant(tId, async (tx) => getAiQuotaStatus(tx));
        items.push(q);
      }
      res.status(200).json({ items });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Tenants may see which AI features are switched off (no tenant data involved)
  app.get("/api/v2/ai/kill-switches", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      authorize(await resolveActor(who.tenantId, who.subject, new Date(), who.role), "ai.kill_switch.read");
      res.status(200).json(await withPlatform(tx => getKillSwitches(tx)));
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Propose External Action with Grant Token (Domain S09)
  app.post("/api/v2/actions/proposals", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      res.status(201).json(await proposeAction({ who, actor, input: ActionProposalInput.parse(req.body) }));
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Dispatch External Action (Domain S09): grant bound to tenant + attempt; tool/target/params from the stored attempt
  app.post("/api/v2/actions/:id/dispatch", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const out = await dispatchAction({
        who,
        actor,
        attemptId: String(req.params.id),
        input: { params: req.body?.params ?? {}, grantToken: getHeader(req, "x-action-grant") || req.body?.grantToken }
      });
      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });
}
