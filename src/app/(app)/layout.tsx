import Link from 'next/link'
import { BrandMark, BrandWordmark } from '@/components/brand'
import { MainNav } from '@/components/nav'
import { TourOverlay } from '@/components/tour'
import { WorkspaceSwitcher } from '@/components/workspace-switcher'
import { GUIDED_TOURS } from '@/lib/guides/registry'
import { requireSession, listWorkspacesForUser } from '@/lib/auth/session'
import { roleName } from '@/lib/domain/roles'
import { Badge } from '@/components/ui'
import { endSession } from './actions'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession()
  const workspaces = await listWorkspacesForUser(session.userId)

  return (
    <div className="min-h-screen">
      {/*
        The top layer carries the brand: deep brand blue behind the identity row and the nav, closed
        by the Capgemini Blue → Vibrant Blue rule. Everything below it stays light, so the chrome
        frames the work rather than competing with it.
      */}
      <header className="brand-bar bg-brand-900">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-3 rounded-md">
              <BrandMark />
              <BrandWordmark onDark />
            </Link>
            <Badge tone="info" title="Agents act. Humans decide.">
              Supervised autonomy
            </Badge>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <WorkspaceSwitcher
              workspaces={workspaces.map((workspace) => ({
                id: workspace.id,
                slug: workspace.slug,
                name: workspace.name,
              }))}
              activeSlug={session.workspaceSlug}
            />
            <span className="text-white">
              {session.userName}
              <span className="ml-1 text-xs text-brand-300">
                ({session.roles.map(roleName).join(', ')})
              </span>
            </span>
            <form action={endSession}>
              <button
                type="submit"
                className="rounded-md border border-brand-700 bg-brand-850 px-2.5 py-1 text-xs font-medium text-brand-100 hover:bg-brand-800"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
        <MainNav door={session.door} />
      </header>

      <main id="main">{children}</main>

      <TourOverlay tours={GUIDED_TOURS} />
    </div>
  )
}
