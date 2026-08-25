import { prisma } from '@/lib/db'
import { decisionRegisterSchema, marketplaceListingSchema } from '@/lib/artifacts/registry'

/**
 * Duplicate detection is the primary defence against catalogue sprawl, so it runs before final
 * submit and its results are shown to the requester — not buried in a triage screen.
 */

export interface NearMatch {
  kind: 'PRODUCT' | 'REQUEST'
  id: string
  key: string
  name: string
  reason: string
  score: number
  href: string
}

const STOP_WORDS = new Set([
  'which', 'what', 'how', 'many', 'much', 'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and',
  'or', 'is', 'are', 'was', 'were', 'this', 'that', 'we', 'our', 'my', 'i', 'do', 'does', 'did',
  'have', 'has', 'had', 'be', 'been', 'by', 'with', 'at', 'from', 'as', 'it', 'they', 'them',
])

export function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  )
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / Math.min(a.size, b.size)
}

export interface DuplicateQuery {
  workspaceId: string
  decision: string
  consumerRole: string
  questions: string[]
  domainId?: string | null
  excludeRequestId?: string
}

export async function findNearMatches(query: DuplicateQuery): Promise<NearMatch[]> {
  const needle = tokenise([query.decision, query.consumerRole, ...query.questions].join(' '))
  const matches: NearMatch[] = []

  const products = await prisma.dataProduct.findMany({
    where: { workspaceId: query.workspaceId, archivedAt: null },
    include: {
      artifacts: {
        where: { type: { in: ['decision-register', 'marketplace-listing'] } },
        include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      },
    },
  })

  for (const product of products) {
    const haystackParts: string[] = [product.name, product.description]
    for (const artifact of (product.artifacts || [])) {
      const version = artifact.versions[0]
      if (!version) continue
      const content = JSON.parse(version.contentJson)
      if (artifact.type === 'decision-register') {
        const parsed = decisionRegisterSchema.safeParse(content)
        if (parsed.success) {
          for (const decision of parsed.data.decisions) {
            haystackParts.push(decision.decision, decision.consumerPersona, ...decision.questions)
          }
        }
      } else {
        const parsed = marketplaceListingSchema.safeParse(content)
        if (parsed.success) {
          haystackParts.push(parsed.data.description, ...parsed.data.sampleQuestions, ...parsed.data.entities)
        }
      }
    }
    const score = overlap(needle, tokenise(haystackParts.join(' ')))
    if (score >= 0.25) {
      matches.push({
        kind: 'PRODUCT',
        id: product.id,
        key: product.key,
        name: product.name,
        reason:
          product.status === 'PUBLISHED'
            ? 'Published product covering similar questions'
            : `In progress at Stage ${product.currentStage}`,
        score,
        href: product.status === 'PUBLISHED' ? `/marketplace/${product.key}` : `/products/${product.id}`,
      })
    }
  }

  const openRequests = await prisma.productRequest.findMany({
    where: {
      workspaceId: query.workspaceId,
      state: { in: ['SUBMITTED', 'IN_TRIAGE', 'INFO_REQUESTED', 'DEFERRED'] },
      ...(query.excludeRequestId ? { id: { not: query.excludeRequestId } } : {}),
    },
  })

  for (const request of openRequests) {
    const questions = JSON.parse(request.questionsJson) as string[]
    const score = overlap(
      needle,
      tokenise([request.title, request.decision, request.consumerRole, ...questions].join(' ')),
    )
    if (score >= 0.25) {
      matches.push({
        kind: 'REQUEST',
        id: request.id,
        key: request.reference,
        name: request.title,
        reason: `Open request from ${request.consumerRole || 'another consumer'} (${request.state})`,
        score,
        href: `/request/${request.id}`,
      })
    }
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, 5)
}
