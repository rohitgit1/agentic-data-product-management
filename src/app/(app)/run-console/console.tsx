'use client'

import Link from 'next/link'
import { useActionState, useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  attachContextAction,
  cancelRunAction,
  dispatchStepAction,
  startRunAction,
  syncRunAction,
  type RunResult,
} from './actions'
import { dispositionProposalAction } from '../products/actions'
import type { RunView } from '@/lib/agents/orchestrator'
import type { ConsoleProduct, ContextAttachment, DraftedItem } from '@/lib/queries/run-console'
import { roleName } from '@/lib/domain/roles'
import type { RoleKey } from '@/lib/domain/roles'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorText,
  EmptyState,
  Field,
  inputClass,
  type Tone,
} from '@/components/ui'

/** How often the console asks the server where the run stands. No background worker exists. */
const POLL_MS = 2500

const RUN_STATE_TONE: Record<string, Tone> = {
  RUNNING: 'info',
  AWAITING_REVIEW: 'agent',
  AWAITING_GATE: 'warn',
  BLOCKED: 'bad',
  COMPLETED: 'good',
  CANCELLED: 'neutral',
}

const RUN_STATE_LABEL: Record<string, string> = {
  RUNNING: 'Running',
  AWAITING_REVIEW: 'Awaiting your review',
  AWAITING_GATE: 'Awaiting gate decision',
  BLOCKED: 'Blocked',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
}

const STEP_TONE: Record<string, Tone> = {
  PENDING: 'neutral',
  RUNNING: 'info',
  DRAFTED: 'good',
  SKIPPED: 'neutral',
  FAILED: 'bad',
}

/** The two context sources an operator can attach, in the order the console offers them. */
const CONTEXT_SOURCES = [
  {
    category: 'DATA_CATALOGUE' as const,
    label: 'Data catalogue',
    blurb: 'Sources, glossary, certified metrics and lineage hops from Collibra or Alation.',
  },
  {
    category: 'DATA_MODELLING' as const,
    label: 'Data modelling',
    blurb: 'Entities, keys, attributes and relationships from erwin.',
  },
]

export interface RunConsoleProps {
  products: ConsoleProduct[]
  openRuns: { id: string; productName: string; state: string }[]
  selectedProductId: string
  attachments: ContextAttachment[]
  initialRun: RunView | null
  drafted: DraftedItem[]
  currentStageApprovers: string[]
  importStages: number[]
  models: { id: string; name: string; tier: string; bestFor: string }[]
  stages: { number: number; name: string }[]
  route: { stageNumber: number; name: string; agents: string[] }[]
  connectors: {
    key: string
    name: string
    category: string
    supplies: string[]
    fileTypes: string[]
    howToExport: string
  }[]
  agentsEnabled: boolean
  budgetRemainingUsd: number
  provider: 'model' | 'local-heuristic'
}

