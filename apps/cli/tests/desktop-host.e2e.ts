/** Built Desktop Host lifecycle with Electron disconnecting before profile startup settles. */

import { execFile, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finished } from 'node:stream/promises'
import { expect, it, onTestFinished, vi } from 'vitest'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { buildNativeVideoPreview } from '@deepseek-ai/dsh-jubian-api'

function prepareHostFixture(root: string, profileBootSource: string): string {
  const modules = join(root, 'node_modules', '@deepseek-ai')
  const hostDirectory = fileURLToPath(new URL('../../desktop-host/', import.meta.url))
  const manifest = JSON.parse(readFileSync(join(hostDirectory, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
  const stubbed = new Set(['@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh', '@deepseek-ai/dsh-home-paths'])
  for (const name of Object.keys(manifest.dependencies)) {
    const destination = join(root, 'node_modules', name)
    mkdirSync(dirname(destination), { recursive: true })
    if (stubbed.has(name)) mkdirSync(destination)
    else symlinkSync(realpathSync(join(hostDirectory, 'node_modules', name)), destination, 'junction')
  }
  for (const name of ['@xmanrui/dsh-im', '@wenbin_wb/dsh-bridge']) {
    const directory = join(root, 'node_modules', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, type: 'module',
      exports: { '.': './index.js', './remote': './remote.js' } }))
    writeFileSync(join(directory, 'index.js'), 'export default {}\n')
    writeFileSync(join(directory, 'remote.js'), 'export default {}\n')
  }
  for (const [name, source] of [
    ['dsh-home-paths', `import { join } from 'node:path';
      export const resolveDshHome = () => ${JSON.stringify(root)};
      export const dshHomePath = (...parts) => join(resolveDshHome(), ...parts);`],
  ] as const) {
    writeFileSync(join(modules, name, 'package.json'), '{"type":"module","exports":"./index.js"}')
    writeFileSync(join(modules, name, 'index.js'), source)
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(modules, 'dsh-app-boot', 'package.json'), '{"type":"module","exports":"./index.js"}')
  writeFileSync(join(modules, 'dsh-app-boot', 'index.js'), `
    export const loadProfileDirectory = () => ({ layers: [], patches: [], skippedBundles: [] });
    export const reportSkippedBundles = () => {};
    export const loadLayeredEnv = () => ({});
    export const loadOverlayPatches = () => [];
    export const composeEntries = () => [{ id: 'agent-preset-registry' }, { id: 'skill-filesystem' }];
  `)
  writeFileSync(join(modules, 'dsh', 'package.json'), '{"type":"module","exports":{"./profile-boot":"./profile-boot.js"}}')
  writeFileSync(join(modules, 'dsh', 'profile-boot.js'), profileBootSource)
  const fixtureHost = join(root, 'host')
  for (const directory of ['lib', 'config', 'presets', 'skills']) {
    cpSync(join(hostDirectory, directory), join(fixtureHost, directory), { recursive: true })
  }
  const entry = join(fixtureHost, 'lib', 'index.js')
  const pythonRoot = join(root, 'dependencies', 'python')
  const pythonBin = process.platform === 'win32' ? pythonRoot : join(pythonRoot, 'bin')
  mkdirSync(pythonBin, { recursive: true })
  mkdirSync(join(pythonRoot, ...(process.platform === 'win32' ? ['Lib'] : ['lib', 'python3.12']), 'site-packages'), { recursive: true })
  // Lifecycle acceptance resolves the payload but never invokes Python tools.
  writeFileSync(join(pythonBin, process.platform === 'win32' ? 'python.exe' : 'python3'), '')
  writeFileSync(join(root, 'runtime.json'), JSON.stringify({
    desktopVersion: '1.0.1', platform: process.platform, arch: process.arch, python: '3.12.14', pythonPackages: {},
  }))
  return entry
}

it.each([false, true])('settles startup after parent IPC disconnect (boot failure: %s)', async (fail) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-disconnect-')))
  const entry = prepareHostFixture(root, `
    import { writeFileSync } from 'node:fs';
    export function runProfile(options) {
      process.send({ type: 'booting', packageManager: options.packageManager,
        shutdownTimeoutMs: options.shutdownTimeoutMs });
      return new Promise((resolve, reject) => process.once('disconnect', () => {
        if (${String(fail)}) { reject(new Error('fixture boot failure')); return; }
        resolve({ ctx: { plugin: async () => {}, effect: () => {}, on: () => {}, inject: () => {},
          connection: { authenticatedUrl: value => value }, webServer: { protocol: 'http:', port: 19387, collectIndexInjections: () => [] } },
          shutdown: { shutdown: async () => writeFileSync(${JSON.stringify(join(root, 'stopped'))}, 'stopped') } });
      }));
    }
  `)
  const pnpm = join(root, 'bundled-pnpm.mjs')
  const nodeBin = join(root, 'bin')
  const child = fork(entry, [root, root, root, pnpm, nodeBin], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
  const drained = finished(child.stderr!, { cleanup: true })
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.all([exited, drained])
    rmSync(root, { recursive: true, force: true })
  })
  try {
    const boot = await new Promise<{
      packageManager: { command: string; args: string[]; env: Record<string, string> }
      shutdownTimeoutMs: number
    }>((resolve, reject) => {
      child.once('message', resolve)
      child.once('error', reject)
      child.once('exit', (code) => { reject(new Error(`Host exited before booting: ${String(code)} ${stderr}`)) })
    })
    expect(boot.packageManager.command).toBe(process.execPath)
    expect(boot.shutdownTimeoutMs).toBe(25_000)
    expect(boot.packageManager.args).toEqual(['--expose-internals', pnpm])
    expect(boot.packageManager.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(boot.packageManager.env.PATH).toBe(`${nodeBin}${delimiter}${process.env.PATH ?? ''}`)
    child.disconnect()
    const exitCode = await exited
    await drained
    expect(child.signalCode).toBeNull()
    expect(exitCode, stderr).toBe(fail ? 1 : 0)
    expect(stderr).not.toContain('ERR_IPC_CHANNEL_CLOSED')
    expect(stderr).not.toContain('Unhandled')
    if (fail) expect(stderr).toContain('fixture boot failure')
    else expect(readFileSync(join(root, 'stopped'), 'utf8')).toBe('stopped')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.all([exited, drained])
  }
})

