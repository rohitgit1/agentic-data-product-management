'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession } from '@/lib/auth/session'
import { assertRole } from '@/lib/auth/authorise'
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit/log'
import { MATURITY_DIMENSIONS } from '@/lib/portfolio/maturity'

const overrideSchema = z.object({
  productId: z.string().min(1),
  score: z.coerce.number(),
  reason: z.string().trim().min(10, 'An override needs a recorded reason.'),
})

export async function overridePrioritisation(
  _prev: { ok?: string; error?: string } | undefined,
  formData: FormData,
) {
  const session = await requireSession()
  const parsed = overrideSchema.safeParse({
    productId: formData.get('productId'),
    score: formData.get('score'),
    reason: formData.get('reason'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid override.' }

  const product = await prisma.dataProduct.findUniqueOrThrow({ where: { id: parsed.data.productId } })
  try {
    await assertRole(
      session.userId,
      product.workspaceId,
      ['PORTFOLIO_LEAD', 'DOMAIN_PRODUCT_OWNER'],
      'Overriding a prioritisation score',
    )
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Not authorised.' }
  }

  await prisma.$transaction(async (tx: any) => {
    const created = await tx.prioritisationOverride.create({
      data: {
        productId: product.id,
        score: parsed.data.score,
        reason: parsed.data.reason,
        overriddenById: session.userId,
      },
    })
    await recordAudit(tx, {
      workspaceId: product.workspaceId,
      productId: product.id,
      actorId: session.userId,
      action: AUDIT_ACTIONS.PRIORITISATION_OVERRIDDEN,
      entityType: 'PrioritisationOverride',
      entityId: created.id,
      data: { score: parsed.data.score, reason: parsed.data.reason },
    })
  })

  revalidatePath('/portfolio')
  return { ok: 'Override recorded against your name, with the reason.' }
}

export async function saveMaturityAssessment(
  _prev: { ok?: string; error?: string } | undefined,
  formData: FormData,
) {
  const session = await requireSession()
  try {
    await assertRole(
      session.userId,
      session.workspaceId,
      ['PORTFOLIO_LEAD', 'GOVERNANCE_COUNCIL', 'ADMIN'],
      'Recording a maturity assessment',
    )
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Not authorised.' }
  }

  const scores: Record<string, number> = {}
  const notes: Record<string, string> = {}
  for (const dimension of MATURITY_DIMENSIONS) {
    scores[dimension.key] = Number(formData.get(`score-${dimension.key}`) ?? 0)
    const note = String(formData.get(`note-${dimension.key}`) ?? '').trim()
    if (note) notes[dimension.key] = note
  }

  await prisma.$transaction(async (tx: any) => {
    const created = await tx.maturityAssessment.create({
      data: {
        workspaceId: session.workspaceId,
        createdById: session.userId,
        scoresJson: JSON.stringify(scores),
        notesJson: JSON.stringify(notes),
      },
    })
    await recordAudit(tx, {
      workspaceId: session.workspaceId,
      actorId: session.userId,
      action: AUDIT_ACTIONS.MATURITY_ASSESSED,
      entityType: 'MaturityAssessment',
      entityId: created.id,
      data: scores,
    })
  })

  revalidatePath('/portfolio')
  return { ok: 'Assessment recorded. Export it to Word from the maturity panel.' }
}
