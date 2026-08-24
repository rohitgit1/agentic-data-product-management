import { prisma } from '@/lib/db'
import { ROLES } from '@/lib/domain/roles'
import { BrandMark, BrandWordmark } from '@/components/brand'
import { Button, Card, CardBody, CardHeader, ErrorText, Field, inputClass } from '@/components/ui'
import { authenticate } from './actions'

export const dynamic = 'force-dynamic'

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  let error: string | undefined = undefined
  try {
    const sp = await searchParams
    error = sp?.error
  } catch {
    error = undefined
  }

  let seeded: Array<{ email: string; name: string; title: string }> = []
  try {
    seeded = await prisma.user.findMany({
      orderBy: { email: 'asc' },
      select: { email: true, name: true, title: true },
    })
  } catch (err) {
    console.warn('Unable to fetch seeded users from DB, falling back to static ROLES list:', err)
  }

  const userList =
    seeded && seeded.length > 0
      ? seeded
      : ROLES.map((r) => ({
          email: r.seedEmail,
          name: r.seedName,
          title: r.name,
        }))

  return (
    <div className="flex min-h-screen flex-col justify-center bg-ink-50 py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex flex-col items-center gap-3 text-center">
          <BrandMark size={40} className="text-accent-600" />
          <BrandWordmark size="lg" />
          <p className="text-sm font-semibold uppercase tracking-wider text-ink-500">
            Sign In
          </p>
        </div>
      </div>

      <div className="mt-6 sm:mx-auto sm:w-full sm:max-w-md">
        <Card>
          <CardHeader title="Seeded domain roles" />
          <CardBody className="space-y-3">
            <p className="text-xs text-ink-600">
              Each user holds a different set of doors, approvals, and write privileges.
              Click any role to enter instantly.
            </p>
            {userList.map((u) => (
              <form key={u.email} action={authenticate} className="block">
                <input type="hidden" name="email" value={u.email} />
                <input type="hidden" name="password" value="adpm-demo" />
                <Button type="submit" variant="secondary" className="w-full justify-between text-left">
                  <span>
                    <span className="font-semibold text-ink-900">{u.name}</span>
                    <span className="ml-2 text-xs text-ink-500">({u.title})</span>
                  </span>
                  <span className="text-xs font-semibold text-accent-600">Enter &rarr;</span>
                </Button>
              </form>
            ))}
          </CardBody>
        </Card>

        <Card className="mt-4">
          <CardHeader title="Custom credentials" />
          <CardBody>
            {error && (
              <ErrorText className="mb-4">
                {error === 'CredentialsSignin'
                  ? 'Invalid email or password.'
                  : `Sign-in failed (${error}).`}
              </ErrorText>
            )}

            <form action={authenticate} className="space-y-4">
              <Field label="Email address" htmlFor="email">
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  defaultValue="owner@adpm.local"
                  className={inputClass()}
                />
              </Field>

              <Field label="Password" htmlFor="password">
                <input
                  id="password"
                  name="password"
                  type="password"
                  required
                  defaultValue="adpm-demo"
                  className={inputClass()}
                />
              </Field>

              <Button type="submit" variant="primary" className="w-full">
                Sign in
              </Button>
            </form>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
