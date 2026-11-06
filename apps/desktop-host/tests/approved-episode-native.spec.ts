/** Production ToolJubian composition and actual source guardian produce one verified local episode. */
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, copyFile, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { initProfile, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { guardianEnvironment } from '../src/episode-guardian-launcher.ts'
import { createVideoRecoveryProjectFixture } from '../../../packages/jubian/tool-jubian/tests/fixtures/video-recovery-service.ts'

const ffmpeg = process.env.MUSE_EPISODE_TEST_FFMPEG
const ffprobe = process.env.MUSE_EPISODE_TEST_FFPROBE
const font = process.env.MUSE_EPISODE_TEST_FONT
const enabled = process.platform === 'darwin' && ffmpeg !== undefined && ffprobe !== undefined && font !== undefined
const execute = promisify(execFile)

async function fixture(tamper = false) {
  if (ffmpeg === undefined || ffprobe === undefined || font === undefined) throw new Error('Explicit reviewed native resources are required')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-approved-native-')))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const source = join(root, 'synthetic.mp4')
  await execute(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=s=1440x2560:r=60,noise=alls=60:allf=t+u', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '1', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '16M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source],
  { timeout: 90000, maxBuffer: 131072 })
  const data = await createVideoRecoveryProjectFixture({ sourceBytes: await readFile(source) })
  await writeFile(join(data.project, 'project_config.json'), JSON.stringify({ jubian_script_id: 1,
    project_bible: { visual_medium: 'animation_3d', delivery: { width: 1440, height: 2560, fps: 60 } } }))
  const editing = join(data.project, 'editing'); await mkdir(editing)
  await writeFile(join(editing, '01-episode-delivery.json'), JSON.stringify({ schema_version: 1, episode: 1, total_shots: 1,
    shots: [{ shot: 1, idempotency_key: data.key, review_digest: data.input.digest }],
    timeline: 'editing/timeline.json', subtitle_srt: 'editing/subtitle.srt', mix_profile: 'editing/mix.json' }))
  await writeFile(join(editing, 'timeline.json'), JSON.stringify({ clips: [{ shot: 1, start_us: 0, duration_us: 1000000 }], body_end: 1,
    delivery: { width: 1440, height: 2560, fps: 60, visual_medium: 'animation_3d' } }))
  await writeFile(join(editing, 'subtitle.srt'), '1\n00:00:00,000 --> 00:00:00,900\n原声保留\n')
  await writeFile(join(editing, 'mix.json'), '{"schema_version":1,"mode":"no_bgm","analysis_window_ms":50,"original_gain":1,"music_gain":0}')
  const fonts = join(root, 'fonts'); await mkdir(fonts); await copyFile(font, join(fonts, 'NotoSansCJKsc-Regular.otf'))
  const home = join(root, 'home'); await mkdir(home)
  const profile = resolveProfileDir('approved-episode-native', home); initProfile(profile, [])
  let run = 0
  const launchHost = async (resume = false) => {
    const result = join(root, `result-${++run}.json`), patch = join(root, `host-${run}.overlay.json`)
    const moduleUrl = (path: string) => new URL(path, import.meta.url).href
    await writeFile(patch, JSON.stringify([{ insert: [
      { id: 'subprocess', name: moduleUrl('../../../packages/subprocess/subprocess-local/src/index.ts') },
      { id: 'system-prompt', name: moduleUrl('../../../packages/core/system-prompt/src/index.ts') },
      { id: 'tools', name: moduleUrl('../../../packages/core/tools/src/index.ts') },
      { id: 'credentials', name: moduleUrl('../../../packages/credentials/credentials-local/src/index.ts'), config: { path: join(home, 'credentials.yml'), watch: false } },
      { id: 'native-fixture', name: moduleUrl('./fixtures/approved-episode-native-host.mjs'), config: {
        project: data.project, ledgerRoot: join(data.root, 'ledger'), review: data.input, result, ffmpeg, resume,
        endingAssetRoot: fileURLToPath(new URL('../../../packages/drama/skills/skills', import.meta.url)),
        limits: { requestBytes: 4096, replyBytes: 16384, descriptorBytes: 4194304, journalBytes: 2097152, lockWaitMs: 30000,
          mediaGraceMs: 1000, mediaStdoutBytes: 8388608, mediaStderrBytes: 8388608, diagnosticBytes: 8192, runtimeEntries: 4096 },
        carrier: { kind: 'source-fixture', executable: process.execPath, cli: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)),
          tsxEsm: import.meta.resolve('tsx/esm'), tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
          subprocessEntry: fileURLToPath(new URL('../../../packages/subprocess/subprocess-local/src/index.ts', import.meta.url)),
          workerEntry: fileURLToPath(new URL(tamper ? './fixtures/approved-episode-tamper-worker.mjs' : '../src/episode-render-worker.ts', import.meta.url)) },
      } },
    ] }]))
    const env = { ...guardianEnvironment(home, process.platform), DSH_FFMPEG_PATH: ffmpeg, DSH_FFPROBE_PATH: ffprobe,
      MUSE_FONTS_DIR: fonts, MUSE_SUBTITLE_FONT_FAMILY: 'Noto Sans CJK SC', MUSE_WATERMARK_FONT_FAMILY: 'Noto Sans CJK SC' }
    const launch = resolveExampleLaunch({ mode: 'src', srcBin: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)),
      sourceImport: 'tsx/esm', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
      configArgs: ['--profile', 'approved-episode-native', '--patch', patch], env })
    const child = spawn(launch.command, ['--expose-internals', ...launch.args], { cwd: profile, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    let diagnostic = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', (bytes: Buffer) => { diagnostic = (diagnostic + bytes.toString()).slice(-32768) })
    onTestFinished(async () => {
      child.stdin.end()
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await closed
    })
    const observed = Promise.withResolvers<{ attempt: string; execution?: string }>()
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      let value: unknown
      try { value = JSON.parse(line) } catch (_diagnostic) { return }
      const parsed = z.object({ kind: z.literal('state'), state: z.literal('running'), attempt: z.string(), execution: z.string() }).safeParse(value)
      if (parsed.success) observed.resolve(parsed.data)
    })
    void closed.then(() => { lines.close() }, () => { lines.close() })
    return { child, closed, result, diagnostic: () => diagnostic,
      running: async () => await Promise.race([observed.promise, closed.then((value) => { throw new Error('Host exited before rendering: ' + JSON.stringify(value) + diagnostic) })]) }
  }
  return { root, data, launchHost }
}

