import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ACCESS_REQUEST_STATES,
  ACTOR_TYPES,
  AGENT_DISPOSITIONS,
  ARCHETYPES,
  AUTONOMY_LEVELS,
  CHANGE_REQUEST_STATES,
  COMMENT_KINDS,
  DECISIONS,
  DOORS,
  GATE_STATES,
  PRODUCT_STATUSES,
  PROPOSAL_STATES,
  PROVENANCE,
  REQUEST_STATES,
  SEVERITIES,
  STAGE_RUN_STATES,
  TASK_KINDS,
  TIERS,
  VALUE_STATES,
  VERSION_BUMPS,
} from '@/lib/domain/enums'
import {
  countColumns,
  parsePrismaSchema,
  relationEdges,
  scalarFields,
  type ParsedModel,
  type ParsedSchema,
  type RelationEdge,
} from './parse'

/**
 * The reading guide for the persistence model, held AS DATA beside the schema it annotates.
 *
 * The shape of the data model is read from prisma/schema.prisma at request time; what is written
 * here is only what a schema file cannot say — what each table is for in plain language, which
 * invariant it carries, and what may write to it. A model with no note is reported as
 * un-annotated rather than quietly dropped, and a test fails when the two fall out of step.
 */

export const SCHEMA_PATH = 'prisma/schema.prisma'

export type GroupKey =
  | 'tenancy'
  | 'demand'
  | 'lifecycle'
  | 'evidence'
  | 'governance'
  | 'consumption'
  | 'portfolio'
  | 'agents'
  | 'configuration'

export interface ModelGroup {
  key: GroupKey
  title: string
  /** Two sentences: what this cluster of tables is for, and why it is separate from the others. */
  summary: string
}

export const MODEL_GROUPS: ModelGroup[] = [
  {
    key: 'tenancy',
    title: 'Tenancy and people',
    summary:
      'Who is using the application, in which workspace, holding which role in which domain. Every other table hangs off a workspace, so a demo, a pilot and a client engagement can share one installation without seeing each other.',
  },
  {
    key: 'demand',
    title: 'Demand',
    summary:
      'A consumer describing a decision they cannot make today. Nothing here is a data product yet — a request becomes one only when a triage decision approves it, which is what keeps the lifecycle consumption-first.',
  },
  {
    key: 'lifecycle',
    title: 'Product and lifecycle',
    summary:
      'The data product itself and its passage through the twelve stages. `currentStage` is a progress pointer and never an approval record; approval lives entirely in the governance tables.',
  },
  {
    key: 'evidence',
    title: 'Artifacts and evidence',
    summary:
      'The documents produced at each stage, versioned by content hash and never edited in place. Field-level provenance rides alongside every version so an approver can see which words a human wrote and which an agent proposed.',
  },
  {
    key: 'governance',
    title: 'Governance and audit',
    summary:
      'Gates, the approvals cast at them, the artifact versions they relied on, and the append-only audit trail. This cluster is the reason the product can claim supervised autonomy rather than assert it.',
  },
  {
    key: 'consumption',
    title: 'Consumption and feedback',
    summary:
      'How a published product is actually used: which consumption patterns it is ready for, who asked for access, and what consumers said afterwards. Adoption evidence starts here.',
  },
  {
    key: 'portfolio',
    title: 'Portfolio and value',
    summary:
      'The leadership view: the value hypothesis carried from Stage 2 to a measured outcome at Stage 12, prioritisation overrides with a stated reason, and periodic maturity assessments.',
  },
  {
    key: 'agents',
    title: 'Agents',
    summary:
      'Everything an agent touches is recorded here: its settings, the model behind each autonomy level, every invocation, every proposal, and the human disposition of each. No table in this cluster can move a gate.',
  },
  {
    key: 'configuration',
    title: 'Configuration',
    summary:
      'Industry packs and the blueprints they carry, installed from YAML under packs/. Industry logic lives in data so no domain, regulation or entity name is ever hard-coded in application code.',
  },
]

export interface ModelNote {
  model: string
  group: GroupKey
  /** One or two sentences, plain language, no schema jargon. */
  purpose: string
  /** Who or what may write to it, when the answer is not "the owning service". */
  writeRule?: string
  /** True where rows are only ever inserted. Cross-checked against the schema doc comments. */
  appendOnly?: boolean
  /** Invariant numbers from CLAUDE.md that this table carries. */
  invariants?: number[]
}

