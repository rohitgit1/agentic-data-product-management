import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dbUrl = process.env.POSTGRES_PRISMA_URL || process.env.DATABASE_URL || ''
const isPostgres = dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://')

console.log(`[build-step] Detected database provider: ${isPostgres ? 'PostgreSQL' : 'SQLite'}`)

if (isPostgres) {
  console.log('[build-step] Preparing PostgreSQL schema and client...')
  execSync('node scripts/prepare-postgres.js', { stdio: 'inherit' })
  try {
    console.log('[build-step] Pushing database schema to PostgreSQL...')
    execSync('npx prisma db push --schema prisma/schema.postgres.prisma --skip-generate --accept-data-loss', { stdio: 'inherit' })
    console.log('[build-step] Seeding PostgreSQL database...')
    execSync('npx tsx prisma/seed.ts', { stdio: 'inherit' })
  } catch (err) {
    console.warn('[build-step] Warning during db push / seed (continuing build):', err.message)
  }
  execSync('npx prisma generate --schema prisma/schema.postgres.prisma', { stdio: 'inherit' })
} else {
  console.log('[build-step] Using SQLite...')
  execSync('npx prisma generate', { stdio: 'inherit' })
}

console.log('[build-step] Running Next.js build...')
execSync('npx next build', { stdio: 'inherit' })
