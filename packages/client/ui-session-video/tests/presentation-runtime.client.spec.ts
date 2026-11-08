/** Optional UI scopes unwind before a successor can register the same slots. */
import { describe, expect, it, vi } from 'vitest'
import { PresentationRuntime } from '../src/client/presentation-runtime.ts'

describe('optional conversation presentation', () => {
  it('serializes rapid switches behind disposal and creates a fresh scope on re-enable', async () => {
    const calls: string[] = []
    let release: () => void = () => {}
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const mount = vi.fn(async () => {
      calls.push('mount')
      return { dispose: async () => { calls.push('disposing'); await barrier; calls.push('disposed') } }
    })
    const runtime = new PresentationRuntime(mount)
    await runtime.setEnabled(false)
    expect(mount).not.toHaveBeenCalled()
    await runtime.setEnabled(true)
    await runtime.setEnabled(true)
    const disabled = runtime.setEnabled(false)
    const enabled = runtime.setEnabled(true)
    await vi.waitFor(() => { expect(calls).toEqual(['mount', 'disposing']) })
    expect(mount).toHaveBeenCalledTimes(1)
    release(); await disabled; await enabled
    expect(calls).toEqual(['mount', 'disposing', 'disposed', 'mount'])
    await runtime.dispose()
    await runtime.setEnabled(true)
    expect(mount).toHaveBeenCalledTimes(2)
  })

  it('releases a mount that finishes after the controller was disposed', async () => {
    const dispose = vi.fn(async () => {})
    let release: () => void = () => {}
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const mount = vi.fn(async () => { await barrier; return { dispose } })
    const runtime = new PresentationRuntime(mount)
    const enabled = runtime.setEnabled(true)
    await vi.waitFor(() => { expect(mount).toHaveBeenCalledTimes(1) })
    const stopped = runtime.dispose()
    release(); await enabled; await stopped
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('can retry a failed mount without losing disposal ownership', async () => {
    const dispose = vi.fn(async () => {})
    const mount = vi.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValue({ dispose })
    const runtime = new PresentationRuntime(mount)
    await expect(runtime.setEnabled(true)).rejects.toThrow('failed')
    await runtime.setEnabled(true)
    await runtime.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
