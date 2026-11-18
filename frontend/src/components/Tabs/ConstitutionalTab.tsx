// frontend/src/components/Tabs/ConstitutionalTab.tsx
import type { SystemHealth, SystemInfo } from "../../api/client";

interface ConstitutionalTabProps {
  health: SystemHealth | null;
  info: SystemInfo | null;
}

export function ConstitutionalTab({ health, info }: ConstitutionalTabProps) {
  return (
    <div className="tab-pane">
      <div className="card hero-banner">
        <h2>Zoiko Abate Core Mission & Architecture Baseline</h2>
        <p className="lead">
          Sector-neutral organizational work-design and psychosocial-risk infrastructure for regulated knowledge-work teams (UK Legal Sector Pack active today).
          Abate measures work conditions at cohort level (never individuals), helps companies identify hazards, review organizational causes, approve controls, and compile independently checkable evidence packages.
        </p>
        <div className="tagline-quote">
          &ldquo;Change the work. Not the worker.&rdquo;
        </div>
        {health && (
          <div className="text-sm monospace" style={{ marginTop: "0.5rem", color: "var(--muted-text)" }}>
            Connected to {health.app} (v{health.version}) &bull; Environment: {health.environment}
            {info?.description ? ` &bull; ${info.description}` : ""}
          </div>
        )}
      </div>

      <div className="grid-2col">
        <div className="card">
          <div className="card-header">
            <h3>Non-Negotiable Constitutional Boundaries</h3>
            <span className="badge badge-success">ENFORCED</span>
          </div>
          <p className="card-desc">Every layer of the system fails closed if any of these rules are breached:</p>
          <ul className="rule-list">
            <li>
              <strong>1. No Individual Scoring:</strong> Zero individual psychosocial, mental-health, performance, or employability scores. No worker ranking; no automated individual employment decisions.
            </li>
            <li>
              <strong>2. No Surveillance or Keystrokes:</strong> No screenshots, keystroke logging, URLs, application names, email contents, substantive work product, or emotion recognition.
            </li>
            <li>
              <strong>3. No Clinical Path in v1.0:</strong> No clinical screening, diagnostic treatment, therapeutic chat, or private Vault dependencies (ZAB-ARCH-001 governs).
            </li>
            <li>
              <strong>4. Zero Model Training on Workforce Data:</strong> No general model training on identifiable customer data. No customer-admin or support bypass of Privacy Release.
            </li>
            <li>
              <strong>5. Privacy Release Gate (n &ge; 10):</strong> Aggregate cohort release requires &ge; 10 distinct eligible contributors and overlap protection.
            </li>
            <li>
              <strong>6. Bounded AI (Proposal Only):</strong> AI output is strictly a proposal (explain and draft). Every workflow completes with AI disabled.
            </li>
          </ul>
        </div>

        <div className="card">
          <div className="card-header">
            <h3>The Two Value Planes</h3>
            <span className="badge badge-aubergine">NEVER MIX</span>
          </div>
          <div className="plane-box plane-a">
            <h4>Plane A: Risk Assurance</h4>
            <p><strong>Question:</strong> What work condition creates risk, what control was put in place, what evidence supports the outcome?</p>
            <div className="chain-badge">Hazard &rarr; Cause &rarr; Control &rarr; Owner &rarr; Action &rarr; Verification &rarr; Evidence Package</div>
          </div>

          <div className="plane-box plane-b">
            <h4>Plane B: Work-Design Outcomes</h4>
            <p><strong>Question:</strong> Did organizational conditions actually improve after the intervention?</p>
            <div className="chain-badge">Outcome Snapshots &rarr; Comparison Basis &rarr; Uncertainty &rarr; Permitted Claims</div>
          </div>

          <div className="callout-alert">
            <strong>Hard Rule:</strong> Plane B can <em>never</em> change, close, or downgrade a Plane A obligation. Faster work or superior financials is not evidence a hazard is controlled. A named human must assess verification evidence.
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>The Twelve Core Domains (S01 &ndash; S12)</h3>
          <a
            href="/api/v2/contracts/openapi.json"
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary btn-sm"
          >
            OpenAPI 3.1 Contract Registry &rarr;
          </a>
        </div>
        <div className="domains-grid">
          <div className="domain-item active">
            <span className="domain-code">S01</span>
            <div className="domain-name">Tenant & Organization</div>
            <div className="domain-desc">Identity, effective memberships, forced RLS, tenant-local context.</div>
            <span className="status-pill status-live">ACTIVE (Phase 1)</span>
          </div>
          <div className="domain-item">
            <span className="domain-code">S02 / S03</span>
            <div className="domain-name">Ingestion & Work Ledger</div>
            <div className="domain-desc">Allowlisted connectors, minimized receipts, canonical revisions.</div>
            <span className="status-pill">Phase 2</span>
          </div>
          <div className="domain-item">
            <span className="domain-code">S04 / S06</span>
            <div className="domain-name">Measurement & Privacy Release</div>
            <div className="domain-desc">Protected computation; n&ge;10 gate, overlap suppression, channel parity.</div>
            <span className="status-pill">Phase 3</span>
          </div>
          <div className="domain-item">
            <span className="domain-code">S05 / S07</span>
            <div className="domain-name">Hazards & Interventions</div>
            <div className="domain-desc">Reviewed causes, version-bound approvals, verified evidence packages.</div>
            <span className="status-pill">Phase 4</span>
          </div>
          <div className="domain-item">
            <span className="domain-code">S08 / S09</span>
            <div className="domain-name">AI & Safe Action Execution</div>
            <div className="domain-desc">Bounded AI proposals, typed catalogs, independent kill-switches.</div>
            <span className="status-pill">Phase 6</span>
          </div>
          <div className="domain-item">
            <span className="domain-code">S10</span>
            <div className="domain-name">Governance &amp; Jurisdiction</div>
            <div className="domain-desc">Jurisdiction &amp; sector policy packs, evidence manifests, cryptographic hashes.</div>
            <span className="status-pill">Phase 5</span>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: "1.25rem" }}>
        <div className="card-header">
          <h3>Why Abate Exists &amp; Plain-English Phase Guide (Phases 0&ndash;8)</h3>
          <span className="badge badge-aubergine">SYSTEM OVERVIEW</span>
        </div>
        <p className="card-desc">
          Employers often either ignore psychosocial workload risk (burnout, attrition, regulatory liability) or deploy
          invasive monitoring (&ldquo;bossware&rdquo; screenshots, keystrokes, personal scores) that damages trust and violates privacy law.
          Abate solves this by redesigning work patterns at cohort level while making surveillance technically impossible.
        </p>
        <ul className="rule-list">
          <li><strong>Phase 0 &ndash; Foundation:</strong> Separates database roles (<code>abate_migrator</code> vs restricted <code>abate_app</code>), seeds synthetic fixtures (Apex Legal Partners &amp; Beacon Chambers), and freezes OpenAPI contracts. <em>Why:</em> Prevents privilege mistakes and environment drift before any business data exists.</li>
          <li><strong>Phase 1 &ndash; Tenancy, RLS &amp; Command Pipeline:</strong> Enforces PostgreSQL Forced Row-Level Security per transaction (<code>withTenant</code>) and atomic <code>runCommand</code> (idempotency + audit + outbox). <em>Why:</em> Guarantees Firm A can never see Firm B and retries never duplicate records.</li>
          <li><strong>Phase 2 &ndash; Ingestion &amp; Work Ledger:</strong> Validates ZoikoTime and CalendarCadence batches with strict <code>.strict()</code> schemas, rejects forbidden decoys, derives HMAC pseudonyms, and tracks STALE feeds. <em>Why:</em> Blocks surveillance fields before storage and ensures outages show &ldquo;stale,&rdquo; never fake &ldquo;zero risk.&rdquo;</li>
          <li><strong>Phase 3 &ndash; Deterministic Measurement &amp; Privacy Release:</strong> Computes interval math without double-counting and gates every export/UI/AI channel through <code>n &ge; 10</code> contributors, overlap (&ge; 5), and residual (&ge; 5) checks. <em>Why:</em> Stops differential reconstruction attacks that isolate individuals across overlapping cohorts.</li>
          <li><strong>Phase 4 &ndash; Hazards, Controls &amp; Verification:</strong> Separates organizational causes, control lifecycle, version-bound approvals (<code>If-Match</code> + <code>materialHash</code>), and verification outcomes (<code>EFFECTIVE</code> vs <code>TRANSFER_OF_RISK</code>). <em>Why:</em> Completing a checklist task never counts as closing a risk until verified.</li>
          <li><strong>Phase 5 &ndash; Jurisdiction Packs, Evidence &amp; Lifecycle:</strong> Keeps cloud region, legal jurisdiction, and billing entitlements separate; adds SHA-256/Merkle verification, legal holds, and anti-resurrection deletion tombstones across restores. <em>Why:</em> Makes compliance portable across legal systems without losing deleted-data proofs on backup restore.</li>
          <li><strong>Phase 6 &ndash; Bounded AI &amp; Safe Actions:</strong> Runs proposal-only AI behind released-evidence retrieval, output validators, and 5 kill switches. <em>Why:</em> AI can explain or draft, never hallucinate numbers or execute silent approvals; full manual mode works with AI off.</li>
          <li><strong>Phase 7 &ndash; Outcomes &amp; AI-Change Assurance (Plane B):</strong> Measures workload sustainability, role clarity, fragmentation, and AI rework behind disabled-by-default flags and SQL triggers blocking Plane B from closing Plane A hazards. <em>Why:</em> Higher productivity never overrules open safety obligations.</li>
          <li><strong>Phase 8 &ndash; Operations, Support &amp; Release Dossier:</strong> Provides zero-impersonation diagnostic receipts, live SLO targets, measured load/restore drills, and a hash-bound dossier waiting for named human sign-off. <em>Why:</em> Shipping decisions rest on executed proof, never undocumented promises.</li>
        </ul>
      </div>
    </div>
  );
}
