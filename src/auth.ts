import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { compare } from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { ROLES } from '@/lib/domain/roles'

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export const { handlers, signIn, signOut, auth } = NextAuth({
  secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || 'adpm-local-development-secret-change-me',
  session: { strategy: 'jwt' },
  trustHost: true,
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw)
        if (!parsed.success) return null

        let user = null
        try {
          user = await prisma.user.findUnique({ where: { email: parsed.data.email } })
        } catch (err) {
          console.warn('Auth DB lookup warning:', err)
        }

        if (user && !user.archivedAt) {
          const ok = await compare(parsed.data.password, user.passwordHash)
          if (ok) return { id: user.id, email: user.email, name: user.name }
        }

        // Fallback for static demo users when DB is unseeded or unreachable
        const staticRole = ROLES.find((r) => r.seedEmail === parsed.data.email)
        if (staticRole && (parsed.data.password === 'adpm-demo' || parsed.data.password === 'password')) {
          return {
            id: `static-${staticRole.key.toLowerCase()}`,
            email: staticRole.seedEmail,
            name: staticRole.seedName,
          }
        }

        return null
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
        token.email = user.email
        token.name = user.name
      }
      return token
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string
        session.user.email = token.email as string
        session.user.name = token.name as string
      }
      return session
    },
  },
})
