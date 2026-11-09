/** Dedicated cloud hosting through the named dsh profile and launcher-owned shutdown. */
import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stringify } from 'yaml'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleLaunch, resolveExampleMode } from '@deepseek-ai/dsh-loader-smoke'
import { limits } from './fixtures.ts'

const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const production = join(repository, 'services/muse-accounts/market-profile')
const secret = 'profile-private-market-secret-'.repeat(2)

const readinessPlugin = `import { writeFileSync, renameSync } from 'node:fs'
export const name = 'market-profile-readiness'
export const inject = ['webServer', 'appReady']
export function apply(ctx, config) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    writeFileSync(config.file + '.tmp', JSON.stringify({ port: ctx.webServer.port }), { mode: 0o600 })
    renameSync(config.file + '.tmp', config.file)
  }), 'market-profile-readiness')
}
`

// Windows terminate signals do not deliver the launcher's POSIX graceful-shutdown path.
it.runIf(process.platform !== 'win32')('boots the two-row cloud profile on an assigned port and exits after normal termination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-market-profile-'))
  const home = join(root, 'home'), profile = join(home, 'profiles', 'market-test'), ready = join(root, 'ready.json')
  let child: ReturnType<typeof spawn> | undefined
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const readiness = Promise.withResolvers<number>()
  const watcher = watch(root, (_event, filename) => {
    if (filename !== 'ready.json') return
    void readFile(ready, 'utf8').then((text) => {
      const value: unknown = JSON.parse(text)
      if (typeof value !== 'object' || value === null || !('port' in value)
        || typeof value.port !== 'number' || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535) {
        throw new Error('Invalid profile readiness record')
      }
      readiness.resolve(value.port)
    }).catch(readiness.reject)
  })
  try {
    const mode = resolveExampleMode()
    await mkdir(join(profile, 'node_modules', '@deepseek-ai'), { recursive: true })
    for (const name of ['package.json', 'cordis.patch.yml']) await copyFile(join(production, name), join(profile, name))
    for (const [name, path] of [['dsh-host-webserver', 'webserver'], ['dsh-muse-market', 'muse-market']]) {
      await symlink(join(repository, 'packages/host', path!), join(profile, 'node_modules', '@deepseek-ai', name!), 'junction')
    }
    const policyFile = join(root, 'policy.json'), secretFile = join(root, 'secret'), overlay = join(root, 'observer.patch.yml')
    await writeFile(secretFile, secret, { mode: 0o600 })
    await writeFile(policyFile, JSON.stringify({ root: join(root, 'catalog'), secretFile, limits,
      maxReleases: 100, maxActiveUploads: 2, jsonRequestBytes: 16384, jsonResponseBytes: 1048576, catalogLimit: 100 }), { mode: 0o600 })
    const plugin = join(root, 'readiness.mjs')
    await writeFile(plugin, readinessPlugin)
    if (mode === 'src') {
      let patch = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
      for (const [specifier, source] of [
        ['@deepseek-ai/dsh-host-webserver', 'packages/host/webserver/src/index.ts'],
        ['@deepseek-ai/dsh-muse-market/cloud-host', 'packages/host/muse-market/src/cloud-host.ts'],
      ]) {
        const token = `'${specifier}'`
        expect(patch.split(token)).toHaveLength(2)
        patch = patch.replace(token, JSON.stringify(pathToFileURL(join(repository, source!)).href))
      }
      await writeFile(join(profile, 'cordis.patch.yml'), patch)
    }
    await writeFile(overlay, stringify([
      { insert: [{ id: 'market-readiness', name: pathToFileURL(plugin).href, config: { file: ready } }] },
    ]))
    const launch = resolveExampleLaunch({ srcBin: join(repository, 'apps/cli/src/bin.ts'), mode,
      configArgs: ['--profile', 'market-test', '--patch', overlay], tsconfigPath: join(repository, 'tsconfig.json'),
      sourceImport: 'tsx/esm', env: { DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents'),
        MUSE_MARKET_POLICY: policyFile, MUSE_MARKET_PORT: '0', DSH_TELEMETRY_DISABLED: '1' } })
    child = spawn(launch.command, launch.args, { cwd: root, env: { ...process.env, ...launch.env }, stdio: 'pipe' })
    let stdout = '', stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    closed = new Promise((resolve, reject) => {
      child!.once('error', reject)
      child!.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    child.stdin?.end()
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error(`Cloud profile exceeded its 30-second process deadline.\n${stdout}\n${stderr}`)) }, 30000)
    })
    const port = await Promise.race([readiness.promise, deadline, closed.then((exit) => {
      throw new Error(`Cloud profile exited before readiness: ${JSON.stringify(exit)}\n${stdout}\n${stderr}`)
    })])
    const origin = `http://127.0.0.1:${port}`
    const response = await fetch(origin + '/api/market/v1/catalog', {
      headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(5000),
    })
    expect(response.status, stderr).toBe(200)
    expect(await response.json()).toEqual({ items: [] })
    child.kill('SIGTERM')
    expect(await Promise.race([closed, deadline]), stderr).toEqual({ code: 0, signal: null })
    await expect(fetch(origin + '/api/market/v1/catalog', { signal: AbortSignal.timeout(5000) })).rejects.toThrow()
    expect(stderr).not.toContain('UNHANDLED')
  } finally {
    clearTimeout(timer)
    watcher.close()
    if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    try { await closed } finally { await rm(root, { recursive: true, force: true }) }
  }
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