export const MODEL_NOTES: ModelNote[] = [
  {
    model: 'Workspace',
    group: 'tenancy',
    purpose:
      'One tenant: an organisation, a pilot or a demo. Carries the installed industry pack, the triage SLA, and the agent budget that caps spend for everything inside it.',
    invariants: [11],
  },
  {
    model: 'Domain',
    group: 'tenancy',
    purpose:
      'A business area within a workspace, such as Claims or Supply Chain. Products and requests belong to a domain, and role assignments can be scoped to one.',
    invariants: [11],
  },
  {
    model: 'User',
    group: 'tenancy',
    purpose:
      'A person who signs in. The long list of relations is deliberate: every decision, comment, approval and disposition in the application is attributable to a named human.',
    invariants: [6],
  },
  {
    model: 'Role',
    group: 'tenancy',
    purpose:
      'The catalogue of roles, seeded from the role registry in code. The table exists so assignments can be foreign-keyed and inspected; the registry stays the source of truth.',
    writeRule: 'Seeded from src/lib/domain/roles.ts. Not user-editable.',
    invariants: [10],
  },
  {
    model: 'RoleAssignment',
    group: 'tenancy',
    purpose:
      'Grants one user one role, in one workspace, optionally narrowed to a single domain. Server-side authorisation reads this table on every mutation.',
    invariants: [10],
  },
  {
    model: 'ProductRequest',
    group: 'demand',
    purpose:
      'A consumer intake record in plain business language: the decision they cannot make, who is affected, how often, what they do instead today, and what it costs them.',
    writeRule: 'Becomes a data product only through triage approval, never by direct promotion.',
    invariants: [1],
  },
  {
    model: 'RequestMessage',
    group: 'demand',
    purpose:
      'The conversation on a request — a triager asking for more detail, the requester answering. Keeps clarification out of the intake fields themselves.',
  },
  {
    model: 'DataProduct',
    group: 'lifecycle',
    purpose:
      'The unit of work moving through the lifecycle, with its archetype, tier, owner, steward and semantic version.',
    writeRule:
      'There is deliberately no approval status column here. `currentStage` records progress; whether a stage was approved is answered by its gate.',
    invariants: [2],
  },
  {
    model: 'Stage',
    group: 'lifecycle',
    purpose:
      'A projection of the twelve-stage registry so stage numbers can be referenced and listed in the database. The registry in code remains authoritative.',
    writeRule: 'Seeded from src/lib/lifecycle/stages.ts.',
  },
  {
    model: 'StageRun',
    group: 'lifecycle',
    purpose:
      'One pass of one product through one stage. A rejected gate opens a new attempt rather than reopening the old run, so history reads as a sequence of attempts.',
  },
  {
    model: 'Artifact',
    group: 'evidence',
    purpose:
      'A named, schema-validated document a stage produces — a charter, a data contract, a grounding pack. One row per artifact type per product; the content lives in its versions.',
  },
  {
    model: 'ArtifactVersion',
    group: 'evidence',
    purpose:
      'An immutable, content-hashed snapshot of an artifact, mirrored to a git-friendly file under workspace/. Editing an artifact appends a version; nothing overwrites.',
    writeRule: 'Append-only. A commit never mutates a previous row.',
    appendOnly: true,
    invariants: [3, 4],
  },
  {
    model: 'FieldProvenance',
    group: 'evidence',
    purpose:
      'Per-field record of whether a value was written by a human, proposed by an agent, accepted or edited — and by whom. This is what makes "agents act, humans decide" checkable rather than claimed.',
    writeRule:
      'An artifact cannot be submitted for review while any field is still unreviewed agent output.',
    invariants: [5],
  },
  {
    model: 'Gate',
    group: 'governance',
    purpose:
      'The approval checkpoint between two stages: which roles must approve, how many are needed, who holds a veto, and whether the decision still stands.',
    writeRule:
      'Only recordDecision() may move a gate to APPROVED. No API route, seed script, agent or admin action may set that state directly.',
    invariants: [2, 4],
  },
  {
    model: 'GateEvidence',
    group: 'governance',
    purpose:
      'The artifact versions an approved gate relied on, pinned by content hash. Cascade invalidation reads this table to find approvals whose evidence has since changed.',
    invariants: [4, 8],
  },
  {
    model: 'Approval',
    group: 'governance',
    purpose:
      'One person, in one role, casting one decision at one gate, with their rationale. Quorum and veto are counted from these rows.',
    invariants: [2],
  },
  {
    model: 'Comment',
    group: 'governance',
    purpose:
      'Review conversation, threaded, and attachable to a specific field of a specific artifact. Agent critiques land here too, marked by kind, so a critique is discussable rather than authoritative.',
  },
  {
    model: 'Task',
    group: 'governance',
    purpose:
      'A piece of work waiting for a person: an approval to cast, a review to complete, a re-approval raised by a stale gate. Assignable to a role or to a named user.',
  },
  {
    model: 'AuditEvent',
    group: 'governance',
    purpose:
      'Every mutation in the application, recorded with actor, action, entity and payload. Emitted as the last step of each mutation, after the transaction commits.',
    writeRule: 'Append-only. Never edited, never deleted.',
    appendOnly: true,
    invariants: [3, 6],
  },
  {
    model: 'ChangeRequest',
    group: 'governance',
    purpose:
      'A proposed change to a published product, with severity and the version bump it implies. Agents may raise one; only a human dispositions it.',
    invariants: [5],
  },
  {
    model: 'ConsumptionPatternBinding',
    group: 'consumption',
    purpose:
      'Which consumption patterns a product targets, and its computed readiness for each — green where the required artifact exists and its gate is approved, red where it is absent.',
    invariants: [7],
  },
  {
    model: 'AccessRequest',
    group: 'consumption',
    purpose:
      'A consumer asking for access to a published product through a named pattern, with the purpose they stated and the decision taken.',
  },
  {
    model: 'Feedback',
    group: 'consumption',
    purpose:
      'What consumers said after using the product. Feeds adoption evidence and the change requests that follow from it.',
  },
  {
    model: 'ValueMeasurement',
    group: 'portfolio',
    purpose:
      'The value hypothesis stated at Stage 2 and the outcome measured against it at Stage 12, including the honest NOT_REALISED result.',
    writeRule:
      'A product may be published without realised value; it may not be published without a stated, measurable hypothesis.',
    invariants: [9],
  },
  {
    model: 'MaturityAssessment',
    group: 'portfolio',
    purpose:
      'A point-in-time score of the organisation’s data product capability across the maturity dimensions, with notes. Kept as a series so movement is visible.',
  },
  {
    model: 'PrioritisationOverride',
    group: 'portfolio',
    purpose:
      'A leader overriding the computed prioritisation score, with a reason. The computed score is never silently replaced — both are shown.',
  },
  {
    model: 'AgentSetting',
    group: 'agents',
    purpose:
      'Per-workspace autonomy configuration for one agent. The agent registry supplies the ceiling; this row may only lower it.',
    writeRule: 'No value here can permit gate approval.',
    invariants: [2, 6],
  },
  {
    model: 'ModelAssignment',
    group: 'agents',
    purpose:
      'Which model backs each autonomy level in a workspace. A model choice changes what an agent is good at, never what it may do.',
    invariants: [2],
  },
  {
    model: 'AgentAction',
    group: 'agents',
    purpose:
      'One agent invocation: the trigger, the declared read scope, the input hash, the model that actually ran, tokens, estimated cost, the output, and the human disposition of it.',
    writeRule: 'Append-only. An agent that cannot be audited cannot run.',
    appendOnly: true,
    invariants: [3, 6],
  },
  {
    model: 'AgentProposal',
    group: 'agents',
    purpose:
      'One proposed field value from an agent, with its rationale, awaiting a human to accept, edit or reject it. Accepting writes the value and the provenance together.',
    invariants: [5],
  },
  {
    model: 'AgentRun',
    group: 'agents',
    purpose:
      'One supervised pass of a product through the lifecycle with agents drafting ahead of the humans. Its states name what it is waiting for, because it halts wherever a person must act.',
    writeRule: 'A run approves nothing, commits nothing and satisfies no exit criterion.',
    invariants: [2, 5],
  },
  {
    model: 'AgentRunStep',
    group: 'agents',
    purpose:
      'One planned agent dispatch inside a run, planned up front from the stage registry so the operator sees the whole route before anything is spent.',
    writeRule: 'Appended to, never rewritten.',
    appendOnly: true,
    invariants: [3],
  },
  {
    model: 'ExternalMetadataImport',
    group: 'agents',
    purpose:
      'One import of metadata from an external modelling or catalogue tool. It is context an agent may read so its proposals are informed rather than invented — never artifact content.',
    writeRule:
      'An external tool’s own certified state is carried through verbatim, never mapped onto ADPM certification.',
    appendOnly: true,
    invariants: [5, 8],
  },
  {
    model: 'Pack',
    group: 'configuration',
    purpose:
      'An installed industry pack: domains, regulations, entities, sample sources and vocabulary, loaded from YAML and stored with its change log.',
    invariants: [11],
  },
  {
    model: 'Blueprint',
    group: 'configuration',
    purpose:
      'A reusable starter product carried by a pack, which seeds early-stage artifacts when a new product adopts it.',
    invariants: [11],
  },
]