const recoveryFfmpeg = process.env.MUSE_RECOVERY_TEST_FFMPEG

it.skipIf(!recoveryFfmpeg).each([{ mode: 'configured keys', discover: false }, { mode: 'discovery', discover: true }])(
  'recovers an interrupted video review across Desktop Host process restarts with $mode', async ({ discover }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-video-recovery-')))
    const children: ReturnType<typeof startRecoveryHost>[] = []
    onTestFinished(async () => {
      for (const host of children) await host.stop()
      rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    })
    const bootSource = readFileSync(new URL('./fixtures/desktop-video-recovery.mjs', import.meta.url), 'utf8')
    const entry = prepareHostFixture(root, bootSource)
    const projectDir = join(root, 'video-project')
    const previewPath = join(projectDir, 'video_tasks', 'storyboard-native.json')
    const ledgerRoot = join(root, 'ledger')
    mkdirSync(dirname(previewPath), { recursive: true })
    const scriptId = 2708
    const storyboardId = 916953
    const taskId = 335343
    const imageUrl = 'https://101.aigc.jubianai.net/reference.jpg'
    const mediaUrl = 'https://101.aigc.jubianai.net/generated.mp4'
    const model = { platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-0-260128', standardId: 11, genType: 3,
      modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, ratio: '9:16', resolution: '720p', genNum: 1,
      materialList: [], backupModelList: [], prompt: '@[lead](lead) walks into the frame' }
    const materials = [{ assetId: 'asset-lead', materialAssetId: 81285, fileName: 'lead', materialKey: 'lead',
      materialType: 'image', materialUrl: imageUrl, sortOrder: 1 }]
    const preview = buildNativeVideoPreview({
      storyboard: { id: storyboardId, scriptId, isGenerate: 0, storyboardName: 'scene one',
        modelConfig: JSON.stringify(model), storyboardMaterialList: materials },
      assets: [{ id: 81285, scriptId, assetUrl: imageUrl, hsAssetId: 'asset-lead',
        hsAssetStatus: 'Active', isUsed: 1, official: true, asset_status: 'confirmed' }],
      models: [{ id: 11, standardId: 11, modelId: model.modelId, platformId: model.platformId,
        duration: 8, genNum: 1, genTypes: [{ id: 7, type: 3 }],
        videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p', genNum: 1 }] }],
      createdAt: '2026-09-20T10:00:00.000Z',
    })
    writeFileSync(join(projectDir, 'project_config.json'), JSON.stringify({ jubian_script_id: scriptId }))
    writeFileSync(previewPath, JSON.stringify(preview))
    const key = preview.idempotencyKey
    const ledger = new JubianLedger({ root: ledgerRoot })
    const recordSubmission = async () => await ledger.beginManyChecked([key], async () => [{
      idempotencyKey: key, method: 'storyboard_native_submit', scriptId, videoPreviewPath: previewPath,
      beforeTaskIds: [], requestSha256: 'sha256:' + createHash('sha256').update(JSON.stringify(preview.payload)).digest('hex'),
    }])
    if (!discover) await recordSubmission()
    const reportPath = join(projectDir, 'video_tasks', 'review', createHash('sha256').update(key).digest('hex') + '.json')
    const mediaPath = join(root, 'fixture.mp4')
    await promisify(execFile)(recoveryFfmpeg!, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', mediaPath],
    { timeout: 15_000, windowsHide: true })
    const mediaDigest = 'sha256:' + createHash('sha256').update(readFileSync(mediaPath)).digest('hex')
    const input = {
      recovery: { projectDir, ...(discover ? {} : { keys: [key] }), ffmpegPath: recoveryFfmpeg },
      ledgerRoot, mediaPath, task: { id: taskId, scriptId, storyboardId, taskType: 1, taskStatus: 'succeeded' },
      subtask: { id: 972949, aigcVideoTaskId: taskId, storyboardId, taskStatus: 'succeeded',
        imageMaterials: preview.payload.storyboardMaterialList, modelConfig: preview.payload.modelConfig,
        resultList: [{ tosVideoUrl: mediaUrl }] },
    }
    const start = (completed: boolean) => {
      const host = startRecoveryHost(entry, root, { ...input, completed })
      children.push(host)
      return host
    }

    const first = start(false)
    await first.wait('ready')
    if (discover) {
      expect(first.messages.filter(message => message.type === 'provider-read')).toEqual([])
      await recordSubmission()
    }
    await first.wait('provider-read')
    expect(existsSync(reportPath)).toBe(false)
    await first.shutdown()
    expect(first.messages.filter(message => message.type === 'provider-read').map(message => message.method))
      .not.toContain('PUT')

    const second = start(true)
    await second.wait('ready')
    await second.wait('provider-read')
    await vi.waitFor(() => expect(existsSync(reportPath)).toBe(true), { timeout: 10_000 })
    const bytes = readFileSync(reportPath)
    expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({
      status: 'awaiting_review', task_id: taskId,
      media_checks: [{ sha256: mediaDigest, video: true, audio: true }],
    })
    const digest = createHash('sha256').update(bytes).digest('hex')
    second.child.send({ type: 'fixture-review', args: { action: 'approve', idempotency_key: key, digest },
      userText: `approve ${key} ${digest}` })
    expect(await second.wait('fixture-review-result')).toMatchObject({
      result: { decision: { action: 'approve', digest } },
    })
    await second.shutdown()
    expect(second.messages.filter(message => message.type === 'provider-read').map(message => message.method))
      .not.toContain('PUT')
    expect(readdirSync(dirname(reportPath)).sort()).toEqual([basename(reportPath), basename(reportPath) + '.decision.json'])

    const third = start(true)
    await third.wait('ready')
    third.child.send({ type: 'fixture-review', args: { action: 'read', idempotency_key: key } })
    expect(await third.wait('fixture-review-result')).toMatchObject({
      result: { decision: { action: 'approve', digest } },
    })
    await third.shutdown()
    expect(third.messages.filter(message => message.type === 'provider-read')).toEqual([])
    expect(readFileSync(reportPath)).toEqual(bytes)
  })

function startRecoveryHost(entry: string, root: string, configuration: object) {
  const child = fork(entry, [root, root, root], { execArgv: [],
    env: { ...process.env, DSH_HOME: root, MUSE_HOST_RECOVERY_FIXTURE: JSON.stringify(configuration) },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const messages: Array<{ type: string; method?: string }> = []
  child.on('message', (message: { type: string; method?: string }) => messages.push(message))
  let stderr = ''
  child.stderr!.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  const drained = finished(child.stderr!, { cleanup: true })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve)
    child.once('error', reject)
  })
  const wait = async (type: string) => {
    const buffered = messages.find(message => message.type === type)
    if (buffered !== undefined) return buffered
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Host exited before ${type}: ${stderr}`)
    }
    return await new Promise<(typeof messages)[number]>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(deadline)
        child.off('message', onMessage)
        child.off('exit', onExit)
        child.off('error', onError)
      }
      const onError = (error: Error) => { cleanup(); reject(error) }
      const onExit = (code: number | null) => onError(
        new Error(`Host exited before ${type} with ${String(code)}: ${stderr}`))
      const onMessage = (message: (typeof messages)[number]) => {
        if (message.type === 'fatal') onError(new Error(JSON.stringify(message)))
        else if (message.type === type) { cleanup(); resolve(message) }
      }
      const deadline = setTimeout(() => onError(new Error(`Waiting for ${type}: ${stderr}`)), 10_000)
      child.on('message', onMessage)
      child.once('exit', onExit)
      child.once('error', onError)
    })
  }
  return { child, messages, wait,
    shutdown: async () => {
      child.send({ type: 'shutdown' })
      await wait('shutdown-complete')
      expect(await exited, stderr).toBe(0)
      await drained
    },
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await Promise.all([exited, drained])
    },
  }
}
