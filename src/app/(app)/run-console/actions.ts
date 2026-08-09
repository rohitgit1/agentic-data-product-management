'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireSession } from '@/lib/auth/session'
import { AgentError } from '@/lib/agents/runtime'
import {
  cancelAgentRun,
  dispatchStep,
  loadRun,
  startAgentRun,
  syncAgentRun,
  type RunView,
} from '@/lib/agents/orchestrator'
import { draftedForStage, type DraftedItem } from '@/lib/queries/run-console'
import { importExternalMetadataAction } from '../products/actions'
import { getConnector } from '@/lib/integrations/registry'

export interface RunResult {
  ok?: string
  error?: string
  runId?: string
  run?: RunView
  /** The current stage's drafted output, so a decision shows up without a page reload. */
  drafted?: DraftedItem[]
}

function message(error: unknown): string {
  if (error instanceof AgentError) return error.message
  return error instanceof Error ? error.message : 'That could not be done.'
}

const startSchema = z.object({
  productId: z.string().min(1, 'Choose a data product.'),
  mode: z.enum(['AUTOMATED', 'MANUAL']),
  modelId: z.string().min(1, 'Choose a model.'),
  contextSources: z.array(z.enum(['DATA_CATALOGUE', 'DATA_MODELLING', 'OPEN'])).default([]),
})

export async function startRunAction(_prev: RunResult | undefined, formData: FormData): Promise<RunResult> {
  const session = await requireSession()
  const parsed = startSchema.safeParse({
    productId: formData.get('productId'),
    mode: formData.get('mode'),
    modelId: formData.get('modelId'),
    contextSources: formData.getAll('contextSources').map(String),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check the run settings.' }

  try {
    const runId = await startAgentRun({
      workspaceId: session.workspaceId,
      productId: parsed.data.productId,
      userId: session.userId,
      mode: parsed.data.mode,
      modelId: parsed.data.modelId,
      contextSources: parsed.data.contextSources,
    })
    // The first sync is what actually dispatches stage one in AUTOMATED mode.
    const run = await syncAgentRun(runId, session.userId)
    revalidatePath('/run-console')
    return {
      ok:
        parsed.data.mode === 'AUTOMATED'
          ? 'Run started. Agents draft ahead; every gate still waits for you.'
          : 'Run started in manual mode. Dispatch each agent when you are ready.',
      runId,
      run,
      drafted: await draftedForStage(run.productId, run.currentStage),
    }
  } catch (error) {
    return { error: message(error) }
  }
}

/**
 * The console's heartbeat. Recomputes where the run stands and, in automated mode, dispatches
 * whatever it may dispatch now. Called on a timer by the client because there is no background
 * worker — nothing happens here except while a human is watching, which is the point.
 */
export async function syncRunAction(runId: string): Promise<RunResult> {
  const session = await requireSession()
  try {
    const run = await syncAgentRun(runId, session.userId)
    return { run, drafted: await draftedForStage(run.productId, run.currentStage) }
  } catch (error) {
    return { error: message(error) }
  }
}

export async function dispatchStepAction(_prev: RunResult | undefined, formData: FormData): Promise<RunResult> {
  const session = await requireSession()
  const runId = String(formData.get('runId') ?? '')
  const stepId = String(formData.get('stepId') ?? '')
  if (!runId || !stepId) return { error: 'Nothing to dispatch.' }

  try {
    await dispatchStep(runId, stepId, session.userId)
    const run = await syncAgentRun(runId, session.userId)
    revalidatePath('/run-console')
    return {
      ok: 'Agent dispatched. Its output is a proposal until you say otherwise.',
      run,
      drafted: await draftedForStage(run.productId, run.currentStage),
    }
  } catch (error) {
    return { error: message(error) }
  }
}

/**
 * Attach a catalogue or modelling export to the product, from the console rather than the stage
 * screen. It delegates to the same import action the studio uses, so the parsing, validation,
 * duplicate check and audit trail are identical — this is a second door onto one room, not a
 * second implementation.
 */
export async function attachContextAction(
  _prev: RunResult | undefined,
  formData: FormData,
): Promise<RunResult> {
  const connector = getConnector(String(formData.get('connectorKey') ?? ''))
  if (!connector) return { error: 'Choose a tool to import from.' }

  const result = await importExternalMetadataAction(undefined, formData)
  revalidatePath('/run-console')
  if (result.error) {
    return { error: result.details?.length ? `${result.error} ${result.details.join(' ')}` : result.error }
  }
  return {
    ok: `${connector.name} attached. It is context an agent may read — not artifact content, and nothing has been committed.`,
  }
}

export async function cancelRunAction(_prev: RunResult | undefined, formData: FormData): Promise<RunResult> {
  const session = await requireSession()
  const runId = String(formData.get('runId') ?? '')
  const reason = String(formData.get('reason') ?? '')
  if (!runId) return { error: 'No run to cancel.' }

  try {
    await cancelAgentRun(runId, session.userId, reason)
    revalidatePath('/run-console')
    return {
      ok: 'Run cancelled. Drafts already produced are untouched and still waiting for you.',
      run: (await loadRun(runId)) ?? undefined,
    }
  } catch (error) {
    return { error: message(error) }
  }
}
