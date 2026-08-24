import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit/log'
import { assertRole, rolesForUser } from '@/lib/auth/authorise'
import type { Decision } from '@/lib/domain/enums'
import type { RoleKey } from '@/lib/domain/roles'
import { buildStageContext } from './context'
import { allBlockingPassed, failedBlocking, type CriterionResult } from './criteria'
import { getStage, LAST_STAGE } from './stages'

/**
 * The only two gate paths in the application.
 *
 *   requestTransition() moves a stage run between DRAFT, IN_REVIEW, CHANGES_REQUESTED and
 *   GATE_OPEN. It can open a gate. It can never approve one.
 *
 *   recordDecision() is the sole code path that may set Gate.state to APPROVED — invariant 2.
 *   No route handler, service, seed script, agent or admin action writes that state directly.
 *   tests/gate-engine.test.ts asserts this against the source tree.
 */

export class TransitionError extends Error {
  constructor(
    message: string,
    readonly failures: CriterionResult[] = [],
  ) {
    super(message)
    this.name = 'TransitionError'
  }
}

export type TransitionAction =
  | 'SUBMIT_FOR_REVIEW'
  | 'REQUEST_CHANGES'
  | 'WITHDRAW_TO_DRAFT'
  | 'OPEN_GATE'

export interface TransitionInput {
  productId: string
  stageNumber: number
  action: TransitionAction
  userId: string
  note?: string
}

export interface StageRunView {
  id: string
  productId: string
  stageNumber: number
  attempt: number
  state: string
}

/** Every product/stage pair has exactly one live stage run; this creates it on first touch. */
export async function ensureStageRun(
  productId: string,
  stageNumber: number,
): Promise<StageRunView> {
  const existing = await prisma.stageRun.findFirst({
    where: { productId, stageNumber },
    orderBy: { attempt: 'desc' },
  })
  if (existing) return existing
  return prisma.stageRun.create({ data: { productId, stageNumber } })
}

async function currentStageRun(productId: string, stageNumber: number) {
  const run = await prisma.stageRun.findFirst({
    where: { productId, stageNumber },
    orderBy: { attempt: 'desc' },
    include: { gate: true },
  })
  if (!run) throw new TransitionError(`Stage ${stageNumber} has not been started for this product.`)
  return run
}

/** Evaluate the exit criteria for a stage exactly as the gate will. */
export async function evaluateExitCriteria(
  productId: string,
  stageNumber: number,
): Promise<CriterionResult[]> {
  const stage = getStage(stageNumber)
  const ctx = await buildStageContext(productId, stageNumber)
  return stage.exitCriteria(ctx)
}

export async function requestTransition(input: TransitionInput): Promise<StageRunView> {
  const stage = getStage(input.stageNumber)
  const product = await prisma.dataProduct.findUniqueOrThrow({
    where: { id: input.productId },
    select: { id: true, workspaceId: true, ownerId: true, key: true },
  })

  const run = await currentStageRun(input.productId, input.stageNumber)
  const held = await rolesForUser(input.userId, product.workspaceId)

  switch (input.action) {
    case 'SUBMIT_FOR_REVIEW':
      return submitForReview({ input, stage, product, run, held })
    case 'REQUEST_CHANGES':
      return requestChanges({ input, stage, product, run, held })
    case 'WITHDRAW_TO_DRAFT':
      return withdrawToDraft({ input, product, run })
    case 'OPEN_GATE':
      return openGate({ input, stage, product, run, held })
  }
}

type TransitionContext = {
  input: TransitionInput
  stage: ReturnType<typeof getStage>
  product: { id: string; workspaceId: string; ownerId: string; key: string }
  run: { id: string; state: string; stageNumber: number; attempt: number; productId: string }
  held: RoleKey[]
}

