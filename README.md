# Agentic Data Product Management (ADPM)

A locally hosted, industry-agnostic web application for managing the full lifecycle of data
products — from a business user's unmet decision need through design, certification, publication,
consumption and retirement.

> **Agents act. Humans decide.**
> Agents research, profile, draft, cross-check, critique and monitor. They produce proposals,
> findings and alerts. They never approve a gate, never commit an artifact version, never publish,
> and never satisfy an exit criterion on their own authority. There is no configuration, autonomy
> level or admin override that changes this.

---

## Five-minute quickstart

```bash
pnpm install          # installs dependencies, creates .env, generates the Prisma client
pnpm db:seed          # creates the SQLite database and seeds 9 workspaces, 73 certified products
pnpm dev              # http://localhost:3000
```

Needs Node 20.11+ and pnpm 10+.

- **[RUNNING.md](RUNNING.md)** — the step-by-step local guide: prerequisites, the seeded accounts,
  and a first walkthrough that takes a consumer request through triage, authoring, quorum,
  approval decay and veto.
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — the operational guide: production build, ports,
  the optional Postgres path, where secrets live, scheduled monitoring, backup and troubleshooting.
- **[docs/hosting-prerequisites.md](docs/hosting-prerequisites.md)** — **what has to change in the
  code before ADPM is hosted anywhere.** ADPM is local-first; most importantly there is no user
  management yet, so a hosted instance needs an identity boundary in front of it. Explicit about
  which gaps are deployment work and which are missing features.
- Cloud guides, all building on that one: **[AWS](docs/AWS.md)** · **[Azure](docs/AZURE.md)** ·
  **[GCP](docs/GCP.md)**.
- **[docs/screenshots/](docs/screenshots/)** — every tab and page captured against the seeded
  database, regenerable with `pnpm screenshots`.

Sign in with any seeded account and the password `adpm`:

| Email | Role | Lands on |
|---|---|---|
| `consumer@adpm.local` | Data Consumer | Marketplace |
| `owner@adpm.local` | Domain Product Owner | My Work |
| `steward@adpm.local` | Data Steward | My Work |
| `privacy@adpm.local` | Privacy & Security Officer | My Work |
| `cdo@adpm.local` | Portfolio Lead / CDO | Portfolio |
| `admin@adpm.local` | Admin | Admin |

The full list is on the sign-in screen.

**Nothing else is required.** No cloud service, no warehouse connection, no API key. Agents are
disabled by default and, where enabled, fall back to a deterministic local heuristic provider that
makes no network call at all.

### The seeded demo

`pnpm db:seed` drives every demo product through the **real** transition engine — the same
`requestTransition()` and `recordDecision()` calls the UI makes. If the engine is broken, the seed
fails. It produces:

- 9 workspaces, one per industry pack, with one user per role in each
- 73 data products, each certified and published through all 12 gates (876 approved gates) —
  every industry and domain combination the packs declare has at least one
- ~1,825 content-hashed artifact versions and ~6,350 append-only audit events
- A cross-industry marketplace, an intake queue with a breached triage target, a declined request
  with its reason visible to the requester, and an open change request

---

## What it does

### Three front doors, never blended

| Door | Who | Entry point |
|---|---|---|
| **Consumer** | Business user, analyst, executive | **Marketplace** → search, then **Request** if nothing answers the question |
| **Practitioner** | Product owner, steward, SME, architect, engineer, privacy officer | **My Work** → **Lifecycle Studio** |
| **Leadership** | CDO, domain lead, programme director | **Portfolio** |

### The eleven tabs

Marketplace · Request · My Work · Lifecycle Studio · Portfolio · Consumption Patterns ·
Agent Run Console · Agents · Academy · Data Model · Admin.

**Data Model** documents the application's own persistence model — every table, column, key,
relationship and enumeration behind ADPM, with a plain-language note on what each table is for and
which invariant it carries. Structure is parsed from `prisma/schema.prisma` at request time and the
entity-relationship diagrams are generated from it, so the page cannot drift from what the
application actually stores; a test fails if a table is added without a reading note.

### The twelve stages

1. Consumption Discovery · 2. Charter & Value Case · 3. Source Discovery & Profiling ·
4. Conceptual & Logical Model · 5. Attribute Register & Data Contract · 6. Semantic Model & Metrics ·
7. Physical Architecture · 8. Quality & Observability · 9. Access & Governance ·
10. Serving & Consumption · 11. Certification & Publication · 12. Operate, Evolve & Retire

Every stage carries the same furniture: a "why this stage matters" panel, a live exit-criteria
checklist, an agent panel, a review thread anchored to fields, version diff, parking lot, gate
panel and audit timeline.

Some stages add an import surface, because the web form is the wrong tool for that job:

