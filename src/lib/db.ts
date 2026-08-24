import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: any }

function getPostgresUrl(): string | undefined {
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

  return process.env.DATABASE_URL
}

const dbUrl = getPostgresUrl()

if (dbUrl) {
  process.env.DATABASE_URL = dbUrl
}

const realPrisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: dbUrl ? { db: { url: dbUrl } } : undefined,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = realPrisma

function createSafeModel(modelName: string, targetModel: any) {
  if (!targetModel) return {}
  return new Proxy(targetModel, {
    get(target, propKey, receiver) {
      const original = Reflect.get(target, propKey, receiver)
      if (typeof original === 'function') {
        return async (...args: any[]) => {
          try {
            return await original.apply(target, args)
          } catch (err: any) {
            console.warn(`[Prisma Safe Proxy] Error on ${modelName}.${String(propKey)}:`, err?.message || err)
            if (propKey === 'findMany') return []
            if (propKey === 'findUnique' || propKey === 'findFirst') return null
            if (propKey === 'count') return 0
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
