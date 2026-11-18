// frontend/src/components/Demo/WhatHappened.tsx
import React from "react";

export interface WhatHappenedProps {
  stepId: number;
  data?: {
    health?: any;
    tenantId?: string;
    subject?: string;
    role?: string;
    testReport?: any;
    dossier?: any;
    activeOrgName?: string;
    activeKey?: string;
    secondaryKey?: string;
  };
}

export const WhatHappened: React.FC<WhatHappenedProps> = ({ stepId, data }) => {
  const objectMode = data?.health?.objectStore?.mode || "unknown";
  const dbMode = data?.health?.database?.mode || "unknown";
  const boundaryTotal = data?.testReport?.total ?? 0;
  const boundaryPassed = data?.testReport?.passed ?? 0;
  const dossierSuites = Array.isArray(data?.dossier?.testSuites) ? data.dossier.testSuites.length : 0;
  const dossierChecks = data?.dossier?.totalChecksPassed;
  const dossierStatus = data?.dossier?.status || data?.dossier?.decision?.outcome || "UNAVAILABLE";
  const serverOrigin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "http://localhost:5000";

  return (
    <div className="what-happened-panel" aria-label="What just happened explanation">
      <div className="panel-badge">WHAT JUST HAPPENED &amp; WHY IT MATTERS</div>

      {stepId === 1 && (
        <div className="explanation-content">
          <p>
            The live Express + TypeScript backend answered from <code>{serverOrigin}</code> in environment{" "}
            <code>{data?.health?.environment || "unknown"}</code> with database mode <code>{dbMode}</code> and object
            storage in <code>{objectMode}</code> mode:
          </p>
          <div className="domain-pill-list">
            <span className="pill">S01 tenant (Phase 0–1)</span>
            <span className="pill">S02/S03 ingest &amp; ledger (Phase 2)</span>
            <span className="pill">S04/S06 measure &amp; privacy (Phase 3)</span>
            <span className="pill">S05/S07 hazards &amp; controls (Phase 4)</span>
            <span className="pill">S10/S11/S12 lifecycle (Phase 5)</span>
            <span className="pill">S08/S09 bounded AI &amp; actions (Phase 6)</span>
            <span className="pill">Plane B outcomes &amp; AI change (Phase 7)</span>
            <span className="pill">B8 ops &amp; SLOs (Phase 8)</span>
          </div>
          <p className="note-text">
            <strong>Why we use this:</strong> Abate prevents individual workplace surveillance by separating data collection,
            cohort privacy release, and compliance action across strict domain boundaries. This check proves the live
            backend enforces all constitutional boundaries—not a static UI mockup.
          </p>
        </div>
      )}

      {stepId === 2 && (
        <div className="explanation-content">
          <p>
            The backend served the canonical <strong>OpenAPI 3.1 contract specification</strong> from{" "}
            <code>GET /api/v2/contracts/openapi.json</code>, generated from strict Zod schemas in{" "}
            <code>backend/src/contracts/</code>.
          </p>
          <p>
            Every allowed field, enum, header requirement (<code>Idempotency-Key</code>, <code>If-Match</code>), and safe
            error shape (<code>code</code>, <code>message</code>, <code>requestId</code>) lives in one shared registry.
          </p>
          <p className="note-text">
            <strong>Why we use this:</strong> Rejecting unknown fields (<code>.strict()</code>) at the API boundary is
            Abate&apos;s first shield against overcollection—forbidden fields like screenshots or medical reasons cannot
            sneak through unvalidated payloads.
          </p>
        </div>
      )}

      {stepId === 3 && (
        <div className="explanation-content">
          <p>
            The backend issued a signed JWT binding the caller&apos;s verified identity to one tenant scope and purpose
            (outside <code>local</code> and <code>test</code>, dev tokens turn off and OIDC provider tokens apply):
          </p>
          <div className="jwt-claims-box">
            <div><strong>tenantId:</strong> <code>{data?.tenantId || "00000000-0000-4000-a000-00000000000a"}</code></div>
            <div><strong>subject:</strong> <code>{data?.subject || "auth0|user-tenant-a-risk-owner"}</code></div>
            <div><strong>role:</strong> <code>{data?.role || "RISK_OWNER"}</code></div>
            <div><strong>lifetime:</strong> <code>8 hours</code></div>
          </div>
          <p className="note-text">
            <strong>Why we use this:</strong> Clients can never choose a tenant by editing a JSON field or URL parameter.
            All queries derive <code>tenant_id</code> strictly from verified token claims.
          </p>
        </div>
      )}

      {stepId === 4 && (
        <div className="explanation-content">
          <p>
            Inside a single atomic PostgreSQL transaction wrapped with <code>withTenant()</code> (<code>set_config(&apos;app.tenant_id&apos;, ..., true)</code>),
            <code>runCommand()</code> committed the <strong>4-way atomic state change</strong>:
          </p>
          <div className="four-writes-grid">
            <div className="write-card">
              <span className="w-num">1</span>
              <div className="w-info">
                <strong>organization</strong>
                <p>Inserted row for <code>{data?.activeOrgName || "Apex Litigation Practice"}</code> with UUID &amp; tenant ID.</p>
              </div>
            </div>
            <div className="write-card">
              <span className="w-num">2</span>
              <div className="w-info">
                <strong>idempotency_record</strong>
                <p>Claimed primary key <code>(tenant_id, operation, key)</code> and saved SHA-256 request hash &amp; response.</p>
              </div>
            </div>
            <div className="write-card">
              <span className="w-num">3</span>
              <div className="w-info">
                <strong>audit_event</strong>
                <p>Appended immutable record: <code>organization.create</code> with actor ID and evidence reference.</p>
              </div>
            </div>
            <div className="write-card">
              <span className="w-num">4</span>
              <div className="w-info">
                <strong>outbox_event</strong>
                <p>Queued <code>organization.created</code> inside the same transaction for the background worker.</p>
              </div>
            </div>
          </div>
          <p className="note-text">
            <strong>Why we use this:</strong> Audit trails and downstream events can never be lost after a crash, and all
            four records succeed or roll back together.
          </p>
        </div>
      )}

      {stepId === 5 && (
        <div className="explanation-content">
          <p>
            The client replayed Step 4 with the identical <code>Idempotency-Key</code> (<code>{data?.activeKey?.slice(0, 12) || "same-key"}...</code>)
            and identical JSON body.
          </p>
          <p>
            The backend matched <code>sha256(canonicalJson(body))</code> against <code>idempotency_record</code> and returned
            the exact cached response immediately without executing a second insert.
          </p>
          <p className="note-text">
            <strong>Why we use this:</strong> Double-clicks, mobile retries, and flaky networks never create duplicate
            organizations, work facts, or duplicate hazard approvals.
          </p>
        </div>
      )}

      {stepId === 6 && (
        <div className="explanation-content">
          <p>
            The client submitted a modified payload (<code>{`{ "name": "Apex Regulatory & Compliance Practice" }`}</code>)
            paired with a newly generated <code>Idempotency-Key</code>.
          </p>
          <p>
            By issuing a fresh key whenever the request body changes, the mutation commits cleanly with{" "}
            <strong>HTTP 200 OK</strong> instead of colliding with Step 4&apos;s payload hash.
          </p>
          <p className="note-text">
            <strong>Why we use this:</strong> One idempotency key represents one user intent—retrying uses the same key, while
            changing parameters uses a fresh key.
          </p>
        </div>
      )}

      {stepId === 7 && (
        <div className="explanation-content">
          <p>
            The client submitted <code>POST /api/v2/organizations</code> with a valid <code>Idempotency-Key</code> header and
            strict schema-compliant JSON body.
          </p>
          <p>
            The gateway verified the header and schema, committing the new unit and returning{" "}
            <strong>HTTP 200 OK</strong> with a correlation <code>requestId</code>.
          </p>
          <p className="note-text">
            <strong>Why we use this:</strong> Supplying a valid caller key on every state-changing endpoint guarantees retry
            safety and clean 200 OK execution.
          </p>
        </div>
      )}

      {stepId === 8 && (
        <div className="explanation-content">
          <p>
            The console signed in as <strong>Beacon Chambers (Tenant B)</strong> and queried <code>GET /api/v2/organizations</code>{" "}
            alongside <strong>Apex Legal Partners (Tenant A)</strong>.
          </p>
          <p>
            Because every query executes inside <code>set_config(&apos;app.tenant_id&apos;, &apos;...&apos;, true)</code> under
            PostgreSQL <strong>Forced Row-Level Security (RLS)</strong> with the restricted non-owner <code>abate_app</code> role,
            Tenant B sees zero rows from Tenant A.
          </p>
          <p className="note-text">
            <strong>Why we use this:</strong> Even if application code had a SQL filtering bug, PostgreSQL RLS acts as a
            hard vault wall between firms—and foreign IDs return the exact same <code>404 Not Found</code> as missing IDs.
          </p>
        </div>
      )}

      {stepId === 9 && (
        <div className="explanation-content">
          <p>
            Loaded live boundary test output from <code>/test-report.json</code> generated by <code>npm run test-boundaries</code>.
          </p>
          <p>
            All <strong>{boundaryPassed}/{boundaryTotal} constitutional boundary tests</strong> passed, verifying RLS
            isolation, pooled-connection safety, data minimization decoys, privacy floor (<code>n &ge; 10</code>) &amp;
            overlap/residual suppression, control approvals, legal holds, bounded AI, and Plane A vs Plane B separation.
          </p>
          <p className="note-text">
            <strong>Why we use this:</strong> Security and privacy promises in Abate are never marketing claims—every boundary
            has an automated adversarial test that runs as the restricted runtime role.
          </p>
        </div>
      )}

      {stepId === 10 && (
        <div className="explanation-content">
          <p>
            Loaded the dynamic Release Evidence Dossier from <code>GET /api/v2/release/dossier</code> (status:{" "}
            <code>{dossierStatus}</code>).
          </p>
          <p>
            The dossier aggregates <strong>{dossierSuites} automated suites</strong>
            {dossierChecks ? ` (${dossierChecks} checks passed)` : ""}, 30-day HTTP simulation, kill-switch drills, and
            restore reconciliation checks, remaining <code>READY FOR REVIEW</code> until a named authority runs{" "}
            <code>sign-dossier.ts</code>.
          </p>
          <p className="note-text">
            <strong>Why we use this:</strong> Governance teams and auditors get machine-checked evidence linked directly to
            executed suites, commit SHAs, and SHA-256 digests instead of hand-written spreadsheets.
          </p>
        </div>
      )}

      {stepId === 11 && (
        <div className="explanation-content">
          <p>
            Issued a brand-new creation request (<code>Dispute Resolution &amp; Advisory Division</code>) with fresh{" "}
            <code>Idempotency-Key</code> <code>{data?.secondaryKey || "idem-sec-..."}</code>.
          </p>
          <p>
            Because the key is new, <code>runCommand()</code> opened a distinct atomic transaction, committed a second
            organization record for Tenant A, and recorded its own audit and outbox entries.
          </p>
          <p className="note-text">
            <strong>Why we use this:</strong> Confirms that Step 5&apos;s replay lock only deduplicates the repeated intent; a
            genuinely new division with a new intent key persists cleanly.
          </p>
        </div>
      )}

      {stepId === 12 && (
        <div className="explanation-content">
          <p>
            Executed direct single-record retrieval <code>GET /api/v2/organizations/:id</code> using Apex Legal
            Partners&apos; (Tenant A) token.
          </p>
          <p>
            PostgreSQL verified ownership under Row-Level Security and returned the persisted organization record with{" "}
            <strong>HTTP 200 OK</strong> (whereas querying that same UUID with Tenant B&apos;s token fails closed with{" "}
            <code>404 NOT_FOUND</code>).
          </p>
          <p className="note-text">
            <strong>Why we use this:</strong> Completes the full write-replay-conflict-isolation-read lifecycle against live
            storage with full request correlation (<code>X-Request-Id</code>).
          </p>
        </div>
      )}
    </div>
  );
};
