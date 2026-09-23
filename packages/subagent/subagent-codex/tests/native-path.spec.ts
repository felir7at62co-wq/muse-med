import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ manifestPath: '' }))
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  return Object.assign({}, actual, { createRequire: (url: string | URL) => {
    const require = actual.createRequire(url)
    const resolve = require.resolve
    require.resolve = Object.assign((name: string) => name === '@openai/codex/package.json'
      ? fixture.manifestPath : resolve(name), { paths: (name: string) => resolve.paths(name) })
    return require
  } })
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
    if (String(args[0]).endsWith(join('@openai', 'codex', 'package.json'))) {
      return JSON.stringify({ bin: { codex: 'bin/codex.js' } })
    }
    return actual.readFileSync(...args)
  } }
})
afterEach(() => { vi.resetModules() })

it.each(['app.asar', 'app.asar.unpacked', 'my-app.asar-copy', 'development'])('resolves the Codex wrapper on the native filesystem under %s', async (container) => {
  const root = join(tmpdir(), 'codex-native-path', container, 'dsh', 'node_modules', '@openai', 'codex')
  fixture.manifestPath = join(root, 'package.json')
  const { codexAppServerArgv } = await import('../src/run.ts')
  const nativeRoot = join(tmpdir(), 'codex-native-path', container === 'app.asar' ? 'app.asar.unpacked' : container,
    'dsh', 'node_modules', '@openai', 'codex')
  expect(codexAppServerArgv()).toEqual([process.execPath, join(nativeRoot, 'bin', 'codex.js'), 'app-server', '--stdio'])
})
