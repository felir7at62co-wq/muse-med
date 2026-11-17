/** Account details cross the private gateway, generated Host Remote and real Web profile. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT, ZH_BROWSER_LOCALE } from './support.ts'

interface AccountDetailsStack {
  readonly origin: string
  readonly cookie: string
  readonly username: string
  close(): Promise<void>
}
interface AccountDetailsFixture {
  startAccountDetailsStack(root: string): Promise<AccountDetailsStack>
}
const fixtureUrl = new URL('./fixtures/muse-user-details/stack.mjs', import.meta.url)

it('shows the signed-in user both group sources and private token details through the shipped account page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-user-details-browser-'))
  let account: AccountDetailsStack | undefined
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  try {
    const fixture = await import(fixtureUrl.href) as AccountDetailsFixture
    account = await fixture.startAccountDetailsStack(root)
    const accountHome = join(root, 'account')
    await mkdir(accountHome, { mode: 0o700 })
    await writeFile(join(accountHome, 'session.json'), JSON.stringify({ baseUrl: account.origin,
      cookie: account.cookie, username: account.username, revision: 'browser-account-details',
    }), { mode: 0o600 })
    const overlay = join(root, 'account.patch.json')
    await writeFile(overlay, JSON.stringify([{ insert: [
      { id: 'muse-account', name: '@deepseek-ai/dsh-muse-account', config: { baseUrl: account.origin, accountHome, remoteAccess: false } },
      { id: 'ui-muse-account', name: '@deepseek-ai/dsh-client-ui-muse-account', config: { feedbackUrl: 'https://example.invalid/feedback' } },
    ] }]))
    scaffold = await launchWebScaffold({ harnessHome: join(root, 'profile'), deepSeekMissingCredential: true,
      extraOverlayPath: [overlay, join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
      extraInstallAnchors: [join(REPO_ROOT, 'apps/desktop-host/package.json')],
    })
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1, productName: 'muse-med' } })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('dialog', { name: '为 muse-med 配置模型', exact: true })
      .getByRole('button', { name: '稍后配置', exact: true }).click()
    await page.getByRole('button', { name: 'MUSE', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置', exact: true })
    await dialog.getByRole('button', { name: 'MUSE', exact: true }).click()
    const details = dialog.locator('[data-muse-account-details]')
    await details.getByText('短剧创作组', { exact: true }).waitFor()
    expect(await details.getByText('负责剧本与分镜创作', { exact: true }).count()).toBe(1)
    expect(await details.getByText('内容中心/编剧组', { exact: true }).count()).toBe(1)
    expect(await details.getByText('测试编剧', { exact: true }).count()).toBe(1)
    const summary = details.locator('[data-muse-usage-summary]')
    expect(await summary.innerText()).toContain('160')
    await details.getByRole('button', { name: '更新用量', exact: true }).click()
    await details.getByRole('table', { name: '请求明细', exact: true }).getByText('browser-writer', { exact: true }).waitFor()
    expect(await details.getByRole('table', { name: '按模型', exact: true }).innerText()).toContain('160')
    const expected = { headings: await details.getByRole('heading').allTextContents(), summary: await summary.innerText() }
    await expect(JSON.stringify(expected, null, 2) + '\n').toMatchFileSnapshot(join(REPO_ROOT, 'apps/web/tests/expected/muse-user-details/account.json'))
    const shots = join(REPO_ROOT, '.playwright-mcp/muse-user-details')
    await mkdir(shots, { recursive: true })
    await page.screenshot({ path: join(shots, 'account.png'), fullPage: true })
    await summary.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(shots, 'account-usage.png'), fullPage: true })
    await details.getByRole('table', { name: '请求明细', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(shots, 'account-requests.png'), fullPage: true })
    await page.emulateMedia({ colorScheme: 'dark' })
    await summary.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(shots, 'account-dark.png'), fullPage: true })
    await dialog.getByRole('button', { name: '退出登录', exact: true }).click()
    await dialog.getByRole('button', { name: '飞书登录', exact: true }).waitFor()
    expect(await dialog.locator('[data-muse-account-details]').count()).toBe(0)
    expect(await dialog.getByText('短剧创作组', { exact: true }).count()).toBe(0)
  } finally {
    try { await browser?.close() }
    finally {
      try { await scaffold?.close() }
      finally {
        try { await account?.close() }
        finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  }
})
