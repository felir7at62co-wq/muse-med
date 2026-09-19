/**
 * Encoder selection: probe the GPU encoder, then fall back to the CPU encoder
 * with the reason recorded.
 *
 * The probe encodes one frame of a 256x256 black source. The size matters —
 * several NVIDIA generations reject smaller frames as below NVENC's minimum, so
 * a 64x64 probe reports a working card as unusable. An old driver, a missing
 * NVENC build, or a busy GPU session all fail the probe the same way, which is
 * why the failure is a recorded fallback rather than an error: the delivery must
 * still happen, and the operator has to be able to see why it happened on the CPU.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/encoder
 */

import { ENCODER_PROBE_SOURCE, encoderArguments } from './delivery.ts'
import type { EncoderChoice, MediaToolkit } from './types.ts'

/** The CPU encoder used when no GPU encoder is available. */
export const CPU_ENCODER = 'libx264'

/** The GPU encoder the renderer prefers. */
export const GPU_ENCODER = 'h264_nvenc'

/** Characters of the probe's output kept in the recorded reason. */
const REASON_CHARS = 1000

/**
 * Collapse one command's output into a single line a result and a log can carry.
 * @param text - The captured output.
 * @returns The trimmed last {@link REASON_CHARS} characters with runs of whitespace collapsed.
 */
export function collapseReason(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.slice(-REASON_CHARS)
}

/**
 * Choose the encoder one render uses.
 * @param toolkit - The binaries and channel to use.
 * @param preferNvenc - Whether the GPU encoder is probed at all.
 * @returns The encoder, its arguments, and the probe failure that forced the CPU encoder.
 */
export async function chooseEncoder(toolkit: MediaToolkit, preferNvenc: boolean): Promise<EncoderChoice> {
  if (!preferNvenc) {
    return {
      encoder: CPU_ENCODER,
      args: encoderArguments(CPU_ENCODER),
      fallbackReason: 'preferNvenc=false：本次不探测 GPU 编码器，直接用 libx264。',
    }
  }
  const outcome = await toolkit.channel.run(toolkit.ffmpeg, [
    '-v', 'error', '-f', 'lavfi', '-i', ENCODER_PROBE_SOURCE,
    '-frames:v', '1', '-c:v', GPU_ENCODER, '-f', 'null', '-',
  ])
  if (outcome.code === 0) {
    return { encoder: GPU_ENCODER, args: encoderArguments(GPU_ENCODER), fallbackReason: '' }
  }
  return {
    encoder: CPU_ENCODER,
    args: encoderArguments(CPU_ENCODER),
    fallbackReason: `h264_nvenc 探测失败（退出码 ${String(outcome.code)}）：`
      + collapseReason(outcome.stderr.trim() === '' ? outcome.stdout : outcome.stderr),
  }
}
