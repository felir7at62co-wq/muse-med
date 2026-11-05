/** Authenticated built Host and browser recovery, real media and exact local file receipts. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { buildNativeVideoPreview } from '@deepseek-ai/dsh-jubian-api'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import type {} from '@deepseek-ai/dsh-tool-jubian'
import type {} from '@deepseek-ai/dsh-host-directory-picker'
import { chromium, type Browser, type Page, type WebSocketRoute } from 'playwright'
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const packageDir = fileURLToPath(new URL('../../../packages/jubian/tool-jubian', import.meta.url))
const expected = fileURLToPath(new URL('./expected/jubian-video-recovery', import.meta.url))
const artifacts = fileURLToPath(new URL('../../../.artifacts/web/jubian-video-recovery', import.meta.url))
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

function preview(storyboardId: number) {
  const url = 'https://jubian-aigc.tos-cn-beijing.volces.com/fixture/recovery-lead.jpg'
  const model = { modelId: 'doubao-seedance-2-0-260128', platformId: 'YU_DIAN', standardId: 11,
    genType: 3, modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, genNum: 1,
    ratio: '9:16', resolution: '720p', prompt: '@[Lead](lead)', materialList: [], backupModelList: [] }
  return buildNativeVideoPreview({ createdAt: '2026-11-05T00:00:00Z',
    storyboard: { id: storyboardId, scriptId: 2708, episodeId: 9, episodeCount: 1, modelConfig: JSON.stringify(model),
      storyboardMaterialList: [{ assetId: 'lead-id', materialAssetId: 81285, fileName: 'Lead', materialKey: 'lead',
        materialType: 'image', materialUrl: url, sortOrder: 1 }] },
    assets: [{ id: 81285, scriptId: 2708, assetUrl: url, hsAssetId: 'lead-id', hsAssetStatus: 'Active',
      isUsed: 1, official: true, asset_status: 'confirmed' }],
    models: [{ ...model, id: 11, genTypes: [{ id: 7, type: 3 }],
      videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p', genNum: 1 }] }],
  })
}

async function openRecovery(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('button', { name: 'Jubian', exact: true }).click()
  const region = settings.getByRole('region', { name: 'Project video recovery', exact: true })
  await region.waitFor()
  return region
}

it('reviews real media, retains reports across reconnect and delivers exact approved MP4s offline', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-recovery-browser-')))
  const media = new Context()
  const resources: { browser?: Browser; scaffold?: WebScaffold } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() }
    finally {
      try { await resources.scaffold?.close() }
      finally {
        try { await media.fiber.dispose() }
        finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
      }
    }
  })
  const home = join(root, 'home'), project = join(root, 'project'), tasks = join(project, 'video_tasks')
  const review = join(tasks, 'review')
  await mkdir(review, { recursive: true })
  await mkdir(home)
  vi.stubEnv('MUSE_HOME', home)
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('DEEPSEEK_API_KEY', '')
  vi.stubEnv('JUBIANAI_ADMIN_TOKEN', 'offline-recovery-browser-fixture')
  await media.plugin(SubprocessLocal).await()
  const configured = process.env.MUSE_RECOVERY_TEST_FFMPEG ?? process.env.DSH_FFMPEG_PATH ?? 'ffmpeg'
  const ffmpeg = await media.subprocess.resolveExecutable(configured)
  const signal = new AbortController().signal
  const generate = async (path: string, audio: boolean, color: string): Promise<Buffer> => {
    const handle = media.subprocess.spawn({ argv: [ffmpeg, '-nostdin', '-v', 'error', '-f', 'lavfi',
      '-i', `color=c=${color}:s=64x64:r=10`, ...(audio ? ['-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono'] : []),
      '-t', '0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac'] : ['-an']), path],
    cwd: root, graceMs: 100, signal,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } } })
    const outcome = await handle.done
    expect(await handle.waitForExit()).toBe(true)
    expect(outcome.exitCode, handle.collected.stderr?.readFrom(0).text).toBe(0)
    return readFile(path)
  }
  const original = await generate(join(root, 'provider.mp4'), true, 'black')
  const silent = await generate(join(root, 'silent.mp4'), false, 'blue')
  const importedPath = 'video_tasks/local-edit.mp4'
  const imported = await generate(join(project, importedPath), true, 'red')
  const originalSha = hash(original), silentSha = hash(silent), importedSha = hash(imported)
  await writeFile(join(project, 'project_config.json'), '{"jubian_script_id":2708}\n')
  const ledger = new JubianLedger({ root: join(home, 'jubian', 'ledger') })
  const rows = [{ preview: preview(1), task: 4201, sha: originalSha, bytes: original, audio: true },
    { preview: preview(2), task: 4202, sha: silentSha, bytes: silent, audio: false }]
  for (const row of rows) {
    const path = join(tasks, row.preview.idempotencyKey + '.storyboard-native.prepared.json')
    await writeFile(path, JSON.stringify(row.preview) + '\n')
    await ledger.begin({ idempotencyKey: row.preview.idempotencyKey, method: 'storyboard_native_submit', scriptId: 2708,
      requestSha256: 'sha256:' + hash(JSON.stringify(row.preview.payload)), beforeTaskIds: [], videoPreviewPath: path })
    await writeFile(join(review, 'original-' + row.sha + '.mp4'), row.bytes)
    await writeFile(join(review, hash(row.preview.idempotencyKey) + '.json'), JSON.stringify({
      idempotency_key: row.preview.idempotencyKey, task_id: row.task, status: 'awaiting_review',
      media_checks: [{ sha256: 'sha256:' + row.sha, video: true, audio: row.audio }],
    }))
  }
  const ledgerBefore = await ledger.records()
  const counters = { generationPuts: 0, providerRequests: 0, modelCalls: 0 }
  const fetch = globalThis.fetch
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.startsWith('http://127.0.0.1:1/')) {
      counters.providerRequests++
      if (init?.method === 'PUT') counters.generationPuts++
      throw new Error('Recovery UI fixture must not access a provider')
    }
    return fetch(input, init)
  })
  onTestFinished(() => { transport.mockRestore() })
  const overlay = join(root, 'recovery.overlay.json')
  await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'tool-jubian', name: '@deepseek-ai/dsh-tool-jubian', config: {
    videoRecoverySettings: true, videoRecoveryFfmpegPath: ffmpeg, videoRecoveryDecodeTimeoutMs: 5000,
    workspaceSecrets: false, baseUrl: 'http://127.0.0.1:1',
  } }] }]))
  const scaffold = await launchWebScaffold({ harnessHome: home, extraOverlayPath: overlay,
    extraInstallAnchors: [join(packageDir, 'package.json')] })
  resources.scaffold = scaffold
  scaffold.ctx.on('llm/stream', async function* (_request, next) { counters.modelCalls++; yield* next() })
  const hostEntry = [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'tool-jubian')
  expect(hostEntry?.options.name).toBe('@deepseek-ai/dsh-tool-jubian')
  expect(scaffold.ctx.directoryPicker.capability().kind).toBe('browse')
  const browser = await chromium.launch(process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH === undefined
    ? {} : { executablePath: process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH })
  resources.browser = browser
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'muse-video-recovery'))
  const console = watchConsole(page)
  page.on('pageerror', (error) => { process.stderr.write(String(error) + '\n') })
  page.on('console', (message) => { if (message.type() === 'error') process.stderr.write(message.text() + '\n') })
  const sockets: { client: WebSocketRoute; server: WebSocketRoute }[] = []
  const waiting = new Set<WebSocketRoute>()
  let connect = true, ready = 0
  const relay = (client: WebSocketRoute): void => {
    const server = client.connectToServer()
    sockets.push({ client, server })
    client.onMessage((message) => { server.send(message) })
    server.onMessage((message) => {
      if (typeof message === 'string') {
        const frame = JSON.parse(message) as { type?: string; value?: { type?: string } }
        if (frame.type === 'item' && frame.value?.type === 'ready') ready++
      }
      client.send(message)
    })
  }
  await page.routeWebSocket('**/api/remote.mux', (client) => {
    if (connect) relay(client)
    else { waiting.add(client); client.onClose(() => { waiting.delete(client) }) }
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await mkdir(artifacts, { recursive: true })
  await page.screenshot({ path: join(artifacts, 'boot.png') })
  await writeFile(join(artifacts, 'boot.html'), await page.content())
  const region = await openRecovery(page)
  await region.getByText('Recovery disabled', { exact: true }).waitFor()
  expect(await region.getByRole('button', { name: 'Choose folder', exact: true }).count()).toBe(0)
  await region.getByRole('textbox', { name: 'Project folder', exact: true }).fill(project)
  await region.getByRole('button', { name: 'Enable recovery', exact: true }).click()
  await region.getByText('Recovery enabled', { exact: true }).waitFor()
  const first = region.getByRole('article').filter({ hasText: 'Task 4201' })
  const second = region.getByRole('article').filter({ hasText: 'Task 4202' })
  await first.getByText('Current source file verified', { exact: true }).waitFor()
  await second.getByText('Video decodes · Audio could not be decoded', { exact: true }).waitFor()
  expect(await second.getByRole('button', { name: 'Approve video', exact: true }).isDisabled()).toBe(true)
  const captures: { path: string; actual: string }[] = []
  const replacements: [string, string][] = [[project, '{{project}}'], [originalSha, '{{original-sha}}'],
    [silentSha, '{{silent-sha}}'], [importedSha, '{{imported-sha}}']]
  const capture = async (name: string): Promise<void> => {
    const actual = await captureStableAria(page, '[aria-label="Project video recovery"]', root, { replacements })
    await mkdir(artifacts, { recursive: true })
    await writeFile(join(artifacts, name + '.actual.md'), actual + '\n')
    captures.push({ path: join(expected, name + '.expected.md'), actual })
  }
  await capture('reports')
  await second.getByRole('button', { name: 'Import local video', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Import local video', exact: true })
  await dialog.getByRole('textbox', { name: 'Local video path', exact: true }).fill(importedPath)
  await dialog.getByRole('button', { name: 'Import local video', exact: true }).click()
  await second.getByText('Local imported version', { exact: true }).waitFor()
  const markerPath = join(review, hash(rows[1]!.preview.idempotencyKey) + '.json.decision.json')
  const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { filename: string }
  const managed = 'video_tasks/review/' + marker.filename
  replacements.push([managed, '{{managed-video}}'])
  await second.getByRole('button', { name: 'Approve video', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Approve video', exact: true })
  await dialog.getByText(managed, { exact: true }).waitFor()
  await dialog.getByText('SHA-256 ' + importedSha, { exact: true }).waitFor()
  await page.setViewportSize({ width: 420, height: 900 })
  await dialog.evaluate(async (element) => {
    for (let node: Element | null = element; node !== null && node !== document.body; node = node.parentElement) {
      await Promise.all(node.getAnimations().map(animation => animation.finished))
    }
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished))
  })
  await expect.poll(() => dialog.evaluate((element) => {
    let opacity = 1
    for (let node: Element | null = element; node !== null && node !== document.body; node = node.parentElement) {
      opacity *= Number.parseFloat(getComputedStyle(node).opacity)
    }
    return opacity
  })).toBe(1)
  expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: join(artifacts, 'approval-narrow.png') })
  await page.setViewportSize({ width: 1680, height: 1000 })
  await dialog.getByRole('button', { name: 'Approve video', exact: true }).click()
  await second.getByText('Approved', { exact: true }).waitFor()
  await first.getByRole('button', { name: 'Reject video', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Reject video', exact: true })
  await dialog.getByRole('textbox', { name: 'Reason', exact: true }).fill('Review the whole sequence')
  await dialog.getByRole('button', { name: 'Reject video', exact: true }).click()
  await first.getByText('Rejected', { exact: true }).waitFor()
  await first.getByRole('button', { name: 'Reopen review', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Reopen review', exact: true })
  await dialog.getByRole('textbox', { name: 'Reason', exact: true }).fill('Checked the complete clip')
  await dialog.getByRole('button', { name: 'Reopen review', exact: true }).click()
  await first.getByRole('button', { name: 'Approve video', exact: true }).click()
  await page.getByRole('dialog', { name: 'Approve video', exact: true }).getByRole('button', { name: 'Approve video', exact: true }).click()
  await first.getByText('Approved', { exact: true }).waitFor()
  await capture('reviewed')
  const priorReady = ready
  connect = false
  const active = sockets.at(-1)
  if (active === undefined) throw new Error('Authenticated Remote mux was not opened')
  await Promise.all([active.client.close({ code: 1012, reason: 'recovery fixture loss' }), active.server.close({ code: 1012, reason: 'recovery fixture loss' })])
  await region.getByText('Connection unavailable. Previously loaded reports remain visible.', { exact: true }).waitFor()
  expect(await region.getByRole('article').count()).toBe(2)
  connect = true
  for (const client of waiting) relay(client)
  waiting.clear()
  await expect.poll(() => ready, { timeout: 20_000 }).toBeGreaterThan(priorReady)
  await region.getByRole('button', { name: 'Refresh reports', exact: true }).waitFor({ state: 'visible' })
  await expect.poll(() => region.getByRole('button', { name: 'Refresh reports', exact: true }).isEnabled()).toBe(true)
  await first.getByRole('button', { name: 'Deliver MP4 directly', exact: true }).click()
  await first.getByText('MP4 delivered directly', { exact: true }).waitFor()
  await second.getByRole('button', { name: 'Deliver MP4 directly', exact: true }).click()
  await second.getByText('MP4 delivered directly', { exact: true }).waitFor()
  const files = await Promise.all(rows.map(async (row) => {
    const article = region.getByRole('article').filter({ hasText: 'Task ' + String(row.task) })
    const digest = (await article.locator('details code').allTextContents()).at(-1)
    if (digest === undefined || !/^[a-f0-9]{64}$/u.test(digest)) throw new Error('Displayed review digest is missing')
    const receipt: unknown = JSON.parse(await readFile(join(review, digest + '.direct-delivery.json'), 'utf8'))
    if (receipt === null || typeof receipt !== 'object' || !('path' in receipt) || typeof receipt.path !== 'string'
      || !('sha256' in receipt) || typeof receipt.sha256 !== 'string') throw new Error('Actual delivery receipt is invalid')
    expect(receipt.path).toBe('exports/Muse-approved-' + String(row.task) + '-' + digest + '.mp4')
    expect(receipt.sha256).toBe(row.task === 4201 ? originalSha : importedSha)
    replacements.push([digest, row.task === 4201 ? '{{original-review}}' : '{{imported-review}}'])
    const path = join(project, receipt.path)
    const identity = await stat(path)
    expect(hash(await readFile(path))).toBe(row.task === 4201 ? originalSha : importedSha)
    return { taskId: row.task, digest, path, identity }
  }))
  await capture('direct-delivery')
  await unlink(files[0]!.path)
  await first.getByRole('button', { name: 'Deliver MP4 directly', exact: true }).click()
  await expect.poll(async () => {
    try { return hash(await readFile(files[0]!.path)) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  }).toBe(originalSha)
  await expect.poll(() => first.getByRole('button', { name: 'Deliver MP4 directly', exact: true }).isEnabled()).toBe(true)
  files[0]!.identity = await stat(files[0]!.path)
  for (const [index, file] of files.entries()) {
    const source = index === 0 ? join(review, 'original-' + originalSha + '.mp4') : join(project, managed)
    await unlink(source)
    await unlink(join(review, file.digest + '.direct-delivery.json'))
    const article = region.getByRole('article').filter({ hasText: 'Task ' + String(file.taskId) })
    await article.getByRole('button', { name: 'Deliver MP4 directly', exact: true }).click()
    await article.getByText(index === 0
      ? 'The original video is not cached locally.'
      : 'The recorded local video is currently missing.', { exact: true }).waitFor()
    await expect.poll(async () => hash(await readFile(file.path))).toBe(index === 0 ? originalSha : importedSha)
    await expect.poll(async () => (await stat(file.path)).ino).toBe(file.identity.ino)
    await readFile(join(review, file.digest + '.direct-delivery.json'))
  }
  await capture('source-unavailable')
  await writeFile(files[0]!.path, 'occupied different bytes')
  await first.getByRole('button', { name: 'Deliver MP4 directly', exact: true }).click()
  await page.getByText(/Could not complete:/).waitFor()
  expect(await readFile(files[0]!.path, 'utf8')).toBe('occupied different bytes')
  await region.getByRole('button', { name: 'Refresh reports', exact: true }).click()
  await first.getByText('The export file has changed. It will not be overwritten.', { exact: true }).waitFor()
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(theme === 'dark')
    await page.setViewportSize({ width: theme === 'light' ? 1280 : 620, height: 900 })
    await page.screenshot({ path: join(artifacts, theme + '.png') })
  }
  expect(await ledger.records()).toEqual(ledgerBefore)
  expect(console.pageErrors).toEqual([])
  expect(counters).toEqual({ generationPuts: 0, providerRequests: 0, modelCalls: 0 })
  const proof = { builtHostEntry: join(packageDir, 'lib/index.js'), builtHostSha256: hash(await readFile(join(packageDir, 'lib/index.js'))),
    frontend: 'apps/web/dist', ffmpeg, ...counters, newIntents: (await ledger.records()).length - ledgerBefore.length, authenticated: true,
    sourceChecked: true, deletedOutputRestored: true, realImportDecoder: true, reconnectedWithRows: true, directBytesVerified: true,
    originalAndImportedOfflineReceiptRepair: true, preservedInodes: true, changedDestinationPreserved: true,
    boundary: 'built web composition and generated Remote; not installed Electron or Windows' }
  await writeFile(join(artifacts, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
  const comparisons = await Promise.allSettled(captures.map(item => compareOrRefreshGolden(item.path, item.actual, webSnapshotMode())))
  const failures: unknown[] = []
  for (const item of comparisons) {
    if (item.status === 'rejected') { const reason: unknown = item.reason; failures.push(reason) }
  }
  if (failures.length) throw new AggregateError(failures, 'Recovery UI expectations require owner-local review')
})
