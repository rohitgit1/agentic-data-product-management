import { prisma } from '@/lib/db'
import { serialiseContent } from '@/lib/artifacts/serialise'
import { getStage } from '@/lib/lifecycle/stages'
import { agentName } from '@/lib/agents/registry'
import { loadRun, plannedAgentsForStage, type RunView } from '@/lib/agents/orchestrator'
import { getConnector, type ConnectorCategory } from '@/lib/integrations/registry'

/**
 * Everything the run console renders in one read. Kept out of the page so the route stays a
 * composition and the shape is testable on its own.
 */

export interface DraftedItem {
  id: string
  agentId: string
  agentName: string
  stageNumber: number
  fieldPath: string
  rationale: string
  state: string
  preview: string
  isComment: boolean
  dispositionedBy: string | null
}

export interface ConsoleProduct {
  id: string
  key: string
  name: string
  domainName: string
  currentStage: number
  status: string
  hasOpenRun: boolean
}

export interface ContextAttachment {
  id: string
  connectorKey: string
  connectorName: string
  category: ConnectorCategory
  fileName: string
  summary: string
  importedAt: Date
}

export interface RunConsoleView {
  products: ConsoleProduct[]
  /** The product the console is showing attachments for — the run's, or the operator's pick. */
  selectedProductId: string
  /** External metadata already attached to that product, newest first. */
  attachments: ContextAttachment[]
  /** Every run still in flight in this workspace, so a second one is never hidden behind the first. */
  openRuns: { id: string; productName: string; state: string }[]
  run: RunView | null
  /** Drafted output for the run's current stage, newest last, awaiting or carrying a decision. */
  drafted: DraftedItem[]
  /** Who may clear the current stage's gate, so the console can say whose turn it is. */
  currentStageApprovers: string[]
  /** Stages in the run's range that accept a catalogue or modelling import. */
  importStages: number[]
}

/** The stages where an external catalogue or model is worth having in front of an agent. */
export const METADATA_IMPORT_STAGES = [3, 4, 6, 7]

export async function loadRunConsole(
  workspaceId: string,
  selectedRunId?: string,
  selectedProductId?: string,
): Promise<RunConsoleView> {
  const productRows = await prisma.dataProduct.findMany({
    where: { workspaceId, archivedAt: null },
    include: { domain: { select: { name: true } } },
    orderBy: [{ status: 'asc' }, { name: 'asc' }],
  })

  const openRunRows = await prisma.agentRun.findMany({
    where: { workspaceId, state: { notIn: ['COMPLETED', 'CANCELLED'] } },
    select: { id: true, productId: true, state: true, product: { select: { name: true } } },
    orderBy: { startedAt: 'desc' },
  })
  const openByProduct = new Set(openRunRows.map((r) => r.productId))
  const openRuns = openRunRows.map((r) => ({
    id: r.id,
    productName: r.product.name,
    state: r.state,
  }))

  const products: ConsoleProduct[] = productRows.map((product) => ({
    id: product.id,
    key: product.key,
    name: product.name,
    domainName: product.domain.name,
    currentStage: product.currentStage,
    status: product.status,
    hasOpenRun: openByProduct.has(product.id),
  }))

  const runId = selectedRunId ?? openRunRows[0]?.id
  const run = runId ? await loadRun(runId) : null

  // A run pins the product; otherwise the operator's pick, falling back to the first listed.
  const productId = run?.productId ?? selectedProductId ?? products[0]?.id ?? ''
  const attachments = productId ? await attachmentsFor(productId) : []

  if (!run) {
    return {
      products,
      openRuns,
      selectedProductId: productId,
      attachments,
      run: null,
      drafted: [],
      currentStageApprovers: [],
      importStages: [],
    }
  }

  const drafted = await draftedForStage(run.productId, run.currentStage)
  const stage = getStage(run.currentStage)

  return {
    products,
    openRuns,
    selectedProductId: productId,
    attachments,
    run,
    drafted,
    currentStageApprovers: stage.approverRoles,
    importStages: METADATA_IMPORT_STAGES.filter(
      (number) => number >= run.fromStage && number <= run.toStage,
    ),
  }
}

/** What a product already has imported, so the console can show it before a run is started. */
export async function attachmentsFor(productId: string): Promise<ContextAttachment[]> {
  const rows = await prisma.externalMetadataImport.findMany({
    where: { productId, archivedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  return rows.flatMap((row) => {
    const connector = getConnector(row.connectorKey)
    // An import whose connector has been retired from the registry is not shown as a live source.
    if (!connector) return []
    return [
      {
        id: row.id,
        connectorKey: row.connectorKey,
        connectorName: connector.name,
        category: connector.category,
        fileName: row.fileName,
        summary: row.summary,
        importedAt: row.createdAt,
      },
    ]
  })
}

/**
 * The drafted output for one stage. Read on every console poll as well as on page load, so a
 * decision a reviewer just made is reflected without them having to reload to find out.
 */
export async function draftedForStage(
  productId: string,
  stageNumber: number,
): Promise<DraftedItem[]> {
  const rows = await prisma.agentProposal.findMany({
    where: { productId, stageNumber },
    include: {
      agentAction: { select: { agentId: true } },
      dispositionBy: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  return rows.map((row) => {
    const value = JSON.parse(row.proposedValueJson) as unknown
    const isComment = !!value && typeof value === 'object' && 'comment' in (value as object)
    return {
      id: row.id,
      agentId: row.agentAction.agentId,
      agentName: agentName(row.agentAction.agentId),
      stageNumber: row.stageNumber,
      fieldPath: row.fieldPath,
      rationale: row.rationale,
      state: row.state,
      preview: isComment
        ? String((value as { comment: string }).comment)
        : serialiseContent(value, 'yaml').slice(0, 4000),
      isComment,
      dispositionedBy: row.dispositionBy?.name ?? null,
    }
  })
}

/** The full planned route, for the rail shown before a run has been started. */
export function plannedRoute(fromStage: number, toStage: number) {
  const route: { stageNumber: number; name: string; agents: string[] }[] = []
  for (let stage = fromStage; stage <= toStage; stage += 1) {
    route.push({
      stageNumber: stage,
      name: getStage(stage).name,
      agents: plannedAgentsForStage(stage).map(agentName),
    })
  }
  return route
}
