/** Built authenticated browser exercises real episode services with a controlled renderer; no native-media claim. */
import { mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-tool-jubian'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { VideoRecoveryDigest } from '@deepseek-ai/dsh-tool-jubian/types'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, openSettings, saveFailureShot } from './support.ts'

interface BrowserRendererControl {
  captures: number
  calls: number
  encodes: number
  entered: Promise<void>
  release(): void
}
declare module '@deepseek-ai/cordis' {
  interface Context { episodeBrowserFixture: BrowserRendererControl }
}
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const providerModule = String.raw`/** Test-only renderer provider: real durable journals, controlled candidate bytes, no native-encode claim. */
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const name = 'browser-episode-controlled-renderer'
export async function apply(ctx, config) {
  const library = await import(config.libraryUrl)
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  let entered, release
  const enteredPromise = new Promise(resolve => { entered = resolve })
  const barrier = new Promise(resolve => { release = resolve })
  const lifetime = new AbortController()
  const control = { captures: 0, calls: 0, encodes: 0, entered: enteredPromise, release }
  ctx.effect(() => () => { lifetime.abort(); release() })
  ctx.effect(() => ctx.provide('episodeBrowserFixture', control))
  ctx.effect(() => ctx.provide('approvedEpisodeRenderer', {
    async capture() {
      control.captures++
      return { identity: { generation: randomUUID(), configurationSha256: hash('browser configuration'), codeSha256: hash('controlled browser renderer') },
        runtimeInputs: [], signal: lifetime.signal,
        async render(input, signal) {
          control.calls++; entered()
          const source = input.sources[0], inputs = join(input.job.attemptRoot, 'inputs')
          await mkdir(inputs, { recursive: true })
          const staged = join(inputs, 'original.mp4')
          await copyFile(source.path, staged)
          const facts = await library.hashEpisodeFile(staged, signal)
          await input.job.admit({ approvals: [{ idempotencyKey: source.idempotencyKey, digest: source.digest, sha256: source.sha256 }],
            inputs: [{ path: staged, sha256: facts.sha256, bytes: facts.bytes }] })
          const descriptorPath = join(input.stageRoot, 'descriptor.json'), descriptor = JSON.stringify({ identity: input.identity, execution: input.execution })
          await writeFile(descriptorPath, descriptor)
          const identity = { ...input.identity, execution: input.execution, descriptorSha256: hash(descriptor) }
          const candidatePath = join(input.stageRoot, 'candidate.mp4')
          await input.job.admitExecution({ identity, descriptorPath, candidatePath, retry: input.retry })
          const running = { version: 1, kind: 'running', identity, guardianPid: process.pid }
          await input.job.assertAdmission(identity); await input.job.armExecution(running)
          await writeFile(join(input.job.attemptRoot, 'execution.json'), JSON.stringify(running))
          control.encodes++
          await barrier; signal.throwIfAborted()
          await copyFile(staged, candidatePath)
          const actual = await library.hashEpisodeFile(candidatePath, signal)
          const proof = { ...running, kind: 'drained', commands: 0, result: 'completed',
            candidate: { outputSha256: actual.sha256, outputBytes: actual.bytes } }
          await writeFile(join(input.job.attemptRoot, 'drained-' + input.execution + '.json'), JSON.stringify(proof))
          return { kind: 'drained', proof, candidate: { path: candidatePath, sha256: actual.sha256, bytes: actual.bytes,
            width: 64, height: 64, durationUs: 500000, video: true, audio: true } }
        } }
    },
  }))
}
`

async function browserFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-episode-browser-'))), media = new Context()
  onTestFinished(async () => { try { await media.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await media.plugin(SubprocessLocal).await()
  const configured = process.env.MUSE_RECOVERY_TEST_FFMPEG ?? process.env.DSH_FFMPEG_PATH ?? 'ffmpeg'
  const ffmpeg = await media.subprocess.resolveExecutable(configured)
  const project = join(root, 'project'), directory = join(project, 'video_tasks', 'review'), editing = join(project, 'editing')
  await mkdir(directory, { recursive: true }); await mkdir(editing)
  const generated = join(root, 'source.mp4'), handle = media.subprocess.spawn({ argv: [ffmpeg, '-nostdin', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono',
    '-t', '0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', generated], cwd: root, graceMs: 100,
  stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } } })
  const outcome = await handle.done
  expect(await handle.waitForExit()).toBe(true)
  expect(outcome.exitCode, handle.collected.stderr?.readFrom(0).text).toBe(0)
  const sourceBytes = await readFile(generated), sourceSha = hash(sourceBytes), key = 'original-browser-source'
  await writeFile(join(project, 'project_config.json'), '{"jubian_script_id":1}\n')
  const preview = join(project, 'video_tasks', 'preview.json'); await writeFile(preview, '{}')
  const ledger = new JubianLedger({ root: join(root, 'ledger') })
  await ledger.begin({ idempotencyKey: key, method: 'storyboard_native_submit', requestSha256: 'original', scriptId: 1,
    beforeTaskIds: [], videoPreviewPath: preview })
  const report = JSON.stringify({ idempotency_key: key, task_id: 42, status: 'awaiting_review',
    media_checks: [{ sha256: 'sha256:' + sourceSha, video: true, audio: true }] })
  await writeFile(join(directory, hash(key) + '.json'), report)
  await writeFile(join(directory, 'original-' + sourceSha + '.mp4'), sourceBytes)
  await writeFile(join(editing, '01-episode-delivery.json'), JSON.stringify({ schema_version: 1, episode: 1, total_shots: 1,
    shots: [{ shot: 1, idempotency_key: key, review_digest: hash(report) }], timeline: 'editing/timeline.json',
    subtitle_srt: 'editing/subtitles.srt', mix_profile: 'editing/mix.json' }))
  await writeFile(join(editing, 'timeline.json'), '{"clips":[{"shot":1,"start_us":0,"duration_us":500000}],"body_end":0.5}')
  await writeFile(join(editing, 'subtitles.srt'), '1\n00:00:00,000 --> 00:00:00,500\nFixture\n')
  await writeFile(join(editing, 'mix.json'), '{"schema_version":1,"mode":"no_bgm"}')
  const providerPath = join(root, 'renderer.mjs'); await writeFile(providerPath, providerModule)
  return { root, project, directory, sourceBytes, sourceSha, key, reportDigest: hash(report), ledger, ffmpeg, providerPath }
}

async function openEpisode(page: Page) {
  await openSettings(page, 'en')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('button', { name: 'Jubian', exact: true }).click()
  const region = settings.getByRole('region', { name: 'Episode MP4', exact: true })
  await region.waitFor()
  return region
}

it('keeps original episode tasks across reply loss, reload and offline receipt repair without a second encode', async () => {
  const f = await browserFixture(), home = join(f.root, 'browser-home')
  await mkdir(home)
  vi.stubEnv('MUSE_HOME', home); vi.stubEnv('DSH_HOME', home); vi.stubEnv('DEEPSEEK_API_KEY', '')
  const owned: { browser?: Browser; scaffold?: WebScaffold } = {}
  onTestFinished(async () => {
    try { await owned.browser?.close() }
    finally { try { await owned.scaffold?.close() } finally { vi.unstubAllEnvs(); vi.restoreAllMocks() } }
  })
  const before = await f.ledger.records(), counters = { paid: 0, model: 0, readiness: 0, history: 0, status: 0, admission: 0 }
  const actualFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.startsWith('http://127.0.0.1:1/')) { counters.paid++; throw new Error('Provider access is forbidden in this browser fixture') }
    return actualFetch(input, init)
  })
  const overlay = join(f.root, 'episode.overlay.json')
  await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'tool-jubian', name: '@deepseek-ai/dsh-tool-jubian', config: {
    videoRecoverySettings: true, videoRecoveryFfmpegPath: f.ffmpeg, episodePollIntervalMs: 100,
    ledgerRoot: join(f.root, 'ledger'), workspaceSecrets: false, baseUrl: 'http://127.0.0.1:1',
    characterReferenceQaAuthorizationDataRoot: join(f.root, 'browser-qa'),
    characterReferenceQaAuthorizationDatabasePath: join(f.root, 'browser-qa', 'authorizations.sqlite'),
  } }, { id: 'browser-episode-renderer', name: pathToFileURL(f.providerPath).href, config: {
    libraryUrl: pathToFileURL(fileURLToPath(new URL('../../../packages/jubian/tool-jubian/lib/types/episode-delivery.js', import.meta.url))).href,
  } }] }]))
  const scaffold = await launchWebScaffold({ harnessHome: home,
    extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), overlay],
    extraInstallAnchors: [fileURLToPath(new URL('../../../packages/jubian/tool-jubian/package.json', import.meta.url))] })
  owned.scaffold = scaffold
  const renderer = scaffold.ctx.get('episodeBrowserFixture')
  if (renderer === undefined) throw new Error('The test-only controlled renderer was not mounted by the actual Loader')
  expect([...scaffold.ctx.loader.entries()].some(entry => entry.options.id === 'tool-jubian'
    && entry.options.name === '@deepseek-ai/dsh-tool-jubian')).toBe(true)
  const recovery = scaffold.ctx.get('jubianVideoRecovery'), episode = scaffold.ctx.get('jubianEpisodeDelivery')
  if (recovery === undefined || episode === undefined) throw new Error('Built product overlay did not mount both services')
  await recovery.configure({ enabled: false, projectDir: f.project })
  await recovery.review({ idempotencyKey: f.key, digest: brandString<VideoRecoveryDigest>(f.reportDigest), action: 'approve' })
  scaffold.ctx.on('llm/stream', async function* (_request, next) { counters.model++; yield* next() })
  const browser = await chromium.launch(process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH === undefined
    ? {} : { executablePath: process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH })
  owned.browser = browser
  const page = await newEnglishPage(browser), console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'jubian-episode-delivery'))
  let lose = true
  await page.route('**/api/jubianEpisodeDelivery/*', async (route) => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)
    if (method === 'episodeReadiness') counters.readiness++
    if (method === 'episodeHistory') counters.history++
    if (method === 'episodeStatus') counters.status++
    if (method === 'admitEpisode') {
      counters.admission++
      if (lose) {
        lose = false
        const response = await route.fetch()
        expect(response.ok()).toBe(true)
        await route.abort('failed')
        return
      }
    }
    await route.continue()
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  let region = await openEpisode(page)
  expect(await page.evaluate((): unknown => Reflect.get(globalThis, '__DSH_JUBIAN_EPISODE_UI__'))).toEqual({ episodePollIntervalMs: 100 })
  expect(counters.readiness).toBe(0); expect(counters.history).toBe(0)
  await region.getByRole('button', { name: 'Check export readiness', exact: true }).click()
  const submit = region.getByRole('button', { name: 'Export episode MP4', exact: true })
  await expect.poll(() => submit.isEnabled()).toBe(true)
  await submit.click()
  await renderer.entered
  await region.getByText('Exporting', { exact: true }).waitFor()
  const roots = await episode.episodeHistory({ projectDir: f.project, episode: 1 })
  const original = roots.entries[0]
  if (original === undefined) throw new Error('Committed task was not discoverable after lost reply')
  const target = { projectDir: f.project, episode: 1, digest: original.digest }
  expect(counters.admission).toBe(1); await expect.poll(() => renderer.encodes).toBe(1)
  for (let i = 0; i < 2; i++) {
    const reads = counters.status
    await expect.poll(() => counters.status).toBeGreaterThan(reads)
  }
  expect(counters.readiness).toBe(1)
  renderer.release()
  await region.getByRole('status').filter({ hasText: 'Episode MP4 published' }).waitFor()
  const completed = await episode.episodeStatus(target)
  if (completed.output === undefined) throw new Error('Actual publication receipt was not returned')
  const output = join(f.project, completed.output.path), identity = await stat(output), bytes = await readFile(output)
  const artifacts = fileURLToPath(new URL('../../../.artifacts/web/jubian-episode-delivery', import.meta.url))
  await mkdir(artifacts, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.setViewportSize({ width: scheme === 'light' ? 1280 : 420, height: 900 })
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(scheme === 'dark')
    expect(await region.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    const rect = await region.boundingBox()
    if (rect === null) throw new Error('Episode section was not laid out')
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    await region.screenshot({ path: join(artifacts, scheme + '.png') })
  }
  await unlink(join(f.project, '.muse', 'episode-delivery', original.attempt, 'receipt.json'))
  await unlink(join(f.directory, 'original-' + f.sourceSha + '.mp4'))
  const readCount = counters.readiness
  await page.reload({ waitUntil: 'load' })
  region = await openEpisode(page)
  expect(counters.readiness).toBe(readCount)
  await region.getByRole('button', { name: 'Find original tasks', exact: true }).click()
  const select = region.getByRole('button', { name: 'Select this original task', exact: true })
  await select.waitFor()
  expect(await region.getByRole('button', { name: 'Resume this original task', exact: true }).count()).toBe(0)
  await select.click()
  const resume = region.getByRole('button', { name: 'Resume this original task', exact: true })
  await expect.poll(() => resume.isEnabled()).toBe(true)
  await resume.click()
  await region.getByRole('status').filter({ hasText: 'Episode MP4 published' }).waitFor()
  expect(counters.admission).toBe(2); expect(counters.readiness).toBe(readCount)
  expect(renderer.encodes).toBe(1); expect(renderer.calls).toBe(1)
  expect(await readFile(output)).toEqual(bytes)
  expect((await stat(output)).ino).toBe(identity.ino)
  await expect.poll(async () => {
    const value = await episode.episodeStatus(target)
    return value.state === 'unknown' ? value.state + ': ' + (value.problem ?? '') : value.state
  }).toBe('completed')
  const current = await episode.episodeStatus(target)
  expect(current.attempt).toBe(original.attempt)
  expect(current.state).toBe('completed')
  expect(await f.ledger.records()).toEqual(before)
  expect(counters.paid).toBe(0); expect(counters.model).toBe(0)
  const actual = await captureStableAria(page, '[aria-label="Episode MP4"]', f.root, { replacements: [
    [completed.output.path, '{{published-path}}'],
    [original.attempt, '{{original-attempt}}'], [original.digest, '{{original-digest}}'],
    [completed.output.sha256, '{{output-sha}}'],
  ] })
  await writeFile(join(artifacts, 'restored.actual.md'), actual + '\n')
  const expected = fileURLToPath(new URL('./expected/jubian-episode-delivery/restored.expected.md', import.meta.url))
  await compareOrRefreshGolden(expected, actual, scaffold.mode)
  await writeFile(join(artifacts, 'receipt.json'), JSON.stringify({ actualBuiltBrowser: true, controlledRendererOnly: true,
    nativeMediaAcceptance: false, seedFfmpeg: f.ffmpeg,
    builtHostSha256: hash(await readFile(fileURLToPath(new URL('../../../packages/jubian/tool-jubian/lib/index.js', import.meta.url)))),
    builtClientSha256: hash(await readFile(fileURLToPath(new URL('../../../packages/jubian/tool-jubian/lib/client.js', import.meta.url)))),
    originalAttemptSelected: current.attempt === original.attempt, existingInodePreserved: true,
    rendererEncodes: renderer.encodes, ...counters }, null, 2) + '\n')
  expect(console.pageErrors).toEqual([])
})
