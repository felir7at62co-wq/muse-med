/** Encoder probing and the CPU fallback it records. */

import { describe, expect, it } from 'vitest'
import { chooseEncoder, collapseReason, CPU_ENCODER, GPU_ENCODER } from '../src/encoder.ts'
import { createMediaToolkit } from '../src/ffmpeg.ts'
import { stubChannel, type StubHandler } from './harness.ts'

/** Build a toolkit over a stub channel. */
function toolkit(handlers: readonly StubHandler[]) {
  return createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: stubChannel(handlers).channel })
}

describe('collapseReason', () => {
  it('collapses every run of whitespace into one space', () => {
    expect(collapseReason('Cannot load nvcuda.dll\n\t  driver too old ')).toBe('Cannot load nvcuda.dll driver too old')
  })

  it('keeps only the last 1000 characters', () => {
    expect(collapseReason('x'.repeat(1200))).toHaveLength(1000)
  })
})

describe('chooseEncoder', () => {
  it('uses the GPU encoder when the probe succeeds and records no reason', async () => {
    const channel = stubChannel([() => ({})])
    const choice = await chooseEncoder(
      createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }), true)
    expect(choice.encoder).toBe(GPU_ENCODER)
    expect(choice.args).toContain('-cq')
    expect(choice.fallbackReason).toBe('')
    expect(channel.calls[0]?.args).toEqual([
      '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.1',
      '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-',
    ])
  })

  it('falls back to the CPU encoder and records the driver failure', async () => {
    const choice = await chooseEncoder(
      toolkit([() => ({ code: 1, stderr: 'Cannot load nvcuda.dll: 驱动过旧' })]), true)
    expect(choice.encoder).toBe(CPU_ENCODER)
    expect(choice.args).toContain('medium')
    expect(choice.fallbackReason).toBe('h264_nvenc 探测失败（退出码 1）：Cannot load nvcuda.dll: 驱动过旧')
  })

  it('records standard output when the probe wrote nothing to standard error', async () => {
    const choice = await chooseEncoder(toolkit([() => ({ code: 1, stdout: 'Conversion failed' })]), true)
    expect(choice.fallbackReason).toContain('Conversion failed')
  })

  it('skips the probe entirely when the deployment refuses the GPU encoder', async () => {
    const channel = stubChannel([() => ({})])
    const choice = await chooseEncoder(
      createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }), false)
    expect(choice.encoder).toBe(CPU_ENCODER)
    expect(choice.fallbackReason).toBe('preferNvenc=false：本次不探测 GPU 编码器，直接用 libx264。')
    expect(channel.calls).toHaveLength(0)
  })
})
