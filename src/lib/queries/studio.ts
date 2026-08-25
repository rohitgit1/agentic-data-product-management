import { prisma } from '@/lib/db'
import { artifactTypesForStage, getArtifactType } from '@/lib/artifacts/registry'
import { serialiseContent } from '@/lib/artifacts/serialise'
import { diffContent, summariseDiff, type FieldChange } from '@/lib/artifacts/diff'
import { buildStageContext } from '@/lib/lifecycle/context'
import { getStage } from '@/lib/lifecycle/stages'
import type { CriterionResult } from '@/lib/lifecycle/criteria'
import { agentsForStage } from '@/lib/agents/registry'
import { stringify as yamlStringify } from 'yaml'

export interface StageArtifactView {
  type: string
  title: string
  description: string
  fileName: string
  format: string
  version?: number
  committedAt?: Date
  yaml: string
  provenance: { fieldPath: string; provenance: string; agentId: string | null }[]
  diff?: { changes: FieldChange[]; summary: string; fromVersion: number; toVersion: number }
}

/**
 * A serialisable projection of the stage definition. The definition itself holds the exit-criteria
 * function, which cannot cross the server/client boundary — and should not, since the criteria are
 * always evaluated on the server.
 */
export interface StageSummary {
  number: number
  key: string
  name: string
  purpose: string
  whyItMatters: string
  requiredArtifacts: string[]
  approverRoles: string[]
  quorum: number
  vetoRoles: string[]
  permittedAgents: string[]
  guideKey: string
}

export interface StageView {
  product: {
    id: string
    key: string
    name: string
    status: string
    currentStage: number
    semanticVersion: string
    workspaceId: string
    ownerName: string
    domainName: string
  }
  stage: StageSummary
  run: { id: string; state: string; attempt: number; submittedAt: Date | null }
  gate?: {
    id: string
    state: string
    quorum: number
    requiredRoles: string[]
    vetoRoles: string[]
    staleReason: string | null
    approvals: { roleKey: string; decision: string; rationale: string; userName: string; createdAt: Date }[]
  }
  criteria: CriterionResult[]
  artifacts: StageArtifactView[]
  comments: {
    id: string
    body: string
    kind: string
    fieldPath: string | null
    authorName: string
    createdAt: Date
    resolvedAt: Date | null
  }[]
  proposals: {
    id: string
    agentId: string
    fieldPath: string
    rationale: string
    state: string
    preview: string
    isComment: boolean
  }[]
  agents: { id: string; name: string; charter: string; readScope: string[]; ceiling: string }[]
  audit: { id: string; action: string; actorName: string; createdAt: Date; data: string }[]
  approvedStages: number[]
}

