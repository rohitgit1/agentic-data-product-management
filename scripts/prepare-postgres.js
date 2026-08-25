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
  const envPath = resolve(process.cwd(), '.env')
  const envContent = `DATABASE_URL="${pgUrl}"\nPOSTGRES_PRISMA_URL="${pgUrl}"\n`
  writeFileSync(envPath, envContent, 'utf8')
  console.log('[prepare-postgres] Set DATABASE_URL in process.env and written to .env')
}

const isCloudOrPostgres = Boolean(pgUrl)

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
