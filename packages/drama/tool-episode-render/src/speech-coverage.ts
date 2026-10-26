/** Compare source-bound recognition words with the selected final SRT, without recognizing or rewriting audio. */
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileSha256 } from './cache.ts'
import { parseSrtDocument } from './subtitles.ts'
import type { SubtitleCue, Timeline } from './types.ts'

/** Exact selected clips, final subtitles and the existing cloud-receipt mapping. */
export interface SpeechCoverageInput {
  readonly project: string
  readonly timeline: Timeline
  readonly sources: ReadonlyMap<number, string>
  readonly subtitleSrt: string
  readonly transcriptsPath: string
  readonly decisionsPath?: string
}

/** One original recognition token; character matching never invents times inside it. */
export interface SpeechCoverageWord {
  readonly id: string
  readonly shot: number
  readonly clip_index: number
  readonly word_index: number
  readonly text: string
  readonly source_start_seconds: number
  readonly source_end_seconds: number
  readonly start_seconds: number
  readonly end_seconds: number
}

/** A caller's recorded listening statement, not a Host acoustic measurement. */
export interface SpeechListeningStatement {
  readonly decision: 'keep' | 'adjust_subtitle' | 'asr_error' | 'unresolved'
  readonly reason: string
  readonly observed_text: string
  readonly reviewed_start_seconds: number
  readonly reviewed_end_seconds: number
}

/** One unresolved text or word-boundary difference for listening review. */
export interface SpeechCoverageFinding {
  readonly id: string
  readonly kind: 'recognized_without_subtitle' | 'subtitle_without_recognition' | 'timing_mismatch'
  readonly text: string
  readonly start_seconds: number
  readonly end_seconds: number
  readonly word_ids: readonly string[]
  readonly cue_indexes: readonly number[]
  readonly review?: SpeechListeningStatement
}

/** Local comparison evidence; neither successful matching nor statements certify actual speech. */
export interface SpeechCoverageReport {
  readonly schema_version: 1
  readonly assessment: 'asr_candidate_comparison'
  readonly listening_verified: false
  readonly subtitle_path: string
  readonly subtitle_sha256: string
  readonly evidence_sha256: string
  readonly evidence_complete: boolean
  readonly sources: readonly {
    readonly shot: number
    readonly clip_index: number
    readonly path: string
    readonly sha256: string
    readonly receipt_path: string
    readonly receipt_sha256: string
    readonly transcript_path: string
    readonly transcript_sha256: string
  }[]
  readonly words: readonly SpeechCoverageWord[]
  readonly matches: readonly { readonly word_id: string; readonly cue_index: number; readonly text: string; readonly precision: 'word' }[]
  readonly findings: readonly SpeechCoverageFinding[]
  readonly warnings: readonly string[]
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('证据必须是 JSON 对象。')
  return value as Record<string, unknown>
}

function finiteSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('字词或核听时间必须是非负有限秒数。')
  return value
}

function nonblank(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('核听记录需要非空 item_id、decision 和 reason。')
  return value
}

const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const textKey = (text: string): string => text.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '')
const seconds = (value: number): number => Math.round(value * 1_000_000) / 1_000_000
const overlaps = (left: { start_seconds: number; end_seconds: number }, cue: SubtitleCue): boolean =>
  left.start_seconds < cue.endSeconds && left.end_seconds > cue.startSeconds

async function ownedPath(project: string, file: string): Promise<string> {
  const path = resolve(project, file)
  const lexical = relative(project, path)
  if (lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) throw new Error('转写证据路径必须位于当前项目内。')
  const actual = await realpath(path)
  const inside = relative(project, actual)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('转写证据链接指向项目外。')
  return actual
}

interface Character { readonly text: string; readonly owner: number }
interface Pair { readonly word: number; readonly cue: number }

