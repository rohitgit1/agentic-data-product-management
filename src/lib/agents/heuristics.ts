import {
  attributeRegisterSchema,
  dataContractSchema,
  decisionRegisterSchema,
  groundingPackSchema,
  logicalModelSchema,
  physicalArchitectureSchema,
  profileReportSchema,
  semanticModelSchema,
  sourceInventorySchema,
  telemetrySchema,
} from '@/lib/artifacts/registry'
import type { CriterionResult } from '@/lib/lifecycle/criteria'
import type { AgentInvocationContext, AgentOutput, FindingDraft } from './provider'
import {
  externalMetadataSchema,
  type ExternalMetadata,
} from '@/lib/integrations/schema'

/**
 * The local heuristic provider. Deterministic, rule-based, offline. It is not a language model
 * and the UI never claims it is — but it produces real, useful proposals from the artifacts
 * already committed, so the whole supervised-autonomy loop is demonstrable with no API key.
 */

type Facts = Record<string, unknown>

function fact<T>(facts: Facts, key: string): T | undefined {
  return facts[key] as T | undefined
}

function parse<T>(
  artifacts: Record<string, unknown>,
  key: string,
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
): T | undefined {
  const raw = artifacts[key]
  if (raw === undefined) return undefined
  const result = schema.safeParse(raw)
  return result.success ? result.data : undefined
}

const empty: AgentOutput = { narrative: '', proposals: [], findings: [], comments: [] }

/**
 * The external metadata slice the runtime injected under `external`, already narrowed to what the
 * agent declared and already redacted. Nothing here assumes any of it is present — every stage
 * stays completable with no catalogue and no modelling tool connected.
 */
const emptyish = {
  sources: [],
  columnProfiles: [],
  entities: [],
  relationships: [],
  glossary: [],
  metrics: [],
  lineage: [],
}

function external(art: Record<string, unknown>): Partial<ExternalMetadata> {
  const raw = art.external
  if (!raw || typeof raw !== 'object') return {}
  const parsed = externalMetadataSchema.safeParse({
    ...emptyish,
    ...(raw as Record<string, unknown>),
  })
  return parsed.success ? parsed.data : {}
}

/** Findings that say what an external tool already knows, so a human can act on the difference. */
function externalFindings(art: Record<string, unknown>): FindingDraft[] {
  const ext = external(art)
  const findings: FindingDraft[] = []

  const certified = (ext.sources ?? []).filter((s) => s.externalCertification)
  if (certified.length) {
    findings.push({
      title: `${certified.length} source(s) already carry a certification in your catalogue`,
      detail:
        certified
          .slice(0, 5)
          .map((s) => `${s.name}: "${s.externalCertification}"${s.owner ? ` (owner ${s.owner})` : ''}`)
          .join('; ') +
        '. That is the catalogue\u2019s opinion, not this product\u2019s certification — it still needs evidence and an approval here.',
      severity: 'LOW',
    })
  }

  const lineage = ext.lineage ?? []
  if (lineage.length) {
    const upstream = [...new Set(lineage.map((edge) => edge.from))]
    findings.push({
      title: `Your catalogue records ${lineage.length} lineage hop(s) across ${upstream.length} upstream object(s)`,
      detail:
        lineage
          .slice(0, 6)
          .map(
            (edge) =>
              `${edge.from} → ${edge.to}${edge.transformation ? ` (${edge.transformation})` : ''}`,
          )
          .join('; ') +
        '. Anything upstream of this product is a dependency you inherit: a schema change there lands here. Check the source inventory names the ones that matter.',
      severity: 'MEDIUM',
    })
  }

  const classified = (ext.columnProfiles ?? []).filter((c) => c.classification)
  if (classified.length) {
    findings.push({
      title: `${classified.length} column(s) are already classified in your catalogue`,
      detail:
        classified
          .slice(0, 8)
          .map((c) => `${c.source}.${c.column} = ${c.classification}`)
          .join('; ') + '. Carry these into the attribute register rather than re-deciding them.',
      severity: 'MEDIUM',
    })
  }

  const highNull = (ext.columnProfiles ?? []).filter((c) => (c.nullRatePct ?? 0) > 5)
  if (highNull.length) {
    findings.push({
      title: `${highNull.length} column(s) already profiled above a 5% null rate`,
      detail:
        highNull
          .slice(0, 8)
          .map((c) => `${c.source}.${c.column} at ${c.nullRatePct}%`)
          .join('; ') + '. These came from your catalogue, not from a profile run here.',
      severity: 'MEDIUM',
    })
  }

  const terms = ext.glossary ?? []
  if (terms.length) {
    findings.push({
      title: `${terms.length} glossary term(s) already defined`,
      detail:
        terms
          .slice(0, 6)
          .map((t) => `${t.term}${t.steward ? ` (steward ${t.steward})` : ''}`)
          .join('; ') +
        '. Reuse the existing wording where it holds, and say so where it does not.',
      severity: 'LOW',
    })
  }

  const metrics = ext.metrics ?? []
  if (metrics.length) {
    findings.push({
      title: `${metrics.length} metric definition(s) exist in your catalogue`,
      detail:
        metrics.map((m) => m.name).slice(0, 8).join(', ') +
        '. Check these before defining a new metric — a name that already means something else is a collision Stage 6 will block.',
      severity: 'HIGH',
    })
  }

  return findings
}

