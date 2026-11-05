/** Built market smoke with fixture releases and local authoring. */
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { build as viteBuild, preview as vitePreview } from 'vite'
import { expect, it, onTestFinished } from 'vitest'
import { createMarketPackage, marketDigest, readMarketPackage } from '@deepseek-ai/dsh-muse-market/package'
import type { MarketManifest, MarketRelease } from '@deepseek-ai/dsh-muse-market/types'

const policy = { limits: { archiveBytes: 1048576, expandedBytes: 4194304, fileCount: 64 },
  allowedPlugins: ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-tool-skill'], requestTimeoutMs: 10000, metadataBytes: 1048576 }
const publisherId = 'b'.repeat(32) as MarketRelease['publisherId']
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
  + "font-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
const audioSkill = { name: 'audio-transcribe', title: '录音转文字', description: '把录音转成文字。', category: '媒体与交付' }

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

function portraitHeight(portrait: Locator): Promise<number> {
  return portrait.evaluate(element => element.getBoundingClientRect().height)
}

async function portraitSource(artwork: Locator): Promise<string> {
  return artwork.evaluate(async (element) => {
    if (!(element instanceof HTMLImageElement)) throw Error('Skill character did not render as an image')
    await element.decode()
    return element.currentSrc
  })
}

async function fillSkillMetadata(page: Page, skill: Pick<MarketManifest, 'name' | 'title' | 'description' | 'category'>): Promise<void> {
  await page.getByRole('textbox', { name: '发布标识（小写英文与连字符）', exact: true }).fill(skill.name)
  await page.getByRole('textbox', { name: '显示名称', exact: true }).fill(skill.title)
  await page.getByRole('textbox', { name: '介绍', exact: true }).fill(skill.description)
  await page.getByRole('textbox', { name: '分类', exact: true }).fill(skill.category)
}

it('shows only Skills, retains matching characters through previews and downloads exact publication bytes', async () => {
  const [bot, skill] = await Promise.all([fixture('storyboard-director', 'a'.repeat(32)), fixture('storyboard-starter', 'c'.repeat(32))])
  const audioPath = 'skills/audio-transcribe/SKILL.md'
  const examples = Array.from({ length: 8 }, (_, index) => '示例 ' + String(index + 1) + '：' + '转写结束后核对时间码、说话人和漏字。'.repeat(25))
  const audioManifest = { ...skill.release.manifest, ...audioSkill, examples, skills: [{ name: audioSkill.name, path: audioPath }] }
  const audioBytes = createMarketPackage(audioManifest, {
    [audioPath]: Buffer.from('---\nname: audio-transcribe\ndescription: Transcribe audio clips.\n---\n\nReview the transcript.'),
  }, policy.limits, policy.allowedPlugins)
  const publishedSkills = [{ ...skill.release, status: 'published' }, {
    ...skill.release, id: 'd'.repeat(32), status: 'published', manifest: audioManifest,
    sha256: marketDigest(audioBytes), bytes: audioBytes.length,
  }]
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
      if (url.pathname === '/api/market/v1/catalog') {
        const publicItems = publishedSkills.filter(row => row.manifest.name === url.searchParams.get('q'))
        json(response, { items: url.searchParams.get('mine') === 'true' ? archives.map(row => row.release) : publicItems })
        return
      }
      const archive = archives.find(row => url.pathname === '/api/market/v1/releases/' + row.release.id + '/download')
      if (archive) { response.writeHead(200, { 'content-type': 'application/zip' }); response.end(archive.bytes); return }
      if (url.pathname === '/market/ui/config.json') { json(response, policy); return }
      if (url.pathname === '/market/catalog.json') { json(response, { entries: [...originalEntries, ...extraSkills] }); return }
      if (url.pathname === '/market/' || url.pathname === '/market/manage') {
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
  const guide = page.getByRole('dialog', { name: '市场新手指引', exact: true })
  await page.goto(origin + '/market/manage')
  const botCard = page.getByRole('article').filter({ has: page.getByRole('heading', { name: bot.release.manifest.title, exact: true }) })
  const skillCard = page.getByRole('article').filter({ has: page.getByRole('heading', { name: skill.release.manifest.title, exact: true }) })
  await skillCard.getByRole('heading').waitFor()
  expect(await guide.count()).toBe(0)
  expect(await page.getByRole('article').count()).toBe(1)
  expect(await botCard.count()).toBe(0)
  expect(await page.getByRole('button', { name: '启用', exact: true }).count()).toBe(0)
  const publishedPortrait = await portraitSource(skillCard.getByRole('img'))
  expect(publishedPortrait).toContain('storyboard-reviewer')
  const portrait = skillCard.getByRole('button', { name: '认识一下', exact: true }).first()
  const audit = await portrait.getByRole('img').evaluateHandle((element) => {
    const changes: string[] = []
    const observer = new MutationObserver((records) => {
      for (const record of records) changes.push(`${record.type}:${record.attributeName ?? ''}`)
    })
    observer.observe(element, { attributes: true, attributeFilter: ['src', 'hidden'] })
    return { finish: () => { observer.disconnect(); return changes } }
  })
  const marketPortraitHeight = await portraitHeight(portrait)
  for (let index = 0; index < 4; index++) {
    await portrait.hover()
    await page.locator('strong').filter({ hasText: skill.release.manifest.title }).waitFor()
    expect(await portraitHeight(portrait)).toBe(marketPortraitHeight)
    await page.mouse.move(4, 4)
    await page.locator('strong').filter({ hasText: skill.release.manifest.title }).waitFor({ state: 'hidden' })
    expect(await portraitSource(skillCard.getByRole('img'))).toBe(publishedPortrait)
  }
  expect(await audit.evaluate(value => value.finish())).toEqual([])
  await audit.dispose()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await portraitHeight(portrait)).toBe(marketPortraitHeight)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const downloadReady = page.waitForEvent('download')
  await skillCard.getByRole('button', { name: '下载发布包', exact: true }).click()
  const download = await downloadReady, path = await download.path()
  if (!path) throw Error('Verified publication did not produce a download')
  expect(new Uint8Array(await readFile(path))).toEqual(skill.bytes)
  expect(download.suggestedFilename()).toBe('storyboard-starter-1.0.0.zip')
  const input = page.getByLabel('选择 ZIP 发布包', { exact: true })
  expect(await input.count()).toBe(0)
  const beforeCreator = requests.length
  await Promise.all([
    page.waitForURL(origin + '/market/manage?view=upload'),
    page.getByRole('button', { name: '上传 Skill', exact: true }).click(),
  ])
  await input.waitFor()
  expect(await guide.count()).toBe(0)
  expect(await botCard.count()).toBe(0)
  expect(await skillCard.count()).toBe(0)
  await page.getByText('等待选择发布包', { exact: true }).waitFor()
  expect(await page.getByRole('button', { name: '认识一下', exact: true }).count()).toBe(0)
  await input.setInputFiles({ name: 'storyboard-director-1.0.0.zip', mimeType: 'application/zip', buffer: Buffer.from(bot.bytes) })
  await page.getByRole('alert').filter({ hasText: '市场仅支持 Skill' }).waitFor()
  expect(await page.getByRole('button', { name: '上传私有草稿', exact: true }).isEnabled()).toBe(false)
  const uploadForm = page.getByRole('region', { name: '上传新的发布包', exact: true })
  expect(await uploadForm.getByRole('combobox', { name: '发布角色', exact: true }).count()).toBe(0)
  await input.setInputFiles({ name: 'storyboard-starter-1.0.0.zip', mimeType: 'application/zip', buffer: Buffer.from(skill.bytes) })
  const previewArtwork = uploadForm.getByRole('img', { name: skill.release.manifest.title, exact: true })
  expect(await portraitSource(previewArtwork)).toBe(publishedPortrait)
  expect(await page.getByRole('button', { name: '上传私有草稿', exact: true }).isEnabled()).toBe(true)
  const previewPortrait = uploadForm.getByRole('button', { name: '认识一下', exact: true }).first()
  expect(await portraitHeight(previewPortrait)).toBe(marketPortraitHeight)
  await input.setInputFiles({ name: 'audio-transcribe-1.0.0.zip', mimeType: 'application/zip', buffer: Buffer.from(audioBytes) })
  const audioPreviewPortrait = await portraitSource(uploadForm.getByRole('img', { name: audioSkill.title, exact: true }))
  expect(audioPreviewPortrait).toContain('sound-designer')
  expect(requests.slice(beforeCreator).filter(request => request.startsWith('GET /api/market/v1/catalog'))).toEqual([])
  expect(requests.filter(request => request.startsWith('POST '))).toEqual([])
  expect(requests).not.toContain('GET /market/catalog.json')
  await Promise.all([
    page.waitForURL(origin + '/market/manage'),
    page.getByRole('button', { name: '返回市场', exact: true }).click(),
  ])
  await skillCard.getByRole('heading').waitFor()
  expect(await botCard.count()).toBe(0)
  expect(await input.count()).toBe(0)
  await page.goto(origin + '/market/')
  await guide.waitFor()
  const nextGuideStep = guide.getByRole('button', { name: '下一步', exact: true })
  expect(await nextGuideStep.evaluate(element => element === document.activeElement)).toBe(true)
  await nextGuideStep.click()
  await guide.getByRole('button', { name: '上一步', exact: true }).click()
  await nextGuideStep.click()
  await nextGuideStep.click()
  await guide.getByRole('button', { name: '开始探索', exact: true }).click()
  await guide.waitFor({ state: 'hidden' })
  await page.reload()
  await page.getByRole('heading', { name: originalEntries[1]!.name, exact: true }).waitFor()
  expect(await guide.count()).toBe(0)
  const replayGuide = page.getByRole('button', { name: '市场指引', exact: true })
  await replayGuide.click()
  await nextGuideStep.waitFor()
  await page.keyboard.press('Escape')
  await guide.waitFor({ state: 'hidden' })
  expect(await replayGuide.evaluate(element => element === document.activeElement)).toBe(true)
  const originalDownloads = page.getByRole('link', { name: '下载原始资源包' })
  expect(await originalDownloads.count()).toBe(12)
  await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight) })
  await expect.poll(() => originalDownloads.count()).toBe(14)
  const featured = page.getByRole('article')
  expect(await featured.nth(0).getByRole('heading').textContent()).toBe(originalEntries[1]!.name)
  expect(await page.getByRole('heading', { name: originalEntries[0]!.name, exact: true }).count()).toBe(0)
  const animatedPortrait = featured.first().getByRole('img', { name: originalEntries[1]!.name })
  expect(await portraitSource(animatedPortrait)).toBe(publishedPortrait)
  await animatedPortrait.evaluate(element => element instanceof HTMLImageElement ? element.decode() : undefined)
  const animationName = () => animatedPortrait.evaluate((element) => {
    if (!element.parentElement) throw Error('Missing catalog animation layer')
    return getComputedStyle(element.parentElement).animationName
  })
  expect(await animationName()).not.toBe('none')
  const originalPortrait = featured.first().getByRole('button', { name: '认识一下', exact: true }).first()
  expect(await portraitHeight(originalPortrait)).toBe(marketPortraitHeight)
  await originalPortrait.hover()
  await page.locator('strong').filter({ hasText: originalEntries[1]!.name }).waitFor()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await animationName()).toBe('none')
  expect(await page.getByRole('button', { name: 'Bot', exact: true }).count()).toBe(0)
  expect(await page.getByRole('button', { name: '制作 Bot', exact: true }).count()).toBe(0)
  await page.getByRole('textbox', { name: '搜索名称、用途或制作组', exact: true }).fill(skill.release.manifest.name)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  expect(await portraitSource(skillCard.getByRole('img'))).toBe(publishedPortrait)
  await page.getByRole('textbox', { name: '搜索名称、用途或制作组', exact: true }).fill(audioSkill.name)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  expect(await portraitSource(page.getByRole('img', { name: audioSkill.title, exact: true }))).toBe(audioPreviewPortrait)
  const viewAudioDetails = page.getByRole('article').filter({ has: page.getByRole('heading', { name: audioSkill.title, exact: true }) })
    .getByRole('button', { name: '查看详情', exact: true })
  const detail = page.getByRole('dialog', { name: audioSkill.title, exact: true })
  const closeDetails = detail.getByRole('button', { name: '关闭详情', exact: true })
  const finalExample = detail.getByText(examples.at(-1)!, { exact: true })
  for (const viewport of [{ width: 1282, height: 821 }, { width: 390, height: 620 }]) {
    await page.setViewportSize(viewport)
    await viewAudioDetails.click()
    const closeTop = await closeDetails.evaluate(element => element.getBoundingClientRect().top)
    expect(closeTop).toBeGreaterThanOrEqual(0)
    expect(await finalExample.evaluate(element => element.getBoundingClientRect().bottom)).toBeGreaterThan(viewport.height)
    await page.keyboard.press('Tab')
    await page.keyboard.press('End')
    await expect.poll(() => finalExample.evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThan(viewport.height)
    expect(await closeDetails.evaluate(element => element.getBoundingClientRect().top)).toBe(closeTop)
    await page.keyboard.press('Escape')
    await detail.waitFor({ state: 'hidden' })
    expect(await viewAudioDetails.evaluate(element => element === document.activeElement)).toBe(true)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  expect(failures).toEqual([])
})

