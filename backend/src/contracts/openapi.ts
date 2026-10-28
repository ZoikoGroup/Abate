// backend/src/contracts/openapi.ts
export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Zoiko Abate API Contract Registry",
    version: "2.0.0",
    description: "Official canonical API contract for Abate organizational work-design and psychosocial-risk infrastructure."
  },
  servers: [
    { url: "/api/v2", description: "API v2 Base" }
  ],
  paths: {
    "/auth/token": {
      post: {
        summary: "Issue dev/test authentication token with tenant binding",
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
                  role: { type: "string", enum: ["RISK_OWNER", "CONTROL_OWNER", "REVIEWER", "EMPLOYER_ADMIN"] },
                  purpose: { type: "string" }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Token issued successfully" },
          "400": { description: "Validation error" }
        }
      }
    },
    "/organizations": {
      post: {
        summary: "Create organization unit within tenant",
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
                  name: { type: "string" },
                  parentId: { type: "string", format: "uuid" }
                },
                additionalProperties: false
              }
            }
          }
        },
        responses: {
          "200": { description: "Organization created or retrieved via idempotency" },
          "401": { description: "Unauthenticated" },
          "403": { description: "Forbidden" },
          "409": { description: "Conflict - Key reused with modified payload" }
        }
      },
      get: {
        summary: "List organizations in tenant scope",
        responses: {
          "200": { description: "List of organizations belonging strictly to the caller's tenant" },
          "401": { description: "Unauthenticated" }
        }
      }
    },
    "/organizations/{id}": {
      get: {
        summary: "Get organization by ID",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": { description: "Organization details" },
          "404": { description: "Not Found (returned identically for foreign or non-existent IDs)" }
        }
      }
    },
    "/audit-events": {
      get: {
        summary: "Query append-only audit events for caller's tenant",
        responses: {
          "200": { description: "Tenant audit trail" }
        }
      }
    },
    "/outbox/drain": {
      post: {
        summary: "Drain and publish pending outbox events",
        responses: {
          "200": { description: "Drained batch summary" }
        }
      }
    }
  }
};

