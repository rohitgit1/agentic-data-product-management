# Hosting Agentic Data Product Management on Netlify

A comprehensive step-by-step guide to deploy ADPM onto Netlify.

---

## 1. Overview & Architecture on Netlify

ADPM is a Next.js (version 15) full-stack application leveraging Server Components, Server Actions, NextAuth v5, and Prisma ORM.

When deploying to Netlify:
- **Frontend & Server Actions:** Managed automatically via Netlify's Next.js Runtime (`@netlify/plugin-nextjs`).
- **Database:** Serverless platforms run statelessly on AWS Lambda. For production or shared deployments, connect a remote PostgreSQL database (such as **Neon**, **Supabase**, or **AWS RDS**).
- **Demo / Preview Mode:** You can also pre-seed a local SQLite database during build or connect directly to a remote Postgres database.

---

## 2. Option 1: Deploying via Netlify Web UI (Recommended)

### Step 1: Connect your GitHub Repository
1. Log into your account at [Netlify](https://app.netlify.com).
2. Click **"Add new site"** > **"Import an existing project"**.
3. Select **GitHub** and authorize Netlify.
4. Select `CloudKatasani/AgenticDataProductManagement`.

### Step 2: Configure Build Settings
Netlify will auto-detect Next.js from `netlify.toml` or `package.json`. Confirm the following settings:
- **Base directory:** (leave blank / root)
- **Build command:** `pnpm db:pg:setup && pnpm build` (if using Postgres) or `pnpm build`
- **Publish directory:** `.next`

### Step 3: Configure Environment Variables
Under **Site configuration** > **Environment variables**, add the following required variables:

| Variable | Recommended Value | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://user:password@host:5432/dbname?sslmode=require` | Connection string to your PostgreSQL database (e.g. Neon, Supabase) |
| `AUTH_SECRET` | `generate-a-32-char-base64-secret` | Generate via `openssl rand -base64 32` or PowerShell `[Convert]::ToBase64String((1..32\|%{Get-Random -Max 256}))` |
| `AUTH_TRUST_HOST` | `true` | Required for NextAuth behind Netlify reverse proxies |
| `ADPM_WORKSPACE_DIR` | `off` | Prevents read-only filesystem errors on serverless lambdas |
| `NODE_VERSION` | `22` | Uses Node.js 22 LTS |
| `ANTHROPIC_API_KEY` | `sk-ant-...` *(optional)* | For agent capabilities (falls back to local heuristic provider if omitted) |

### Step 4: Initialise Database Schema & Seed Data
Before your first login, seed your remote database from your local machine:
```bash
# Set your remote DATABASE_URL in your terminal
export DATABASE_URL="postgresql://..."

# Run PostgreSQL setup and seed
pnpm db:pg:setup
pnpm db:seed:pg
```

### Step 5: Deploy
Click **"Deploy site"**. Once the deployment completes, open your `*.netlify.app` URL and sign in with any seeded account (e.g., `owner@adpm.local` / `adpm`).

---

## 3. Option 2: Deploying via Netlify CLI

You can also deploy directly from your local terminal using the Netlify CLI:

```bash
# 1. Install Netlify CLI globally
npm install -g netlify-cli

# 2. Authenticate
netlify login

# 3. Initialize Netlify project linked to repository
netlify init

# 4. Set Environment Variables
netlify env:set AUTH_SECRET "$(openssl rand -base64 32)"
netlify env:set AUTH_TRUST_HOST "true"
netlify env:set ADPM_WORKSPACE_DIR "off"
netlify env:set NODE_VERSION "22"
netlify env:set DATABASE_URL "postgresql://<user>:<password>@<host>:5432/<db>?sslmode=require"

# 5. Trigger production build & deployment
netlify deploy --build --prod
```

---

## 4. Default Seeded Credentials

| Email | Role | Default Password |
|---|---|---|
| `consumer@adpm.local` | Data Consumer | `adpm` |
| `owner@adpm.local` | Domain Product Owner | `adpm` |
| `steward@adpm.local` | Data Steward | `adpm` |
| `privacy@adpm.local` | Privacy & Security Officer | `adpm` |
| `cdo@adpm.local` | Portfolio Lead / CDO | `adpm` |
| `admin@adpm.local` | Admin | `adpm` |

---

## 5. Troubleshooting & Best Practices

- **Database Connection Pooling:** When using serverless platforms like Netlify with PostgreSQL, use a connection pooler (e.g., Neon connection pooling string or Supabase Transaction Pooler on port 6543) and append `?connection_limit=5` to prevent lambda function connection exhaustion.
- **Build Failures:** Ensure `NODE_VERSION` is set to `22` (or >= `20.11`) in Netlify Environment variables.