it('automatically assigns profession characters to Skills while keeping their preview size stable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-market-portrait-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const configFile = fileURLToPath(new URL('../../../packages/client/ui-muse-account/tests/market-preview/vite.config.ts', import.meta.url))
  const build = { outDir: root, emptyOutDir: false }
  await viteBuild({ configFile, logLevel: 'silent', build })
  const preview = await vitePreview({ configFile, logLevel: 'silent', build, preview: { host: '127.0.0.1', port: 0 } })
  onTestFinished(() => preview.close())
  const address = preview.httpServer.address()
  if (!address || typeof address === 'string') throw Error('Fixture did not allocate a TCP port')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, reducedMotion: 'reduce' })
  await page.goto('http://127.0.0.1:' + String(address.port))
  const guide = page.getByRole('dialog', { name: '市场新手指引', exact: true })
  await guide.getByRole('button', { name: '跳过指引', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: '制作 Skill', exact: true }).click()
  const { release: { manifest: skill } } = await fixture('storyboard-starter', 'c'.repeat(32))
  const previewPortrait = page.getByRole('button', { name: '认识一下', exact: true }).first()
  const height = await portraitHeight(previewPortrait)
  await fillSkillMetadata(page, skill)
  expect(await portraitSource(page.getByRole('img', { name: skill.title, exact: true }))).toContain('storyboard-reviewer')
  await fillSkillMetadata(page, audioSkill)
  expect(await portraitSource(page.getByRole('img', { name: audioSkill.title, exact: true }))).toContain('sound-designer')
  expect(await portraitHeight(previewPortrait)).toBe(height)
  await fillSkillMetadata(page, { name: 'image-grading', title: '调色师', description: '统一镜头的色彩。', category: '后期制作' })
  expect(await portraitSource(page.getByRole('img', { name: '调色师', exact: true }))).toContain('colorist')
  expect(await portraitHeight(previewPortrait)).toBe(height)
  await fillSkillMetadata(page, { name: 'code-review', title: '编程助手', description: '检查代码。', category: '编程开发' })
  expect(await portraitSource(page.getByRole('img', { name: '编程助手', exact: true }))).toContain('coding-assistant')
  expect(await portraitHeight(previewPortrait)).toBe(height)
  expect(await page.getByRole('button', { name: '制作 Bot', exact: true }).count()).toBe(0)
  expect(await page.getByRole('combobox', { name: '发布角色', exact: true }).count()).toBe(0)
  expect(await page.getByLabel(/角色形象（PNG/u).count()).toBe(0)
  expect(await page.getByRole('button', { name: '生成候选形象', exact: true }).count()).toBe(0)
})