type NativeFixture = Awaited<ReturnType<typeof fixture>>
type NativeHost = Awaited<ReturnType<NativeFixture['launchHost']>>

async function completed(f: NativeFixture, host: NativeHost) {
  expect(await host.closed, host.diagnostic()).toEqual({ code: 0, signal: null })
  const receipt = z.object({ productionComposition: z.literal(true), fetchCalls: z.literal(0), ready: z.object({ ready: z.literal(true) }),
    status: z.object({ state: z.literal('completed'), attempt: z.string(), execution: z.string(), output: z.object({ path: z.string(), sha256: z.string(), bytes: z.number().positive() }) }) })
    .parse(JSON.parse(await readFile(host.result, 'utf8')))
  const bytes = await readFile(join(f.data.project, receipt.status.output.path))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(receipt.status.output.sha256)
  expect(bytes.length).toBe(receipt.status.output.bytes)
  expect(f.data.fetch).not.toHaveBeenCalled()
  console.info(JSON.stringify({ kind: 'actual-episode-native-complete', ...receipt }))
  return receipt
}

it.skipIf(!enabled)('runs production admission, an ordinary isolated guardian and actual current rendering without a provider call', async () => {
  const f = await fixture()
  await completed(f, await f.launchHost())
}, 180000)

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}

