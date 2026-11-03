/** Built website smoke with fixture identity and private releases; no production account or network. */
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { build as viteBuild } from 'vite'
import { expect, it, onTestFinished } from 'vitest'
import { marketDigest, readMarketPackage } from '@deepseek-ai/dsh-muse-market/package'
import type { MarketRelease } from '@deepseek-ai/dsh-muse-market/types'

const policy = { limits: { archiveBytes: 1048576, expandedBytes: 4194304, fileCount: 64 },
  allowedPlugins: ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-tool-skill'], requestTimeoutMs: 10000, metadataBytes: 1048576 }
const publisherId = 'b'.repeat(32) as MarketRelease['publisherId']
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
  + "font-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"

async function fixture(name: string, id: string): Promise<{ release: MarketRelease; bytes: Uint8Array }> {
  const path = new URL('../../../packages/host/muse-market/tests/fixtures/handoff/' + name + '-1.0.0.zip', import.meta.url)
  const bytes = new Uint8Array(await readFile(path))
  return { bytes, release: { id: id as MarketRelease['id'], publisherId, publisher: 'Browser fixture studio',
    sha256: marketDigest(bytes), bytes: bytes.length, status: 'draft', reviewNote: '', revision: 1, createdAt: '2026-11-02T00:00:00Z',
    manifest: readMarketPackage(bytes, policy.limits, policy.allowedPlugins).manifest } }
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

it('renders shared roles, keeps hover frames loaded, previews locally and downloads exact publication bytes', async () => {
  const [bot, skill] = await Promise.all([fixture('storyboard-director', 'a'.repeat(32)), fixture('storyboard-starter', 'c'.repeat(32))])
  const archives = [bot, skill], requests: string[] = [], failures: string[] = [], pending = new Set<Promise<void>>()
  const originalEntries = archives.map(({ release }) => ({
    id: release.manifest.kind === 'bot' ? 'muse/bots/storyboard-director-16-9' : 'muse/skills/' + release.manifest.name,
    kind: release.manifest.kind, name: '首批 ' + release.manifest.title,
    description: release.manifest.description, category: release.manifest.category, version: release.manifest.version,
    requirements: ['测试环境'], sha256: release.sha256, validation: '测试素材',
    package: 'downloads/' + release.manifest.name + (release.manifest.kind === 'bot' ? '.tgz' : '.zip'),
  }))
  const extraSkills = Array.from({ length: 13 }, (_, index) => ({
    ...originalEntries[1]!, id: 'muse/skills/extra-' + String(index), name: '额外技能 ' + String(index),
  }))
  const root = await mkdtemp(join(tmpdir(), 'muse-market-website-'))
  const output = join(root, 'web'), build = pathToFileURL(output + '/')
  const resources: { browser?: Browser } = {}
  const server = createServer((request, response) => {
    const task = (async () => {
      requests.push(`${request.method ?? ''} ${request.url ?? '/'}`)
      const url = new URL(request.url ?? '/', 'http://fixture.invalid')
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
      if (url.pathname === '/api/market/v1/me') { json(response, { publishers: [{ id: publisherId, title: 'Browser fixture studio' }], admin: false }); return }
      if (url.pathname === '/api/market/v1/catalog') { json(response, { items: url.searchParams.get('mine') === 'true' ? archives.map(row => row.release) : [] }); return }
      const archive = archives.find(row => url.pathname === '/api/market/v1/releases/' + row.release.id + '/download')
      if (archive) { response.writeHead(200, { 'content-type': 'application/zip' }); response.end(archive.bytes); return }
      if (url.pathname === '/market/ui/config.json') { json(response, policy); return }
      if (url.pathname === '/market/catalog.json') { json(response, { entries: [...originalEntries, ...extraSkills] }); return }
      if (url.pathname === '/market/manage') {
        response.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': csp })
        response.end(await readFile(new URL('index.html', build))); return
      }
      const name = url.pathname.slice('/market/ui/assets/'.length)
      if (url.pathname.startsWith('/market/ui/assets/') && basename(name) === name) {
        const mime: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2',
          '.woff': 'font/woff', '.ttf': 'font/ttf' }
        response.writeHead(200, { 'content-type': mime[extname(name)] ?? 'application/octet-stream' })
        response.end(await readFile(new URL('assets/' + name, build))); return
      }
      response.writeHead(404); response.end()
    })().catch((error: unknown) => {
      failures.push(String(error))
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
    pending.add(task); void task.finally(() => { pending.delete(task) })
  })
  onTestFinished(async () => {
    try { await resources.browser?.close() }
    finally {
      try {
        if (server.listening) await new Promise<void>((resolve, reject) => {
          server.close((error) => { if (error) reject(error); else resolve() }); server.closeAllConnections()
        })
      } finally {
        await Promise.all(pending)
        await rm(root, { recursive: true, force: true })
      }
    }
  })
  await viteBuild({ configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'silent',
    build: { outDir: output, emptyOutDir: false } })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Fixture did not allocate a TCP port')
  const origin = 'http://127.0.0.1:' + String(address.port)
  const browser = await chromium.launch()
  resources.browser = browser
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, locale: 'zh-CN' })
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === origin) await route.continue()
    else { failures.push('Unexpected external request: ' + route.request().url()); await route.abort() }
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => { failures.push(error.message) })
  page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()) })
  await page.goto(origin + '/market/manage')
  const botCard = page.getByRole('article').filter({ has: page.getByRole('heading', { name: bot.release.manifest.title, exact: true }) })
  const skillCard = page.getByRole('article').filter({ has: page.getByRole('heading', { name: skill.release.manifest.title, exact: true }) })
  await botCard.getByRole('heading').waitFor()
  await skillCard.getByRole('heading').waitFor()
  expect(await page.getByRole('article').count()).toBe(3)
  expect(await page.getByRole('button', { name: '启用', exact: true }).count()).toBe(0)
  const sprite = botCard.locator('[data-playing="true"]')
  await sprite.waitFor({ state: 'visible' })
  await skillCard.getByRole('img').evaluate(image => image instanceof HTMLImageElement ? image.decode() : undefined)
  const sheet = sprite.locator('svg image')
  const audit = await sprite.evaluateHandle((element) => {
    const changes: string[] = []
    const observer = new MutationObserver((records) => {
      for (const record of records) changes.push(`${record.type}:${record.attributeName ?? ''}`)
    })
    observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'data-playing'] })
    return { finish: () => { observer.disconnect(); return changes } }
  })
  const portrait = botCard.getByRole('button', { name: '认识一下', exact: true }).first()
  for (let index = 0; index < 4; index++) {
    await portrait.hover()
    await expect.poll(() => sheet.getAttribute('y')).toBe('-627')
    await skillCard.getByRole('img').hover()
    await expect.poll(() => sheet.getAttribute('y')).toBe('0')
  }
  expect(await audit.evaluate(value => value.finish())).toEqual([])
  await audit.dispose()
  const downloadReady = page.waitForEvent('download')
  await botCard.getByRole('button', { name: '下载发布包', exact: true }).click()
  const download = await downloadReady, path = await download.path()
  if (!path) throw Error('Verified publication did not produce a download')
  expect(new Uint8Array(await readFile(path))).toEqual(bot.bytes)
  expect(download.suggestedFilename()).toBe('storyboard-director-1.0.0.zip')
  const input = page.getByLabel('选择 ZIP 发布包', { exact: true })
  await input.setInputFiles({ name: 'storyboard-director-1.0.0.zip', mimeType: 'application/zip', buffer: Buffer.from(bot.bytes) })
  await page.getByText('storyboard-director-1.0.0.zip', { exact: true }).waitFor()
  expect(await page.getByRole('button', { name: '上传私有草稿', exact: true }).isEnabled()).toBe(true)
  const uploadForm = page.getByRole('region', { name: '上传新的发布包', exact: true })
  const portraitPicker = uploadForm.getByRole('combobox', { name: '发布角色', exact: true })
  await expect.poll(() => portraitPicker.inputValue()).not.toBe('')
  const previewArtwork = uploadForm.getByRole('img', { name: bot.release.manifest.title, exact: true })
  await previewArtwork.evaluate(image => image instanceof HTMLImageElement ? image.decode() : undefined)
  const recommendedArtwork = await previewArtwork.getAttribute('src')
  expect(recommendedArtwork).toBeTruthy()
  await portraitPicker.selectOption('coding-assistant')
  expect(await portraitPicker.inputValue()).toBe('coding-assistant')
  await previewArtwork.evaluate(image => image instanceof HTMLImageElement ? image.decode() : undefined)
  expect(await previewArtwork.getAttribute('src')).not.toBe(recommendedArtwork)
  expect(requests.filter(request => request.startsWith('POST '))).toEqual([])
  expect(requests).not.toContain('GET /market/catalog.json')
  await page.getByRole('button', { name: '发现', exact: true }).click()
  await page.getByRole('heading', { name: originalEntries[0]!.name, exact: true }).waitFor()
  const originalDownloads = page.getByRole('link', { name: '下载原始资源包' })
  expect(await originalDownloads.count()).toBe(12)
  await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight) })
  await expect.poll(() => originalDownloads.count()).toBe(15)
  const featured = page.getByRole('article')
  expect(await featured.nth(0).getByRole('heading').textContent()).toBe(originalEntries[0]!.name)
  expect(await featured.nth(1).getByRole('heading').textContent()).toBe(originalEntries[1]!.name)
  const animatedPortrait = featured.first().getByRole('img', { name: originalEntries[0]!.name })
  await animatedPortrait.evaluate(element => element instanceof HTMLImageElement ? element.decode() : undefined)
  const animationName = () => animatedPortrait.evaluate(element => getComputedStyle(element).animationName)
  expect(await animationName()).not.toBe('none')
  await featured.first().getByRole('button', { name: '认识一下', exact: true }).first().hover()
  await page.getByText('我是' + originalEntries[0]!.name + '。' + originalEntries[0]!.description, { exact: true }).waitFor()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await animationName()).toBe('none')
  await page.getByRole('button', { name: 'Bot', exact: true }).click()
  await expect.poll(() => page.getByRole('link', { name: '下载原始资源包' }).count()).toBe(1)
  expect(await page.getByRole('link', { name: '下载原始资源包' }).getAttribute('href'))
    .toBe('/market/' + originalEntries[0]!.package)
  await page.getByRole('button', { name: 'Skill', exact: true }).click()
  await expect.poll(() => originalDownloads.count()).toBe(12)
  await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight) })
  await expect.poll(() => originalDownloads.count()).toBe(14)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  expect(failures).toEqual([])
})
