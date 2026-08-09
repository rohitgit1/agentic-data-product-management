# Before you host ADPM anywhere

ADPM was built local-first. Several things that are fine on a laptop are wrong on a server, and one
of them — authentication — is a hard blocker for anything reachable beyond a trusted group.

**None of these changes are in the repository.** This document specifies them; it does not contain
them. It is shared by the [AWS](AWS.md), [Azure](AZURE.md) and [GCP](GCP.md) guides, so it is the
one place to update when any of it stops being true.

For the reference architectures these guides deploy into — and for the build specification behind
them, including the per-table data loading specification — see
[docs/build-spec/](build-spec/README.md).

---

## 1. Blocking for anything other people can reach

| # | Problem | Where | What has to happen |
|---|---------|-------|--------------------|
| **B1** | **There is no user management at all.** No signup, no invitation, no password change, no password reset, no deactivation. The only accounts that exist are the ones `pnpm db:seed` creates, and every one of them has the password `adpm` — which is published in the README and on the sign-in screen. | `prisma/seed.ts:83`, `src/auth.ts:24` (the only place `passwordHash` is read; nothing writes it outside the seed) | Either put the whole thing behind an identity-aware proxy or network access control so only trusted people reach the sign-in page, **or** build user management first: create/invite, set password, rotate, deactivate — plus removing the seeded accounts from any non-demo database. Do not put the seeded accounts on the public internet. Each cloud guide names the proxy option for that platform; they are not equivalent, and the Azure and GCP ones are markedly better than doing it with IP allowlists. |
| **B2** | `AUTH_SECRET` ships as the literal string `adpm-local-development-secret-change-me`. It signs the session JWT. Anyone who knows it can forge a session as any user, including `admin@adpm.local`. | `.env.example` | Generate a real one (`openssl rand -base64 32`) and inject it from the platform's secret store. Never bake it into the image. Keep it **stable across deployments** — changing it invalidates every issued session. |
| **B3** | **The workspace mirror writes to the container filesystem and throws if it cannot.** `commitArtifact()` writes `workspace/<product>/<file>` under `process.cwd()` *after* the database transaction has committed. On a read-only or full filesystem the version **is** saved but the user is told the commit failed — so they write it again. | `src/lib/artifacts/commit.ts:167-177` | Make the mirror configurable and non-fatal. See §4 for the shape. Nothing in the application ever reads the mirror back — it is a git-diff convenience, not a system of record — so disabling it loses no data. |

## 2. Blocking for a containerised or multi-instance deployment

| # | Problem | Where | What has to happen |
|---|---------|-------|--------------------|
| **B4** | Agent API keys saved through Admin are written to `.adpm-secrets.json` in `process.cwd()`. In a container that file is ephemeral and per-instance: it vanishes on redeploy, and with two instances running, one has the key and the other does not. | `src/lib/secrets.ts:18,43` | Use the `ANTHROPIC_API_KEY` environment variable instead — the code already prefers it over the file. Treat the Admin key field as a laptop-only affordance and say so, or hide it when the env var is set. |
| **B5** | There is no `Dockerfile`, and `next.config.ts` does not set `output: 'standalone'`, so a container image has to carry the whole toolchain and `node_modules`. | repo root, `next.config.ts` | Add both. §3 gives working content. |
| **B6** | There is no health-check endpoint. Every managed platform wants one. | `src/app/api/` | Add `GET /api/health` returning 200 with a database round-trip. Until then, point health checks at `/signin`, which returns 200 unauthenticated — but that only proves the process is up, not that the database is reachable. |

## 3. Needs care, not necessarily a code change

| # | Issue | Detail |
|---|-------|--------|
| **C1** | **The Postgres path has never been executed.** `docker-compose.yml`, `scripts/prepare-postgres.ts` and `pnpm db:seed:pg` exist and the schema derivation is exercised, but no Docker daemon was available where this was built, so seeding against a live Postgres has not been run once. SQLite is the tested store. | Run `pnpm db:seed:pg` against a local `docker compose up -d` **before** you provision anything managed. If it fails, fix it there, not against a cloud database. |
| **C2** | **The seed is destructive and demo-only.** It opens with `deleteMany()` across every table and then creates 9 workspaces of fictional products. There is no "bootstrap an empty instance with one real workspace" path. | For a demo box this is exactly what you want — run it once. For anything else you need a bootstrap script that creates one workspace, real roles and real users, and deletes nothing. That does not exist yet. |
| **C3** | SQLite will not work on any of these platforms. Ephemeral container storage loses it on redeploy; a disk works for exactly one instance and makes that instance a pet. | Use the platform's managed Postgres. This is what C1 is about. |
| **C4** | Sessions are JWT (`src/auth.ts:13`), so they are stateless — no sticky sessions, no shared session store. This one is good news. | Nothing to do. Noted because it is the usual multi-instance trap and ADPM avoids it. |
| **C5** | The agent budget cap is per workspace and enforced in-process. Two instances each read-modify-write `agentSpendUsd`, so the cap can be overshot under concurrency. | Immaterial at demo scale. Worth knowing before attaching a real API key to a multi-instance deployment. |
| **C6** | Prisma opens a connection pool **per instance**. A platform that scales to many instances can exhaust a small managed Postgres's connection limit long before it runs out of CPU. | Cap the instance count, and set `connection_limit` in `DATABASE_URL` (e.g. `?connection_limit=5`). Most acute on Cloud Run and Container Apps, which scale aggressively by default. |

