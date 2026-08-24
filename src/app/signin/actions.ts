'use server'

import { AuthError } from 'next-auth'
import { redirect } from 'next/navigation'
import { signIn } from '@/auth'
import { landingPathFor } from '@/lib/auth/session'

export async function authenticate(formData: FormData) {
  try {
    await signIn('credentials', {
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
      redirectTo: landingPathFor('PRACTITIONER'),
    })
  } catch (err) {
    if (err instanceof AuthError) {
      redirect(`/signin?error=${encodeURIComponent(err.type)}`)
    }
    throw err
  }
}
