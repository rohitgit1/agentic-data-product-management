'use client'

import { ROLES } from '@/lib/domain/roles'
import { BrandMark, BrandWordmark } from '@/components/brand'
import { Button, Card, CardBody, CardHeader, Field, inputClass } from '@/components/ui'

export default function SignInPage() {
  const handleRoleClick = (email: string) => {
    if (typeof document === 'undefined') return
    const form = document.createElement('form')
    form.method = 'POST'
    form.action = '/api/auth/callback/credentials'

    const emailInput = document.createElement('input')
    emailInput.type = 'hidden'
    emailInput.name = 'email'
    emailInput.value = email
    form.appendChild(emailInput)

    const passInput = document.createElement('input')
    passInput.type = 'hidden'
    passInput.name = 'password'
    passInput.value = 'adpm-demo'
    form.appendChild(passInput)

    const redirectInput = document.createElement('input')
    redirectInput.type = 'hidden'
    redirectInput.name = 'redirectTo'
    redirectInput.value = '/inbox'
    form.appendChild(redirectInput)

    document.body.appendChild(form)
    form.submit()
  }

  const handleCustomSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const target = e.currentTarget
    const email = (target.elements.namedItem('email') as HTMLInputElement).value
    handleRoleClick(email)
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
              <Button
                key={r.seedEmail}
                type="button"
                variant="secondary"
                className="w-full justify-between text-left"
                onClick={() => handleRoleClick(r.seedEmail)}
              >
                <span>
                  <span className="font-semibold text-ink-900">{r.seedName}</span>
                  <span className="ml-2 text-xs text-ink-500">({r.name})</span>
                </span>
                <span className="text-xs font-semibold text-accent-600">Enter &rarr;</span>
              </Button>
            ))}
          </CardBody>
        </Card>

        <Card className="mt-4">
          <CardHeader title="Custom credentials" />
          <CardBody>
            <form onSubmit={handleCustomSubmit} className="space-y-4">
              <Field label="Email address" htmlFor="email">
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  defaultValue="owner@adpm.local"
                  className={inputClass}
                />
              </Field>

              <Field label="Password" htmlFor="password">
                <input
                  id="password"
                  name="password"
                  type="password"
                  required
                  defaultValue="adpm-demo"
                  className={inputClass}
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