export function heuristicOutput(context: AgentInvocationContext): AgentOutput {
  const { agent, scopedArtifacts: art, facts } = context
  switch (agent.id) {
    case 'discovery':
      return discovery(art, facts)
    case 'curator':
      return curator(facts)
    case 'charter':
      return charter(art)
    case 'profiling':
      return profiling(art)
    case 'modelling':
      return modelling(art)
    case 'definition':
      return definition(art)
    case 'semantic':
      return semantic(art, facts)
    case 'architecture':
      return architecture(art)
    case 'quality':
      return quality(art)
    case 'compliance':
      return compliance(art, facts)
    case 'grounding':
      return grounding(art)
    case 'evidence':
      return evidence(facts)
    case 'steward':
      return steward(art)
    case 'critic':
      return critic(facts, context.stageNumber)
    default:
      return empty
  }
}

function discovery(art: Record<string, unknown>, facts: Facts): AgentOutput {
  const register = parse(art, 'decision-register', decisionRegisterSchema)
  const intake = fact<{
    decision: string
    consumerRole: string
    cadence: string
    currentWorkaround: string
    questions: string[]
    stakes: string
    requiredFreshness: string
  }>(facts, 'intake')

  if (!intake?.consumerRole) {
    return {
      ...empty,
      narrative:
        'The request does not name a consumer role, so I have proposed nothing. Naming who is blocked is the one thing I will not invent.',
      findings: [
        {
          title: 'No consumer role named in the request',
          detail: 'Stage 1 cannot proceed on "the business". Ask the requester who specifically is blocked.',
          severity: 'HIGH',
        },
      ],
    }
  }

  const existing = register?.decisions.length ?? 0
  const questions = [...intake.questions]
  const suggested = [
    `How has this changed over the last twelve months?`,
    `Which segments are worst affected, and by how much?`,
    `What would we have decided differently last quarter if we had known?`,
  ].filter((q) => !questions.includes(q))

  return {
    narrative: `Drafted a decision record from the approved request and proposed ${suggested.length} additional questions the requester did not ask.`,
    proposals: [
      {
        fieldPath: `decisions[${existing}]`,
        value: {
          id: `DR-${existing + 1}`,
          consumerPersona: intake.consumerRole,
          decision: intake.decision,
          cadence: intake.cadence || 'Not stated',
          currentWorkaround: intake.currentWorkaround || 'Not stated',
          latencyTolerance: intake.requiredFreshness || 'Not stated',
          consequence: intake.stakes || 'Not stated',
          questions: [...questions, ...suggested].slice(0, 8),
        },
        rationale:
          'Taken directly from the approved intake answers, with three questions added that consumers in this position usually need but rarely ask for.',
      },
    ],
    findings: [],
    comments: [],
  }
}

function curator(facts: Facts): AgentOutput {
  const overlaps =
    fact<{ productKey: string; productName: string; sharedEntities: string[]; sharedQuestions: number }[]>(
      facts,
      'overlaps',
    ) ?? []
  if (overlaps.length === 0) {
    return { ...empty, narrative: 'No meaningful overlap with existing products in this workspace.' }
  }
  return {
    narrative: `${overlaps.length} existing product(s) overlap with this one.`,
    proposals: [],
    findings: overlaps.map((o) => ({
      title: `Overlaps with ${o.productName}`,
      detail: `Shares ${o.sharedEntities.join(', ') || 'no entities'} and ${o.sharedQuestions} question(s). Consider reusing rather than rebuilding — a human decides, not me.`,
      severity: o.sharedEntities.length >= 2 ? ('HIGH' as const) : ('MEDIUM' as const),
    })),
    comments: [],
  }
}

