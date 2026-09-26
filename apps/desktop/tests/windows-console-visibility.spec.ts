/**
 * Windows console visibility for the two child processes Electron starts itself.
 *
 * The packaged backend is the GUI-subsystem Electron binary, so it owns no
 * console; a console child started without Node's `windowsHide` receives a new
 * visible console window. Both owned spawn sites must ask for it explicitly.
 */

import { EventEmitter } from 'node:events'
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { DesktopHostProcess } from '../src/host-process.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { DesktopProjectManager } from '../src/project-manager.ts'

interface SpawnCall {
  readonly command: string
  readonly windowsHide: unknown
}

interface StubChild extends EventEmitter {
  stdio: unknown[]
  stdout: PassThrough
  stderr: PassThrough
  pid: number
  kill(signal?: string): boolean
}

const roots: string[] = []
const spawnCalls: SpawnCall[] = []
let child: StubChild | undefined

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: (command: string, _args: readonly string[], options: Record<string, unknown>) => {
    spawnCalls.push({ command, windowsHide: options?.windowsHide })
    return child
  },
}))

function stubChild(): StubChild {
  const stub = new EventEmitter() as StubChild
  stub.stdio = []
  stub.stdio[3] = new PassThrough()
  stub.stdio[4] = new PassThrough()
  stub.stdout = new PassThrough()
  stub.stderr = new PassThrough()
  stub.pid = 4242
  stub.kill = () => true
  return stub
}

beforeEach(() => {
  spawnCalls.length = 0
  child = stubChild()
})

afterEach(() => {
  child = undefined
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('owned desktop child processes', () => {
  it('starts the backend with a hidden console', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-console-'))
    roots.push(root)
    const host = new DesktopHostProcess('C:/desktop/muse-med.exe', root, root)
    const started = host.start()
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]?.windowsHide).toBe(true)
    child?.emit('message', { type: 'ready', protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, dshVersion: '0.0.0-test' })
    await expect(started).resolves.toMatchObject({ dshVersion: '0.0.0-test' })
  })

  it('runs the package manager with a hidden console', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-console-'))
    roots.push(root)
    const paths = resolveDesktopPaths(join(root, '.dsh'))
    mkdirSync(paths.profile, { recursive: true })
    const lock = openSync(paths.lock, 'w')
    const manager = new DesktopProjectManager(paths, {
      node: 'C:/desktop/muse-med.exe', pnpm: 'C:/runtime/pnpm/bin/pnpm.mjs', dsh: join(root, 'resources', 'dsh'),
    })
    const owned = manager as unknown as { lockDescriptor: number; runPnpm(dir: string, args: string[]): Promise<void> }
    owned.lockDescriptor = lock
    try {
      const project = join(root, 'project')
      mkdirSync(project, { recursive: true })
      const running = owned.runPnpm(project, ['install'])
      expect(spawnCalls).toHaveLength(1)
      expect(spawnCalls[0]).toMatchObject({ command: 'C:/desktop/muse-med.exe', windowsHide: true })
      child?.emit('close', 0, null)
      await running
    } finally {
      closeSync(lock)
    }
  })
})