/** Sparse ordered matching consumes each character once, only in overlapping real intervals. */
function matchCharacters(words: readonly SpeechCoverageWord[], cues: readonly SubtitleCue[]) {
  const heard: Character[] = words.flatMap((word, owner) => Array.from(textKey(word.text), text => ({ text, owner })))
  const printed: Character[] = cues.flatMap((cue, owner) => Array.from(textKey(cue.text), text => ({ text, owner })))
  const positions = new Map<string, number[]>()
  for (const [index, char] of printed.entries()) {
    const list = positions.get(char.text) ?? []
    list.push(index); positions.set(char.text, list)
  }
  const tails: number[] = [], nodes: { pair: Pair; previous: number }[] = [], tailNodes: number[] = []
  for (const [word, char] of heard.entries()) {
    for (const cue of [...positions.get(char.text) ?? []].reverse()) {
      const printedChar = printed[cue] as Character
      if (!overlaps(words[char.owner] as SpeechCoverageWord, cues[printedChar.owner] as SubtitleCue)) continue
      let low = 0, high = tails.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if ((tails[middle] as number) < cue) low = middle + 1
        else high = middle
      }
      nodes.push({ pair: { word, cue }, previous: tailNodes[low - 1] ?? -1 })
      tails[low] = cue; tailNodes[low] = nodes.length - 1
    }
  }
  const pairs: Pair[] = []
  for (let node = tailNodes.at(-1) ?? -1; node !== -1;) {
    const entry = nodes[node] as (typeof nodes)[number]
    pairs.push(entry.pair); node = entry.previous
  }
  return { heard, printed, pairs: pairs.reverse() }
}

function compare(words: readonly SpeechCoverageWord[], cues: readonly SubtitleCue[]) {
  const { heard, printed, pairs } = matchCharacters(words, cues)
  const matchedHeard = new Set(pairs.map(pair => pair.word)), matchedPrinted = new Set(pairs.map(pair => pair.cue))
  const matches = new Map<string, { word_id: string; cue_index: number; text: string; precision: 'word' }>()
  for (const pair of pairs) {
    const heardChar = heard[pair.word] as Character, printedChar = printed[pair.cue] as Character
    const word = words[heardChar.owner] as SpeechCoverageWord, cue = cues[printedChar.owner] as SubtitleCue
    const key = `${word.id}:${String(cue.index)}`, previous = matches.get(key)
    matches.set(key, { word_id: word.id, cue_index: cue.index, text: (previous?.text ?? '') + heardChar.text, precision: 'word' })
  }
  const findings: SpeechCoverageFinding[] = []
  const occurrences = new Map<string, number>()
  const add = (finding: Omit<SpeechCoverageFinding, 'id'>) => {
    const originalId = digest(JSON.stringify(finding)), occurrence = occurrences.get(originalId) ?? 0
    occurrences.set(originalId, occurrence + 1)
    findings.push({ id: occurrence === 0 ? originalId : digest(`${originalId}:${String(occurrence)}`), ...finding })
  }
  const missing = (characters: readonly Character[], matched: ReadonlySet<number>, side: 'word' | 'cue') => {
    let index = 0
    while (index < characters.length) {
      if (matched.has(index)) { index++; continue }
      const owner = (characters[index] as Character).owner
      let text = ''
      while (index < characters.length && (characters[index] as Character).owner === owner && !matched.has(index)) {
        text += (characters[index++] as Character).text
      }
      if (side === 'word') {
        const word = words[owner] as SpeechCoverageWord
        add({ kind: 'recognized_without_subtitle', text, start_seconds: word.start_seconds, end_seconds: word.end_seconds,
          word_ids: [word.id], cue_indexes: [] })
      } else {
        const cue = cues[owner] as SubtitleCue
        add({ kind: 'subtitle_without_recognition', text, start_seconds: cue.startSeconds, end_seconds: cue.endSeconds,
          word_ids: [], cue_indexes: [cue.index] })
      }
    }
  }
  missing(heard, matchedHeard, 'word'); missing(printed, matchedPrinted, 'cue')
  for (const cue of cues) {
    const selected = [...matches.values()].filter(match => match.cue_index === cue.index)
    if (selected.map(match => match.text).join('') !== textKey(cue.text) || selected.length === 0) continue
    const ids = new Set(selected.map(match => match.word_id))
    const spans = words.filter(word => ids.has(word.id))
    const start = Math.min(...spans.map(word => word.start_seconds)), end = Math.max(...spans.map(word => word.end_seconds))
    if (Math.round(start * 1000) !== Math.round(cue.startSeconds * 1000)
      || Math.round(end * 1000) !== Math.round(cue.endSeconds * 1000)) {
      add({ kind: 'timing_mismatch', text: cue.text, start_seconds: Math.min(start, cue.startSeconds), end_seconds: Math.max(end, cue.endSeconds),
        word_ids: [...ids], cue_indexes: [cue.index] })
    }
  }
  return { matches: [...matches.values()], findings }
}

