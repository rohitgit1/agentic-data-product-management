import { prisma } from '@/lib/db'
import { assertRole } from '@/lib/auth/authorise'
import { PRACTITIONER_ROLES } from '@/lib/domain/roles'
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit/log'
import { STAGES, getStage } from '@/lib/lifecycle/stages'
import { ensureStageRun, evaluateExitCriteria } from '@/lib/lifecycle/transitions'
import { categoryOf, type ConnectorCategory } from '@/lib/integrations/registry'
import { isKnownModel } from './models'
import { getAgent, agentName } from './registry'
import { AgentError, invokeAgent } from './runtime'

/**
 * The run orchestrator: one supervised pass of a product through the lifecycle with agents
 * drafting ahead of the humans.
 *
 * ## What a run cannot do
 *
 * A run dispatches agents and records what they produced. It approves nothing, commits nothing,
 * publishes nothing and satisfies no exit criterion — there is no mode, model or setting that
 * changes that (CLAUDE.md §2, and `AGENT_FORBIDDEN_ACTIONS`). Every state below names what the run
 * is waiting FOR rather than what it has done, because waiting for a human is the normal case and
 * the UI should not present it as a failure.
 *
 * ## Why it advances one stage at a time
 *
 * Stage N+1's agents read what Stage N committed. Dispatching all twelve stages at once would
 * produce eleven stages of drafts written against artifacts that do not exist, which is not speed —
 * it is a backlog of guesses a reviewer has to throw away. So a run drafts one stage, halts while
 * humans disposition and clear the gate, and resumes into the next stage with real inputs.
 *
 * The route is derived from the stage registry, so adding a stage or chartering a new agent
 * changes what a run does without touching this file.
 */

export type RunMode = 'AUTOMATED' | 'MANUAL'

export type RunState =
  | 'RUNNING'
  | 'AWAITING_REVIEW'
  | 'AWAITING_GATE'
  | 'BLOCKED'
  | 'COMPLETED'
  | 'CANCELLED'

export type RunStepState = 'PENDING' | 'RUNNING' | 'DRAFTED' | 'SKIPPED' | 'FAILED'

export const TERMINAL_RUN_STATES: RunState[] = ['COMPLETED', 'CANCELLED']

export function isRunTerminal(state: string): boolean {
  return TERMINAL_RUN_STATES.includes(state as RunState)
}

/** The agents a stage would dispatch, drafting agents first and the Critic last. */
export function plannedAgentsForStage(stageNumber: number): string[] {
  const permitted = getStage(stageNumber).permittedAgents.filter((id) => getAgent(id))
  return [...permitted.filter((id) => id !== 'critic'), ...permitted.filter((id) => id === 'critic')]
}

export interface StartRunInput {
  workspaceId: string
  productId: string
  userId: string
  mode: RunMode
  modelId: string
  /**
   * Which categories of imported metadata the agents may draw on. Empty means artifacts only —
   * every stage stays completable that way, so this widens what an agent knows and never what it
   * is allowed to do.
   */
  contextSources?: ConnectorCategory[]
  /** Where to start. Defaults to the product's current stage — a run never rewinds history. */
  fromStage?: number
  toStage?: number
}