/** The tables a reader should understand first, in the order the lifecycle touches them. */
export const SPINE_MODELS = [
  'ProductRequest',
  'DataProduct',
  'StageRun',
  'Gate',
  'Approval',
  'GateEvidence',
  'Artifact',
  'ArtifactVersion',
  'FieldProvenance',
  'AgentAction',
  'AgentProposal',
]

export interface Enumeration {
  name: string
  label: string
  values: readonly string[]
  /** The columns that hold these values, as `Model.field`. */
  columns: string[]
  note?: string
}

/**
 * SQLite has no native enum type, so enumerated columns are Strings validated by Zod. The values
 * are imported from the one place they are defined; only the column mapping is written here.
 */
export const ENUMERATIONS: Enumeration[] = [
  {
    name: 'REQUEST_STATES',
    label: 'Request state',
    values: REQUEST_STATES,
    columns: ['ProductRequest.state'],
    note: 'APPROVED, DECLINED and MERGED are terminal.',
  },
  {
    name: 'PRODUCT_STATUSES',
    label: 'Product status',
    values: PRODUCT_STATUSES,
    columns: ['DataProduct.status'],
  },
  { name: 'ARCHETYPES', label: 'Archetype', values: ARCHETYPES, columns: ['DataProduct.archetype'] },
  { name: 'TIERS', label: 'Tier', values: TIERS, columns: ['DataProduct.tier'] },
  {
    name: 'STAGE_RUN_STATES',
    label: 'Stage run state',
    values: STAGE_RUN_STATES,
    columns: ['StageRun.state'],
  },
  {
    name: 'GATE_STATES',
    label: 'Gate state',
    values: GATE_STATES,
    columns: ['Gate.state'],
    note: 'STALE is reached automatically when evidence a gate relied on changes.',
  },
  { name: 'DECISIONS', label: 'Approval decision', values: DECISIONS, columns: ['Approval.decision'] },
  {
    name: 'PROVENANCE',
    label: 'Provenance',
    values: PROVENANCE,
    columns: ['FieldProvenance.provenance'],
    note: 'AGENT_PROPOSED is the only value that blocks submission for review.',
  },
  {
    name: 'AUTONOMY_LEVELS',
    label: 'Autonomy level',
    values: AUTONOMY_LEVELS,
    columns: ['AgentSetting.autonomyLevel', 'ModelAssignment.autonomyLevel'],
    note: 'No level permits approving a gate, committing a version or publishing.',
  },
  {
    name: 'AGENT_DISPOSITIONS',
    label: 'Agent disposition',
    values: AGENT_DISPOSITIONS,
    columns: ['AgentAction.disposition'],
  },
  {
    name: 'PROPOSAL_STATES',
    label: 'Proposal state',
    values: PROPOSAL_STATES,
    columns: ['AgentProposal.state'],
  },
  { name: 'COMMENT_KINDS', label: 'Comment kind', values: COMMENT_KINDS, columns: ['Comment.kind'] },
  { name: 'TASK_KINDS', label: 'Task kind', values: TASK_KINDS, columns: ['Task.kind'] },
  { name: 'ACTOR_TYPES', label: 'Actor type', values: ACTOR_TYPES, columns: ['AuditEvent.actorType'] },
  {
    name: 'CHANGE_REQUEST_STATES',
    label: 'Change request state',
    values: CHANGE_REQUEST_STATES,
    columns: ['ChangeRequest.state'],
  },
  { name: 'SEVERITIES', label: 'Severity', values: SEVERITIES, columns: ['ChangeRequest.severity'] },
  {
    name: 'VERSION_BUMPS',
    label: 'Version bump',
    values: VERSION_BUMPS,
    columns: ['ChangeRequest.versionBump'],
  },
  {
    name: 'VALUE_STATES',
    label: 'Value state',
    values: VALUE_STATES,
    columns: ['ValueMeasurement.state'],
    note: 'NOT_REALISED is a legitimate, reportable outcome.',
  },
  {
    name: 'ACCESS_REQUEST_STATES',
    label: 'Access request state',
    values: ACCESS_REQUEST_STATES,
    columns: ['AccessRequest.state'],
  },
  { name: 'DOORS', label: 'Door', values: DOORS, columns: ['Role.door'] },
]

