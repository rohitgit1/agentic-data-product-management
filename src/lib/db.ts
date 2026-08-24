import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

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

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: dbUrl ? { db: { url: dbUrl } } : undefined,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export type { Prisma } from '@prisma/client'
