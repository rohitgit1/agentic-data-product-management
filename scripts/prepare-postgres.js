import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dbUrl = process.env.POSTGRES_PRISMA_URL || process.env.DATABASE_URL || ''
const isPostgres = dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://')

if (isPostgres) {
  const SOURCE = resolve(process.cwd(), 'prisma/schema.prisma')
  const TARGET = resolve(process.cwd(), 'prisma/schema.postgres.prisma')

  const BANNER = `// GENERATED FILE — do not edit.
//
// Produced by scripts/prepare-postgres.js from prisma/schema.prisma. Edit the SQLite schema and
// re-run \`pnpm db:pg:prepare\`; any edit made here is lost on the next run.
`

  const DATASOURCE = /datasource\s+db\s*\{[^}]*\}/

  const source = readFileSync(SOURCE, 'utf8')
  if (source.includes('provider = "sqlite"')) {
    const output =
      BANNER +
      source.replace(
        DATASOURCE,
        ['datasource db {', '  provider = "postgresql"', '  url      = env("DATABASE_URL")', '}'].join('\n'),
      )

    writeFileSync(SOURCE, output, 'utf8')
    writeFileSync(TARGET, output, 'utf8')
    console.log('[prepare-postgres] Updated schema.prisma for PostgreSQL')
  }
} else {
  console.log('[prepare-postgres] Retaining SQLite schema.prisma')
}