export interface InvariantAnchor {
  invariant: number
  claim: string
  /** Where the schema carries it, as `Model` or `Model.field`. */
  carriedBy: string[]
  /** The code path that enforces it, because a schema alone cannot. */
  enforcedIn: string
}

export const INVARIANT_ANCHORS: InvariantAnchor[] = [
  {
    invariant: 1,
    claim: 'Consumption-first: no product without a named consumer and a blocked decision.',
    carriedBy: ['ProductRequest.decision', 'ProductRequest.consumerRole', 'DataProduct.requestId'],
    enforcedIn: 'Stage 2 exit criteria in src/lib/lifecycle/stages.ts',
  },
  {
    invariant: 2,
    claim: 'One approval path: only recordDecision() can move a gate to APPROVED.',
    carriedBy: ['Gate.state', 'Approval'],
    enforcedIn: 'src/lib/lifecycle/transitions.ts',
  },
  {
    invariant: 3,
    claim: 'Immutability: versions and logs are append-only; nothing is hard-deleted.',
    carriedBy: [
      'ArtifactVersion.contentHash',
      'AuditEvent',
      'AgentAction',
      'AgentRunStep',
      'archivedAt columns',
    ],
    enforcedIn: 'src/lib/artifacts/commit.ts and src/lib/audit',
  },
  {
    invariant: 4,
    claim: 'Cascade honesty: approvals decay when the evidence under them changes.',
    carriedBy: ['GateEvidence.contentHash', 'Gate.staleReason', 'Gate.staleAt'],
    enforcedIn: 'Cascade invalidation on commit, in src/lib/artifacts/commit.ts',
  },
  {
    invariant: 5,
    claim: 'Human in the loop: unreviewed agent output blocks submission for review.',
    carriedBy: ['FieldProvenance.provenance', 'AgentProposal.state', 'AgentAction.disposition'],
    enforcedIn: 'A named exit criterion in src/lib/lifecycle/criteria.ts',
  },
  {
    invariant: 6,
    claim: 'Agent accountability: every invocation is auditable or it does not run.',
    carriedBy: [
      'AgentAction.scopeJson',
      'AgentAction.inputHash',
      'AgentAction.model',
      'AgentAction.estimatedCostUsd',
    ],
    enforcedIn: 'src/lib/agents/runtime.ts',
  },
  {
    invariant: 8,
    claim: 'Evidence over assertion: certification cites versions and approvals.',
    carriedBy: ['GateEvidence', 'ArtifactVersion.version'],
    enforcedIn: 'Certification scorecard validation in src/lib/artifacts/registry.ts',
  },
  {
    invariant: 9,
    claim: 'Value closes the loop: a stated hypothesis is required to publish.',
    carriedBy: ['ValueMeasurement.hypothesisJson', 'ValueMeasurement.state'],
    enforcedIn: 'Stage 2 and Stage 12 exit criteria',
  },
  {
    invariant: 10,
    claim: 'Roles enforced server-side.',
    carriedBy: ['RoleAssignment', 'Role.key'],
    enforcedIn: 'Authorisation in every server action, via src/lib/auth',
  },
  {
    invariant: 11,
    claim: 'Industry logic lives in packs, never in application code.',
    carriedBy: ['Pack.contentJson', 'Blueprint.contentJson', 'Workspace.packKey'],
    enforcedIn: 'src/lib/packs',
  },
]

