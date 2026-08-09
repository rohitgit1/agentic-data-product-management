# Running ADPM on a laptop

ADPM is designed to run entirely on one machine, offline, with no cloud service and no warehouse
connection. This guide covers the whole path: first run, production build, the optional Postgres
path, agent configuration, scheduled monitoring, backup and reset, and what to do when something
does not work.

If you only want it running, read [RUNNING.md](../RUNNING.md) instead — it is the step-by-step
version of §1, with the seeded accounts and a guided first walkthrough. This document is the
operational reference behind it.

For hosting it on a server rather than a laptop, start with
[hosting-prerequisites.md](hosting-prerequisites.md) — the code changes that have to happen first —
then the guide for your cloud: [AWS](AWS.md), [Azure](AZURE.md) or [GCP](GCP.md).

For building ADPM on a client network rather than running this repository — the functional spec,
the physical data model, what data belongs in every table, and the three cloud reference
architectures — see [docs/build-spec/](build-spec/README.md).

---

## 1. First run

### Prerequisites

| Requirement | Version | Check |
|---|---|---|
| Node.js | 20.11 or newer (22 LTS recommended) | `node --version` |
| pnpm | 10 or newer | `pnpm --version` |
| Git | any recent | `git --version` |

pnpm ships with Node via Corepack:

```bash
corepack enable
corepack prepare pnpm@10 --activate
```

Nothing else is required. No Docker, no database server, no API key.

### Three commands

```bash
git clone <your-clone-url> AgenticDataProductManagement
cd AgenticDataProductManagement

pnpm install     # installs dependencies, creates .env, generates the Prisma client
pnpm db:seed     # creates prisma/dev.db and seeds the full demo
pnpm dev         # http://localhost:3000
```

`pnpm install` creates `.env` from `.env.example` if you do not already have one, so there is no
configuration step before the seed. `.env` is git-ignored and stays on your machine.

`pnpm db:seed` takes roughly 90 seconds to two minutes. It is not writing fixture rows: it drives all 73 demo
products through the **real** transition engine, the same `requestTransition()` and
`recordDecision()` calls the UI makes. When it finishes you have 9 workspaces, 73 published
products, 876 approved gates, ~1,825 artifact versions and ~6,350 audit events.

### Signing in

Any seeded account, password `adpm`:

| Email | Role | Lands on |
|---|---|---|
| `consumer@adpm.local` | Data Consumer | Marketplace |
| `owner@adpm.local` | Domain Product Owner | My Work |
| `steward@adpm.local` | Data Steward | My Work |
| `privacy@adpm.local` | Privacy & Security Officer | My Work |
| `cdo@adpm.local` | Portfolio Lead / CDO | Portfolio |
| `admin@adpm.local` | Admin | Admin |

The full list is on the sign-in screen. Roles are enforced server-side, so signing in as the
consumer genuinely cannot approve a gate — it is not a UI mode.

**These are demo credentials with a published password.** They exist so a stakeholder can open the
app and see something credible. Do not put this instance anywhere other people can reach it without
replacing them.

---

## 2. Production build

`pnpm dev` recompiles on every request, which is the wrong thing to demo on. For a client-facing
run, build once:

```bash
pnpm build            # runs prisma generate, then next build
pnpm start            # http://localhost:3000
```

Change the port with `PORT`:

```bash
PORT=4000 pnpm start
```

The build is a standard Next.js server build. `pnpm start` needs Node on the machine — there is no
static export, because every page is authenticated and most are dynamic.

### Keeping it running

Nothing here needs a process manager for a demo, but if you want the app to survive a terminal
closing:

```bash
# macOS / Linux
nohup pnpm start > adpm.log 2>&1 &

# or, with pm2 if you already use it
pnpm build && pm2 start "pnpm start" --name adpm
```

### Reaching it from another device on your network

`pnpm start` binds all interfaces by default, so `http://<your-laptop-ip>:3000` works from a phone
or a second laptop on the same network. Before you do that:

1. Replace `AUTH_SECRET` in `.env` with a real value — `openssl rand -base64 32`.
2. Replace the seeded passwords, or accept that anyone on the network can sign in as anyone.
3. Remember the traffic is plain HTTP. This is a local tool, not a hardened deployment.

