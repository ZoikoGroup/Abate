// backend/src/routes/planes.ts
// Domain S13 & S14: Phase 7 Feature Flags, Work-Design Outcomes (Plane B), and AI Change Assessments.
import type { Express, Request, Response } from "express";
import { toErrorResponse, AppError } from "../platform/errors";
import { withTenant } from "../platform/db/with-tenant";
import { authenticate, resolveActor } from "../domains/tenant/auth";
import { getRelease } from "../domains/privacy";
import {
  CreateOutcomeDefinitionInput,
  EvaluateOutcomeInput,
  ToggleFeatureFlagInput,
  CreateAiChangeProfileInput,
  AdvanceAssessmentInput
} from "../contracts";
import {
  setFeatureFlag,
  listFeatureFlags,
  requireFeatureFlag,
  createOutcomeDefinition,
  approveOutcomeDefinition,
  getOutcomeDefinition,
  listOutcomeDefinitions,
  evaluateOutcome,
  getOutcomeEvaluation,
  listOutcomeEvaluations
} from "../domains/performance";
import {
  registerAiChangeProfile,
  createAssessment,
  advanceAssessment,
  getAssessment,
  listAssessments
} from "../domains/aichange";

export interface PlanesRouteDeps {
  getHeader: (req: Request, name: string) => string | null;
}

export function registerPlanesRoutes(app: Express, deps: PlanesRouteDeps): void {
  const { getHeader } = deps;

  // Feature Flags: list and toggle
  app.get("/api/v2/flags", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const flags = await withTenant(who.tenantId, async (tx) => {
        return await listFeatureFlags(tx, who.tenantId);
      });
      res.status(200).json(flags);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.post("/api/v2/flags", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const input = ToggleFeatureFlagInput.parse(req.body);
      if (input.tenantId && input.tenantId !== who.tenantId) {
        throw new AppError("FORBIDDEN", "Feature flags can only be changed for the authenticated tenant.");
      }
      const out = await withTenant(who.tenantId, async (tx) => {
        return await setFeatureFlag(tx, input.flag, input.enabled, actor.principalId, who.tenantId);
      });
      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Domain S13: Outcomes Definitions
  app.post("/api/v2/outcomes/definitions", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const input = CreateOutcomeDefinitionInput.parse(req.body);
      const out = await withTenant(who.tenantId, async (tx) => {
        await requireFeatureFlag(tx, who.tenantId, "outcomes_plane_b");
        return await createOutcomeDefinition(tx, input);
      });
      res.status(201).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.post("/api/v2/outcomes/definitions/:id/approve", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const out = await withTenant(who.tenantId, async (tx) => {
        await requireFeatureFlag(tx, who.tenantId, "outcomes_plane_b");
        return await approveOutcomeDefinition(tx, String(req.params.id), Number(req.query.version) || 1);
      });
      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.get("/api/v2/outcomes/definitions", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const out = await withTenant(who.tenantId, async (tx) => {
        return await listOutcomeDefinitions(tx);
      });
      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.get("/api/v2/outcomes/definitions/:id", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const out = await withTenant(who.tenantId, async (tx) => {
        return await getOutcomeDefinition(tx, String(req.params.id), Number(req.query.version) || 1);
      });
      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Domain S13: Outcomes Evaluations (Plane B - runs with write_plane = 'B')
  app.post("/api/v2/outcomes/evaluations", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const input = EvaluateOutcomeInput.parse(req.body);
      const out = await withTenant(
        who.tenantId,
        async (tx) => {
          return await evaluateOutcome(tx, actor, input);
        },
        { writePlane: "B" } // Enforce Plane B write context
      );
      res.status(201).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.get("/api/v2/outcomes/evaluations", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const out = await withTenant(who.tenantId, async (tx) => {
        return await listOutcomeEvaluations(tx, who.tenantId);
      });
      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.get("/api/v2/outcomes/evaluations/:id", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const out = await withTenant(who.tenantId, async (tx) => {
        return await getOutcomeEvaluation(tx, who.tenantId, String(req.params.id));
      });
      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Plane B Release Read Path (Refuses Plane-A release from Plane-B outcome endpoint)
  app.get("/api/v2/outcomes/releases/:id", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const release = await getRelease(actor, String(req.params.id), "B");
      res.status(200).json(release);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Domain S14: AI Change Profiles & Assessments
  app.post("/api/v2/ai-changes", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const input = CreateAiChangeProfileInput.parse(req.body);
      const out = await withTenant(who.tenantId, async (tx) => {
        const profile = await registerAiChangeProfile(tx, actor, input);
        const assessment = await createAssessment(tx, actor, { profileId: profile.id, profileVersion: profile.version });
        return { profile, assessment };
      });
      res.status(201).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.get("/api/v2/ai-changes", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const out = await withTenant(who.tenantId, async (tx) => {
        return await listAssessments(tx, who.tenantId);
      });
      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.get("/api/v2/ai-changes/:id", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const out = await withTenant(who.tenantId, async (tx) => {
        return await getAssessment(tx, who.tenantId, String(req.params.id));
      });
      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.post("/api/v2/ai-changes/:id/advance", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const ifMatchHeader = getHeader(req, "if-match");
      const ifMatch = ifMatchHeader ? parseInt(ifMatchHeader.replace(/"/g, ""), 10) : Number(req.body?.version);
      if (!ifMatch || isNaN(ifMatch)) {
        throw new AppError("VALIDATION", "Header 'If-Match' (or body.version) is required for stage advance.");
      }
      const input = AdvanceAssessmentInput.parse(req.body);
      const out = await withTenant(who.tenantId, async (tx) => {
        return await advanceAssessment(tx, actor, String(req.params.id), input.to, ifMatch, input);
      });
      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });
}