// ── Derived views ───────────────────────────────────────────────────────────────────────────

export interface AnnotatedModel {
  model: ParsedModel
  note: ModelNote | undefined
  group: GroupKey | 'unannotated'
  edgesOut: RelationEdge[]
  edgesIn: RelationEdge[]
  appendOnly: boolean
  archivable: boolean
  jsonColumns: string[]
}

export interface DataModel {
  schema: ParsedSchema
  edges: RelationEdge[]
  models: AnnotatedModel[]
  groups: { group: ModelGroup; models: AnnotatedModel[] }[]
  /** Models present in the schema with no note written for them. */
  unannotated: string[]
  /** Notes written for models that no longer exist in the schema. */
  orphanedNotes: string[]
  totals: { models: number; columns: number; relations: number; enumeratedColumns: number }
}

const NOTE_BY_MODEL = new Map(MODEL_NOTES.map((note) => [note.model, note]))

export function enumerationForColumn(model: string, field: string): Enumeration | undefined {
  const key = `${model}.${field}`
  return ENUMERATIONS.find((enumeration) => enumeration.columns.includes(key))
}

export function buildDataModel(source: string): DataModel {
  const schema = parsePrismaSchema(source)
  const edges = relationEdges(schema)

  const models: AnnotatedModel[] = schema.models.map((model) => {
    const note = NOTE_BY_MODEL.get(model.name)
    return {
      model,
      note,
      group: note?.group ?? 'unannotated',
      edgesOut: edges.filter((edge) => edge.from === model.name),
      edgesIn: edges.filter((edge) => edge.to === model.name),
      appendOnly: note?.appendOnly === true,
      archivable: model.fields.some((field) => field.name === 'archivedAt'),
      jsonColumns: scalarFields(model)
        .filter((field) => field.name.endsWith('Json'))
        .map((field) => field.name),
    }
  })

  const present = new Set(schema.models.map((model) => model.name))

  return {
    schema,
    edges,
    models,
    groups: MODEL_GROUPS.map((group) => ({
      group,
      models: models.filter((annotated) => annotated.group === group.key),
    })),
    unannotated: models.filter((m) => m.note === undefined).map((m) => m.model.name),
    orphanedNotes: MODEL_NOTES.filter((note) => !present.has(note.model)).map((note) => note.model),
    totals: {
      models: schema.models.length,
      columns: countColumns(schema),
      relations: edges.length,
      enumeratedColumns: ENUMERATIONS.reduce(
        (total, enumeration) => total + enumeration.columns.length,
        0,
      ),
    },
  }
}

