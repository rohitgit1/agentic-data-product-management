import path from 'node:path'
import { expect, test } from '@playwright/test'

/**
 * Attaching a catalogue and a model is what makes an agent's draft grounded rather than invented,
 * so the round trip is asserted end to end: upload two real export shapes, confirm the console
 * reports what each supplies, and confirm a run started with both toggles on records that choice.
 */
const FIXTURES = path.join(__dirname, 'fixtures')

test('attach Collibra and erwin, then run with that context', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.setViewportSize({ width: 1440, height: 1100 })

  await page.goto('/signin')
  await page.getByLabel('Email').fill('owner@adpm.local')
  await page.getByLabel('Password').fill('adpm')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/inbox|marketplace|portfolio|admin/)
  await page.goto('/run-console')

  const cancel = page.getByRole('button', { name: 'Cancel run' })
  while (await cancel.count()) { await cancel.first().click(); await page.waitForTimeout(1500) }

  // Pick the stage-7 product so the Architecture agent has a model to lay out.
  const select = page.getByLabel('Data product')
  const options = await select.locator('option').allTextContents()
  const target = options.find((o) => o.includes('Stage 7'))!
  await select.selectOption({ label: target })
  await page.waitForURL(/product=/)

  // Before attaching: both sources say nothing is attached.
  await expect(page.getByText('Nothing attached yet.').first()).toBeVisible()

  // Attach the Collibra export (catalogue + lineage).
  await page.getByLabel('Tool', { exact: false }).first().selectOption({ label: 'Collibra Data Intelligence Platform' })
  await page.locator('#file-Data\\ catalogue').setInputFiles(path.join(FIXTURES, 'collibra-export.json'))
  await page.getByRole('button', { name: 'Attach' }).first().click()
  await expect(page.getByText('collibra-export.json')).toBeVisible({ timeout: 20_000 })

  // Attach the erwin model.
  await page.locator('#file-Data\\ modelling').setInputFiles(path.join(FIXTURES, 'erwin-export.csv'))
  await page.getByRole('button', { name: 'Attach' }).last().click()
  await expect(page.getByText('erwin-export.csv')).toBeVisible({ timeout: 20_000 })

  await page.reload()
  await expect(page.getByText(/lineage hop/i).first()).toBeVisible()

  // Both context toggles on, then run.
  const catalogue = page.locator('input[name="contextSources"][value="DATA_CATALOGUE"]')
  const modelling = page.locator('input[name="contextSources"][value="DATA_MODELLING"]')
  await expect(catalogue).toBeChecked()
  await expect(modelling).toBeChecked()

  await page.getByRole('button', { name: 'Start automated execution' }).click()
  await expect(page.getByText('Awaiting your review')).toBeVisible({ timeout: 40_000 })

  // The Architecture agent is chartered for lineage, and says so in what it drafted.
  await expect(page.getByText(/lineage hop\(s\) from your catalogue were used/)).toBeVisible({
    timeout: 40_000,
  })

  expect(errors).toEqual([])
})
