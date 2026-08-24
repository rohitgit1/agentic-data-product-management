import { ROLES } from '@/lib/domain/roles'
import { BrandMark, BrandWordmark } from '@/components/brand'
import { Button, Card, CardBody, CardHeader, ErrorText, Field, inputClass } from '@/components/ui'

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
            {ROLES.map((r) => (
              <form key={r.seedEmail} method="POST" action="/api/auth/callback/credentials" className="block">
                <input type="hidden" name="email" value={r.seedEmail} />
                <input type="hidden" name="password" value="adpm-demo" />
                <input type="hidden" name="redirectTo" value="/inbox" />
                <Button type="submit" variant="secondary" className="w-full justify-between text-left">
                  <span>
                    <span className="font-semibold text-ink-900">{r.seedName}</span>
                    <span className="ml-2 text-xs text-ink-500">({r.name})</span>
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

            <form method="POST" action="/api/auth/callback/credentials" className="space-y-4">
              <input type="hidden" name="redirectTo" value="/inbox" />
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
