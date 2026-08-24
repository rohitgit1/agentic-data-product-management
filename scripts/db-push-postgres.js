import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return
  try {
    const content = readFileSync(filePath, 'utf8')
    content.split('\n').forEach((line) => {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) {
        const idx = trimmed.indexOf('=')
        if (idx > 0) {
          const key = trimmed.slice(0, idx).trim()
          let val = trimmed.slice(idx + 1).trim()
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1)
          }
          if (!process.env[key] || process.env[key].startsWith('file:')) {
            process.env[key] = val
          }
        }
      }
    })
  } catch {}
}

loadEnvFile(resolve(process.cwd(), '.vercel/.env.production.local'))
loadEnvFile(resolve(process.cwd(), '.env'))

const candidates = [
  process.env.POSTGRES_PRISMA_URL,
  process.env.POSTGRES_URL,
  process.env.POSTGRES_URL_NON_POOLING,
  process.env.DATABASE_URL_UNPOOLED,
  process.env.DATABASE_URL,
]

const pgUrl = candidates.find(
  (url) => url && (url.startsWith('postgres://') || url.startsWith('postgresql://'))
)

if (pgUrl) {
  process.env.DATABASE_URL = pgUrl
  console.log('[db-push-postgres] Overriding process.env.DATABASE_URL with PostgreSQL URL')
} else {
  console.warn('[db-push-postgres] Warning: No PostgreSQL URL found in environment variables')
}

// Force schema.prisma provider to postgresql if cloud/postgres
const isCloudOrPostgres =
  Boolean(process.env.VERCEL) ||
  Boolean(process.env.NETLIFY) ||
  Boolean(process.env.CI) ||
  Boolean(pgUrl)

if (isCloudOrPostgres) {
  const SOURCE = resolve(process.cwd(), 'prisma/schema.prisma')
  const DATASOURCE = /datasource\s+db\s*\{[^}]*\}/
  const source = readFileSync(SOURCE, 'utf8')

  const updated = source.replace(
    DATASOURCE,
    ['datasource db {', '  provider = "postgresql"', '  url      = env("DATABASE_URL")', '}'].join('\n')
  )

  writeFileSync(SOURCE, updated, 'utf8')
  console.log('[db-push-postgres] Configured schema.prisma with provider = "postgresql"')
}

console.log('[db-push-postgres] Pushing schema to database...')
try {
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    stdio: 'inherit',
    env: process.env,
  })
} catch (err) {
  console.warn('[db-push-postgres] Warning during db push:', err.message)
}

console.log('[db-push-postgres] Running seed script...')
try {
  execSync('npx tsx prisma/seed.ts', {
    stdio: 'inherit',
    env: process.env,
  })
} catch (err) {
  console.warn('[db-push-postgres] Warning during seed:', err.message)
}
