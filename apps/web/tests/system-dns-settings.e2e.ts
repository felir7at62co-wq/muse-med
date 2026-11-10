/** Desktop DNS setting in Chromium with a simulated preload bridge. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { openSettings, REPO_ROOT } from './support.ts'

it('shows the device setting only with its Desktop bridge and retains accepted values on failure', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const ordinary = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US' })
  await ordinary.goto(scaffold.authenticatedUrl)
  await openSettings(ordinary, 'en')
  expect(await ordinary.getByRole('switch', { name: 'System DNS compatibility' }).count()).toBe(0)
  await ordinary.close()

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US' })
  const tripwire = watchConsole(page)
  await page.addInitScript(() => {
    const fixture = { saved: false, active: false, fail: false, unknown: false }
    Object.assign(globalThis, { systemDnsFixture: fixture, dshDesktop: {
      protocolVersion: 1,
      productName: 'muse-med',
      systemDns: {
        status: async () => ({ saved: fixture.saved, active: fixture.active }),
        set: async (enabled: boolean) => {
          if (fixture.unknown) {
            fixture.saved = enabled
            return { unknown: true }
          }
          if (fixture.fail) return { saved: fixture.saved, active: fixture.active, saveFailed: true }
          fixture.saved = enabled
          return { saved: fixture.saved, active: fixture.active }
        },
      },
    } })
  })
  await page.goto(scaffold.authenticatedUrl)
  await openSettings(page, 'en')
  const toggle = page.getByRole('switch', { name: 'System DNS compatibility' })
  await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
  await toggle.click()
  await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
  const restart = page.getByText('Restart Muse to apply this change.', { exact: true })
  await restart.waitFor()

  const artifacts = join(REPO_ROOT, '.artifacts', 'system-dns-settings')
  await mkdir(artifacts, { recursive: true })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await toggle.scrollIntoViewIfNeeded()
    await dialog.screenshot({ path: join(artifacts, `${colorScheme}.png`) })
    const bounds = await toggle.boundingBox()
    expect(bounds?.width).toBeGreaterThan(0)
    expect(bounds?.height).toBeGreaterThan(0)
  }

  await page.evaluate(() => {
    const fixture = Reflect.get(globalThis, 'systemDnsFixture') as { fail: boolean }
    fixture.fail = true
  })
  await toggle.click()
  await page.getByText('Could not save. Please try again.', { exact: true }).waitFor()
  expect(await toggle.getAttribute('aria-checked')).toBe('true')
  expect(await restart.count()).toBe(1)

  await page.evaluate(() => {
    const fixture = Reflect.get(globalThis, 'systemDnsFixture') as { unknown: boolean; fail: boolean }
    fixture.fail = false
    fixture.unknown = true
  })
  await toggle.click()
  await expect.poll(() => toggle.count()).toBe(0)
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog.getByRole('alert').filter({ hasText: 'Could not confirm whether the setting was saved. Retry to check.' }).waitFor()
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
  expect(await restart.count()).toBe(0)
  expect(tripwire.pageErrors).toEqual([])

  const chinese = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
  const chineseTripwire = watchConsole(chinese)
  await chinese.addInitScript(() => {
    Object.assign(globalThis, { dshDesktop: {
      protocolVersion: 1, productName: 'muse-med',
      systemDns: { status: async () => ({ saved: true, active: false }), set: async () => ({ saved: true, active: false }) },
    } })
  })
  await chinese.goto(scaffold.authenticatedUrl)
  await openSettings(chinese, 'zh')
  const chineseToggle = chinese.getByRole('switch', { name: '系统 DNS 兼容模式' })
  await expect.poll(() => chineseToggle.getAttribute('aria-checked')).toBe('true')
  await chinese.getByText('优先使用系统 DNS，改善部分代理软件兼容性；重启后影响 Muse 的网络连接', { exact: true }).waitFor()
  await chinese.getByText('重启 Muse 后生效', { exact: true }).waitFor()
  await chineseToggle.scrollIntoViewIfNeeded()
  await chinese.getByRole('dialog', { name: '设置', exact: true }).screenshot({ path: join(artifacts, 'zh.png') })
  expect(chineseTripwire.pageErrors).toEqual([])
})
