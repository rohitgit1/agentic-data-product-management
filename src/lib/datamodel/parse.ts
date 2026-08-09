/**
 * A reader for the subset of Prisma schema syntax this project uses.
 *
 * The Data model tab renders the parsed result rather than a transcription, so the documentation
 * cannot drift from prisma/schema.prisma: adding a column changes the page with no second edit.
 * The parser is deliberately narrow — it understands models, fields, relations, defaults and the
 * `@@id` / `@@unique` / `@@index` block attributes, and nothing else.
 */

export const SCALAR_TYPES = [
  'String',
  'Int',
  'Float',
  'Boolean',
  'DateTime',
  'Json',
  'BigInt',
  'Bytes',
  'Decimal',
] as const

export type ScalarType = (typeof SCALAR_TYPES)[number]

export interface ParsedRelation {
  /** The disambiguating name in `@relation("ProductOwner", …)`, when the schema gives one. */
  name: string | null
  /** Columns on this model holding the foreign key. Empty on the back-reference side. */
  fields: string[]
  /** Columns on the referenced model. Empty on the back-reference side. */
  references: string[]
}

export interface ParsedField {
  name: string
  type: string
  list: boolean
  optional: boolean
  isId: boolean
  isUnique: boolean
  /** The literal text inside `@default(…)`, or null when the column has no default. */
  default: string | null
  updatedAt: boolean
  /** Non-null exactly when `type` names another model. */
  relation: ParsedRelation | null
  /** The `///` comment above the field, when there is one. */
  doc: string
}

export interface ParsedModel {
  name: string
  /** The `///` comment above the model, when there is one. */
  doc: string
  fields: ParsedField[]
  /** Primary key columns, whether declared with `@id` or `@@id([…])`. */
  primaryKey: string[]
  uniques: string[][]
  indexes: string[][]
}

export interface ParsedSchema {
  provider: string
  models: ParsedModel[]
}

const MODEL_OPEN = /^model\s+(\w+)\s*\{$/
const FIELD = /^(\w+)\s+(\w+)(\[\]|\?)?\s*(.*)$/
const BLOCK_ATTRIBUTE = /^@@(\w+)\s*\(\s*\[([^\]]*)\]/
const PROVIDER = /^provider\s*=\s*"([^"]+)"$/

/** Reads the argument list of `@name(…)`, matching parentheses so quoted commas survive. */
function attributeArgs(source: string, name: string): string | null {
  const marker = `@${name}`
  let index = source.indexOf(marker)
  while (index !== -1) {
    const after = index + marker.length
    // `@id` must not match inside `@identity`; `@default` must not match `@defaults`.
    const next = source[after]
    if (next === undefined || next === '(' || /[\s@]/.test(next)) {
      if (next !== '(') return ''
      let depth = 0
      let quoted = false
      for (let cursor = after; cursor < source.length; cursor += 1) {
        const char = source[cursor]
        if (quoted) {
          if (char === '"') quoted = false
          continue
        }
        if (char === '"') quoted = true
        else if (char === '(') depth += 1
        else if (char === ')') {
          depth -= 1
          if (depth === 0) return source.slice(after + 1, cursor)
        }
      }
      return ''
    }
    index = source.indexOf(marker, after)
  }
  return null
}

function hasAttribute(source: string, name: string): boolean {
  return attributeArgs(source, name) !== null
}

function listArg(args: string, key: string): string[] {
  const match = new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(args)
  return columnList(match?.[1] ?? '')
}

function quotedName(args: string): string | null {
  return /^\s*"([^"]*)"/.exec(args)?.[1] ?? null
}

function columnList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/** Model names, needed before field parsing so a relation field can be told from a scalar. */
function modelNames(lines: string[]): Set<string> {
  const names = new Set<string>()
  for (const line of lines) {
    const name = MODEL_OPEN.exec(line.trim())?.[1]
    if (name) names.add(name)
  }
  return names
}

