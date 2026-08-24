import { redirect } from 'next/navigation'
import { AuthError } from 'next-auth'
import { signIn } from '@/auth'
import { prisma } from '@/lib/db'
import { currentUser, landingPathFor } from '@/lib/auth/session'
import { ROLES } from '@/lib/domain/roles'
import { BrandMark, BrandWordmark } from '@/components/brand'
import { Button, Card, CardBody, CardHeader, ErrorText, Field, inputClass } from '@/components/ui'

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  let user = null
  try {
    user = await currentUser()
  } catch (err) {
    console.warn('Unable to get currentUser on signin page:', err)
  }
  if (user) redirect('/')

  const { error } = await searchParams

  let seeded: Array<{ email: string; name: string; title: string }> = []
  try {
    seeded = await prisma.user.findMany({
      orderBy: { email: 'asc' },
      select: { email: true, name: true, title: true },
    })
  } catch (err) {
    console.warn('Unable to fetch seeded users from DB, falling back to static ROLES list:', err)
  }

  const userList = seeded.length > 0
    ? seeded
    : ROLES.map((r) => ({
        email: r.seedEmail,
        name: r.seedName,
        title: r.name,
      }))

  async function authenticate(formData: FormData) {
    'use server'
    try {
      await signIn('credentials', {
        email: String(formData.get('email') ?? ''),
        password: String(formData.get('password') ?? ''),
        redirectTo: landingPathFor('PRACTITIONER'),
      })
    } catch (thrown) {
      if (thrown instanceof AuthError) redirect('/signin?error=1')
      throw thrown
    }
  }

  return (
    <div className="min-h-screen">
      {/* The same top layer the application wears, so the first screen already looks like it. */}
      <div className="brand-bar bg-brand-900">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-4">
          <BrandMark />
          <BrandWordmark onDark />
        </div>
        <div className="brand-rule h-1" />
      </div>

      <div className="mx-auto flex max-w-5xl items-center px-6 py-12">
        <div className="grid w-full gap-8 md:grid-cols-2">
          <div>
            <h1 className="text-2xl font-semibold text-ink-900">Agentic Data Product Management</h1>
            <p className="mt-3 text-sm text-ink-700">
              Agents act. Humans decide. Sign in as any seeded role to see the same lifecycle from that
              role&rsquo;s door.
            </p>
            <Card className="mt-6">
              <CardHeader title="Seeded users" description="Every account uses the password “adpm”." />
              <CardBody className="max-h-[420px] overflow-y-auto p-0">
                <table className="w-full text-sm">
                  <thead className="sr-only">
                    <tr>
                      <th>Email</th>
                      <th>Name</th>
                      <th>Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {userList.map((seed) => (
                      <tr key={seed.email} className="border-b border-ink-100 last:border-0">
                        <td className="px-5 py-2 font-mono text-xs text-ink-800">{seed.email}</td>
                        <td className="px-2 py-2 text-ink-700">{seed.name}</td>
                        <td className="px-5 py-2 text-right text-xs text-ink-500">
                          {seed.title || ROLES.find((r) => r.seedEmail === seed.email)?.name}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardBody>
            </Card>
          </div>

          <Card className="self-start">
            <CardHeader title="Sign in" />
            <CardBody>
              <form action={authenticate}>
                <Field label="Email" htmlFor="email" required>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="username"
                    required
                    defaultValue="owner@adpm.local"
                    className={inputClass}
                  />
                </Field>
                <Field label="Password" htmlFor="password" required>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    defaultValue="adpm"
                    className={inputClass}
                  />
                </Field>
                {error ? <ErrorText>That email and password did not match a seeded user.</ErrorText> : null}
                <Button className="mt-2 w-full">Sign in</Button>
              </form>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  )
}