async function submitForReview({ input, stage, product, run }: TransitionContext) {
  if (run.state !== 'DRAFT' && run.state !== 'CHANGES_REQUESTED') {
    throw new TransitionError(
      `Stage ${stage.number} is ${run.state}; only a draft or changes-requested stage can be submitted.`,
    )
  }
  const results = await evaluateExitCriteria(input.productId, input.stageNumber)
  if (!allBlockingPassed(results)) {
    throw new TransitionError(
      `Stage ${stage.number} does not meet its exit criteria.`,
      failedBlocking(results),
    )
  }

  return prisma.$transaction(async (tx: any) => {
    const updated = await tx.stageRun.update({
      where: { id: run.id },
      data: { state: 'IN_REVIEW', submittedAt: new Date() },
    })
    await recordAudit(tx, {
      workspaceId: product.workspaceId,
      productId: product.id,
      actorId: input.userId,
      action: AUDIT_ACTIONS.STAGE_SUBMITTED,
      entityType: 'StageRun',
      entityId: run.id,
      data: { stageNumber: stage.number, attempt: run.attempt, note: input.note ?? '' },
    })
    return updated
  })
}

async function requestChanges({ input, stage, product, run, held }: TransitionContext) {
  if (run.state !== 'IN_REVIEW' && run.state !== 'GATE_OPEN') {
    throw new TransitionError(`Stage ${stage.number} is not under review.`)
  }
  if (!held.some((r) => stage.approverRoles.includes(r))) {
    throw new TransitionError(
      `Requesting changes on Stage ${stage.number} requires one of: ${stage.approverRoles.join(', ')}.`,
    )
  }

  return prisma.$transaction(async (tx: any) => {
    const updated = await tx.stageRun.update({
      where: { id: run.id },
      data: { state: 'CHANGES_REQUESTED' },
    })
    const gate = await tx.gate.findUnique({ where: { stageRunId: run.id } })
    if (gate && gate.state === 'OPEN') {
      await tx.gate.update({
        where: { id: gate.id },
        data: { state: 'PENDING', openedAt: null },
      })
    }
    await recordAudit(tx, {
      workspaceId: product.workspaceId,
      productId: product.id,
      actorId: input.userId,
      action: AUDIT_ACTIONS.STAGE_CHANGES_REQUESTED,
      entityType: 'StageRun',
      entityId: run.id,
      data: { stageNumber: stage.number, note: input.note ?? '' },
    })
    return updated
  })
}

async function withdrawToDraft({
  input,
  product,
  run,
}: Pick<TransitionContext, 'input' | 'product' | 'run'>) {
  if (run.state === 'APPROVED') {
    throw new TransitionError('An approved stage cannot be withdrawn. Commit a new version instead.')
  }
  return prisma.$transaction(async (tx: any) => {
    const updated = await tx.stageRun.update({ where: { id: run.id }, data: { state: 'DRAFT' } })
    const gate = await tx.gate.findUnique({ where: { stageRunId: run.id } })
    if (gate && gate.state === 'OPEN') {
      await tx.gate.update({ where: { id: gate.id }, data: { state: 'PENDING', openedAt: null } })
    }
    await recordAudit(tx, {
      workspaceId: product.workspaceId,
      productId: product.id,
      actorId: input.userId,
      action: AUDIT_ACTIONS.STAGE_WITHDRAWN,
      entityType: 'StageRun',
      entityId: run.id,
      data: { stageNumber: run.stageNumber },
    })
    return updated
  })
}

