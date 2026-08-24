import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
  const envPath = resolve(process.cwd(), '.env')
  const envContent = `DATABASE_URL="${pgUrl}"\nPOSTGRES_PRISMA_URL="${pgUrl}"\n`
  writeFileSync(envPath, envContent, 'utf8')
  console.log('[prepare-postgres] Set DATABASE_URL in process.env and written to .env')
}

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
  console.log('[prepare-postgres] Configured schema.prisma with provider = "postgresql"')
}
