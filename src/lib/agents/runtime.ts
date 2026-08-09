import { prisma } from '@/lib/db'
import { assertRole } from '@/lib/auth/authorise'
import { PRACTITIONER_ROLES } from '@/lib/domain/roles'
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit/log'
import { contentHash } from '@/lib/hash'
import { getAgentCredentials } from '@/lib/secrets'
import { setAtPath } from '@/lib/util/path'
import type { AutonomyLevel, Provenance } from '@/lib/domain/enums'
import { buildStageContext } from '@/lib/lifecycle/context'
import { getStage } from '@/lib/lifecycle/stages'
import { decisionRegisterSchema, semanticModelSchema } from '@/lib/artifacts/registry'
import {
  externalMetadataSchema,
  mergeExternalMetadata,
  scopeExternalMetadata,
  type ExternalMetadata,
} from '@/lib/integrations/schema'
import { categoryOf, type ConnectorCategory } from '@/lib/integrations/registry'
import { getAgent, type AgentDefinition } from './registry'
import { DEFAULT_MODEL_BY_LEVEL, isKnownModel } from './models'
import { redactForAgent } from './redaction'
import {
  createAnthropicProvider,
  localHeuristicProvider,
  type AgentProvider,
  type ProviderResult,
} from './provider'

/**
 * The agent runtime. Enforces the guardrails from CLAUDE.md §2 and PROMPT.md §9 in code:
 *
 *  1. Output persists as a proposal, never directly as artifact content.
 *  2. Acceptance requires an explicit human action.
 *  3. Every field carries provenance.
 *  4. An artifact cannot be submitted while any field remains AGENT_PROPOSED (enforced in the
 *     universal exit criteria, evaluated by the transition engine).
 *  5. Agents read only within their declared scope.
 *  6. Agents cannot invoke one another without an orchestration record naming a human.
 *  7. Every invocation writes an AgentAction.
 *  8. Every stage is completable with all agents disabled.
 */

export class AgentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentError'
  }
}

export type AgentTrigger = 'MANUAL' | 'STAGE_ENTRY' | 'SCHEDULE'

export interface InvokeAgentInput {
  agentId: string
  workspaceId: string
  productId: string
  stageNumber: number
  /** The human who initiated this run. Required — an agent never runs unattributed. */
  userId: string
  trigger: AgentTrigger
  /** Set when one agent invoked another; the orchestration record still names the human above. */
  orchestrationParentId?: string
  /**
   * Which categories of imported metadata this dispatch may draw on — the run console's
   * "context sources" choice, carried down to the boundary that actually builds the context.
   * Omitted means every import the product has, which is what the stage studio wants; an empty
   * array means none at all, which is how a run with both toggles off stays agent-only.
   */
  externalCategories?: ConnectorCategory[]
  /**
   * The model a run console operator chose for this dispatch, overriding the workspace assignment
   * for the agent's autonomy level. It changes what the agent is good at, never what it may do —
   * every guardrail above and below this line is evaluated identically whichever model runs.
   */
  modelOverride?: string
}

export interface InvokeAgentResult {
  actionId: string
  provider: string
  model: string
  narrative: string
  proposalCount: number
  findingCount: number
  commentCount: number
  redactedFields: string[]
  estimatedCostUsd: number
}

export async function effectiveAutonomy(
  workspaceId: string,
  agent: AgentDefinition,
): Promise<AutonomyLevel> {
  const setting = await prisma.agentSetting.findUnique({
    where: { workspaceId_agentId: { workspaceId, agentId: agent.id } },
  })
  if (!setting) return 'L1'
  if (!setting.enabled) return 'L0'
  const order: AutonomyLevel[] = ['L0', 'L1', 'L2', 'L3']
  const configured = setting.autonomyLevel as AutonomyLevel
  // A setting may only lower the registry ceiling, never raise it.
  return order.indexOf(configured) > order.indexOf(agent.autonomyCeiling)
    ? agent.autonomyCeiling
    : configured
}