async function openGate({ input, stage, product, run, held }: TransitionContext) {
  if (run.state !== 'IN_REVIEW') {
    throw new TransitionError(
      `Stage ${stage.number} must be in review before its gate opens (currently ${run.state}).`,
    )
  }
  if (!held.some((r) => stage.approverRoles.includes(r))) {
    throw new TransitionError(
      `Opening the Stage ${stage.number} gate requires one of: ${stage.approverRoles.join(', ')}.`,
    )
  }
  const results = await evaluateExitCriteria(input.productId, input.stageNumber)
  if (!allBlockingPassed(results)) {
    throw new TransitionError(
      `Stage ${stage.number} does not meet its exit criteria.`,
      failedBlocking(results),
    )
  }

  return prisma.$transaction(async (tx: any) => {
    const existing = await tx.gate.findUnique({ where: { stageRunId: run.id } })
    const gate = existing
      ? await tx.gate.update({
          where: { id: existing.id },
          data: { state: 'OPEN', openedAt: new Date(), staleReason: null, staleAt: null },
        })
      : await tx.gate.create({
          data: {
            productId: product.id,
            stageNumber: stage.number,
            stageRunId: run.id,
            state: 'OPEN',
            quorum: stage.quorum,
            requiredRoles: stage.approverRoles.join(','),
            vetoRoles: stage.vetoRoles.join(','),
            openedAt: new Date(),
          },
        })

    for (const roleKey of stage.approverRoles) {
      const alreadyOpen = await tx.task.findFirst({
        where: { gateId: gate.id, assigneeRoleKey: roleKey, kind: 'GATE_APPROVAL', completedAt: null },
      })
      if (alreadyOpen) continue
      await tx.task.create({
        data: {
          workspaceId: product.workspaceId,
          productId: product.id,
          gateId: gate.id,
          kind: 'GATE_APPROVAL',
          title: `Approve Stage ${stage.number} — ${stage.name}`,
          detail: stage.purpose,
          assigneeRoleKey: roleKey,
        },
      })
    }

    const updated = await tx.stageRun.update({
      where: { id: run.id },
      data: { state: 'GATE_OPEN' },
    })
    await recordAudit(tx, {
      workspaceId: product.workspaceId,
      productId: product.id,
      actorId: input.userId,
      action: AUDIT_ACTIONS.GATE_OPENED,
      entityType: 'Gate',
      entityId: gate.id,
      data: {
        stageNumber: stage.number,
        quorum: stage.quorum,
        requiredRoles: stage.approverRoles,
        vetoRoles: stage.vetoRoles,
      },
    })
    return updated
  })
}

export interface DecisionInput {
  gateId: string
  userId: string
  decision: Decision
  rationale?: string
  /** Which of the user's roles they are voting as. Must be an approver role for the stage. */
  roleKey?: RoleKey
}

export interface DecisionResult {
  gateId: string
  gateState: string
  approvingRoles: RoleKey[]
  outstandingRoles: RoleKey[]
  quorum: number
}

/**
 * The single approval path. Applies quorum, veto and role checks server-side, records the
 * approval, snapshots the evidence the approval rests on, and — only here — sets APPROVED.
 */
