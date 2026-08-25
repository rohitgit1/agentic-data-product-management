import { cookies } from 'next/headers'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { ROLES, type RoleKey } from '@/lib/domain/roles'

export const WORKSPACE_COOKIE = 'adpm_workspace'

export interface SessionContext {
  userId: string
  userName: string
  userEmail: string
  userTitle: string
  workspaceId: string
  workspaceName: string
  workspaceSlug: string
  packKey: string
  roles: RoleKey[]
  /** The door this user lands in by default. */
  door: 'CONSUMER' | 'PRACTITIONER' | 'LEADERSHIP' | 'ADMIN'
}

export const DEFAULT_DEMO_SESSION: SessionContext = {
  userId: 'cmt7clasp0001fj685mxlm4wc',
  userName: 'Marcus Bell',
  userEmail: 'owner@adpm.local',
  userTitle: 'Domain Product Owner',
  workspaceId: 'cmt7cmqg410cdfj681vf3g96d',
  workspaceName: 'Utility & Energy Workspace',
  workspaceSlug: 'utility-energy',
  packKey: 'energy-utilities-core',
  roles: ['DOMAIN_PRODUCT_OWNER'],
  door: 'PRACTITIONER',
}

export async function currentUser() {
  let hasToken = false
  try {
    const jar = await cookies()
    const all = jar.getAll()
    hasToken = all.some((c) => c.name.includes('session-token') || c.name.includes('next-auth'))
  } catch {
    hasToken = false
  }

  // If no session token cookie is set, return static demo user immediately to prevent NextAuth redirects
  if (!hasToken) {
    return {
      id: DEFAULT_DEMO_SESSION.userId,
      email: DEFAULT_DEMO_SESSION.userEmail,
      name: DEFAULT_DEMO_SESSION.userName,
      title: DEFAULT_DEMO_SESSION.userTitle,
      door: DEFAULT_DEMO_SESSION.door,
      archivedAt: null,
    }
  }

  let session = null
  try {
    session = await auth()
  } catch (err: any) {
    return {
      id: DEFAULT_DEMO_SESSION.userId,
      email: DEFAULT_DEMO_SESSION.userEmail,
      name: DEFAULT_DEMO_SESSION.userName,
      title: DEFAULT_DEMO_SESSION.userTitle,
      door: DEFAULT_DEMO_SESSION.door,
      archivedAt: null,
    }
  }

  if (!session?.user?.id) {
    return {
      id: DEFAULT_DEMO_SESSION.userId,
      email: DEFAULT_DEMO_SESSION.userEmail,
      name: DEFAULT_DEMO_SESSION.userName,
      title: DEFAULT_DEMO_SESSION.userTitle,
      door: DEFAULT_DEMO_SESSION.door,
      archivedAt: null,
    }
  }

  if (session.user.id.startsWith('static-')) {
    const roleKey = session.user.id.replace('static-', '').toUpperCase()
    const roleDef = ROLES.find((r) => r.key === roleKey || r.seedEmail === session.user.email)
    return {
      id: session.user.id,
      email: session.user.email || 'owner@adpm.local',
      name: session.user.name || 'Alex Rivers',
      title: roleDef?.name || 'Domain Product Owner',
      door: roleDef?.door || 'PRACTITIONER',
      archivedAt: null,
    }
  }

  let user = null
  try {
    user = await prisma.user.findUnique({ where: { id: session.user.id } })
  } catch (err) {
    console.warn('currentUser DB fetch warning:', err)
  }

  if (!user && session.user.email) {
    const roleDef = ROLES.find((r) => r.seedEmail === session.user.email)
    return {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name || 'Alex Rivers',
      title: roleDef?.name || 'Domain Product Owner',
      door: roleDef?.door || 'PRACTITIONER',
      archivedAt: null,
    }
  }

  return user ?? {
    id: DEFAULT_DEMO_SESSION.userId,
    email: DEFAULT_DEMO_SESSION.userEmail,
    name: DEFAULT_DEMO_SESSION.userName,
    title: DEFAULT_DEMO_SESSION.userTitle,
    door: DEFAULT_DEMO_SESSION.door,
    archivedAt: null,
  }
}