/**
 * Compare every recognized character, including short and unplanned speech, with the final selected SRT.
 * @param input - Project-owned existing receipts and files; this operation never submits, writes or repairs them.
 * @returns Source-bound ASR candidates and optional caller listening statements, never an acoustic approval.
 */
export async function reviewSpeechCoverage(input: SpeechCoverageInput): Promise<SpeechCoverageReport> {
  const project = await realpath(input.project), fingerprints = new Map<string, string>()
  const warnings: string[] = []
  const capture = async (file: string) => {
    const path = await ownedPath(project, file), bytes = await readFile(path)
    fingerprints.set(path, digest(bytes))
    return { path, bytes, sha256: digest(bytes) }
  }
  const subtitle = await capture(input.subtitleSrt)
  const cues = parseSrtDocument(subtitle.bytes.toString('utf8'), subtitle.path)
  for (const cue of cues) {
    if (cue.startSeconds < 0 || cue.endSeconds <= cue.startSeconds) throw new Error('最终 SRT 含无效时间，不能进行声文比较。')
  }
  const mapping = new Map<number, string>()
  try {
    const document = object(JSON.parse((await capture(input.transcriptsPath)).bytes.toString('utf8')))
    if (!Array.isArray(document.shots)) throw new Error('云转写映射需要 shots 数组。')
    for (const entry of document.shots) {
      const row = object(entry)
      if (typeof row.shot !== 'number' || !Number.isSafeInteger(row.shot) || row.shot < 1
        || typeof row.receipt !== 'string' || !row.receipt || mapping.has(row.shot)) throw new Error('云转写映射含无效或重复镜头。')
      mapping.set(row.shot, resolve(dirname(resolve(project, input.transcriptsPath)), row.receipt))
    }
  } catch (error) {
    mapping.clear()
    warnings.push(`转写映射未核实：${String(error)}`)
  }
  const sources: SpeechCoverageReport['sources'][number][] = [], words: SpeechCoverageWord[] = []
  for (const [clipIndex, clip] of input.timeline.clips.entries()) {
    try {
      const selected = input.sources.get(clip.shot), receiptFile = mapping.get(clip.shot)
      if (selected === undefined || receiptFile === undefined) throw new Error('缺少选定源文件或云转写收据。')
      const source = await ownedPath(project, selected), sha256 = await fileSha256(source)
      fingerprints.set(source, sha256)
      const receipt = await capture(receiptFile), row = object(JSON.parse(receipt.bytes.toString('utf8')))
      if (typeof row.source !== 'string' || await ownedPath(project, row.source) !== source || row.sourceSha256 !== sha256) throw new Error('收据源路径或 SHA-256 与当前镜头不一致。')
      if (row.status !== 'complete' && row.status !== 'silent') throw new Error('转写未完成，不能认定无发声。')
      if (typeof row.stem !== 'string' || !/^[\w.-]+$/u.test(row.stem) || typeof row.version !== 'number'
        || !Number.isSafeInteger(row.version) || row.version < 1
        || receipt.path !== resolve(project, 'transcript', 'jobs', `${row.stem}-v${String(row.version)}.json`)) throw new Error('请使用当前项目原始转写收据路径及版本。')
      let transcriptPath = '', transcriptHash = ''
      const shotWords: SpeechCoverageWord[] = []
      if (row.status === 'complete') {
        const transcript = await capture(resolve(project, 'transcript', 'raw', `${row.stem}-v${String(row.version)}.json`))
        transcriptPath = transcript.path; transcriptHash = transcript.sha256
        const segments: unknown = JSON.parse(transcript.bytes.toString('utf8'))
        if (!Array.isArray(segments) || segments.length === 0) throw new Error('转写缺少原始语音片段。')
        let previous = 0
        for (const value of segments) {
          const segment = object(value)
          if (!Array.isArray(segment.words) || segment.words.length === 0) throw new Error('缺少实际字词时间，不能用句子均分代替。')
          const segmentStart = finiteSeconds(segment.start), segmentEnd = finiteSeconds(segment.end)
          for (const value of segment.words) {
            const word = object(value), start = finiteSeconds(word.start), end = finiteSeconds(word.end)
            if (typeof word.text !== 'string' || end <= start || start < previous || start < segmentStart
              || end > segmentEnd || end * 1_000_000 > clip.durationUs) throw new Error('字词时间无效、无序或超出选定镜头。')
            previous = start
            shotWords.push({ id: `${String(clipIndex + 1)}:${String(shotWords.length + 1)}`, shot: clip.shot, clip_index: clipIndex + 1,
              word_index: shotWords.length + 1, text: word.text, source_start_seconds: start, source_end_seconds: end,
              start_seconds: seconds(clip.startUs / 1_000_000 + start), end_seconds: seconds(clip.startUs / 1_000_000 + end) })
          }
        }
      }
      sources.push({ shot: clip.shot, clip_index: clipIndex + 1, path: source, sha256, receipt_path: receipt.path,
        receipt_sha256: receipt.sha256, transcript_path: transcriptPath, transcript_sha256: transcriptHash })
      words.push(...shotWords)
    } catch (error) {
      warnings.push(`镜头 ${String(clip.shot)} 声文证据未核实：${String(error)}`)
    }
  }
  const evidenceHash = digest(JSON.stringify({ files: [...fingerprints], clips: input.timeline.clips, sources: [...input.sources] }))
  words.sort((left, right) => left.start_seconds - right.start_seconds)
  const comparison = compare(words, cues)
  if (input.decisionsPath !== undefined) {
    try {
      const plan = object(JSON.parse((await capture(input.decisionsPath)).bytes.toString('utf8')))
      if (plan.schema_version !== 1 || plan.evidence_sha256 !== evidenceHash || !Array.isArray(plan.decisions)) throw new Error('核听记录的字幕或证据已变化，旧记录不适用。')
      const statements = new Map<string, SpeechListeningStatement>()
      for (const value of plan.decisions) {
        const row = object(value), id = nonblank(row.item_id), decision = nonblank(row.decision), reason = nonblank(row.reason)
        const finding = comparison.findings.find(item => item.id === id)
        const start = finiteSeconds(row.reviewed_start_seconds), end = finiteSeconds(row.reviewed_end_seconds)
        if (!finding || statements.has(id) || (decision !== 'keep' && decision !== 'adjust_subtitle' && decision !== 'asr_error' && decision !== 'unresolved')
          || typeof row.observed_text !== 'string' || end <= start || start > finding.start_seconds || end < finding.end_seconds) throw new Error('核听记录需要本次逐项结果、有效决定、reason 和覆盖该项的实听区间。')
        statements.set(id, { decision, reason, observed_text: row.observed_text, reviewed_start_seconds: start, reviewed_end_seconds: end })
      }
      comparison.findings = comparison.findings.map((item) => {
        const review = statements.get(item.id)
        return review === undefined ? item : { ...item, review }
      })
    } catch (error) {
      warnings.push(`核听声明未采用：${String(error)}`)
    }
  }
  for (const [path, hash] of fingerprints) if (await fileSha256(path) !== hash) throw new Error('比较期间输入文件已变化，请重新核对当前版本。')
  return { schema_version: 1, assessment: 'asr_candidate_comparison', listening_verified: false,
    subtitle_path: subtitle.path, subtitle_sha256: subtitle.sha256, evidence_sha256: evidenceHash,
    evidence_complete: sources.length === input.timeline.clips.length, sources, words, ...comparison, warnings }
}
