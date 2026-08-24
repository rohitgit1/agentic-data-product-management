'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { parse as parseYaml } from 'yaml'
import { prisma } from '@/lib/db'
import { requireSession } from '@/lib/auth/session'
import { assertRole } from '@/lib/auth/authorise'
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit/log'
import { ArtifactValidationError, commitArtifact, latestVersion } from '@/lib/artifacts/commit'
import { getArtifactType } from '@/lib/artifacts/registry'
import { recordDecision, requestTransition, TransitionError } from '@/lib/lifecycle/transitions'
import {
  acceptCriticComment,
  applyAcceptedProposals,
  dispositionProposal,
  invokeAgent,
  AgentError,
} from '@/lib/agents/runtime'
import { decisionSchema } from '@/lib/domain/enums'
import { PRACTITIONER_ROLES } from '@/lib/domain/roles'
import { parseAttributeWorkbook, WorkbookImportError } from '@/lib/exports/xlsx'
import { CsvError, mergeProfileDataset, profileCsv } from '@/lib/profiling/csv'
import { getConnector } from '@/lib/integrations/registry'
import { ImportError, parseImport, summariseImport } from '@/lib/integrations/parse'
import { contentHash } from '@/lib/hash'

export interface Result {
  ok?: string
  error?: string
  details?: string[]
}

/**
 * Authoring an artifact is a mutation, so it is authorised by role server-side like every other
 * one: you must hold a practitioner role in the workspace that owns the product.
 */
async function assertCanAuthor(userId: string, workspaceId: string, action: string) {
  await assertRole(userId, workspaceId, PRACTITIONER_ROLES, action)
}

function refresh(productId: string, stageNumber?: number) {
  revalidatePath(`/products/${productId}`)
  if (stageNumber) revalidatePath(`/products/${productId}/stage/${stageNumber}`)
  revalidatePath('/inbox')
}

export async function commitArtifactAction(_prev: Result | undefined, formData: FormData): Promise<Result> {
  const session = await requireSession()
  const productId = String(formData.get('productId') ?? '')
  const artifactType = String(formData.get('artifactType') ?? '')
  const body = String(formData.get('content') ?? '')
  const message = String(formData.get('message') ?? '')
  const applyProposals = String(formData.get('applyProposals') ?? '') === 'true'

  const type = getArtifactType(artifactType)
  const owning = await prisma.dataProduct.findUniqueOrThrow({
    where: { id: productId },
    select: { workspaceId: true },
  })
  try {
    await assertCanAuthor(session.userId, owning.workspaceId, `Committing ${type.title}`)
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Not authorised.' }
  }

  let content: unknown
  try {
    content = parseYaml(body)
  } catch (error) {
    return { error: `That is not valid YAML: ${error instanceof Error ? error.message : 'parse error'}` }
  }

  let provenance: { fieldPath: string; provenance: 'AGENT_ACCEPTED' | 'AGENT_EDITED'; agentId: string; acceptedById: string }[] = []
  if (applyProposals) {
    const applied = await applyAcceptedProposals({
      productId,
      stageNumber: type.stage,
      baseContent: content,
    })
    content = applied.content
    provenance = applied.provenance.filter(
      (p): p is { fieldPath: string; provenance: 'AGENT_ACCEPTED' | 'AGENT_EDITED'; agentId: string; acceptedById: string } =>
        p.provenance === 'AGENT_ACCEPTED' || p.provenance === 'AGENT_EDITED',
    )
  }

  try {
    const result = await commitArtifact({
      productId,
      artifactType,
      content,
      userId: session.userId,
      message,
      provenance,
    })
    refresh(productId, type.stage)
    if (result.unchanged) return { ok: 'No change — content is identical to the current version.' }
    return {
      ok: `Committed ${type.title} v${result.version}.${
        result.staledGateIds.length
          ? ` ${result.staledGateIds.length} downstream approval(s) went stale and need re-approval.`
          : ''
      }`,
    }
  } catch (error) {
    if (error instanceof ArtifactValidationError) {
      return {
        error: error.message,
        details: error.issues.map((issue) => `${issue.path || '(root)'}: ${issue.message}`),
      }
    }
    return { error: error instanceof Error ? error.message : 'Commit failed.' }
  }
}