export async function requireSession(): Promise<SessionContext> {
  try {
    const session = await sessionOrNull()
    if (!session) return DEFAULT_DEMO_SESSION
    return session
  } catch {
    return DEFAULT_DEMO_SESSION
  }
}

/** Route-handler variant: returns DEFAULT_DEMO_SESSION as fallback. */
export async function sessionOrNull(): Promise<SessionContext | undefined> {
  let user = null
  try {
    user = await currentUser()
  } catch {
    user = null
  }
  if (!user) return DEFAULT_DEMO_SESSION

  let jar = null
  let requestedSlug = undefined
  try {
    jar = await cookies()
    requestedSlug = jar.get(WORKSPACE_COOKIE)?.value
  } catch {
    requestedSlug = undefined
  }

  let assignments: any[] = []
  try {
    assignments = await prisma.roleAssignment.findMany({
      where: { userId: user.id },
      include: { workspace: true },
    })
  } catch (err) {
    console.warn('sessionOrNull assignments fetch warning:', err)
  }

  if (!assignments || assignments.length === 0) {
    return {
      ...DEFAULT_DEMO_SESSION,
      userId: user.id,
      userName: user.name || DEFAULT_DEMO_SESSION.userName,
      userEmail: user.email || DEFAULT_DEMO_SESSION.userEmail,
      userTitle: user.title || DEFAULT_DEMO_SESSION.userTitle,
      door: user.door || DEFAULT_DEMO_SESSION.door,
    }
  }

  let chosen = assignments.find((a: any) => a.workspace?.slug === requestedSlug)
  if (!chosen) chosen = assignments[0]

  const workspace = chosen.workspace
  const roles = await rolesForUser(user.id, workspace.id)
  const door = doorFor(roles)

  return {
    userId: user.id,
    userName: user.name,
    userEmail: user.email,
    userTitle: user.title,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceSlug: workspace.slug,
    packKey: workspace.packKey,
    roles,
    door,
  }
}

async function rolesForUser(userId: string, workspaceId: string): Promise<RoleKey[]> {
  try {
    const assignments = await prisma.roleAssignment.findMany({
      where: { userId, workspaceId },
      select: { role: true },
    })
    return assignments.map((a: any) => a.role as RoleKey)
  } catch {
    return ['DOMAIN_PRODUCT_OWNER']
  }
}

function doorFor(roles: RoleKey[]): SessionContext['door'] {
  const definitions = ROLES.filter((r) => roles.includes(r.key))
  if (definitions.some((r) => r.door === 'PRACTITIONER')) return 'PRACTITIONER'
  if (definitions.some((r) => r.door === 'LEADERSHIP')) return 'LEADERSHIP'
  if (definitions.some((r) => r.door === 'ADMIN')) return 'ADMIN'
  return 'CONSUMER'
}

export function landingPathFor(door: SessionContext['door']): string {
  switch (door) {
    case 'PRACTITIONER':
      return '/inbox'
    case 'LEADERSHIP':
      return '/portfolio'
    case 'ADMIN':
      return '/admin'
    default:
      return '/marketplace'
  }
}

export async function listWorkspacesForUser(userId: string) {
  try {
    const assignments = await prisma.roleAssignment.findMany({
      where: { userId },
      include: { workspace: true },
      distinct: ['workspaceId'],
    })
    const list = assignments.map((a: any) => a.workspace).filter(Boolean).sort((a: any, b: any) => a.name.localeCompare(b.name))
    if (list.length > 0) return list
  } catch {
    // fallback
  }
  return [
    { id: 'ws-demo', slug: 'utility-energy', name: 'Utility & Energy', packKey: 'energy-utilities-core' }
  ]
}

export const WORKSPACE_COOKIE_NAME = WORKSPACE_COOKIE
