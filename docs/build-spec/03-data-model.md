# 03 — Physical data model

Thirty-five tables, 353 columns, 72 foreign keys, 52 indexes. The database is the system of record:
every gate decision, artifact version and agent action is append-only and queryable there.

The DDL for every table is generated and committed at [`ddl/postgres-schema.sql`](ddl/postgres-schema.sql).
This document explains it: the clusters, the keys, the conventions, how it grows, how it is
migrated, and how it maps onto each hyperscaler's managed PostgreSQL.

What goes *into* each table is document [04](04-data-loading.md).

---

## 1. Conventions, and why they are load-bearing

| Convention | Rule | Why |
|---|---|---|
| **Identifiers** | Application-generated CUIDs in `TEXT` columns. Exceptions: `Stage.number` (integer, the natural key) and `Role.id` (the role key itself) | IDs are assigned before insert, so a whole object graph can be built in one transaction. No sequence contention, no ID leakage of row counts |
| **Enumerations** | `TEXT` columns validated by Zod against a single definition in `src/lib/domain/enums.ts`. **No native `ENUM` types** | A native enum needs a migration to add a value and is not portable between SQLite and PostgreSQL. 21 columns are enumerated this way; the permitted values are listed in [01](01-functional-spec.md) and rendered in the app's Data Model tab |
| **Structured payloads** | `TEXT` columns suffixed `Json`, parsed at the boundary, never read raw in the UI | Keeps the schema portable and keeps payload shape under Zod's control rather than the database's. `jsonb` is a legitimate PostgreSQL-only optimisation — see §5.3 before reaching for it |
| **Timestamps** | `TIMESTAMP(3)` UTC. `createdAt` defaults to now; `updatedAt` is ORM-maintained | |
| **Soft delete** | Nothing is hard-deleted. Tables that can leave circulation carry `archivedAt TIMESTAMP(3) NULL` | Governance evidence cannot be deleted by design |
| **Append-only** | `ArtifactVersion`, `AuditEvent`, `AgentAction`, `AgentRunStep`, `ExternalMetadataImport` are insert-only by contract | Invariants 3 and 6. Enforce in code; optionally enforce with a `BEFORE UPDATE/DELETE` trigger in production (§5.4) |
| **Tenant key** | Every tenant-scoped table carries `workspaceId`, directly or through its parent | Multi-tenancy and query scoping (02 §5.6) |
| **No status denormalisation** | There is deliberately **no** approval-status column on `DataProduct`. `currentStage` is a progress pointer, never an approval record | Invariant 2: the gate is the only record of approval |

---

## 2. The nine clusters

| Cluster | Tables | Purpose |
|---|---|---|
| **Tenancy and people** | `Workspace`, `Domain`, `User`, `Role`, `RoleAssignment` | Who is using the application, where, in what role |
| **Demand** | `ProductRequest`, `RequestMessage` | Consumer intake, before anything is a product |
| **Product and lifecycle** | `DataProduct`, `Stage`, `StageRun` | The unit of work and its passage through twelve stages |
| **Artifacts and evidence** | `Artifact`, `ArtifactVersion`, `FieldProvenance` | What each stage produced, immutably, with human/agent provenance per field |
| **Governance and audit** | `Gate`, `GateEvidence`, `Approval`, `Comment`, `Task`, `AuditEvent`, `ChangeRequest` | Approval, the evidence it rested on, and the trail |
| **Consumption and feedback** | `ConsumptionPatternBinding`, `AccessRequest`, `Feedback` | How a published product is actually used |
| **Portfolio and value** | `ValueMeasurement`, `MaturityAssessment`, `PrioritisationOverride` | The leadership view |
| **Agents** | `AgentSetting`, `ModelAssignment`, `AgentAction`, `AgentProposal`, `AgentRun`, `AgentRunStep`, `ExternalMetadataImport` | Everything an agent touched and every human disposition of it |
| **Configuration** | `Pack`, `Blueprint` | Industry configuration as data |

### 2.1 The spine

```mermaid
erDiagram
  ProductRequest ||--o| DataProduct : "triage approval creates"
  DataProduct ||--o{ StageRun : "one per stage attempt"
  StageRun ||--o| Gate : "exactly one"
  Gate ||--o{ Approval : "quorum and veto counted from"
  Gate ||--o{ GateEvidence : "pins content hashes"
  DataProduct ||--o{ Artifact : "one row per artifact type"
  Artifact ||--o{ ArtifactVersion : "append-only versions"
  ArtifactVersion ||--o{ FieldProvenance : "human or agent, per field"
  DataProduct ||--o{ AgentAction : "every invocation"
  AgentAction ||--o{ AgentProposal : "awaiting human disposition"
```