export async function startAgentRun(input: StartRunInput): Promise<string> {
  await assertRole(input.userId, input.workspaceId, PRACTITIONER_ROLES, 'Starting an agent run')

  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: input.workspaceId } })
  if (!workspace.agentsEnabled) {
    throw new AgentError(
      'Agents are disabled for this workspace. Enable them in Admin first — every stage is still completable by hand without them.',
    )
  }
  if (!isKnownModel(input.modelId)) {
    throw new AgentError('Choose a model from the catalogue before starting a run.')
  }

  const product = await prisma.dataProduct.findUniqueOrThrow({ where: { id: input.productId } })
  if (product.workspaceId !== input.workspaceId) {
    throw new AgentError('That product belongs to another workspace.')
  }
  if (product.archivedAt) throw new AgentError('That product is archived.')

  const existing = await prisma.agentRun.findFirst({
    where: { productId: input.productId, state: { notIn: TERMINAL_RUN_STATES } },
  })
  if (existing) {
    throw new AgentError(
      'A run is already open on this product. Cancel it before starting another — two runs drafting the same stage produce proposals that contradict each other.',
    )
  }

  // A context source the operator asked for but has attached nothing for would silently do
  // nothing, so it is refused rather than accepted and quietly ignored.
  const contextSources = [...new Set(input.contextSources ?? [])]
  if (contextSources.length > 0) {
    const imports = await prisma.externalMetadataImport.findMany({
      where: { productId: input.productId, archivedAt: null },
      select: { connectorKey: true },
    })
    const attached = new Set(imports.map((row) => categoryOf(row.connectorKey)).filter(Boolean))
    const missing = contextSources.filter((category) => !attached.has(category))
    if (missing.length > 0) {
      throw new AgentError(
        `Nothing has been imported for: ${missing.map(categoryLabel).join(' and ')}. Attach an export first, or switch that context source off — an agent cannot read a catalogue you have not given it.`,
      )
    }
  }

  const fromStage = clampStage(input.fromStage ?? product.currentStage)
  const toStage = clampStage(input.toStage ?? STAGES.length)
  if (toStage < fromStage) throw new AgentError('The last stage cannot come before the first.')

  const run = await prisma.$transaction(async (tx) => {
    const created = await tx.agentRun.create({
      data: {
        workspaceId: input.workspaceId,
        productId: input.productId,
        mode: input.mode,
        state: 'RUNNING',
        requestedModel: input.modelId,
        contextSourcesJson: JSON.stringify(contextSources),
        fromStage,
        toStage,
        currentStage: fromStage,
        startedById: input.userId,
        statusDetail:
          input.mode === 'AUTOMATED'
            ? 'Dispatching the first stage.'
            : 'Waiting for you to dispatch the first agent.',
      },
    })

    // The whole route is planned up front so the operator sees where this goes before any spend.
    let sequence = 0
    for (let stage = fromStage; stage <= toStage; stage += 1) {
      for (const agentId of plannedAgentsForStage(stage)) {
        await tx.agentRunStep.create({
          data: { runId: created.id, stageNumber: stage, agentId, sequence: sequence++ },
        })
      }
    }

    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      productId: input.productId,
      actorId: input.userId,
      action: AUDIT_ACTIONS.AGENT_RUN_STARTED,
      entityType: 'AgentRun',
      entityId: created.id,
      data: {
        mode: input.mode,
        model: input.modelId,
        contextSources,
        fromStage,
        toStage,
        steps: sequence,
      },
    })

    return created
  })

  return run.id
}

export interface RunStageStatus {
  stageNumber: number
  name: string
  /** Proposals from this run's dispatches that nobody has dispositioned yet. */
  pendingProposals: number
  dispositionedProposals: number
  gateState: string
  blockingCriteria: number
  passingCriteria: number
}

export interface RunView {
  id: string
  mode: RunMode
  state: RunState
  statusDetail: string
  requestedModel: string
  contextSources: ConnectorCategory[]
  fromStage: number
  toStage: number
  currentStage: number
  startedAt: Date
  endedAt: Date | null
  endedReason: string
  productId: string
  productName: string
  steps: {
    id: string
    stageNumber: number
    agentId: string
    agentName: string
    sequence: number
    state: RunStepState
    detail: string
    narrative: string
    agentActionId: string | null
    endedAt: Date | null
  }[]
  stages: RunStageStatus[]
}

export async function loadRun(runId: string): Promise<RunView | null> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    include: { steps: { orderBy: { sequence: 'asc' } }, product: { select: { name: true } } },
  })
  if (!run) return null

  const stages: RunStageStatus[] = []
  for (let stage = run.fromStage; stage <= run.toStage; stage += 1) {
    stages.push(await stageStatus(run.productId, stage))
  }

  return {
    id: run.id,
    mode: run.mode as RunMode,
    state: run.state as RunState,
    statusDetail: run.statusDetail,
    requestedModel: run.requestedModel,
    contextSources: parseContextSources(run.contextSourcesJson),
    fromStage: run.fromStage,
    toStage: run.toStage,
    currentStage: run.currentStage,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    endedReason: run.endedReason,
    productId: run.productId,
    productName: run.product.name,
    steps: run.steps.map((step) => ({
      id: step.id,
      stageNumber: step.stageNumber,
      agentId: step.agentId,
      agentName: agentName(step.agentId),
      sequence: step.sequence,
      state: step.state as RunStepState,
      detail: step.detail,
      narrative: step.narrative,
      agentActionId: step.agentActionId,
      endedAt: step.endedAt,
    })),
    stages,
  }
}

