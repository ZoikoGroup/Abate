// backend/src/contracts/openapi.ts
// Official Canonical OpenAPI 3.1 Contract for Zoiko Abate (Phases 0-7, B8)

export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Zoiko Abate Authoritative API Contract Registry",
    version: "2.0.0",
    description: "Production API specification for Zoiko Abate psychosocial-risk governance, differential privacy compiler, bounded AI, work-design outcomes, and zero-impersonation diagnostic infrastructure."
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
        summary: "Execute semantic query through the differential privacy compiler",
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
        summary: "Approve outcome definition for production measurement",
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
    }
  }
};
