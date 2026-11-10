/** Source identity for an SRT placed on an episode's measured edit clock. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { fileSha256 } from './cache.ts'
import type { ResolvedShot } from './prepare.ts'

/** A readable generated subtitle still matches its receipt, but its source clock changed. */
export class StaleSubtitleClockError extends Error {}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function fingerprint(episode: string, shots: readonly ResolvedShot[],
  alignedAudio?: ReadonlyMap<number, string | undefined>, signal?: AbortSignal): Promise<string> {
  const files = new Map<string, Promise<string>>()
  const hash = (file: string): Promise<string> => {
    let pending = files.get(file)
    if (!pending) { pending = fileSha256(file, signal); files.set(file, pending) }
    return pending
  }
  const clock = []
  for (const shot of shots) {
    const video = await hash(shot.video)
    const audio = await hash(shot.audio)
    if (alignedAudio?.has(shot.source.shot) && alignedAudio.get(shot.source.shot) !== audio) {
      throw new Error('字幕自动修复缺少与当前声音文件一致的对齐证据，镜头 '
        + String(shot.source.shot) + ' 请重新取得同源对齐。')
    }
    clock.push([shot.source.shot, shot.durationUs, video, audio])
  }
  return digest(JSON.stringify([episode, clock]))
}

/**
 * Get the adjacent file recording the edit clock of a generated subtitle.
 * @param srt - Subtitle artifact path.
 * @returns Clock receipt path.
 */
export function subtitleClockPath(srt: string): string { return `${srt}.clock.json` }

/**
 * Publish one subtitle clock receipt before publishing its matching SRT.
 * @param srt - SRT destination.
 * @param text - The exact SRT document being published.
 * @param episode - Source episode identity.
 * @param shots - Selected picture and voice sources in clip order.
 * @param alignedAudio - Source hashes to recheck before publishing, including missing entries the caller requires.
 * @returns Written receipt path.
 */
export async function writeSubtitleClock(srt: string, text: string, episode: string,
  shots: readonly ResolvedShot[], alignedAudio?: ReadonlyMap<number, string | undefined>): Promise<string> {
  const receipt = subtitleClockPath(srt)
  const content = { version: 1, srt_sha256: digest(text), source_clock_sha256: await fingerprint(episode, shots, alignedAudio) }
  await writeFileAtomic(receipt, `${JSON.stringify(content)}\n`, { mode: 0o600, dirMode: 0o700 })
  return receipt
}

/**
 * Carry a previously verified edit clock to a display-only subtitle derivative.
 * @param source - Subtitle already verified against the current source media by the caller.
 * @param target - New normalized or word-split display subtitle.
 * @param text - Exact derived SRT bytes, with existing measured cue boundaries.
 * @returns New receipt path, or undefined for an unbound legacy source.
 */
export async function writeDerivedSubtitleClock(source: string, target: string, text: string): Promise<string | undefined> {
  let original: string
  try { original = await readFile(subtitleClockPath(source), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const receipt: unknown = JSON.parse(original)
  if (receipt === null || typeof receipt !== 'object' || !('version' in receipt) || receipt.version !== 1
    || !('srt_sha256' in receipt) || receipt.srt_sha256 !== await fileSha256(source)
    || !('source_clock_sha256' in receipt) || typeof receipt.source_clock_sha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(receipt.source_clock_sha256)) {
    throw new Error('显示字幕派生前的原字幕或来源时钟已变化，请用当前素材重跑 prepare。')
  }
  const path = subtitleClockPath(target)
  await writeFileAtomic(path, `${JSON.stringify({ version: 1, srt_sha256: digest(text),
    source_clock_sha256: receipt.source_clock_sha256 })}\n`, { mode: 0o600, dirMode: 0o700 })
  return path
}

/**
 * Check a generated SRT against the current media and clip order.
 * @param srt - Subtitle to install.
 * @param episode - Target episode identity.
 * @param readShots - Current selected picture and voice sources in clip order, resolved only for a generated SRT.
 * @param signal - Optional owning operation cancellation.
 * @returns Verified receipt, or undefined for an unbound manual or legacy SRT.
 */
export async function verifySubtitleClock(srt: string, episode: string,
  readShots: () => readonly ResolvedShot[] | Promise<readonly ResolvedShot[]>, signal?: AbortSignal): Promise<string | undefined> {
  let text: string
  signal?.throwIfAborted()
  try { text = await readFile(subtitleClockPath(srt), { encoding: 'utf8', signal }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const receipt: unknown = JSON.parse(text)
  const stale = () => new Error('生成字幕与当前集、分包素材或切点不一致。请使用当前清单和同源对齐记录重跑 drama_render subtitles，再重跑 prepare。')
  if (receipt === null || typeof receipt !== 'object' || !('version' in receipt) || receipt.version !== 1
    || !('srt_sha256' in receipt) || !('source_clock_sha256' in receipt)
    || typeof receipt.source_clock_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(receipt.source_clock_sha256)) throw stale()
  if (receipt.srt_sha256 !== await fileSha256(srt, signal)) throw stale()
  if (receipt.source_clock_sha256 !== await fingerprint(episode, await readShots(), undefined, signal)) {
    throw new StaleSubtitleClockError(stale().message)
  }
  return text
}
