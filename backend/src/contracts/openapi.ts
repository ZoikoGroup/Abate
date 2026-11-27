// backend/src/contracts/openapi.ts
// Official Canonical OpenAPI 3.1 Contract for Zoiko Abate (Phases 0-7, B8)

export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Zoiko Abate Authoritative API Contract Registry",
    version: "2.0.0",
    description: "API v2 specification for Zoiko Abate psychosocial-risk governance, privacy release compiler, bounded AI, work-design outcomes, and zero-impersonation diagnostic infrastructure."
  },
  servers: [
    { url: "/api/v2", description: "API v2 Base (Default Tenant Environment)" }
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Bearer token with embedded tenant_id, sub, and role."
      }
    }
  },
  security: [
    { BearerAuth: [] }
  ],
  paths: {
    // -------------------------------------------------------------
    // Phase 0/1: Authentication, Tenancy & Organizations
    // -------------------------------------------------------------
    "/auth/token": {
      post: {
        tags: ["Authentication & Tenancy"],
        summary: "Issue dev/test token with strict tenant context binding",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["tenantId", "subject"],
                properties: {
                  tenantId: { type: "string", format: "uuid" },
                  subject: { type: "string" },
                  role: { type: "string", enum: ["RISK_OWNER", "CONTROL_OWNER", "REVIEWER", "WORKS_COUNCIL", "EMPLOYER_ADMIN", "OPS_ADMIN"] }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Bearer token successfully issued" },
          "400": { description: "Validation error" }
        }
      }
    },
    "/auth/refresh": {
      post: {
        tags: ["Authentication & Tenancy"],
        summary: "Refresh active Bearer token with identical tenant context",
        responses: {
          "200": { description: "New Bearer token successfully issued" },
          "401": { description: "Unauthenticated" }
        }
      }
    },
    "/auth/logout": {
      post: {
        tags: ["Authentication & Tenancy"],
        summary: "Invalidate session credentials",
        responses: {
          "204": { description: "Session successfully terminated" }
        }
      }
    },
    "/me": {
      get: {
        tags: ["Authentication & Tenancy"],
        summary: "Retrieve authenticated principal profile, tenant, memberships, and navigation permissions",
        responses: {
          "200": { description: "Principal profile and allowed navigation items" },
          "401": { description: "Unauthenticated" }
        }
      }
    },
    "/tenants": {
      get: {
        tags: ["Authentication & Tenancy"],
        summary: "List available tenant workspaces for workspace switching",
        responses: {
          "200": { description: "List of available tenants" },
          "401": { description: "Unauthenticated" }
        }
      }
    },
    "/tenants/{id}": {
      get: {
        tags: ["Authentication & Tenancy"],
        summary: "Inspect tenant profile by ID (enforces strict tenant boundary)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "Tenant profile details" },
          "403": { description: "Forbidden: cross-tenant access prohibited" },
          "404": { description: "Tenant not found" }
        }
      }
    },
    "/tenants/current": {
      get: {
        tags: ["Authentication & Tenancy"],
        summary: "Retrieve current tenant profile from token context",
        responses: {
          "200": { description: "Current tenant metadata" },
          "401": { description: "Unauthenticated" }
        }
      }
    },
    "/organizations": {
      post: {
        tags: ["Organizations"],
        summary: "Create organizational unit within tenant scope",
        parameters: [
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string", minLength: 1 },
                  parentId: { type: "string", format: "uuid" }
                },
                additionalProperties: false
              }
            }
          }
        },
        responses: {
          "200": { description: "Organization unit created or returned via idempotency replay" },
          "409": { description: "Idempotency conflict" }
        }
      },
      get: {
        tags: ["Organizations"],
        summary: "List organizations strictly scoped to caller's tenant",
        responses: {
          "200": { description: "Tenant organization hierarchy" }
        }
      }
    },
    "/organizations/{id}": {
      get: {
        tags: ["Organizations"],
        summary: "Get organization unit by ID",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "Organization unit details" },
          "404": { description: "Not found (identically returned for foreign tenant IDs)" }
        }
      }
    },
    "/audit-events": {
      get: {
        tags: ["Audit & Outbox"],
        summary: "Query append-only audit trail for caller's tenant",
        responses: {
          "200": { description: "Tenant audit logs" }
        }
      }
    },
    "/outbox/drain": {
      post: {
        tags: ["Audit & Outbox"],
        summary: "Drain and publish transactional outbox events",
        responses: {
          "200": { description: "Outbox drain summary" }
        }
      }
    },

    // -------------------------------------------------------------
    // Phase 2: Ingest & Work Ledger
    // -------------------------------------------------------------
    "/ingest/batches": {
      post: {
        tags: ["Ingest & Work Ledger"],
        summary: "Submit append-only immutable work telemetry batch",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["connectionId", "records"],
                properties: {
                  connectionId: { type: "string", format: "uuid" },
                  records: { type: "array", items: { type: "object" } }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Batch accepted and ledger recorded" },
          "400": { description: "Invalid batch or schema contract mismatch" }
        }
      }
    },
    "/work-ledger": {
      get: {
        tags: ["Ingest & Work Ledger"],
        summary: "Inspect raw immutable work ledger entries",
        responses: {
          "200": { description: "List of work facts with cryptographically hashed record keys" }
        }
      }
    },
    "/connectors/calendar-cadence/batches": {
      post: {
        tags: ["Ingest & Work Ledger"],
        summary: "Ingest bounded CalendarCadence v1 batches (rejects meeting subjects, attendees, and descriptions)",
        responses: {
          "200": { description: "CalendarCadence batch accepted and safe receipt returned" },
          "400": { description: "Strict contract rejection (unallowlisted field or invalid timestamp)" }
        }
      }
    },
    "/source-contracts": {
      get: {
        tags: ["Ingest & Work Ledger"],
        summary: "List approved source contracts scoped to caller's tenant",
        responses: {
          "200": { description: "Tenant source contracts" }
        }
      }
    },
    "/connections": {
      get: {
        tags: ["Ingest & Work Ledger"],
        summary: "List tenant connections with wall-clock freshness health",
        responses: {
          "200": { description: "Enriched connection list" }
        }
      },
      post: {
        tags: ["Ingest & Work Ledger"],
        summary: "Idempotently register a new connection bound to an active source contract",
        responses: {
          "200": { description: "Registered connection" },
          "400": { description: "Validation or missing Idempotency-Key error" },
          "409": { description: "Idempotency conflict or inactive contract" }
        }
      }
    },
    "/tenant/sector-profile": {
      get: {
        tags: ["Tenants & Organizations"],
        summary: "Resolve active sector pack, neutral/pack vocabulary, demand windows, and enabled claim scope for caller's tenant",
        responses: {
          "200": { description: "TenantSectorProfile" }
        }
      },
      put: {
        tags: ["Tenants & Organizations"],
        summary: "Update per-tenant sector pack setting (tenant_sector_setting) via idempotent command",
        responses: {
          "200": { description: "Updated TenantSectorProfile" },
          "400": { description: "Validation error or missing Idempotency-Key" },
          "403": { description: "Requires RISK_OWNER or EMPLOYER_ADMIN role" }
        }
      }
    },
    "/connections/{id}/pause": {
      post: {
        tags: ["Ingest & Work Ledger"],
        summary: "Pause connection via idempotent command pipeline with audit and outbox event",
        responses: {
          "200": { description: "Connection paused" },
          "409": { description: "Suspended (REVOKED) connection cannot transition" }
        }
      }
    },
    "/connections/{id}/resume": {
      post: {
        tags: ["Ingest & Work Ledger"],
        summary: "Resume paused or suspended connection via idempotent command pipeline",
        responses: {
          "200": { description: "Connection resumed (ACTIVE or RESUMED)" },
          "409": { description: "Disconnected/revoked terminal connection cannot transition" }
        }
      }
    },
    "/connections/{id}/suspend": {
      post: {
        tags: ["Ingest & Work Ledger"],
        summary: "Reversibly suspend connection (SUSPENDED) via idempotent command pipeline",
        responses: {
          "200": { description: "Connection suspended (SUSPENDED)" },
          "409": { description: "Connection is in a terminal state" }
        }
      }
    },
    "/connections/{id}/disconnect": {
      post: {
        tags: ["Ingest & Work Ledger"],
        summary: "Permanently disconnect connection (terminal DISCONNECTED) via idempotent command pipeline",
        responses: {
          "200": { description: "Connection permanently disconnected (DISCONNECTED)" },
          "409": { description: "Connection already disconnected" }
        }
      }
    },
    "/connections/{id}/revoke": {
      post: {
        tags: ["Ingest & Work Ledger"],
        summary: "Legacy terminal revoke connection (REVOKED) via idempotent command pipeline",
        responses: {
          "200": { description: "Connection revoked (REVOKED)" },
          "409": { description: "Already in terminal connection state" }
        }
      }
    },

    // -------------------------------------------------------------
    // Phase 3: Cohort Privacy Compiler & Measurement
    // -------------------------------------------------------------
    "/metrics/definitions": {
      get: {
        tags: ["Cohort Privacy & Measurement"],
        summary: "List approved metric definitions (e.g. BOUNDARY_INTRUSION_SHARE)",
        responses: {
          "200": { description: "Metric definitions" }
        }
      }
    },
    "/privacy/query": {
      post: {
        tags: ["Cohort Privacy & Measurement"],
        summary: "Execute semantic query through the privacy release compiler",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["metricId", "cohortRef", "periodStart", "periodEnd"],
                properties: {
                  metricId: { type: "string" },
                  metricVersion: { type: "integer", default: 1 },
                  cohortRef: { type: "string" },
                  periodStart: { type: "string", format: "date-time" },
                  periodEnd: { type: "string", format: "date-time" },
                  releaseClass: { type: "string", enum: ["CLASS_A", "CLASS_B"], default: "CLASS_B" }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "RELEASED with aggregate value OR uniform UNAVAILABLE suppression" }
        }
      }
    },
    "/releases/{id}": {
      get: {
        tags: ["Cohort Privacy & Measurement"],
        summary: "Retrieve immutable privacy release artifact (Plane A)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "Release artifact without individual contributor counts" },
          "404": { description: "Not found or cross-plane refusal" }
        }
      }
    },

    // -------------------------------------------------------------
    // Phase 4: Risk Assurance & Control Workflow (Plane A)
    // -------------------------------------------------------------
    "/hazards": {
      post: {
        tags: ["Assurance & Hazards (Plane A)"],
        summary: "Register authoritative psychosocial hazard anchored to RELEASED evidence",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["title", "originatingReleaseId"],
                properties: {
                  title: { type: "string", minLength: 3 },
                  originatingReleaseId: { type: "string" }
                }
              }
            }
          }
        },
        responses: {
          "201": { description: "Hazard registered in state OPEN" },
          "400": { description: "Validation error or release not in RELEASED status" }
        }
      },
      get: {
        tags: ["Assurance & Hazards (Plane A)"],
        summary: "List authoritative hazards for tenant",
        responses: {
          "200": { description: "Hazard list" }
        }
      }
    },
    "/hazards/{id}": {
      get: {
        tags: ["Assurance & Hazards (Plane A)"],
        summary: "Get complete hazard detail view with causes and controls",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "Hazard detail view" },
          "404": { description: "Hazard not found" }
        }
      }
    },
    "/hazards/{id}/causes": {
      post: {
        tags: ["Assurance & Hazards (Plane A)"],
        summary: "Propose organizational cause statement (never individual worker blame)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["statement"],
                properties: {
                  statement: { type: "string", minLength: 5 }
                }
              }
            }
          }
        },
        responses: {
          "201": { description: "Organizational cause proposed in state PROPOSED" }
        }
      }
    },
    "/causes/{id}/review": {
      post: {
        tags: ["Assurance & Hazards (Plane A)"],
        summary: "Named reviewer decision on organizational cause",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["status"],
                properties: {
                  status: { type: "string", enum: ["REVIEWED_ACCEPTED", "REVIEWED_REJECTED"] },
                  note: { type: "string" }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Cause status updated" }
        }
      }
    },
    "/controls": {
      post: {
        tags: ["Assurance & Controls (Plane A)"],
        summary: "Draft version-bound control intervention",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["hazardId", "causeId", "scope", "objective", "dueDate", "verificationPlan"],
                properties: {
                  hazardId: { type: "string", format: "uuid" },
                  causeId: { type: "string", format: "uuid" },
                  scope: { type: "string" },
                  objective: { type: "string" },
                  dueDate: { type: "string", format: "date" },
                  verificationPlan: { type: "object" }
                }
              }
            }
          }
        },
        responses: {
          "201": { description: "Control drafted in state PROPOSED" }
        }
      }
    },
    "/controls/{id}/approve": {
      post: {
        tags: ["Assurance & Controls (Plane A)"],
        summary: "Authorized Risk Owner approves control bound to immutable version & hash",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "Control state advanced to APPROVED" }
        }
      }
    },
    "/controls/{id}/receipt": {
      post: {
        tags: ["Assurance & Controls (Plane A)"],
        summary: "Record implementation receipt with audit trail",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["kind", "completedOn", "evidenceRefs"],
                properties: {
                  kind: { type: "string", enum: ["MANUAL", "INTEGRATED"] },
                  completedOn: { type: "string", format: "date" },
                  evidenceRefs: { type: "array", items: { type: "string" } }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Receipt attached; state advances to IMPLEMENTED" }
        }
      }
    },
    "/controls/{id}/evaluate": {
      post: {
        tags: ["Assurance & Controls (Plane A)"],
        summary: "Human reviewer concludes verification outcome",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["outcome", "residualRisk"],
                properties: {
                  outcome: { type: "string", enum: ["EFFECTIVE", "PARTIALLY_EFFECTIVE", "NOT_EFFECTIVE", "INCONCLUSIVE"] },
                  residualRisk: { type: "string" }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Verification concluded; control state advances to CLOSED" }
        }
      }
    },
    "/hazards/{id}/evidence-package": {
      post: {
        tags: ["Assurance & Cryptographic Packages"],
        summary: "Export tamper-evident cryptographic evidence package with SHA-256 manifest",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "Signed manifest and bundled evidence artifacts" }
        }
      }
    },

    // -------------------------------------------------------------
    // Phase 5: Retention & Jurisdictions
    // -------------------------------------------------------------
    "/jurisdictions/active": {
      get: {
        tags: ["Retention & Jurisdictions"],
        summary: "List active policy packs and tenant bindings",
        responses: {
          "200": { description: "Active jurisdiction policy packs" }
        }
      }
    },
    "/retention/runs": {
      post: {
        tags: ["Retention & Jurisdictions"],
        summary: "Trigger scheduled retention evaluation run with legal hold guards",
        responses: {
          "200": { description: "Purged count and tombstone generation summary" }
        }
      }
    },

    // -------------------------------------------------------------
    // B8: Zero-Impersonation Operations & Diagnostics
    // -------------------------------------------------------------
    "/support/diagnostics": {
      post: {
        tags: ["Operations & Support (B8)"],
        summary: "Tenant issues signed HMAC-SHA256 diagnostic receipt without database access",
        responses: {
          "200": { description: "Signed diagnostic receipt" }
        }
      }
    },
    "/support/diagnostics/verify": {
      post: {
        tags: ["Operations & Support (B8)"],
        summary: "Verify authenticity of a diagnostic receipt signature",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["receipt"],
                properties: { receipt: { type: "object" } }
              }
            }
          }
        },
        responses: {
          "200": { description: "Verification status (true/false)" }
        }
      }
    },

    // -------------------------------------------------------------
    // Phase 6: Bounded AI & Safe Action Execution
    // -------------------------------------------------------------
    "/ai/use-cases": {
      get: {
        tags: ["Bounded AI & Actions (Phase 6)"],
        summary: "List registered bounded AI use cases",
        responses: {
          "200": { description: "Use case definitions" }
        }
      }
    },
    "/ai/proposals": {
      post: {
        tags: ["Bounded AI & Actions (Phase 6)"],
        summary: "Generate grounded AI mitigation explanation and proposal",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["useCaseKey", "version", "releaseId", "userQuery"],
                properties: {
                  useCaseKey: { type: "string" },
                  version: { type: "integer", default: 1 },
                  releaseId: { type: "string" },
                  userQuery: { type: "string" }
                }
              }
            }
          }
        },
        responses: {
          "201": { description: "AI Proposal created with verified citation grounding" }
        }
      }
    },
    "/ai/proposals/{id}/accept": {
      post: {
        tags: ["Bounded AI & Actions (Phase 6)"],
        summary: "Human authority accepts AI proposal into human workflow state",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "Proposal accepted with decision audit record" }
        }
      }
    },
    "/actions/proposals": {
      post: {
        tags: ["Bounded AI & Actions (Phase 6)"],
        summary: "Generate cryptographic short-lived action grant bound to approval",
        responses: {
          "201": { description: "Grant token and action attempt recorded" }
        }
      }
    },
    "/actions/{id}/dispatch": {
      post: {
        tags: ["Bounded AI & Actions (Phase 6)"],
        summary: "Safely execute approved action with fencing token",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "Dispatch outcome (SUCCEEDED/FAILED)" }
        }
      }
    },
    "/ops/kill-switches": {
      get: {
        tags: ["Bounded AI & Actions (Phase 6)"],
        summary: "List global AI kill-switches",
        responses: {
          "200": { description: "Kill switch state map" }
        }
      },
      post: {
        tags: ["Bounded AI & Actions (Phase 6)"],
        summary: "Trip or reset an operational kill-switch",
        responses: {
          "200": { description: "Kill switch record updated" }
        }
      }
    },

    // -------------------------------------------------------------
    // Phase 7: Work-Design Outcomes & Governed AI Change (Package B7)
    // -------------------------------------------------------------
    "/flags": {
      get: {
        tags: ["Work-Design & Outcomes (Plane B)"],
        summary: "Get active tenant feature flags (e.g. outcomes_plane_b)",
        responses: {
          "200": { description: "Feature flag state dictionary" }
        }
      },
      post: {
        tags: ["Work-Design & Outcomes (Plane B)"],
        summary: "Toggle a feature flag for tenant",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["flag", "enabled"],
                properties: {
                  flag: { type: "string" },
                  enabled: { type: "boolean" }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Feature flag state updated" }
        }
      }
    },
    "/outcomes/definitions": {
      get: {
        tags: ["Work-Design & Outcomes (Plane B)"],
        summary: "List prototype work-design outcome definitions (Plane B)",
        responses: {
          "200": { description: "Outcome definitions" }
        }
      },
      post: {
        tags: ["Work-Design & Outcomes (Plane B)"],
        summary: "Create new outcome definition",
        responses: {
          "201": { description: "Outcome definition created in state DRAFT" }
        }
      }
    },
    "/outcomes/definitions/{id}/approve": {
      post: {
        tags: ["Work-Design & Outcomes (Plane B)"],
        summary: "Approve outcome definition for active cohort measurement",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "Outcome definition approved" }
        }
      }
    },
    "/outcomes/evaluations": {
      get: {
        tags: ["Work-Design & Outcomes (Plane B)"],
        summary: "List recorded Plane B outcome evaluations",
        responses: {
          "200": { description: "Evaluations list with permitted claims" }
        }
      },
      post: {
        tags: ["Work-Design & Outcomes (Plane B)"],
        summary: "Evaluate work-design outcome with permitted claims check",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["outcomeId", "releaseId", "permittedClaims"],
                properties: {
                  outcomeId: { type: "string" },
                  outcomeVersion: { type: "integer", default: 1 },
                  releaseId: { type: "string" },
                  comparisonBasis: { type: "object" },
                  confounders: { type: "object" },
                  seriesBreak: { type: "boolean", default: false },
                  outcomeConfidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW", "INSUFFICIENT_DATA"] },
                  permittedClaims: { type: "array", items: { type: "string" } },
                  evidenceRefs: { type: "array", items: { type: "string" } }
                }
              }
            }
          }
        },
        responses: {
          "201": { description: "Outcome evaluation recorded in Plane B" },
          "400": { description: "Prohibited claim detected (e.g. claiming hazard mitigation)" }
        }
      }
    },
    "/outcomes/releases/{id}": {
      get: {
        tags: ["Work-Design & Outcomes (Plane B)"],
        summary: "Retrieve Plane B release artifact (strictly isolated from Plane A)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "Plane B release view" },
          "404": { description: "Cross-plane refusal or not found" }
        }
      }
    },
    "/ai-changes": {
      get: {
        tags: ["Governed AI Change (Domain S14)"],
        summary: "List AI work-design risk assessments",
        responses: {
          "200": { description: "Active assessments" }
        }
      },
      post: {
        tags: ["Governed AI Change (Domain S14)"],
        summary: "Register AI Change Profile and initialize 8-stage assessment",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["title", "affectedRoles", "affectedTasks", "decisionRights", "humanOverride", "monitoringChanges", "throughputAssumptions", "rolloutDate", "trainingSupport"],
                properties: {
                  title: { type: "string" },
                  affectedRoles: { type: "array", items: { type: "string" } },
                  affectedTasks: { type: "array", items: { type: "string" } },
                  automationMode: { type: "string", enum: ["ASSIST", "AUTOMATE_WITH_REVIEW", "AUTONOMOUS_BOUNDED"] },
                  decisionRights: { type: "string" },
                  humanOverride: { type: "string" },
                  monitoringChanges: { type: "string" },
                  throughputAssumptions: { type: "string" },
                  rolloutDate: { type: "string", format: "date" },
                  trainingSupport: { type: "string" }
                }
              }
            }
          }
        },
        responses: {
          "201": { description: "Profile registered and assessment started in stage REGISTERED" }
        }
      }
    },
    "/ai-changes/{id}": {
      get: {
        tags: ["Governed AI Change (Domain S14)"],
        summary: "Get assessment detail with assurance and performance summaries",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "Assessment view" }
        }
      }
    },
    "/ai-changes/{id}/advance": {
      post: {
        tags: ["Governed AI Change (Domain S14)"],
        summary: "Advance assessment stage (strictly guarded by If-Match versioning & prerequisite evidence)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "If-Match", in: "header", required: true, schema: { type: "string" }, description: "Current entity version (e.g. \"1\")" }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["to"],
                properties: {
                  to: { type: "string", enum: ["REGISTERED", "BASELINE", "DETECT", "ATTRIBUTE", "CONTROL", "VERIFY", "PERFORMANCE_REVIEW", "CLOSED"] },
                  version: { type: "integer" },
                  hazardIds: { type: "array", items: { type: "string" } },
                  controlIds: { type: "array", items: { type: "string" } },
                  baselineReleaseIds: { type: "array", items: { type: "string" } },
                  verificationRefs: { type: "array", items: { type: "string" } }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Stage successfully advanced" },
          "409": { description: "Conflict - Prerequisite evidence not met or version mismatch" }
        }
      }
    },
    "/jobs/{id}": {
      get: {
        tags: ["Operations & Jobs"],
        summary: "Poll status of long-running asynchronous background job (Guide §C.6)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "Async job status and progress" },
          "401": { description: "Unauthenticated" },
          "404": { description: "Job not found" }
        }
      }
    },
    "/ops/jobs": {
      get: {
        tags: ["Operations & Jobs"],
        summary: "List active background workers and async queue depth (Guide §D.8)",
        responses: {
          "200": { description: "Async job queue status" },
          "401": { description: "Unauthenticated" },
          "403": { description: "Forbidden" }
        }
      }
    },
    "/ops/dead-letters/{id}/replay": {
      post: {
        tags: ["Operations & Jobs"],
        summary: "Human-approved replay of a dead-lettered outbox event (requires support token & reason)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Dead-letter row marked replayed and outbox event restored to PENDING" },
          "400": { description: "Missing/invalid approval reason" },
          "401": { description: "Unauthenticated or non-support credential" },
          "404": { description: "Dead-letter event not found" },
          "409": { description: "Dead-letter event already replayed" }
        }
      }
    },
    "/auth/oidc/config": {
      get: {
        tags: ["Authentication & Tenancy"],
        summary: "Discover OIDC login configuration and dev-token availability",
        security: [],
        responses: {
          "200": { description: "OIDC configuration payload ({ enabled, devTokenEnabled, ... })" }
        }
      }
    },
    "/auth/oidc/exchange": {
      post: {
        tags: ["Authentication & Tenancy"],
        summary: "Exchange OIDC authorization code + PKCE verifier or ID token for session cookies",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  code: { type: "string" },
                  codeVerifier: { type: "string" },
                  redirectUri: { type: "string" },
                  idToken: { type: "string" }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Authenticated principal and session cookie set" },
          "400": { description: "Validation error" },
          "401": { description: "OIDC token verification failed" }
        }
      }
    },
    "/auth/support-token": {
      post: {
        tags: ["Operations & Support"],
        summary: "Issue scoped support operator token (non-tenant, zero tenant data access)",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["operator"],
                properties: {
                  operator: { type: "string" }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Issued support token and operator identity" },
          "403": { description: "Disabled outside local/test" }
        }
      }
    },
    "/connectors/zoikotime/batches": {
      post: {
        tags: ["Ingestion & Ledger (Phase 2)"],
        summary: "Ingest ZoikoTime work interval batch (strict allowlist; physical minimization)",
        parameters: [
          { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "IngestReceipt JSON ({ id, batch_id, accepted, duplicate, rejected, conflicted })" },
          "400": { description: "Schema validation error (unallowlisted surveillance fields rejected)" },
          "409": { description: "Batch payload conflict or inactive connection" }
        }
      }
    },
    "/connections/{id}": {
      get: {
        tags: ["Ingestion & Ledger (Phase 2)"],
        summary: "Fetch single source connection and cadence health",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "Connection detail view" },
          "404": { description: "Connection not found" }
        }
      }
    },
    "/receipts": {
      get: {
        tags: ["Ingestion & Ledger (Phase 2)"],
        summary: "List traceable ingestion receipts (counts only, zero quarantined rows)",
        responses: {
          "200": { description: "Array of IngestReceipt objects" }
        }
      }
    },
    "/work-facts": {
      get: {
        tags: ["Ingestion & Ledger (Phase 2)"],
        summary: "List append-only pseudonymized work-state facts for tenant",
        responses: {
          "200": { description: "Array of WorkFact objects" }
        }
      }
    },
    "/releases/query": {
      post: {
        tags: ["Privacy Compiler & Analytics (Phase 3)"],
        summary: "Compile deterministic privacy-safe cohort metric release (floor n>=10, window>=28d, diff>=5)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["metricId", "cohortRef", "periodStart", "periodEnd"],
                properties: {
                  metricId: { type: "string" },
                  metricVersion: { type: "integer" },
                  cohortRef: { type: "string" },
                  periodStart: { type: "string", format: "date-time" },
                  periodEnd: { type: "string", format: "date-time" },
                  releaseClass: { type: "string", enum: ["CLASS_A", "CLASS_B"] },
                  memberRefs: { type: "array", items: { type: "string" } }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "ReleaseView (RELEASED with aggregate value or uniform UNAVAILABLE when suppressed)" }
        }
      }
    },
    "/releases/{id}/export.csv": {
      get: {
        tags: ["Privacy Compiler & Analytics (Phase 3)"],
        summary: "Export suppressed aggregate release as CSV (fails closed if not RELEASED)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "text/csv release export" },
          "404": { description: "Release not found or not exportable" }
        }
      }
    },
    "/metrics/{id}/recalculate": {
      post: {
        tags: ["Privacy Compiler & Analytics (Phase 3)"],
        summary: "Recalculate metric version and mark existing releases STALE / SUPERSEDED",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "Recalculation summary ({ count })" }
        }
      }
    },
    "/hazards/{id}/causes/{causeId}/review": {
      post: {
        tags: ["Hazards & Controls (Phase 4)"],
        summary: "Accept or reject proposed organizational cause under a hazard",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "causeId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["status"],
                properties: {
                  status: { type: "string", enum: ["REVIEWED_ACCEPTED", "REVIEWED_REJECTED"] },
                  note: { type: "string" }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Updated cause record" },
          "404": { description: "Cause not found" }
        }
      }
    },
    "/controls/{id}": {
      get: {
        tags: ["Hazards & Controls (Phase 4)"],
        summary: "Get ControlDetailView by ID",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "ControlDetailView object" },
          "404": { description: "Control not found" }
        }
      },
      patch: {
        tags: ["Hazards & Controls (Phase 4)"],
        summary: "Material edit to control scope/objective/plan (increments version & invalidates prior approval)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "If-Match", in: "header", required: true, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "Updated ControlDetailView" },
          "409": { description: "Version mismatch conflict" }
        }
      }
    },
    "/controls/{id}/implementation": {
      post: {
        tags: ["Hazards & Controls (Phase 4)"],
        summary: "Commit implementation receipt (requires APPROVED state and matching material hash)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["kind", "completedOn", "evidenceRefs"],
                properties: {
                  kind: { type: "string", enum: ["MANUAL", "INTEGRATED"] },
                  completedOn: { type: "string" },
                  evidenceRefs: { type: "array", items: { type: "string" } }
                }
              }
            }
          }
        },
        responses: {
          "201": { description: "Updated ControlDetailView in IMPLEMENTED state" },
          "400": { description: "Schema validation error" },
          "409": { description: "Conflict - control is not APPROVED" }
        }
      }
    },
    "/controls/{id}/verification/pin": {
      post: {
        tags: ["Hazards & Controls (Phase 4)"],
        summary: "Pin pre-analysis verification plan before observing post-implementation data",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "Updated ControlDetailView in VERIFYING state" },
          "409": { description: "Conflict - control must be IMPLEMENTED" }
        }
      }
    },
    "/controls/{id}/verification/conclude": {
      post: {
        tags: ["Hazards & Controls (Phase 4)"],
        summary: "Human reviewer concludes control verification evaluation",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "Updated ControlDetailView in CLOSED state" }
        }
      }
    },
    "/hazards/{id}/disposition": {
      post: {
        tags: ["Hazards & Controls (Phase 4)"],
        summary: "Commit formal hazard disposition decision",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "Updated Hazard record" }
        }
      }
    },
    "/jurisdiction/coverage": {
      get: {
        tags: ["Retention & Legal Holds (Phase 5)"],
        summary: "Resolve tenant's active jurisdiction pack coverage over [effective_from, effective_to)",
        responses: {
          "200": { description: "JurisdictionCoverage object" }
        }
      }
    },
    "/jurisdiction/pack-versions": {
      get: {
        tags: ["Retention & Legal Holds (Phase 5)"],
        summary: "List read-only jurisdiction pack versions",
        responses: {
          "200": { description: "{ versions: JurisdictionPack[] }" }
        }
      }
    },
    "/retention": {
      get: {
        tags: ["Retention & Legal Holds (Phase 5)"],
        summary: "Get tenant retention classes, active legal holds, runs, and tombstone verification counts",
        responses: {
          "200": { description: "RetentionState payload" }
        }
      }
    },
    "/retention/preview": {
      get: {
        tags: ["Retention & Legal Holds (Phase 5)"],
        summary: "Dry-run retention preview calculating eligible, purgeable, and held facts",
        responses: {
          "200": { description: "RetentionPreview payload" }
        }
      }
    },
    "/retention/classes": {
      post: {
        tags: ["Retention & Legal Holds (Phase 5)"],
        summary: "Configure tenant retention schedule constrained by active jurisdiction pack floor/ceiling",
        parameters: [
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "Created retention class record" },
          "201": { description: "Created retention class record" },
          "400": { description: "Validation or jurisdiction pack bound refusal" }
        }
      }
    },
    "/legal-holds": {
      post: {
        tags: ["Retention & Legal Holds (Phase 5)"],
        summary: "Place legal preservation hold over tenant or connection scope",
        parameters: [
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } }
        ],
        responses: {
          "201": { description: "Created legal hold record" }
        }
      }
    },
    "/lifecycle/holds": {
      post: {
        tags: ["Retention & Legal Holds (Phase 5)"],
        summary: "Alias for /legal-holds",
        responses: {
          "201": { description: "Created legal hold record" }
        }
      }
    },
    "/legal-holds/{id}/release": {
      post: {
        tags: ["Retention & Legal Holds (Phase 5)"],
        summary: "Release an active legal hold with audit reason",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "Released legal hold record" }
        }
      }
    },
    "/lifecycle/holds/{id}/release": {
      post: {
        tags: ["Retention & Legal Holds (Phase 5)"],
        summary: "Alias for /legal-holds/{id}/release",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "Released legal hold record" }
        }
      }
    },
    "/ops/slo": {
      get: {
        tags: ["Operations & Support"],
        summary: "Compute live SLO latency/availability report from request ring buffer (support token required)",
        responses: {
          "200": { description: "SloReport payload" },
          "403": { description: "Tenant tokens forbidden on support routes" }
        }
      }
    },
    "/ops/requests/{requestId}": {
      get: {
        tags: ["Operations & Support"],
        summary: "Look up sanitized route template, status, and latency by requestId",
        parameters: [
          { name: "requestId", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "OpsRequestRecord" },
          "404": { description: "Request not found" }
        }
      }
    },
    "/ops/errors": {
      get: {
        tags: ["Operations & Support"],
        summary: "List fingerprinted safe internal errors without stack traces or tenant PII",
        responses: {
          "200": { description: "Array of SafeErrorLogEntry" }
        }
      }
    },
    "/ops/diagnostic-receipts/verify": {
      post: {
        tags: ["Operations & Support"],
        summary: "Verify HMAC/signature integrity of tenant-provided diagnostic receipt",
        responses: {
          "200": { description: "Verification result ({ valid, receiptId, tenantId, generatedAt })" }
        }
      }
    },
    "/ops/alerts": {
      get: {
        tags: ["Operations & Support"],
        summary: "List operational threshold alerts",
        responses: {
          "200": { description: "Active alerts list" }
        }
      }
    },
    "/ops/release-readiness": {
      get: {
        tags: ["Operations & Support"],
        summary: "Summarize release readiness checks and P0 blockers",
        responses: {
          "200": { description: "Release readiness summary" }
        }
      }
    },
    "/ops/connectors": {
      get: {
        tags: ["Operations & Support"],
        summary: "Inspect connector lag and health across service",
        responses: {
          "200": { description: "Connector health summary" }
        }
      }
    },
    "/support/diagnostic-receipts": {
      post: {
        tags: ["Operations & Support"],
        summary: "Tenant self-issues signed diagnostic state snapshot for zero-impersonation support",
        parameters: [
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } }
        ],
        responses: {
          "201": { description: "Signed DiagnosticReceipt payload" }
        }
      }
    },
    "/entitlements": {
      get: {
        tags: ["Retention & Legal Holds (Phase 5)"],
        summary: "Retrieve tenant feature entitlements",
        responses: {
          "200": { description: "Entitlements configuration" }
        }
      }
    },
    "/policy/resolution": {
      get: {
        tags: ["Retention & Legal Holds (Phase 5)"],
        summary: "Resolve effective policy envelope for tenant",
        responses: {
          "200": { description: "Resolved policy payload" }
        }
      }
    },
    "/evidence-packages": {
      get: {
        tags: ["Audit & Evidence"],
        summary: "List cryptographic evidence packages for tenant",
        responses: {
          "200": { description: "Array of EvidencePackage manifests" }
        }
      },
      post: {
        tags: ["Audit & Evidence"],
        summary: "Issue and persist signed Merkle evidence bundle for tenant",
        responses: {
          "201": { description: "Issued EvidencePackage bundle with Merkle root and manifestHash" }
        }
      }
    },
    "/evidence-packages/{id}": {
      get: {
        tags: ["Audit & Evidence"],
        summary: "Retrieve stored EvidencePackage by ID",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "EvidencePackage JSON" },
          "404": { description: "Package not found" }
        }
      }
    },
    "/evidence-packages/{id}/verify": {
      get: {
        tags: ["Audit & Evidence"],
        summary: "Server-side verification of stored EvidencePackage",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "Verification result" }
        }
      }
    },
    "/corrections/ingest": {
      post: {
        tags: ["Retention & Legal Holds (Phase 5)"],
        summary: "Record immutable correction against ledger data",
        responses: {
          "201": { description: "Correction recorded" }
        }
      }
    },
    "/corrections/{id}/acknowledge": {
      post: {
        tags: ["Retention & Legal Holds (Phase 5)"],
        summary: "Acknowledge a recorded ledger correction",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "Correction acknowledged" }
        }
      }
    },
    "/lifecycle/rights-requests": {
      post: {
        tags: ["Retention & Legal Holds (Phase 5)"],
        summary: "Submit GDPR / data-subject erasure or access rights request",
        responses: {
          "201": { description: "Rights request logged" }
        }
      }
    },
    "/ai/explain-release": {
      post: {
        tags: ["Bounded AI & Actions (Phase 6)"],
        summary: "Generate grounded explanation draft for a released privacy artifact (supports Idempotency-Key deduplication)",
        responses: {
          "200": { description: "AiRunView with validatorReport" },
          "400": { description: "Individual-inference or unsafe question refused" },
          "409": { description: "Idempotency-Key reused with different request payload" },
          "429": { description: "Monthly AI quota exceeded (RATE_LIMITED, sets Retry-After header)" },
          "503": { description: "Disabled by kill-switch" }
        }
      }
    },
    "/ai/draft-cause": {
      post: {
        tags: ["Bounded AI & Actions (Phase 6)"],
        summary: "Draft candidate organizational cause proposal (requires human accept; supports Idempotency-Key)",
        responses: {
          "200": { description: "AiRunView draft" },
          "409": { description: "Idempotency-Key reused with different request payload" },
          "429": { description: "Monthly AI quota exceeded (RATE_LIMITED, sets Retry-After header)" },
          "503": { description: "Disabled by kill-switch" }
        }
      }
    },
    "/ai/draft-control": {
      post: {
        tags: ["Bounded AI & Actions (Phase 6)"],
        summary: "Draft candidate control intervention proposal (requires human accept; supports Idempotency-Key)",
        responses: {
          "200": { description: "AiRunView draft" },
          "409": { description: "Idempotency-Key reused with different request payload" },
          "429": { description: "Monthly AI quota exceeded (RATE_LIMITED, sets Retry-After header)" },
          "503": { description: "Disabled by kill-switch" }
        }
      }
    },
    "/ai/quota": {
      get: {
        tags: ["Bounded AI & Actions (Phase 6)"],
        summary: "Inspect current tenant monthly AI quota usage, remaining allowance, and active kill switches",
        responses: {
          "200": { description: "Tenant AI quota status per use case" }
        }
      }
    },
    "/ops/ai-quota": {
      get: {
        tags: ["Operations & Support"],
        summary: "Support ops visibility into per-tenant monthly AI quota usage and kill-switch state",
        responses: {
          "200": { description: "Array of tenant AI quota summaries" }
        }
      }
    },
    "/ai/runs": {
      get: {
        tags: ["Bounded AI & Actions (Phase 6)"],
        summary: "List AI run audit records for tenant",
        responses: {
          "200": { description: "Array of AiRunView" }
        }
      }
    },
    "/ai/runs/{id}/accept": {
      post: {
        tags: ["Bounded AI & Actions (Phase 6)"],
        summary: "Human reviewer accepts AI draft as a non-binding workflow proposal",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "Accepted proposal with registered decisionRef" }
        }
      }
    },
    "/ai/runs/{id}/discard": {
      post: {
        tags: ["Bounded AI & Actions (Phase 6)"],
        summary: "Human reviewer discards AI draft proposal",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "Proposal marked DISCARDED" }
        }
      }
    },
    "/ai/kill-switches": {
      get: {
        tags: ["Bounded AI & Actions (Phase 6)"],
        summary: "Inspect current AI and tool kill-switch status",
        responses: {
          "200": { description: "Array of KillSwitchRecord" }
        }
      }
    },
    "/release/dossier": {
      get: {
        tags: ["Operations & Support"],
        summary: "Retrieve synthesized Platform Release Evidence Dossier JSON",
        security: [],
        responses: {
          "200": { description: "Release dossier JSON (status, testSuites, openFindingsBySeverity, signOff)" }
        }
      }
    },
    "/release-dossier": {
      get: {
        tags: ["Operations & Support"],
        summary: "Alias for /release/dossier",
        security: [],
        responses: {
          "200": { description: "Release dossier JSON" }
        }
      }
    },
    "/outcomes/definitions/{id}": {
      get: {
        tags: ["Work-Design & Outcomes (Plane B)"],
        summary: "Get Plane B outcome definition by ID",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "OutcomeDefinitionView" },
          "404": { description: "Not found" }
        }
      }
    },
    "/outcomes/evaluations/{id}": {
      get: {
        tags: ["Work-Design & Outcomes (Plane B)"],
        summary: "Get single Plane B outcome evaluation by ID",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "OutcomeEvaluationView" },
          "404": { description: "Not found" }
        }
      }
    },
    "/sector/work-items": {
      get: {
        tags: ["Sector Packs"],
        summary: "List work items for the tenant's active sector pack, with the pack vocabulary",
        responses: {
          "200": { description: "Active sectorKey, vocabulary and array of SectorWorkItem" },
          "403": { description: "No sector pack is enabled for this tenant" }
        }
      }
    },
    "/sector/work-items/map": {
      post: {
        tags: ["Sector Packs"],
        summary: "Validate sector work-item metadata against the active pack and map it to the neutral WORK_ITEM (rejects pack-forbidden fields)",
        responses: {
          "200": { description: "SectorWorkItem and neutral work item representation" },
          "400": { description: "Validation error: forbidden field, unit, jurisdiction or demand window outside the pack" },
          "403": { description: "No sector pack is enabled for this tenant" }
        }
      }
    },
    "/sector/work-items/fatigue-check": {
      post: {
        tags: ["Sector Packs"],
        summary: "Evaluate consecutive late-night sessions and pack-declared cohort work-design rules with jurisdiction overlay status",
        responses: {
          "200": { description: "SectorFatigueAssessment including ruleFindings and jurisdictionOverlay" },
          "403": { description: "No sector pack is enabled for this tenant" },
          "404": { description: "Work item not found" }
        }
      }
    },
    "/sector/rules": {
      get: {
        tags: ["Sector Packs"],
        summary: "List active sector pack cohort rules, jurisdiction overlays, forbidden fields, and non-overridable constitutional guardrails",
        responses: {
          "200": { description: "Active sector rule catalog and jurisdiction overlay metadata" },
          "403": { description: "No sector pack is enabled for this tenant" }
        }
      }
    },
    "/sector/legal/matters": {
      get: {
        tags: ["UK Legal Sector Pack (SRA 2023)"],
        summary: "Alias of /sector/work-items for the Legal pack: list UK Legal Practice matters and active court/closing demand windows",
        responses: {
          "200": { description: "Array of LegalMatterView" }
        }
      }
    },
    "/sector/legal/matters/map": {
      post: {
        tags: ["UK Legal Sector Pack (SRA 2023)"],
        summary: "Translate legal matter metadata into domain-neutral WORK_ITEM (rejects privileged/billing/ranking fields)",
        responses: {
          "200": { description: "Neutral workItem representation" },
          "400": { description: "Validation error - prohibited legal privilege, billing rate, or lawyer ranking rejected" }
        }
      }
    },
    "/sector/legal/fatigue-check": {
      post: {
        tags: ["UK Legal Sector Pack (SRA 2023)"],
        summary: "Evaluate consecutive late-night sessions and SRA 2023 supervisory partner consultation trigger",
        responses: {
          "200": { description: "LegalFatigueAssessmentView" },
          "404": { description: "Matter not found" }
        }
      }
    },
    "/auth/super-admin-token": {
      post: {
        tags: ["Super Admin Platform"],
        summary: "Issue dev-only Super Admin bearer token and SameSite=Strict admin session cookies (disabled outside local/test)",
        security: [],
        responses: {
          "200": { description: "Signed platform-super-admin bearer token and CSRF token" },
          "404": { description: "Disabled in hardened environments" }
        }
      }
    },
    "/admin/session/logout": {
      post: {
        tags: ["Super Admin Platform"],
        summary: "Clear dedicated HttpOnly SameSite=Strict Super Admin session and CSRF cookies",
        security: [],
        responses: {
          "204": { description: "Admin cookies cleared" }
        }
      }
    },
    "/admin/session/oidc/exchange": {
      post: {
        tags: ["Super Admin Platform"],
        summary: "Exchange an asymmetric OIDC Super Admin JWT (with MFA amr/acr and auth_time) for HttpOnly SameSite=Strict admin session cookies",
        security: [],
        responses: {
          "200": { description: "Verified OIDC Super Admin session and CSRF token" },
          "401": { description: "Missing/invalid OIDC JWT or missing MFA amr/acr claim" },
          "403": { description: "Super Admin scope required" }
        }
      }
    },
    "/admin/session/step-up": {
      post: {
        tags: ["Super Admin Platform"],
        summary: "Verify step-up re-authentication within configured window (checks real IdP auth_time and MFA amr/acr in staging/production)",
        responses: {
          "200": { description: "Upgraded step-up session and expiry timestamp" },
          "401": { description: "Unauthenticated, missing MFA, or stale IdP auth_time" },
          "403": { description: "Super Admin scope or CSRF check failed" }
        }
      }
    },
    "/admin/me": {
      get: {
        tags: ["Super Admin Platform"],
        summary: "Retrieve Super Admin identity, step-up state, safety banner, and server-driven navigation and action permissions",
        responses: {
          "200": { description: "AdminMeProfile" },
          "401": { description: "Unauthenticated or tenant token refused" },
          "403": { description: "Super Admin scope required" }
        }
      }
    },
    "/admin/overview": {
      get: {
        tags: ["Super Admin Platform"],
        summary: "Retrieve zero-impersonation platform overview telemetry, tenant counts, SLOs, pending approvals, and operational alerts",
        responses: {
          "200": { description: "AdminOverview payload" },
          "401": { description: "Unauthenticated or tenant token refused" },
          "403": { description: "Super Admin scope required" }
        }
      }
    },
    "/admin/tenants": {
      get: {
        tags: ["Super Admin Platform"],
        summary: "List tenant metadata and active sector pack assignments (no workforce data)",
        responses: {
          "200": { description: "{ items: AdminTenantRecord[] }" }
        }
      },
      post: {
        tags: ["Super Admin Platform"],
        summary: "Provision a new tenant, root organization, and initial launched or baseline sector pack setting (requires reason)",
        responses: {
          "201": { description: "Created AdminTenantRecord with ETag" },
          "400": { description: "Validation error or unknown fields" },
          "403": { description: "Preview sector pack blocked" }
        }
      }
    },
    "/admin/tenants/{tenantId}": {
      get: {
        tags: ["Super Admin Platform"],
        summary: "Retrieve single tenant metadata and current ETag version",
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "AdminTenantRecord" },
          "404": { description: "Tenant not found" }
        }
      },
      patch: {
        tags: ["Super Admin Platform"],
        summary: "Update tenant metadata with optimistic If-Match version check and mandatory reason",
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "If-Match", in: "header", required: false, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "Updated tenant metadata" },
          "404": { description: "Tenant not found" },
          "409": { description: "Stale If-Match version conflict" }
        }
      }
    },
    "/admin/tenants/{tenantId}/state": {
      post: {
        tags: ["Super Admin Platform"],
        summary: "Reactivate tenant immediately or request four-eyes tenant suspension (requires step-up and reason)",
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "If-Match", in: "header", required: false, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "{ id, state: 'ACTIVE', version }" },
          "202": { description: "Suspension queued for four-eyes approval (PENDING_APPROVAL)" },
          "401": { description: "Step-up re-authentication required or expired" },
          "404": { description: "Tenant not found" },
          "409": { description: "Stale If-Match version conflict" }
        }
      }
    },
    "/admin/tenants/{tenantId}/offboard-request": {
      post: {
        tags: ["Super Admin Platform"],
        summary: "Request four-eyes tenant offboarding through retention, hold, and tombstone workflow (never hard deletes)",
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "If-Match", in: "header", required: false, schema: { type: "string" } }
        ],
        responses: {
          "202": { description: "Offboard request queued for four-eyes approval" },
          "401": { description: "Step-up re-authentication required" },
          "404": { description: "Tenant not found" }
        }
      }
    },
    "/admin/tenants/{tenantId}/sector-pack": {
      put: {
        tags: ["Super Admin Platform"],
        summary: "Assign baseline sector pack or request four-eyes enablement of a launched sector pack (preview packs blocked)",
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "{ tenantId, sectorKey, packKey }" },
          "202": { description: "Launched pack enablement queued for four-eyes approval" },
          "401": { description: "Step-up re-authentication required" },
          "403": { description: "Preview or fixture sector pack blocked" }
        }
      }
    },
    "/admin/tenants/{tenantId}/principals": {
      get: {
        tags: ["Super Admin Platform"],
        summary: "List pseudonymous principal IDs, masked identifiers, and role memberships (every view audited)",
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "{ tenantId, privacyMode, items: AdminPrincipalMembership[] }" }
        }
      }
    },
    "/admin/tenants/{tenantId}/memberships": {
      post: {
        tags: ["Super Admin Platform"],
        summary: "Bootstrap initial EMPLOYER_ADMIN membership only (strictly refuses approval roles and platform staff)",
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "201": { description: "Created pseudonymous AdminPrincipalMembership" },
          "403": { description: "Role separation violation (only EMPLOYER_ADMIN bootstrap permitted)" }
        }
      }
    },
    "/admin/tenants/{tenantId}/memberships/{membershipId}/revoke": {
      post: {
        tags: ["Super Admin Platform"],
        summary: "Revoke an active role membership with mandatory reason and optimistic concurrency support",
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "membershipId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "{ membershipId, revoked: true }" },
          "404": { description: "Membership not found" }
        }
      }
    },
    "/admin/platform-users": {
      get: {
        tags: ["Super Admin Platform"],
        summary: "List named platform staff accounts (SUPER_ADMIN and OPS_SUPPORT)",
        responses: {
          "200": { description: "{ items: AdminPlatformUser[] }" }
        }
      },
      post: {
        tags: ["Super Admin Platform"],
        summary: "Create named platform staff account (refuses shared names; four-eyes for SUPER_ADMIN or break-glass)",
        responses: {
          "201": { description: "Created OPS_SUPPORT platform user" },
          "202": { description: "SUPER_ADMIN or break-glass creation queued for four-eyes approval" },
          "400": { description: "Shared account name refused or validation error" },
          "401": { description: "Step-up re-authentication required" }
        }
      }
    },
    "/admin/platform-users/{userId}/role": {
      patch: {
        tags: ["Super Admin Platform"],
        summary: "Change platform staff role (four-eyes required when promoting to SUPER_ADMIN)",
        parameters: [
          { name: "userId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "Updated platform role" },
          "202": { description: "Promotion to SUPER_ADMIN queued for four-eyes approval" },
          "404": { description: "Platform user not found" }
        }
      }
    },
    "/admin/platform-users/{userId}/disable": {
      post: {
        tags: ["Super Admin Platform"],
        summary: "Disable a platform staff account (four-eyes required for disabling SUPER_ADMIN; self-disable refused)",
        parameters: [
          { name: "userId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "Platform user disabled" },
          "202": { description: "SUPER_ADMIN disable queued for four-eyes approval" },
          "409": { description: "Cannot disable own active Super Admin account" }
        }
      }
    },
    "/admin/approvals": {
      get: {
        tags: ["Super Admin Platform"],
        summary: "List four-eyes admin approval requests (filterable by status)",
        responses: {
          "200": { description: "{ items: AdminApprovalRequestRecord[] }" }
        }
      }
    },
    "/admin/approvals/{id}/approve": {
      post: {
        tags: ["Super Admin Platform"],
        summary: "Approve and execute a pending four-eyes request as a second distinct Super Admin (requires step-up)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "Approved and executed action receipt" },
          "401": { description: "Step-up re-authentication required" },
          "403": { description: "Four-eyes violation (self-approval refused)" },
          "409": { description: "Replayed or expired approval request refused" }
        }
      }
    },
    "/admin/approvals/{id}/reject": {
      post: {
        tags: ["Super Admin Platform"],
        summary: "Reject a pending four-eyes request as a second distinct Super Admin (requires step-up)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "{ id, status: 'REJECTED', rejectedBy }" },
          "403": { description: "Requester cannot decide own approval request" },
          "409": { description: "Approval request already decided" }
        }
      }
    },
    "/admin/governance": {
      get: {
        tags: ["Super Admin Platform"],
        summary: "List registered sector and jurisdiction governance packs with preview not-enabled flags",
        responses: {
          "200": { description: "{ sectorPacks: AdminGovernancePack[] }" }
        }
      }
    },
    "/admin/feature-flags": {
      get: {
        tags: ["Super Admin Platform"],
        summary: "List tenant and platform feature flags",
        responses: {
          "200": { description: "{ items: AdminFeatureFlagRecord[] }" }
        }
      },
      post: {
        tags: ["Super Admin Platform"],
        summary: "Disable a feature flag immediately or request four-eyes enablement (requires step-up and reason)",
        responses: {
          "200": { description: "{ tenantId, flag, enabled: false }" },
          "202": { description: "Feature flag enablement queued for four-eyes approval" },
          "401": { description: "Step-up re-authentication required" }
        }
      }
    },
    "/admin/entitlements": {
      get: {
        tags: ["Super Admin Platform"],
        summary: "List commercial tenant entitlements (never privacy overrides)",
        responses: {
          "200": { description: "{ items: AdminEntitlementRecord[] }" }
        }
      },
      post: {
        tags: ["Super Admin Platform"],
        summary: "Set commercial tenant entitlement (refuses privacy-floor override keys with 403)",
        responses: {
          "200": { description: "Saved AdminEntitlementRecord" },
          "403": { description: "Privacy-floor override key refused" },
          "409": { description: "Stale If-Match version conflict" }
        }
      }
    },
    "/admin/ai-quota": {
      get: {
        tags: ["Super Admin Platform"],
        summary: "List per-tenant AI monthly quota configurations (metadata only)",
        responses: {
          "200": { description: "{ items: AdminAiQuotaRecord[] }" }
        }
      }
    },
    "/admin/tenants/{tenantId}/ai-quota": {
      put: {
        tags: ["Super Admin Platform"],
        summary: "Configure per-tenant monthly AI budget cap with optimistic If-Match and mandatory reason",
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "If-Match", in: "header", required: false, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "Updated AI quota configuration" },
          "404": { description: "Tenant not found" },
          "409": { description: "Stale If-Match version conflict" }
        }
      }
    },
    "/admin/kill-switches": {
      post: {
        tags: ["Super Admin Platform"],
        summary: "Request four-eyes activation or reset of an AI or tool kill switch (supports optional expiry)",
        responses: {
          "202": { description: "Kill switch request queued for four-eyes approval" },
          "401": { description: "Step-up re-authentication required" }
        }
      }
    },
    "/admin/operations": {
      get: {
        tags: ["Super Admin Platform"],
        summary: "Content-free platform operational summary (worker heartbeat, queue depth, dead letters, connector freshness)",
        responses: {
          "200": { description: "AdminOperationsOverview" }
        }
      }
    },
    "/admin/audit": {
      get: {
        tags: ["Super Admin Platform"],
        summary: "Search and filter immutable platform administration audit events",
        responses: {
          "200": { description: "{ items: AdminPlatformAuditEvent[] }" }
        }
      }
    },
    "/admin/audit/export": {
      post: {
        tags: ["Super Admin Platform"],
        summary: "Audited export of platform administration audit events as JSON or CSV (export itself is audited)",
        responses: {
          "200": { description: "JSON bundle or CSV text export" }
        }
      }
    },

    // -------------------------------------------------------------
    // Tenant Admin Workspace (/api/v2/tenant-admin/*)
    // -------------------------------------------------------------
    "/tenant-admin/users": {
      get: {
        tags: ["Tenant Admin"],
        summary: "List principals and effective-dated role memberships within caller's tenant",
        responses: {
          "200": { description: "{ tenantId, items: TenantAdminUserRecord[] }" },
          "403": { description: "Requires tenant administration read role" }
        }
      }
    },
    "/tenant-admin/users/{principalId}": {
      get: {
        tags: ["Tenant Admin"],
        summary: "Retrieve single tenant principal with ETag (foreign and missing IDs return identical 404)",
        parameters: [
          { name: "principalId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "TenantAdminUserRecord" },
          "404": { description: "User not found" }
        }
      }
    },
    "/tenant-admin/users/{principalId}/deactivate": {
      post: {
        tags: ["Tenant Admin"],
        summary: "Deactivate a tenant user via idempotent command with If-Match check and audit trail",
        parameters: [
          { name: "principalId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
          { name: "If-Match", in: "header", required: false, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "{ principalId, active: false, version }" },
          "403": { description: "Requires EMPLOYER_ADMIN role" },
          "404": { description: "User not found" },
          "409": { description: "Self-deactivation or stale If-Match conflict" }
        }
      }
    },
    "/tenant-admin/users/{principalId}/reactivate": {
      post: {
        tags: ["Tenant Admin"],
        summary: "Reactivate a deactivated tenant user via idempotent command",
        parameters: [
          { name: "principalId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
          { name: "If-Match", in: "header", required: false, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "{ principalId, active: true, version }" },
          "404": { description: "User not found" },
          "409": { description: "Stale If-Match conflict" }
        }
      }
    },
    "/tenant-admin/memberships": {
      post: {
        tags: ["Tenant Admin"],
        summary: "Assign effective-dated domain role membership inside caller's tenant",
        parameters: [
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } }
        ],
        responses: {
          "201": { description: "Created effective-dated membership with approver-authority indicator" },
          "403": { description: "Requires EMPLOYER_ADMIN role" },
          "404": { description: "Organization or principal not found in tenant" }
        }
      }
    },
    "/tenant-admin/memberships/{membershipId}/end": {
      post: {
        tags: ["Tenant Admin"],
        summary: "End an effective-dated role membership and recheck remaining approver authority",
        parameters: [
          { name: "membershipId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
          { name: "If-Match", in: "header", required: false, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "Ended membership and remaining approver authority summary" },
          "404": { description: "Membership not found" },
          "409": { description: "Stale If-Match conflict" }
        }
      }
    },
    "/tenant-admin/invitations": {
      get: {
        tags: ["Tenant Admin"],
        summary: "List OIDC invitations strictly within caller's tenant",
        responses: {
          "200": { description: "{ tenantId, items: TenantInvitationRecord[] }" }
        }
      },
      post: {
        tags: ["Tenant Admin"],
        summary: "Create OIDC invitation with masked email storage and effective-dated role grant",
        parameters: [
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } }
        ],
        responses: {
          "201": { description: "Created TenantInvitationRecord" },
          "403": { description: "Requires EMPLOYER_ADMIN role" }
        }
      }
    },
    "/tenant-admin/invitations/{invitationId}/revoke": {
      post: {
        tags: ["Tenant Admin"],
        summary: "Revoke a pending OIDC invitation inside caller's tenant",
        parameters: [
          { name: "invitationId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
          { name: "If-Match", in: "header", required: false, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "{ id, status: 'REVOKED', version }" },
          "404": { description: "Invitation not found" },
          "409": { description: "Already revoked or stale If-Match conflict" }
        }
      }
    },
    "/tenant-admin/organizations/{orgId}": {
      patch: {
        tags: ["Tenant Admin"],
        summary: "Rename or reparent an organization unit inside caller's tenant",
        parameters: [
          { name: "orgId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
          { name: "If-Match", in: "header", required: false, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "Updated organization unit with ETag" },
          "400": { description: "Validation error or self-parent cycle" },
          "404": { description: "Organization not found" },
          "409": { description: "Stale If-Match conflict" }
        }
      }
    },
    "/tenant-admin/audit": {
      get: {
        tags: ["Tenant Admin"],
        summary: "Search and filter own tenant's append-only audit log",
        responses: {
          "200": { description: "{ tenantId, items: AuditEvent[] }" }
        }
      }
    },
    "/tenant-admin/rights-requests": {
      get: {
        tags: ["Tenant Admin"],
        summary: "List own tenant's data-subject rights request history",
        responses: {
          "200": { description: "{ tenantId, items: RightsRequestRecord[] }" }
        }
      }
    },
    "/tenant-admin/usage": {
      get: {
        tags: ["Tenant Admin"],
        summary: "Unified tenant usage summary: AI quota remaining, entitlements, and tenant-scoped connector health",
        responses: {
          "200": { description: "TenantAdminUsageSummary" }
        }
      }
    }
  }
};
