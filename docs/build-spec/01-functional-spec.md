# 01 — Functional specification

What the application does, for whom, and by what rules. This document is the contract between the
product and the build; documents 02–04 say how to construct it.

---

## 1. Purpose, audiences and front doors

ADPM is a locally hostable, enterprise-grade, **industry-agnostic** web application for managing the
full lifecycle of data products with AI agents doing the work and humans making every decision.

Three audiences, three front doors. They are never blended into one navigation list.

| Door | Who | Entry point | What they do |
|---|---|---|---|
| **Consumer** | Business user, analyst, executive | Marketplace → Request | Search published products in business language; when nothing answers the question, describe the decision they cannot make today |
| **Practitioner** | Owner, steward, SME, architect, engineer, privacy officer, semantic steward, council | My Work → Lifecycle Studio | Move approved requests through the twelve stages, produce artifacts, review agent proposals, cast gate decisions |
| **Leadership** | CDO, domain lead, portfolio director | Portfolio | Decide what to build next, what it costs, what it returned, and how mature the capability is |

Two supporting surfaces: **Enable** (consumption patterns, agent run console, agents, academy, data
model) and **Run** (admin).

The application is also a teaching instrument and a client-ready demo asset. It ships pre-populated
with a cross-industry marketplace so the first screen a stakeholder sees is credible, not empty.

**Scope boundary — what ADPM is not.** It does not move data, run pipelines, connect to a warehouse,
or execute queries against source systems. It designs, governs and documents data products; the
client's existing platform builds them. The only data it ingests is (a) artifact content typed or
proposed inside the application, (b) an optional CSV extract uploaded for local profiling, and
(c) optional metadata exports from modelling and catalogue tools. There is no live connector to any
external system. Design accordingly: this is a governance application, not a data platform.

---

## 2. The eleven invariants

These are the acceptance criteria for the whole build. Violating one is a defect regardless of what
else works. Each must have a named automated test.

| # | Invariant | Enforcement point | Test |
|---|---|---|---|
| 1 | **Consumption-first.** No data product exists without a named consumer persona, a named decision blocked today, and the questions that consumer would ask. Stage 2 is hard-blocked until Stage 1 has at least one complete decision record. | Stage 1 and Stage 2 exit criteria | `criteria.test.ts` |
| 2 | **One approval path.** `recordDecision()` is the only code path that can move a gate to `APPROVED`. No API route, service, seed script, agent or admin action may set that state directly. | Transition engine | `gate-engine.test.ts` |
| 3 | **Immutability.** Artifact versions are content-hashed and append-only. Audit events and agent actions are append-only. Nothing is hard-deleted; use `archivedAt`. | Commit path, audit writer | `roundtrip.test.ts` |
| 4 | **Cascade honesty.** Committing a new version of an artifact an approved downstream gate relied on flips those gates to `STALE` and raises re-approval tasks. | Cascade on commit | `lifecycle.test.ts` |
| 5 | **Human in the loop, structurally.** Every agent output is persisted as a proposal with field-level provenance. An artifact cannot be submitted for review while any field remains unreviewed agent output. | Named exit criterion, not a UI convention | `agent-guardrails.test.ts` |
| 6 | **Agent accountability.** Every agent invocation writes an action recording agent id, trigger, declared read scope, input hash, model, token count, estimated cost, output and human disposition. An agent that cannot be audited cannot run. | Agent runtime | `agent-guardrails.test.ts` |
| 7 | **Grounding purity.** Conversational and agentic consumption artifacts may reference only certified semantic-layer objects. Any grounding artifact referencing a physical Bronze or Silver table is rejected by the validator. No free-form text-to-SQL against raw tables, ever. | Stage 10 exit criterion + schema validator | `criteria.test.ts` |
| 8 | **Evidence over assertion.** Certification scores cite specific artifact versions and approvals. Free-text justification alone never clears a certification dimension. | Stage 11 exit criteria | `criteria.test.ts` |
| 9 | **Value closes the loop.** Every product carries a value hypothesis from Stage 2 to a measured outcome at Stage 12. A product may be published without realised value; it may not be published without a stated, measurable hypothesis. | Stage 2 and Stage 12 exit criteria | `criteria.test.ts` |
| 10 | **Roles enforced server-side.** Client-side role checks are a convenience, never a control. | Every mutation | `lifecycle.test.ts` |
| 11 | **Industry logic lives in packs.** No industry name, domain, regulation or entity may be hard-coded in application code. | Pack loader and validator | `packs.test.ts` |