---

## 3. Environment variables

`.env` (git-ignored, created for you on install):

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | `file:./dev.db` | Prisma connection string. SQLite path is relative to `prisma/`. |
| `AUTH_SECRET` | development placeholder | Signs the session JWT. **Replace for anything shared.** |
| `AUTH_TRUST_HOST` | `true` | Required by Auth.js v5 when not behind a known proxy. |
| `PORT` | `3000` | Server port. Read by `next dev` / `next start`. |

Optional, for agents:

| Variable | What it does |
|---|---|
| `ANTHROPIC_API_KEY` | Switches the agent provider from the local heuristic to a real model. |
| `ADPM_AGENT_MODEL` | Overrides the model id. Defaults to the adapter's pinned model. |
| `ADPM_MONITOR_USER` | The email of the human accountable for scheduled monitoring runs (§6). |

**Where secrets live.** In the environment, or in `.adpm-secrets.json` — a git-ignored file written
with owner-only (`0600`) permissions when you save a key through Admin. Never in the database and
never in a committed artifact. The Admin screen shows only the last four characters of a stored key
and has no path that reads it back out.

---

## 4. Optional: Postgres instead of SQLite

SQLite is the default and is sufficient for everything ADPM does on a laptop. Use Postgres when you
want a shared demo box, want to exercise concurrent approvals, or are rehearsing a deployment that
will not use SQLite.

```bash
docker compose up -d                    # postgres:16-alpine, bound to 127.0.0.1:5432
```

Point `.env` at it:

```
DATABASE_URL="postgresql://adpm:adpm-local-development@127.0.0.1:5432/adpm?schema=public"
```

Then:

```bash
pnpm db:seed:pg                         # derive the Postgres schema, push it, seed through the engine
pnpm dev
```

`pnpm db:seed:pg` runs `scripts/prepare-postgres.ts`, which generates
`prisma/schema.postgres.prisma` from the canonical SQLite schema with only the datasource provider
changed. The generated file is git-ignored and must never be hand-edited — edit
`prisma/schema.prisma` and re-run. This is why the two stores cannot drift.

To go back to SQLite: restore `DATABASE_URL="file:./dev.db"`, run `pnpm db:generate`, and
`docker compose down` (add `-v` to delete the Postgres volume too).

> **Not verified in the environment this was built in.** The Postgres path is written and the
> schema derivation is tested, but no Docker daemon was available to run `docker compose up` and
> seed against a live Postgres instance. Treat §4 as untested until you have run it once. The
> SQLite path in §1 was exercised end to end.

---

## 5. Agents

Agents are **disabled by default and optional**. Every stage is completable with all agents off —
that is a tested invariant, not an aspiration.

To turn them on:

1. Sign in as `admin@adpm.local`.
2. **Admin → Agent configuration** → enable agents for the workspace, and set the budget cap.
3. **Agents** tab → set an autonomy level per agent. L1 (suggest) is the default; a workspace
   setting can only ever *lower* an agent's registry ceiling, never raise it.

With no API key configured, agents run on the `local-heuristic` provider: deterministic, rule-based,
no network call, labelled as such everywhere it appears in the UI. **The whole supervised-autonomy
loop is demonstrable offline** — invoke, review proposals, accept or reject, watch provenance and
the exit criteria respond.

To use a real model instead, either set `ANTHROPIC_API_KEY` in the environment before starting the
server, or paste a key into Admin (it is written to `.adpm-secrets.json`, not the database). Before
transmission, values flagged as PII or restricted in the attribute register are redacted and sample
data is withheld unless the workspace explicitly allows it; the redacted-field count is reported
back after every run.

Costs are estimated and charged against the workspace budget cap. When the cap is reached, agents
stop running until an admin raises it.

---

## 6. Scheduled monitoring

L3 monitoring agents (Curator, Steward) can run unattended against published products:

```bash
ADPM_MONITOR_USER=steward@adpm.local pnpm monitor
ADPM_MONITOR_USER=steward@adpm.local pnpm monitor --workspace=utility-energy --dry-run
```

