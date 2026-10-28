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
          Organizational work-design and psychosocial-risk infrastructure for legal services. 
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
              <strong>2. No Surveillance or Keystrokes:</strong> No screenshots, keystroke logging, URLs, application names, email contents, legal work product, or emotion recognition.
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
            href="http://localhost:5000/api/v2/contracts/openapi.json" 
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
            <div className="domain-name">Governance & Jurisdiction</div>
            <div className="domain-desc">Legal sector policy packs, evidence manifests, cryptographic hashes.</div>
            <span className="status-pill">Phase 5</span>
          </div>
        </div>
      </div>
    </div>
  );
}
