import { parseCsv } from '@/lib/profiling/csv'
import {
  emptyExternalMetadata,
  externalMetadataSchema,
  type ExternalMetadata,
  type ExternalEntity,
  type ExternalLineageEdge,
} from './schema'

/**
 * Per-tool parsers. Each maps a documented export shape onto the canonical schema; the canonical
 * format has no mapping at all. Everything ends up validated by `externalMetadataSchema`, so a
 * parser that produces nonsense fails here rather than in an agent's context.
 */

export class ImportError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message)
    this.name = 'ImportError'
  }
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new ImportError(
      `That is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`,
    )
  }
}

/** Case- and space-insensitive header lookup, because export templates vary. */
function column(row: Record<string, string>, ...candidates: string[]): string {
  const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const map = new Map(Object.entries(row).map(([k, v]) => [normalise(k), v]))
  for (const candidate of candidates) {
    const value = map.get(normalise(candidate))
    if (value !== undefined && value !== '') return value.trim()
  }
  return ''
}

function truthy(value: string): boolean {
  return ['y', 'yes', 'true', '1', 'pk', 'primary key', 'not null'].includes(value.toLowerCase())
}

/**
 * erwin Data Modeler — Bulk Editor / Report Designer CSV.
 *
 * One row per attribute, entity repeated. Relationship rows are recognised by carrying a parent
 * and child entity instead of an attribute, so a single combined export works too.
 */
export function parseErwinCsv(text: string): ExternalMetadata {
  const { headers, rows: dataRows } = parseCsv(text)
  if (dataRows.length === 0) throw new ImportError('The erwin export has no rows.')
  const rows = dataRows.map((cells) =>
    Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])),
  )

  const metadata = emptyExternalMetadata()
  const entities = new Map<string, ExternalEntity>()

  for (const row of rows) {
    const parent = column(row, 'Parent Entity', 'ParentEntity', 'Parent')
    const child = column(row, 'Child Entity', 'ChildEntity', 'Child')
    if (parent && child) {
      const cardinality = column(row, 'Cardinality', 'Relationship Type', 'Type').toLowerCase()
      metadata.relationships.push({
        from: parent,
        to: child,
        cardinality: cardinality.includes('many to many')
          ? 'MANY_TO_MANY'
          : cardinality.includes('one to one')
            ? 'ONE_TO_ONE'
            : 'ONE_TO_MANY',
        description: column(row, 'Relationship Name', 'Verb Phrase', 'Description'),
      })
      continue
    }

    const entityName = column(row, 'Entity', 'Entity Name', 'Table', 'Table Name')
    if (!entityName) continue
    const entity = entities.get(entityName) ?? {
      name: entityName,
      description: column(row, 'Entity Definition', 'Entity Description', 'Definition'),
      attributes: [],
    }
    entities.set(entityName, entity)

    const attributeName = column(row, 'Attribute', 'Attribute Name', 'Column', 'Column Name')
    if (!attributeName) continue
    entity.attributes.push({
      name: attributeName,
      datatype: column(row, 'Datatype', 'Data Type', 'Physical Data Type', 'Domain'),
      // erwin writes "NOT NULL" / "NULL" in the Null Option column.
      nullable: !truthy(column(row, 'Null Option', 'Nullable', 'Null')),
      isKey: truthy(column(row, 'Primary Key', 'PK', 'Key Type')),
      description: column(row, 'Attribute Definition', 'Attribute Description', 'Comment'),
    })
  }

  metadata.entities = [...entities.values()]
  if (metadata.entities.length === 0 && metadata.relationships.length === 0) {
    throw new ImportError(
      'No entities or relationships were recognised.',
      ['Expected an Entity column, or a Parent Entity and Child Entity pair. Column headings vary by erwin report template — check yours against the export instructions.'],
    )
  }
  return externalMetadataSchema.parse(metadata)
}

interface CollibraAsset {
  name?: string
  displayName?: string
  type?: string | { name?: string }
  description?: string
  status?: string | { name?: string }
  steward?: string
  owner?: string
  attributes?: Record<string, unknown>
  relations?: {
    target?: string
    name?: string
    /** Collibra names the relation type, e.g. "sources / is sourced by", "Data Flow". */
    type?: string | { name?: string }
    /** Which end of the relation the target sits on. */
    direction?: string
    transformation?: string
  }[]
}

interface CollibraExport {
  results?: CollibraAsset[]
  /** Some lineage exports ship a separate edge list rather than per-asset relations. */
  lineage?: {
    from?: string
    source?: string
    to?: string
    target?: string
    fromSystem?: string
    toSystem?: string
    transformation?: string
    description?: string
  }[]
}

