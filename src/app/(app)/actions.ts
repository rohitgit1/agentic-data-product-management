'use server'

import { signOut } from '@/auth'

export async function endSession() {
  await signOut({ redirectTo: '/signin' })
}