---

## 4. The shape of the B3 fix

`mirrorToWorkspace` currently is:

```ts
async function mirrorToWorkspace(relativePath: string, body: string): Promise<void> {
  const absolute = join(process.cwd(), relativePath)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, body, 'utf8')
}
```

It needs to (a) honour an `ADPM_WORKSPACE_DIR` env var, including an `off` value, (b) return a
warning instead of throwing, and (c) have `CommitResult` carry that warning so
`commitArtifactAction` can append it to the success message. The commit itself must still be
reported as a success, because it is one.

Every guide below assumes `ADPM_WORKSPACE_DIR` exists. Without the B3 change that variable does
nothing, and every artifact commit on a container with a read-only or ephemeral filesystem will
report a false failure.

---

## 5. The container build (B5)

Identical on all three clouds.

**Add `output: 'standalone'` to `next.config.ts`:**

```ts
const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',        // <- add this
  serverExternalPackages: ['@prisma/client', 'bcryptjs', 'exceljs', 'docx'],
  typedRoutes: false,
  eslint: { dirs: ['src', 'tests', 'scripts', 'prisma'] },
}
```

`pnpm dev` and `pnpm start` are unaffected; it only adds a `.next/standalone` output directory.

**Add a `Dockerfile` at the repository root:**

```dockerfile
# ---- deps ----
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
COPY scripts/ensure-env.mjs ./scripts/ensure-env.mjs
COPY .env.example ./.env.example
RUN pnpm install --frozen-lockfile

# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Only needs a syntactically valid URL to generate the client; it never connects.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public"
RUN pnpm db:pg:prepare \
 && pnpm exec prisma generate --schema prisma/schema.postgres.prisma \
 && pnpm exec next build

# ---- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
ENV ADPM_WORKSPACE_DIR=off
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/prisma/schema.postgres.prisma ./prisma/schema.prisma
COPY --from=build /app/node_modules/.prisma/client ./node_modules/.prisma/client
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

`PORT` is read from the environment, which matters: Cloud Run and App Service both inject their own
port and expect the container to honour it. The Next standalone server does.

**Add a `.dockerignore`,** or the build context carries your local database and secrets:

```
node_modules
.next
.git
.env
.adpm-secrets.json
*.db
prisma/dev.db*
prisma/test.db*
prisma/schema.postgres.prisma
workspace/*
playwright-report
test-results
```

**Prove it locally before pushing it to any registry:**

```bash
docker compose up -d          # local Postgres, per DEPLOYMENT.md §4
pnpm db:seed:pg               # this is C1 — do not skip it
docker build -t adpm:local .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL="postgresql://adpm:adpm-local-development@host.docker.internal:5432/adpm?schema=public" \
  -e AUTH_SECRET="$(openssl rand -base64 32)" \
  -e AUTH_TRUST_HOST=true \
  adpm:local
```

If that does not produce a working app, stop. Fix it locally, where the feedback loop is seconds.

---

## 6. Environment variables, on any platform

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Managed Postgres. Consider `?connection_limit=5` (C6). Inject from the secret store — it contains the password. |
| `AUTH_SECRET` | yes | From the secret store. Stable across deploys (B2). |
| `AUTH_TRUST_HOST` | yes | `true`. Auth.js v5 requires it behind a proxy or load balancer. |
| `PORT` | platform-set | Honour whatever the platform injects. |
| `ADPM_WORKSPACE_DIR` | recommended | A writable persistent path, or `off`. Requires B3. |
| `ANTHROPIC_API_KEY` | optional | Only if agents use a real model. From the secret store, never the Admin field (B4). |
| `ADPM_MONITOR_USER` | optional | Scheduled-monitoring job only. The email of the human accountable for the schedule. |

---

## 7. What is true regardless of cloud

- **Run the database push and the seed as one-off administrative jobs**, never from the web
  container. The seed can delete every table (C2); nothing that destructive should be one HTTP
  handler away from a user.
- **Serve it over HTTPS.** Auth.js sets a session cookie. Over plain HTTP that cookie is the whole
  session, readable by anyone on the path.
- **The database is the system of record.** Every gate decision, artifact version and agent action
  is append-only and queryable there. Platform logs are for process health, not governance
  evidence. Back up the database; the workspace mirror needs no backup.
- **Agents are optional and off by default.** The simplest hosted deployment leaves them off and is
  complete. With no API key they fall back to the deterministic local provider and make no network
  call — which means no egress path is needed at all.