it.skipIf(!enabled)('drains real media after Host death and explicitly resumes the original attempt with a new physical execution', async () => {
  const f = await fixture(), host = await f.launchHost(), active = await host.running()
  const attemptRoot = join(f.data.project, '.muse', 'episode-delivery', active.attempt)
  const stage = join(attemptRoot, active.execution ?? '', 'stage')
  const owned: { guardian?: number; media?: number } = {}
  onTestFinished(async () => {
    for (const pid of [owned.guardian, owned.media]) {
      if (pid === undefined || !alive(pid)) continue
      let command: string
      try { command = (await execute('ps', ['-p', String(pid), '-o', 'command='])).stdout }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 1) continue; throw error }
      if (!command.includes(stage)) throw new Error('Refusing to signal PID without the owned execution path')
      process.kill(pid, 'SIGTERM')
      await expect.poll(() => alive(pid), { timeout: 30000 }).toBe(false)
    }
  })
  await expect.poll(async () => {
    const processes = (await execute('ps', ['-axo', 'pid=,command='])).stdout
    const row = processes.split('\n').find(line => line.includes(stage) && line.includes(ffmpeg ?? '') && line.includes('-i'))
    if (row !== undefined) owned.media = Number.parseInt(row.trim(), 10)
    return owned.media
  }, { timeout: 30000, interval: 10 }).toBeDefined()
  const running = z.object({ guardianPid: z.number().int().positive(), identity: z.object({ execution: z.string() }) })
    .parse(JSON.parse(await readFile(join(attemptRoot, 'execution.json'), 'utf8')))
  expect(running.identity.execution).toBe(active.execution)
  const guardian = running.guardianPid; owned.guardian = guardian
  host.child.kill('SIGKILL')
  expect(await host.closed).toEqual({ code: null, signal: 'SIGKILL' })
  let proof: unknown
  await expect.poll(async () => {
    try { proof = JSON.parse(await readFile(join(attemptRoot, `drained-${active.execution}.json`), 'utf8')); return true }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error }
  }, { timeout: 30000 }).toBe(true)
  expect(proof).toMatchObject({ result: 'cancelled', guardianPid: guardian, identity: { attempt: active.attempt, execution: active.execution } })
  await expect.poll(() => owned.media === undefined || !alive(owned.media), { timeout: 30000 }).toBe(true)
  await expect.poll(() => !alive(guardian), { timeout: 30000 }).toBe(true)
  const restored = await completed(f, await f.launchHost(true))
  expect(restored.status.attempt).toBe(active.attempt)
  expect(restored.status.execution).not.toBe(active.execution)
  console.info(JSON.stringify({ kind: 'actual-episode-host-death-resume', original: active, proof, resumed: restored.status }))
}, 180000)

it.skipIf(!enabled)('rejects changed captured font bytes in the real worker before arming or spawning media', async () => {
  const f = await fixture(true), host = await f.launchHost()
  expect(await host.closed, host.diagnostic()).toEqual({ code: 1, signal: null })
  const result = z.object({ fetchCalls: z.literal(0), admitted: z.object({ attempt: z.string(), digest: z.string() }),
    status: z.object({ state: z.literal('failed'), execution: z.string(), problem: z.string() }) })
    .parse(JSON.parse(await readFile(host.result, 'utf8')))
  expect(result.status.problem).toContain('Episode staged or runtime file changed')
  const attemptRoot = join(f.data.project, '.muse', 'episode-delivery', result.admitted.attempt)
  const stage = join(attemptRoot, result.status.execution, 'stage')
  expect(JSON.parse(await readFile(join(stage, 'media-spawn-witness.json'), 'utf8'))).toEqual({ calls: 0 })
  const job = z.object({ armedExecutions: z.array(z.string()), executionRef: z.null() })
    .parse(JSON.parse(await readFile(join(attemptRoot, 'job.json'), 'utf8')))
  expect(job.armedExecutions).toEqual([])
  expect(job.executionRef).toBeNull()
  for (const path of [join(attemptRoot, 'execution.json'), join(attemptRoot, `drained-${result.status.execution}.json`),
    join(stage, 'candidate-facts.json'), join(stage, 'exports', '01.mp4')]) {
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  }
  await expect(readFile(join(attemptRoot, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(f.data.project, 'exports', `Muse-episode-01-${result.admitted.digest}.mp4`)))
    .rejects.toMatchObject({ code: 'ENOENT' })
}, 180000)
