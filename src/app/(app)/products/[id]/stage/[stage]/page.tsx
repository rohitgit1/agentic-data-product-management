import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/db'
import { requireSession } from '@/lib/auth/session'
import { loadStageView } from '@/lib/queries/studio'
import { credentialStatus } from '@/lib/secrets'
import { getGuide, STAGE_GUIDES } from '@/lib/guides/registry'
import { StageNav } from '@/components/studio/stage-nav'
import { AgentPanel, ArtifactEditor, GatePanel, ReviewThread } from '@/components/studio/panels'
import {
  AttributeWorkbookRoundTrip,
  CsvProfiler,
  ExternalMetadataImporter,
} from '@/components/studio/imports'
import { CONNECTORS, getConnector } from '@/lib/integrations/registry'
import { Badge, Card, CardBody, CardHeader, PageHeader } from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function StagePage({
  params,
}: {
  params: Promise<{ id: string; stage: string }>
}) {
  const { id, stage: stageParam } = await params
  const stageNumber = Number(stageParam)
  if (!Number.isInteger(stageNumber) || stageNumber < 1 || stageNumber > 12) notFound()

  const session = await requireSession()
  const view = await loadStageView(id, stageNumber)
  if (!view) notFound()

  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: view.product.workspaceId } })
  const credentials = await credentialStatus()
  // Discovery, profiling, modelling and semantics are the stages where what erwin and the
  // catalogue already know is worth having in front of an agent.
  const METADATA_IMPORT_STAGES = [3, 4, 6]
  const metadataImports = METADATA_IMPORT_STAGES.includes(stageNumber)
    ? await prisma.externalMetadataImport.findMany({
        where: { productId: id, archivedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 10,
      })
    : []
  const gates = await prisma.gate.findMany({
    where: { productId: id },
    select: { stageNumber: true, state: true },
  })
  const gateStates = new Map(gates.map((g) => [g.stageNumber, g.state]))
  const guide = getGuide(view.stage.guideKey) || STAGE_GUIDES[stageNumber - 1] || STAGE_GUIDES[0]

  const canApprove = session.roles.some(
    (role) => view.stage.approverRoles.includes(role) || view.stage.vetoRoles.includes(role),
  )
  const hasAcceptedProposals = view.proposals.some(
    (p) => (p.state === 'ACCEPTED' || p.state === 'EDITED') && !p.isComment,
  )
  const blocking = view.criteria.filter((c) => c.blocking)
  const passing = blocking.filter((c) => c.passed).length

  return (
    <div>
      <p className="mb-2 text-sm">
        <Link href={`/products/${id}`} className="text-accent-600 underline">
          ← {view.product.name}
        </Link>
      </p>
      <PageHeader
        eyebrow={`Stage ${view.stage.number} of 12 · ${view.product.domainName}`}
        title={view.stage.name}
        description={view.stage.purpose}
        actions={
          <span className="flex gap-2">
            <Badge tone={view.product.status === 'PUBLISHED' ? 'good' : 'neutral'}>
              {view.product.status}
            </Badge>
            <Badge tone={passing === blocking.length ? 'good' : 'warn'}>
              {passing}/{blocking.length} blocking criteria
            </Badge>
          </span>
        }
      />

      <StageNav productId={id} current={stageNumber} gateStates={gateStates} />

      <details open className="mb-6 rounded-lg border border-accent-100 bg-accent-50 px-5 py-4">
        <summary className="cursor-pointer text-sm font-semibold text-accent-700">
          Why this stage matters
        </summary>
        <p className="mt-2 text-sm text-ink-800">{view.stage.whyItMatters}</p>
        {guide ? (
          <>
            <p className="mt-3 text-sm text-ink-800">
              <strong>In plain terms:</strong> {guide.plainTerms}
            </p>
            <p className="mt-2 text-sm text-ink-800">
              <strong>What breaks if you skip it:</strong> {guide.whatBreaks}
            </p>
            <p className="mt-2 text-xs text-ink-600">
              Typical effort: {guide.effort} ·{' '}
              <Link href={`/academy/${guide.key}`} className="text-accent-700 underline">
                Full guide
              </Link>
            </p>
          </>
        ) : null}
      </details>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title="Exit criteria"
              description="Evaluated live, and evaluated again by the engine when the gate opens. There is no way past them."
            />
            <CardBody>
              <ul className="space-y-2">
                {view.criteria.map((criterion) => (
                  <li key={criterion.key} className="flex gap-3">
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${
                        criterion.passed ? 'bg-emerald-600' : criterion.blocking ? 'bg-rose-600' : 'bg-amber-500'
                      }`}
                    >
                      {criterion.passed ? '✓' : '!'}
                    </span>
                    <span>
                      <span className="text-sm font-medium text-ink-900">
                        {criterion.label}
                        {!criterion.blocking ? (
                          <span className="ml-2 text-xs font-normal text-ink-500">(advisory)</span>
                        ) : null}
                      </span>
                      <span className="sr-only">{criterion.passed ? ' passed' : ' not met'}</span>
                      <p className="text-sm text-ink-600">{criterion.detail}</p>
                    </span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>

          {METADATA_IMPORT_STAGES.includes(stageNumber) ? (
            <ExternalMetadataImporter
              productId={id}
              connectors={CONNECTORS.map((c) => ({
                key: c.key,
                name: c.name,
                vendor: c.vendor,
                category: c.category,
                fileTypes: [...c.fileTypes],
                howToExport: c.howToExport,
                note: c.note,
                verified: !!c.verification,
              }))}
              existing={metadataImports.map((item) => ({
                id: item.id,
                connectorName: getConnector(item.connectorKey)?.name ?? item.connectorKey,
                summary: item.summary,
                fileName: item.fileName,
                importedOn: item.createdAt.toLocaleDateString('en-GB'),
              }))}
            />
          ) : null}
          {stageNumber === 3 ? <CsvProfiler productId={id} /> : null}
          {stageNumber === 5 ? <AttributeWorkbookRoundTrip productId={id} /> : null}

          {view.artifacts.map((artifact) => (
            <ArtifactEditor
              key={artifact.type}
              artifact={artifact}
              productId={id}
              hasAcceptedProposals={hasAcceptedProposals}
            />
          ))}

          <ReviewThread view={view} />
        </div>

        <div className="space-y-6">
          <GatePanel view={view} canApprove={canApprove} myRoles={session.roles} />
          <AgentPanel
            view={view}
            productId={id}
            agentsEnabled={workspace.agentsEnabled}
            providerLabel={
              credentials.configured
                ? `Provider: Anthropic ${credentials.model ?? 'claude-opus-5'} (key ${credentials.hint}).`
                : 'No API key configured, so runs use the local heuristic provider — deterministic, offline, and labelled as such.'
            }
          />

          <Card>
            <CardHeader title="Audit timeline" description="Append-only. Nothing here can be edited." />
            <CardBody className="max-h-[420px] overflow-y-auto">
              <ul className="space-y-2 text-xs">
                {view.audit.map((event) => (
                  <li key={event.id} className="border-b border-ink-100 pb-2 last:border-0">
                    <p className="font-mono text-ink-800">{event.action}</p>
                    <p className="text-ink-500">
                      {event.actorName} · {event.createdAt.toLocaleString('en-GB')}
                    </p>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  )
}
