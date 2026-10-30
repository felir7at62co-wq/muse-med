/** Split overwide Chinese cues only at complete, source-bound recognition-word starts. */
import type { SpeechCoverageReport, SpeechCoverageWord } from './speech-coverage.ts'
import type { SubtitleCue } from './types.ts'

/** The font probe returns null when it could not establish the actual width. */
export type SubtitleWidthProbe = (text: string) => Promise<boolean | null>

function compact(text: string): string { return text.replace(/\s+/gu, '') }

function matchedWords(cue: SubtitleCue, coverage: SpeechCoverageReport): SpeechCoverageWord[] | undefined {
  if (!/^[\p{Script=Han}\s]+$/u.test(cue.text) || cue.text.normalize('NFKC') !== cue.text) return undefined
  const matches = coverage.matches.filter(match => match.cue_index === cue.index)
  const words = new Map(coverage.words.map(word => [word.id, word]))
  const selected: SpeechCoverageWord[] = []
  for (const match of matches) {
    const word = words.get(match.word_id)
    if (word === undefined || selected.some(item => item.id === word.id)
      || coverage.matches.some(other => other.word_id === word.id && other.cue_index !== cue.index)
      || compact(word.text) !== match.text || !/^[\p{Script=Han}]+$/u.test(word.text)) return undefined
    selected.push(word)
  }
  if (selected.length < 2 || selected.map(word => word.text).join('') !== compact(cue.text)) return undefined
  if (selected.some((word, index) => word.end_seconds <= word.start_seconds
    || (index > 0 && word.start_seconds <= (selected[index - 1]?.start_seconds ?? Infinity))
    || (index > 0 && word.start_seconds < (selected[index - 1]?.end_seconds ?? Infinity))
    || word.start_seconds < cue.startSeconds || word.end_seconds > cue.endSeconds)) return undefined
  return selected
}

/** Preserve original text and times when width or complete word boundaries cannot be established.
 * @param cues - The normalized display cues, in delivery order.
 * @param coverage - Existing source-bound recognition evidence, never a new transcription request.
 * @param fits - Real font-width measurement for a proposed single line.
 * @returns Display cues and non-blocking reasons for any unresolved line.
 */
export async function fitSubtitleCues(
  cues: readonly SubtitleCue[], coverage: SpeechCoverageReport, fits: SubtitleWidthProbe,
): Promise<{ cues: SubtitleCue[]; warnings: string[] }> {
  const output: SubtitleCue[] = [], warnings: string[] = []
  for (const cue of cues) {
    const width = await fits(cue.text)
    if (width === true) { output.push(cue); continue }
    const words = width === false ? matchedWords(cue, coverage) : undefined
    if (words === undefined) {
      output.push(cue)
      warnings.push(`第 ${String(cue.index)} 条字幕${width === null ? '宽度未测得' : '超出可用宽度'}，`
        + '未取得完整匹配的真实字词时间；保留原文字和时码供核对。')
      continue
    }
    const original = Array.from(cue.text), indices = original.flatMap((char, index) => /\s/u.test(char) ? [] : [index])
    const boundaries = [0]
    for (const word of words) boundaries.push((boundaries.at(-1) ?? 0) + Array.from(word.text).length)
    const segment = (from: number, to: number): string => original.slice(indices[boundaries[from] ?? 0],
      (indices[(boundaries[to] ?? 0) - 1] ?? -1) + 1).join('').trim()
    const pieces: SubtitleCue[] = []
    let start = 0
    while (start < words.length) {
      let low = start + 1, high = words.length, best = start
      while (low <= high) {
        const mid = Math.floor((low + high) / 2)
        const measured = await fits(segment(start, mid))
        if (measured === null) { best = start; break }
        if (measured) { best = mid; low = mid + 1 } else high = mid - 1
      }
      if (best === start) break
      const next = best === words.length ? cue.endSeconds : words[best]?.start_seconds
      const begin = start === 0 ? cue.startSeconds : words[start]?.start_seconds
      if (begin === undefined || next === undefined || next <= begin || next > cue.endSeconds) break
      pieces.push({ ...cue, text: segment(start, best), startSeconds: begin, endSeconds: next })
      start = best
    }
    if (start === words.length) output.push(...pieces)
    else {
      output.push(cue)
      warnings.push(`第 ${String(cue.index)} 条字幕无法依据完整词界测量切分；保留原文字和时码供核对。`)
    }
  }
  return { cues: output.map((cue, index) => ({ ...cue, index: index + 1 })), warnings }
}
