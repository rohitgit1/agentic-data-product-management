import { execSync } from 'node:child_process'

const candidates = [
  process.env.POSTGRES_PRISMA_URL,
  process.env.POSTGRES_URL,
  process.env.POSTGRES_URL_NON_POOLING,
  process.env.DATABASE_URL_UNPOOLED,
  process.env.DATABASE_URL,
]

let pgUrl = candidates.find(
  (url) => url && (url.startsWith('postgres://') || url.startsWith('postgresql://'))
)

if (pgUrl) {
  process.env.DATABASE_URL = pgUrl
  console.log('[build-step] Using PostgreSQL database URL for build and seed.')
} else {
  console.warn('[build-step] Warning: No PostgreSQL URL found in environment variables.')
}

console.log('[build-step] Pushing schema to PostgreSQL database...')
try {
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    stdio: 'inherit',
    env: process.env,
  })
  console.log('[build-step] Seeding PostgreSQL database...')
  execSync('npx tsx prisma/seed.ts', { stdio: 'inherit', env: process.env })
} catch (err) {
  console.warn('[build-step] Note on db push/seed:', err.message)
}

console.log('[build-step] Generating Prisma client for PostgreSQL...')
execSync('npx prisma generate', { stdio: 'inherit', env: process.env })

console.log('[build-step] Running Next.js build...')
execSync('npx next build', { stdio: 'inherit', env: process.env })
