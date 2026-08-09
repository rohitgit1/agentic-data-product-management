import { z } from 'zod'

/**
 * The normalised shape every external metadata tool is mapped onto.
 *
 * This is the contract. Erwin, Collibra and Alation adapters exist to produce *this*, and any
 * tool that can emit this shape works without an adapter at all. One schema, validated on import,
 * so a malformed export is rejected at the boundary rather than reaching an agent's context.
 *
 * What this deliberately is NOT:
 *
 *   * **Not artifact content.** An import never becomes a committed artifact version. It is
 *     context an agent may read, so that its proposals are informed rather than invented. Those
 *     proposals still require a human disposition (invariant 5). Nothing here shortcuts that.
 *   * **Not authoritative.** A catalogue saying an asset is "certified" is that catalogue's
 *     opinion, carried through as `externalCertification` and never mapped onto ADPM's own
 *     certification, which requires evidence and an approval here (invariant 8).
 */

const trimmed = z.string().trim()

export const externalSourceSchema = z.object({
  name: trimmed.min(1),
  system: trimmed.default(''),
  description: trimmed.default(''),
  owner: trimmed.default(''),
  /** The source tool's own certification/endorsement state, verbatim. Never ADPM's. */
  externalCertification: trimmed.default(''),
  rowCountEstimate: z.number().int().nonnegative().optional(),
  /** Physical layer if the tool states one. Used to keep Bronze/Silver out of grounding. */
  layer: z.enum(['BRONZE', 'SILVER', 'GOLD', 'UNKNOWN']).default('UNKNOWN'),
})

export const externalColumnProfileSchema = z.object({
  source: trimmed.min(1),
  column: trimmed.min(1),
  datatype: trimmed.default(''),
  nullRatePct: z.number().min(0).max(100).optional(),
  distinctCount: z.number().int().nonnegative().optional(),
  min: trimmed.default(''),
  max: trimmed.default(''),
  /** The external tool's classification, e.g. its PII or sensitivity label. */
  classification: trimmed.default(''),
})

export const externalAttributeSchema = z.object({
  name: trimmed.min(1),
  datatype: trimmed.default(''),
  nullable: z.boolean().default(true),
  isKey: z.boolean().default(false),
  description: trimmed.default(''),
})

export const externalEntitySchema = z.object({
  name: trimmed.min(1),
  description: trimmed.default(''),
  attributes: z.array(externalAttributeSchema).default([]),
})

export const externalRelationshipSchema = z.object({
  from: trimmed.min(1),
  to: trimmed.min(1),
  cardinality: z.enum(['ONE_TO_ONE', 'ONE_TO_MANY', 'MANY_TO_MANY']).default('ONE_TO_MANY'),
  description: trimmed.default(''),
})

export const externalGlossaryTermSchema = z.object({
  term: trimmed.min(1),
  definition: trimmed.default(''),
  steward: trimmed.default(''),
  status: trimmed.default(''),
  mappedAssets: z.array(trimmed).default([]),
})

export const externalMetricSchema = z.object({
  name: trimmed.min(1),
  definition: trimmed.default(''),
  expression: trimmed.default(''),
  owner: trimmed.default(''),
  externalCertification: trimmed.default(''),
})

/**
 * One hop of lineage: an upstream object feeding a downstream one. Deliberately flat rather than
 * a graph type — agents reason about "what feeds this and what does it break" far better from a
 * list of hops than from a nested structure, and a catalogue export is a list of hops anyway.
 *
 * The layer fields matter beyond documentation: lineage is where physical Bronze and Silver names
 * live, which is exactly what invariant 7 keeps out of a grounding pack. Carrying the layer makes
 * that filterable rather than a matter of guessing from a table name.
 */
export const externalLineageEdgeSchema = z.object({
  from: trimmed.min(1),
  to: trimmed.min(1),
  fromSystem: trimmed.default(''),
  toSystem: trimmed.default(''),
  /** What happens between the two, in the catalogue's own words. */
  transformation: trimmed.default(''),
  fromLayer: z.enum(['BRONZE', 'SILVER', 'GOLD', 'UNKNOWN']).default('UNKNOWN'),
  toLayer: z.enum(['BRONZE', 'SILVER', 'GOLD', 'UNKNOWN']).default('UNKNOWN'),
})