/**
 * Stage 2. Scope comes out of the decision register; the value numbers deliberately do not. The
 * agent proposes how the hypothesis would be measured and leaves the baseline blank, because a
 * fabricated baseline is worse than an empty one — it survives review by looking finished.
 */
function charter(art: Record<string, unknown>): AgentOutput {
  const register = parse(art, 'decision-register', decisionRegisterSchema)
  if (!register || register.decisions.length === 0) {
    return {
      ...empty,
      narrative:
        'No decision register is committed yet. Stage 2 is blocked on Stage 1 by design — there is nothing to scope against.',
    }
  }

  const decisions = register.decisions
  const personas = [...new Set(decisions.map((d) => d.consumerPersona).filter(Boolean))]
  const questions = decisions.flatMap((d) => d.questions)
  const primary = decisions[0]!

  return {
    narrative: `Drafted a scope boundary from ${decisions.length} decision record(s) and ${questions.length} question(s). The value hypothesis names its measurement method; the baseline is deliberately left for you to supply.`,
    proposals: [
      {
        fieldPath: 'purpose',
        value: `Enable ${personas.join(' and ') || 'the named consumer'} to decide ${primary.decision.toLowerCase()} without assembling the data by hand.`,
        rationale: 'Restates the Stage 1 decision as a purpose, so the scope traces to a blocked decision rather than to a source system.',
      },
      {
        fieldPath: 'inScope',
        value: questions.slice(0, 6).map((question) => `Answer: ${question}`),
        rationale: 'One in-scope item per recorded question. Anything that answers no recorded question is out of scope by construction.',
      },
      {
        fieldPath: 'outOfScope',
        value: [
          'Any question not recorded in the Stage 1 decision register.',
          'Real-time or sub-daily delivery unless a decision record demands it.',
          'Serving consumers outside the named persona(s) without a new decision record.',
        ],
        rationale: 'An explicit out-of-scope list is what stops scope creep being settled by whoever asks last. Argue with these three.',
      },
      {
        fieldPath: 'stakeholders',
        value: personas.map((role) => ({ role, name: '' })),
        rationale: 'Roles taken from the decision register. Names are left blank — the agent does not know who holds these roles.',
      },
      {
        fieldPath: 'hypothesis.statement',
        value: `${personas[0] || 'The consumer'} reaches a decision on "${primary.decision}" without the current workaround (${primary.currentWorkaround || 'manual assembly'}).`,
        rationale: 'Written so it can be falsified at Stage 12. A hypothesis that cannot fail is not a hypothesis.',
      },
      {
        fieldPath: 'hypothesis.measurementMethod',
        value: `Compare time-to-decision and rework rate before and after publication, sampled over one full ${primary.cadence || 'decision'} cycle.`,
        rationale: 'The method is proposable from the register; the baseline number is not. Supply the baseline yourself — a fabricated one would survive review by looking finished.',
      },
    ],
    findings: [],
    comments: [],
  }
}