export function RunConsole(props: RunConsoleProps) {
  const router = useRouter()
  const [run, setRun] = useState<RunView | null>(props.initialRun)
  const [drafted, setDrafted] = useState<DraftedItem[]>(props.drafted)
  const productId = props.selectedProductId
  const [contextSources, setContextSources] = useState<string[]>(() =>
    CONTEXT_SOURCES.filter((source) =>
      props.attachments.some((attachment) => attachment.category === source.category),
    ).map((source) => source.category),
  )
  const [mode, setMode] = useState<'AUTOMATED' | 'MANUAL'>('AUTOMATED')
  const [modelId, setModelId] = useState(props.models[1]?.id ?? props.models[0]?.id ?? '')
  const [pollError, setPollError] = useState<string | undefined>()
  const [, startPoll] = useTransition()

  const [startState, startAction, starting] = useActionState<RunResult | undefined, FormData>(
    startRunAction,
    undefined,
  )
  const [cancelState, cancelAction, cancelling] = useActionState<RunResult | undefined, FormData>(
    cancelRunAction,
    undefined,
  )

  useEffect(() => {
    if (startState?.run) setRun(startState.run)
    if (startState?.drafted) setDrafted(startState.drafted)
  }, [startState])
  useEffect(() => {
    if (cancelState?.run) setRun(cancelState.run)
  }, [cancelState])

  const active = run && run.state !== 'COMPLETED' && run.state !== 'CANCELLED'

  const poll = useCallback(() => {
    if (!run) return
    startPoll(async () => {
      const result = await syncRunAction(run.id)
      if (result.error) setPollError(result.error)
      else if (result.run) {
        setPollError(undefined)
        setRun(result.run)
        if (result.drafted) setDrafted(result.drafted)
      }
    })
  }, [run])

  // The heartbeat: in automated mode this is also what dispatches the next stage once a human has
  // cleared the gate, so it keeps running while the run is anything other than finished.
  useEffect(() => {
    if (!active) return
    const timer = setInterval(poll, POLL_MS)
    return () => clearInterval(timer)
  }, [active, poll])

  const selectedProduct = props.products.find((product) => product.id === productId)

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="lg:col-span-2">
        <Card>
          <CardHeader
            title="Run settings"
            description="Choose the product, how much you want the run to do on its own, and which model does the drafting."
            actions={
              <span className="flex items-center gap-2">
                <Badge tone={props.agentsEnabled ? 'good' : 'bad'}>
                  {props.agentsEnabled ? 'Agents enabled' : 'Agents disabled'}
                </Badge>
                <Badge tone={props.provider === 'model' ? 'info' : 'neutral'} title={
                  props.provider === 'model'
                    ? 'An API key is configured, so the chosen model runs.'
                    : 'No API key is configured, so the deterministic local heuristic runs instead. The log records both.'
                }>
                  {props.provider === 'model' ? 'Model backed' : 'Local heuristic'}
                </Badge>
                <Badge tone={props.budgetRemainingUsd > 0 ? 'neutral' : 'bad'}>
                  ${props.budgetRemainingUsd.toFixed(2)} budget left
                </Badge>
              </span>
            }
          />
          <CardBody>
            <form action={startAction} className="grid gap-4 md:grid-cols-4">
              <div className="md:col-span-2">
                <Field label="Data product" htmlFor="productId" required>
                  <select
                    id="productId"
                    name="productId"
                    className={inputClass}
                    value={productId}
                    // The product drives which attachments are shown, and those are read on the
                    // server, so choosing one is a navigation rather than local state.
                    onChange={(event) => router.push(`/run-console?product=${event.target.value}`)}
                    disabled={Boolean(active)}
                  >
                    {props.products.length === 0 ? <option value="">No products yet</option> : null}
                    {props.products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name} — Stage {product.currentStage} · {product.domainName}
                        {product.hasOpenRun ? ' (run open)' : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <Field label="Execution" htmlFor="mode" required>
                <div className="flex overflow-hidden rounded-md border border-ink-300">
                  {(['AUTOMATED', 'MANUAL'] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={mode === option}
                      disabled={Boolean(active)}
                      onClick={() => setMode(option)}
                      className={`flex-1 px-3 py-2 text-xs font-semibold uppercase tracking-wide transition disabled:opacity-60 ${
                        mode === option ? 'bg-accent-600 text-white' : 'bg-white text-ink-700 hover:bg-ink-50'
                      }`}
                    >
                      {option === 'AUTOMATED' ? 'Automated' : 'Manual'}
                    </button>
                  ))}
                </div>
                <input type="hidden" name="mode" value={mode} />
              </Field>

              <Field label="Model" htmlFor="modelId" required hint={props.models.find((m) => m.id === modelId)?.bestFor}>
                <select
                  id="modelId"
                  name="modelId"
                  className={inputClass}
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                  disabled={Boolean(active)}
                >
                  {props.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name} · {model.tier}
                    </option>
                  ))}
                </select>
              </Field>

              <div className="md:col-span-4 border-t border-ink-200 pt-4">
                <p className="mb-2 text-sm font-medium text-ink-800">
                  Context sources for the agents
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {CONTEXT_SOURCES.map((source) => {
                    const attached = props.attachments.filter((a) => a.category === source.category)
                    const checked = contextSources.includes(source.category)
                    return (
                      <label
                        key={source.category}
                        className={`flex gap-2 rounded-md border px-3 py-2 ${
                          checked ? 'border-accent-600 bg-accent-50' : 'border-ink-300 bg-white'
                        } ${active ? 'opacity-60' : 'cursor-pointer'}`}
                      >
                        <input
                          type="checkbox"
                          name="contextSources"
                          value={source.category}
                          checked={checked}
                          disabled={Boolean(active)}
                          onChange={(event) =>
                            setContextSources((current) =>
                              event.target.checked
                                ? [...current, source.category]
                                : current.filter((entry) => entry !== source.category),
                            )
                          }
                          className="mt-0.5"
                        />
                        <span>
                          <span className="block text-sm font-medium text-ink-900">{source.label}</span>
                          <span className="block text-xs text-ink-600">{source.blurb}</span>
                          <span
                            className={`mt-1 block text-xs ${
                              attached.length ? 'text-emerald-800' : 'text-amber-900'
                            }`}
                          >
                            {attached.length
                              ? `${attached.length} import(s) attached — ${attached[0]!.summary}`
                              : 'Nothing attached yet. Import below, or leave this off.'}
                          </span>
                        </span>
                      </label>
                    )
                  })}
                </div>
                <p className="mt-2 text-xs text-ink-600">
                  Attached metadata is <strong>context an agent may read</strong>, never artifact
                  content. It widens what an agent knows; it changes nothing about what an agent may
                  do, and every stage stays completable with both switched off.
                </p>
              </div>

              <div className="md:col-span-4 flex flex-wrap items-center gap-3 border-t border-ink-200 pt-4">
                <Button disabled={starting || Boolean(active) || !props.agentsEnabled || props.products.length === 0}>
                  {starting ? 'Starting…' : mode === 'AUTOMATED' ? 'Start automated execution' : 'Start manual execution'}
                </Button>
                <p className="text-xs text-ink-600">
                  {mode === 'AUTOMATED'
                    ? 'Dispatches each stage’s agents, then halts for your review and your gate decision before the next stage.'
                    : 'Dispatches nothing on its own. You press a button per agent.'}
                </p>
              </div>
            </form>

            {startState?.error ? <ErrorText>{startState.error}</ErrorText> : null}
            {cancelState?.error ? <ErrorText>{cancelState.error}</ErrorText> : null}
            {!props.agentsEnabled ? (
              <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                Agents are switched off for this workspace. Turn them on in{' '}
                <Link href="/admin" className="underline">
                  Admin
                </Link>
                . Every stage remains completable by hand either way.
              </p>
            ) : null}
            {props.openRuns.length > 1 ? (
              <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-700">
                <span className="font-semibold">{props.openRuns.length} runs in flight:</span>
                {props.openRuns.map((openRun) => (
                  <Link
                    key={openRun.id}
                    href={`/run-console?run=${openRun.id}`}
                    className={`rounded border px-2 py-0.5 ${
                      openRun.id === run?.id
                        ? 'border-accent-600 bg-accent-50 text-accent-700'
                        : 'border-ink-300 hover:bg-ink-50'
                    }`}
                  >
                    {openRun.productName}
                  </Link>
                ))}
              </p>
            ) : null}
            {selectedProduct && !active ? (
              <p className="mt-3 text-xs text-ink-600">
                The run starts at Stage {selectedProduct.currentStage} — where {selectedProduct.name} actually
                is. A run never rewinds history.
              </p>
            ) : null}
          </CardBody>
        </Card>
      </div>

      <div className="lg:col-span-2">
        <ContextSources
          productId={productId}
          attachments={props.attachments}
          connectors={props.connectors}
          locked={Boolean(active)}
        />
      </div>

      <div className="lg:col-span-2">
        <StageRail run={run} route={props.route} stages={props.stages} />
      </div>

      <ExecutionLog
        run={run}
        pollError={pollError}
        cancelAction={cancelAction}
        cancelling={cancelling}
        onDispatched={(next, nextDrafted) => {
          setRun(next)
          if (nextDrafted) setDrafted(nextDrafted)
        }}
      />

      <DraftedOutput
        run={run}
        drafted={drafted}
        onDecided={poll}
        approvers={props.currentStageApprovers}
        connectors={props.connectors}
        importStages={props.importStages}
      />
    </div>
  )
}

