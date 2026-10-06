/** Image normalization checks child completion, output dimensions and owned temporary cleanup. */
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { scaleImageWithFfmpeg, uploadReferenceMethod } from '../src/reference.ts'

const child = vi.hoisted(() => ({ mode: 'valid', calls: [] as { executable: string; args: string[] }[] }))
vi.mock('node:child_process', () => ({
  execFile: (executable: string, args: string[], _options: object,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    child.calls.push({ executable, args })
    if (child.mode === 'failure') { callback(new Error('process exited unsuccessfully'), '', ''); return }
    const bytes = new Uint8Array(24)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    bytes.set([73, 72, 68, 82], 12)
    const view = new DataView(bytes.buffer)
    view.setUint32(16, child.mode === 'wrong-size' ? 17 : 32)
    view.setUint32(20, 32)
    void writeFile(args.at(-1)!, bytes).then(() => { callback(null, '', '') }, (error: unknown) => {
      callback(error as Error, '', '')
    })
  },
}))

const request = { bytes: new Uint8Array([1]), width: 17, height: 17,
  format: 'png' as const, target: { width: 32, height: 32 } }
afterEach(() => { child.calls.splice(0); child.mode = 'valid'; vi.unstubAllEnvs() })

it.each([
  { explicit: '/configured/ffmpeg', env: 'DSH_JUBIAN_FFMPEG', value: '/environment/ffmpeg', expected: '/configured/ffmpeg' },
  { explicit: undefined, env: 'DSH_JUBIAN_FFMPEG', value: '/environment/ffmpeg', expected: '/environment/ffmpeg' },
  { explicit: ' ', env: 'FFMPEG_PATH', value: '/fallback/ffmpeg', expected: '/fallback/ffmpeg' },
  { explicit: undefined, env: 'MUSE_FFMPEG_EXECUTABLE', value: '/muse/ffmpeg', expected: '/muse/ffmpeg' },
  { explicit: undefined, env: 'FFMPEG_PATH', value: ' ', expected: 'ffmpeg' },
])('normalizes dimensions using the configured binary resolution %j', async ({ explicit, env, value, expected }) => {
  for (const name of ['DSH_JUBIAN_FFMPEG', 'FFMPEG_PATH', 'MUSE_FFMPEG_EXECUTABLE']) vi.stubEnv(name, '')
  vi.stubEnv(env, value)
  const bytes = await scaleImageWithFfmpeg(request, explicit), call = child.calls[0]!
  expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16)).toBe(32)
  expect(call.executable).toBe(expected)
  expect(call.args).toContain('scale=32:32')
  await expect(access(dirname(call.args.at(-1)!))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['failure', 'wrong-size'])('refuses %s output and releases its temporary directory', async (mode) => {
  child.mode = mode
  await expect(scaleImageWithFfmpeg(request, '/test/ffmpeg')).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  await expect(access(dirname(child.calls[0]!.args.at(-1)!))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports alignment requirements through the default scaler when child execution fails', async () => {
  child.mode = 'failure'
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); bytes.set([73, 72, 68, 82], 12)
  new DataView(bytes.buffer).setUint32(16, 17); new DataView(bytes.buffer).setUint32(20, 17)
  const root = await mkdtemp(join(tmpdir(), 'jubian-scale-input-'))
  try {
    const source = join(root, 'odd.png')
    await writeFile(source, bytes)
    const network = vi.fn<typeof fetch>()
    expect(await uploadReferenceMethod({ image_path: source }, { fetch: network, ffmpegPath: '/test/ffmpeg' }))
      .toMatchObject({ uploaded: false, status: 'alignment_required', required_width: 16, required_height: 16 })
    expect(network).not.toHaveBeenCalled()
  } finally { await rm(root, { recursive: true, force: true }) }
})