/**
 * Whether a Collibra relation describes data movement rather than, say, stewardship or a glossary
 * mapping. Matched on the documented relation-type vocabulary; anything unrecognised is ignored
 * rather than guessed at, because a wrong lineage edge is worse than a missing one — it tells an
 * architect a dependency exists that does not.
 */
function isLineageRelation(type: string): boolean {
  const normalised = type.toLowerCase()
  return (
    normalised.includes('lineage') ||
    normalised.includes('data flow') ||
    normalised.includes('dataflow') ||
    normalised.includes('sources') ||
    normalised.includes('sourced by') ||
    normalised.includes('source for') ||
    normalised.includes('targets') ||
    normalised.includes('feeds')
  )
}

/** Bronze/Silver/Gold if the object name says so. Used to keep physical names out of grounding. */
function layerFromName(name: string): 'BRONZE' | 'SILVER' | 'GOLD' | 'UNKNOWN' {
  const normalised = name.toLowerCase()
  if (/(^|[^a-z])bronze([^a-z]|$)|(^|_)raw([^a-z]|$)|(^|_)stg([^a-z]|$)/.test(normalised)) return 'BRONZE'
  if (/(^|[^a-z])silver([^a-z]|$)|(^|_)cleansed([^a-z]|$)/.test(normalised)) return 'SILVER'
  if (/(^|[^a-z])gold([^a-z]|$)|(^|_)mart([^a-z]|$)|(^|_)serving([^a-z]|$)/.test(normalised)) return 'GOLD'
  return 'UNKNOWN'
}

function nameOf(value: string | { name?: string } | undefined): string {
  if (!value) return ''
  return typeof value === 'string' ? value : (value.name ?? '')
}

/** Collibra — asset export JSON (an array of assets, or `{ results: [...] }`). */
export function parseCollibraJson(text: string): ExternalMetadata {
  const raw = readJson(text)
  const payload: CollibraExport = Array.isArray(raw) ? { results: raw as CollibraAsset[] } : (raw as CollibraExport)
  const assets: CollibraAsset[] = payload.results ?? []
  if (assets.length === 0 && (payload.lineage ?? []).length === 0) {
    throw new ImportError('No assets found.', ['Expected a JSON array of assets, or an object with a "results" array.'])
  }

  const metadata = emptyExternalMetadata()

  // An export may describe the same hop twice — once as a per-asset relation and once in a
  // top-level edge list. Both are read, but a hop is recorded once: a duplicated edge inflates
  // the dependency count an architect is reading and says nothing new.
  const seenEdges = new Set<string>()
  const addEdge = (edge: ExternalLineageEdge) => {
    const key = `${edge.from}->${edge.to}`
    if (seenEdges.has(key)) return
    seenEdges.add(key)
    metadata.lineage.push(edge)
  }

  // A standalone edge list, when the export ships one.
  for (const edge of payload.lineage ?? []) {
    const from = (edge.from ?? edge.source ?? '').trim()
    const to = (edge.to ?? edge.target ?? '').trim()
    if (!from || !to) continue
    addEdge({
      from,
      to,
      fromSystem: edge.fromSystem ?? '',
      toSystem: edge.toSystem ?? '',
      transformation: edge.transformation ?? edge.description ?? '',
      fromLayer: layerFromName(from),
      toLayer: layerFromName(to),
    })
  }
  for (const asset of assets) {
    const name = (asset.displayName || asset.name || '').trim()
    if (!name) continue
    const type = nameOf(asset.type).toLowerCase()
    const status = nameOf(asset.status)
    const steward = (asset.steward || asset.owner || '').trim()

    if (type.includes('term') || type.includes('glossary')) {
      metadata.glossary.push({
        term: name,
        definition: asset.description ?? '',
        steward,
        status,
        mappedAssets: (asset.relations ?? []).map((r) => r.target ?? '').filter(Boolean),
      })
    } else if (type.includes('metric') || type.includes('kpi')) {
      metadata.metrics.push({
        name,
        definition: asset.description ?? '',
        expression: String(asset.attributes?.expression ?? ''),
        owner: steward,
        externalCertification: status,
      })
    } else {
      metadata.sources.push({
        name,
        system: String(asset.attributes?.system ?? nameOf(asset.type)),
        description: asset.description ?? '',
        owner: steward,
        externalCertification: status,
        layer: layerFromName(name),
      })
    }

    // Lineage carried on the asset itself. `direction` says which way the hop runs; Collibra's
    // own wording is kept for the transformation so nothing is invented on the way through.
    for (const relation of asset.relations ?? []) {
      const target = (relation.target ?? '').trim()
      const type = nameOf(relation.type) || relation.name || ''
      if (!target || !isLineageRelation(type)) continue
      const inbound = /source|upstream|input|sourced by/i.test(relation.direction ?? type)
      const from = inbound ? target : name
      const to = inbound ? name : target
      addEdge({
        from,
        to,
        fromSystem: '',
        toSystem: '',
        transformation: relation.transformation ?? type,
        fromLayer: layerFromName(from),
        toLayer: layerFromName(to),
      })
    }
  }
  return externalMetadataSchema.parse(metadata)
}

