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
  if (!where) return true
  for (const [key, val] of Object.entries(where)) {
    if (key === 'OR' && Array.isArray(val)) {
      if (!val.some((sub) => matchWhere(item, sub))) return false
      continue
    }
    if (key === 'AND' && Array.isArray(val)) {
      if (!val.every((sub) => matchWhere(item, sub))) return false
      continue
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      if ('in' in val && Array.isArray((val as any).in)) {
        if (!(val as any).in.includes(item[key])) return false
      } else if ('not' in val) {
        if (item[key] === (val as any).not) return false
      }
    } else if (val !== undefined && item[key] !== val) {
      return false
    }
  }
  return true
}

function filterFallback(modelName: string, list: any[], query?: any) {
  if (!query || !query.where) return list
  return list.filter((item) => matchWhere(item, query.where))
}

function findFirstFallback(modelName: string, list: any[], query?: any) {
  const filtered = filterFallback(modelName, list, query)
  return filtered[0] || list[0] || null
}

function createSafeModel(modelName: string, targetModel: any) {
  if (!targetModel) return {}
  const fallbackList = (FALLBACK_STORE as Record<string, any[]>)[modelName] || []
  return new Proxy(targetModel, {
    get(target, propKey, receiver) {
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
            if (propKey === 'findMany') return filterFallback(modelName, fallbackList, args[0])
            if (propKey === 'findUnique' || propKey === 'findFirst') return findFirstFallback(modelName, fallbackList, args[0])
            if (propKey === 'count') return fallbackList.length
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
