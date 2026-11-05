/** Captured Desktop runtime identity and private guardian launch environment. */
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { afterEach, expect, it, vi } from 'vitest'
import { captureDesktopCarrier, guardianEnvironment, launchGuardian } from '../src/episode-guardian-launcher.ts'
import { guardianParsers } from '../src/episode-guardian-journal.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(async (root) => { await rm(root, { recursive: true, force: true }) }))
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-guardian-launcher-'))); roots.push(root)
  const packageRoot = (name: string) => join(root, 'node_modules', '@deepseek-ai', name)
  for (const [name, version] of [['dsh', '0.2.2-rc.1'], ['dsh-desktop-host', '0.2.2-rc.1'], ['dsh-subprocess-local', '0.2.2-rc.1']] as const) {
    const dir = packageRoot(name); await mkdir(join(dir, 'lib'), { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version,
      type: 'module', exports: { '.': './lib/index.js', './package.json': './package.json' } }))
    await writeFile(join(dir, 'lib', 'index.js'), 'export {}\n')
  }
  for (const entry of ['cli.js', 'episode-render-worker.js']) await writeFile(join(packageRoot('dsh-desktop-host'), 'lib', entry), 'export {}\n')
  return { root, packageRoot }
}

it('retains only declared OS facts and overrides both Harness homes privately', () => {
  vi.stubEnv('MUSE_HOME', '/personal/muse'); vi.stubEnv('DSH_HOME', '/personal/dsh')
  vi.stubEnv('MUSE_FONTS_DIR', '/personal/fonts'); vi.stubEnv('NODE_OPTIONS', '--inspect')
  vi.stubEnv('HTTP_PROXY', 'http://private.invalid'); vi.stubEnv('DEEPSEEK_API_KEY', 'secret')
  const env = guardianEnvironment('/private/worker', process.platform)
  expect(env).toMatchObject({ MUSE_HOME: '/private/worker', DSH_HOME: '/private/worker', ELECTRON_RUN_AS_NODE: '1',
    DSH_TELEMETRY_DISABLED: '1', XDG_CONFIG_HOME: '/private/worker/config' })
  for (const key of ['MUSE_FONTS_DIR', 'NODE_OPTIONS', 'HTTP_PROXY', 'DEEPSEEK_API_KEY']) expect(env[key]).toBeUndefined()
  expect(process.env.MUSE_HOME).toBe('/personal/muse')
})

it('captures exact same-version packages and reuses the current Node executable', async () => {
  const f = await fixture(), captured = await captureDesktopCarrier(f.root, false)
  expect(captured).toEqual({ kind: 'desktop-runtime', runtimeDir: f.root, executable: process.execPath,
    packageRoots: { host: f.packageRoot('dsh-desktop-host'), cli: f.packageRoot('dsh'), subprocess: f.packageRoot('dsh-subprocess-local') } })
})

it('refuses a missing production worker rather than falling back to source', async () => {
  const f = await fixture()
  await rm(join(f.packageRoot('dsh-desktop-host'), 'lib', 'episode-render-worker.js'))
  await expect(captureDesktopCarrier(f.root, true)).rejects.toThrow()
})

it('refuses package identity or version mismatches', async () => {
  const f = await fixture()
  await writeFile(join(f.packageRoot('dsh'), 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: 'other' }))
  await expect(captureDesktopCarrier(f.root, false)).rejects.toThrow('identity mismatch')
})

it('rejects a runtime entry symlink escaping its captured owner', async () => {
  const f = await fixture(), worker = join(f.packageRoot('dsh-desktop-host'), 'lib', 'episode-render-worker.js')
  await rm(worker); await writeFile(join(f.root, 'escaped.js'), 'export {}\n'); await symlink(join(f.root, 'escaped.js'), worker)
  await expect(captureDesktopCarrier(f.root, true)).rejects.toThrow('entry escaped')
})

it('refuses oversized requests before preparing a profile or spawning', async () => {
  const f = await fixture()
  const identity = guardianParsers.parseRequest({ version: 1, kind: 'run', identity: {
    attempt: '00000000-0000-4000-8000-000000000001', execution: '00000000-0000-4000-8000-000000000003',
    rendererGeneration: '00000000-0000-4000-8000-000000000002', planSha256: 'a'.repeat(64),
    projectSha256: 'b'.repeat(64), configurationSha256: 'c'.repeat(64), descriptorSha256: 'd'.repeat(64),
  } }).identity
  const children = new Set<import('node:child_process').ChildProcessWithoutNullStreams>()
  await expect(launchGuardian({ carrier: await captureDesktopCarrier(f.root, false), executionRoot: f.root,
    descriptorPath: join(f.root, 'descriptor.json'), identity, limits: { requestBytes: 1, replyBytes: 4096, diagnosticBytes: 1024 },
    workerConfig: {}, parsers: guardianParsers, rawChildren: children })).rejects.toThrow('request exceeds limit')
  expect(children.size).toBe(0)
})

it('rejects a drained reply whose guardian PID differs from its actual child', async () => {
  const f = await fixture()
  const identity = guardianParsers.parseRequest({ version: 1, kind: 'run', identity: {
    attempt: '00000000-0000-4000-8000-000000000001', execution: '00000000-0000-4000-8000-000000000003',
    rendererGeneration: '00000000-0000-4000-8000-000000000002', planSha256: 'a'.repeat(64),
    projectSha256: 'b'.repeat(64), configurationSha256: 'c'.repeat(64), descriptorSha256: 'd'.repeat(64),
  } }).identity
  const children = new Set<import('node:child_process').ChildProcessWithoutNullStreams>()
  try {
    const guardian = await launchGuardian({ carrier: { kind: 'source-fixture', executable: process.execPath,
      cli: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)), tsxEsm: import.meta.resolve('tsx/esm'),
      tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
      subprocessEntry: fileURLToPath(new URL('../../../packages/subprocess/subprocess-local/src/index.ts', import.meta.url)),
      workerEntry: fileURLToPath(new URL('./fixtures/episode-guardian-wire.mjs', import.meta.url)) },
    executionRoot: f.root, descriptorPath: join(f.root, 'descriptor.json'), identity,
    limits: { requestBytes: 4096, replyBytes: 4096, diagnosticBytes: 4096 }, workerConfig: {},
    parsers: guardianParsers, rawChildren: children })
    await expect(guardian.result).rejects.toThrow('another guardian PID')
    expect((await guardian.closed).code, guardian.diagnostic()).toBe(0)
    expect(children.size).toBe(1)
  } finally {
    await Promise.all([...children].map(async (child) => {
      child.stdin.end()
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('close', resolve) })
    }))
  }
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
