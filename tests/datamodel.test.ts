import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parsePrismaSchema, relationEdges, type ParsedField } from '@/lib/datamodel/parse'
import {
  ENUMERATIONS,
  INVARIANT_ANCHORS,
  MODEL_GROUPS,
  MODEL_NOTES,
  SCHEMA_PATH,
  SPINE_MODELS,
  buildDataModel,
  erDiagram,
} from '@/lib/datamodel/registry'

const source = readFileSync(SCHEMA_PATH, 'utf8')
const dataModel = buildDataModel(source)
const byName = new Map(dataModel.schema.models.map((model) => [model.name, model]))

/** Looks up a `Model.field` reference, as the annotations write them. */
function fieldFor(column: string): ParsedField | undefined {
  const [modelName, fieldName] = column.split('.')
  if (!modelName || !fieldName) return undefined
  return byName.get(modelName)?.fields.find((field) => field.name === fieldName)
}

describe('prisma schema parser', () => {
  it('reads the datasource provider', () => {
    expect(dataModel.schema.provider).toBe('sqlite')
  })

  it('reads every model declared in the file', () => {
    const declared = source.split('\n').filter((line) => /^model\s+\w+\s*\{$/.test(line.trim()))
    expect(dataModel.schema.models).toHaveLength(declared.length)
  })

  it('reads columns, keys, defaults and doc comments', () => {
    const gate = byName.get('Gate')
    expect(gate?.primaryKey).toEqual(['id'])
    expect(gate?.fields.find((f) => f.name === 'state')?.default).toBe('"PENDING"')
    expect(gate?.fields.find((f) => f.name === 'stageRunId')?.isUnique).toBe(true)
    expect(gate?.fields.find((f) => f.name === 'staleAt')?.optional).toBe(true)
    expect(gate?.indexes).toContainEqual(['productId', 'stageNumber'])
    expect(gate?.doc).toContain('recordDecision')
  })

  it('reads a non-cuid primary key', () => {
    expect(byName.get('Stage')?.primaryKey).toEqual(['number'])
  })

  it('reads multi-column unique constraints', () => {
    expect(byName.get('RoleAssignment')?.uniques).toContainEqual([
      'userId',
      'roleId',
      'workspaceId',
      'domainId',
    ])
  })

  it('separates relation fields from scalars', () => {
    const product = byName.get('DataProduct')
    expect(product?.fields.find((f) => f.name === 'workspaceId')?.relation).toBeNull()
    expect(product?.fields.find((f) => f.name === 'workspace')?.relation).toEqual({
      name: null,
      fields: ['workspaceId'],
      references: ['id'],
    })
    expect(product?.fields.find((f) => f.name === 'owner')?.relation?.name).toBe('ProductOwner')
    expect(product?.fields.find((f) => f.name === 'stageRuns')?.list).toBe(true)
  })
})

describe('relation edges', () => {
  const edges = relationEdges(dataModel.schema)

  it('reads the foreign key side only, once per relation', () => {
    const workspaceToDomain = edges.filter((e) => e.from === 'Domain' && e.to === 'Workspace')
    expect(workspaceToDomain).toHaveLength(1)
    expect(workspaceToDomain.at(0)?.backReference).toBe('domains')
    expect(workspaceToDomain.at(0)?.unique).toBe(false)
  })

  it('detects one-to-one relations from a unique foreign key', () => {
    const gateToRun = edges.find((e) => e.from === 'Gate' && e.to === 'StageRun')
    expect(gateToRun?.unique).toBe(true)
    const productToRequest = edges.find((e) => e.from === 'DataProduct' && e.to === 'ProductRequest')
    expect(productToRequest?.unique).toBe(true)
    expect(productToRequest?.optional).toBe(true)
  })

  it('keeps named relations to the same model apart', () => {
    const toUser = edges.filter((e) => e.from === 'DataProduct' && e.to === 'User')
    expect(toUser.map((e) => e.field).sort()).toEqual(['owner', 'steward'])
    expect(toUser.find((e) => e.field === 'owner')?.backReference).toBe('ownedProducts')
    expect(toUser.find((e) => e.field === 'steward')?.optional).toBe(true)
  })

  it('holds a foreign key column that exists, pointing at a model that exists', () => {
    for (const edge of edges) {
      expect(
        byName.has(edge.to),
        `${edge.from}.${edge.field} references unknown model ${edge.to}`,
      ).toBe(true)
      const owner = byName.get(edge.from)
      expect(edge.foreignKeys.length).toBeGreaterThan(0)
      for (const key of edge.foreignKeys) {
        expect(owner?.fields.some((field) => field.name === key), `${edge.from}.${key}`).toBe(true)
      }
    }
  })
})

describe('data model reading notes', () => {
  it('annotates every table, and annotates nothing that no longer exists', () => {
    expect(dataModel.unannotated).toEqual([])
    expect(dataModel.orphanedNotes).toEqual([])
  })

  it('places every table in exactly one group', () => {
    const grouped = dataModel.groups.flatMap((entry) => entry.models.map((m) => m.model.name))
    expect(new Set(grouped).size).toBe(grouped.length)
    expect(grouped).toHaveLength(dataModel.schema.models.length)
  })

  it('uses only declared group keys', () => {
    const keys = new Set(MODEL_GROUPS.map((group) => group.key))
    for (const note of MODEL_NOTES) expect(keys.has(note.group)).toBe(true)
  })

  it('marks as append-only every table whose schema comment says so', () => {
    for (const model of dataModel.schema.models) {
      if (!/append-only/i.test(model.doc)) continue
      const annotated = dataModel.models.find((entry) => entry.model.name === model.name)
      expect(annotated?.appendOnly, `${model.name} is append-only in the schema`).toBe(true)
    }
  })

  it('names real tables in the spine and in the invariant anchors', () => {
    for (const name of SPINE_MODELS) expect(byName.has(name)).toBe(true)
    for (const anchor of INVARIANT_ANCHORS) {
      for (const carrier of anchor.carriedBy) {
        const [modelName, fieldName] = carrier.split('.')
        const model = modelName ? byName.get(modelName) : undefined
        if (!model) continue // prose entries such as "archivedAt columns"
        if (fieldName) {
          expect(
            model.fields.some((candidate) => candidate.name === fieldName),
            `${carrier} is not a column`,
          ).toBe(true)
        }
      }
    }
  })
})

describe('enumerated columns', () => {
  it('maps every enumeration onto a string column that exists', () => {
    for (const enumeration of ENUMERATIONS) {
      expect(enumeration.values.length).toBeGreaterThan(0)
      for (const column of enumeration.columns) {
        const field = fieldFor(column)
        expect(field, `${column} does not exist`).toBeDefined()
        expect(field?.type, `${column} is not a string column`).toBe('String')
      }
    }
  })

  it('does not claim the same column for two enumerations', () => {
    const columns = ENUMERATIONS.flatMap((enumeration) => enumeration.columns)
    expect(new Set(columns).size).toBe(columns.length)
  })

  it('keeps every column default inside its enumeration', () => {
    for (const enumeration of ENUMERATIONS) {
      for (const column of enumeration.columns) {
        const value = fieldFor(column)?.default
        if (!value) continue
        expect(enumeration.values, `${column} defaults outside its enumeration`).toContain(
          value.replace(/^"(.*)"$/, '$1'),
        )
      }
    }
  })
})

describe('entity-relationship diagrams', () => {
  it('draws only the requested models and reports the relations it left out', () => {
    const { chart, external } = erDiagram(dataModel, ['Gate', 'Approval', 'GateEvidence'])
    expect(chart.startsWith('erDiagram')).toBe(true)
    expect(chart).toContain('Gate ||--o{ Approval : gate')
    expect(chart).toContain('Gate ||--o{ GateEvidence : gate')
    expect(chart).not.toContain('DataProduct {')
    expect(external.some((edge) => edge.to === 'DataProduct')).toBe(true)
  })

  it('gives every entity at least its primary key, so no block is empty', () => {
    for (const { group, models } of dataModel.groups) {
      const { chart } = erDiagram(
        dataModel,
        models.map((entry) => entry.model.name),
      )
      for (const entry of models) {
        expect(chart, `${group.key} diagram is missing ${entry.model.name}`).toContain(
          `${entry.model.name} {`,
        )
      }
      expect(chart).not.toContain('{\n  }')
    }
  })

  it('marks an optional foreign key as zero-or-one on the parent side', () => {
    const { chart } = erDiagram(dataModel, ['DataProduct', 'ProductRequest'])
    expect(chart).toContain('ProductRequest |o--o| DataProduct : request')
  })
})

describe('schema parsing edge cases', () => {
  it('reads defaults containing brackets, quotes and function calls', () => {
    const parsed = parsePrismaSchema(`
datasource db {
  provider = "sqlite"
}

/// A doc comment.
model Sample {
  id       String   @id @default(cuid())
  listJson String   @default("[]")
  mapJson  String   @default("{}")
  count    Int      @default(0)
  at       DateTime @default(now())
  touched  DateTime @updatedAt
  optional String?

  @@index([count])
}
`)
    const model = parsed.models.at(0)
    expect(model?.doc).toBe('A doc comment.')
    expect(model?.fields.find((f) => f.name === 'listJson')?.default).toBe('"[]"')
    expect(model?.fields.find((f) => f.name === 'mapJson')?.default).toBe('"{}"')
    expect(model?.fields.find((f) => f.name === 'at')?.default).toBe('now()')
    expect(model?.fields.find((f) => f.name === 'touched')?.updatedAt).toBe(true)
    expect(model?.fields.find((f) => f.name === 'count')?.isId).toBe(false)
    expect(model?.fields.find((f) => f.name === 'optional')?.optional).toBe(true)
    expect(model?.indexes).toEqual([['count']])
  })
})