function profiling(art: Record<string, unknown>): AgentOutput {
  const profile = parse(art, 'profile-report', profileReportSchema)
  const inventory = parse(art, 'source-inventory', sourceInventorySchema)
  const imported = externalFindings(art)
  if (!profile) {
    return {
      ...empty,
      narrative: imported.length
        ? 'No profile report is committed yet. What your catalogue already knows is below — it is a starting point, not a substitute for profiling here.'
        : 'No profile report is committed yet, so there is nothing to analyse.',
      findings: imported,
    }
  }

  const gaps: { fieldPath: string; value: unknown; rationale: string }[] = []
  let index = 0
  for (const dataset of profile.datasets) {
    for (const column of dataset.columns) {
      if (column.nullRate > 0.05) {
        gaps.push({
          fieldPath: `gaps[${index++}]`,
          value: {
            id: `GAP-${index}`,
            source: dataset.source,
            description: `${column.name} is null in ${(column.nullRate * 100).toFixed(1)}% of rows.`,
            severity: column.nullRate > 0.3 ? 'HIGH' : 'MEDIUM',
            mitigation: 'Confirm whether null is meaningful or a collection failure before modelling.',
            owner: 'DATA_STEWARD',
          },
          rationale: `Observed null rate ${(column.nullRate * 100).toFixed(1)}% exceeds the 5% flag threshold.`,
        })
      }
      if (column.distinctCount === 1 && dataset.rowCount > 1) {
        gaps.push({
          fieldPath: `gaps[${index++}]`,
          value: {
            id: `GAP-${index}`,
            source: dataset.source,
            description: `${column.name} has a single distinct value across ${dataset.rowCount} rows.`,
            severity: 'MEDIUM',
            mitigation: 'Confirm the column carries information before including it in the contract.',
            owner: 'DATA_ARCHITECT',
          },
          rationale: 'Zero cardinality means the column cannot discriminate anything.',
        })
      }
    }
  }

  const unprofiled = (inventory?.sources ?? []).filter(
    (s) => !profile.datasets.some((d) => d.source === s.name),
  )

  return {
    narrative: `Analysed ${profile.datasets.length} dataset(s) and proposed ${gaps.length} gap-log entry/entries.`,
    proposals: gaps,
    findings: unprofiled.map((s) => ({
      title: `${s.name} has not been profiled`,
      detail: 'Stage 3 cannot exit until every inventoried source has profile statistics.',
      severity: 'HIGH' as const,
    })),
    comments: [],
  }
}

function modelling(art: Record<string, unknown>): AgentOutput {
  const inventory = parse(art, 'source-inventory', sourceInventorySchema)
  const profile = parse(art, 'profile-report', profileReportSchema)
  if (!inventory) {
    return { ...empty, narrative: 'No source inventory is committed yet.' }
  }

  const ext = external(art)
  const modelled = (ext.entities ?? []).map((entity) => ({
    name: entity.name,
    description: entity.description || `Imported from your modelling tool.`,
    primaryKey: entity.attributes.filter((a) => a.isKey).map((a) => a.name),
    attributes: entity.attributes.map((a) => a.name),
  }))

  const entities = modelled.length
    ? modelled
    : profile
    ? profile.datasets.map((dataset) => ({
        name: dataset.source.replace(/[^A-Za-z0-9]+/g, ' ').trim(),
        description: `Derived from ${dataset.source}.`,
        primaryKey: [
          dataset.columns.find((c) => /(^|_)id$|key$/i.test(c.name))?.name ?? dataset.columns[0]?.name ?? 'id',
        ],
        attributes: dataset.columns.map((c) => c.name),
      }))
    : []

  return {
    narrative: `Proposed ${entities.length} entity/entities and a grain statement from the profiled sources. The grain is a guess — argue with it.`,
    proposals: [
      ...(entities.length
        ? [
            {
              fieldPath: 'entities',
              value: entities,
              rationale:
                'One entity per profiled dataset, keyed on the first column that looks like an identifier.',
            },
          ]
        : []),
      {
        fieldPath: 'grainStatement',
        value: entities[0]
          ? `One row represents one ${entities[0].name.toLowerCase()} identified by ${entities[0].primaryKey.join(' + ')}.`
          : 'One row represents one record of the system of record.',
        rationale:
          'Stated explicitly so the disagreement happens now rather than in front of an executive.',
      },
    ],
    findings: [],
    comments: [],
  }
}

function definition(art: Record<string, unknown>): AgentOutput {
  const register = parse(art, 'attribute-register', attributeRegisterSchema)
  if (!register || register.attributes.length === 0) {
    return { ...empty, narrative: 'No attributes are registered yet.' }
  }

  const proposals = register.attributes.flatMap((attribute, index) => {
    const out: { fieldPath: string; value: unknown; rationale: string }[] = []
    if (attribute.businessDefinition.trim().length < 10) {
      out.push({
        fieldPath: `attributes[${index}].businessDefinition`,
        value: `The ${attribute.name.replace(/_/g, ' ')} recorded for each ${attribute.entity || 'record'}, sourced from ${attribute.sourceLineage || 'the system of record'}.`,
        rationale: 'Drafted from the attribute name, entity and lineage. A steward must confirm it matches reality.',
      })
    }
    const looksPersonal = /(name|email|phone|address|dob|birth|ssn|nino|passport|iban)/i.test(
      attribute.name,
    )
    if (looksPersonal && !attribute.pii) {
      out.push({
        fieldPath: `attributes[${index}].pii`,
        value: true,
        rationale: `"${attribute.name}" reads as personal data. I propose the stricter classification; I am not certain.`,
      })
      out.push({
        fieldPath: `attributes[${index}].sensitivity`,
        value: 'RESTRICTED',
        rationale: 'Following the PII flag. Downgrade it deliberately if that is wrong.',
      })
    }
    return out
  })

  return {
    narrative: `Reviewed ${register.attributes.length} attribute(s) and proposed ${proposals.length} change(s).`,
    proposals,
    findings: [],
    comments: [],
  }
}

