import { expect, it, vi } from 'vitest'
import type { DshDesktopApi } from '../src/ipc.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'

const bridge = vi.hoisted(() => ({
  api: undefined as DshDesktopApi | undefined,
  invoke: vi.fn(async (_channel: string, ..._args: unknown[]) => undefined),
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: DshDesktopApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn() },
}))

it('keeps discovery on the existing private shell bridge and installs through the existing mutation channel', async () => {
  await import('../src/preload.ts')
  expect(bridge.api).toBeDefined()
  await bridge.api!.plugins.catalog(false)
  await bridge.api!.plugins.catalog(true)
  await bridge.api!.plugins.add('selected-plugin@1.2.3')
  expect(bridge.invoke.mock.calls).toEqual([
    [DESKTOP_IPC.pluginsCatalog, false],
    [DESKTOP_IPC.pluginsCatalog, true],
    [DESKTOP_IPC.pluginsAdd, 'selected-plugin@1.2.3'],
  ])
})
