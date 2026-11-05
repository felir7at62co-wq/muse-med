/**
 * Windows console visibility for the two child processes Electron starts itself.
 *
 * The packaged backend is the GUI-subsystem Electron binary, so it owns no
 * console; a console child started without Node's `windowsHide` receives a new
 * visible console window. Both owned spawn sites must ask for it explicitly.
 */

import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopHostProcess } from '../src/host-process.ts'

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
    child?.emit('message', { type: 'ready', hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, url: 'http://127.0.0.1:3131/?token=fixture', injections: [] })
    await expect(started).resolves.toMatchObject({ url: 'http://127.0.0.1:3131/?token=fixture' })
  })

})
