import { execSync } from 'node:child_process'

console.log('[build-step] Pushing schema to PostgreSQL database...')
try {
  execSync('npx prisma db push --skip-generate --accept-data-loss', { stdio: 'inherit' })
  console.log('[build-step] Seeding PostgreSQL database...')
  execSync('npx tsx prisma/seed.ts', { stdio: 'inherit' })
} catch (err) {
  console.warn('[build-step] Note on db push/seed:', err.message)
}

console.log('[build-step] Generating Prisma client for PostgreSQL...')
execSync('npx prisma generate', { stdio: 'inherit' })

console.log('[build-step] Running Next.js build...')
execSync('npx next build', { stdio: 'inherit' })