export async function recordDecision(input: DecisionInput): Promise<DecisionResult> {
  const gate = await prisma.gate.findUniqueOrThrow({
    where: { id: input.gateId },
    include: { product: true, approvals: true, stageRun: true },
  })
  const stage = getStage(gate.stageNumber)

  if (gate.state !== 'OPEN') {
    throw new TransitionError(
      `Gate for Stage ${gate.stageNumber} is ${gate.state}; decisions can only be recorded on an open gate.`,
    )
  }

  const eligibleRoles: RoleKey[] = [
    ...new Set<RoleKey>([...stage.approverRoles, ...stage.vetoRoles]),
  ]
  const matching = await assertRole(
    input.userId,
    gate.product.workspaceId,
    eligibleRoles,
    `Recording a decision on Stage ${gate.stageNumber}`,
  )
  const votingRole = input.roleKey && matching.includes(input.roleKey) ? input.roleKey : matching[0]
  if (!votingRole) {
    throw new TransitionError('No eligible role to vote with on this gate.')
  }

  return prisma.$transaction(async (tx: any) => {
    await tx.approval.upsert({
      where: {
        gateId_userId_roleKey: { gateId: gate.id, userId: input.userId, roleKey: votingRole },
      },
      update: { decision: input.decision, rationale: input.rationale ?? '' },
      create: {
        gateId: gate.id,
        userId: input.userId,
        roleKey: votingRole,
        decision: input.decision,
        rationale: input.rationale ?? '',
      },
    })

    await recordAudit(tx, {
      workspaceId: gate.product.workspaceId,
      productId: gate.productId,
      actorId: input.userId,
      action: AUDIT_ACTIONS.GATE_DECISION_RECORDED,
      entityType: 'Gate',
      entityId: gate.id,
      data: {
        stageNumber: gate.stageNumber,
        decision: input.decision,
        roleKey: votingRole,
        rationale: input.rationale ?? '',
      },
    })

    const approvals = await tx.approval.findMany({ where: { gateId: gate.id } })
    const outcome = evaluateGateOutcome({
      approverRoles: stage.approverRoles,
      vetoRoles: stage.vetoRoles,
      quorum: gate.quorum,
      approvals: approvals.map((a) => ({ roleKey: a.roleKey as RoleKey, decision: a.decision as Decision })),
    })

    if (outcome.state === 'APPROVED') {
      await approveGate(tx, gate.id, gate.productId, gate.product.workspaceId, gate.stageNumber, input.userId, gate.stageRunId)
    } else if (outcome.state === 'REJECTED') {
      await tx.gate.update({
        where: { id: gate.id },
        data: { state: 'REJECTED', decidedAt: new Date() },
      })
      await tx.stageRun.update({
        where: { id: gate.stageRunId },
        data: { state: 'CHANGES_REQUESTED' },
      })
      await tx.task.updateMany({
        where: { gateId: gate.id, completedAt: null, kind: 'GATE_APPROVAL' },
        data: { completedAt: new Date() },
      })
      await recordAudit(tx, {
        workspaceId: gate.product.workspaceId,
        productId: gate.productId,
        actorId: input.userId,
        action: AUDIT_ACTIONS.GATE_REJECTED,
        entityType: 'Gate',
        entityId: gate.id,
        data: { stageNumber: gate.stageNumber, reason: outcome.reason },
      })
    }

    return {
      gateId: gate.id,
      gateState: outcome.state,
      approvingRoles: outcome.approvingRoles,
      outstandingRoles: outcome.outstandingRoles,
      quorum: gate.quorum,
    }
  })
}

/**
 * The only place in the codebase that writes Gate.state = 'APPROVED'. Private to this module.
 */
async function approveGate(
  tx: Prisma.TransactionClient,
  gateId: string,
  productId: string,
  workspaceId: string,
  stageNumber: number,
  actorId: string,
  stageRunId: string,
): Promise<void> {
  await tx.gate.update({
    where: { id: gateId },
    data: { state: 'APPROVED', decidedAt: new Date(), staleReason: null, staleAt: null },
  })
  await tx.stageRun.update({
    where: { id: stageRunId },
    data: { state: 'APPROVED', closedAt: new Date() },
  })
  await tx.task.updateMany({
    where: { gateId, completedAt: null },
    data: { completedAt: new Date() },
  })

  // Snapshot the evidence this approval rests on, so a later commit can invalidate it honestly.
  const artifacts = await tx.artifact.findMany({
    where: { productId, archivedAt: null },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  })
  for (const artifact of artifacts) {
    const version = artifact.versions[0]
    if (!version) continue
    await tx.gateEvidence.upsert({
      where: { gateId_artifactId: { gateId, artifactId: artifact.id } },
      update: { artifactVersionId: version.id, contentHash: version.contentHash },
      create: {
        gateId,
        artifactId: artifact.id,
        artifactVersionId: version.id,
        contentHash: version.contentHash,
      },
    })
  }

  const product = await tx.dataProduct.findUniqueOrThrow({ where: { id: productId } })
  const nextStage = Math.min(stageNumber + 1, LAST_STAGE)
  await tx.dataProduct.update({
    where: { id: productId },
    data: {
      currentStage: Math.max(product.currentStage, nextStage),
      ...(stageNumber === 11
        ? { status: 'PUBLISHED', publishedAt: product.publishedAt ?? new Date() }
        : {}),
    },
  })

  if (stageNumber < LAST_STAGE) {
    const existingNext = await tx.stageRun.findFirst({
      where: { productId, stageNumber: nextStage },
    })
    if (!existingNext) {
      await tx.stageRun.create({ data: { productId, stageNumber: nextStage } })
    }
  }

  await recordAudit(tx, {
    workspaceId,
    productId,
    actorId,
    action: AUDIT_ACTIONS.GATE_APPROVED,
    entityType: 'Gate',
    entityId: gateId,
    data: { stageNumber, evidenceCount: artifacts.length },
  })

  if (stageNumber === 11) {
    await recordAudit(tx, {
      workspaceId,
      productId,
      actorId,
      action: AUDIT_ACTIONS.PRODUCT_PUBLISHED,
      entityType: 'DataProduct',
      entityId: productId,
      data: { stageNumber },
    })
  }
}

