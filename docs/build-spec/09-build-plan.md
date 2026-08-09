# 09 — Build plan, test strategy and acceptance

How two engineers get from an empty repository to a client-hosted deployment, what "done" means at
each step, and what is genuinely unresolved.

---

## 1. Team and split

The minimum viable team is two people plus a part-time architect. This specification is written for
that shape.

| Role | Owns | Percentage of the build |
|---|---|---|
| **AI / application engineer** | Lifecycle engine, artifact service, agent runtime, UI, auth, exports | ~65% |
| **Data engineer** | Schema, migrations, packs, bootstrap and seed tooling, reconciliation, backups, cloud database | ~25% |
| **Cloud / platform engineer** (part-time) | Network, identity, container platform, secrets, pipeline, observability | ~10% |

Both engineers need to understand the eleven invariants ([01 §2](01-functional-spec.md)) before they
write anything. Most defects in a system like this are invariant violations that look like features.

---

## 2. Milestones

Durations assume the team above, full-time, building from scratch. Halve them if starting from the
reference implementation in this repository.

| # | Milestone | Contents | Exit criteria | Est. |
|---|---|---|---|---|
| **M0** | Foundations | Repo, Next.js + TypeScript strict, Tailwind, Prisma, Vitest, CI running lint/typecheck/test/build | Empty app deploys locally; CI green | 3 d |
| **M1** | Data model and registries | 35 tables, migrations, enums, roles, stages, artifact types, patterns, agents, models — all as data | Schema migrates; registry tests pass; `Role`/`Stage` seeded | 1 w |
| **M2** | **The engine** | `commitArtifact` (canonicalise, hash, version, provenance), `requestTransition`, `recordDecision`, exit-criteria evaluation, cascade invalidation, audit writer | Invariant tests 2, 3, 4, 5 pass with no UI at all | 2 w |
| **M3** | Packs and bootstrap | Pack schema, loader, validator, `pnpm pack:validate`, blueprint expansion, bootstrap script, demo seed driving products through the real engine | A seeded database passes all nine reconciliation queries ([04 §8](04-data-loading.md)) | 1 w |
| **M4** | Practitioner UI | Lifecycle Studio (all twelve stages), artifact forms from Zod schemas, exit-criteria checklist, review thread, diff, gate panel, audit timeline, My Work | A product can be taken from Stage 1 to publication entirely through the UI | 3 w |
| **M5** | Consumer and leadership | Marketplace, search, listing from artifacts, intake wizard, my requests, triage; portfolio, prioritisation, value, cost, maturity | The three doors are usable end to end | 2 w |
| **M6** | Agents | Provider abstraction, local-heuristic provider, scope enforcement, redaction, action logging, proposal disposition, agent panel, run console, model provider for the target cloud | Guardrail tests ([08 §9](08-agents-llm.md)) pass; agents demonstrably cannot approve anything | 2 w |
| **M7** | Enterprise readiness | OIDC or IAP identity, JIT provisioning, role mapping, `/api/health`, container image, configurable artifact mirror, structured logging, export routes | Deploys to the target cloud; a real user signs in with their own identity | 1.5 w |
| **M8** | Client deployment | IaC, database provisioning, secrets, pipeline, migration and bootstrap jobs, observability, backup and restore rehearsal, runbooks, handover | Production runbook executed end to end, including a restore | 1.5 w |

**Total ≈ 14–15 weeks** from scratch; ≈ 6–7 weeks starting from the reference implementation, of
which most is M7 and M8.

**The ordering is not negotiable in one place:** M2 before M4. The engine must be correct and tested
before any screen exists, because every screen is a client of it and every shortcut taken in the UI
becomes an invariant violation later.

---

## 3. Work breakdown for the data engineer

Running alongside M1–M8, roughly in this order:

1. **Schema and migrations** (M1). One canonical schema; the Postgres variant is derived, never
   hand-maintained. Migration job, not an application step.
2. **Prove the Postgres path locally** (M1) — [03 §7](03-data-model.md). Before any cloud work.
3. **Database roles and grants** (M1). `adpm_app` without `DELETE` turns invariant 3 into a database
   guarantee.
4. **Pack authoring for the client** (M3) — [04 §5](04-data-loading.md). Start the domain, control
   and metric interviews in week one; this is the long-lead content item.
