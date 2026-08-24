'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession } from '@/lib/auth/session'
import { assertRole } from '@/lib/auth/authorise'
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit/log'

const accessSchema = z.object({
  productId: z.string().min(1),
  patternKey: z.string().min(1),
  purpose: z.string().trim().min(10, 'Say what you will use the data for.'),
})

export async function requestAccess(_prev: unknown, formData: FormData) {
  const session = await requireSession()
  const parsed = accessSchema.safeParse({
    productId: formData.get('productId'),
    patternKey: formData.get('patternKey'),
    purpose: formData.get('purpose'),
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' }
  }

  const product = await prisma.dataProduct.findUniqueOrThrow({
    where: { id: parsed.data.productId },
    select: { id: true, key: true, workspaceId: true },
  })

  await prisma.$transaction(async (tx: any) => {
    const created = await tx.accessRequest.create({
      data: {
        productId: product.id,
        requesterId: session.userId,
        patternKey: parsed.data.patternKey,
        purpose: parsed.data.purpose,
        state: 'PENDING',
      },
    })
    await recordAudit(tx, {
      workspaceId: product.workspaceId,
      productId: product.id,
      actorId: session.userId,
      action: AUDIT_ACTIONS.ACCESS_REQUESTED,
      entityType: 'AccessRequest',
      entityId: created.id,
      data: { patternKey: parsed.data.patternKey, purpose: parsed.data.purpose },
    })
  })

  revalidatePath(`/marketplace/${product.key}`)
  return { ok: 'Access request submitted. The product owner will see it in their inbox.' }
}

const feedbackSchema = z.object({
  productId: z.string().min(1),
  rating: z.coerce.number().min(1).max(5),
  comment: z.string().trim().default(''),
})

export async function submitFeedback(_prev: unknown, formData: FormData) {
  const session = await requireSession()
  const parsed = feedbackSchema.safeParse({
    productId: formData.get('productId'),
    rating: formData.get('rating'),
    comment: formData.get('comment'),
  })
  if (!parsed.success) return { error: 'Give a rating between 1 and 5.' }

  const product = await prisma.dataProduct.findUniqueOrThrow({
    where: { id: parsed.data.productId },
    select: { id: true, key: true, workspaceId: true },
  })

  await prisma.$transaction(async (tx: any) => {
    const created = await tx.feedback.create({
      data: {
        productId: product.id,
        userId: session.userId,
        rating: parsed.data.rating,
        comment: parsed.data.comment,
        sentiment: parsed.data.rating >= 4 ? 'POSITIVE' : parsed.data.rating <= 2 ? 'NEGATIVE' : 'NEUTRAL',
      },
    })
    await recordAudit(tx, {
      workspaceId: product.workspaceId,
      productId: product.id,
      actorId: session.userId,
      action: AUDIT_ACTIONS.FEEDBACK_SUBMITTED,
      entityType: 'Feedback',
      entityId: created.id,
      data: { rating: parsed.data.rating },
    })
  })

  revalidatePath(`/marketplace/${product.key}`)
  return { ok: 'Thanks — recorded against the product and visible in the portfolio.' }
}

const decideAccessSchema = z.object({
  accessRequestId: z.string().min(1),
  decision: z.enum(['APPROVED', 'DENIED']),
  note: z.string().trim().default(''),
})

export async function decideAccessRequest(formData: FormData) {
  const session = await requireSession()
  const parsed = decideAccessSchema.parse({
    accessRequestId: formData.get('accessRequestId'),
    decision: formData.get('decision'),
    note: formData.get('note'),
  })

  const request = await prisma.accessRequest.findUniqueOrThrow({
    where: { id: parsed.accessRequestId },
    include: { product: true },
  })
  await assertRole(
    session.userId,
    request.product.workspaceId,
    ['DOMAIN_PRODUCT_OWNER', 'PRIVACY_SECURITY_OFFICER'],
    'Deciding an access request',
  )

  await prisma.$transaction(async (tx: any) => {
    await tx.accessRequest.update({
      where: { id: request.id },
      data: {
        state: parsed.decision,
        decidedById: session.userId,
        decidedAt: new Date(),
        decisionNote: parsed.note,
      },
    })
    await recordAudit(tx, {
      workspaceId: request.product.workspaceId,
      productId: request.productId,
      actorId: session.userId,
      action: AUDIT_ACTIONS.ACCESS_DECIDED,
      entityType: 'AccessRequest',
      entityId: request.id,
      data: { decision: parsed.decision, note: parsed.note },
    })
  })

  revalidatePath('/inbox')
  revalidatePath(`/marketplace/${request.product.key}`)
}
