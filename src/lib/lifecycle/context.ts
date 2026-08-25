import { prisma } from '@/lib/db'
import { getArtifactType } from '@/lib/artifacts/registry'
import { PATTERN_KEYS } from '@/lib/patterns/registry'
import { semanticModelSchema } from '@/lib/artifacts/registry'
import type { ArtifactSnapshot, StageContext } from './criteria'

/**
 * Assembles everything the exit criteria need, in one place, so the criteria themselves stay
 * pure functions. Used identically by the UI checklist and by the transition engine.
 */
export async function buildStageContext(
  productId: string,
  stageNumber: number,
): Promise<StageContext> {
  const product = await prisma.dataProduct.findUniqueOrThrow({
    where: { id: productId },
    select: {
      id: true,
      key: true,
      name: true,
      workspaceId: true,
      archetype: true,
      tier: true,
      status: true,
    },
  })

  const artifactRows = await prisma.artifact.findMany({
    where: { productId, archivedAt: null },
    include: {
      versions: { orderBy: { version: 'desc' }, take: 1, include: { provenance: true } },
    },
  })

  const artifacts: Record<string, ArtifactSnapshot | undefined> = {}
  const evidenceRefs: string[] = []
  for (const artifact of artifactRows) {
    const version = artifact.versions[0]
    if (!version) continue
    artifacts[artifact.type] = {
      type: artifact.type,
      version: version.version,
      content: JSON.parse(version.contentJson) as unknown,
      contentHash: version.contentHash,
      committedAt: version.createdAt,
      hasUnreviewedAgentFields: (version.provenance || []).some((p) => p.provenance === 'AGENT_PROPOSED'),
    }
    evidenceRefs.push(`artifact:${artifact.type}@v${version.version}`)
  }

  const gates = await prisma.gate.findMany({
    where: { productId },
    select: { stageNumber: true, state: true },
  })
  const approvedStages = gates.filter((g) => g.state === 'APPROVED').map((g) => g.stageNumber)
  for (const stage of approvedStages) evidenceRefs.push(`approval:stage-${stage}`)

  const pendingProposals = await prisma.agentProposal.count({
    where: { productId, stageNumber, state: 'PENDING' },
  })

  const unresolvedComments = await prisma.comment.count({
    where: { productId, stageNumber, resolvedAt: null, kind: { in: ['REVIEW', 'AGENT_CRITIC'] } },
  })

  const otherProductMetricNames = await collectWorkspaceMetricNames(product.workspaceId, productId)

  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: product.workspaceId },
    select: { packKey: true },
  })
  const pack = await prisma.pack.findUnique({ where: { key: workspace.packKey } })
  const packControlKeys = pack ? readControlKeys(pack.contentJson) : []

  return {
    stageNumber,
    product,
    artifacts,
    pendingProposals,
    unresolvedComments,
    otherProductMetricNames,
    approvedStages,
    evidenceRefs,
    packControlKeys,
    patternKeys: PATTERN_KEYS,
  }
}

function readControlKeys(contentJson: string): string[] {
  try {
    const parsed = JSON.parse(contentJson) as { controls?: { key: string }[] }
    return (parsed.controls ?? []).map((c) => c.key)
  } catch {
    return []
  }
}

/** Certified metric names owned by every other product in the workspace. */
export async function collectWorkspaceMetricNames(
  workspaceId: string,
  excludeProductId?: string,
): Promise<{ metric: string; productKey: string }[]> {
  const products = await prisma.dataProduct.findMany({
    where: {
      workspaceId,
      archivedAt: null,
      ...(excludeProductId ? { id: { not: excludeProductId } } : {}),
    },
    select: {
      key: true,
      artifacts: {
        where: { type: 'semantic-model' },
        include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      },
    },
  })

  const names: { metric: string; productKey: string }[] = []
  for (const product of products) {
    for (const artifact of product.artifacts) {
      const version = artifact.versions[0]
      if (!version) continue
      const parsed = semanticModelSchema.safeParse(JSON.parse(version.contentJson))
      if (!parsed.success) continue
      for (const metric of parsed.data.metrics) {
        names.push({ metric: metric.name, productKey: product.key })
      }
    }
  }
  return names
}

export function artifactStageOf(artifactType: string): number {
  return getArtifactType(artifactType).stage
}
