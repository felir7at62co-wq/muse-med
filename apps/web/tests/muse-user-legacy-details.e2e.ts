/** Legacy account data reaches the account UI through the private Host and generated Remote service. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT, ZH_BROWSER_LOCALE } from './support.ts'

interface LegacyRequest {
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  readonly authenticated: boolean
}
interface LegacyAccountDetailsStack {
  readonly origin: string
  readonly cookie: string
  readonly username: string
  readonly accountId: string
  readonly requests: readonly LegacyRequest[]
  readonly violations: readonly string[]
  close(): Promise<void>
}
interface LegacyAccountDetailsFixture {
  startLegacyAccountDetailsStack(options?: {
    readonly profile?: boolean
    readonly organization?: boolean
  }): Promise<LegacyAccountDetailsStack>
}
const fixtureUrl = new URL('./fixtures/muse-user-legacy-details/stack.mjs', import.meta.url)

it.each([
  { label: 'legacy', profile: false, organization: false },
  { label: 'profile', profile: true, organization: false },
  { label: 'workbench', profile: false, organization: true },
])('shows private relay totals and cursor pages through $label', async ({ profile, organization }) => {
  const root = await mkdtemp(join(tmpdir(), 'muse-legacy-details-browser-'))
  let account: LegacyAccountDetailsStack | undefined
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  try {
    const fixture = await import(fixtureUrl.href) as LegacyAccountDetailsFixture
    account = await fixture.startLegacyAccountDetailsStack({ profile, organization })
    const accountHome = join(root, 'account')
    await mkdir(accountHome, { mode: 0o700 })
    await writeFile(join(accountHome, 'session.json'), JSON.stringify({ baseUrl: account.origin,
      cookie: account.cookie, username: account.username, revision: 'legacy-browser-account-details',
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
    const externalRequests: string[] = []
    const allowedOrigins = new Set([new URL(scaffold.authenticatedUrl).origin, account.origin])
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (allowedOrigins.has(url.origin) || ['data:', 'blob:'].includes(url.protocol)) await route.continue()
      else { externalRequests.push(url.origin); await route.abort('blockedbyclient') }
    })
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
    if (profile) {
      await details.getByText('测试编剧', { exact: true }).waitFor()
      await details.getByText('长剧创作组', { exact: true }).waitFor()
      await details.getByText('长剧项目协作', { exact: true }).waitFor()
      await details.getByText('示例公司 / 创作中心 / 编剧部', { exact: true }).waitFor()
      expect(await details.getByText('当前服务尚未提供分组信息，请联系管理员', { exact: true }).count()).toBe(0)
    } else {
      await details.getByText('当前服务尚未提供分组信息，请联系管理员', { exact: true }).waitFor()
      if (organization) await details.getByText('示例公司 / 创作中心 / 编剧部', { exact: true }).waitFor()
      else await details.getByText('当前服务尚未提供飞书部门信息，请联系管理员开通同步', { exact: true }).waitFor()
    }
    expect(await details.getByText('管理员尚未分配分组', { exact: true }).count()).toBe(0)
    expect(await details.getByText('飞书未返回所属部门', { exact: true }).count()).toBe(0)
    expect(await details.getByText(account.accountId, { exact: true }).count()).toBe(1)
    expect(await details.innerText()).toContain('直连、自定义和租用通道未观测')
    const summary = details.locator('[data-muse-usage-summary]')
    const requestCount = summary.locator('div').filter({ has: page.getByText('请求数', { exact: true }) })
    expect(await requestCount.locator('dd').innerText()).toBe('7')
    expect(await summary.innerText()).toContain('40,520')
    const requests = details.getByRole('table', { name: '请求明细', exact: true })
    await requests.getByText('legacy-model-1', { exact: true }).waitFor()
    expect(await requests.locator('tbody tr').count()).toBe(2)
    const unreported = requests.getByRole('row').filter({ hasText: 'legacy-model-2' })
    const headers = await requests.getByRole('columnheader').allTextContents()
    for (const label of ['输入 Token', '输出 Token', '总 Token']) {
      expect(await unreported.getByRole('cell').nth(headers.indexOf(label)).innerText()).toBe('未报告')
    }
    const firstSummary = await summary.innerText()
    await details.getByRole('button', { name: '下一页', exact: true }).click()
    await requests.getByText('legacy-model-7', { exact: true }).waitFor()
    expect(await requests.locator('tbody tr').count()).toBe(5)
    expect(await requests.getByText('legacy-model-1', { exact: true }).count()).toBe(0)
    expect(await summary.innerText()).toBe(firstSummary)
    expect(await details.getByRole('button', { name: '下一页', exact: true }).isDisabled()).toBe(true)
    await details.getByRole('button', { name: '上一页', exact: true }).click()
    await requests.getByText('legacy-model-1', { exact: true }).waitFor()
    expect(await requests.locator('tbody tr').count()).toBe(2)
    expect(await summary.innerText()).toBe(firstSummary)
    const usageReads = account.requests.filter(request => request.path === '/api/muse/usage')
    expect(usageReads.map(request => request.query.cursor ?? null)).toEqual([null, 'fixture-next-page', null])
    expect(usageReads.every(request => request.query.from === usageReads[0]?.query.from
      && request.query.to === usageReads[0]?.query.to)).toBe(true)
    expect(usageReads.every(request => !Object.hasOwn(request.query, 'accountId'))).toBe(true)
    expect(account.requests.every(request => request.authenticated)).toBe(true)
    expect(account.requests.some(request => request.path === '/api/muse.account/details')).toBe(true)
    expect(account.requests.some(request => request.path === '/api/muse/identity')).toBe(true)
    expect(account.requests.some(request => request.path === '/api/muse/profile')).toBe(true)
    if (profile) expect(account.requests.some(request => request.path === '/api/workbench')).toBe(false)
    else expect(account.requests.filter(request => request.path === '/api/workbench').every(request => request.query.scope === 'self')).toBe(true)
    expect(account.requests.some(request => request.path.startsWith('/api/admin/'))).toBe(false)
    expect(account.violations).toEqual([])
    expect(externalRequests).toEqual([])
    expect(await details.innerText()).not.toContain(account.cookie)
    const snapshot = { headings: await details.getByRole('heading').allTextContents(), summary: firstSummary,
      ...(organization ? { department: await details.getByText('示例公司 / 创作中心 / 编剧部', { exact: true }).innerText() } : {}),
    }
    await expect(JSON.stringify(snapshot, null, 2) + '\n').toMatchFileSnapshot(join(REPO_ROOT,
      'apps/web/tests/fixtures/muse-user-legacy-details/'
      + (profile ? 'account-profile.expected.json' : organization ? 'account-organization.expected.json' : 'account.expected.json')))
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
