# ADPM Build Specification

**Agentic Data Product Management — build-from-scratch and enterprise deployment specification.**

This is the document you hand to an AI engineer and a data engineer who have to build this
application on a client network and run it on AWS, Azure or GCP. It specifies the product, the
architecture, the physical data model, what data goes in every table, the three cloud reference
architectures, the agent runtime, and the build plan.

It is written to be buildable without reading the source. Where the reference implementation in
this repository already answers a question, the spec says so and names the file, so you can read
working code instead of inventing it.

---

## Who this is for

| Reader | Read in this order | What you own |
|---|---|---|
| **AI / application engineer** | 01 → 02 → 08 → 09 | Application, lifecycle engine, agent runtime, UI, auth |
| **Data engineer** | 03 → 04 → 05/06/07 → 09 | Database, schema migration, seeding, bootstrap, backups, reconciliation |
| **Cloud / platform engineer** | 02 → 05/06/07 → 09 | Network, identity, container platform, secrets, observability |
| **Architect / reviewer** | 01 → 02 → 09 | Invariants, acceptance criteria, risk register |
| **Client stakeholder** | 01 §1–§3, 09 §1 | What is being built and in what order |

---

## Contents

| # | Document | What it specifies |
|---|---|---|
| 01 | [Functional specification](01-functional-spec.md) | Product, roles, the eleven invariants, the twelve stages, artifacts, gates, agents, consumption patterns, packs, portfolio scoring, standards, screen inventory |
| 02 | [Solution architecture](02-architecture.md) | Runtime architecture, request path, client-network topology, identity, security model, multi-tenancy, NFRs, observability, CI/CD |
| 03 | [Physical data model](03-data-model.md) | 35 tables, portable Postgres DDL, keys, indexes, growth model, retention, per-hyperscaler database mapping and tuning, migration strategy |
| 04 | [Data loading specification](04-data-loading.md) | **Per-table load specification** — source, phase, mandatory columns, example rows, volumes, load method, validation query — plus load order, bootstrap for a real client, and reconciliation |
| 05 | [AWS reference architecture](05-cloud-aws.md) | ECS Fargate / Aurora PostgreSQL / Cognito / Bedrock, network, IaC, runbook, cost |
| 06 | [Azure reference architecture](06-cloud-azure.md) | Container Apps / PostgreSQL Flexible Server / Entra ID / AI Foundry, network, IaC, runbook, cost |
| 07 | [GCP reference architecture](07-cloud-gcp.md) | Cloud Run / Cloud SQL / IAP / Vertex AI, network, IaC, runbook, cost |
| 08 | [Agent and LLM engineering](08-agents-llm.md) | Provider abstraction, scope enforcement, redaction, prompts, cost accounting, per-cloud model access, guardrail tests |
| 09 | [Build plan and acceptance](09-build-plan.md) | Milestones M0–M8, work breakdown, test strategy, acceptance criteria per invariant, risk register, open items |
| — | [`ddl/postgres-schema.sql`](ddl/postgres-schema.sql) | Generated DDL for all 35 tables, for review and for non-Prisma tooling |

Operational guides for the *existing* implementation live one directory up and are not repeated
here: [DEPLOYMENT.md](../DEPLOYMENT.md) (laptop and Postgres), [hosting-prerequisites.md](../hosting-prerequisites.md)
(the code changes any hosted deployment needs first), and the click-through guides
[AWS.md](../AWS.md), [AZURE.md](../AZURE.md), [GCP.md](../GCP.md). Documents 05–07 here are the
*reference architectures* those guides deploy into; read both.

---

## The one-paragraph product

ADPM manages the full lifecycle of data products — from a business user's unmet decision need
through design, certification, publication, consumption and retirement — across twelve governed
stages with a human approval gate between each. AI agents research, draft, profile, cross-check and
monitor; they never approve a gate, never commit a version and never publish. Every agent output is
persisted as a proposal with field-level provenance and needs a named human to accept, edit or
reject it. Industry specifics live in declarative packs, never in code. The database is the system
of record: gate decisions, artifact versions and agent actions are append-only and queryable.

**Agents act. Humans decide.** Every design decision in this specification serves that sentence. If
an implementation choice would let an agent clear a gate — through configuration, an admin override,
a "trusted mode" or a batch job — it is wrong, and no amount of convenience justifies it.

---

## How to use this specification

1. **Do not skip [01](01-functional-spec.md) §2.** The eleven invariants are the acceptance
   criteria. Every one has a corresponding automated test in the reference implementation; a build
   that passes the UI review and fails an invariant test is not done.
2. **Build the engine before the screens.** The lifecycle transition engine, the artifact commit
   path and the gate model are the product. The UI is a client of them.
3. **Registries are data, not code branches.** Stages, roles, agents, models, consumption patterns,
   connectors, standards adapters and teaching content are declarative arrays. Adding a stage or an
   agent must not require editing the transition engine. Where you see a table in document 01, it
   is a registry in the build, not a set of `if` statements.
4. **The data engineer starts at [04](04-data-loading.md).** Phase 0–2 (reference, tenancy,
   configuration) can be loaded before the application exists. Phases 3–7 must go through the
   engine, not through SQL.
5. **Assume nothing about the client network.** Document 02 §4 lists the questions to ask before
   any cloud work starts; several have answers that change the architecture.

---

## Status and honesty markers

This specification describes a system that exists as a working reference implementation, and it
inherits that implementation's known gaps rather than papering over them. Throughout the documents:

| Marker | Meaning |
|---|---|
| **[BUILT]** | Exists and is tested in the reference implementation. Read the named file. |
| **[GAP]** | Does not exist. Must be built for a hosted client deployment. Cross-referenced to the B/C item in [hosting-prerequisites.md](../hosting-prerequisites.md) where one exists. |
| **[VERIFY]** | Depends on a cloud service, region, licence or tenant setting that must be confirmed in the client's own account before it is designed around. Never assume from this document. |

The largest **[GAP]** items, stated once here so nobody discovers them in week six:

- **There is no user management** — no signup, invitation, password change, reset or deactivation.
  Authentication must be replaced with the client's identity provider (02 §5) or the whole
  application must sit behind an identity-aware proxy.
- **The seed is destructive and demo-only.** A real client workspace needs a bootstrap path that
  creates one workspace with real people and deletes nothing (04 §6).
- **The Postgres path has been derived and reviewed but never run end to end against a managed
  cloud database.** Prove it against a local container before provisioning anything (03 §7).
- **No container image, health endpoint or configurable artifact mirror ships in the repository.**
  All three are specified in [hosting-prerequisites.md](../hosting-prerequisites.md) §3–§5.
- **Cloud costs, service availability and model availability in documents 05–08 are design-time
  estimates.** Price them in the client's own account and region.