async function stageStatus(productId: string, stageNumber: number): Promise<RunStageStatus> {
  const proposals = await prisma.agentProposal.groupBy({
    by: ['state'],
    where: { productId, stageNumber },
    _count: true,
  })
  const pending = proposals.find((p) => p.state === 'PENDING')?._count ?? 0
  const done = proposals.filter((p) => p.state !== 'PENDING').reduce((sum, p) => sum + p._count, 0)

  const gate = await prisma.gate.findFirst({
    where: { productId, stageNumber },
    orderBy: { openedAt: 'desc' },
    select: { state: true },
  })

  let blocking = 0
  let passing = 0
  try {
    const criteria = await evaluateExitCriteria(productId, stageNumber)
    const blockingOnes = criteria.filter((c) => c.blocking)
    blocking = blockingOnes.length
    passing = blockingOnes.filter((c) => c.passed).length
  } catch {
    // A stage whose run has never been opened cannot be evaluated yet. Zero is the honest answer.
  }

  return {
    stageNumber,
    name: getStage(stageNumber).name,
    pendingProposals: pending,
    dispositionedProposals: done,
    gateState: gate?.state ?? 'NOT_OPENED',
    blockingCriteria: blocking,
    passingCriteria: passing,
  }
}

/**
 * Recompute where a run stands and, in AUTOMATED mode, dispatch whatever it may dispatch now.
 *
 * Called on every console poll and after every disposition and gate decision. It is deliberately
 * idempotent and deliberately synchronous: there is no background worker, so nothing happens
 * except while a human is looking at it — which is the correct property for a system whose whole
 * claim is that a human is in the loop.
 */
export async function syncAgentRun(runId: string, userId: string): Promise<RunView> {
  const run = await prisma.agentRun.findUniqueOrThrow({
    where: { id: runId },
    include: { steps: { orderBy: { sequence: 'asc' } } },
  })

  if (isRunTerminal(run.state)) return (await loadRun(runId))!

  // Advance past every stage whose gate a human has already approved.
  let stage = run.currentStage
  while (stage <= run.toStage && (await gateApproved(run.productId, stage))) stage += 1

  if (stage > run.toStage) {
    await finishRun(runId, run.workspaceId, run.productId, userId, 'COMPLETED', 'Every stage in range has an approved gate.')
    return (await loadRun(runId))!
  }

  if (stage !== run.currentStage) {
    await prisma.agentRun.update({
      where: { id: runId },
      data: { currentStage: stage, state: 'RUNNING', statusDetail: `Resuming into Stage ${stage}.` },
    })
  }

  const stageSteps = run.steps.filter((s) => s.stageNumber === stage)
  const undispatched = stageSteps.filter((s) => s.state === 'PENDING')

  if (undispatched.length > 0 && run.mode === 'AUTOMATED') {
    await dispatchStage(runId, userId)
    return syncAgentRun(runId, userId)
  }

  const status = await stageStatus(run.productId, stage)
  const next = await nextState({ run: { ...run, currentStage: stage }, status, undispatched: undispatched.length })

  await prisma.agentRun.update({
    where: { id: runId },
    data: { currentStage: stage, state: next.state, statusDetail: next.detail },
  })

  return (await loadRun(runId))!
}

function nextState(params: {
  run: { mode: string; toStage: number; currentStage: number }
  status: RunStageStatus
  undispatched: number
}): { state: RunState; detail: string } {
  const { status, run, undispatched } = params
  const stage = run.currentStage

  if (undispatched > 0) {
    return {
      state: 'RUNNING',
      detail: `Stage ${stage}: ${undispatched} agent(s) not yet dispatched. Dispatch each one when you are ready.`,
    }
  }
  if (status.pendingProposals > 0) {
    return {
      state: 'AWAITING_REVIEW',
      detail: `Stage ${stage}: ${status.pendingProposals} drafted item(s) waiting for a human to accept, edit or reject. Nothing has been applied.`,
    }
  }
  if (status.gateState === 'APPROVED') {
    return { state: 'RUNNING', detail: `Stage ${stage} gate approved. Moving on.` }
  }
  return {
    state: 'AWAITING_GATE',
    detail:
      status.blockingCriteria > 0 && status.passingCriteria < status.blockingCriteria
        ? `Stage ${stage}: every draft is dispositioned. ${status.passingCriteria}/${status.blockingCriteria} blocking exit criteria pass — commit the artifact, then the approvers can open the gate.`
        : `Stage ${stage}: every draft is dispositioned and the exit criteria pass. The gate is a human decision — approvers must record it in the Lifecycle Studio.`,
  }
}

async function gateApproved(productId: string, stageNumber: number): Promise<boolean> {
  const gate = await prisma.gate.findFirst({
    where: { productId, stageNumber, state: 'APPROVED' },
    select: { id: true },
  })
  return Boolean(gate)
}

/**
 * Dispatch every not-yet-run agent for the run's current stage. One agent at a time, in registry
 * order, stopping at the first failure so a blown budget does not become twelve blown budgets.
 */