/**
 * Attaching an export is a second door onto the same import the stage studio offers, put here
 * because this is where an operator decides what an agent should know before pressing start.
 */
function ContextSources({
  productId,
  attachments,
  connectors,
  locked,
}: {
  productId: string
  attachments: ContextAttachment[]
  connectors: RunConsoleProps['connectors']
  locked: boolean
}) {
  return (
    <Card>
      <CardHeader
        title="Attach catalogue and model metadata"
        description="Export from your tool, upload the file. There is no live API call — ADPM runs offline and does not write back to a system of record it does not own."
      />
      <CardBody>
        <div className="grid gap-4 md:grid-cols-2">
          {CONTEXT_SOURCES.map((source) => (
            <AttachPanel
              key={source.category}
              label={source.label}
              productId={productId}
              locked={locked}
              // The panel's own category first, so the default selection matches the panel and a
              // modelling CSV is never handed to the JSON parser. The canonical import stays
              // available underneath for anything that can emit the normalised shape directly.
              connectors={[
                ...connectors.filter((connector) => connector.category === source.category),
                ...connectors.filter((connector) => connector.category === 'OPEN'),
              ]}
              attached={attachments.filter((a) => a.category === source.category)}
            />
          ))}
        </div>
        {locked ? (
          <p className="mt-3 text-xs text-ink-600">
            A run is open, so its context is fixed. Cancel it to attach anything further — an agent
            that read one catalogue halfway through a run and another afterwards would leave a log
            nobody could reconstruct.
          </p>
        ) : null}
      </CardBody>
    </Card>
  )
}