export async function stageTransitionAction(_prev: Result | undefined, formData: FormData): Promise<Result> {
  const session = await requireSession()
  const productId = String(formData.get('productId') ?? '')
  const stageNumber = Number(formData.get('stageNumber') ?? 0)
  const action = String(formData.get('action') ?? '') as
    | 'SUBMIT_FOR_REVIEW'
    | 'REQUEST_CHANGES'
    | 'WITHDRAW_TO_DRAFT'
    | 'OPEN_GATE'
  const note = String(formData.get('note') ?? '')

  try {
    await requestTransition({ productId, stageNumber, action, userId: session.userId, note })
    refresh(productId, stageNumber)
    return { ok: `Stage ${stageNumber}: ${action.toLowerCase().replace(/_/g, ' ')}.` }
  } catch (error) {
    if (error instanceof TransitionError) {
      return {
        error: error.message,
        details: error.failures.map((failure) => `${failure.label} — ${failure.detail}`),
      }
    }
    return { error: error instanceof Error ? error.message : 'Transition failed.' }
  }
}

export async function recordDecisionAction(_prev: Result | undefined, formData: FormData): Promise<Result> {
  const session = await requireSession()
  const gateId = String(formData.get('gateId') ?? '')
  const decision = decisionSchema.parse(formData.get('decision'))
  const rationale = String(formData.get('rationale') ?? '')
  const roleKeyRaw = String(formData.get('roleKey') ?? '')

  try {
    const gate = await prisma.gate.findUniqueOrThrow({ where: { id: gateId } })
    const result = await recordDecision({
      gateId,
      userId: session.userId,
      decision,
      rationale,
      roleKey: roleKeyRaw ? (roleKeyRaw as never) : undefined,
    })
    refresh(gate.productId, gate.stageNumber)
    return {
      ok:
        result.gateState === 'APPROVED'
          ? `Gate approved. Stage ${gate.stageNumber} is locked and the next stage is open.`
          : result.gateState === 'REJECTED'
            ? 'Gate rejected. The stage is back with the authors.'
            : `Decision recorded. ${result.approvingRoles.length} of ${result.quorum} approvals; awaiting ${result.outstandingRoles.join(', ') || 'nobody'}.`,
    }
  } catch (error) {
    if (error instanceof TransitionError) return { error: error.message }
    return { error: error instanceof Error ? error.message : 'Could not record the decision.' }
  }
}

const commentSchema = z.object({
  productId: z.string().min(1),
  stageNumber: z.coerce.number().min(1).max(12),
  body: z.string().trim().min(2, 'Write a comment.'),
  fieldPath: z.string().trim().default(''),
  kind: z.enum(['REVIEW', 'NOTE', 'PARKING_LOT']).default('REVIEW'),
})

