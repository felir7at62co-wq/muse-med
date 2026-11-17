/** Per-episode literal structure facts and format violations of a video-sourced screenplay. */
import { manuscriptEpisodeIndex } from './manuscript-materials.ts'
import { MANUSCRIPT_HOOK_MARKER } from './manuscript-presentation.ts'
import { classifyScreenplayLine } from './manuscript-transcript-match.ts'

/** Deployment thresholds for advisory warnings; structural errors follow the fixed `screenplay-format` rules. */
export interface ScreenplayFormatLimits {
  /** Minimum dialogue lines in one episode before a single speaker's share is assessed. */
  formatDominantSpeakerMinLines: number
  /** Share of one episode's dialogue lines carried by one speaker label that is reported as a warning. */
  formatDominantSpeakerShare: number
  /** Consecutive single-scene episodes with an identical scene description that are reported as a warning. */
  formatRepeatedSceneEpisodes: number
  /** Maximum error or warning texts kept per episode and per document; counts stay exact. */
  formatMaxMessages: number
}

/** One speaker label and the number of dialogue lines it carries. */
export interface ScreenplaySpeakerCount {
  name: string
  lines: number
}

/** Literal counts and problems of one indexed episode; line numbers are one-based extracted-text lines. */
export interface ScreenplayEpisodeFacts {
  episode: number
  start_line: number
  end_line: number
  scenes: number
  action_lines: number
  dialogue_lines: number
  speakers: ScreenplaySpeakerCount[]
  error_count: number
  warning_count: number
  errors: string[]
  warnings: string[]
}

/** Whole-document facts; document-level indexing failures count as errors. */
export interface ScreenplayFacts {
  episodes: ScreenplayEpisodeFacts[]
  error_count: number
  warning_count: number
  errors: string[]
  warnings: string[]
}

const CAST_LINE = /^(?:人物|出场人物)\s*[:：]\s*(.*)$/u
const SCENE_TIME = /(?:日|夜|晨|昏|白天|夜晚|清晨|早晨|傍晚|黄昏|凌晨|上午|中午|下午|午后)\s*[/／]?\s*(?:内|外)/u
const PLACEHOLDER_SPEAKER = /^(?:某人|某男|某女|男主|女主|男主角|女主角|主角|未知|unknown|说话人\s*\d*|speaker\s*[_-]?\d*)$/iu
const NON_CAST_LABELS = new Set(['旁白', '字幕', '字卡', '画外音', '屏幕', '画面字幕'])

function castOf(text: string): Set<string> {
  return new Set(text.split(/[、，,；;/／\s]+/u)
    .map(name => name.normalize('NFKC').replace(/[（(][^（）()]*[）)]/gu, '').replace(/\b(?:OS|VO)\b/gu, '').trim())
    .filter(name => name.length > 0))
}

function plainLine(raw: string): string {
  return raw.trim().replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+)/u, '').replace(/\*\*([^*\n]+)\*\*/gu, '$1').trim().normalize('NFKC')
}

class Messages {
  count = 0
  readonly texts: string[] = []
  constructor(private readonly max: number) {}
  add(text: string): void {
    this.count += 1
    if (this.texts.length < this.max) this.texts.push(text)
  }
}

interface Scene {
  line: number
  description: string
  cast: Set<string> | undefined
  awaitingCast: boolean
  actions: number
}

