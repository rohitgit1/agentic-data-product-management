import { requireSession, landingPathFor } from '@/lib/auth/session'
import { LinkButton } from '@/components/ui'

export const dynamic = 'force-dynamic'

const COMMITMENTS = [
  {
    title: 'Consumption-first, not pipeline-first',
    body: 'The entry point is a blocked decision, never a source system. Architecture is the answer to a consumption question, not the question itself.',
  },
  {
    title: 'Supervised autonomy',
    body: 'Agents act; humans decide. Maximum agent leverage, zero unaccountable decisions. The gate is the unit of accountability.',
  },
  {
    title: 'One metric, one definition, one answer',
    body: 'A metric defined once and enforced identically across dashboards, self-serve, conversation, agents and APIs.',
  },
  {
    title: 'Evidence, not assertion',
    body: 'Certification cites artifact versions and approvals. Trust is demonstrated, not badged.',
  },
  {
    title: 'Value closes the loop',
    body: 'A value hypothesis at charter, measured at operate. Products that never returned value are visible in the portfolio, not quietly forgotten.',
  },
]

const DOORS = [
  {
    name: 'I need an answer',
    who: 'Business user, analyst, executive',
    href: '/marketplace',
    body: 'Search the marketplace. If nothing answers your question, describe the decision you cannot make today.',
  },
  {
    name: 'I build data products',
    who: 'Product owner, steward, SME, architect, engineer, privacy officer',
    href: '/inbox',
    body: 'Your inbox: approvals pending on you, stages you own, comments awaiting reply and agent proposals to disposition.',
  },
  {
    name: 'I run the portfolio',
    who: 'CDO, domain lead, programme director',
    href: '/portfolio',
    body: 'What are we building, why in that order, what did the last ten cost, and what did they return?',
  },
]

export default async function LandingPage() {
  const session = await requireSession()

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <p className="text-xs font-semibold uppercase tracking-wide text-accent-600">
        {session.workspaceName}
      </p>
      <h1 className="mt-2 text-3xl font-semibold text-ink-900">
        Agentic Data Product Management
      </h1>
      <p className="mt-2 max-w-2xl text-base text-ink-600">
        Manage the full lifecycle of data products — agents do the work, humans make every
        decision.
      </p>

      <h2 className="mt-10 text-lg font-semibold text-ink-900">Core Commitments</h2>
      <ol className="mt-4 grid gap-4 sm:grid-cols-2">
        {COMMITMENTS.map((commitment, index) => (
          <li key={commitment.title} className="rounded-lg border border-ink-200 bg-white p-4">
            <p className="text-sm font-semibold text-ink-900">
              <span className="mr-2 text-accent-600">{index + 1}.</span>
              {commitment.title}
            </p>
            <p className="mt-1 text-sm text-ink-600">{commitment.body}</p>
          </li>
        ))}
      </ol>

      <h2 className="mt-10 text-lg font-semibold text-ink-900">Three front doors</h2>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        {DOORS.map((door) => (
          <div key={door.name} className="flex flex-col rounded-lg border border-ink-200 bg-white p-5">
            <p className="text-sm font-semibold text-ink-900">{door.name}</p>
            <p className="mt-1 text-xs uppercase tracking-wide text-ink-500">{door.who}</p>
            <p className="mt-2 flex-1 text-sm text-ink-600">{door.body}</p>
            <LinkButton href={door.href} className="mt-4 self-start">
              Enter
            </LinkButton>
          </div>
        ))}
      </div>

      <div className="mt-10 flex flex-wrap gap-3">
        <LinkButton href={landingPathFor(session.door)} variant="primary">
          Go to my default door
        </LinkButton>
        <LinkButton href="/academy">Start with the Academy</LinkButton>
      </div>
    </div>
  )
}
