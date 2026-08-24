import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requireSession } from '@/lib/auth/session'
import { ROLES } from '@/lib/domain/roles'
import { STANDARDS_ADAPTERS } from '@/lib/standards'
import { validatePack } from '@/lib/packs/schema'
import { credentialStatus } from '@/lib/secrets'
import { Badge, Card, CardBody, CardHeader, Callout, LinkButton, PageHeader } from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  const session = await requireSession()

  let workspace: any = { id: session.workspaceId, name: session.workspaceName, packKey: session.packKey }
  try {
    const dbWs = await prisma.workspace.findUnique({ where: { id: session.workspaceId } })
    if (dbWs) workspace = dbWs
  } catch (err) {
    console.warn('Workspace fetch warning on Admin page:', err)
  }

  let packRow = null
  try {
    packRow = await prisma.pack.findUnique({ where: { key: workspace.packKey } })
  } catch (err) {
    console.warn('Pack fetch warning on Admin page:', err)
  }

  const pack = packRow ? validatePack(JSON.parse(packRow.contentJson)) : undefined

  let assignments: any[] = []
  try {
    assignments = await prisma.roleAssignment.findMany({
      where: { workspaceId: session.workspaceId },
      include: { user: true, role: true },
      orderBy: { role: { sortOrder: 'asc' } },
    })
  } catch (err) {
    console.warn('Role assignments fetch warning on Admin page:', err)
  }

  const credentials = await credentialStatus()

  let packs: any[] = []
  try {
    packs = await prisma.pack.findMany({ orderBy: { name: 'asc' } })
  } catch (err) {
    console.warn('Packs list fetch warning on Admin page:', err)
  }

  return (
    <div>
      <PageHeader
        eyebrow="Run"
        title="Admin"
        description={`Packs, roles, controls, standards and configuration for ${workspace.name}.`}
      />

      <Callout tone="warn" title="Packs are illustrative and editable, not authoritative.">
        <p>
          Pack content — domains, controls, metrics, blueprints — is a starting point for a
          conversation with your own regulatory and domain experts. It is not legal advice, and it is
          not a compliance certification.
        </p>
      </Callout>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Installed packs"
            description="Industry logic lives here, never in application code."
          />
          <CardBody>
            <ul className="space-y-2 text-sm">
              {packs.map((entry: any) => (
                <li key={entry.id} className="flex items-center justify-between gap-2">
                  <span>
                    <span className="font-medium text-ink-900">{entry.name}</span>{' '}
                    <span className="text-xs text-ink-500">
                      v{entry.version} · {entry.sourcePath}
                    </span>
                  </span>
                  {entry.key === workspace.packKey ? <Badge tone="good">active</Badge> : null}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-600">
              Validate every pack with <code className="rounded bg-ink-100 px-1">pnpm pack:validate</code>.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Role assignment" description="Roles are per workspace and enforced server-side." />
          <CardBody className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-5 py-2">Role</th>
                  <th className="px-3 py-2">Assigned to</th>
                  <th className="px-5 py-2">Door</th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((assignment: any) => (
                  <tr key={assignment.id} className="border-t border-ink-100">
                    <td className="px-5 py-2 text-ink-800">{assignment.role?.name || 'Role'}</td>
                    <td className="px-3 py-2 text-ink-700">{assignment.user?.name || 'User'}</td>
                    <td className="px-5 py-2 text-xs text-ink-500">{assignment.role?.door || 'PRACTITIONER'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Control and regulatory library"
            description={pack ? `${pack.controls.length} controls from ${pack.name}` : 'No pack loaded'}
          />
          <CardBody>
            <ul className="space-y-2 text-sm">
              {pack?.controls.map((control: any) => (
                <li key={control.key}>
                  <span className="font-medium text-ink-900">{control.name}</span>{' '}
                  <span className="text-xs text-ink-500">({control.key})</span>
                  <p className="mt-0.5 text-xs text-ink-600">{control.body}</p>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Role catalog"
            description={`${ROLES.length} canonical roles. Veto rights live in the stage registry.`}
          />
          <CardBody>
            <ul className="space-y-2 text-sm">
              {ROLES.map((role: any) => (
                <li key={role.key} className="flex items-center justify-between gap-2">
                  <span>
                    <span className="font-medium text-ink-900">{role.name}</span>{' '}
                    <span className="text-xs text-ink-500">({role.key})</span>
                  </span>
                  <Badge tone={role.door === 'PRACTITIONER' ? 'info' : 'neutral'}>{role.door}</Badge>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Standards Adapters"
            description="Open standards mapped to the stage lifecycle"
          />
          <CardBody>
            <ul className="space-y-2 text-sm">
              {STANDARDS_ADAPTERS.map((adapter: any) => (
                <li key={adapter.name}>
                  <span className="font-medium text-ink-900">{adapter.name}</span>{' '}
                  <span className="text-xs text-ink-500">({adapter.standard})</span>
                  <p className="mt-0.5 text-xs text-ink-600">{adapter.description}</p>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Secret & Integration Status" description="Configured API keys and secrets" />
          <CardBody>
            <div className="flex items-center justify-between gap-2 text-sm">
              <span>
                <span className="font-medium text-ink-900">Anthropic API Key</span>{' '}
                <code className="text-xs text-ink-500">{credentials.hint ?? 'Not set'}</code>
              </span>
              <Badge tone={credentials.configured ? 'good' : 'warn'}>
                {credentials.configured ? 'configured' : 'missing'}
              </Badge>
            </div>
          </CardBody>
        </Card>
      </div>

      <div className="mt-6 flex justify-end">
        <LinkButton href="/run-console">Open Run Console &rarr;</LinkButton>
      </div>
    </div>
  )
}