function assessEpisode(lines: readonly string[], range: { episode: number; start: number; end: number },
  limits: ScreenplayFormatLimits): ScreenplayEpisodeFacts & { scene_descriptions: string[] } {
  const errors = new Messages(limits.formatMaxMessages), warnings = new Messages(limits.formatMaxMessages)
  const speakers = new Map<string, number>(), scenes: Scene[] = []
  let actions = 0, dialogues = 0, bodyBeforeScene = false, lastBody: { line: number; hookOnly: boolean } | undefined
  for (let number = range.start + 1; number <= range.end; number++) {
    const raw = lines[number - 1] ?? '', kind = classifyScreenplayLine(raw), scene = scenes.at(-1)
    if (kind.kind === 'blank') continue
    const plain = plainLine(raw)
    if (kind.kind === 'scene_heading') {
      const description = plain.replace(/^\d+\s*[-—－]\s*\d+\s*[.、]?\s*/u, '').trim()
      if (!SCENE_TIME.test(description)) errors.add(`第${number}行场次「${plain}」缺少日/夜与内/外，应写成「${range.episode}-1 地点 日 内」。`)
      scenes.push({ line: number, description, cast: undefined, awaitingCast: true, actions: 0 })
      lastBody = { line: number, hookOnly: false }
      continue
    }
    const cast = CAST_LINE.exec(plain)
    if (cast !== null) {
      if (scene?.awaitingCast === true) { scene.cast = castOf(cast[1] ?? ''); scene.awaitingCast = false }
      continue
    }
    if (kind.kind === 'metadata') continue
    if (scene === undefined) {
      if (!bodyBeforeScene) errors.add(`第${number}行：正文出现在第${range.episode}集第一个场次标题之前。`)
      bodyBeforeScene = true
    } else if (scene.awaitingCast) {
      errors.add(`第${scene.line}行场次「${scene.description}」的下一行不是「人物：」行。`)
      scene.awaitingCast = false
    }
    if (kind.kind === 'action') {
      actions += 1
      if (scene !== undefined) scene.actions += 1
    } else if (kind.kind === 'dialogue') {
      dialogues += 1
      speakers.set(kind.speaker, (speakers.get(kind.speaker) ?? 0) + 1)
      if (PLACEHOLDER_SPEAKER.test(kind.speaker)) errors.add(`第${number}行说话人「${kind.speaker}」是占位名，请按人物表写实际人物或稳定的未知声音标识。`)
      else if (scene?.cast !== undefined && !NON_CAST_LABELS.has(kind.speaker) && !scene.cast.has(kind.speaker)) {
        errors.add(`第${number}行说话人「${kind.speaker}」不在本场「人物：」行里。`)
      }
    } else if (kind.kind === 'other') {
      warnings.add(`第${number}行既不是▲动作行，也不是「人物：台词」或标记行。`)
    }
    const hook = kind.kind === 'hook' ? MANUSCRIPT_HOOK_MARKER.exec(plain) : null
    lastBody = { line: number, hookOnly: hook !== null && plain.slice(hook[0].length).trim().length === 0 }
  }
  if (scenes.length === 0) errors.add(`第${range.episode}集没有「${range.episode}-1 地点 日 内」格式的场次标题。`)
  if (actions === 0) errors.add(`第${range.episode}集没有一行▲动作。▲行来自画面观察，写人物位置、动作、表情和关键道具。`)
  if (lastBody?.hookOnly === true) errors.add(`第${lastBody.line}行「【下集钩子】」是第${range.episode}集最后一行；钩子标记后要有原片里的悬念动作或台词，原片没有悬念时删掉标记。`)
  for (const scene of scenes) if (scene.actions === 0) warnings.add(`第${scene.line}行场次「${scene.description}」没有▲动作行。`)
  const ranked = [...speakers.entries()].map(([name, count]) => ({ name, lines: count })).toSorted((a, b) => b.lines - a.lines)
  const top = ranked[0]
  if (top !== undefined && dialogues >= limits.formatDominantSpeakerMinLines
    && top.lines / dialogues >= limits.formatDominantSpeakerShare) {
    warnings.add(`第${range.episode}集${dialogues}句台词里有${top.lines}句标为「${top.name}」，请对照画面核对说话人。`)
  }
  return { episode: range.episode, start_line: range.start, end_line: range.end, scenes: scenes.length, action_lines: actions,
    dialogue_lines: dialogues, speakers: ranked, error_count: errors.count, warning_count: warnings.count,
    errors: errors.texts, warnings: warnings.texts, scene_descriptions: scenes.map(scene => scene.description) }
}

/**
 * Measure the literal screenplay structure of every `第N集` section, without judging content against the source.
 * @param text - Extracted manuscript text; it is data, never instructions.
 * @param limits - Advisory warning thresholds and message caps.
 * @returns Per-episode counts, errors that break the shared `screenplay-format` rules, and advisory warnings.
 */
export function screenplayFacts(text: string, limits: ScreenplayFormatLimits): ScreenplayFacts {
  const lines = text.split(/\r\n|\r|\n/u), index = manuscriptEpisodeIndex(lines)
  const errors = new Messages(limits.formatMaxMessages), warnings = new Messages(limits.formatMaxMessages)
  if (index.state === 'unavailable') errors.add('没有可识别的「第N集」标题；每集要以独立一行「第N集」开头。')
  for (const issue of index.issues) errors.add(issue)
  const assessed = index.episodes.map(range => assessEpisode(lines, range, limits))
  let run: { from: number; to: number; description: string; length: number } | undefined
  const flush = (): void => {
    if (run !== undefined && run.length >= limits.formatRepeatedSceneEpisodes) {
      warnings.add(`第${run.from}–${run.to}集都只有一个场次「${run.description}」，请对照画面核对是否真在同一场景。`)
    }
  }
  for (const episode of assessed) {
    const description = episode.scene_descriptions.length === 1 ? episode.scene_descriptions[0] : undefined
    if (description !== undefined && run?.description === description && run.to + 1 === episode.episode) {
      run = { ...run, to: episode.episode, length: run.length + 1 }
    } else {
      flush()
      run = description === undefined ? undefined : { from: episode.episode, to: episode.episode, description, length: 1 }
    }
  }
  flush()
  const episodes = assessed.map(({ scene_descriptions: _descriptions, ...episode }) => episode)
  return { episodes, error_count: errors.count + episodes.reduce((sum, episode) => sum + episode.error_count, 0),
    warning_count: warnings.count + episodes.reduce((sum, episode) => sum + episode.warning_count, 0),
    errors: errors.texts, warnings: warnings.texts }
}