function semantic(art: Record<string, unknown>, facts: Facts): AgentOutput {
  const register = parse(art, 'decision-register', decisionRegisterSchema)
  const model = parse(art, 'semantic-model', semanticModelSchema)
  const existing = fact<{ metric: string; productKey: string }[]>(facts, 'workspaceMetricNames') ?? []
  const questions = register?.decisions.flatMap((d) => d.questions) ?? []

  const untraced = (model?.metrics ?? []).filter((m) => m.tracesToQuestions.length === 0)
  const collisions = (model?.metrics ?? []).filter((m) =>
    existing.some((e) => e.metric.toLowerCase() === m.name.toLowerCase()),
  )

  const proposals = untraced.map((metric) => ({
    fieldPath: `metrics[${model?.metrics.indexOf(metric)}].tracesToQuestions`,
    value: questions.slice(0, 1),
    rationale: `${metric.name} traces to no Stage 1 question. This is the closest recorded question — confirm it or delete the metric.`,
  }))

  return {
    narrative: questions.length
      ? `Checked ${model?.metrics.length ?? 0} metric(s) against ${questions.length} recorded question(s).`
      : 'No Stage 1 questions are available, so nothing can be traced.',
    proposals,
    findings: collisions.map((metric) => ({
      title: `Metric name "${metric.name}" already exists in this workspace`,
      detail: `Owned by ${existing.find((e) => e.metric.toLowerCase() === metric.name.toLowerCase())?.productKey}. One metric, one definition, one answer — rename or reuse.`,
      severity: 'CRITICAL' as const,
    })),
    comments: [],
  }
}

/**
 * Stage 7. Layer assignment follows the contract already agreed at Stage 5 rather than inventing
 * a platform: the agent describes capability, never a vendor, because naming a product is spend.
 */
function architecture(art: Record<string, unknown>): AgentOutput {
  const model = parse(art, 'logical-model', logicalModelSchema)
  const contract = parse(art, 'data-contract', dataContractSchema)
  const inventory = parse(art, 'source-inventory', sourceInventorySchema)
  if (!model || model.entities.length === 0) {
    return {
      ...empty,
      narrative: 'No logical model is committed yet. There is nothing to lay out physically.',
    }
  }

  const entities = model.entities
  const sources = inventory?.sources ?? []
  const ext = external(art)
  const lineage = ext.lineage ?? []
  // Where the catalogue already knows the physical layout, mirror it rather than inventing a
  // parallel one — a bronze table that exists is better evidence than a name this agent made up.
  const knownBronze = [...new Set(lineage.filter((e) => e.fromLayer === 'BRONZE').map((e) => e.from))]
  const knownSilver = [...new Set(lineage.filter((e) => e.toLayer === 'SILVER').map((e) => e.to))]
  // The contract states freshness in minutes, so "sub-daily" is arithmetic rather than a guess.
  const freshnessMinutes = contract?.slas?.freshnessMinutes ?? 0
  const freshness = freshnessMinutes ? `${freshnessMinutes} minute(s)` : ''
  const incremental = freshnessMinutes > 0 && freshnessMinutes < 24 * 60

  return {
    narrative: `Proposed a medallion layout for ${entities.length} entity/entities across ${sources.length || 'the declared'} source(s), sized to the freshness the Stage 5 contract already promises${freshness ? ` (${freshness})` : ''}.${
      lineage.length
        ? ` ${lineage.length} lineage hop(s) from your catalogue were used, so ${knownBronze.length + knownSilver.length} layer name(s) are what already exist rather than invented.`
        : ' No lineage was attached, so every layer name below is invented — attach a catalogue export and dispatch again for names that match reality.'
    } Platform is described as a capability — naming a vendor is your call, not the agent's.`,
    proposals: [
      {
        fieldPath: 'platformProfile',
        value: incremental
          ? 'A warehouse or lakehouse supporting incremental merge and change capture at sub-daily frequency.'
          : 'A warehouse or lakehouse supporting scheduled batch merge at daily frequency.',
        rationale: 'Stated as a capability the contract requires, not a product. Replace with the platform your organisation actually runs.',
      },
      {
        fieldPath: 'ingestionPattern',
        value: incremental ? 'Change data capture into bronze, merged into silver' : 'Scheduled batch extract into bronze, merged into silver',
        rationale: `Derived from the contract freshness${freshness ? ` of "${freshness}"` : ''}. A looser pattern than the contract promises would be a breach on day one.`,
      },
      {
        fieldPath: 'refreshStrategy',
        value: incremental ? 'Incremental merge on the declared primary key' : 'Full refresh of silver, incremental merge into gold',
        rationale: 'Keyed on the grain the logical model already declares, so the physical layout cannot contradict the model.',
      },
      {
        fieldPath: 'layers',
        value: {
          bronze: knownBronze.length
            ? knownBronze
            : sources.map((source) => `bronze_${source.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`),
          silver: knownSilver.length
            ? knownSilver
            : entities.map((entity) => `silver_${entity.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`),
          gold: [`gold_${entities[0]!.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_serving`],
        },
        rationale: knownBronze.length || knownSilver.length
          ? 'Bronze and silver names taken from the lineage your catalogue already records, so this layout matches what exists rather than proposing a parallel one.'
          : 'One bronze object per declared source, one silver object per modelled entity, one gold serving object. Split gold further if the consumption patterns diverge.',
      },
    ],
    findings: [],
    comments: [],
  }
}