export interface GateOutcome {
  state: 'OPEN' | 'APPROVED' | 'REJECTED'
  approvingRoles: RoleKey[]
  outstandingRoles: RoleKey[]
  reason: string
}

/**
 * Pure quorum/veto arithmetic, exported so the rules can be tested without a database.
 *
 *   * A REJECT from any veto role rejects the gate outright.
 *   * A veto role that is also an approver role must record an approval before the gate passes;
 *     silence from a veto holder is not consent.
 *   * Otherwise the gate approves when the count of distinct approving approver roles reaches
 *     quorum, and rejects when enough approver roles have rejected that quorum is unreachable.
 */
export function evaluateGateOutcome(params: {
  approverRoles: RoleKey[]
  vetoRoles: RoleKey[]
  quorum: number
  approvals: { roleKey: RoleKey; decision: Decision }[]
}): GateOutcome {
  const { approverRoles, vetoRoles, quorum, approvals } = params

  const vetoRejection = approvals.find(
    (a) => a.decision === 'REJECT' && vetoRoles.includes(a.roleKey),
  )
  const approvingRoles = [
    ...new Set(
      approvals
        .filter((a) => a.decision === 'APPROVE' && approverRoles.includes(a.roleKey))
        .map((a) => a.roleKey),
    ),
  ]
  const rejectingRoles = [
    ...new Set(
      approvals
        .filter((a) => a.decision === 'REJECT' && approverRoles.includes(a.roleKey))
        .map((a) => a.roleKey),
    ),
  ]
  const outstandingRoles = approverRoles.filter(
    (r) => !approvingRoles.includes(r) && !rejectingRoles.includes(r),
  )

  if (vetoRejection) {
    return {
      state: 'REJECTED',
      approvingRoles,
      outstandingRoles,
      reason: `${vetoRejection.roleKey} exercised a veto.`,
    }
  }

  const vetoApproversOutstanding = vetoRoles.filter(
    (r) => approverRoles.includes(r) && !approvingRoles.includes(r),
  )

  if (approvingRoles.length >= quorum && vetoApproversOutstanding.length === 0) {
    return { state: 'APPROVED', approvingRoles, outstandingRoles, reason: 'Quorum reached.' }
  }

  if (approvingRoles.length + outstandingRoles.length < quorum) {
    return {
      state: 'REJECTED',
      approvingRoles,
      outstandingRoles,
      reason: 'Quorum can no longer be reached.',
    }
  }

  return {
    state: 'OPEN',
    approvingRoles,
    outstandingRoles,
    reason:
      vetoApproversOutstanding.length > 0
        ? `Awaiting the veto holder: ${vetoApproversOutstanding.join(', ')}.`
        : `Awaiting ${quorum - approvingRoles.length} more approval(s).`,
  }
}