interface AlationTable {
  name?: string
  title?: string
  description?: string
  ds_name?: string
  data_source?: string
  owner?: string
  steward?: string
  endorsement?: string
  row_count?: number
  columns?: {
    name?: string
    data_type?: string
    type?: string
    null_percent?: number
    distinct_count?: number
    min?: unknown
    max?: unknown
    classification?: string
  }[]
}

interface AlationExport {
  tables?: AlationTable[]
  terms?: { title?: string; name?: string; description?: string; steward?: string; status?: string }[]
}

/** Alation — bulk metadata JSON: tables with columns, plus glossary terms. */
export function parseAlationJson(text: string): ExternalMetadata {
  const raw = readJson(text) as AlationExport | AlationTable[]
  const payload: AlationExport = Array.isArray(raw) ? { tables: raw } : raw
  const tables = payload.tables ?? []
  const terms = payload.terms ?? []
  if (tables.length === 0 && terms.length === 0) {
    throw new ImportError('No tables or terms found.', ['Expected {"tables": [...]} or {"terms": [...]}, or a bare array of tables.'])
  }

  const metadata = emptyExternalMetadata()
  for (const table of tables) {
    const name = (table.title || table.name || '').trim()
    if (!name) continue
    metadata.sources.push({
      name,
      system: table.ds_name || table.data_source || '',
      description: table.description ?? '',
      owner: table.steward || table.owner || '',
      externalCertification: table.endorsement ?? '',
      rowCountEstimate: typeof table.row_count === 'number' ? Math.max(0, Math.trunc(table.row_count)) : undefined,
      layer: 'UNKNOWN',
    })
    for (const col of table.columns ?? []) {
      const columnName = (col.name ?? '').trim()
      if (!columnName) continue
      metadata.columnProfiles.push({
        source: name,
        column: columnName,
        datatype: col.data_type || col.type || '',
        nullRatePct:
          typeof col.null_percent === 'number' ? Math.min(100, Math.max(0, col.null_percent)) : undefined,
        distinctCount:
          typeof col.distinct_count === 'number' ? Math.max(0, Math.trunc(col.distinct_count)) : undefined,
        min: col.min === undefined || col.min === null ? '' : String(col.min),
        max: col.max === undefined || col.max === null ? '' : String(col.max),
        classification: col.classification ?? '',
      })
    }
  }
  for (const term of terms) {
    const title = (term.title || term.name || '').trim()
    if (!title) continue
    metadata.glossary.push({
      term: title,
      definition: term.description ?? '',
      steward: term.steward ?? '',
      status: term.status ?? '',
      mappedAssets: [],
    })
  }
  return externalMetadataSchema.parse(metadata)
}

/** The canonical format: validated, never mapped. */
export function parseCanonicalJson(text: string): ExternalMetadata {
  const parsed = externalMetadataSchema.safeParse(readJson(text))
  if (!parsed.success) {
    throw new ImportError(
      'The file does not match the canonical import schema.',
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    )
  }
  return parsed.data
}

export function parseImport(connectorKey: string, text: string): ExternalMetadata {
  switch (connectorKey) {
    case 'adpm-json':
      return parseCanonicalJson(text)
    case 'erwin-csv':
      return parseErwinCsv(text)
    case 'collibra-json':
      return parseCollibraJson(text)
    case 'alation-json':
      return parseAlationJson(text)
    default:
      throw new ImportError(`Unknown connector: ${connectorKey}`)
  }
}

/** A one-line summary for the import list and the audit event. */
export function summariseImport(metadata: ExternalMetadata): string {
  const parts: string[] = []
  if (metadata.sources.length) parts.push(`${metadata.sources.length} source(s)`)
  if (metadata.columnProfiles.length) parts.push(`${metadata.columnProfiles.length} column profile(s)`)
  if (metadata.entities.length) parts.push(`${metadata.entities.length} entity/entities`)
  if (metadata.relationships.length) parts.push(`${metadata.relationships.length} relationship(s)`)
  if (metadata.glossary.length) parts.push(`${metadata.glossary.length} glossary term(s)`)
  if (metadata.metrics.length) parts.push(`${metadata.metrics.length} metric(s)`)
  if (metadata.lineage.length) parts.push(`${metadata.lineage.length} lineage hop(s)`)
  return parts.length ? parts.join(', ') : 'nothing recognised'
}
