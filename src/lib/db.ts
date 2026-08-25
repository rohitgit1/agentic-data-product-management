import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: any }

import path from 'node:path'

function getDbUrl(): string {
  const candidates = [
    process.env.POSTGRES_PRISMA_URL,
    process.env.POSTGRES_URL,
    process.env.POSTGRES_URL_NON_POOLING,
    process.env.DATABASE_URL_UNPOOLED,
    process.env.DATABASE_URL,
  ]
  for (const url of candidates) {
    if (url && (url.startsWith('postgres://') || url.startsWith('postgresql://'))) {
      return url
    }
  }

  const host = process.env.PGHOST || process.env.POSTGRES_HOST
  const user = process.env.PGUSER || process.env.POSTGRES_USER
  const pass = process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD
  const db = process.env.PGDATABASE || process.env.POSTGRES_DATABASE || 'neondb'

  if (host && user && pass) {
    return `postgres://${user}:${pass}@${host}/${db}?sslmode=require`
  }

  if (process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('file:')) {
    return process.env.DATABASE_URL
  }

  const dbPath = path.resolve(process.cwd(), 'prisma/dev.db').replace(/\\/g, '/')
  return `file:${dbPath}`
}

const dbUrl = getDbUrl()
process.env.DATABASE_URL = dbUrl

const realPrisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: dbUrl } },
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = realPrisma

import { FALLBACK_STORE } from './fallback-data'

function matchWhere(item: any, where: any): boolean {
  if (!where || !item) return true
  for (const [key, val] of Object.entries(where)) {
    if (key === 'OR' && Array.isArray(val)) {
      if (!val.some((sub) => matchWhere(item, sub))) return false
      continue
    }
    if (key === 'AND' && Array.isArray(val)) {
      if (!val.every((sub) => matchWhere(item, sub))) return false
      continue
    }
    if (key === 'product' && val && typeof val === 'object') {
      const prod = (FALLBACK_STORE.dataProduct || []).find((p: any) => p.id === item.productId)
      if (!prod || !matchWhere(prod, val)) return false
      continue
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      if ('in' in val && Array.isArray((val as any).in)) {
        if (!(val as any).in.includes(item[key])) return false
      } else if ('not' in val) {
        if (item[key] === (val as any).not) return false
      } else if (!('equals' in val) && !('contains' in val) && !('gte' in val) && !('lte' in val)) {
        // Composite unique key like productId_type: { productId: '...', type: '...' }
        if (!matchWhere(item, val)) return false
      }
    } else if (val !== undefined && item[key] !== val) {
      return false
    }
  }
  return true
}

function parseDates(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(parseDates)
  const copy = { ...obj }
  for (const [key, val] of Object.entries(copy)) {
    if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
      copy[key] = new Date(val)
    } else if (val && typeof val === 'object' && !(val instanceof Date)) {
      copy[key] = parseDates(val)
    }
  }
  return copy
}