function quality(art: Record<string, unknown>): AgentOutput {
  const register = parse(art, 'attribute-register', attributeRegisterSchema)
  const contract = parse(art, 'data-contract', dataContractSchema)
  const profile = parse(art, 'profile-report', profileReportSchema)
  if (!register || !contract) {
    return { ...empty, narrative: 'The attribute register and contract must both exist first.' }
  }

  const observed = new Map<string, number>()
  for (const dataset of profile?.datasets ?? []) {
    for (const column of dataset.columns) observed.set(column.name, column.nullRate)
  }

  const rules: { fieldPath: string; value: unknown; rationale: string }[] = []
  let index = 0
  rules.push({
    fieldPath: `rules[${index++}]`,
    value: {
      id: 'QR-FRESH',
      attribute: register.attributes[0]?.name ?? 'unknown',
      dimension: 'FRESHNESS',
      expression: `max(loaded_at) >= now() - interval '${contract.slas.freshnessMinutes} minutes'`,
      threshold: contract.slas.freshnessMinutes,
      unit: 'minutes',
      severity: 'HIGH',
      alertRoute: 'DATA_ENGINEER',
    },
    rationale: `Derived directly from the contract freshness SLA of ${contract.slas.freshnessMinutes} minutes.`,
  })

  for (const attribute of register.attributes.filter((a) => !a.nullable).slice(0, 5)) {
    const nullRate = observed.get(attribute.name) ?? 0
    rules.push({
      fieldPath: `rules[${index++}]`,
      value: {
        id: `QR-NN-${attribute.name}`,
        attribute: attribute.name,
        dimension: 'COMPLETENESS',
        expression: `null_rate(${attribute.name}) <= ${contract.slas.maxNullRatePct}`,
        threshold: Math.min(contract.slas.maxNullRatePct, Math.max(nullRate * 100, 0.1)),
        unit: '%',
        severity: 'HIGH',
        alertRoute: 'DATA_STEWARD',
      },
      rationale: `Declared non-nullable in the register; observed null rate ${(nullRate * 100).toFixed(2)}%. Threshold clamped to the contract SLA so monitoring can never be looser than the promise.`,
    })
  }

  return {
    narrative: `Proposed ${rules.length} rule(s), all at least as strict as the Stage 5 contract.`,
    proposals: rules,
    findings: [],
    comments: [],
  }
}

