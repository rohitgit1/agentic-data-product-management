import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/db'
import { AGENTS, getAgent } from '@/lib/agents/registry'
import { STAGES, getStage } from '@/lib/lifecycle/stages'
import { AgentError, dispositionProposal, loadExternalMetadata } from '@/lib/agents/runtime'
import {
  cancelAgentRun,
  dispatchStage,
  isRunTerminal,
  loadRun,
  plannedAgentsForStage,
  startAgentRun,
  syncAgentRun,
  TERMINAL_RUN_STATES,
} from '@/lib/agents/orchestrator'
import {
  emptyExternalMetadata,
  scopeExternalMetadata,
} from '@/lib/integrations/schema'
import { parseCollibraJson } from '@/lib/integrations/parse'
import { blueprintArtifacts, commit, createFixture, createProduct } from './helpers/fixtures'

afterAll(async () => {
  await prisma.$disconnect()
})

async function runnableProduct() {
  const fixture = await createFixture({ agentsEnabled: true })
  const product = await createProduct(fixture, `run-${Date.now().toString(36)}`)
  const artifacts = blueprintArtifacts(fixture)
  await commit(fixture, product.id, 'decision-register', artifacts['decision-register'])
  return { fixture, product }
}

describe('every stage has a route an agent run can plan', () => {
  it('charters at least one drafting agent for all twelve stages', () => {
    for (const stage of STAGES) {
      const planned = plannedAgentsForStage(stage.number)
      expect(planned.length).toBeGreaterThan(0)
      const drafting = planned.filter((id) => id !== 'critic')
      expect(drafting.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('puts the Critic last on every stage, so it reviews what the others drafted', () => {
    for (const stage of STAGES) {
      const planned = plannedAgentsForStage(stage.number)
      if (planned.includes('critic')) expect(planned[planned.length - 1]).toBe('critic')
    }
  })

  it('plans only agents that exist and are permitted on that stage', () => {
    for (const stage of STAGES) {
      for (const agentId of plannedAgentsForStage(stage.number)) {
        const agent = getAgent(agentId)
        expect(agent).toBeDefined()
        expect(stage.permittedAgents).toContain(agentId)
        if (agent!.stages.length > 0) expect(agent!.stages).toContain(stage.number)
      }
    }
  })

  it('keeps the two new agents inside the same guardrails as the rest', () => {
    for (const id of ['charter', 'architecture']) {
      const agent = getAgent(id)!
      expect(agent.autonomyCeiling).not.toBe('L3')
      expect(agent.escalationRule.length).toBeGreaterThan(20)
      expect(agent.readScope.length).toBeGreaterThan(0)
      expect(agent.wantsSampleData).toBe(false)
    }
  })
})

describe('a run refuses to start when it should', () => {
  it('will not start with agents disabled for the workspace', async () => {
    const fixture = await createFixture({ agentsEnabled: false })
    const product = await createProduct(fixture, `off-${Date.now().toString(36)}`)
    await expect(
      startAgentRun({
        workspaceId: fixture.workspaceId,
        productId: product.id,
        userId: fixture.users.get('DATA_STEWARD')!,
        mode: 'AUTOMATED',
        modelId: 'claude-sonnet-5',
      }),
    ).rejects.toThrow(AgentError)
  })

  it('will not start on an unknown model', async () => {
    const { fixture, product } = await runnableProduct()
    await expect(
      startAgentRun({
        workspaceId: fixture.workspaceId,
        productId: product.id,
        userId: fixture.users.get('DATA_STEWARD')!,
        mode: 'AUTOMATED',
        modelId: 'gpt-nonexistent',
      }),
    ).rejects.toThrow(AgentError)
  })

  it('will not start a second run against a product that already has one open', async () => {
    const { fixture, product } = await runnableProduct()
    const input = {
      workspaceId: fixture.workspaceId,
      productId: product.id,
      userId: fixture.users.get('DATA_STEWARD')!,
      mode: 'MANUAL' as const,
      modelId: 'claude-sonnet-5',
    }
    await startAgentRun(input)
    await expect(startAgentRun(input)).rejects.toThrow(/already open/i)
  })

  it('refuses a consumer who holds no practitioner role', async () => {
    const { fixture, product } = await runnableProduct()
    await expect(
      startAgentRun({
        workspaceId: fixture.workspaceId,
        productId: product.id,
        userId: fixture.users.get('DATA_CONSUMER')!,
        mode: 'AUTOMATED',
        modelId: 'claude-sonnet-5',
      }),
    ).rejects.toThrow()
  })
})

describe('a run drafts, and stops', () => {
  it('plans the whole route up front, before anything is spent', async () => {
    const { fixture, product } = await runnableProduct()
    const runId = await startAgentRun({
      workspaceId: fixture.workspaceId,
      productId: product.id,
      userId: fixture.users.get('DATA_STEWARD')!,
      mode: 'MANUAL',
      modelId: 'claude-sonnet-5',
    })
    const run = await loadRun(runId)
    expect(run).not.toBeNull()

    let expected = 0
    for (let stage = run!.fromStage; stage <= run!.toStage; stage += 1) {
      expected += plannedAgentsForStage(stage).length
    }
    expect(run!.steps).toHaveLength(expected)
    // Nothing has run yet: a plan is not a dispatch.
    expect(run!.steps.every((step) => step.state === 'PENDING')).toBe(true)
    const actions = await prisma.agentAction.count({ where: { productId: product.id } })
    expect(actions).toBe(0)
  })

  it('halts at AWAITING_REVIEW once a stage has drafted, and approves nothing', async () => {
    const { fixture, product } = await runnableProduct()
    const userId = fixture.users.get('DATA_STEWARD')!
    const runId = await startAgentRun({
      workspaceId: fixture.workspaceId,
      productId: product.id,
      userId,
      mode: 'AUTOMATED',
      modelId: 'claude-sonnet-5',
    })
    const run = await syncAgentRun(runId, userId)

    expect(run.state).toBe('AWAITING_REVIEW')
    expect(run.currentStage).toBe(1)

    // It drafted something...
    const proposals = await prisma.agentProposal.count({
      where: { productId: product.id, stageNumber: 1 },
    })
    expect(proposals).toBeGreaterThan(0)

    // ...and every one of them is still pending a human.
    const pending = await prisma.agentProposal.count({
      where: { productId: product.id, stageNumber: 1, state: 'PENDING' },
    })
    expect(pending).toBe(proposals)

    // The run approved no gate and committed no version. This is the whole claim.
    const approvedGates = await prisma.gate.count({
      where: { productId: product.id, state: 'APPROVED' },
    })
    expect(approvedGates).toBe(0)
    const versions = await prisma.artifactVersion.count({
      where: { artifact: { productId: product.id, type: 'charter' } },
    })
    expect(versions).toBe(0)
  })

  it('does not advance past a stage whose gate no human has approved', async () => {
    const { fixture, product } = await runnableProduct()
    const userId = fixture.users.get('DATA_STEWARD')!
    const runId = await startAgentRun({
      workspaceId: fixture.workspaceId,
      productId: product.id,
      userId,
      mode: 'AUTOMATED',
      modelId: 'claude-sonnet-5',
    })

    await syncAgentRun(runId, userId)
    const again = await syncAgentRun(runId, userId)
    // Polling repeatedly must not walk the run forward on its own.
    expect(again.currentStage).toBe(1)
    expect(TERMINAL_RUN_STATES).not.toContain(again.state)

    const stage2Steps = again.steps.filter((step) => step.stageNumber === 2)
    expect(stage2Steps.length).toBeGreaterThan(0)
    expect(stage2Steps.every((step) => step.state === 'PENDING')).toBe(true)
  })

  it('dispatches nothing on its own in manual mode', async () => {
    const { fixture, product } = await runnableProduct()
    const userId = fixture.users.get('DATA_STEWARD')!
    const runId = await startAgentRun({
      workspaceId: fixture.workspaceId,
      productId: product.id,
      userId,
      mode: 'MANUAL',
      modelId: 'claude-sonnet-5',
    })
    const run = await syncAgentRun(runId, userId)
    expect(run.state).toBe('RUNNING')
    expect(run.steps.every((step) => step.state === 'PENDING')).toBe(true)
    expect(await prisma.agentAction.count({ where: { productId: product.id } })).toBe(0)

    // ...until a human dispatches the stage.
    await dispatchStage(runId, userId)
    const after = await loadRun(runId)
    expect(after!.steps.filter((step) => step.stageNumber === 1).some((s) => s.state === 'DRAFTED')).toBe(true)
  })

  it('records the run in the audit log under the human who started it', async () => {
    const { fixture, product } = await runnableProduct()
    const userId = fixture.users.get('DATA_STEWARD')!
    const runId = await startAgentRun({
      workspaceId: fixture.workspaceId,
      productId: product.id,
      userId,
      mode: 'AUTOMATED',
      modelId: 'claude-sonnet-5',
    })
    const event = await prisma.auditEvent.findFirst({
      where: { entityType: 'AgentRun', entityId: runId, action: 'agent.run_started' },
    })
    expect(event).not.toBeNull()
    expect(event!.actorId).toBe(userId)
  })

  it('attributes every dispatched action to the initiating human, never to the run', async () => {
    const { fixture, product } = await runnableProduct()
    const userId = fixture.users.get('DATA_STEWARD')!
    const runId = await startAgentRun({
      workspaceId: fixture.workspaceId,
      productId: product.id,
      userId,
      mode: 'AUTOMATED',
      modelId: 'claude-sonnet-5',
    })
    await syncAgentRun(runId, userId)
    const actions = await prisma.agentAction.findMany({ where: { productId: product.id } })
    expect(actions.length).toBeGreaterThan(0)
    for (const action of actions) {
      expect(action.initiatedById).toBe(userId)
      expect(action.disposition).toBe('PENDING')
      // The model the operator chose for the run is what the action records as configured.
      expect(action.configuredModel).toBe('claude-sonnet-5')
    }
  })
})

describe('cancelling a run', () => {
  it('stops dispatching without discarding drafts a human may still want', async () => {
    const { fixture, product } = await runnableProduct()
    const userId = fixture.users.get('DATA_STEWARD')!
    const runId = await startAgentRun({
      workspaceId: fixture.workspaceId,
      productId: product.id,
      userId,
      mode: 'AUTOMATED',
      modelId: 'claude-sonnet-5',
    })
    await syncAgentRun(runId, userId)
    const before = await prisma.agentProposal.count({ where: { productId: product.id } })
    expect(before).toBeGreaterThan(0)

    await cancelAgentRun(runId, userId, 'Changed my mind')
    const run = await loadRun(runId)
    expect(run!.state).toBe('CANCELLED')
    expect(isRunTerminal(run!.state)).toBe(true)

    const after = await prisma.agentProposal.count({ where: { productId: product.id } })
    expect(after).toBe(before)

    // A cancelled run is inert: syncing it dispatches nothing further.
    const synced = await syncAgentRun(runId, userId)
    expect(synced.state).toBe('CANCELLED')
    expect(await prisma.agentProposal.count({ where: { productId: product.id } })).toBe(before)
  })

  it('frees the product for a new run once cancelled', async () => {
    const { fixture, product } = await runnableProduct()
    const userId = fixture.users.get('DATA_STEWARD')!
    const input = {
      workspaceId: fixture.workspaceId,
      productId: product.id,
      userId,
      mode: 'MANUAL' as const,
      modelId: 'claude-sonnet-5',
    }
    const first = await startAgentRun(input)
    await cancelAgentRun(first, userId, 'done')
    const second = await startAgentRun(input)
    expect(second).not.toBe(first)
  })
})

describe('the console cannot become a back door', () => {
  it('exposes no orchestrator function that approves, commits or publishes', async () => {
    const orchestrator = await import('@/lib/agents/orchestrator')
    const names = Object.keys(orchestrator).join(' ').toLowerCase()
    for (const forbidden of ['approve', 'commit', 'publish', 'certif']) {
      expect(names).not.toContain(forbidden)
    }
  })

  it('never plans an agent whose ceiling would let it act unattended on a draft', () => {
    for (const stage of STAGES) {
      for (const agentId of plannedAgentsForStage(stage.number)) {
        const agent = AGENTS.find((a) => a.id === agentId)!
        // L3 is read-only monitoring and only ever produces findings.
        if (agent.autonomyCeiling === 'L3') expect(agent.outputType).toBe('FINDINGS')
      }
    }
  })

  it('keeps every stage completable with no agent at all', () => {
    for (const stage of STAGES) {
      // Exit criteria are functions of committed artifacts, never of agent participation.
      const source = getStage(stage.number).exitCriteria.toString()
      expect(source).not.toContain('agentAction')
      expect(source).not.toContain('plannedAgents')
    }
  })
})

describe('a scalar proposal can be dispositioned', () => {
  /**
   * Regression: the disposition path tested `'comment' in JSON.parse(value)`, which throws when a
   * proposal's value is a scalar rather than an object. Plenty are scalars — a grain statement, a
   * platform profile, a refresh strategy — so approving one crashed the render.
   */
  it('accepts a proposal whose value is a bare string', async () => {
    const { fixture, product } = await runnableProduct()
    const userId = fixture.users.get('DATA_STEWARD')!
    const runId = await startAgentRun({
      workspaceId: fixture.workspaceId,
      productId: product.id,
      userId,
      mode: 'AUTOMATED',
      modelId: 'claude-sonnet-5',
    })
    await syncAgentRun(runId, userId)

    const scalar = await prisma.agentProposal.create({
      data: {
        agentActionId: (await prisma.agentAction.findFirstOrThrow({ where: { productId: product.id } })).id,
        productId: product.id,
        stageNumber: 1,
        fieldPath: 'grainStatement',
        proposedValueJson: JSON.stringify('One row represents one account.'),
        rationale: 'Scalar value, not an object.',
        state: 'PENDING',
      },
    })

    const parsed = JSON.parse(scalar.proposedValueJson) as unknown
    // The guard the action now uses must not throw on this shape.
    expect(() => !!parsed && typeof parsed === 'object' && 'comment' in parsed).not.toThrow()

    await dispositionProposal({ proposalId: scalar.id, userId, action: 'ACCEPT' })
    const after = await prisma.agentProposal.findUniqueOrThrow({ where: { id: scalar.id } })
    expect(after.state).toBe('ACCEPTED')
    expect(after.dispositionById).toBe(userId)
  })
})

describe('catalogue and modelling context', () => {
  /**
   * Lineage is where physical Bronze and Silver names live. Invariant 7 says a grounding artifact
   * may reference only certified semantic objects, and the surest enforcement is that the agent
   * writing one never sees them.
   */
  it('never grants lineage to the Grounding agent', () => {
    const grounding = getAgent('grounding')!
    expect(grounding.externalScope ?? []).toEqual([])
    const withLineage = AGENTS.filter((a) => (a.externalScope ?? []).includes('lineage'))
    expect(withLineage.map((a) => a.id)).not.toContain('grounding')
    expect(withLineage.length).toBeGreaterThan(0)
  })

  it('grants lineage only to agents whose stage reasons about physical dependencies', () => {
    const withLineage = AGENTS.filter((a) => (a.externalScope ?? []).includes('lineage')).map((a) => a.id)
    expect(withLineage.sort()).toEqual(['architecture', 'critic', 'modelling', 'profiling'])
  })

  it('scopes lineage away from an agent that did not declare it', () => {
    const metadata = {
      ...emptyExternalMetadata(),
      sources: [{ name: 'src', system: '', description: '', owner: '', externalCertification: '', layer: 'UNKNOWN' as const }],
      lineage: [
        {
          from: 'bronze_meter_reads',
          to: 'silver_meter_reads',
          fromSystem: '',
          toSystem: '',
          transformation: 'dedupe',
          fromLayer: 'BRONZE' as const,
          toLayer: 'SILVER' as const,
        },
      ],
    }
    const forSemantic = scopeExternalMetadata(metadata, getAgent('semantic')!.externalScope!)
    expect(forSemantic.lineage).toBeUndefined()
    const forArchitecture = scopeExternalMetadata(metadata, getAgent('architecture')!.externalScope!)
    expect(forArchitecture.lineage).toHaveLength(1)
  })

  it('reads lineage from a Collibra export, from relations and from an edge list', () => {
    const fromRelations = parseCollibraJson(
      JSON.stringify([
        {
          name: 'silver_arrears',
          type: 'Table',
          relations: [{ target: 'bronze_billing', type: 'is sourced by', direction: 'source' }],
        },
      ]),
    )
    expect(fromRelations.lineage).toHaveLength(1)
    expect(fromRelations.lineage[0]!.from).toBe('bronze_billing')
    expect(fromRelations.lineage[0]!.to).toBe('silver_arrears')
    expect(fromRelations.lineage[0]!.fromLayer).toBe('BRONZE')
    expect(fromRelations.lineage[0]!.toLayer).toBe('SILVER')

    const fromEdges = parseCollibraJson(
      JSON.stringify({
        results: [{ name: 'gold_arrears_serving', type: 'Table' }],
        lineage: [{ from: 'silver_arrears', to: 'gold_arrears_serving', transformation: 'aggregate' }],
      }),
    )
    expect(fromEdges.lineage).toHaveLength(1)
    expect(fromEdges.lineage[0]!.transformation).toBe('aggregate')
  })

  it('records a hop once when the export describes it as both a relation and an edge', () => {
    const parsed = parseCollibraJson(
      JSON.stringify({
        results: [
          {
            name: 'gold_serving',
            type: 'Table',
            relations: [{ target: 'silver_core', type: 'is sourced by', direction: 'source' }],
          },
        ],
        lineage: [{ from: 'silver_core', to: 'gold_serving', transformation: 'aggregate' }],
      }),
    )
    expect(parsed.lineage).toHaveLength(1)
  })

  it('ignores a relation that does not describe data movement', () => {
    const parsed = parseCollibraJson(
      JSON.stringify([
        { name: 'silver_arrears', type: 'Table', relations: [{ target: 'Priya Raman', type: 'stewarded by' }] },
      ]),
    )
    expect(parsed.lineage).toHaveLength(0)
  })

  it('refuses to start a run asking for context nobody has attached', async () => {
    const { fixture, product } = await runnableProduct()
    await expect(
      startAgentRun({
        workspaceId: fixture.workspaceId,
        productId: product.id,
        userId: fixture.users.get('DATA_STEWARD')!,
        mode: 'AUTOMATED',
        modelId: 'claude-sonnet-5',
        contextSources: ['DATA_CATALOGUE'],
      }),
    ).rejects.toThrow(/Nothing has been imported/i)
  })

  it('records on the run which context sources the operator attached', async () => {
    const { fixture, product } = await runnableProduct()
    const userId = fixture.users.get('DATA_STEWARD')!
    await prisma.externalMetadataImport.create({
      data: {
        workspaceId: fixture.workspaceId,
        productId: product.id,
        connectorKey: 'collibra-json',
        fileName: 'collibra.json',
        contentHash: `h-${Date.now()}`,
        payloadJson: JSON.stringify(emptyExternalMetadata()),
        summary: 'test',
        importedById: userId,
      },
    })
    const runId = await startAgentRun({
      workspaceId: fixture.workspaceId,
      productId: product.id,
      userId,
      mode: 'MANUAL',
      modelId: 'claude-sonnet-5',
      contextSources: ['DATA_CATALOGUE'],
    })
    const run = await loadRun(runId)
    expect(run!.contextSources).toEqual(['DATA_CATALOGUE'])
  })

  it('keeps catalogue metadata out of a run that did not ask for it', async () => {
    const { fixture, product } = await runnableProduct()
    const userId = fixture.users.get('DATA_STEWARD')!
    const catalogue = {
      ...emptyExternalMetadata(),
      sources: [
        {
          name: 'catalogue_only_source',
          system: 'Collibra',
          description: '',
          owner: '',
          externalCertification: '',
          layer: 'UNKNOWN' as const,
        },
      ],
    }
    await prisma.externalMetadataImport.create({
      data: {
        workspaceId: fixture.workspaceId,
        productId: product.id,
        connectorKey: 'collibra-json',
        fileName: 'collibra.json',
        contentHash: `h2-${Date.now()}`,
        payloadJson: JSON.stringify(catalogue),
        summary: 'test',
        importedById: userId,
      },
    })

    // Everything on disk, when nothing is filtered.
    const everything = await loadExternalMetadata(product.id)
    expect(everything.sources.map((s) => s.name)).toContain('catalogue_only_source')

    // A run that asked only for modelling context must not receive the catalogue.
    const modellingOnly = await loadExternalMetadata(product.id, ['DATA_MODELLING'])
    expect(modellingOnly.sources).toHaveLength(0)

    // A run that asked for nothing receives nothing.
    const none = await loadExternalMetadata(product.id, [])
    expect(none.sources).toHaveLength(0)
  })
})