A scheduled run is still somebody's run. `ADPM_MONITOR_USER` names the human accountable for the
schedule; that user is authorised server-side exactly like an interactive one, and their id is
written to every `AgentAction` the run produces. Without it the script refuses to start.

What it will not do, by construction: approve a gate, commit an artifact version, publish anything,
or run an agent that an admin has not deliberately raised to L3. Findings land as tasks in the
named human's inbox.

To run it nightly at 06:00 (`crontab -e`):

```cron
0 6 * * * cd /path/to/AgenticDataProductManagement && ADPM_MONITOR_USER=steward@adpm.local /path/to/pnpm monitor >> /tmp/adpm-monitor.log 2>&1
```

Use `which pnpm` for the absolute path — cron does not inherit your shell's `PATH`.

---

## 7. Data, backup and reset

| What | Where |
|---|---|
| The database | `prisma/dev.db` (SQLite) |
| Committed artifacts, as plain YAML/Markdown | `workspace/` |
| Agent API key, if you stored one | `.adpm-secrets.json` |
| Environment | `.env` |

None of these are in git. `workspace/` is a git-friendly mirror written on every artifact commit,
so you can diff the whole programme outside the application.

**Back up** by copying `prisma/dev.db` while the server is stopped. **Restore** by copying it back.

```bash
pnpm db:reset      # delete the database and reseed from scratch — destructive, no confirmation
```

`db:reset` deletes `prisma/dev.db` and re-runs the seed. Anything you entered is gone. There is no
undo, because a demo database that quietly kept half your old state would be worse.

Note that nothing inside the application hard-deletes: artifact versions, audit events and agent
actions are append-only, and things that leave circulation are archived. `db:reset` is a
filesystem-level operation, deliberately outside that model.

---

## 8. Tests

```bash
pnpm typecheck        # tsc --noEmit
pnpm lint             # eslint, zero warnings tolerated
pnpm test             # vitest — unit + integration against a separate prisma/test.db
pnpm build            # production build
pnpm pack:validate    # validate every industry pack
```

Integration tests use their own SQLite file and never touch `prisma/dev.db`.

End-to-end tests need a built server with the seeded database:

```bash
pnpm db:seed && pnpm build
PORT=3111 pnpm start &
pnpm test:e2e
```

If your machine has a Chromium that does not match this Playwright version, point at it rather than
downloading another:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome pnpm test:e2e
```

---

## 9. Troubleshooting

**`Environment variable not found: DATABASE_URL`**
`.env` is missing. `cp .env.example .env`, or re-run `pnpm install` which creates it.

**`Error: P1003` / `The table does not exist`**
The database was never created. Run `pnpm db:seed`.

**Prisma client is out of date after switching stores**
`pnpm db:generate` (SQLite) or `pnpm db:pg:setup` (Postgres). The generated client is bound to one
provider at a time.

**Port 3000 is in use**
`PORT=4000 pnpm dev`. Do not kill processes blindly to free it.

**Seed fails with "Stage N does not meet its exit criteria"**
The seed drives the real engine, so this is the engine correctly refusing something in the pack
data — most often a duplicate metric name or a certification claim with no resolving reference. Fix
the pack; do not weaken the criterion. `pnpm pack:validate` catches the common cases first.

**Sign-in fails for every account**
`AUTH_SECRET` changed after sessions were issued. Clear the site cookies and sign in again.

**An agent refuses to run**
Read the message; the runtime states the reason. In order: agents disabled for the workspace, the
agent is not chartered for that stage, its autonomy level is L0 or too low for the trigger, the
workspace budget is exhausted, or your role does not permit invoking agents.

**`pnpm test` interferes with the running app**
It does not — tests use `prisma/test.db`. If you see the demo data change during a test run,
something has overridden `DATABASE_URL`; check your shell environment.

---

## 10. What this is not

ADPM does not execute pipelines, run queries, or connect to a warehouse in any core flow. There is
nothing to deploy alongside it: no scheduler, no message bus, no compute. Stage 3 profiling works on
an uploaded CSV extract precisely so that "we can't get you a warehouse connection" never blocks a
demo or a workshop.

That is also why this document is short. There is no infrastructure here to get wrong.