Read it in one sentence: *a request becomes a product, a product runs a stage, a stage run has one
gate, a gate is approved by people and pinned to the exact artifact versions it relied on.*

---

## 3. Keys, constraints and what they protect

| Table | Uniqueness that matters | What it prevents |
|---|---|---|
| `Workspace` | `slug` | Two tenants sharing a URL |
| `Domain` | `(workspaceId, key)` | Duplicate domains within a tenant |
| `User` | `email` | Duplicate identities |
| `RoleAssignment` | `(userId, roleId, workspaceId, domainId)` | The same grant twice |
| `ProductRequest` | `reference` | Two requests claiming REQ-1004 |
| `DataProduct` | `(workspaceId, key)`, `requestId` unique | Duplicate product keys; one product per request |
| `StageRun` | `(productId, stageNumber, attempt)` | Two concurrent runs of the same stage |
| `Artifact` | `(productId, type)` | Two artifacts of the same type on one product |
| `ArtifactVersion` | `(artifactId, version)` | A version number reused |
| `FieldProvenance` | `(artifactVersionId, fieldPath)` | Two provenance claims for one field |
| `Gate` | `stageRunId` unique | Two gates on one stage run — the invariant that makes "one gate per run" true in the data, not just in code |
| `GateEvidence` | `(gateId, artifactId)` | Double-pinning one artifact |
| `Approval` | `(gateId, userId, roleKey)` | One person voting twice in the same role |
| `ConsumptionPatternBinding` | `(productId, patternKey)` | Duplicate readiness rows |
| `AgentSetting` | `(workspaceId, agentId)` | Two autonomy settings for one agent |
| `ModelAssignment` | `(workspaceId, autonomyLevel)` | Two models for one level |
| `AgentRunStep` | `(runId, sequence)` | A rewritten plan |
| `Blueprint` | `(packId, key)` | Duplicate blueprints in a pack |

Referential integrity is enforced by foreign keys on all 72 relationships. Deletes are `RESTRICT` by
design — nothing cascades, because nothing is deleted.

### 3.1 Indexes

Fifty-two, including the unique constraints above. The query-shaped ones:

| Index | Serves |
|---|---|
| `ProductRequest(workspaceId, state)` | Triage queue |
| `DataProduct(workspaceId, status)` | Marketplace and product list |
| `StageRun(productId, stageNumber)` | Studio |
| `Artifact(productId, stageNumber)` | Studio |
| `ArtifactVersion(contentHash)` | Cascade invalidation — the hot path for invariant 4 |
| `Gate(productId, stageNumber)`, `Gate(state)` | Inbox, stale-gate sweeps |
| `Approval(gateId)` | Quorum evaluation |
| `Comment(productId, stageNumber)` | Review thread |
| `Task(workspaceId, completedAt)`, `Task(assigneeRoleKey)` | My Work |
| `AuditEvent(workspaceId, createdAt)`, `(productId, createdAt)`, `(entityType, entityId)` | Timelines and evidence export |
| `AgentAction(workspaceId, createdAt)`, `(agentId)`, `(productId)` | Action log and cost reporting |
| `AgentProposal(productId, stageNumber, state)` | The agent panel's pending queue |
| `AgentRun(productId, state)`, `(workspaceId, startedAt)` | Run console |
| `ExternalMetadataImport(productId, createdAt)` | Import history |

Add nothing else before measuring. The two most likely additions under real load are
`ArtifactVersion(artifactId, createdAt DESC)` for "latest version" lookups and a partial index
`Gate(state) WHERE state = 'STALE'` for the stale sweep.

---

## 4. Growth model

Measured from the reference seed: 9 workspaces, 73 products, all but two driven through all twelve
stages by the real engine.