- **Stage 3** profiles an uploaded **CSV extract** — row counts, null rates, cardinality, ranges and
  patterns are computed locally. No core flow anywhere in the application requires a warehouse
  connection. Sample values are withheld unless explicitly requested.
- **Stage 5** round-trips the **attribute register through Excel**, because nobody reviews 200
  attributes in a browser.
- **Stages 3, 4 and 6** import from **erwin, Collibra and Alation**, so the agents chartered for
  discovery, profiling, modelling and semantics know what your existing tools already know. See
  [Integrating erwin, Collibra and Alation](#integrating-erwin-collibra-and-alation).

**Guided tours drive the real UI.** Starting a tour from the Academy pins a persistent overlay that
navigates to each screen it describes and survives the navigation. It is not a slideshow, which
would go stale the first time the product changed and nobody would notice.

---

## The invariants, and where they are enforced

| # | Invariant | Enforced in | Tested in |
|---|---|---|---|
| 1 | Consumption-first: Stage 2 is hard-blocked until Stage 1 is approved | `lib/lifecycle/stages.ts` | `tests/criteria.test.ts` |
| 2 | `recordDecision()` is the only path to an APPROVED gate | `lib/lifecycle/transitions.ts` | `tests/gate-engine.test.ts` (source scan) |
| 3 | Artifact versions are content-hashed and append-only | `lib/artifacts/commit.ts` | `tests/lifecycle.test.ts` |
| 4 | Cascade honesty: changed evidence flips approvals to STALE | `lib/lifecycle/cascade.ts` | `tests/lifecycle.test.ts` |
| 5 | An artifact cannot be submitted while a field is unreviewed agent output | `lib/lifecycle/criteria.ts` | `tests/agent-guardrails.test.ts` |
| 6 | Every agent invocation writes an auditable `AgentAction` | `lib/agents/runtime.ts` | `tests/agent-guardrails.test.ts` |
| 7 | Grounding purity: no Bronze or Silver reference survives the validator | `lib/lifecycle/stages.ts` (Stage 10) | `tests/criteria.test.ts` |
| 8 | Evidence over assertion: every certification dimension cites a resolving reference | `lib/lifecycle/stages.ts` (Stage 11) | `tests/criteria.test.ts` |
| 9 | Value closes the loop: hypothesis at Stage 2, measured at Stage 12 | `lib/lifecycle/stages.ts` | `tests/criteria.test.ts` |
| 10 | Roles are re-derived server-side on every mutation, including agent invocation | `lib/auth/authorise.ts`, `lib/agents/runtime.ts` | `tests/lifecycle.test.ts`, `tests/agent-guardrails.test.ts` |
| 11 | Industry logic lives in packs, never in application code | `packs/*.yaml`, `lib/packs/` | `pnpm pack:validate` |

Quorum and veto arithmetic is a pure function (`evaluateGateOutcome`) so the rules can be read and
tested without a database. Two rules worth stating explicitly:

- A **reject from a veto role rejects the gate outright**, regardless of quorum.
- **Silence from a veto holder is not consent** — if a veto role is also an approver role, the gate
  cannot pass until they have approved.

---

## Commands

```bash
pnpm dev            # development server
pnpm build          # production build (runs prisma generate first)
pnpm start          # serve the production build
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint, zero warnings tolerated
pnpm test           # vitest — unit + integration against a separate SQLite file
pnpm test:e2e       # playwright, against a running server (see below)
pnpm pack:validate  # validate every industry pack
pnpm db:seed        # create and seed the database
pnpm db:reset       # drop and reseed
pnpm monitor        # scheduled L3 monitoring run, for cron (see docs/DEPLOYMENT.md §6)
pnpm db:seed:pg     # the optional Postgres path (docker compose up -d first)
```

End-to-end tests expect a built server on port 3111 with the seeded database:

```bash
pnpm db:seed && pnpm build
PORT=3111 pnpm start &
pnpm test:e2e
# If your environment ships a Chromium that does not match this Playwright version:
# PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome pnpm test:e2e
```

---

## Agents

Twelve chartered agents, each declaring a stage binding, a read scope, an output type, an autonomy
ceiling and an escalation rule (`src/lib/agents/registry.ts`).

| Level | Name | Behaviour |
|---|---|---|
| **L0** | Off | Never runs |
| **L1** | Suggest *(default)* | Runs only when invoked; proposes field by field |
| **L2** | Draft | Runs on a stage-entry trigger; produces a whole-artifact draft |
| **L3** | Monitor | Runs on a schedule against published products; raises findings. **Never edits an artifact.** |

There is deliberately **no level that clears a gate or commits a version**. A workspace setting can
lower an agent's ceiling; it can never raise it.

**Choosing a model per autonomy level.** The Agents tab narrows by industry → domain → data
product, and lets an admin assign an Anthropic model to each level for that industry — Opus for
adversarial critique, Sonnet for drafting, Haiku for scheduled monitoring across many products. The
catalogue is data (`src/lib/agents/models.ts`), maintained by hand; nothing queries a vendor for
available models. **A model choice changes what an agent is good at, never what it may do** — L3 is
read-only monitoring whichever model backs it, and that is asserted in a test.

With no API key the deterministic local provider runs regardless of what is assigned, so the action
log records the **assigned** model and the model that **actually ran** as separate fields. It will
never tell you a model ran when it did not.

Invoking an agent is a mutation — it spends workspace budget and puts product content in front of a
model — so it is authorised by role server-side in the runtime, not at the route. `pnpm monitor` is
bound by the same rule as the button in the studio, and refuses to start without
`ADPM_MONITOR_USER` naming the human accountable for the schedule.

**Providers.** Model access sits behind an adapter:

- `local-heuristic` (default) — deterministic, rule-based, no network call. Labelled as such
  everywhere it appears. This is what makes the whole lifecycle demonstrable offline.
- `anthropic` — used when an API key is configured in Admin. Keys live in the environment or a
  git-ignored local file, never in the database and never in a committed artifact.

Before transmission, values flagged as PII or restricted in the attribute register are redacted, and
sample data is withheld unless the workspace explicitly allows it. The redacted field count is
reported back in the UI after every run.

### Integrating erwin, Collibra and Alation

Agents give better guidance when they know what your existing tools already know. Stages 3, 4 and 6
accept an export from a data modelling tool or catalogue:

| Connector | Supplies | Status |
|---|---|---|
| **Canonical import** (any tool) | everything | fully specified and round-trip tested |
| **erwin Data Modeler** (CSV) | entities, relationships | mapped from the documented Bulk Editor layout, **unverified against a live instance** |
| **Collibra** (JSON) | sources, glossary, metrics | mapped from the documented asset export, **unverified** |
| **Alation** (JSON) | sources, column profiles, glossary | mapped from the documented bulk metadata shape, **unverified** |

Three rules make this safe, and each is tested:

- **An import is context, never content.** It is read by agents; it never becomes an artifact
  version. Proposals derived from it still require a human disposition. See
  [ADR 0009](docs/adr/0009-external-metadata-is-context-not-content.md) for why this beats turning
  each imported row into a proposal.
- **External context is scoped and declared.** Each agent declares which slices it may read, that
  declaration is recorded on every `AgentAction`, and it is part of the input hash — invariant 6
  does not distinguish artifact context from catalogue context. **The grounding agent is given
  none of it**, because catalogue exports are full of physical Bronze and Silver table names and
  invariant 7 says a grounding artifact may reference only certified semantic-layer objects.
- **A catalogue's "certified" is not ADPM's.** External endorsement is carried verbatim as
  `externalCertification` and never mapped onto certification here, which needs cited evidence and
  a recorded approval.

**Import-only, file-based, no live sync.** Nothing writes back to your catalogue, and nothing
requires a reachable Collibra or Alation instance — the app still runs entirely offline. The local
heuristic provider reads imported context too, so the benefit is visible with no API key.

**Where to find it.** The **Agents** tab lists every connector, what each supplies, what has been
imported in the workspace, and — per agent — which external context that agent may read. You
perform the import from a product's **Stage 3, 4 or 6**, next to the artifact it informs.

---

## Packs

Nine packs ship: `_generic`, utility/energy (the reference implementation), banking, insurance,
retail/CPG, healthcare, manufacturing, telecom and public sector. Each supplies domains, a conformed
backbone, canonical entities, a control library, starter metrics, sample decision records, platform
profiles, a glossary, blueprints and seed marketplace products.

**Packs are illustrative and editable, not authoritative.** They are a starting point for a
conversation with your own regulatory and domain experts. They are not legal advice and not a
compliance certification. The UI says so on every pack screen.

---

## Exports

- **Word** — evidence pack (every artifact version, approval, provenance summary), maturity assessment
- **Excel** — attribute register (colour-coded inputs, dropdown validation, locked reference sheet,
  COUNTIFS review summary, parking-lot tab) and portfolio extract. The attribute workbook is a true
  **round trip**: export it, review it in Excel, import it back from Stage 5. The edits become a new
  artifact version and the reviewer's comments become review-thread comments anchored to the
  attribute, so the review does not stay trapped in a file on somebody's laptop.
- **YAML / JSON** — every stage artifact, marketplace listing, grounding pack, standards payloads
- **Mermaid** — ER, lineage and portfolio dependency graphs, generated from committed artifacts
- **PDF** — the printable "How data products work here" primer
- **Audit bundle** — every gate, decision, artifact version and agent action, digest-sealed

Every committed artifact is also mirrored to `workspace/` as plain YAML or Markdown, so the whole
programme is git-diffable outside the application.

---

## Standards interoperability

| Standard | Version pinned | Direction | Checked against the published spec? |
|---|---|---|---|
| Open Data Contract Standard (ODCS) | v3.0.2 | round-trip | **Yes** — `bitol-io/open-data-contract-standard`, 2026-08-01 |
| OpenLineage | 2-0-2 run event | export | **Yes** — `OpenLineage/OpenLineage`, 2026-08-01 |
| Open Data Product Specification (ODPS) | v3.0 | export | No |
| DCAT / DCAT-AP | DCAT 3 JSON-LD | export | No |
| MetricFlow / dbt semantic manifest | semantic manifest v1 | round-trip | No |
| schema.org `Dataset` | schema.org 27.x | export | No |
| OpenMetadata / DataHub | listing export shape | export only, no live sync | No |

**Be precise about what this claims.** Every adapter pins the version it was written against and is
covered by a round-trip or shape test in `tests/standards.test.ts` — the mapping is stable and
tested. That is a weaker claim than conformance.

Two adapters go further. ODCS and OpenLineage have been read against their published JSON schemas,
and each carries a `verification` record naming the source, the date and the finding
(`src/lib/standards/index.ts`); `tests/standards.test.ts` asserts that every root field the ODCS
schema marks as required is actually emitted. The remaining five say **unverified** in their own
description, in the Admin UI, and here. Check the pin against the current published spec before
relying on one of them in production.

---

## Anti-goals — things this deliberately is not

- **Not a pipeline builder, query engine, or anything that executes transformations.** ADPM designs,
  governs and manages data products; it does not run them.
- **No live warehouse dependency in any core flow.** Stage 3 profiling accepts entered or uploaded
  statistics; it never requires a connection.
- **No agent that can approve, commit, publish or complete a stage.** No exceptions, no override.
- **No single blended navigation** across consumer, practitioner and leadership.
- **Gates are not a status enum on a product.** They are first-class entities with roles, quorum,
  veto, decisions, evidence snapshots and an audit trail.
- **No industry logic in application code.** If it names an industry, a domain, a regulation or an
  entity, it belongs in a pack.
- **No prioritisation score that cannot be overridden** by a named human with a recorded reason.
- **No claimed standards conformance without a round-trip test** against the pinned specification.

A tool that is honest about its boundary is more credible in an enterprise procurement conversation
than one that claims everything.

---

## Honest limitations in this build

- **Peer-band comparison in the maturity assessment is a placeholder.** No external benchmark data is
  bundled, and inventing one would be dishonest.
- **The audit bundle is digest-sealed, not cryptographically signed** by an external key holder. The
  bundle says so in its own payload.
- **Scheduled L3 monitoring is a script you schedule, not a service.** `pnpm monitor` is built to run
  from cron and refuses to run unattributed, but ADPM ships no daemon of its own — there is nothing
  in-process watching the clock.
- **Five of the seven standards adapters are unverified** against their published specifications.
  ODCS and OpenLineage have been checked and carry a verification record; the others say so.
- **The Postgres path is written but was never executed.** `docker-compose.yml` and the schema
  derivation exist and the derivation is exercised, but no Docker daemon was available in the
  environment this was built in, so `pnpm db:seed:pg` has not been run against a live Postgres.
  SQLite is the tested path.

---

## Architecture

```
src/
  app/                        # Next.js App Router — one route per tab, server actions for mutations
  lib/
    lifecycle/stages.ts       # the 12-stage registry AS DATA (roles, quorum, veto, exit criteria)
    lifecycle/transitions.ts  # requestTransition / recordDecision — the only gate paths
    lifecycle/criteria.ts     # pure exit-criteria evaluators
    lifecycle/cascade.ts      # approval decay when evidence changes
    artifacts/                # Zod schemas, commit.ts, diff.ts, serialise.ts
    agents/                   # registry (charters AS DATA), runtime, providers, redaction
    patterns/registry.ts      # the eight consumption patterns AS DATA
    guides/registry.ts        # the teaching layer AS DATA
    packs/                    # loader, validator, blueprint expansion
    portfolio/                # scoring and maturity models
    standards/                # ODCS, ODPS, DCAT, OpenLineage, MetricFlow, schema.org adapters
    exports/                  # docx, xlsx, pdf, audit bundle
prisma/                       # schema and the seed that drives the real engine
packs/                        # nine industry packs (YAML)
workspace/                    # git-friendly mirror of committed artifacts
tests/                        # vitest unit + integration, playwright e2e
docs/adr/                     # architecture decision records
```

Registries are data. Adding a stage, agent, pattern, pack or guide never requires editing the
transition engine.