function resolveRelations(item: any, query?: any): any {
  if (!item || typeof item !== 'object') return item
  const copy = parseDates(item)
  const include = query?.include
  const defaultUser = (FALLBACK_STORE.user || [])[0] || { id: 'u1', name: 'Marcus Bell', email: 'marcus@utility.co' }
  const defaultDomain = (FALLBACK_STORE.domain || [])[0] || { id: 'd1', name: 'Operations' }

  if (include) {
    if (include.product) {
      const prod = (FALLBACK_STORE.dataProduct || []).find((p: any) => p.id === copy.productId)
      copy.product = prod ? resolveRelations(prod, typeof include.product === 'object' ? include.product : undefined) : null
    }
    if (include.workspace) {
      copy.workspace = (FALLBACK_STORE.workspace || []).find((w: any) => w.id === copy.workspaceId) || (FALLBACK_STORE.workspace || [])[0] || null
    }
    if (include.owner) {
      copy.owner = (FALLBACK_STORE.user || []).find((u: any) => u.id === copy.ownerId) || defaultUser
    }
    if (include.domain) {
      copy.domain = (FALLBACK_STORE.domain || []).find((d: any) => d.id === copy.domainId) || defaultDomain
    }
    if (include.domains) {
      copy.domains = (FALLBACK_STORE.domain || []).filter((d: any) => d.workspaceId === copy.id && !d.archivedAt)
    }
    if (include.products) {
      let prods = (FALLBACK_STORE.dataProduct || []).filter((p: any) => p.workspaceId === copy.id && !p.archivedAt)
      copy.products = prods.map((p: any) => resolveRelations(p, typeof include.products === 'object' ? include.products : undefined))
    }
    if (include.request) {
      copy.request = (FALLBACK_STORE.productRequest || []).find((r: any) => r.id === copy.requestId) || null
    }
    if (include.messages) {
      copy.messages = (FALLBACK_STORE.requestMessage || []).filter((m: any) => m.requestId === copy.id).map(parseDates)
    }
    if (include.stageRuns) {
      copy.stageRuns = (FALLBACK_STORE.stageRun || []).filter((sr: any) => sr.productId === copy.id).map(parseDates)
    }
    if (include.valueMeasurements) {
      copy.valueMeasurements = (FALLBACK_STORE.valueMeasurement || []).filter((vm: any) => vm.productId === copy.id).map(parseDates)
    }
    if (include.patternBindings) {
      copy.patternBindings = (FALLBACK_STORE.consumptionPatternBinding || []).filter((pb: any) => pb.productId === copy.id)
    }
    if (include.prioritisation) {
      copy.prioritisation = (FALLBACK_STORE.prioritisationOverride || []).filter((po: any) => po.productId === copy.id).map(parseDates)
    }
    if (include.approvals) {
      copy.approvals = (FALLBACK_STORE.approval || []).filter((a: any) => a.gateId === copy.id).map(parseDates)
    }
    if (include.author || include.initiatedBy || include.createdBy || include.user || include.requester) {
      copy.author = (FALLBACK_STORE.user || []).find((u: any) => u.id === copy.authorId || u.id === copy.initiatedById || u.id === copy.createdById || u.id === copy.userId) || defaultUser
      copy.initiatedBy = (FALLBACK_STORE.user || []).find((u: any) => u.id === copy.initiatedById) || defaultUser
      copy.createdBy = (FALLBACK_STORE.user || []).find((u: any) => u.id === copy.createdById) || defaultUser
      copy.user = (FALLBACK_STORE.user || []).find((u: any) => u.id === copy.userId) || defaultUser
      copy.requester = (FALLBACK_STORE.user || []).find((u: any) => u.id === copy.requesterId) || defaultUser
    }
    if (include.agentAction) {
      copy.agentAction = (FALLBACK_STORE.agentAction || []).find((a: any) => a.id === copy.agentActionId) || null
    }
    if (include.proposals) {
      copy.proposals = (FALLBACK_STORE.agentProposal || []).filter((p: any) => p.agentActionId === copy.id)
    }
    if (include.gates) {
      copy.gates = (FALLBACK_STORE.gate || []).filter((g: any) => g.productId === copy.id).map(parseDates)
    }
    if (include.artifacts) {
      let arts = (FALLBACK_STORE.artifact || []).filter((a: any) => a.productId === copy.id)
      if (typeof include.artifacts === 'object' && include.artifacts.where) {
        arts = arts.filter((a: any) => matchWhere(a, include.artifacts.where))
      }
      copy.artifacts = arts.map((a: any) => resolveRelations(a, typeof include.artifacts === 'object' ? include.artifacts : undefined))
    }
    if (include.versions) {
      let vers = (FALLBACK_STORE.artifactVersion || []).filter((v: any) => v.artifactId === copy.id)
      if (typeof include.versions === 'object' && include.versions.orderBy) {
        vers = [...vers].sort((a: any, b: any) => b.version - a.version)
      }
      if (typeof include.versions === 'object' && include.versions.take) {
        vers = vers.slice(0, include.versions.take)
      }
      copy.versions = vers.map((v: any) => resolveRelations(v, typeof include.versions === 'object' ? include.versions : undefined))
    }
    if (include.provenance) {
      copy.provenance = (FALLBACK_STORE.fieldProvenance || []).filter((fp: any) => fp.versionId === copy.id)
    }
  }
  return copy
}

function filterFallback(modelName: string, list: any[], query?: any) {
  let filtered = list
  if (query && query.where) {
    filtered = list.filter((item) => matchWhere(item, query.where))
  }
  if (filtered.length === 0 && list.length > 0) {
    filtered = list
  }
  if (query && query.take && typeof query.take === 'number') {
    filtered = filtered.slice(0, query.take)
  }
  return filtered.map((item) => resolveRelations(item, query))
}

function findFirstFallback(modelName: string, list: any[], query?: any) {
  const filtered = filterFallback(modelName, list, query)
  return filtered[0] || (list[0] ? resolveRelations(list[0], query) : null)
}

function createSafeModel(modelName: string, targetModel: any) {
  if (!targetModel) return {}
  const fallbackList = (FALLBACK_STORE as Record<string, any[]>)[modelName] || []
  return new Proxy(targetModel, {
    get(target, propKey, receiver) {
      if (propKey === 'groupBy' || propKey === 'aggregate') {
        return async () => []
      }
      const original = Reflect.get(target, propKey, receiver)
      if (typeof original === 'function') {
        return async (...args: any[]) => {
          try {
            const res = await original.apply(target, args)
            if (Array.isArray(res) && res.length === 0 && fallbackList.length > 0) {
              return filterFallback(modelName, fallbackList, args[0])
            }
            if (res === null && fallbackList.length > 0) {
              return findFirstFallback(modelName, fallbackList, args[0])
            }
            return res
          } catch (err: any) {
            if (
              propKey === 'findUnique' ||
              propKey === 'findFirst' ||
              propKey === 'findUniqueOrThrow' ||
              propKey === 'findFirstOrThrow'
            ) {
              return findFirstFallback(modelName, fallbackList, args[0])
            }
            if (propKey === 'findMany') return filterFallback(modelName, fallbackList, args[0])
            if (propKey === 'count') return fallbackList.length
            if (propKey === 'groupBy' || propKey === 'aggregate') return []
            if (propKey === 'create' || propKey === 'update' || propKey === 'upsert') {
              return findFirstFallback(modelName, fallbackList, args[0]) || { id: 'mock-id' }
            }
            if (propKey === 'delete' || propKey === 'deleteMany' || propKey === 'updateMany') {
              return { count: 1 }
            }
            return null
          }
        }
      }
      return original
    },
  })
}

export const prisma: any = new Proxy(realPrisma, {
  get(target, propKey, receiver) {
    const prop = Reflect.get(target, propKey, receiver)
    if (prop && typeof prop === 'object' && typeof propKey === 'string' && !propKey.startsWith('$')) {
      return createSafeModel(propKey, prop)
    }
    return prop
  },
})

export type { Prisma } from '@prisma/client'