export async function loadStageView(productId: string, stageNumber: number): Promise<StageView | undefined> {
  const product = await prisma.dataProduct.findUnique({
    where: { id: productId },
    include: { owner: true, domain: true },
  })
  if (!product) return undefined

  let run = await prisma.stageRun.findFirst({
    where: { productId, stageNumber },
    orderBy: { attempt: 'desc' },
  })
  if (!run) {
    run = {
      id: `sr_auto_${productId}_${stageNumber}`,
      productId,
      stageNumber,
      attempt: 1,
      state: 'IN_PROGRESS',
      startedAt: new Date(),
      completedAt: null,
    } as any
  }

  let gateRow = await prisma.gate.findUnique({
    where: { stageRunId: run.id },
    include: { approvals: { include: { user: true } } },
  })

  const ctx = await buildStageContext(productId, stageNumber)
  const criteria = stage.exitCriteria(ctx)

  const artifacts: StageArtifactView[] = []
  for (const type of artifactTypesForStage(stageNumber)) {
    const artifact = await prisma.artifact.findUnique({
      where: { productId_type: { productId, type: type.key } },
      include: {
        versions: { orderBy: { version: 'desc' }, take: 2, include: { provenance: true } },
      },
    })
    const latest = artifact?.versions[0]
    const previous = artifact?.versions[1]
    const content = latest ? (JSON.parse(latest.contentJson) as unknown) : type.empty()
    const changes = latest && previous ? diffContent(JSON.parse(previous.contentJson), JSON.parse(latest.contentJson)) : undefined

    artifacts.push({
      type: type.key,
      title: type.title,
      description: type.description,
      fileName: type.fileName,
      format: type.format,
      version: latest?.version,
      committedAt: latest?.createdAt,
      yaml: yamlStringify(content, { lineWidth: 100 }),
      provenance:
        (latest?.provenance ?? []).map((p) => ({
          fieldPath: p.fieldPath,
          provenance: p.provenance,
          agentId: p.agentId,
        })),
      diff:
        changes && latest && previous
          ? {
              changes: changes.slice(0, 40),
              summary: summariseDiff(changes),
              fromVersion: previous.version,
              toVersion: latest.version,
            }
          : undefined,
    })
  }

  const comments = await prisma.comment.findMany({
    where: { productId, stageNumber },
    include: { author: true },
    orderBy: { createdAt: 'asc' },
  })

  const proposalRows = await prisma.agentProposal.findMany({
    where: { productId, stageNumber },
    include: { agentAction: true },
    orderBy: { createdAt: 'desc' },
    take: 60,
  })

  const audit = await prisma.auditEvent.findMany({
    where: { productId },
    include: { actor: true },
    orderBy: { createdAt: 'desc' },
    take: 40,
  })

  return {
    product: {
      id: product.id,
      key: product.key,
      name: product.name,
      status: product.status,
      currentStage: product.currentStage,
      semanticVersion: product.semanticVersion,
      workspaceId: product.workspaceId,
      ownerName: product.owner.name,
      domainName: product.domain.name,
    },
    stage: {
      number: stage.number,
      key: stage.key,
      name: stage.name,
      purpose: stage.purpose,
      whyItMatters: stage.whyItMatters,
      requiredArtifacts: stage.requiredArtifacts,
      approverRoles: stage.approverRoles,
      quorum: stage.quorum,
      vetoRoles: stage.vetoRoles,
      permittedAgents: stage.permittedAgents,
      guideKey: stage.guideKey,
    },
    run: { id: run.id, state: run.state, attempt: run.attempt, submittedAt: run.submittedAt },
    gate: gateRow
      ? {
          id: gateRow.id,
          state: gateRow.state,
          quorum: gateRow.quorum,
          requiredRoles: (gateRow.requiredRoles || '').split(',').filter(Boolean),
          vetoRoles: (gateRow.vetoRoles || '').split(',').filter(Boolean),
          staleReason: gateRow.staleReason,
          approvals: (gateRow.approvals || []).map((a) => ({
            roleKey: a.roleKey,
            decision: a.decision,
            rationale: a.rationale,
            userName: a.user?.name ?? 'System',
            createdAt: a.createdAt,
          })),
        }
      : undefined,
    criteria,
    artifacts,
    comments: comments.map((c) => ({
      id: c.id,
      body: c.body,
      kind: c.kind,
      fieldPath: c.fieldPath,
      authorName: c.author.name,
      createdAt: c.createdAt,
      resolvedAt: c.resolvedAt,
    })),
    proposals: proposalRows.map((p) => {
      const value = JSON.parse(p.proposedValueJson) as unknown
      const isComment = !!value && typeof value === 'object' && 'comment' in (value as object)
      return {
        id: p.id,
        agentId: p.agentAction?.agentId ?? 'agent-unknown',
        fieldPath: p.fieldPath,
        rationale: p.rationale,
        state: p.state,
        preview: isComment
          ? String((value as { comment: string }).comment)
          : serialiseContent(value, 'yaml').slice(0, 1200),
        isComment,
      }
    }),
    agents: agentsForStage(stageNumber)
      .filter((agent) => stage.permittedAgents.includes(agent.id))
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        charter: agent.charter,
        readScope: agent.readScope,
        ceiling: agent.autonomyCeiling,
      })),
    audit: audit.map((event) => ({
      id: event.id,
      action: event.action,
      actorName: event.actor?.name ?? (event.actorType === 'SYSTEM' ? 'System' : 'Unknown'),
      createdAt: event.createdAt,
      data: event.dataJson,
    })),
    approvedStages: ctx.approvedStages,
  }
}

export async function loadProductOverview(productId: string) {
  const product = await prisma.dataProduct.findUnique({
    where: { id: productId },
    include: {
      owner: true,
      steward: true,
      domain: true,
      workspace: true,
      request: true,
      gates: { orderBy: { stageNumber: 'asc' } },
      changeRequests: { orderBy: { createdAt: 'desc' }, include: { raisedBy: true } },
      valueMeasurements: { orderBy: { createdAt: 'desc' } },
      patternBindings: true,
      accessRequests: { include: { requester: true }, orderBy: { createdAt: 'desc' } },
      feedback: { include: { user: true }, orderBy: { createdAt: 'desc' } },
      artifacts: {
        include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
        orderBy: { stageNumber: 'asc' },
      },
    },
  })
  if (!product) return undefined
  return {
    product,
    artifactSummary: (product.artifacts || []).map((artifact) => ({
      type: artifact.type,
      title: getArtifactType(artifact.type)?.title ?? artifact.type,
      stage: artifact.stageNumber,
      version: artifact.versions?.[0]?.version ?? 0,
      committedAt: artifact.versions?.[0]?.createdAt,
    })),
  }
}