| Table | Seeded rows | Rows per published product | Growth driver |
|---|---|---|---|
| `Workspace` | 9 | — | Tenants |
| `Domain` | 71 | — | ~8 per workspace, from the pack |
| `User` | 12 | — | People with access |
| `Role` | 11 | — | Fixed registry |
| `RoleAssignment` | 108 | — | users × workspaces × roles |
| `ProductRequest` | 3 | ~1 | Consumer demand |
| `RequestMessage` | 1 | — | Triage conversation |
| `DataProduct` | 73 | 1 | The portfolio |
| `Stage` | 12 | — | Fixed registry |
| `StageRun` | 861 | **12** (+1 per rejected attempt) | Lifecycle |
| `Artifact` | 1,787 | **~24.5** | Artifact types committed |
| `ArtifactVersion` | 1,787 | **~24.5 at v1**, +1 per edit | The main growth table |
| `FieldProvenance` | 0 | 0–hundreds | Only when agents propose — one row per proposed field |
| `Gate` | 859 | **12** | One per stage run |
| `GateEvidence` | 10,690 | **~146** | Artifacts × approved gates. The largest table by row count |
| `Approval` | 1,719 | **~23** | Quorum per stage (2–3 approvers × 12) |
| `Comment` | 0 | 0–dozens | Review activity |
| `Task` | 1,720 | **~23** | Approvals and reviews raised |
| `AuditEvent` | 6,227 | **~85** | Every mutation |
| `ChangeRequest` | 1 | 0–few | Post-publication change |
| `Pack` / `Blueprint` | 9 / 18 | — | Installed packs |
| `ConsumptionPatternBinding` | 568 | **8** | One per pattern |
| `AccessRequest` / `Feedback` | 2 / 2 | 0–many | Consumer activity after publication |
| `ValueMeasurement` | 71 | 1 | Hypothesis then measurement |
| `MaturityAssessment` | 1 | — | Per assessment cycle |
| `PrioritisationOverride` | 0 | 0–few | Leadership overrides |
| `AgentSetting` | 126 | — | 14 agents × workspaces |
| `ModelAssignment` | 0 | — | ≤4 per workspace |
| `AgentAction` | 0 | 0–hundreds | Every agent invocation, forever |
| `AgentProposal` | 0 | 0–thousands | Per proposed field |
| `AgentRun` / `AgentRunStep` | 0 / 0 | — | Run console usage |
| `ExternalMetadataImport` | 0 | 0–few | Catalogue imports |

**Sizing rule of thumb.** A published product costs roughly **350 rows** across all tables, plus
artifact content. A 500-product engagement with heavy agent use lands in the low millions of rows —
comfortably a single PostgreSQL instance, no sharding, no partitioning. The tables to watch are
`GateEvidence`, `AuditEvent` and `AgentAction`, in that order.

**Storage.** Artifact content dominates: a typical committed artifact is 2–20 KB of JSON text, so
~24 versions per product ≈ 250 KB, plus re-commits. Budget 1 GB per 1,000 products of artifact
content and index overhead, then double it for headroom. Agent actions add ~5–20 KB each when
outputs are large.

**When to partition.** Not at pilot scale. If `AuditEvent` or `AgentAction` passes ~50 million rows,
range-partition by `createdAt` monthly. Both are append-only and queried by recency, which is the
ideal partitioning shape. Do not partition `GateEvidence`: it is queried by gate, not by time.

---

## 5. PostgreSQL-specific hardening

### 5.1 Session and connection settings

```sql
ALTER DATABASE adpm SET statement_timeout = '30s';
ALTER DATABASE adpm SET idle_in_transaction_session_timeout = '60s';
ALTER DATABASE adpm SET lock_timeout = '10s';
ALTER DATABASE adpm SET default_transaction_isolation = 'read committed';
```

`statement_timeout` protects the app from a runaway export query; raise it only for the
administrative job role, which legitimately runs long migrations and seeds.

### 5.2 Roles

Three database roles, minimum:

| Role | Grants | Used by |
|---|---|---|
| `adpm_app` | `SELECT, INSERT, UPDATE` on all tables; **no `DELETE`**, no DDL | The application |
| `adpm_migrator` | Owner of the schema; DDL | Migration and bootstrap jobs only |
| `adpm_reader` | `SELECT` only | Analytics, reconciliation, support |

Denying `DELETE` to the application role turns invariant 3 from a convention into a database
guarantee. The application never deletes anything, so nothing legitimate breaks.

### 5.3 `TEXT` vs `jsonb` for the `*Json` columns

The schema uses `TEXT` for portability (ADR 0004, ADR 0008). If the client needs to query inside
payloads — "find every product whose telemetry shows a freshness breach" — a **generated column** is
the migration-safe answer, not a type change:

```sql
ALTER TABLE "AgentAction"
  ADD COLUMN "outputJsonb" jsonb GENERATED ALWAYS AS ("outputJson"::jsonb) STORED;
CREATE INDEX ON "AgentAction" USING gin ("outputJsonb");
```

Application writes are untouched, and the SQLite development path keeps working. Converting the base
columns to `jsonb` would break the shared schema and is out of scope for v1.

### 5.4 Optional append-only triggers

Where the client's audit function requires it, enforce append-only in the database:

```sql
CREATE OR REPLACE FUNCTION adpm_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only (ADPM invariant 3)', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "ArtifactVersion_append_only"
  BEFORE UPDATE OR DELETE ON "ArtifactVersion"
  FOR EACH ROW EXECUTE FUNCTION adpm_append_only();
-- repeat for AuditEvent, AgentAction, AgentRunStep, ExternalMetadataImport
```

Test the migration path first: a future schema change that needs a backfill on one of these tables
must drop and recreate the trigger inside the migration.

---

## 6. Migrations

`prisma migrate` is the mechanism. The committed DDL file is documentation, not a deployment path.

```bash
# Author (development, against a scratch database)
pnpm exec prisma migrate dev --name add_something --schema prisma/schema.postgres.prisma

# Apply (every other environment, as a one-off administrative job)
pnpm exec prisma migrate deploy --schema prisma/schema.postgres.prisma
```

Rules:

1. **The Postgres schema is derived, never hand-edited.** `pnpm db:pg:prepare` regenerates
   `prisma/schema.postgres.prisma` from the canonical SQLite schema, changing only the datasource
   block. Editing the generated file is lost work (ADR 0008).
2. **Migrations run before the new revision takes traffic**, as a separate job with the
   `adpm_migrator` role.
3. **Every migration must be backwards compatible with the running revision** for the length of the
   rollout: add columns nullable or with defaults, backfill in a second step, only then make them
   required. Never rename in one step — add, dual-write, backfill, drop.
4. **No destructive migration without a documented backup and a restore rehearsal.** Dropping a
   column that holds governance evidence needs client sign-off, not just a code review.
5. **Migration job failure blocks the deploy.** No "deploy anyway and fix forward" on a database
   whose contents are the audit record.

---

## 7. Prove the Postgres path before you provision anything

**[GAP]** C1. The Postgres derivation is exercised and reviewed, but seeding against a live
PostgreSQL instance has not been run end to end. Do this first, locally, where the feedback loop is
seconds:

```bash
docker compose up -d                 # postgres:16-alpine bound to 127.0.0.1
export DATABASE_URL="postgresql://adpm:adpm-local-development@127.0.0.1:5432/adpm?schema=public"
pnpm db:pg:setup                     # derive schema, push, regenerate the client
pnpm db:seed:pg                      # drive the full demo through the real engine
pnpm build && pnpm start             # exercise the app against Postgres
```

Then run the reconciliation queries in [04 §8](04-data-loading.md). If any of this fails, fix it
here — not against a managed cloud database with a change ticket attached to every retry.

---

## 8. Data classification of the model itself

What a client's security review will ask about the contents of these tables.

| Class | Where it lives | Handling |
|---|---|---|
| **Authentication secrets** | `User.passwordHash` | bcrypt. Eliminated entirely if the client moves to OIDC (02 §5) — the column becomes unused, and should then be dropped in a migration rather than left holding stale hashes |
| **Personal data (staff)** | `User.email`, `name`, `title`; actor ids across audit and approvals | Required for accountability. In scope for the client's employee-data notice, not for customer-privacy regimes |
| **Business-confidential** | Artifact content, packs, marketplace listings, value cases, cost figures | The bulk of the value and the bulk of the sensitivity. Encrypted at rest, access-controlled by workspace |
| **Customer personal data** | **Should not be here.** Attribute registers describe columns; they do not carry customer rows | The one path that could introduce it is an uploaded CSV profiling extract. Profiling stores distributions and null counts, and sample values only where the workspace explicitly allows agents to see them. Make that setting a documented client decision, and default it off |
| **Model interaction** | `AgentAction.outputJson`, `scopeJson`, `redactedFieldsJson` | Records exactly what was sent and what was withheld. This is the artefact an AI-governance review will ask for; do not truncate it |
