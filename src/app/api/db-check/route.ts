import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  const envKeys = Object.keys(process.env).filter(
    (k) => k.includes('POSTGRES') || k.includes('DATABASE') || k.includes('PG') || k.includes('AUTH')
  )

  try {
    const userCount = await prisma.user.count()
    return NextResponse.json({
      status: 'ok',
      userCount,
      envKeys,
    })
  } catch (err: any) {
    return NextResponse.json(
      {
        status: 'error',
        message: err?.message || String(err),
        envKeys,
        pgUrlDetected: Boolean(process.env.POSTGRES_PRISMA_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL),
      },
      { status: 200 }
    )
  }
}