export async function dispatchStage(runId: string, userId: string): Promise<void> {
  const run = await prisma.agentRun.findUniqueOrThrow({
    where: { id: runId },
    include: { steps: { orderBy: { sequence: 'asc' } } },
  })
  if (isRunTerminal(run.state)) return

  const pending = run.steps.filter((s) => s.stageNumber === run.currentStage && s.state === 'PENDING')
  for (const step of pending) {
    const failed = await dispatchStep(runId, step.id, userId)
    if (failed) return
  }
}

/** Dispatch one planned step. Returns true when the run was blocked by the attempt. */
export async function dispatchStep(runId: string, stepId: string, userId: string): Promise<boolean> {
  const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
  if (isRunTerminal(run.state)) return false
  const step = await prisma.agentRunStep.findUniqueOrThrow({ where: { id: stepId } })
  if (step.state !== 'PENDING') return false

  await prisma.agentRunStep.update({
    where: { id: stepId },
    data: { state: 'RUNNING', startedAt: new Date() },
  })

  // The stage run has to exist before an agent can be dispatched against it: the criteria the
  // Critic reads are evaluated against it, and the gate a human will later open hangs off it.
  await ensureStageRun(run.productId, step.stageNumber)

  try {
    const result = await invokeAgent({
      agentId: step.agentId,
      workspaceId: run.workspaceId,
      productId: run.productId,
      stageNumber: step.stageNumber,
      userId,
      trigger: 'MANUAL',
      modelOverride: run.requestedModel,
      externalCategories: parseContextSources(run.contextSourcesJson),
    })
    await prisma.agentRunStep.update({
      where: { id: stepId },
      data: {
        state: 'DRAFTED',
        agentActionId: result.actionId,
        endedAt: new Date(),
        narrative: result.narrative,
        detail: `${result.proposalCount} proposal(s), ${result.commentCount} comment(s), ${result.findingCount} finding(s) via ${result.model}. ${result.redactedFields.length} field(s) redacted before transmission. Nothing applied.`,
      },
    })
    return false
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The agent could not run.'
    // A budget or configuration refusal blocks the run; a charter refusal only skips the step,
    // because a stage with no eligible agent is a stage a human writes, not a broken run.
    const blocking = !/not chartered|not permitted|switched off|only runs when/i.test(message)
    await prisma.agentRunStep.update({
      where: { id: stepId },
      data: { state: blocking ? 'FAILED' : 'SKIPPED', endedAt: new Date(), detail: message },
    })
    if (blocking) {
      await prisma.agentRun.update({
        where: { id: runId },
        data: { state: 'BLOCKED', statusDetail: message },
      })
    }
    return blocking
  }
}

export async function cancelAgentRun(runId: string, userId: string, reason: string): Promise<void> {
  const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
  if (isRunTerminal(run.state)) return
  await assertRole(userId, run.workspaceId, PRACTITIONER_ROLES, 'Cancelling an agent run')
  await finishRun(
    runId,
    run.workspaceId,
    run.productId,
    userId,
    'CANCELLED',
    reason || 'Cancelled by the operator.',
  )
}

/**
 * Ending a run ends the dispatching, and nothing else. Proposals already drafted stay exactly
 * where they are — pending a human — because a cancelled run must not quietly discard work
 * somebody may still want to review.
 */
async function finishRun(
  runId: string,
  workspaceId: string,
  productId: string,
  userId: string,
  state: 'COMPLETED' | 'CANCELLED',
  reason: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.agentRun.update({
      where: { id: runId },
      data: { state, endedAt: new Date(), endedReason: reason, statusDetail: reason },
    })
    await recordAudit(tx, {
      workspaceId,
      productId,
      actorId: userId,
      action:
        state === 'COMPLETED' ? AUDIT_ACTIONS.AGENT_RUN_COMPLETED : AUDIT_ACTIONS.AGENT_RUN_CANCELLED,
      entityType: 'AgentRun',
      entityId: runId,
      data: { reason },
    })
  })
}

/** Stored as JSON on the run; unrecognised entries are dropped rather than trusted. */
function parseContextSources(json: string): ConnectorCategory[] {
  try {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (value): value is ConnectorCategory =>
        value === 'DATA_CATALOGUE' || value === 'DATA_MODELLING' || value === 'OPEN',
    )
  } catch {
    return []
  }
}

export function categoryLabel(category: ConnectorCategory): string {
  if (category === 'DATA_CATALOGUE') return 'data catalogue'
  if (category === 'DATA_MODELLING') return 'data modelling'
  return 'canonical import'
}

function clampStage(value: number): number {
  if (!Number.isInteger(value)) return 1
  return Math.min(Math.max(value, 1), STAGES.length)
}