export async function addCommentAction(_prev: Result | undefined, formData: FormData): Promise<Result> {
  const session = await requireSession()
  const parsed = commentSchema.safeParse({
    productId: formData.get('productId'),
    stageNumber: formData.get('stageNumber'),
    body: formData.get('body'),
    fieldPath: formData.get('fieldPath'),
    kind: formData.get('kind'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Write a comment.' }

  const product = await prisma.dataProduct.findUniqueOrThrow({ where: { id: parsed.data.productId } })
  await prisma.$transaction(async (tx: any) => {
    const created = await tx.comment.create({
      data: {
        productId: product.id,
        stageNumber: parsed.data.stageNumber,
        authorId: session.userId,
        kind: parsed.data.kind,
        body: parsed.data.body,
        fieldPath: parsed.data.fieldPath || null,
      },
    })
    await recordAudit(tx, {
      workspaceId: product.workspaceId,
      productId: product.id,
      actorId: session.userId,
      action: AUDIT_ACTIONS.COMMENT_ADDED,
      entityType: 'Comment',
      entityId: created.id,
      data: { stageNumber: parsed.data.stageNumber, kind: parsed.data.kind },
    })
  })
  refresh(product.id, parsed.data.stageNumber)
  return { ok: 'Comment added.' }
}

export async function resolveCommentAction(formData: FormData) {
  const session = await requireSession()
  const commentId = String(formData.get('commentId') ?? '')
  const comment = await prisma.comment.findUniqueOrThrow({
    where: { id: commentId },
    include: { product: true },
  })
  await prisma.$transaction(async (tx: any) => {
    await tx.comment.update({
      where: { id: comment.id },
      data: { resolvedAt: new Date(), resolvedById: session.userId },
    })
    await recordAudit(tx, {
      workspaceId: comment.product.workspaceId,
      productId: comment.productId,
      actorId: session.userId,
      action: AUDIT_ACTIONS.COMMENT_RESOLVED,
      entityType: 'Comment',
      entityId: comment.id,
      data: { stageNumber: comment.stageNumber },
    })
  })
  refresh(comment.productId, comment.stageNumber)
}

export async function runAgentAction(_prev: Result | undefined, formData: FormData): Promise<Result> {
  const session = await requireSession()
  const productId = String(formData.get('productId') ?? '')
  const stageNumber = Number(formData.get('stageNumber') ?? 0)
  const agentId = String(formData.get('agentId') ?? '')

  try {
    const result = await invokeAgent({
      agentId,
      workspaceId: session.workspaceId,
      productId,
      stageNumber,
      userId: session.userId,
      trigger: 'MANUAL',
    })
    refresh(productId, stageNumber)
    return {
      ok: `${result.model === 'local-heuristic' ? 'Local heuristic run' : `Model ${result.model}`}: ${result.proposalCount} proposal(s), ${result.commentCount} comment(s), ${result.findingCount} finding(s). ${result.redactedFields.length} field(s) redacted before transmission. Nothing has been applied — disposition each item below.`,
    }
  } catch (error) {
    if (error instanceof AgentError) return { error: error.message }
    return { error: error instanceof Error ? error.message : 'The agent could not run.' }
  }
}

export async function dispositionProposalAction(
  _prev: Result | undefined,
  formData: FormData,
): Promise<Result> {
  const session = await requireSession()
  const proposalId = String(formData.get('proposalId') ?? '')
  const action = String(formData.get('action') ?? '') as 'ACCEPT' | 'EDIT_ACCEPT' | 'REJECT'
  const note = String(formData.get('note') ?? '')
  const editedRaw = String(formData.get('editedValue') ?? '')

  const proposal = await prisma.agentProposal.findUniqueOrThrow({ where: { id: proposalId } })
  // A proposed value is any JSON, and plenty of them are scalars — a grain statement, a platform
  // profile, a refresh strategy. `'comment' in "some string"` throws, so the type is checked
  // before the key is, exactly as the read paths in queries/studio.ts already do.
  const proposedValue = JSON.parse(proposal.proposedValueJson) as unknown
  const isComment =
    !!proposedValue && typeof proposedValue === 'object' && 'comment' in proposedValue

  try {
    if (isComment && action === 'ACCEPT') {
      await acceptCriticComment({ proposalId, userId: session.userId, note })
    } else {
      let editedValue: unknown
      if (action === 'EDIT_ACCEPT' && editedRaw) {
        try {
          editedValue = parseYaml(editedRaw)
        } catch {
          editedValue = editedRaw
        }
      }
      await dispositionProposal({ proposalId, userId: session.userId, action, editedValue, note })
    }
  } catch (error) {
    // An authorisation refusal is an answer, not a crash — show it where the decision was made.
    return { error: error instanceof Error ? error.message : 'That disposition could not be recorded.' }
  }
  refresh(proposal.productId, proposal.stageNumber)
  return {
    ok:
      action === 'REJECT'
        ? 'Proposal rejected. The agent action is recorded either way.'
        : 'Proposal accepted. It is now yours: the field carries your name, not the agent’s.',
  }
}

const changeRequestSchema = z.object({
  productId: z.string().min(1),
  title: z.string().trim().min(5),
  detail: z.string().trim().default(''),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  versionBump: z.enum(['PATCH', 'MINOR', 'MAJOR']).default('PATCH'),
})

export async function raiseChangeRequestAction(_prev: Result | undefined, formData: FormData): Promise<Result> {
  const session = await requireSession()
  const parsed = changeRequestSchema.safeParse({
    productId: formData.get('productId'),
    title: formData.get('title'),
    detail: formData.get('detail'),
    severity: formData.get('severity'),
    versionBump: formData.get('versionBump'),
  })
  if (!parsed.success) return { error: 'Give the change request a title of at least five characters.' }

  const product = await prisma.dataProduct.findUniqueOrThrow({ where: { id: parsed.data.productId } })
  await prisma.$transaction(async (tx: any) => {
    const created = await tx.changeRequest.create({
      data: {
        productId: product.id,
        raisedById: session.userId,
        title: parsed.data.title,
        detail: parsed.data.detail,
        severity: parsed.data.severity,
        versionBump: parsed.data.versionBump,
        state: 'OPEN',
      },
    })
    await recordAudit(tx, {
      workspaceId: product.workspaceId,
      productId: product.id,
      actorId: session.userId,
      action: AUDIT_ACTIONS.CHANGE_REQUEST_RAISED,
      entityType: 'ChangeRequest',
      entityId: created.id,
      data: { severity: parsed.data.severity, versionBump: parsed.data.versionBump },
    })
  })
  refresh(product.id, 12)
  return { ok: 'Change request raised.' }
}

export async function dispositionChangeRequestAction(formData: FormData) {
  const session = await requireSession()
  const changeRequestId = String(formData.get('changeRequestId') ?? '')
  const state = String(formData.get('state') ?? '') as 'ACCEPTED' | 'REJECTED' | 'DONE'
  const note = String(formData.get('note') ?? '')

  const cr = await prisma.changeRequest.findUniqueOrThrow({
    where: { id: changeRequestId },
    include: { product: true },
  })
  await assertRole(
    session.userId,
    cr.product.workspaceId,
    ['DOMAIN_PRODUCT_OWNER', 'GOVERNANCE_COUNCIL'],
    'Dispositioning a change request',
  )

  await prisma.$transaction(async (tx: any) => {
    await tx.changeRequest.update({
      where: { id: cr.id },
      data: {
        state,
        dispositionById: session.userId,
        dispositionAt: new Date(),
        dispositionNote: note,
      },
    })

    if (state === 'ACCEPTED') {
      const [major = '0', minor = '0', patch = '0'] = cr.product.semanticVersion.split('.')
      const bumped =
        cr.versionBump === 'MAJOR'
          ? `${Number(major) + 1}.0.0`
          : cr.versionBump === 'MINOR'
            ? `${major}.${Number(minor) + 1}.0`
            : `${major}.${minor}.${Number(patch) + 1}`
      await tx.dataProduct.update({
        where: { id: cr.productId },
        data: { semanticVersion: bumped },
      })
      await recordAudit(tx, {
        workspaceId: cr.product.workspaceId,
        productId: cr.productId,
        actorId: session.userId,
        action: AUDIT_ACTIONS.PRODUCT_VERSION_BUMPED,
        entityType: 'DataProduct',
        entityId: cr.productId,
        data: { from: cr.product.semanticVersion, to: bumped, changeRequestId: cr.id },
      })
    }

    await recordAudit(tx, {
      workspaceId: cr.product.workspaceId,
      productId: cr.productId,
      actorId: session.userId,
      action: AUDIT_ACTIONS.CHANGE_REQUEST_DISPOSITIONED,
      entityType: 'ChangeRequest',
      entityId: cr.id,
      data: { state, note },
    })
  })

  refresh(cr.productId, 12)
}

const valueSchema = z.object({
  productId: z.string().min(1),
  measuredValue: z.coerce.number(),
  state: z.enum(['REALISED', 'NOT_REALISED', 'NOT_YET_MEASURABLE']),
  note: z.string().trim().default(''),
})

export async function measureValueAction(_prev: Result | undefined, formData: FormData): Promise<Result> {
  const session = await requireSession()
  const parsed = valueSchema.safeParse({
    productId: formData.get('productId'),
    measuredValue: formData.get('measuredValue'),
    state: formData.get('state'),
    note: formData.get('note'),
  })
  if (!parsed.success) return { error: 'Enter a measured value and a state.' }

  const product = await prisma.dataProduct.findUniqueOrThrow({ where: { id: parsed.data.productId } })
  try {
    await assertRole(
      session.userId,
      product.workspaceId,
      ['DOMAIN_PRODUCT_OWNER', 'PORTFOLIO_LEAD'],
      'Recording a value measurement',
    )
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Not authorised.' }
  }

  const measurement = await prisma.valueMeasurement.findFirst({
    where: { productId: product.id },
    orderBy: { createdAt: 'desc' },
  })
  if (!measurement) return { error: 'No value hypothesis exists for this product.' }

  await prisma.$transaction(async (tx: any) => {
    await tx.valueMeasurement.update({
      where: { id: measurement.id },
      data: {
        measuredValue: parsed.data.measuredValue,
        state: parsed.data.state,
        measuredAt: new Date(),
        measuredById: session.userId,
        note: parsed.data.note,
      },
    })
    await recordAudit(tx, {
      workspaceId: product.workspaceId,
      productId: product.id,
      actorId: session.userId,
      action: AUDIT_ACTIONS.VALUE_MEASURED,
      entityType: 'ValueMeasurement',
      entityId: measurement.id,
      data: { measuredValue: parsed.data.measuredValue, state: parsed.data.state },
    })
  })

  refresh(product.id, 12)
  revalidatePath('/portfolio')
  return { ok: 'Value measurement recorded against the Stage 2 hypothesis.' }
}

/**
 * The other half of the Excel round trip. An edited workbook commits a new register version and
 * carries the reviewer's outcomes back into the review thread, so the review does not stay trapped
 * in a file on somebody's laptop.
 */
export async function importAttributeWorkbookAction(
  _prev: Result | undefined,
  formData: FormData,
): Promise<Result> {
  const session = await requireSession()
  const productId = String(formData.get('productId') ?? '')
  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { error: 'Choose the edited workbook to import.' }
  }

  const product = await prisma.dataProduct.findUniqueOrThrow({
    where: { id: productId },
    select: { id: true, workspaceId: true },
  })
  try {
    await assertCanAuthor(session.userId, product.workspaceId, 'Importing an attribute register')
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Not authorised.' }
  }

  let parsed
  try {
    parsed = await parseAttributeWorkbook(await file.arrayBuffer())
  } catch (error) {
    if (error instanceof WorkbookImportError) return { error: error.message, details: error.issues }
    return { error: 'That file could not be read as an attribute register workbook.' }
  }

  try {
    const result = await commitArtifact({
      productId,
      artifactType: 'attribute-register',
      content: parsed.register,
      userId: session.userId,
      message: `Imported from workbook: ${parsed.approved} approved, ${parsed.changesRequested} changes requested`,
    })

    // Reviewer comments become real, anchored review comments rather than staying in the file.
    const anchored = parsed.reviews.filter((review) => review.comment)
    if (anchored.length > 0) {
      await prisma.$transaction(async (tx: any) => {
        for (const review of anchored) {
          const index = parsed.register.attributes.findIndex(
            (attribute) => attribute.name === review.attributeName,
          )
          const created = await tx.comment.create({
            data: {
              productId,
              stageNumber: 5,
              authorId: session.userId,
              kind: review.outcome === 'CHANGES REQUESTED' ? 'REVIEW' : 'NOTE',
              body: `${review.attributeName}: ${review.comment}`,
              fieldPath: index >= 0 ? `attributes[${index}]` : null,
            },
          })
          await recordAudit(tx, {
            workspaceId: product.workspaceId,
            productId,
            actorId: session.userId,
            action: AUDIT_ACTIONS.COMMENT_ADDED,
            entityType: 'Comment',
            entityId: created.id,
            data: { source: 'workbook-import', attribute: review.attributeName },
          })
        }
      })
    }

    refresh(productId, 5)
    if (result.unchanged) {
      return {
        ok: `No attribute changed, so no new version was written. ${anchored.length} reviewer comment(s) added to the thread.`,
      }
    }
    return {
      ok: `Attribute register committed at v${result.version} — ${parsed.register.attributes.length} attributes, ${parsed.approved} approved, ${parsed.changesRequested} with changes requested, ${anchored.length} comment(s) added.${
        result.staledGateIds.length
          ? ` ${result.staledGateIds.length} downstream approval(s) went stale.`
          : ''
      }`,
    }
  } catch (error) {
    if (error instanceof ArtifactValidationError) {
      return {
        error: error.message,
        details: error.issues.map((issue) => `${issue.path || '(root)'}: ${issue.message}`),
      }
    }
    return { error: error instanceof Error ? error.message : 'The import failed.' }
  }
}

/**
 * Stage 3 profiling from a CSV extract. There is deliberately no warehouse connection anywhere in
 * this flow — an offline extract is a first-class input, not a fallback.
 */
export async function importProfileCsvAction(
  _prev: Result | undefined,
  formData: FormData,
): Promise<Result> {
  const session = await requireSession()
  const productId = String(formData.get('productId') ?? '')
  const sourceName = String(formData.get('sourceName') ?? '').trim()
  const includeSamples = String(formData.get('includeSamples') ?? '') === 'true'
  const file = formData.get('file')

  if (!sourceName) return { error: 'Name the source this extract came from.' }
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose a CSV file to profile.' }

  const product = await prisma.dataProduct.findUniqueOrThrow({
    where: { id: productId },
    select: { id: true, workspaceId: true },
  })
  try {
    await assertCanAuthor(session.userId, product.workspaceId, 'Profiling a source extract')
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Not authorised.' }
  }

  let dataset
  try {
    dataset = profileCsv(await file.text(), { sourceName, includeSamples })
  } catch (error) {
    if (error instanceof CsvError) return { error: error.message }
    return { error: 'That file could not be read as CSV.' }
  }

  const existing = await latestVersion(productId, 'profile-report')
  const report = mergeProfileDataset(existing?.content, dataset, new Date().toISOString().slice(0, 10))

  try {
    const result = await commitArtifact({
      productId,
      artifactType: 'profile-report',
      content: report,
      userId: session.userId,
      message: `Profiled ${sourceName} from a CSV extract (${dataset.rowCount} rows, ${dataset.columns.length} columns)`,
    })
    refresh(productId, 3)
    const flagged = dataset.columns.filter((column) => column.nullRate > 0.05)
    return {
      ok: `Profiled ${dataset.rowCount} rows across ${dataset.columns.length} columns and committed profile-report v${result.version}.${
        flagged.length
          ? ` ${flagged.length} column(s) exceed a 5% null rate — run the Profiling agent to turn those into gap-log entries.`
          : ''
      }${includeSamples ? '' : ' Sample values were not stored.'}`,
    }
  } catch (error) {
    if (error instanceof ArtifactValidationError) {
      return {
        error: error.message,
        details: error.issues.map((issue) => `${issue.path || '(root)'}: ${issue.message}`),
      }
    }
    return { error: error instanceof Error ? error.message : 'The profile commit failed.' }
  }
}

/**
 * Import metadata from an external modelling or catalogue tool (erwin, Collibra, Alation).
 *
 * The import becomes agent *context*, not artifact content. Nothing here commits an artifact
 * version, so nothing here bypasses the human disposition that invariant 5 requires — an agent
 * that reads this still produces proposals a person has to accept. The external tool's own
 * certification state is carried through verbatim and never mapped onto ADPM's (invariant 8).
 */
export async function importExternalMetadataAction(
  _prev: Result | undefined,
  formData: FormData,
): Promise<Result> {
  const session = await requireSession()
  const productId = String(formData.get('productId') ?? '')
  const connectorKey = String(formData.get('connectorKey') ?? '')
  const file = formData.get('file')

  const connector = getConnector(connectorKey)
  if (!connector) return { error: 'Choose a tool to import from.' }
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose an export file.' }

  const product = await prisma.dataProduct.findUniqueOrThrow({
    where: { id: productId },
    select: { id: true, workspaceId: true },
  })
  try {
    await assertCanAuthor(session.userId, product.workspaceId, `Importing from ${connector.name}`)
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Not authorised.' }
  }

  let metadata
  try {
    metadata = parseImport(connectorKey, await file.text())
  } catch (error) {
    if (error instanceof ImportError) return { error: error.message, details: error.issues }
    return { error: 'That file could not be read.' }
  }

  const summary = summariseImport(metadata)
  const payloadJson = JSON.stringify(metadata)
  const hash = contentHash(metadata)

  const duplicate = await prisma.externalMetadataImport.findFirst({
    where: { productId, connectorKey, contentHash: hash, archivedAt: null },
  })
  if (duplicate) {
    return { ok: `No change — that export is identical to the one imported on ${duplicate.createdAt.toLocaleDateString('en-GB')}.` }
  }

  await prisma.$transaction(async (tx: any) => {
    const created = await tx.externalMetadataImport.create({
      data: {
        workspaceId: product.workspaceId,
        productId,
        connectorKey,
        fileName: file.name,
        contentHash: hash,
        payloadJson,
        summary,
        importedById: session.userId,
      },
    })
    await recordAudit(tx, {
      workspaceId: product.workspaceId,
      productId,
      actorId: session.userId,
      action: AUDIT_ACTIONS.EXTERNAL_METADATA_IMPORTED,
      entityType: 'ExternalMetadataImport',
      entityId: created.id,
      data: { connectorKey, fileName: file.name, summary, contentHash: hash },
    })
  })

  refresh(productId)
  return {
    ok: `Imported from ${connector.name}: ${summary}. This is context for the agents chartered to read it — it is not artifact content, and nothing has been committed. Run an agent on the relevant stage to use it.`,
  }
}