**The autonomy rule, stated once.** Agents research, profile, draft, cross-check, critique, monitor
and escalate. They produce proposals, findings and alerts. They never approve a gate, never commit
an artifact version, never publish, and never satisfy an exit criterion on their own authority.
There is no configuration, autonomy level, admin override or trusted mode that changes this. A
request for one is a defect report, not a feature request.

---

## 3. Roles

Eleven roles. Approval and veto rights are **not** properties of the role — they live in the stage
registry (§4), so the RACI matrix rendered to users is computed from the same data the engine
enforces and cannot drift from it.

| Key | Name | Door | Owns |
|---|---|---|---|
| `DATA_CONSUMER` | Data Consumer | Consumer | Requests, feedback, ratings, access requests |
| `DOMAIN_PRODUCT_OWNER` | Domain Product Owner | Practitioner | Triage, charter, value case, roadmap position |
| `DATA_STEWARD` | Data Steward | Practitioner | Attribute definitions, classification, quality rules, glossary |
| `DOMAIN_SME` | Domain SME | Practitioner | Business meaning, decision context, source truth, metric semantics |
| `DATA_ARCHITECT` | Data Architect | Practitioner | Model, grain, keys, identity resolution, physical architecture |
| `DATA_ENGINEER` | Data / Platform Engineer | Practitioner | Ingestion, transformation, orchestration, serving |
| `PRIVACY_SECURITY_OFFICER` | Privacy & Security Officer | Practitioner | Classification completeness, access policy, regulatory mapping |
| `SEMANTIC_STEWARD` | Semantic Steward | Practitioner | Certified metrics, name uniqueness, grounding pack integrity |
| `GOVERNANCE_COUNCIL` | Governance Council | Practitioner | Certification, publication, retirement |
| `PORTFOLIO_LEAD` | Portfolio Lead / CDO | Leadership | Prioritisation, capacity, spend, value realisation |
| `ADMIN` | Admin | Admin | Packs, role assignment, controls, agent settings, exports |

Rules:

- A user holds a role **within a workspace**, optionally narrowed to one domain
  (`RoleAssignment.domainId`). A user may hold several roles.
- Only `DOMAIN_PRODUCT_OWNER` may triage a product request.
- Only `ADMIN` may change workspace configuration, packs, agent settings or model assignments.
- Authorisation is resolved server-side on every mutation from `RoleAssignment`, never from the
  session claim alone, and never from the client. **[BUILT]** `src/lib/auth/authorise.ts`
- In a client deployment, role assignment should be driven from IdP group membership (02 §5.4).
  The mapping is configuration, not code.

---

## 4. The twelve stages

The stage registry is **data**. Adding, reordering or re-scoping a stage must not require touching
the transition engine. **[BUILT]** `src/lib/lifecycle/stages.ts`

