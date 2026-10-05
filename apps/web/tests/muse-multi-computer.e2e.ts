// Real Web profiles and pinned Muse tunnels share an account but retain separate browser tabs.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold, type WebConsoleTripwire } from './scaffold.ts'
import { REPO_ROOT, ZH_BROWSER_LOCALE } from './support.ts'

interface Device {
  deviceId: string
  tunnel: { stop(): Promise<void> }
}
interface AccountFixture {
  base: string
  alice: string
  connect(
    cookie: string, hostUrl: string, loopbackCookie: string, deviceId: string,
    metadata: { deviceName: string; platform: string },
  ): Promise<Device>
}
interface FixtureModule {
  fixture: (
    owner: { after(cleanup: () => Promise<void>): void },
    options: Record<string, never>, browserOrigin: boolean,
  ) => Promise<AccountFixture>
}
const fixtureUrl = new URL('../../../services/muse-accounts/desktop-test-fixture.mjs', import.meta.url)
const expectedPath = join(REPO_ROOT, 'apps/web/tests/expected/muse-multi-computer/navigation.json')

// Navigation expectations stay beside this browser test; no agent turn is needed to select a computer.
describe.skipIf(webSnapshotMode() === 'record')('Muse multi-computer Web access', () => {
  let browser: Browser
  let picker: Page
  let account: AccountFixture
  const profiles: WebScaffold[] = []
  const hostCookies: string[] = []
  const devices: Device[] = []
  const tabs: Page[] = []
  const cleanup: (() => Promise<void>)[] = []
  const tripwires: WebConsoleTripwire[] = []
  const errors: string[] = []
  const shotDir = join(REPO_ROOT, '.playwright-mcp/multi-computer')

  beforeAll(async () => {
    const { fixture } = await import(fixtureUrl.href) as FixtureModule
    account = await fixture({ after: callback => cleanup.push(callback) }, {}, true)
    await mkdir(shotDir, { recursive: true })
    for (const [deviceName, platform] of [['剪辑电脑', 'win32'], ['外出 Mac', 'darwin']] as const) {
      const profile = await launchWebScaffold({
        firstUse: true,
        extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      })
      profiles.push(profile)
      const exchange = await fetch(profile.authenticatedUrl, { redirect: 'manual' })
      const cookie = exchange.headers.get('set-cookie')?.split(';')[0]
      if (!cookie) throw Error('Web Host authentication exchange failed')
      hostCookies.push(cookie)
      devices.push(await account.connect(account.alice, profile.baseUrl, cookie, randomUUID(), { deviceName, platform }))
    }
    browser = await chromium.launch()
    const context = await browser.newContext({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1280, height: 850 } })
    picker = await context.newPage()
    await picker.goto(account.base + '/login')
    await picker.locator('input[name="username"]').fill('alice')
    await picker.locator('input[name="password"]').fill('password')
    const submitted = picker.waitForRequest(request => request.method() === 'POST')
    const answered = picker.waitForResponse(response => response.request().method() === 'POST')
    await picker.locator('form button').click()
    expect((await (await submitted).allHeaders()).origin).toBe(account.base)
    expect((await answered).status()).toBe(303)
    for (const page of [picker]) {
      const tripwire = watchConsole(page)
      tripwires.push(tripwire)
      page.on('pageerror', error => errors.push(error.message))
    }
    try {
      await picker.getByRole('heading', { name: '选择电脑' }).waitFor({ timeout: 10_000 })
    } catch (error) {
      await picker.screenshot({ path: join(shotDir, 'failure-login.png') })
      throw error
    }
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    for (const close of cleanup.reverse()) await close()
    for (const profile of profiles.reverse()) await profile.close()
  })

  it('lists both computers and opens two complete Web profiles under independent mounts', async () => {
    await picker.getByRole('heading', { name: '选择电脑' }).waitFor()
    const navigation: string[] = []
    const expected = JSON.parse(await readFile(expectedPath, 'utf8')) as { heading: string; computers: string[]; switchLabel: string; navigation: string[] }
    expect(await picker.locator('.computer-name').allTextContents()).toEqual(expected.computers)
    expect(await picker.locator('h1').textContent()).toBe(expected.heading)
    await picker.screenshot({ path: join(shotDir, '01-picker-light.png') })
    for (let index = 0; index < 2; index++) {
      const page = await picker.context().newPage()
      tabs.push(page)
      const requests: string[] = []
      const frames: string[] = []
      page.on('request', request => requests.push(new URL(request.url()).pathname))
      page.on('websocket', socket => socket.on('framereceived', frame => frames.push(String(frame.payload))))
      page.on('pageerror', error => errors.push(error.message))
      tripwires.push(watchConsole(page))
      const prefix = `/desktop/${devices[index]!.deviceId}/`
      expect(await picker.locator('.computer-open').nth(index).getAttribute('href')).toBe(prefix)
      await page.goto(account.base + prefix)
      await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 30_000 })
      expect(await page.locator('#muse-desktop-context').textContent()).toBe('电脑：' + expected.computers[index]! + expected.switchLabel)
      expect(await page.locator('#muse-desktop-context a').getAttribute('target')).toBe('_blank')
      navigation.push(await page.locator('#muse-desktop-context').ariaSnapshot())
      await expect.poll(() => frames.some(frame => frame.includes('"type":"item"')), { timeout: 10_000 }).toBe(true)
      expect(requests.some(path => path.startsWith(prefix + 'plugins/'))).toBe(true)
      expect(requests.filter(path => !path.startsWith(prefix))).toEqual([])
      await page.locator('[data-composer-input]').first().fill(`这份草稿属于电脑 ${index + 1}`)
      const geometry = await page.evaluate(() => ({
        bannerBottom: document.getElementById('muse-desktop-context')!.getBoundingClientRect().bottom,
        rootTop: document.getElementById('root')!.getBoundingClientRect().top,
        overflow: document.body.scrollHeight - innerHeight,
      }))
      expect(geometry.rootTop).toBeGreaterThanOrEqual(geometry.bannerBottom)
      expect(geometry.overflow).toBeLessThanOrEqual(1)
    }
    const firstSessions = profiles[0]!.ctx.sessions.list()
    const secondSessions = profiles[1]!.ctx.sessions.list()
    expect(firstSessions).toHaveLength(1)
    expect(secondSessions).toHaveLength(1)
    expect(firstSessions[0]!.id).not.toBe(secondSessions[0]!.id)
    expect(profiles[0]!.ctx.sessions.get(secondSessions[0]!.id)).toBeUndefined()
    if (webSnapshotMode() === 'refresh') await writeFile(expectedPath, JSON.stringify({ ...expected, navigation }, null, 2) + '\n')
    else expect(navigation).toEqual(expected.navigation)
    await tabs[0]!.screenshot({ path: join(shotDir, '02-first-computer.png') })
    await tabs[1]!.screenshot({ path: join(shotDir, '03-second-computer.png') })
    await tabs[1]!.emulateMedia({ colorScheme: 'dark' })
    await tabs[1]!.screenshot({ path: join(shotDir, '07-chat-dark.png') })
    await tabs[1]!.setViewportSize({ width: 390, height: 844 })
    expect(await tabs[1]!.locator('#muse-desktop-context').evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true)
    await tabs[1]!.screenshot({ path: join(shotDir, '08-chat-mobile.png') })
    await tabs[1]!.setViewportSize({ width: 1280, height: 850 })
    expect(errors).toEqual([])
    expect(tripwires.flatMap(tripwire => tripwire.warnings)).toEqual([])
  }, 90_000)

  it('opens the switch list without clearing the existing tab and its draft', async () => {
    const popup = tabs[0]!.waitForEvent('popup')
    await tabs[0]!.locator('#muse-desktop-context a').click()
    const switchPage = await popup
    await switchPage.getByRole('heading', { name: '选择电脑' }).waitFor()
    expect(new URL(switchPage.url()).pathname).toBe('/computers')
    expect(new URL(tabs[0]!.url()).pathname).toBe(`/desktop/${devices[0]!.deviceId}/`)
    expect(await tabs[0]!.locator('[data-composer-input]').first().textContent()).toContain('电脑 1')
    await switchPage.emulateMedia({ colorScheme: 'dark' })
    await switchPage.screenshot({ path: join(shotDir, '04-picker-dark.png') })
    await switchPage.setViewportSize({ width: 390, height: 844 })
    await switchPage.screenshot({ path: join(shotDir, '05-picker-mobile.png') })
    expect(await switchPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await switchPage.close()
  })

  it('keeps the other computer available and restores the original tab without clearing its draft', async () => {
    await devices[0]!.tunnel.stop()
    await tabs[0]!.getByRole('dialog', { name: 'Muse 连接状态' }).waitFor({ timeout: 15_000 })
    expect(await tabs[0]!.getByRole('dialog').textContent()).toContain('剪辑电脑')
    expect(await tabs[0]!.locator('[data-composer-input]').first().textContent()).toContain('电脑 1')
    await tabs[0]!.screenshot({ path: join(shotDir, '06-offline-preserves-draft.png') })
    await tabs[0]!.emulateMedia({ colorScheme: 'dark' })
    await tabs[0]!.setViewportSize({ width: 390, height: 844 })
    const bounds = await tabs[0]!.getByRole('dialog').evaluate(element => ({
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      width: innerWidth,
    }))
    expect(bounds.left).toBeGreaterThanOrEqual(0)
    expect(bounds.right).toBeLessThanOrEqual(bounds.width)
    await tabs[0]!.screenshot({ path: join(shotDir, '09-offline-mobile-dark.png') })
    const secondStatus = await tabs[1]!.evaluate(async () => {
      const response = await fetch(new URL('api/desktop/status', document.baseURI))
      return await response.json() as { state: string }
    })
    expect(secondStatus.state).toBe('online')
    expect(await tabs[1]!.locator('[data-composer-input]').first().textContent()).toContain('电脑 2')
    expect(new URL(tabs[0]!.url()).pathname).toContain(devices[0]!.deviceId)
    await account.connect(account.alice, profiles[0]!.baseUrl, hostCookies[0]!, devices[0]!.deviceId, { deviceName: '剪辑电脑', platform: 'win32' })
    await tabs[0]!.getByRole('dialog', { name: 'Muse 连接状态' }).waitFor({ state: 'detached', timeout: 15_000 })
    expect(await tabs[0]!.locator('[data-composer-input]').first().textContent()).toContain('电脑 1')
    expect(new URL(tabs[0]!.url()).pathname).toContain(devices[0]!.deviceId)
    expect(errors).toEqual([])
    const unexpectedWarnings = tripwires.flatMap(tripwire => tripwire.warnings)
      .filter(message => !/^\[connection\] connection lost, retry #\d+$/u.test(message))
    expect(unexpectedWarnings).toEqual([])
  }, 30_000)
})
