import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SOURCE = resolve(process.cwd(), 'prisma/schema.prisma')
const TARGET = resolve(process.cwd(), 'prisma/schema.postgres.prisma')

const BANNER = `// GENERATED FILE — do not edit.
//
// Produced by scripts/prepare-postgres.js from prisma/schema.prisma. Edit the SQLite schema and
// re-run \`pnpm db:pg:prepare\`; any edit made here is lost on the next run.
`

const DATASOURCE = /datasource\s+db\s*\{[^}]*\}/

function main() {
  const source = readFileSync(SOURCE, 'utf8')
  const datasource = source.match(DATASOURCE)

  if (!datasource) {
    throw new Error(`No datasource block found in ${SOURCE}. Cannot derive the Postgres schema.`)
  }

  const output =
    BANNER +
    source.replace(
      DATASOURCE,
      ['datasource db {', '  provider = "postgresql"', '  url      = env("DATABASE_URL")', '}'].join('\n'),
    )

  writeFileSync(TARGET, output, 'utf8')
  console.log(`Wrote ${TARGET}`)
}

main()
