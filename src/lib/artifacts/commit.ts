import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { prisma } from '@/lib/db'
import { canonicalise, contentHash } from '@/lib/hash'
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit/log'
import { invalidateDownstreamGates } from '@/lib/lifecycle/cascade'
import type { ActorType, Provenance } from '@/lib/domain/enums'
import { getArtifactType } from './registry'
import { mirrorPathFor, serialiseArtifact } from './serialise'

export interface FieldProvenanceInput {
  fieldPath: string
  provenance: Provenance
  agentId?: string | null
  acceptedById?: string | null
}

export interface CommitInput {
  productId: string
  artifactType: string
  content: unknown
  userId: string
  message?: string
  provenance?: FieldProvenanceInput[]
  actorType?: ActorType
}

export interface CommitResult {
  artifactId: string
  versionId: string
  version: number
  contentHash: string
  unchanged: boolean
  staledGateIds: string[]
  mirrorPath: string
}

export class ArtifactValidationError extends Error {
  constructor(
    message: string,
    readonly issues: { path: string; message: string }[],
  ) {
    super(message)
    this.name = 'ArtifactValidationError'
  }
}

/**
 * The only way artifact content enters the system. Validates, hashes, versions, records
 * provenance, mirrors to `workspace/`, cascades staleness and writes the audit event — in one
 * transaction. Agents never call this directly; a human disposition does.
 */
export async function commitArtifact(input: CommitInput): Promise<CommitResult> {
  const type = getArtifactType(input.artifactType)
  const parsed = type.schema.safeParse(input.content)
  if (!parsed.success) {
    throw new ArtifactValidationError(
      `${type.title} failed schema validation`,
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    )
  }

  const content = canonicalise(parsed.data)
  const hash = contentHash(content)

  const product = await prisma.dataProduct.findUniqueOrThrow({
    where: { id: input.productId },
    select: { id: true, key: true, workspaceId: true },
  })
  const mirrorPath = mirrorPathFor(product.key, type.key)

  const result = await prisma.$transaction(async (tx: any) => {
    const artifact =
      (await tx.artifact.findUnique({
        where: { productId_type: { productId: product.id, type: type.key } },
      })) ??
      (await tx.artifact.create({
        data: {
          productId: product.id,
          type: type.key,
          name: type.title,
          stageNumber: type.stage,
        },
      }))

    const latest = await tx.artifactVersion.findFirst({
      where: { artifactId: artifact.id },
      orderBy: { version: 'desc' },
    })

    if (latest && latest.contentHash === hash) {
      return {
        artifactId: artifact.id,
        versionId: latest.id,
        version: latest.version,
        contentHash: hash,
        unchanged: true,
        staledGateIds: [] as string[],
        mirrorPath,
      }
    }

    const version = await tx.artifactVersion.create({
      data: {
        artifactId: artifact.id,
        version: (latest?.version ?? 0) + 1,
        contentJson: JSON.stringify(content),
        contentHash: hash,
        message: input.message ?? '',
        createdById: input.userId,
        mirrorPath,
      },
    })

    for (const entry of input.provenance ?? []) {
      await tx.fieldProvenance.create({
        data: {
          artifactVersionId: version.id,
          fieldPath: entry.fieldPath,
          provenance: entry.provenance,
          agentId: entry.agentId ?? null,
          acceptedById: entry.acceptedById ?? null,
          acceptedAt: entry.provenance === 'AGENT_PROPOSED' ? null : new Date(),
        },
      })
    }

    const staledGateIds = await invalidateDownstreamGates(tx, {
      workspaceId: product.workspaceId,
      productId: product.id,
      artifactId: artifact.id,
      artifactType: type.key,
      artifactStage: type.stage,
      newContentHash: hash,
      actorId: input.userId,
      reason: `${type.title} committed at v${version.version}; approvals that cited the previous version no longer hold.`,
    })

    await recordAudit(tx, {
      workspaceId: product.workspaceId,
      productId: product.id,
      actorId: input.userId,
      actorType: input.actorType ?? 'HUMAN',
      action: AUDIT_ACTIONS.ARTIFACT_COMMITTED,
      entityType: 'ArtifactVersion',
      entityId: version.id,
      data: {
        artifactType: type.key,
        version: version.version,
        contentHash: hash,
        message: input.message ?? '',
        staledGates: staledGateIds.length,
      },
    })

    return {
      artifactId: artifact.id,
      versionId: version.id,
      version: version.version,
      contentHash: hash,
      unchanged: false,
      staledGateIds,
      mirrorPath,
    }
  })

  if (!result.unchanged) {
    await mirrorToWorkspace(mirrorPath, serialiseArtifact(type.key, content))
  }
  return result
}

async function mirrorToWorkspace(relativePath: string, body: string): Promise<void> {
  if (process.env.ADPM_WORKSPACE_DIR === 'off') return
  try {
    const baseDir = process.env.ADPM_WORKSPACE_DIR && process.env.ADPM_WORKSPACE_DIR !== 'off'
      ? process.env.ADPM_WORKSPACE_DIR
      : process.cwd()
    const absolute = join(baseDir, relativePath)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, body, 'utf8')
  } catch {
    // Non-fatal on serverless / read-only filesystems
  }
}

/** Latest committed content for one artifact type, or undefined. */
export async function latestVersion(productId: string, artifactType: string) {
  const artifact = await prisma.artifact.findUnique({
    where: { productId_type: { productId, type: artifactType } },
    include: {
      versions: { orderBy: { version: 'desc' }, take: 1, include: { provenance: true } },
    },
  })
  const version = artifact?.versions[0]
  if (!artifact || !version) return undefined
  return {
    artifactId: artifact.id,
    version: version.version,
    versionId: version.id,
    content: JSON.parse(version.contentJson) as unknown,
    contentHash: version.contentHash,
    createdAt: version.createdAt,
    provenance: version.provenance,
  }
}