/**
 * Which model the workspace has assigned to an autonomy level. An explicit `ANTHROPIC_API_KEY`
 * model override still wins, because that is set by whoever runs the process, not by a UI.
 */
export async function assignedModel(
  workspaceId: string,
  autonomy: AutonomyLevel,
): Promise<string> {
  const assignment = await prisma.modelAssignment.findUnique({
    where: { workspaceId_autonomyLevel: { workspaceId, autonomyLevel: autonomy } },
  })
  if (assignment && isKnownModel(assignment.modelId)) return assignment.modelId
  return DEFAULT_MODEL_BY_LEVEL[autonomy]
}

async function resolveProvider(configuredModel: string): Promise<AgentProvider> {
  const { apiKey, model } = await getAgentCredentials()
  if (!apiKey) return localHeuristicProvider
  // The env override is deliberate operator intent; otherwise honour the workspace assignment.
  return createAnthropicProvider(apiKey, model ?? configuredModel)
}

export async function invokeAgent(input: InvokeAgentInput): Promise<InvokeAgentResult> {
  const agent = getAgent(input.agentId)
  if (!agent) throw new AgentError(`Unknown agent: ${input.agentId}`)

  // Invariant 10, at the engine rather than the route: invoking an agent spends workspace budget
  // and puts product content in front of a model, so it is a mutation and is authorised like one.
  // Enforcing it here means the scheduled runner (scripts/monitor.ts) is bound by the same rule
  // as the button in the studio.
  await assertRole(
    input.userId,
    input.workspaceId,
    PRACTITIONER_ROLES,
    `Invoking the ${agent.name} agent`,
  )

  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: input.workspaceId } })
  if (!workspace.agentsEnabled) {
    throw new AgentError('Agents are disabled for this workspace. Enable them in Admin first.')
  }
  if (agent.stages.length > 0 && !agent.stages.includes(input.stageNumber)) {
    throw new AgentError(`${agent.name} is not chartered for Stage ${input.stageNumber}.`)
  }
  const stage = getStage(input.stageNumber)
  if (!stage.permittedAgents.includes(agent.id)) {
    throw new AgentError(`${agent.name} is not permitted on Stage ${input.stageNumber}.`)
  }

  const autonomy = await effectiveAutonomy(input.workspaceId, agent)
  if (autonomy === 'L0') throw new AgentError(`${agent.name} is switched off (L0).`)
  if (input.trigger === 'STAGE_ENTRY' && autonomy === 'L1') {
    throw new AgentError(`${agent.name} is at L1 and only runs when explicitly invoked.`)
  }
  if (input.trigger === 'SCHEDULE' && autonomy !== 'L3') {
    throw new AgentError(`${agent.name} must be at L3 to run on a schedule.`)
  }
  if (workspace.agentSpendUsd >= workspace.agentBudgetUsd) {
    throw new AgentError(
      `Workspace agent budget of $${workspace.agentBudgetUsd.toFixed(2)} is exhausted. Raise it in Admin to continue.`,
    )
  }

  const product = await prisma.dataProduct.findUniqueOrThrow({
    where: { id: input.productId },
    select: { id: true, name: true, key: true, workspaceId: true, requestId: true },
  })

  const ctx = await buildStageContext(input.productId, input.stageNumber)

  // Scope enforcement: the agent sees only the artifact types it declared.
  const scoped: Record<string, unknown> = {}
  for (const type of agent.readScope) {
    const snapshot = ctx.artifacts[type]
    if (snapshot) scoped[type] = snapshot.content
  }

  // External metadata (erwin, Collibra, Alation) is context, not artifact content. It is
  // narrowed to the slices this agent declared, then redacted on the same path as the artifacts —
  // a catalogue export is exactly the kind of place a stray PII sample value hides.
  const externalContext = agent.externalScope?.length
    ? scopeExternalMetadata(
        await loadExternalMetadata(input.productId, input.externalCategories),
        agent.externalScope,
      )
    : {}

  const { payload, redactedFields } = redactForAgent(
    { ...scoped, ...(Object.keys(externalContext).length ? { external: externalContext } : {}) },
    { allowSampleData: workspace.agentsMaySeeSampleData && agent.wantsSampleData },
  )

  const facts = await buildFacts(agent, ctx, product)
  // Recorded whether or not it is the model that ends up running: with no API key the local
  // heuristic runs instead, and the action log has to show both rather than imply otherwise.
  const configuredModel =
    input.modelOverride && isKnownModel(input.modelOverride)
      ? input.modelOverride
      : await assignedModel(input.workspaceId, autonomy)
  const provider = await resolveProvider(configuredModel)

  let result: ProviderResult
  try {
    result = await provider.run({
      agent,
      stageNumber: input.stageNumber,
      productName: product.name,
      scopedArtifacts: payload,
      facts,
    })
  } catch (error) {
    throw new AgentError(
      `${agent.name} failed to run: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  }

  const inputHash = contentHash({
    scope: agent.readScope,
    externalScope: agent.externalScope ?? [],
    payload,
    facts,
  })

  const action = await prisma.$transaction(async (tx) => {
    const created = await tx.agentAction.create({
      data: {
        workspaceId: input.workspaceId,
        agentId: agent.id,
        productId: input.productId,
        stageNumber: input.stageNumber,
        trigger: input.trigger,
        scopeJson: JSON.stringify({
          artifacts: agent.readScope,
          external: agent.externalScope ?? [],
          externalCategories: input.externalCategories ?? 'ALL',
        }),
        inputHash,
        model: result.model,
        configuredModel,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        estimatedCostUsd: result.estimatedCostUsd,
        outputJson: JSON.stringify(result.output),
        redactedFieldsJson: JSON.stringify(redactedFields),
        disposition: 'PENDING',
        initiatedById: input.userId,
        orchestrationParentId: input.orchestrationParentId ?? null,
        durationMs: result.durationMs,
      },
    })

    for (const proposal of result.output.proposals) {
      await tx.agentProposal.create({
        data: {
          agentActionId: created.id,
          productId: input.productId,
          stageNumber: input.stageNumber,
          fieldPath: proposal.fieldPath,
          proposedValueJson: JSON.stringify(proposal.value ?? null),
          rationale: proposal.rationale,
          state: 'PENDING',
        },
      })
    }

    // Critic comments are proposals too: a human accepts them into the thread, or they die here.
    for (const comment of result.output.comments) {
      await tx.agentProposal.create({
        data: {
          agentActionId: created.id,
          productId: input.productId,
          stageNumber: input.stageNumber,
          fieldPath: comment.fieldPath || 'overall',
          proposedValueJson: JSON.stringify({ comment: comment.body }),
          rationale: 'Review comment for human disposition',
          state: 'PENDING',
        },
      })
    }

    for (const finding of result.output.findings) {
      await tx.task.create({
        data: {
          workspaceId: input.workspaceId,
          productId: input.productId,
          kind: 'AGENT_DISPOSITION',
          title: `${agent.name}: ${finding.title}`,
          detail: finding.detail,
          assigneeRoleKey: stage.approverRoles[0] ?? null,
        },
      })
    }

    await tx.workspace.update({
      where: { id: input.workspaceId },
      data: { agentSpendUsd: { increment: result.estimatedCostUsd } },
    })

    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      productId: input.productId,
      actorId: input.userId,
      actorType: 'AGENT',
      action: AUDIT_ACTIONS.AGENT_INVOKED,
      entityType: 'AgentAction',
      entityId: created.id,
      data: {
        agentId: agent.id,
        stageNumber: input.stageNumber,
        trigger: input.trigger,
        model: result.model,
        readScope: agent.readScope,
        redactedFields: redactedFields.length,
        proposals: result.output.proposals.length,
        findings: result.output.findings.length,
        estimatedCostUsd: result.estimatedCostUsd,
      },
    })

    return created
  })

  return {
    actionId: action.id,
    provider: provider.id,
    model: result.model,
    narrative: result.output.narrative,
    proposalCount: result.output.proposals.length,
    findingCount: result.output.findings.length,
    commentCount: result.output.comments.length,
    redactedFields,
    estimatedCostUsd: result.estimatedCostUsd,
  }
}

/**
 * The merged, most-recent-wins view of every external import for a product. Newest first so a
 * re-import of the same catalogue supersedes the old one rather than duplicating it.
 */
export async function loadExternalMetadata(
  productId: string,
  categories?: ConnectorCategory[],
): Promise<ExternalMetadata> {
  const rows = await prisma.externalMetadataImport.findMany({
    where: { productId, archivedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  const parsed: ExternalMetadata[] = []
  for (const row of rows) {
    // A run that did not ask for catalogue context must not receive it, whatever is on disk.
    // Filtering here rather than at the caller means the scheduled runner and the studio go
    // through the same gate, and an unrecognised connector key is excluded rather than assumed.
    if (categories) {
      const category = categoryOf(row.connectorKey)
      if (!category || !categories.includes(category)) continue
    }
    const result = externalMetadataSchema.safeParse(JSON.parse(row.payloadJson))
    // A stored import that no longer validates is skipped rather than reaching an agent.
    if (result.success) parsed.push(result.data)
  }
  return mergeExternalMetadata(parsed)
}

async function buildFacts(
  agent: AgentDefinition,
  ctx: Awaited<ReturnType<typeof buildStageContext>>,
  product: { id: string; key: string; workspaceId: string; requestId: string | null },
): Promise<Record<string, unknown>> {
  const facts: Record<string, unknown> = {}

  if (agent.id === 'discovery' && product.requestId) {
    const request = await prisma.productRequest.findUnique({ where: { id: product.requestId } })
    if (request) {
      facts.intake = {
        decision: request.decision,
        consumerRole: request.consumerRole,
        cadence: request.cadence,
        currentWorkaround: request.currentWorkaround,
        questions: JSON.parse(request.questionsJson) as string[],
        stakes: request.stakes,
        requiredFreshness: request.requiredFreshness,
      }
    }
  }

  if (agent.id === 'semantic') facts.workspaceMetricNames = ctx.otherProductMetricNames

  if (agent.id === 'evidence') facts.evidenceRefs = ctx.evidenceRefs

  if (agent.id === 'critic') {
    facts.criteria = getStage(ctx.stageNumber).exitCriteria(ctx)
    const register = ctx.artifacts['decision-register']
    if (register) {
      const parsed = decisionRegisterSchema.safeParse(register.content)
      facts.stage1Questions = parsed.success ? parsed.data.decisions.flatMap((d) => d.questions) : []
    }
  }

  if (agent.id === 'compliance') {
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: product.workspaceId },
      select: { packKey: true },
    })
    const pack = await prisma.pack.findUnique({ where: { key: workspace.packKey } })
    if (pack) {
      const content = JSON.parse(pack.contentJson) as {
        controls?: { key: string; name: string; requirement: string }[]
      }
      facts.packControls = content.controls ?? []
    }
  }

  if (agent.id === 'curator') facts.overlaps = await findOverlaps(product)

  return facts
}

async function findOverlaps(product: { id: string; workspaceId: string }) {
  const others = await prisma.dataProduct.findMany({
    where: { workspaceId: product.workspaceId, id: { not: product.id }, archivedAt: null },
    select: {
      key: true,
      name: true,
      artifacts: {
        where: { type: { in: ['semantic-model', 'decision-register'] } },
        include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      },
    },
  })

  const mine = await prisma.artifact.findMany({
    where: { productId: product.id, type: { in: ['semantic-model', 'decision-register'] } },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  })

  const myEntities = new Set<string>()
  let myQuestions: string[] = []
  for (const artifact of mine) {
    const version = artifact.versions[0]
    if (!version) continue
    const content = JSON.parse(version.contentJson)
    if (artifact.type === 'semantic-model') {
      const parsed = semanticModelSchema.safeParse(content)
      if (parsed.success) parsed.data.entities.forEach((e) => myEntities.add(e.name.toLowerCase()))
    } else {
      const parsed = decisionRegisterSchema.safeParse(content)
      if (parsed.success) myQuestions = parsed.data.decisions.flatMap((d) => d.questions)
    }
  }

  const overlaps: {
    productKey: string
    productName: string
    sharedEntities: string[]
    sharedQuestions: number
  }[] = []

  for (const other of others) {
    const entities = new Set<string>()
    let questions: string[] = []
    for (const artifact of other.artifacts) {
      const version = artifact.versions[0]
      if (!version) continue
      const content = JSON.parse(version.contentJson)
      if (artifact.type === 'semantic-model') {
        const parsed = semanticModelSchema.safeParse(content)
        if (parsed.success) parsed.data.entities.forEach((e) => entities.add(e.name.toLowerCase()))
      } else {
        const parsed = decisionRegisterSchema.safeParse(content)
        if (parsed.success) questions = parsed.data.decisions.flatMap((d) => d.questions)
      }
    }
    const shared = [...entities].filter((e) => myEntities.has(e))
    const sharedQuestions = questions.filter((q) =>
      myQuestions.some((mine) => mine.toLowerCase().includes(q.toLowerCase().slice(0, 20))),
    ).length
    if (shared.length > 0 || sharedQuestions > 0) {
      overlaps.push({
        productKey: other.key,
        productName: other.name,
        sharedEntities: shared,
        sharedQuestions,
      })
    }
  }
  return overlaps
}

export type DispositionAction = 'ACCEPT' | 'EDIT_ACCEPT' | 'REJECT'

export interface DispositionInput {
  proposalId: string
  userId: string
  action: DispositionAction
  editedValue?: unknown
  note?: string
}

/** The explicit human action that guardrail 2 requires. Nothing else moves a proposal. */
export async function dispositionProposal(input: DispositionInput): Promise<void> {
  const proposal = await prisma.agentProposal.findUniqueOrThrow({
    where: { id: input.proposalId },
    include: { product: true, agentAction: true },
  })
  if (proposal.state !== 'PENDING') {
    throw new AgentError('This proposal has already been dispositioned.')
  }
  // Guardrail 2 is only worth anything if the human doing the accepting is entitled to.
  await assertRole(
    input.userId,
    proposal.product.workspaceId,
    PRACTITIONER_ROLES,
    'Dispositioning an agent proposal',
  )

  const state = input.action === 'ACCEPT' ? 'ACCEPTED' : input.action === 'EDIT_ACCEPT' ? 'EDITED' : 'REJECTED'

  await prisma.$transaction(async (tx) => {
    await tx.agentProposal.update({
      where: { id: proposal.id },
      data: {
        state,
        acceptedValueJson:
          state === 'REJECTED'
            ? null
            : JSON.stringify(
                input.action === 'EDIT_ACCEPT' ? (input.editedValue ?? null) : JSON.parse(proposal.proposedValueJson),
              ),
        dispositionById: input.userId,
        dispositionAt: new Date(),
        dispositionNote: input.note ?? '',
      },
    })

    const siblings = await tx.agentProposal.findMany({
      where: { agentActionId: proposal.agentActionId },
    })
    const allDone = siblings.every((s) => s.id === proposal.id || s.state !== 'PENDING')
    if (allDone) {
      const anyAccepted = siblings.some(
        (s) => s.state === 'ACCEPTED' || s.state === 'EDITED' || s.id === proposal.id,
      )
      await tx.agentAction.update({
        where: { id: proposal.agentActionId },
        data: {
          disposition: state === 'REJECTED' && !anyAccepted ? 'REJECTED' : state,
          dispositionById: input.userId,
          dispositionAt: new Date(),
          dispositionNote: input.note ?? '',
        },
      })
    }

    await recordAudit(tx, {
      workspaceId: proposal.product.workspaceId,
      productId: proposal.productId,
      actorId: input.userId,
      action: AUDIT_ACTIONS.AGENT_PROPOSAL_DISPOSITIONED,
      entityType: 'AgentProposal',
      entityId: proposal.id,
      data: {
        agentId: proposal.agentAction.agentId,
        fieldPath: proposal.fieldPath,
        action: input.action,
        note: input.note ?? '',
      },
    })
  })
}

/** Accepting a Critic comment creates a real review comment authored by the accepting human. */
export async function acceptCriticComment(input: {
  proposalId: string
  userId: string
  note?: string
}): Promise<string> {
  const proposal = await prisma.agentProposal.findUniqueOrThrow({
    where: { id: input.proposalId },
    include: { product: true, agentAction: true },
  })
  const value = JSON.parse(proposal.proposedValueJson) as { comment?: string }
  if (!value.comment) throw new AgentError('This proposal is not a review comment.')
  await assertRole(
    input.userId,
    proposal.product.workspaceId,
    PRACTITIONER_ROLES,
    'Accepting a critic comment',
  )

  const comment = await prisma.$transaction(async (tx) => {
    const created = await tx.comment.create({
      data: {
        productId: proposal.productId,
        stageNumber: proposal.stageNumber,
        authorId: input.userId,
        kind: 'AGENT_CRITIC',
        body: value.comment ?? '',
        fieldPath: proposal.fieldPath,
        agentActionId: proposal.agentActionId,
      },
    })
    await tx.agentProposal.update({
      where: { id: proposal.id },
      data: {
        state: 'ACCEPTED',
        acceptedValueJson: proposal.proposedValueJson,
        dispositionById: input.userId,
        dispositionAt: new Date(),
        dispositionNote: input.note ?? '',
      },
    })
    await recordAudit(tx, {
      workspaceId: proposal.product.workspaceId,
      productId: proposal.productId,
      actorId: input.userId,
      action: AUDIT_ACTIONS.COMMENT_ADDED,
      entityType: 'Comment',
      entityId: created.id,
      data: { source: proposal.agentAction.agentId, accepted: true },
    })
    return created
  })

  return comment.id
}

export interface AppliedProposals {
  content: unknown
  provenance: { fieldPath: string; provenance: Provenance; agentId: string; acceptedById: string }[]
  appliedCount: number
}

/**
 * Folds accepted proposals into a draft artifact and returns the provenance entries the commit
 * must record. The commit itself is still a human action — this function writes nothing.
 */
export async function applyAcceptedProposals(params: {
  productId: string
  stageNumber: number
  baseContent: unknown
}): Promise<AppliedProposals> {
  const proposals = await prisma.agentProposal.findMany({
    where: {
      productId: params.productId,
      stageNumber: params.stageNumber,
      state: { in: ['ACCEPTED', 'EDITED'] },
    },
    include: { agentAction: true },
    orderBy: { createdAt: 'asc' },
  })

  let content = params.baseContent
  const provenance: AppliedProposals['provenance'] = []

  for (const proposal of proposals) {
    if (proposal.fieldPath === 'overall') continue
    const raw = proposal.acceptedValueJson ?? proposal.proposedValueJson
    const value = JSON.parse(raw)
    if (value && typeof value === 'object' && 'comment' in value) continue
    content = setAtPath(content, proposal.fieldPath, value)
    provenance.push({
      fieldPath: proposal.fieldPath,
      provenance: proposal.state === 'EDITED' ? 'AGENT_EDITED' : 'AGENT_ACCEPTED',
      agentId: proposal.agentAction.agentId,
      acceptedById: proposal.dispositionById ?? '',
    })
  }

  return { content, provenance, appliedCount: provenance.length }
}