function compliance(art: Record<string, unknown>, facts: Facts): AgentOutput {
  const register = parse(art, 'attribute-register', attributeRegisterSchema)
  const controls = fact<{ key: string; name: string; requirement: string }[]>(facts, 'packControls') ?? []
  if (!register) return { ...empty, narrative: 'No attribute register to map.' }

  const unclassified = register.attributes.filter((a) => !a.sensitivity)
  const personal = register.attributes.filter((a) => a.pii)
  const mappings = controls.slice(0, 4).map((control, index) => ({
    fieldPath: `mappings[${index}]`,
    value: {
      controlKey: control.key,
      requirement: control.requirement,
      attributes: personal.map((a) => a.name).slice(0, 10),
      evidence: 'Mapping proposed by the Compliance agent; evidence must be confirmed by the Privacy & Security Officer.',
    },
    rationale: `${control.name} applies wherever personal data is processed; ${personal.length} attribute(s) are flagged as PII.`,
  }))

  const findings = [
    ...unclassified.map((a) => ({
      title: `${a.name} carries no sensitivity classification`,
      detail: 'Stage 9 cannot open while any attribute is unclassified.',
      severity: 'CRITICAL' as const,
    })),
    ...(personal.length >= 2
      ? [
          {
            title: 'Re-identification risk from combined attributes',
            detail: `${personal.map((a) => a.name).join(', ')} together may identify an individual even if each is masked separately.`,
            severity: 'HIGH' as const,
          },
        ]
      : []),
  ]

  return {
    narrative: `Mapped ${mappings.length} control(s) and raised ${findings.length} finding(s). I never assert that this product is compliant.`,
    proposals: mappings,
    findings,
    comments: [],
  }
}

function grounding(art: Record<string, unknown>): AgentOutput {
  const model = parse(art, 'semantic-model', semanticModelSchema)
  const register = parse(art, 'decision-register', decisionRegisterSchema)
  const pack = parse(art, 'grounding-pack', groundingPackSchema)
  const architecture = parse(art, 'physical-architecture', physicalArchitectureSchema)

  const rawRefs = (pack?.objectReferences ?? []).filter(
    (o) => o.layer === 'BRONZE' || o.layer === 'SILVER',
  )
  const questions = register?.decisions.flatMap((d) => d.questions) ?? []

  return {
    narrative: rawRefs.length
      ? 'The grounding pack references physical Bronze or Silver objects. That is rejected outright.'
      : `Proposed grounding content from ${model?.metrics.length ?? 0} certified metric(s).`,
    proposals: rawRefs.length
      ? []
      : [
          {
            fieldPath: 'sampleQuestions',
            value: questions.slice(0, 5),
            rationale: 'Taken from the Stage 1 register — questions a consumer actually asked.',
          },
          {
            fieldPath: 'metricDefinitions',
            value: (model?.metrics ?? []).map((m) => ({ name: m.name, definition: m.definition })),
            rationale: 'Only certified Stage 6 metrics. Nothing else may ground an answer.',
          },
          {
            fieldPath: 'refusalGuidance',
            value: [
              'Refuse any question that requires an uncertified metric.',
              'Refuse to compute figures at a grain finer than the stated model grain.',
              'Refuse requests for individual-level records; this product answers aggregate questions.',
            ],
            rationale: 'An agent with no refusal rule answers everything, including wrongly.',
          },
          {
            fieldPath: 'objectReferences',
            value: (architecture?.layers.gold ?? []).map((object) => ({ object, layer: 'GOLD' })),
            rationale: 'Gold-layer objects only — the validator rejects Bronze and Silver.',
          },
        ],
    findings: rawRefs.map((ref) => ({
      title: `Rejected reference to ${ref.object}`,
      detail: `${ref.layer} objects are physical tables, not certified semantic objects. Grounding purity is not negotiable.`,
      severity: 'CRITICAL' as const,
    })),
    comments: [],
  }
}