| # | Key | Name | Purpose | Required artifacts | Approvers | Quorum | Veto |
|---|---|---|---|---|---|---|---|
| 1 | `consumption-discovery` | Consumption Discovery | Name the consumer, the decision they cannot make today, and the questions they would ask | `decision-register` | Owner, SME | 2 | — |
| 2 | `charter-value-case` | Charter & Value Case | Fix the scope boundary and commit to a measurable value hypothesis | `charter`, `value-case` | Owner, Council | 2 | Owner |
| 3 | `source-discovery-profiling` | Source Discovery & Profiling | Find the sources, designate the system of record, see the data as it actually is | `source-inventory`, `profile-report`, `gap-log` | Architect, Steward | 2 | — |
| 4 | `conceptual-logical-model` | Conceptual & Logical Model | State the grain, entities, keys and identity resolution | `logical-model`, `er-diagram` | Architect, SME | 2 | Architect |
| 5 | `attribute-register-contract` | Attribute Register & Data Contract | Define every attribute and turn definitions into a contract with SLAs | `attribute-register`, `data-contract` | Steward, SME, Owner | 3 | Steward |
| 6 | `semantic-model-metrics` | Semantic Model & Metrics | Define each metric once and prove it answers a question someone asked | `semantic-model` | Semantic Steward, SME | 2 | Semantic Steward |
| 7 | `physical-architecture` | Physical Architecture | Map the design onto a platform without letting the platform dictate the design | `physical-architecture`, `lineage-diagram` | Architect, Engineer | 2 | Architect |
| 8 | `quality-observability` | Quality & Observability | Bind quality rules to attributes and reconcile them with the contract | `quality-rules`, `runbook` | Steward, Engineer | 2 | Steward |
| 9 | `access-governance` | Access & Governance | Classify everything, decide who may see what and why, map the regulations | `access-policy`, `regulatory-map` | Privacy Officer, Owner | 2 | Privacy Officer |
| 10 | `serving-consumption` | Serving & Consumption | Make the product consumable — and safely groundable for agents | `serving-spec`, `marketplace-listing`, `grounding-pack` | Semantic Steward, Owner | 2 | Semantic Steward |
| 11 | `certification-publication` | Certification & Publication | Score DATSIS+V against cited evidence and publish | `certification-scorecard` | Council, Owner | 2 | Council |
| 12 | `operate-evolve-retire` | Operate, Evolve & Retire | Measure what it returned, absorb change honestly, retire it when it stops earning its place | `telemetry`, `feedback-log`, `change-requests`, `benefit-realisation` | Owner | 1 | Council |

**Quorum** is the number of distinct approving role-holders required. **Veto** roles can reject
unilaterally regardless of quorum. A single user holding two approver roles counts once per role,
and the implementation must prevent one person satisfying a quorum of two by casting twice under
different roles unless the client explicitly accepts that (see 09 §6, open question OQ-3).

### 4.1 Exit criteria

Each stage carries machine-evaluated exit criteria. A gate cannot open until all pass. Criteria are
functions over the stage context (committed artifacts, approved upstream stages, provenance,
comments), not free text. **[BUILT]** `src/lib/lifecycle/criteria.ts`

Universal criteria applied to every stage:

- `artifacts-committed` — every required artifact for the stage is committed.
- `no-unreviewed-agent-fields` — no field in any of those artifacts is still unreviewed agent
  output, and no proposal is still awaiting disposition (invariant 5).

A third criterion, `comments-resolved`, is **advisory**: unresolved review comments are surfaced to
the approver but do not block the gate. That is a deliberate choice — a blocking comment thread
becomes a way to stall a decision without taking one. If a client wants it to block, it is a
one-line change in the stage registry, and it should be their explicit decision.

Stage-specific criteria, by name:

| Stage | Criteria |
|---|---|
| 1 | `one-complete-decision` (≥1 decision record with ≥3 questions), `named-persona` (not "the business"), `workaround-stated` |
| 2 | `stage-1-approved`, `out-of-scope-declared`, `measurable-hypothesis` (baseline, unit, expected change, method, date), `target-patterns-known` |
| 3 | `system-of-record` (exactly one source designated), `sources-profiled`, `severe-gaps-owned` (every severe gap has an owner and a decision) |
| 4 | `grain-stated`, `entities-keyed`, `identity-resolution-justified`, `backbone-bound` (bound to the pack's conformed backbone), `er-generated` |
| 5 | `definitions-written` (every attribute has a definition, not a name restated), `lineage-recorded`, `contract-matches-register`, `slas-stated` |
| 6 | `metrics-traced` (every metric traces to a Stage 1 question), `metric-names-unique` (workspace-wide), `metric-grain-stated` |
| 7 | `platform-profile`, `attributes-layered`, `gold-layer-populated`, `lineage-generated` |
| 8 | `rules-bound-to-attributes`, `contract-reconciled`, `core-dimensions-covered`, `runbook-actionable` |
| 9 | `every-attribute-classified`, `sensitive-attributes-protected`, `controls-from-library` (controls come from the pack, not free text), `retention-and-residency` |
| 10 | `grounding-purity` (invariant 7), `grounded-metrics-certified`, `refusal-guidance`, `listing-complete`, `patterns-known` |
| 11 | `all-dimensions-scored`, `every-dimension-cited`, `citations-resolve` (each citation resolves to a real artifact version or approval), `upstream-approved` |
| 12 | `published`, `benefit-measured-against-hypothesis`, `value-state-declared`, `telemetry-recorded` |

### 4.2 Stage run and gate state machine

```
                    SUBMIT_FOR_REVIEW            OPEN_GATE
   StageRun: DRAFT ──────────────────► IN_REVIEW ──────────► GATE_OPEN
                 ▲                          │                    │
                 │      REQUEST_CHANGES     │                    │ recordDecision()
                 └──────────────────────────┘                    ▼
                                                     ┌──── APPROVED  (Gate.state = APPROVED)
                                                     └──── REJECTED  (new attempt opens)
```

- `Gate.state`: `PENDING → OPEN → APPROVED | REJECTED`, plus `STALE` reachable from `APPROVED` only
  by cascade invalidation (invariant 4).
- `OPEN_GATE` is refused unless every exit criterion passes.
- On approval the engine advances `DataProduct.currentStage`, writes `GateEvidence` pinning the
  content hash of every artifact the gate relied on, closes the stage run, and emits an audit event.
- On rejection the stage run closes and a fresh attempt opens; history is a sequence of attempts,
  never an edited row.
- Publication (`status = PUBLISHED`) happens on approval of Stage 11, never independently.

**Transition actions:** `SUBMIT_FOR_REVIEW`, `REQUEST_CHANGES`, `WITHDRAW_TO_DRAFT`, `OPEN_GATE`.
**[BUILT]** `src/lib/lifecycle/transitions.ts`

### 4.3 Cascade invalidation

When a new artifact version is committed, every `APPROVED` gate whose `GateEvidence` recorded a
different content hash for that artifact flips to `STALE` with a reason, and a `RE_APPROVAL` task is
raised for its approver roles. Downstream approvals decay when the evidence beneath them changes.
A stale gate does not un-publish a product; it marks the approval as needing renewal and surfaces on
the owner's inbox. **[BUILT]** `src/lib/lifecycle/cascade.ts`

---

## 5. Artifacts

Twenty-five artifact types, each with one Zod schema shared by the server action and the form, a
canonical file name and a serialisation format. Versions are content-hashed, immutable and mirrored
to a git-friendly directory for diffing (the mirror is a convenience, never a system of record).

| Stage | Key | File | Format |
|---|---|---|---|
| 1 | `decision-register` | `decision-register.yaml` | YAML |
| 2 | `charter` | `charter.yaml` | YAML |
| 2 | `value-case` | `value-case.yaml` | YAML |
| 3 | `source-inventory` | `source-inventory.yaml` | YAML |
| 3 | `profile-report` | `profile-report.json` | JSON |
| 3 | `gap-log` | `gap-log.yaml` | YAML |
| 4 | `logical-model` | `logical-model.yaml` | YAML |
| 4 | `er-diagram` | `er.mermaid` | Mermaid |
| 5 | `attribute-register` | `attribute-register.yaml` | YAML |
| 5 | `data-contract` | `data-contract.yaml` | YAML |
| 6 | `semantic-model` | `semantic-model.yaml` | YAML |
| 7 | `physical-architecture` | `physical-architecture.yaml` | YAML |
| 7 | `lineage-diagram` | `lineage.mermaid` | Mermaid |
| 8 | `quality-rules` | `quality-rules.yaml` | YAML |
| 8 | `runbook` | `runbook.md` | Markdown |
| 9 | `access-policy` | `access-policy.yaml` | YAML |
| 9 | `regulatory-map` | `regulatory-map.yaml` | YAML |
| 10 | `serving-spec` | `serving-spec.yaml` | YAML |
| 10 | `marketplace-listing` | `marketplace-listing.json` | JSON |
| 10 | `grounding-pack` | `grounding-pack.json` | JSON |
| 11 | `certification-scorecard` | `certification-scorecard.yaml` | YAML |
| 12 | `telemetry` | `telemetry.json` | JSON |
| 12 | `feedback-log` | `feedback-log.yaml` | YAML |
| 12 | `change-requests` | `change-requests.yaml` | YAML |
| 12 | `benefit-realisation` | `benefit-realisation.yaml` | YAML |

**Commit semantics.** A commit canonicalises the content (stable key order, undefined dropped),
hashes it, and appends a version row with the author, message and mirror path. Committing content
identical to the current version is a no-op, not a new version. Field-level provenance rows are
written alongside. **[BUILT]** `src/lib/artifacts/commit.ts`

**Certification dimensions (Stage 11):** DATSIS+V — Discoverable, Addressable, Trustworthy,
Self-describing, Interoperable, Secure, Valuable. Each dimension carries a score and at least one
citation to an artifact version or an approval (invariant 8).

---

## 6. Agents

Fourteen chartered agents. The registry is data: id, charter, permitted stages, read scope,
external-metadata scope, output type, autonomy ceiling, escalation rule, sample-data appetite and
prompt template. **[BUILT]** `src/lib/agents/registry.ts`

| Agent | Stage | Ceiling | Reads |
|---|---|---|---|
| `discovery` | 1 | L2 | decision-register |
| `curator` | 1 | L3 | decision-register, charter, marketplace-listing, semantic-model |
| `charter` | 2 | L2 | decision-register, charter, value-case |
| `profiling` | 3 | L2 | source-inventory, profile-report, gap-log |
| `modelling` | 4 | L2 | source-inventory, profile-report, decision-register, logical-model |
| `definition` | 5 | L2 | logical-model, source-inventory, attribute-register, profile-report |
| `semantic` | 6 | L2 | decision-register, attribute-register, logical-model, semantic-model |
| `architecture` | 7 | L2 | logical-model, data-contract, source-inventory, semantic-model, physical-architecture |
| `quality` | 8 | L2 | attribute-register, data-contract, profile-report, quality-rules |
| `compliance` | 9 | L2 | attribute-register, access-policy, regulatory-map, logical-model |
| `grounding` | 10 | L2 | semantic-model, decision-register, grounding-pack, physical-architecture |
| `evidence` | 11 | L2 | certification-scorecard |
| `steward` | 12 | L3 | telemetry, quality-rules, data-contract, feedback-log |
| `critic` | all | L2 | 21 artifact types (adversarial review against exit criteria) |

**Autonomy levels.** L0 disabled · L1 invoked explicitly by a human · L2 may be triggered on stage
entry · L3 may run on a schedule (monitoring only). The registry sets a ceiling; the per-workspace
`AgentSetting` may only lower it. No level permits approving a gate, committing a version, publishing
or satisfying an exit criterion.

**Invocation contract.** Every invocation: resolve effective autonomy → check the workspace budget →
assemble context strictly from the declared read scope → redact by policy → call the provider →
persist an `AgentAction` with scope, input hash, model, tokens, cost, duration and output → persist
each proposal as an `AgentProposal` in `PENDING` → increment workspace spend. Accepting a proposal
writes the value and its provenance together in one transaction.

**Providers.** `local-heuristic` (deterministic, no network call, the default — the whole lifecycle
is demonstrable offline) and a model provider. Model catalogue is data: Claude Opus 5 (frontier),
Claude Sonnet 5 (default working model), Claude Haiku 4.5 (high-frequency monitoring), with per-level
defaults L1/L2 → Sonnet, L3/L0 → Haiku. Cost is estimated from the catalogue's per-million token
prices and recorded on every action. See [08](08-agents-llm.md) for the full runtime spec and
per-cloud model access.

---

## 7. Consumption patterns

Eight named ways a product is consumed. A product declares which it targets; readiness is
**computed**, never asserted — green when every required artifact is committed and its stage gate is
approved, amber when drafted, red when absent. **[BUILT]** `src/lib/patterns/registry.ts`

| Key | Name | Requires |
|---|---|---|
| `certified-dashboard` | Certified dashboard (BI) | semantic-model, serving-spec, access-policy |
| `self-serve-exploration` | Self-serve exploration | semantic-model, data-contract, access-policy |
| `conversational` | Conversational (natural language) | grounding-pack, semantic-model |
| `agentic-tool-calling` | Agentic / tool-calling | grounding-pack, serving-spec, access-policy |
| `api-embedded` | API / embedded application | serving-spec, data-contract |
| `bulk-extract` | Bulk extract / file | data-contract, access-policy |
| `ml-feature` | ML feature consumption | attribute-register, physical-architecture, data-contract |
| `operational-activation` | Operational activation | data-contract, access-policy, quality-rules |

The conversational and agentic patterns are where invariant 7 bites: their grounding pack may
reference only certified semantic-layer objects, never a physical Bronze or Silver table.

---

## 8. Packs — industry configuration as data

A pack is declarative YAML validated on load and in CI. It supplies domains, a conformed backbone,
canonical entities, controls, starter metrics, sample decisions, platform profiles, glossary and
seed products. Nine ship: `_generic`, banking, healthcare, insurance, manufacturing, public-sector,
retail-cpg, telecom, utility-energy. **[BUILT]** `src/lib/packs/schema.ts`, `packs/*.yaml`

Minimum content enforced by the validator: ≥6 domains, ≥4 backbone entities, ≥10 canonical entities,
≥8 controls, ≥10 starter metrics, ≥3 sample decisions, ≥1 platform profile, ≥3 seed products.
Referential validation: every seed product's domain, platform profile and controls must exist in the
same pack.

Packs are **illustrative and editable, not authoritative** — the UI says so on every pack screen. A
client engagement typically starts by cloning the nearest pack and replacing its content with the
client's own domains, controls and vocabulary. That is a data task (04 §5), not a code change.

---

## 9. Portfolio

- **Prioritisation:** WSJF-with-reuse (default) or RICE, computed from value, time criticality,
  risk reduction, reuse potential and effort. A leader may override the computed score, but only
  with a stated reason; both scores stay visible. **[BUILT]** `src/lib/portfolio/scoring.ts`
- **Value:** every product carries a hypothesis (baseline, unit, expected change, method, due date)
  from Stage 2 and a measured outcome at Stage 12 with state `REALISED`, `NOT_REALISED` or
  `NOT_YET_MEASURABLE`. `NOT_REALISED` is a legitimate, reportable outcome.
- **Cost:** cost-to-serve per product plus agent spend per workspace.
- **Maturity:** six dimensions scored 1–5 with notes — consumption orientation, lifecycle
  discipline, semantic consistency, governance trust, platform automation, operating-model adoption.

---

## 10. Standards and exports

Interoperability adapters, each with an honest verification note. **[BUILT]** `src/lib/standards/`

| Adapter | Version | Direction |
|---|---|---|
| ODCS (Open Data Contract Standard) | v3.0.2 | Round-trip |
| ODPS (Open Data Product Specification) | v3.0 | Export |
| DCAT / DCAT-AP | DCAT 3 JSON-LD | Export |
| OpenLineage | 2-0-2 run event | Export |
| MetricFlow / dbt semantic manifest | v1 | Round-trip |
| schema.org Dataset | 27.x | Export |
| OpenMetadata / DataHub listing shape | listing shape | Export |

Document exports: evidence pack (DOCX), attribute register (XLSX round-trip), portfolio (XLSX),
maturity (XLSX), audit log (CSV), academy primer (PDF). All are route handlers, not server actions,
because they stream binary responses.

---

## 11. Screen inventory

| Route | Door | Purpose | Principal reads | Principal writes |
|---|---|---|---|---|
| `/signin` | — | Credential or IdP sign-in | User | Session |
| `/marketplace` | Consumer | Search published products by question, entity, metric | DataProduct, artifacts | — |
| `/marketplace/[key]` | Consumer | Listing assembled from committed artifacts; request access | Artifact versions, gates | AccessRequest |
| `/request/new` | Consumer | Intake wizard — decision, persona, questions, stakes, freshness | Packs | ProductRequest |
| `/request` `/request/[id]` | Consumer | My requests, conversation, triage outcome | ProductRequest, RequestMessage | RequestMessage |
| `/inbox` | Practitioner | Approvals due, reviews, agent proposals, stale gates, tasks | Task, Gate, AgentProposal | Task completion |
| `/products` | Practitioner | Product list with stage, status, owner | DataProduct | — |
| `/products/[id]` | Practitioner | Product overview, gates, versions, audit timeline | Product graph | — |
| `/products/[id]/stage/[stage]` | Practitioner | **The Lifecycle Studio** — why this stage matters, artifact editor, exit-criteria checklist, agent panel, review thread, diff, parking lot, gate panel, audit | Stage context | ArtifactVersion, Comment, Approval, transitions |
| `/portfolio` | Leadership | Pipeline, prioritisation, cost, adoption, value, maturity | Aggregates | PrioritisationOverride, MaturityAssessment |
| `/patterns` | Enable | Pattern registry and readiness matrix per product | Pattern bindings | — |
| `/run-console` | Enable | Dispatch agents across stages, automated or manual | AgentRun, steps | AgentRun, AgentRunStep |
| `/agents` | Enable | Charters, autonomy, model assignment, action log, cost | AgentAction | AgentSetting, ModelAssignment |
| `/academy` `/academy/[key]` | Enable | Teaching layer, guided tours, RACI computed from the registry | Registries | — |
| `/data-model` | Enable | The application's own persistence model, parsed from the schema | Schema file | — |
| `/admin` | Run | Packs, roles, controls, agent settings, configuration | Pack, RoleAssignment | Pack install, role assignment, settings |
| `/api/export/*` | — | DOCX / XLSX / CSV / PDF / standards exports | Product graph | — |
| `/api/health` | — | **[GAP]** Liveness plus database round-trip. Required by every managed platform | — | — |

---

## 12. Non-functional requirements

| Area | Requirement |
|---|---|
| **Accessibility** | Keyboard navigable, labelled inputs, visible focus, WCAG AA contrast. Tables use real `th`/`scope`; nothing is a `div` pretending to be a button |
| **Latency** | p95 < 800 ms for stage and marketplace pages at 100 products per workspace; exports may stream longer |
| **Concurrency** | Designed for tens of concurrent practitioners per workspace, not thousands. Sessions are stateless JWT, so instances scale horizontally |
| **Availability** | Single-region, business-hours critical. Target 99.5% monthly; no active-active requirement |
| **RPO / RTO** | RPO 15 minutes (point-in-time restore), RTO 4 hours. The database is the system of record; the artifact mirror needs no backup |
| **Retention** | Audit events, agent actions and artifact versions retained for the life of the engagement plus the client's contractual period. Never deleted, only archived |
| **Data residency** | All storage and all model inference in the client's chosen region. This constrains model choice (08 §6) |
| **Offline** | The application must remain fully functional with agents disabled and no egress. This is a hard requirement, not a fallback |
| **Localisation** | UK English throughout. No multi-language requirement in v1 |
| **Browser** | Evergreen Chrome, Edge, Safari, Firefox. No IE, no mobile-first requirement — practitioner screens are dense by design |
