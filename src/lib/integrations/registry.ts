import type { ExternalContextKind } from './schema'

/**
 * The connector registry AS DATA, like every other registry here. Adding a tool must not require
 * editing the agent runtime.
 *
 * ## Read this before believing a connector name
 *
 * Every connector here is **import-only and file-based**. You export from your tool, you upload
 * the file, ADPM parses it. There is deliberately no live API sync, for three reasons:
 *
 *   1. CLAUDE.md §4 requires the whole application to run offline on a laptop. A core flow that
 *      needs a reachable Collibra instance breaks that, and this is a core flow the moment an
 *      agent depends on it.
 *   2. This tool does not own your catalogue. One-way import keeps it that way — nothing here
 *      can write back to Erwin or Collibra, so it cannot corrupt a system of record it does not
 *      own.
 *   3. A live connector that has never been run against a real instance is a claim, not a
 *      feature. None of these have been.
 *
 * `verification` records what each mapping has actually been checked against. `format: 'adpm'`
 * is the canonical, fully specified and fully tested shape; the per-tool adapters map documented
 * export shapes onto it and say plainly that they have not been run against a live instance.
 * Any tool that can emit the canonical shape needs no adapter at all.
 */

export type ConnectorCategory = ConnectorDefinition['category']

export interface ConnectorDefinition {
  key: string
  name: string
  vendor: string
  category: 'DATA_MODELLING' | 'DATA_CATALOGUE' | 'OPEN'
  /** Which slices of the normalised schema this connector can populate. */
  supplies: ExternalContextKind[]
  /** Accepted upload extensions. */
  fileTypes: string[]
  /** How to produce the file from the tool. Shown verbatim in the import panel. */
  howToExport: string
  /** What has actually been checked. Absent means the mapping is written but unverified. */
  verification?: { checkedOn: string; source: string; finding: string }
  note: string
}

export const CONNECTORS: ConnectorDefinition[] = [
  {
    key: 'adpm-json',
    name: 'Canonical import (any tool)',
    vendor: 'ADPM',
    category: 'OPEN',
    supplies: [
      'sources',
      'columnProfiles',
      'entities',
      'relationships',
      'glossary',
      'metrics',
      'lineage',
    ],
    fileTypes: ['.json'],
    howToExport:
      'Emit JSON matching src/lib/integrations/schema.ts. Every field is optional except the names. This is the format the per-tool adapters convert into, so anything that can produce it needs no adapter.',
    verification: {
      checkedOn: '2026-08-01',
      source: 'src/lib/integrations/schema.ts and tests/integrations.test.ts',
      finding:
        'Fully specified by a Zod schema and round-trip tested. This is the only format with no mapping layer between the file and the agent context.',
    },
    note: 'The canonical shape. Prefer this if your tool can be scripted.',
  },
  {
    key: 'erwin-csv',
    name: 'erwin Data Modeler',
    vendor: 'erwin (Quest)',
    category: 'DATA_MODELLING',
    supplies: ['entities', 'relationships'],
    fileTypes: ['.csv'],
    howToExport:
      'In erwin Data Modeler, use the Bulk Editor or Report Designer to export an entity/attribute report as CSV with columns: Entity, Entity Definition, Attribute, Datatype, Null Option, Primary Key, Attribute Definition. Relationships export separately with columns: Parent Entity, Child Entity, Cardinality, Relationship Name.',
    note: 'Mapped from the documented Bulk Editor column layout. Unverified against a live erwin installation — column headings vary by template, so check the first import carefully.',
  },
  {
    key: 'collibra-json',
    name: 'Collibra Data Intelligence Platform',
    vendor: 'Collibra',
    category: 'DATA_CATALOGUE',
    supplies: ['sources', 'glossary', 'metrics', 'lineage'],
    fileTypes: ['.json'],
    howToExport:
      'Export assets from Collibra as JSON, including asset name, type, description, the responsible steward and the asset status. Business Terms become glossary entries, Tables and Systems become sources, Metrics and KPIs become metrics. For lineage, include each asset\'s relations (with the relation type and direction), or ship a top-level "lineage" array of {from, to, transformation} edges — either shape is read.',
    note: 'Mapped from the documented asset export shape (name, type, displayName, attributes, relations). Unverified against a live Collibra instance. Lineage relations are matched on the documented relation-type vocabulary — anything unrecognised is skipped rather than guessed at, because a wrong edge tells an architect a dependency exists that does not.',
  },
  {
    key: 'alation-json',
    name: 'Alation Data Catalog',
    vendor: 'Alation',
    category: 'DATA_CATALOGUE',
    supplies: ['sources', 'columnProfiles', 'glossary'],
    fileTypes: ['.json'],
    howToExport:
      'Export tables, columns and glossary terms as JSON — typically from the bulk metadata API. Column profiling statistics come through when profiling is enabled in Alation.',
    note: 'Mapped from the documented table/column/term JSON shape. Unverified against a live Alation instance. Profiling statistics are only present if Alation itself has profiled the source.',
  },
]

export function getConnector(key: string): ConnectorDefinition | undefined {
  return CONNECTORS.find((c) => c.key === key)
}

export const CONNECTOR_KEYS = CONNECTORS.map((c) => c.key)

/** Connectors in one category, for the run console's per-category attachment panels. */
export function connectorsInCategory(category: ConnectorCategory): ConnectorDefinition[] {
  return CONNECTORS.filter((connector) => connector.category === category)
}

/** The category a connector key belongs to, used to honour a run's declared context sources. */
export function categoryOf(connectorKey: string): ConnectorCategory | undefined {
  return getConnector(connectorKey)?.category
}