export const externalMetadataSchema = z.object({
  sources: z.array(externalSourceSchema).default([]),
  columnProfiles: z.array(externalColumnProfileSchema).default([]),
  entities: z.array(externalEntitySchema).default([]),
  relationships: z.array(externalRelationshipSchema).default([]),
  glossary: z.array(externalGlossaryTermSchema).default([]),
  metrics: z.array(externalMetricSchema).default([]),
  lineage: z.array(externalLineageEdgeSchema).default([]),
})

export type ExternalMetadata = z.infer<typeof externalMetadataSchema>
export type ExternalSource = z.infer<typeof externalSourceSchema>
export type ExternalEntity = z.infer<typeof externalEntitySchema>
export type ExternalLineageEdge = z.infer<typeof externalLineageEdgeSchema>

/**
 * The slices an agent can be granted. These are declared per agent in the agent registry and
 * recorded on every AgentAction, exactly like artifact read scope (invariant 6).
 */
export const EXTERNAL_CONTEXT_KINDS = [
  'sources',
  'columnProfiles',
  'entities',
  'relationships',
  'glossary',
  'metrics',
  'lineage',
] as const

export type ExternalContextKind = (typeof EXTERNAL_CONTEXT_KINDS)[number]

/** Empty metadata, used when a product has no imports. */
export function emptyExternalMetadata(): ExternalMetadata {
  return {
    sources: [],
    columnProfiles: [],
    entities: [],
    relationships: [],
    glossary: [],
    metrics: [],
    lineage: [],
  }
}

/** Narrow an import to the kinds an agent declared. Anything not declared never reaches it. */
export function scopeExternalMetadata(
  metadata: ExternalMetadata,
  kinds: readonly ExternalContextKind[],
): Partial<ExternalMetadata> {
  const scoped: Partial<ExternalMetadata> = {}
  for (const kind of kinds) {
    const slice = metadata[kind]
    if (slice.length > 0) scoped[kind] = slice as never
  }
  return scoped
}

/** Merge imports so the newest import of a source wins, rather than duplicating it. */
export function mergeExternalMetadata(imports: ExternalMetadata[]): ExternalMetadata {
  const merged = emptyExternalMetadata()
  const seen = {
    sources: new Set<string>(),
    columnProfiles: new Set<string>(),
    entities: new Set<string>(),
    relationships: new Set<string>(),
    glossary: new Set<string>(),
    metrics: new Set<string>(),
    lineage: new Set<string>(),
  }
  // Newest first, so the first occurrence of a key is the one that survives.
  for (const item of imports) {
    for (const source of item.sources) {
      if (seen.sources.has(source.name)) continue
      seen.sources.add(source.name)
      merged.sources.push(source)
    }
    for (const profile of item.columnProfiles) {
      const key = `${profile.source}.${profile.column}`
      if (seen.columnProfiles.has(key)) continue
      seen.columnProfiles.add(key)
      merged.columnProfiles.push(profile)
    }
    for (const entity of item.entities) {
      if (seen.entities.has(entity.name)) continue
      seen.entities.add(entity.name)
      merged.entities.push(entity)
    }
    for (const relationship of item.relationships) {
      const key = `${relationship.from}->${relationship.to}`
      if (seen.relationships.has(key)) continue
      seen.relationships.add(key)
      merged.relationships.push(relationship)
    }
    for (const term of item.glossary) {
      if (seen.glossary.has(term.term)) continue
      seen.glossary.add(term.term)
      merged.glossary.push(term)
    }
    for (const metric of item.metrics) {
      if (seen.metrics.has(metric.name)) continue
      seen.metrics.add(metric.name)
      merged.metrics.push(metric)
    }
    for (const edge of item.lineage) {
      const key = `${edge.from}->${edge.to}`
      if (seen.lineage.has(key)) continue
      seen.lineage.add(key)
      merged.lineage.push(edge)
    }
  }
  return merged
}