5. **Bootstrap script** (M3) — [04 §6](04-data-loading.md). The single most important missing piece
   for a client environment.
6. **Reconciliation queries as a scheduled job** (M3) — [04 §8](04-data-loading.md). Nine queries,
   zero rows, alert on non-zero.
7. **Growth and sizing model** (M8) — [03 §4](03-data-model.md). Feed it into the instance sizing
   rather than guessing.
8. **Backup, restore rehearsal and refresh policy** (M8) — including the rule that production is
   never restored into a lower environment unscrubbed.
9. **Migration of any existing inventory** (post-M8) — [04 §7](04-data-loading.md), as candidates at
   Stage 1, never as published products.

---

## 4. Test strategy

| Layer | Tool | Covers | Gate |
|---|---|---|---|
| **Unit** | Vitest | Hashing, canonicalisation, path get/set, scoring, criteria evaluators, registries, redaction, schema parsing | Every PR |
| **Integration** | Vitest + a real database | Transition engine, gate quorum and veto, cascade invalidation, commit path, proposal disposition, intake, packs, standards round-trips | Every PR |
| **Invariant** | Vitest, named per invariant | The eleven invariants of [01 §2](01-functional-spec.md) | Every PR, **and re-run against every environment after deployment** |
| **Guardrail** | Vitest | The eleven agent guardrails of [08 §9](08-agents-llm.md) | Every PR |
| **End-to-end** | Playwright against a built server and seeded database | Consumer journey, practitioner journey, intake wizard, run console, workspace switching, data model | Pre-merge to main, and post-deploy smoke |
| **Data** | SQL | The nine reconciliation queries of [04 §8](04-data-loading.md) | After every load, restore and deployment; scheduled in production |
| **Accessibility** | Manual + axe | Keyboard navigation, labels, focus, contrast on the studio and marketplace | Per milestone |
| **Security** | Image scan, dependency audit, client pen test | Supply chain and the deployed surface | M8 and annually |

Definition of done for any change:

```
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

…all pass, **and** you have stated plainly what works, what is stubbed, and what you could not
verify. Never claim a flow works without exercising it.

---

## 5. Acceptance criteria

The client acceptance pack is the eleven invariants, demonstrated live rather than asserted.

| # | Demonstration | Passes when |
|---|---|---|
| 1 | Create a product request with no named decision; try to reach Stage 2 | Stage 2 is blocked with a criterion naming what is missing |
| 2 | Attempt to approve a gate through every non-`recordDecision` path — API, script, admin, agent | All fail; the test suite proves the path is unique |
| 3 | Edit a committed artifact | A new version appears; the previous version is unchanged and still readable |
| 4 | Change an artifact an approved downstream gate relied on | Those gates flip to `STALE` with a reason and re-approval tasks appear |
| 5 | Ask an agent to draft, then try to submit for review without dispositioning | Submission is refused, naming the unreviewed fields |
| 6 | Open any agent action | Agent, trigger, scope, input hash, model, tokens, cost and disposition are all present |
| 7 | Add a physical Bronze table reference to a grounding pack | The validator rejects it |
| 8 | Score a certification dimension with justification text only | The criterion fails until a version or approval is cited |
| 9 | Publish a product with no value hypothesis | Blocked at Stage 2; publication with `NOT_YET_MEASURABLE` is allowed |
| 10 | Sign in as a consumer and attempt an approval by calling the action directly | Refused server-side |
| 11 | Search the codebase for the client's industry name, domains or regulations | Found only in pack YAML and the database, never in application code |

Add three deployment acceptance items: a restore from backup completes within RTO; the nine
reconciliation queries return zero rows in production; and a named user from the client's IdP signs
in and lands on the right door with the right roles.

---

## 6. Risk register and open questions

### 6.1 Risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | **Identity work is underestimated.** IdP integration in a regulated client involves teams outside the project | Blocks M7 and every client-facing demo | Start in week one. Use an identity-aware proxy for the pilot ([02 §5.2](02-architecture.md)) |
| R2 | **The Postgres path has never been run end to end against a managed service** (**[GAP]** C1) | Discovered late, against a change-controlled database | Prove locally in M1 ([03 §7](03-data-model.md)) |
| R3 | **Connection exhaustion** on aggressive-scaling platforms | Total outage under a demo load spike | Cap instances, set `connection_limit`, use PgBouncer/RDS Proxy ([05](05-cloud-aws.md)–[07](07-cloud-gcp.md) §3) |
| R4 | **Model availability or approval in the client's region** (**[VERIFY]**) | Agents unavailable at demo time | Confirm in week one; the local-heuristic provider makes the deployment complete without models |
| R5 | **Pack content quality.** A pack full of generic domains makes the whole application feel generic | The demo lands flat; adoption stalls | Book the domain, control and metric interviews before M3 |
| R6 | **Demo seed reaching a client environment** (**[GAP]** C2) | Catastrophic — it opens with `deleteMany()` across every table | Guard the seed entry point in code, not in a runbook ([02 §9](02-architecture.md)) |
| R7 | **Agent budget overshoot** under concurrency (**[GAP]** C5) | Cost surprise | Atomic increment, or a stated tolerance agreed with the client |
| R8 | **Scope creep into pipeline execution.** Clients ask for ADPM to "just run the transformation too" | Turns a governance product into a half-built data platform | Hold the scope boundary in [01 §1](01-functional-spec.md); integrate, do not absorb |
| R9 | **Artifact mirror on ephemeral storage** reports false commit failures (**[GAP]** B3) | Users re-enter work that was in fact saved | `ADPM_WORKSPACE_DIR=off`, and make the mirror non-fatal |
| R10 | **Governance theatre.** Gates approved without reading, to move products along | The application records consent without judgement — the one failure it cannot detect | Report approval-to-open time and stale-gate age; make quorum meaningful; train, do not just deploy |

### 6.2 Open questions for the client

| # | Question | Why it matters | Default if no answer |
|---|---|---|---|
| OQ-1 | Which identity provider, and can it issue OIDC or federate to the platform's proxy? | Determines M7's shape entirely | Identity-aware proxy on the platform |
| OQ-2 | Are agents in scope for the first release, and is model inference permitted in-region? | Determines whether M6 needs a cloud model provider | Agents enabled with the local-heuristic provider |
| OQ-3 | May one person satisfy a quorum of two by holding two approver roles? | Changes `recordDecision` quorum evaluation | **No** — quorum counts distinct people as well as distinct roles |
| OQ-4 | One workspace or several — per business unit, per region, per programme? | Role assignment, budgets, metric-name uniqueness and prioritisation are all workspace-scoped | One workspace per governance boundary |
| OQ-5 | What retention applies to audit events and agent actions? | Partitioning and archival ([03 §4](03-data-model.md)) | Retain for the engagement plus the client's contractual period; never delete |
| OQ-6 | Is any customer personal data ever expected in a profiling upload? | Changes the data-protection classification of the whole system ([03 §8](03-data-model.md)) | **No.** Sample data stays off; profiling stores distributions, not rows |
| OQ-7 | Who owns triage, and what SLA? | `Workspace.triageSlaHours` and the queue that follows from it | 48 hours, Domain Product Owner |
| OQ-8 | Does the client require row-level security or customer-managed keys? | Hardening in [02 §5.6](02-architecture.md) and the database configuration | Application-level scoping and platform-managed keys |

---

## 7. Handover checklist

Nothing is finished until all of this exists and someone at the client has used it.

- [ ] Runbooks: deploy, roll back, restore, rotate secrets, add a user, add a workspace, install a pack
- [ ] IaC in the client's repository, applied from their pipeline, not from a laptop
- [ ] Reconciliation queries scheduled, with alerting on non-zero results
- [ ] Backup **restore** rehearsed, timed and documented — not just configured
- [ ] Every seeded `@adpm.local` account removed from every client environment
- [ ] The AI governance pack ([08 §11](08-agents-llm.md)) delivered to the client's review board
- [ ] Role coverage verified per workspace: every stage has an approver who exists
- [ ] Academy walkthrough delivered to each of the three audiences — this application is a change of
      operating model, and an untrained governance tool becomes a rubber stamp within a month
- [ ] Known gaps ([README §status](README.md#status-and-honesty-markers)) written down, owned, and
      dated — not quietly inherited