let cached: DataModel | undefined

/** Reads and parses prisma/schema.prisma. Cached per process; the file does not change at runtime. */
export async function loadDataModel(): Promise<DataModel> {
  if (!cached) {
    const source = await readFile(join(process.cwd(), SCHEMA_PATH), 'utf8')
    cached = buildDataModel(source)
  }
  return cached
}

// ── Diagram generation ──────────────────────────────────────────────────────────────────────

function mermaidType(type: string): string {
  return type.toLowerCase()
}

/**
 * Renders an entity-relationship diagram for a set of models. Each entity lists its key columns
 * only — every column is in the table below the diagram, and an ER diagram that repeats them is
 * unreadable at this size. Relationships to models outside `names` are returned separately rather
 * than dropped, so nothing disappears silently.
 */
export function erDiagram(
  dataModel: DataModel,
  names: string[],
): { chart: string; external: RelationEdge[] } {
  const included = new Set(names)
  const selected = dataModel.models.filter((annotated) => included.has(annotated.model.name))
  const internal = dataModel.edges.filter(
    (edge) => included.has(edge.from) && included.has(edge.to),
  )
  const external = dataModel.edges.filter(
    (edge) =>
      (included.has(edge.from) && !included.has(edge.to)) ||
      (!included.has(edge.from) && included.has(edge.to)),
  )

  const lines = ['erDiagram']
  for (const { model } of selected) {
    const keys = model.fields.filter(
      (field) =>
        field.relation === null &&
        (model.primaryKey.includes(field.name) ||
          dataModel.edges.some(
            (edge) => edge.from === model.name && edge.foreignKeys.includes(field.name),
          )),
    )
    lines.push(`  ${model.name} {`)
    for (const field of keys) {
      const marker = model.primaryKey.includes(field.name) ? 'PK' : 'FK'
      lines.push(`    ${mermaidType(field.type)} ${field.name} ${marker}`)
    }
    lines.push('  }')
  }
  for (const edge of internal) {
    const parent = edge.optional ? '|o' : '||'
    const child = edge.unique ? 'o|' : 'o{'
    lines.push(`  ${edge.to} ${parent}--${child} ${edge.from} : ${edge.field}`)
  }

  return { chart: lines.join('\n'), external }
}
