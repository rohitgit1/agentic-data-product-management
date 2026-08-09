import { prisma } from '@/lib/db'
import { requireSession } from '@/lib/auth/session'
import { credentialStatus } from '@/lib/secrets'
import { AGENT_MODELS } from '@/lib/agents/models'
import { CONNECTORS } from '@/lib/integrations/registry'
import { loadRunConsole, plannedRoute } from '@/lib/queries/run-console'
import { STAGES } from '@/lib/lifecycle/stages'
import { RunConsole } from './console'
import { Callout, PageHeader } from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function RunConsolePage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string; product?: string }>
}) {
  const session = await requireSession()
  const { run: runParam, product: productParam } = await searchParams
  const view = await loadRunConsole(session.workspaceId, runParam, productParam)
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: session.workspaceId } })
  const credentials = await credentialStatus()

  return (
    <div>
      <PageHeader
        eyebrow="Enable"
        title="Agent Run Console"
        description="Dispatch agents across the 12-stage lifecycle, automatically or one at a time. Agents draft; you accept, edit or reject every line; the gates stay yours."
      />

      <Callout tone="agent" title="What an automated run does, and what it will never do">
        An automated run dispatches each stage&rsquo;s chartered agents, then <strong>stops</strong> and
        waits for you. It cannot approve a gate, commit an artifact version, publish a product or
        satisfy an exit criterion — there is no autonomy level, model or setting that changes that.
        Every stage here is also completable with agents switched off entirely.
      </Callout>

      <RunConsole
        products={view.products}
        openRuns={view.openRuns}
        selectedProductId={view.selectedProductId}
        attachments={view.attachments}
        initialRun={view.run}
        drafted={view.drafted}
        currentStageApprovers={view.currentStageApprovers}
        importStages={view.importStages}
        models={AGENT_MODELS.map((model) => ({
          id: model.id,
          name: model.name,
          tier: model.tier,
          bestFor: model.bestFor,
        }))}
        stages={STAGES.map((stage) => ({ number: stage.number, name: stage.name }))}
        route={plannedRoute(1, STAGES.length)}
        connectors={CONNECTORS.map((connector) => ({
          key: connector.key,
          name: connector.name,
          category: connector.category,
          supplies: connector.supplies,
          fileTypes: connector.fileTypes,
          howToExport: connector.howToExport,
        }))}
        agentsEnabled={workspace.agentsEnabled}
        budgetRemainingUsd={Math.max(0, workspace.agentBudgetUsd - workspace.agentSpendUsd)}
        provider={credentials.configured ? 'model' : 'local-heuristic'}
      />
    </div>
  )
}