export function parsePrismaSchema(source: string): ParsedSchema {
  const lines = source.split('\n')
  const names = modelNames(lines)

  let provider = 'unknown'
  let inDatasource = false
  let current: ParsedModel | null = null
  let doc = ''
  const models: ParsedModel[] = []

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (line.startsWith('///')) {
      doc = doc ? `${doc} ${line.slice(3).trim()}` : line.slice(3).trim()
      continue
    }
    if (!line || line.startsWith('//')) continue

    if (current === null) {
      if (line.startsWith('datasource ')) {
        inDatasource = true
        continue
      }
      if (inDatasource) {
        const declared = PROVIDER.exec(line)?.[1]
        if (declared) provider = declared
        if (line === '}') inDatasource = false
        continue
      }
      const opened = MODEL_OPEN.exec(line)?.[1]
      if (opened) {
        current = { name: opened, doc, fields: [], primaryKey: [], uniques: [], indexes: [] }
        doc = ''
        continue
      }
      doc = ''
      continue
    }

    if (line === '}') {
      models.push(current)
      current = null
      doc = ''
      continue
    }

    const block = BLOCK_ATTRIBUTE.exec(line)
    if (block) {
      const columns = columnList(block[2] ?? '')
      if (block[1] === 'id') current.primaryKey = columns
      else if (block[1] === 'unique') current.uniques.push(columns)
      else if (block[1] === 'index') current.indexes.push(columns)
      doc = ''
      continue
    }
    if (line.startsWith('@@')) {
      doc = ''
      continue
    }

    const field = FIELD.exec(line)
    const name = field?.[1]
    const type = field?.[2]
    if (!name || !type) {
      doc = ''
      continue
    }
    const modifier = field?.[3] ?? ''
    const attributes = field?.[4] ?? ''
    const relationArgs = attributeArgs(attributes, 'relation')
    const isRelation = names.has(type)
    const parsed: ParsedField = {
      name,
      type,
      list: modifier === '[]',
      optional: modifier === '?',
      isId: hasAttribute(attributes, 'id'),
      isUnique: hasAttribute(attributes, 'unique'),
      default: attributeArgs(attributes, 'default'),
      updatedAt: hasAttribute(attributes, 'updatedAt'),
      relation: isRelation
        ? {
            name: relationArgs ? quotedName(relationArgs) : null,
            fields: relationArgs ? listArg(relationArgs, 'fields') : [],
            references: relationArgs ? listArg(relationArgs, 'references') : [],
          }
        : null,
      doc,
    }
    doc = ''
    current.fields.push(parsed)
    if (parsed.isId) current.primaryKey = [name]
  }

  return { provider, models }
}

/** One foreign key, read from the side that holds it. */
export interface RelationEdge {
  /** The model holding the foreign key column. */
  from: string
  /** The referenced model. */
  to: string
  /** The relation field on `from`. */
  field: string
  foreignKeys: string[]
  optional: boolean
  /** True when the foreign key is unique, which makes the relation one-to-one. */
  unique: boolean
  /** The back-reference field on `to`, when the schema declares one. */
  backReference: string | null
}

function isUniqueColumn(model: ParsedModel, columns: string[]): boolean {
  if (columns.length === 1) {
    const field = model.fields.find((candidate) => candidate.name === columns[0])
    if (field?.isUnique) return true
  }
  return model.uniques.some(
    (unique) =>
      unique.length === columns.length && unique.every((column) => columns.includes(column)),
  )
}

export function relationEdges(schema: ParsedSchema): RelationEdge[] {
  const byName = new Map(schema.models.map((model) => [model.name, model]))
  const edges: RelationEdge[] = []

  for (const model of schema.models) {
    for (const field of model.fields) {
      if (!field.relation || field.relation.fields.length === 0) continue
      const target = byName.get(field.type)
      const backReference =
        target?.fields.find(
          (candidate) =>
            candidate.type === model.name &&
            candidate.relation !== null &&
            candidate.relation.fields.length === 0 &&
            candidate.relation.name === field.relation?.name,
        )?.name ?? null
      edges.push({
        from: model.name,
        to: field.type,
        field: field.name,
        foreignKeys: field.relation.fields,
        optional: field.optional,
        unique: isUniqueColumn(model, field.relation.fields),
        backReference,
      })
    }
  }

  return edges
}

export function scalarFields(model: ParsedModel): ParsedField[] {
  return model.fields.filter((field) => field.relation === null)
}

export function countColumns(schema: ParsedSchema): number {
  return schema.models.reduce((total, model) => total + scalarFields(model).length, 0)
}
