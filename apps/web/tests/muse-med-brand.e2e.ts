/** Built-client branding through the real Web profile and browser Loader. */
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

it('follows the application theme for brand marks while keeping the favicon black', async () => {
  const scaffold = await launchWebScaffold()
  try {
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      await page.emulateMedia({ colorScheme: 'light' })
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByText('muse-med', { exact: true }).first().waitFor({ timeout: 60000 })
      expect(await page.title()).toBe('muse-med')
      const assertArtwork = async (color: 'black' | 'white') => {
        const url = `./muse-med-logo-${color}.webp`
        const logos = page.locator(`img[src="${url}"]`)
        await expect.poll(() => logos.count()).toBe(2)
        for (const logo of await logos.all()) {
          await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1254)
          expect(await logo.getAttribute('alt')).toBe('')
        }
        await expect.poll(() => page.locator('link[rel="icon"]').getAttribute('href')).toBe('./muse-med-logo-black.webp')
      }
      const action = page.getByRole('button', { name: 'New session', exact: true }).first()
      expect(await action.isEnabled()).toBe(true)
      await action.click()
      await assertArtwork('black')
      await page.emulateMedia({ colorScheme: 'dark' })
      await assertArtwork('white')
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Settings' })
      await dialog.getByRole('button', { name: 'Light', exact: true }).click()
      await assertArtwork('black')
      await page.emulateMedia({ colorScheme: 'light' })
      await dialog.getByRole('button', { name: 'Dark', exact: true }).click()
      await assertArtwork('white')
      await page.keyboard.press('Escape')
      await page.reload({ waitUntil: 'load' })
      await assertArtwork('white')
      expect({ title: await page.title(), name: await page.getByText('muse-med', { exact: true }).first().textContent() })
        .toEqual({ title: 'muse-med', name: 'muse-med' })
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