function evidence(facts: Facts): AgentOutput {
  const refs = fact<string[]>(facts, 'evidenceRefs') ?? []
  const dimensions = [
    'DISCOVERABLE',
    'ADDRESSABLE',
    'TRUSTWORTHY',
    'SELF_DESCRIBING',
    'INTEROPERABLE',
    'SECURE',
    'VALUABLE',
  ] as const
  const preferred: Record<(typeof dimensions)[number], string[]> = {
    DISCOVERABLE: ['artifact:marketplace-listing', 'approval:stage-10'],
    ADDRESSABLE: ['artifact:serving-spec'],
    TRUSTWORTHY: ['artifact:quality-rules', 'approval:stage-8'],
    SELF_DESCRIBING: ['artifact:attribute-register', 'artifact:data-contract'],
    INTEROPERABLE: ['artifact:semantic-model', 'artifact:grounding-pack'],
    SECURE: ['artifact:access-policy', 'approval:stage-9'],
    VALUABLE: ['artifact:value-case', 'approval:stage-2'],
  }

  const proposals: { fieldPath: string; value: unknown; rationale: string }[] = []
  const findings: { title: string; detail: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' }[] = []

  dimensions.forEach((dimension, index) => {
    const citations = refs.filter((ref) => preferred[dimension].some((p) => ref.startsWith(p)))
    if (citations.length === 0) {
      findings.push({
        title: `No evidence for ${dimension}`,
        detail: 'I will not propose a score for a dimension I cannot cite.',
        severity: 'HIGH',
      })
      return
    }
    proposals.push({
      fieldPath: `dimensions[${index}]`,
      value: {
        dimension,
        score: Math.min(5, 3 + citations.length),
        citations: citations.map((ref) => ({
          kind: ref.startsWith('approval:') ? 'APPROVAL' : 'ARTIFACT_VERSION',
          ref,
          detail: '',
        })),
        note: '',
      },
      rationale: `Cited ${citations.length} artifact version(s) or approval(s). Evidence, not assertion.`,
    })
  })

  return {
    narrative: `Assembled citations for ${proposals.length} of 7 dimensions.`,
    proposals,
    findings,
    comments: [],
  }
}

function steward(art: Record<string, unknown>): AgentOutput {
  const telemetry = parse(art, 'telemetry', telemetrySchema)
  const contract = parse(art, 'data-contract', dataContractSchema)
  if (!telemetry) {
    return { ...empty, narrative: 'No telemetry has been recorded for this product yet.' }
  }

  const findings: { title: string; detail: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' }[] = []
  if (telemetry.schemaDriftDetected) {
    findings.push({
      title: 'Schema drift detected against the published contract',
      detail: `The served schema no longer matches ${contract ? 'the Stage 5 contract' : 'the published contract'}. This requires a major version bump and cascade re-approval.`,
      severity: 'CRITICAL',
    })
  }
  if (telemetry.freshnessBreaches30d > 0) {
    findings.push({
      title: `${telemetry.freshnessBreaches30d} freshness breach(es) in the last 30 days`,
      detail: 'The product is not meeting the freshness SLA its consumers were promised.',
      severity: telemetry.freshnessBreaches30d > 3 ? 'HIGH' : 'MEDIUM',
    })
  }
  const lastUsed = telemetry.lastUsedAt ? Date.parse(telemetry.lastUsedAt) : NaN
  if (!Number.isNaN(lastUsed) && Date.now() - lastUsed > 90 * 86_400_000) {
    findings.push({
      title: 'No consumption for more than 90 days',
      detail: 'A product nobody uses still costs money to run. Consider deprecation.',
      severity: 'HIGH',
    })
  }
  if (telemetry.consumers === 0) {
    findings.push({
      title: 'Zero recorded consumers',
      detail: 'This product was built for someone. Find out whether they ever arrived.',
      severity: 'HIGH',
    })
  }

  return {
    narrative: findings.length
      ? `Raised ${findings.length} finding(s). I never edit an artifact — a human dispositions each one.`
      : 'No issues detected in the current telemetry window.',
    proposals: [],
    findings,
    comments: [],
  }
}

function critic(facts: Facts, stageNumber: number): AgentOutput {
  const criteria = fact<CriterionResult[]>(facts, 'criteria') ?? []
  const failing = criteria.filter((c) => !c.passed)
  const questions = fact<string[]>(facts, 'stage1Questions') ?? []

  const comments = failing.map((criterion) => ({
    fieldPath: criterion.key,
    body: `${criterion.label} — not met. ${criterion.detail}${
      criterion.blocking ? ' This blocks the gate.' : ' This is advisory.'
    }`,
  }))

  if (comments.length === 0) {
    comments.push({
      fieldPath: 'overall',
      body:
        questions.length > 0
          ? `Every exit criterion for Stage ${stageNumber} passes. The remaining question for a human reviewer: does this stage actually move the consumer closer to answering "${questions[0]}"? Machine checks cannot answer that.`
          : `Every exit criterion for Stage ${stageNumber} passes mechanically, but there are no Stage 1 questions recorded to judge it against. That is the weakest point of this product.`,
    })
  }

  return {
    narrative: `Reviewed Stage ${stageNumber} against ${criteria.length} exit criterion/criteria and produced ${comments.length} comment(s) for a human to accept or reject.`,
    proposals: [],
    findings: [],
    comments,
  }
}
