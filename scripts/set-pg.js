import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SOURCE = resolve(process.cwd(), 'prisma/schema.prisma')
const TARGET = resolve(process.cwd(), 'prisma/schema.postgres.prisma')

const DATASOURCE = /datasource\s+db\s*\{[^}]*\}/

const source = readFileSync(SOURCE, 'utf8')
const output = source.replace(
  DATASOURCE,
  ['datasource db {', '  provider = "postgresql"', '  url      = env("DATABASE_URL")', '}'].join('\n'),
)

writeFileSync(SOURCE, output, 'utf8')
writeFileSync(TARGET, output, 'utf8')
console.log('Set prisma/schema.prisma provider to postgresql')
