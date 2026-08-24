import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const file = resolve(process.cwd(), '.vercel/.env.production.local')
if (!existsSync(file)) {
  console.log('No .vercel/.env.production.local file found')
  process.exit(0)
}

const content = readFileSync(file, 'utf8')
const env = {}
content.split('\n').forEach((l) => {
  const idx = l.indexOf('=')
  if (idx > 0) {
    const k = l.slice(0, idx).trim()
    let v = l.slice(idx + 1).trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    env[k] = v
  }
})

const host = env.PGHOST || env.POSTGRES_HOST
const user = env.PGUSER || env.POSTGRES_USER
const pass = env.PGPASSWORD || env.POSTGRES_PASSWORD
const db = env.PGDATABASE || env.POSTGRES_DATABASE || 'neondb'

if (host && user && pass && !host.includes('[SENSITIVE]')) {
  const url = `postgresql://${user}:${pass}@${host}/${db}?sslmode=require`
  console.log('[sync-env] Successfully constructed PostgreSQL connection string!')
  const envContent = `DATABASE_URL="${url}"\nPOSTGRES_PRISMA_URL="${url}"\nAUTH_SECRET="adpm-local-development-secret-change-me"\nAUTH_TRUST_HOST=true\n`
  writeFileSync(resolve(process.cwd(), '.env'), envContent, 'utf8')
} else {
  console.log('[sync-env] Credentials check:', {
    host: host ? (host.includes('[SENSITIVE]') ? 'SENSITIVE' : 'OK') : 'MISSING',
    user: user ? (user.includes('[SENSITIVE]') ? 'SENSITIVE' : 'OK') : 'MISSING',
  })
}
