'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { clsx } from 'clsx'

/**
 * Eleven tabs in five groups. The groups are the three front doors plus enablement and run —
 * consumer, practitioner and leadership navigation are never blended into one list.
 */

export const NAV_GROUPS: { group: string; items: { href: string; label: string; hint: string }[] }[] = [
  {
    group: 'Consume',
    items: [
      { href: '/marketplace', label: 'Marketplace', hint: 'Browse published data products' },
      { href: '/request', label: 'Request', hint: 'Describe a decision you cannot make today' },
    ],
  },
  {
    group: 'Build',
    items: [
      { href: '/inbox', label: 'My Work', hint: 'Approvals, reviews and agent proposals' },
      { href: '/products', label: 'Lifecycle Studio', hint: 'The 12-stage workbench' },
    ],
  },
  {
    group: 'Lead',
    items: [{ href: '/portfolio', label: 'Portfolio', hint: 'Pipeline, cost, adoption and value' }],
  },
  {
    group: 'Enable',
    items: [
      { href: '/patterns', label: 'Consumption Patterns', hint: 'The eight ways a product is used' },
      { href: '/run-console', label: 'Agent Run Console', hint: 'Dispatch agents across the 12 stages, automated or manual' },
      { href: '/agents', label: 'Agents', hint: 'Charters, autonomy, supervision and cost' },
      { href: '/academy', label: 'Academy', hint: 'How data products work here' },
      {
        href: '/data-model',
        label: 'Data Model',
        hint: 'The tables, relationships and enumerations the application itself runs on',
      },
    ],
  },
  {
    group: 'Run',
    items: [{ href: '/admin', label: 'Admin', hint: 'Packs, roles, controls and configuration' }],
  },
]

export function MainNav() {
  const pathname = usePathname()
  return (
    <nav aria-label="Main" className="flex flex-wrap items-center gap-x-6 gap-y-2">
      {NAV_GROUPS.map((group) => (
        <div key={group.group} className="flex items-center gap-1">
          <span className="mr-1 text-[10px] font-semibold uppercase tracking-wider text-brand-300">
            {group.group}
          </span>
          {group.items.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
            return (
              <Link
                key={item.href}
                href={item.href}
                title={item.hint}
                aria-current={active ? 'page' : undefined}
                className={clsx(
                  'rounded-md px-2.5 py-1.5 text-sm font-medium transition',
                  // Active is the vibrant blue: it reads as a component against the deep bar at
                  // 5.5:1, and carries deep-blue text at 5.5:1 in turn.
                  active
                    ? 'bg-brand-400 text-brand-900'
                    : 'text-brand-200 hover:bg-white/10 hover:text-white',
                )}
              >
                {item.label}
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
