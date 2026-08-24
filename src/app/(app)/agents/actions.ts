'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession } from '@/lib/auth/session'
import { assertRole } from '@/lib/auth/authorise'
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit/log'
import { AUTONOMY_LEVELS, type AutonomyLevel } from '@/lib/domain/enums'
import { getAgent } from '@/lib/agents/registry'
import { invokeAgent, AgentError } from '@/lib/agents/runtime'
import { getModel, isKnownModel } from '@/lib/agents/models'
import { setAgentCredentials } from '@/lib/secrets'

const settingSchema = z.object({
  agentId: z.string().min(1),
  autonomyLevel: z.enum(AUTONOMY_LEVELS),
  enabled: z.coerce.boolean().default(false),
})

export async function updateAgentSetting(formData: FormData) {
  const session = await requireSession()
  await assertRole(session.userId, session.workspaceId, ['ADMIN'], 'Changing agent configuration')

  const parsed = settingSchema.parse({
    agentId: formData.get('agentId'),
    autonomyLevel: formData.get('autonomyLevel'),
    enabled: formData.get('enabled') === 'on',
  })

  const agent = getAgent(parsed.agentId)
  if (!agent) throw new Error(`Unknown agent ${parsed.agentId}`)

  // A setting may lower the registry ceiling. It can never raise it, and no level approves a gate.
  const order: AutonomyLevel[] = [...AUTONOMY_LEVELS]
  const capped =
    order.indexOf(parsed.autonomyLevel) > order.indexOf(agent.autonomyCeiling)
      ? agent.autonomyCeiling
      : parsed.autonomyLevel

  await prisma.$transaction(async (tx: any) => {
    await tx.agentSetting.upsert({
      where: { workspaceId_agentId: { workspaceId: session.workspaceId, agentId: agent.id } },
      update: { autonomyLevel: capped, enabled: parsed.enabled },
      create: {
        workspaceId: session.workspaceId,
        agentId: agent.id,
        autonomyLevel: capped,
        enabled: parsed.enabled,
      },
    })
    await recordAudit(tx, {
      workspaceId: session.workspaceId,
      actorId: session.userId,
      action: AUDIT_ACTIONS.AGENT_SETTINGS_CHANGED,
      entityType: 'AgentSetting',
      entityId: agent.id,
      data: { autonomyLevel: capped, enabled: parsed.enabled, requested: parsed.autonomyLevel },
    })
  })

  revalidatePath('/agents')
}

export async function updateWorkspaceAgentPolicy(formData: FormData) {
  const session = await requireSession()
  await assertRole(session.userId, session.workspaceId, ['ADMIN'], 'Changing workspace agent policy')

  const agentsEnabled = formData.get('agentsEnabled') === 'on'
  const agentsMaySeeSampleData = formData.get('agentsMaySeeSampleData') === 'on'
  const agentBudgetUsd = Number(formData.get('agentBudgetUsd') ?? 25)
  const apiKey = String(formData.get('apiKey') ?? '')
  const model = String(formData.get('model') ?? '')

  await prisma.$transaction(async (tx: any) => {
    await tx.workspace.update({
      where: { id: session.workspaceId },
      data: { agentsEnabled, agentsMaySeeSampleData, agentBudgetUsd },
    })
    await recordAudit(tx, {
      workspaceId: session.workspaceId,
      actorId: session.userId,
      action: AUDIT_ACTIONS.AGENT_SETTINGS_CHANGED,
      entityType: 'Workspace',
      entityId: session.workspaceId,
      data: { agentsEnabled, agentsMaySeeSampleData, agentBudgetUsd, apiKeyChanged: apiKey.length > 0 },
    })
  })

  if (apiKey || model) {
    // Secrets never enter the database — they go to a git-ignored local file or the environment.
    await setAgentCredentials({ apiKey: apiKey || undefined, model: model || undefined })
  }

  revalidatePath('/agents')
  revalidatePath('/admin')
}

export async function runScheduledSteward(
  _prev: { ok?: string; error?: string } | undefined,
  formData: FormData,
) {
  const session = await requireSession()
  const productId = String(formData.get('productId') ?? '')
  try {
    const result = await invokeAgent({
      agentId: 'steward',
      workspaceId: session.workspaceId,
      productId,
      stageNumber: 12,
      userId: session.userId,
      trigger: 'SCHEDULE',
    })
    revalidatePath('/agents')
    revalidatePath(`/products/${productId}`)
    return {
      ok: `Steward run complete: ${result.findingCount} finding(s) raised as tasks for human disposition. The agent edited nothing.`,
    }
  } catch (error) {
    if (error instanceof AgentError) return { error: error.message }
    return { error: error instanceof Error ? error.message : 'The scheduled run failed.' }
  }
}

const modelAssignmentSchema = z.object({
  workspaceId: z.string().min(1),
  autonomyLevel: z.enum(AUTONOMY_LEVELS),
  modelId: z.string().refine(isKnownModel, 'Unknown model'),
})

/**
 * Assign a model to an autonomy level in a workspace.
 *
 * The workspace comes from the form so the Agents tab can configure any industry the user holds a
 * role in, but authority is re-derived against *that* workspace rather than the session's default
 * (invariant 10). A workspace id in a form is a request, never a claim.
 *
 * A model choice changes what an agent is good at, never what it may do.
 */
export async function updateModelAssignment(
  _prev: { ok?: string; error?: string } | undefined,
  formData: FormData,
): Promise<{ ok?: string; error?: string }> {
  const session = await requireSession()
  const parsed = modelAssignmentSchema.safeParse({
    workspaceId: formData.get('workspaceId'),
    autonomyLevel: formData.get('autonomyLevel'),
    modelId: formData.get('modelId'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Choose a model.' }

  try {
    await assertRole(session.userId, parsed.data.workspaceId, ['ADMIN'], 'Assigning an agent model')
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Not authorised.' }
  }

  const model = getModel(parsed.data.modelId)
  await prisma.$transaction(async (tx: any) => {
    await tx.modelAssignment.upsert({
      where: {
        workspaceId_autonomyLevel: {
          workspaceId: parsed.data.workspaceId,
          autonomyLevel: parsed.data.autonomyLevel,
        },
      },
      update: { modelId: parsed.data.modelId, updatedById: session.userId },
      create: {
        workspaceId: parsed.data.workspaceId,
        autonomyLevel: parsed.data.autonomyLevel,
        modelId: parsed.data.modelId,
        updatedById: session.userId,
      },
    })
    await recordAudit(tx, {
      workspaceId: parsed.data.workspaceId,
      actorId: session.userId,
      action: AUDIT_ACTIONS.AGENT_MODEL_ASSIGNED,
      entityType: 'ModelAssignment',
      entityId: `${parsed.data.workspaceId}:${parsed.data.autonomyLevel}`,
      data: { autonomyLevel: parsed.data.autonomyLevel, modelId: parsed.data.modelId },
    })
  })

  revalidatePath('/agents')
  return {
    ok: `${parsed.data.autonomyLevel} now runs on ${model?.name ?? parsed.data.modelId}. This changes what the agent is good at, not what it may do.`,
  }
}
