import { expect, test, type Page } from '@playwright/test'

/**
 * The Data model tab is generated from prisma/schema.prisma at request time, so the thing worth
 * asserting in a browser is that the generation actually produced a page: real diagrams rather
 * than the Mermaid text fallback, and tables read from the schema rather than transcribed.
 */

async function signIn(page: Page, email: string) {
  await page.goto('/signin')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('adpm')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/inbox|marketplace|portfolio|admin/)
}

test('the data model tab sits beside Academy and renders the schema it reads', async ({ page }) => {
  await signIn(page, 'owner@adpm.local')

  await page.getByRole('link', { name: 'Data Model' }).click()
  await expect(page.getByRole('heading', { name: 'Data model', exact: true })).toBeVisible()

  // Every diagram rendered: Mermaid falls back to a <pre> of its source when parsing fails.
  await expect(page.locator('figure svg').first()).toBeVisible({ timeout: 20_000 })
  expect(await page.locator('pre').count()).toBe(0)

  // Columns, keys and defaults come from the schema, not from prose.
  const version = page.locator('#model-artifactversion')
  await expect(version.getByRole('rowheader', { name: 'contentHash', exact: true })).toBeVisible()
  await expect(version.getByText('Append-only. A commit never mutates a previous row.')).toBeVisible()

  await page.getByRole('link', { name: 'Governance and audit' }).first().click()
  await expect(page.locator('#group-governance')).toBeInViewport()
})