function AttachPanel({
  label,
  productId,
  connectors,
  attached,
  locked,
}: {
  label: string
  productId: string
  connectors: RunConsoleProps['connectors']
  attached: ContextAttachment[]
  locked: boolean
}) {
  const [connectorKey, setConnectorKey] = useState(connectors[0]?.key ?? '')
  const [state, action, pending] = useActionState<RunResult | undefined, FormData>(
    attachContextAction,
    undefined,
  )
  const selected = connectors.find((connector) => connector.key === connectorKey)

  return (
    <div className="rounded-md border border-ink-200 p-3">
      <p className="text-sm font-semibold text-ink-900">{label}</p>

      {attached.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {attached.map((attachment) => (
            <li key={attachment.id} className="text-xs text-ink-700">
              <Badge tone="good">attached</Badge>{' '}
              <span className="font-medium">{attachment.connectorName}</span> · {attachment.fileName}{' '}
              — {attachment.summary}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-ink-600">Nothing attached.</p>
      )}

      <form action={action} className="mt-3">
        <input type="hidden" name="productId" value={productId} />
        <Field label="Tool" htmlFor={`connector-${label}`}>
          <select
            id={`connector-${label}`}
            name="connectorKey"
            className={inputClass}
            value={connectorKey}
            disabled={locked}
            onChange={(event) => setConnectorKey(event.target.value)}
          >
            {connectors.map((connector) => (
              <option key={connector.key} value={connector.key}>
                {connector.name}
              </option>
            ))}
          </select>
        </Field>
        {selected ? (
          <details className="mb-2">
            <summary className="cursor-pointer text-xs text-accent-700">How to export this</summary>
            <p className="mt-1 text-xs text-ink-600">{selected.howToExport}</p>
            <p className="mt-1 text-xs text-ink-600">
              Supplies: {selected.supplies.join(', ')}.
            </p>
          </details>
        ) : null}
        <Field label="Export file" htmlFor={`file-${label}`}>
          <input
            id={`file-${label}`}
            name="file"
            type="file"
            accept={selected?.fileTypes.join(',')}
            disabled={locked}
            className={inputClass}
          />
        </Field>
        <Button variant="secondary" disabled={pending || locked}>
          {pending ? 'Reading…' : 'Attach'}
        </Button>
        {state?.error ? <ErrorText>{state.error}</ErrorText> : null}
        {state?.ok ? <p className="mt-2 text-xs text-emerald-800">{state.ok}</p> : null}
      </form>
    </div>
  )
}

function StageRail({
  run,
  route,
  stages,
}: {
  run: RunView | null
  route: RunConsoleProps['route']
  stages: { number: number; name: string }[]
}) {
  const statusByStage = new Map((run?.stages ?? []).map((stage) => [stage.stageNumber, stage]))

  return (
    <Card>
      <CardHeader
        title="Lifecycle route"
        description={
          run
            ? `Stage ${run.currentStage} of ${run.toStage}. Each stage drafts, then waits for a human before the next one starts.`
            : 'The twelve stages and the agents chartered for each. Nothing is dispatched until you start a run.'
        }
      />
      <CardBody>
        <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {stages.map((stage) => {
            const status = statusByStage.get(stage.number)
            const current = run?.currentStage === stage.number
            const approved = status?.gateState === 'APPROVED'
            const planned = route.find((entry) => entry.stageNumber === stage.number)
            return (
              <li
                key={stage.number}
                aria-current={current ? 'step' : undefined}
                className={`rounded-md border px-3 py-2 ${
                  current
                    ? 'border-accent-600 bg-accent-50'
                    : approved
                      ? 'border-emerald-200 bg-emerald-50'
                      : 'border-ink-200 bg-white'
                }`}
              >
                <p className="flex items-center justify-between gap-2 text-xs font-semibold text-ink-800">
                  <span>
                    {stage.number}. {stage.name}
                  </span>
                  {approved ? <Badge tone="good">gate</Badge> : null}
                </p>
                <p className="mt-1 text-[11px] text-ink-600">
                  {planned?.agents.length ? planned.agents.join(' · ') : 'No chartered agent — human authored'}
                </p>
                {status ? (
                  <p className="mt-1 text-[11px] text-ink-600">
                    {status.pendingProposals > 0
                      ? `${status.pendingProposals} awaiting review`
                      : status.dispositionedProposals > 0
                        ? `${status.dispositionedProposals} reviewed`
                        : '—'}
                    {status.blockingCriteria > 0
                      ? ` · ${status.passingCriteria}/${status.blockingCriteria} criteria`
                      : ''}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ol>
      </CardBody>
    </Card>
  )
}

function ExecutionLog({
  run,
  pollError,
  cancelAction,
  cancelling,
  onDispatched,
}: {
  run: RunView | null
  pollError?: string
  cancelAction: (formData: FormData) => void
  cancelling: boolean
  onDispatched: (run: RunView, drafted?: DraftedItem[]) => void
}) {
  return (
    <Card>
      <CardHeader
        title="Execution log"
        description="Every dispatch, in order, with what it produced and what it cost you in review."
        actions={
          run ? (
            <span className="flex items-center gap-2">
              <Badge tone={RUN_STATE_TONE[run.state] ?? 'neutral'}>
                {RUN_STATE_LABEL[run.state] ?? run.state}
              </Badge>
              <Badge tone="neutral">{run.mode === 'AUTOMATED' ? 'Automated' : 'Manual'}</Badge>
            </span>
          ) : undefined
        }
      />
      <CardBody>
        {!run ? (
          <EmptyState title="Idle.">
            Choose a data product and press start. Agents will draft; you will decide.
          </EmptyState>
        ) : (
          <>
            <p className="mb-3 rounded-md border border-ink-200 bg-ink-50 px-3 py-2 text-sm text-ink-800">
              {run.statusDetail}
            </p>
            {pollError ? <ErrorText>{pollError}</ErrorText> : null}
            <ol className="space-y-2">
              {run.steps.map((step) => (
                <li key={step.id} className="rounded-md border border-ink-200 px-3 py-2">
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge tone={STEP_TONE[step.state] ?? 'neutral'}>{step.state.toLowerCase()}</Badge>
                    <span className="font-medium text-ink-900">
                      S{step.stageNumber} · {step.agentName}
                    </span>
                    {step.state === 'PENDING' && run.mode === 'MANUAL' && step.stageNumber === run.currentStage ? (
                      <DispatchButton runId={run.id} stepId={step.id} onDispatched={onDispatched} />
                    ) : null}
                  </p>
                  {step.narrative ? (
                    <p className="mt-1 text-xs text-ink-800">{step.narrative}</p>
                  ) : null}
                  {step.detail ? <p className="mt-1 text-xs text-ink-600">{step.detail}</p> : null}
                </li>
              ))}
            </ol>
            {run.state !== 'COMPLETED' && run.state !== 'CANCELLED' ? (
              <form action={cancelAction} className="mt-4 flex items-end gap-2 border-t border-ink-200 pt-4">
                <input type="hidden" name="runId" value={run.id} />
                <div className="flex-1">
                  <Field label="Stop the run" htmlFor="reason" hint="Drafts already produced stay where they are.">
                    <input id="reason" name="reason" className={inputClass} placeholder="Why are you stopping?" />
                  </Field>
                </div>
                <Button variant="secondary" disabled={cancelling}>
                  {cancelling ? 'Stopping…' : 'Cancel run'}
                </Button>
              </form>
            ) : (
              <p className="mt-4 border-t border-ink-200 pt-4 text-sm text-ink-700">
                {run.endedReason}
              </p>
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}

function DispatchButton({
  runId,
  stepId,
  onDispatched,
}: {
  runId: string
  stepId: string
  onDispatched: (run: RunView, drafted?: DraftedItem[]) => void
}) {
  const [state, action, pending] = useActionState<RunResult | undefined, FormData>(
    dispatchStepAction,
    undefined,
  )
  useEffect(() => {
    if (state?.run) onDispatched(state.run, state.drafted)
  }, [state, onDispatched])

  return (
    <form action={action} className="inline">
      <input type="hidden" name="runId" value={runId} />
      <input type="hidden" name="stepId" value={stepId} />
      <Button variant="secondary" disabled={pending}>
        {pending ? 'Dispatching…' : 'Dispatch'}
      </Button>
    </form>
  )
}

function DraftedOutput({
  run,
  drafted,
  approvers,
  connectors,
  importStages,
  onDecided,
}: {
  run: RunView | null
  drafted: DraftedItem[]
  approvers: string[]
  connectors: RunConsoleProps['connectors']
  importStages: number[]
  onDecided: () => void
}) {
  const pending = drafted.filter((item) => item.state === 'PENDING')
  const decided = drafted.filter((item) => item.state !== 'PENDING')

  return (
    <Card>
      <CardHeader
        title="Drafted output"
        description={
          run
            ? `Stage ${run.currentStage}. Accept, edit or reject each item. Nothing here is in the artifact until you commit it in the Lifecycle Studio.`
            : 'Agent drafts appear here as they are produced.'
        }
        actions={
          run ? (
            <Link
              href={`/products/${run.productId}/stage/${run.currentStage}`}
              className="text-sm text-accent-700 underline"
            >
              Open Stage {run.currentStage}
            </Link>
          ) : undefined
        }
      />
      <CardBody>
        {!run ? (
          <EmptyState title="Nothing drafted yet." />
        ) : (
          <>
            {run.currentStage && importStages.includes(run.currentStage) ? (
              <div className="mb-4 rounded-md border border-accent-100 bg-accent-50 px-3 py-2 text-xs text-ink-700">
                <span className="font-semibold text-ink-800">Give this stage more to work with. </span>
                Import from{' '}
                {connectors.map((connector, index) => (
                  <span key={connector.key}>
                    {index > 0 ? ', ' : ''}
                    {connector.name}
                  </span>
                ))}{' '}
                on the{' '}
                <Link
                  href={`/products/${run.productId}/stage/${run.currentStage}`}
                  className="underline"
                >
                  Stage {run.currentStage} screen
                </Link>
                , then dispatch again — agents read the catalogue and model as declared context, never as
                artifact content.
              </div>
            ) : null}

            {pending.length === 0 && decided.length === 0 ? (
              <EmptyState title="No drafts on this stage yet.">
                {run.state === 'RUNNING'
                  ? 'Agents are working.'
                  : 'Dispatch an agent, or write the artifact yourself — the stage does not need one.'}
              </EmptyState>
            ) : null}

            {pending.length > 0 ? (
              <p className="mb-3 text-sm text-ink-700">
                <strong>{pending.length}</strong> item(s) waiting on you.{' '}
                {approvers.length > 0 ? (
                  <>Gate approvers for this stage: {approvers.map((role) => roleName(role as RoleKey)).join(', ')}.</>
                ) : null}
              </p>
            ) : null}

            <ul className="space-y-3">
              {[...pending, ...decided].map((item) => (
                <DraftedRow key={item.id} item={item} onDecided={onDecided} />
              ))}
            </ul>
          </>
        )}
      </CardBody>
    </Card>
  )
}

function DraftedRow({ item, onDecided }: { item: DraftedItem; onDecided: () => void }) {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState<{ ok?: string; error?: string } | undefined, FormData>(
    dispositionProposalAction,
    undefined,
  )
  // A recorded decision re-reads the stage, so the row moves to its decided state and the run's
  // status updates from "awaiting your review" the moment the last one is cleared. The callback is
  // held in a ref: it is rebuilt on every poll, and depending on it here would re-fire this effect
  // on each rebuild while `ok` is still set, polling in a loop.
  const decidedRef = useRef(onDecided)
  decidedRef.current = onDecided
  useEffect(() => {
    if (state?.ok) decidedRef.current()
  }, [state])
  const decided = item.state !== 'PENDING'

  return (
    <li className={`rounded-md border px-3 py-3 ${decided ? 'border-ink-200 bg-ink-50' : 'agent-proposed border-ink-200'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink-900">
          <Badge tone="agent">{item.agentName}</Badge>{' '}
          <span className="font-mono text-xs">{item.fieldPath}</span>
          {item.isComment ? <span className="ml-2 text-xs text-ink-600">review comment</span> : null}
        </p>
        <Badge
          tone={
            item.state === 'PENDING'
              ? 'warn'
              : item.state === 'REJECTED'
                ? 'bad'
                : 'good'
          }
        >
          {item.state.toLowerCase()}
          {item.dispositionedBy ? ` · ${item.dispositionedBy}` : ''}
        </Badge>
      </div>

      {item.rationale ? <p className="mt-1 text-xs text-ink-600">{item.rationale}</p> : null}

      <pre className="mt-2 max-h-48 overflow-auto rounded border border-ink-200 bg-white p-2 text-xs text-ink-800">
        {item.preview}
      </pre>

      {decided ? null : (
        <form action={action} className="mt-2">
          <input type="hidden" name="proposalId" value={item.id} />
          {open ? (
            <Field label="Your edit (YAML)" htmlFor={`edit-${item.id}`}>
              <textarea
                id={`edit-${item.id}`}
                name="editedValue"
                rows={5}
                defaultValue={item.preview}
                className={inputClass}
              />
            </Field>
          ) : null}
          <Field label="Note for the record" htmlFor={`note-${item.id}`}>
            <input id={`note-${item.id}`} name="note" className={inputClass} placeholder="Optional" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button name="action" value="ACCEPT" disabled={pending}>
              Approve
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen((current) => !current)}
              disabled={pending}
            >
              {open ? 'Cancel edit' : 'Review & edit'}
            </Button>
            {open ? (
              <Button name="action" value="EDIT_ACCEPT" variant="secondary" disabled={pending}>
                Accept my edit
              </Button>
            ) : null}
            <Button name="action" value="REJECT" variant="danger" disabled={pending}>
              Reject
            </Button>
          </div>
          {state?.error ? <ErrorText>{state.error}</ErrorText> : null}
          {state?.ok ? <p className="mt-2 text-xs text-emerald-800">{state.ok}</p> : null}
        </form>
      )}
    </li>
  )
}
