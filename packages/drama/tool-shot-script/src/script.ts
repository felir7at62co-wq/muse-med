/**
 * Director-format shot-script parsing and this format's decidable rules.
 *
 * Each `【镜头N】` block preserves its speech and voice choice. Explicit positive
 * whole-second durations take precedence over speech/complexity estimates.
 * Creative checks produce warnings; malformed fields remain failures.
 *
 * The parser never throws and never stops at the first problem: it returns every
 * parsed shot plus the complete issue list, so one call tells the model
 * everything it must repair.
 *
 * @module @deepseek-ai/dsh-tool-shot-script/script
 */

import type { DurationSource, IssueCode, IssueSeverity, ParsedShot, ShotIssue, VoiceType } from './types.ts'

/** Han characters, Latin letters, and digits: punctuation and spaces never count. */
const EFFECTIVE_CHARS = /[\u4e00-\u9fffA-Za-z0-9]/g

/**
 * Narration declarations produce advisory guidance and retain speech as `vo`.
 * Ordinary dialogue containing these words is not scanned.
 */
const NARRATION_MARKERS = /(旁白|解说|心声|画外声|叙述|\bos\b)/i

/** `（画外音）`/`(VO)` on a speaker name: the sentence continues off screen. */
const OFFSCREEN_SUFFIX = /[（(]\s*(?:画外音|vo)\s*[）)]\s*$/i

/** A bare `画外音`/`vo` label in the speech-label or voice-type position. */
const OFFSCREEN_LABEL = /^(?:画外音|vo)$/i

/** One speech line: a label, a colon, and a payload that may be empty. */
const SPEECH_LINE = /^(台词|画外音|画外声|心声|旁白|解说|VO|OS|dialogue)[：:][ \t]*(.*)$/gim

/** `台词：角色名：原文` — the speaker prefix the director format allows. */
const SPEAKER_PREFIX = /^([^：:]{1,30})[：:](.+)$/

/** `台词：角色名：` — a speaker prefix with nothing left to say. */
const SPEAKER_PREFIX_ONLY = /^([^：:]{1,30})[：:]\s*$/

/** The style line every shot block is preceded by, with the whitespace that follows it. */
const STYLE_LINE = /真人短剧写实风格\s*$/

/** A suggested negative prompt; absence only produces a warning. */
const NEGATIVE_PROMPT = '无噪点，无跳帧，五官稳定不变形'

/** A marker line, captured together with its shot number. */
const SHOT_MARKER = /^【镜头(\d+)】[ \t]*$/gm

/** The legacy `时长` field, tolerated on old scripts and stripped from the prompt. */
const LEGACY_DURATION = /^时长[：:][ \t]*(.*)$/m

/** A legacy duration value this format still accepts on an old script. */
const LEGACY_DURATION_VALUE = /^[1-9]\d*秒$/

/** Any seconds expression left in a shot body. */
const SECONDS_IN_BODY = /\d[ \t]*秒/

/** The `出镜人物` placeholder this format refuses, with optional sentence punctuation. */
const CHARACTERS_PLACEHOLDER = /^无[。.！!？?\s]*$/

/** Per-shot complexity labels and the whole seconds each charges to a package. */
const ACTION_COMPLEXITY: Readonly<Record<string, number>> = {
  '简单': 1,
  '一般': 2,
  '较复杂': 3,
  '复杂': 4,
}

/** Every accepted `动作复杂度` label, for the refusal message. */
const COMPLEXITY_LABELS = '简单/一般/较复杂/复杂'

/** Advisory spoken-text threshold; longer speech remains intact. */
const MAX_EFFECTIVE_CHARS = 36

/** The writing threshold above which the source sentence should have been split. */
const WRITING_THRESHOLD_CHARS = 15

/** Guidance for checking the project's voice choice without rewriting speech. */
const NARRATION_FIX_HINT = '将作为 vo 画外发声保留，不阻塞编译；请核对本项目是否需要旁白/心声，'
  + '并核对说话人、原文与后期发声轨，不要删改原文。'

/** How the parser charges a silent shot that declares no complexity. */
export interface ParseOptions {
  /** Seconds charged to a silent shot with no `动作复杂度` label. */
  actionShotSeconds: number
}

/** Everything one parse produced. */
export interface ParseResult {
  /** Parsed shots in script order, including shots that broke a rule. */
  shots: ParsedShot[]
  /** Every problem found, failures and warnings together. */
  issues: ShotIssue[]
}

/**
 * Count the effective characters of one spoken text: Han characters, Latin
 * letters, and digits. Punctuation, spaces, and symbols do not count, so reading
 * speed is measured the way this format's 9 字/秒 rule measures it.
 * @param text - Spoken text, with or without punctuation.
 * @returns The number of effective characters.
 */
export function effectiveChars(text: string): number {
  return (text.match(EFFECTIVE_CHARS) ?? []).length
}

/**
 * Derive a speaking shot's whole-second duration.
 * @param chars - Effective characters of the spoken text.
 * @returns `max(1, ceil(chars / 9))` seconds.
 */
export function speechSeconds(chars: number): number {
  return Math.max(1, Math.ceil(chars / 9))
}

/** Trim the bracket forms the older gate shell wrapped field values in. */
function trimBrackets(value: string): string {
  return value.trim().replace(/^[【】]+/, '').replace(/[【】]+$/, '')
}

/**
 * Read one capture group of a successful match.
 * @param match - A successful match of a pattern this module owns.
 * @param index - 1-based capture-group index.
 * @returns The captured text.
 */
function capture(match: readonly string[], index: number): string {
  /* v8 ignore next -- every pattern read through this helper requires the group it returns. */
  return match[index] ?? ''
}

/**
 * Read one field, or an empty string when the block omits it.
 *
 * Two spellings are accepted for every field: the canonical `名称：值`, and the
 * older gate shell's `名称【值】`, which wrapped values in brackets.
 */
function field(block: string, name: string): string {
  const bracketed = new RegExp(`^${name}【(.+)】[ \\t]*$`, 'm').exec(block)
  if (bracketed !== null) return capture(bracketed, 1).trim()
  const colon = new RegExp(`^${name}[：:][ \\t]*(.+)$`, 'm').exec(block)
  return colon === null ? '' : trimBrackets(capture(colon, 1))
}

/** The 1-based line holding one character offset. */
function lineAt(text: string, offset: number): number {
  let line = 1
  for (let index = text.indexOf('\n'); index >= 0 && index < offset; index = text.indexOf('\n', index + 1)) {
    line += 1
  }
  return line
}

/** Build one issue. */
function issue(
  severity: IssueSeverity,
  code: IssueCode,
  shot: number,
  line: number,
  message: string,
): ShotIssue {
  return { severity, code, shot, line, message }
}

/** One shot block located in the script text. */
interface Block {
  /** 0-based offset of the marker line. */
  start: number
  /** Exclusive end offset of this block. */
  end: number
  /** Shot number the marker declares. */
  number: number
}

/** Locate every `【镜头N】` block with the offsets its line numbers and text need. */
function splitBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const markers = [...text.matchAll(SHOT_MARKER)]
  for (const [index, marker] of markers.entries()) {
    blocks.push({
      start: marker.index,
      end: markers[index + 1]?.index ?? text.length,
      number: Number(capture(marker, 1)),
    })
  }
  return blocks
}

/** One shot's `发声类型`/`语音类型` declaration. */
interface VoiceDeclaration {
  /** Declared value, or an empty string when the block omits both fields. */
  value: string
  /** 1-based line of the declaring field, or the marker line when there is none. */
  line: number
  /** Every issue the declaration produced. */
  issues: ShotIssue[]
}

/** Read the voice-type declaration, preferring `发声类型` over the older `语音类型`. */
function readVoiceType(text: string, block: Block, blockText: string): VoiceDeclaration {
  const declared = field(blockText, '发声类型')
  const name = declared === '' ? '语音类型' : '发声类型'
  const value = declared === '' ? field(blockText, '语音类型') : declared
  if (value === '') return { value, line: lineAt(text, block.start), issues: [] }
  const line = lineAt(text, block.start + fieldOffset(blockText, name))
  const marker = NARRATION_MARKERS.exec(value)
  if (marker === null) return { value, line, issues: [] }
  return {
    value,
    line,
    issues: [issue('warning', 'narration_marker', block.number, line,
      `镜头${block.number}（脚本第${line}行）出现旁白/心声标记「${marker[0]}」：${NARRATION_FIX_HINT}`)],
  }
}

/** One shot's speech decision. */
interface Speech {
  /** How the shot produces sound. */
  voiceType: VoiceType
  /** Resolved speaker name, or an empty string. */
  speaker: string
  /** Spoken text with the speaker prefix and off-screen suffix removed. */
  text: string
  /** 1-based line of the speech line, or the marker line when the shot has none. */
  line: number
  /** Every issue the speech lines produced. */
  issues: ShotIssue[]
}

/** Read the silence or speech declaration of one shot block. */
function readSpeech(text: string, block: Block, blockText: string, directorFormat: boolean): Speech {
  const voice = readVoiceType(text, block, blockText)
  const issues: ShotIssue[] = [...voice.issues]
  const markerLine = lineAt(text, block.start)
  const declaredAction = voice.value.trim().toLowerCase() === 'action'
  const speechLines = [...blockText.matchAll(SPEECH_LINE)]
  for (const line of speechLines) {
    const marker = NARRATION_MARKERS.exec(capture(line, 1))
    if (marker === null) continue
    const at = lineAt(text, block.start + line.index)
    issues.push(issue('warning', 'narration_marker', block.number, at,
      `镜头${block.number}（脚本第${at}行）出现旁白/心声标记「${marker[0]}」：${NARRATION_FIX_HINT}`))
  }
  const first = speechLines[0]
  if (first === undefined) {
    if (!declaredAction) {
      issues.push(issue('failure', 'missing_voice_type', block.number, markerLine,
        `镜头${block.number}无正式发声时必须标记 发声类型：action。`))
    }
    return { voiceType: 'action', speaker: '', text: '', line: markerLine, issues }
  }

  const line = lineAt(text, block.start + first.index)
  if (speechLines.length > 1) {
    issues.push(issue('failure', 'multiple_speech_lines', block.number, line,
      `镜头${block.number}最多只能有一条正式发声原文，实际 ${speechLines.length} 条：`
      + '同一句话被切镜时不拆成两条，后半句写成 台词：角色名（画外音）：原文台词。'))
  }
  if (declaredAction) {
    issues.push(issue('failure', 'action_voice_with_dialogue', block.number, line,
      `镜头${block.number}同时声明了 发声类型：action 与台词行：二者只能留一个——`
      + '有台词就删掉 action 行（时长按字数推导），无台词就删掉台词行。'))
  }

  let offscreen = OFFSCREEN_LABEL.test(voice.value.trim()) || NARRATION_MARKERS.test(voice.value)
    || OFFSCREEN_LABEL.test(capture(first, 1)) || NARRATION_MARKERS.test(capture(first, 1))
  let speaker = field(blockText, '说话人')
  let spoken = capture(first, 2).trim()
  if (directorFormat && !NARRATION_MARKERS.test(capture(first, 1))) {
    const prefix = SPEAKER_PREFIX.exec(spoken)
    if (prefix !== null) {
      const possibleSpeaker = capture(prefix, 1).trim()
      const marker = NARRATION_MARKERS.exec(possibleSpeaker)
      if (marker !== null) {
        issues.push(issue('warning', 'narration_marker', block.number, line,
          `镜头${block.number}（脚本第${line}行）出现旁白/心声标记「${marker[0]}」：${NARRATION_FIX_HINT}`))
      }
      offscreen = offscreen || marker !== null || OFFSCREEN_SUFFIX.test(possibleSpeaker)
      speaker = possibleSpeaker.replace(OFFSCREEN_SUFFIX, '').trim()
      spoken = capture(prefix, 2).trim()
    } else if (SPEAKER_PREFIX_ONLY.test(spoken)) {
      spoken = ''
    }
    if (OFFSCREEN_LABEL.test(capture(first, 1).trim())) offscreen = true
  }

  if (spoken === '' || effectiveChars(spoken) === 0) {
    issues.push(issue('failure', 'empty_dialogue_line', block.number, line,
      `镜头${block.number}（脚本第${line}行）的台词没有任何有效字（汉字/字母/数字）：`
      + '它会编译出一条空字幕。无声镜只写 发声类型：action，并整行省略台词行；'
      + '有台词的镜头请写出实际原文。'))
  } else if (CHARACTERS_PLACEHOLDER.test(spoken)) {
    issues.push(issue('failure', 'placeholder_dialogue', block.number, line,
      `镜头${block.number}（脚本第${line}行）的台词是「${spoken}」：它会编译出一条「无」的假字幕；`
      + '无声镜只写 发声类型：action，并整行省略台词行。'))
  }

  return { voiceType: offscreen ? 'vo' : 'dialogue', speaker, text: spoken, line, issues }
}

/** One shot's packing duration. */
interface Duration {
  /** Whole seconds the shot occupies in a package. */
  seconds: number
  /** Which rule produced {@link Duration.seconds}. */
  source: DurationSource
  /** Every issue the duration rules produced. */
  issues: ShotIssue[]
}

/** The offset of one field's declaring line inside the block. */
function fieldOffset(blockText: string, name: string): number {
  return new RegExp(`^${name}[：:]`, 'm').exec(blockText)?.index ?? 0
}

/** Read one shot's duration from its speech, its complexity label, or the default. */
function readDuration(
  text: string,
  block: Block,
  blockText: string,
  speech: Speech,
  options: ParseOptions,
): Duration {
  const issues: ShotIssue[] = []
  const complexity = field(blockText, '动作复杂度')
  const complexityLine = lineAt(text, block.start + fieldOffset(blockText, '动作复杂度'))
  if (speech.text === '') {
    if (complexity === '') return { seconds: options.actionShotSeconds, source: 'default', issues }
    const seconds = ACTION_COMPLEXITY[complexity]
    if (seconds === undefined) {
      issues.push(issue('failure', 'unknown_action_complexity', block.number, complexityLine,
        `镜头${block.number}的 动作复杂度：${complexity} 不是合法取值：只接受 ${COMPLEXITY_LABELS}`
        + '（分别按 1/2/3/4 秒计入打包预算）；复杂动作取 3–4 秒，普通反应与简单动作 1–2 秒。'))
      return { seconds: options.actionShotSeconds, source: 'default', issues }
    }
    return { seconds, source: 'complexity', issues }
  }
  if (complexity !== '') {
    issues.push(issue('warning', 'action_complexity_on_speaking_shot', block.number, complexityLine,
      `镜头${block.number}同时有台词与动作复杂度：估算以发声为准，明确时长声明优先；`
      + '请核对说话时的动作与停顿是否需要额外时间，不必删除动作描述。'))
  }
  const chars = effectiveChars(speech.text)
  const seconds = speechSeconds(chars)
  if (chars > MAX_EFFECTIVE_CHARS) {
    issues.push(issue('warning', 'speech_too_long', block.number, speech.line,
      `镜头${block.number}语音${chars}字，超过建议的 ${MAX_EFFECTIVE_CHARS} 字（估算 ${seconds} 秒）：`
      + '请核对节奏与实际发声时长；可保留长镜头，或按原文语义拆镜，不删改原文与说话人。'))
  } else if (chars > WRITING_THRESHOLD_CHARS) {
    issues.push(issue('warning', 'speech_above_writing_threshold', block.number, speech.line,
      `镜头${block.number}语音${chars}字，超过 ${WRITING_THRESHOLD_CHARS} 字的写作阈值：`
      + `按 9 有效字/秒记为 ${seconds} 秒、不阻塞编译；原文语义上还能拆就拆成连续镜头（不删字、不改顺序）。`))
  }
  return { seconds, source: 'speech', issues }
}

/**
 * Parse one director-format shot script into its shots and every issue it
 * carries. The text is judged exactly as written: this function reads no other
 * file and performs no I/O.
 * @param text - Contents of the shot script, with or without a byte-order mark.
 * @param options - The compiler default a silent shot without a complexity label takes.
 * @returns Parsed shots in script order plus the complete issue list.
 */
export function parseShotScript(text: string, options: ParseOptions): ParseResult {
  const issues: ShotIssue[] = []
  const shots: ParsedShot[] = []
  const blocks = splitBlocks(text)
  if (blocks.length === 0) {
    issues.push(issue('failure', 'no_shots', 0, 0,
      '脚本里没有任何【镜头N】块：本工具编译导演格式镜头脚本，'
      + '每个镜头以独占一行的【镜头N】开头，其上一行是 真人短剧写实风格。'))
    return { shots, issues }
  }
  for (const block of blocks) {
    const blockText = text.slice(block.start, block.end)
    const markerLine = lineAt(text, block.start)
    if (!STYLE_LINE.test(text.slice(0, block.start))) {
      issues.push(issue('warning', 'missing_style_line', block.number, markerLine,
        `镜头${block.number}（脚本第${markerLine}行）前没有建议的「真人短剧写实风格」行：`
        + '请按项目选择风格，不会自动补入固定风格。'))
    }

    const legacy = LEGACY_DURATION.exec(blockText)
    const legacyValue = legacy === null ? '' : capture(legacy, 1).trim()
    const legacyLine = legacy === null ? 0 : lineAt(text, block.start + legacy.index)
    const body = blockText.replace(/^时长[：:].*$\n?/gm, '')
    const declaredSeconds = legacy === null ? undefined : Number(legacyValue.replace(/秒$/, ''))
    const validDuration = legacy !== null && LEGACY_DURATION_VALUE.test(legacyValue)
      && Number.isSafeInteger(declaredSeconds)
    if (legacy !== null && !validDuration) {
      issues.push(issue('failure', 'legacy_duration_invalid', block.number, legacyLine,
        `镜头${block.number}时长必须是正整数秒：${legacyValue}。例如「时长：20秒」；`
        + '省略时长行时按台词或动作复杂度估算。'))
    }
    const seconds = SECONDS_IN_BODY.exec(body)
    if (seconds !== null) {
      const line = lineAt(text, block.start + seconds.index)
      issues.push(issue('warning', 'seconds_in_shot_body', block.number, line,
        `镜头${block.number}（脚本第${line}行）出现秒数「${seconds[0]}」：`
        + '请区分台词原文与拍摄时间要求；正文秒数不改变打包时长，需指定预算时写独立的「时长：N秒」。'))
    }

    const directorFormat = blockText.includes('主体状态追踪：')
    if (directorFormat && !blockText.includes(NEGATIVE_PROMPT)) {
      issues.push(issue('warning', 'missing_negative_prompt', block.number, markerLine,
        `镜头${block.number}没有建议的负面提示「${NEGATIVE_PROMPT}」：请按项目与模型选择是否需要，不自动补入。`))
    }

    const speech = readSpeech(text, block, blockText, directorFormat)
    issues.push(...speech.issues)
    const duration = readDuration(text, block, blockText, speech, options)
    issues.push(...duration.issues)

    if (validDuration && declaredSeconds !== duration.seconds) {
      issues.push(issue('warning', 'legacy_duration_mismatch', block.number, legacyLine,
        `镜头${block.number}估算为${duration.seconds}秒，采用声明的${legacyValue}。`
        + '请试听确认语速、停顿与动作时间；估算不覆盖导演声明。'))
    }
    if (validDuration && declaredSeconds !== undefined) {
      duration.seconds = declaredSeconds
      duration.source = 'declared'
    }

    const charactersField = field(blockText, '出镜人物')
    if (CHARACTERS_PLACEHOLDER.test(charactersField)) {
      const line = lineAt(text, block.start + fieldOffset(blockText, '出镜人物'))
      issues.push(issue('failure', 'characters_placeholder', block.number, line,
        `镜头${block.number}的 出镜人物：${charactersField} 不接受占位值：零人物绑定的镜头`
        + '（纯道具、纯镜像细节）整行省略 出镜人物，不要用「无」占位。'))
    }

    shots.push({
      shot: block.number,
      line: markerLine,
      voiceType: speech.voiceType,
      speaker: speech.speaker,
      text: speech.text,
      effectiveChars: effectiveChars(speech.text),
      durationSeconds: duration.seconds,
      durationSource: duration.source,
      offscreen: speech.voiceType === 'vo',
      charactersField,
      sceneField: field(blockText, '核心场景'),
      propsField: field(blockText, '关键道具'),
      visual: `${STYLE_LINE.test(text.slice(0, block.start)) ? '真人短剧写实风格\n' : ''}${body.trim()}`,
      directorFormat,
      breakAfter: field(blockText, '子任务边界') === '是',
    })
  }

  const deviation = shots.find((item, index) => item.shot !== index + 1)
  if (deviation !== undefined) {
    const position = shots.indexOf(deviation) + 1
    issues.push(issue('failure', 'shot_numbering', deviation.shot, deviation.line,
      `镜头号不连续：第 ${position} 个镜头块的编号是「${deviation.shot}」，应为 ${position}；`
      + '镜头必须从 1 开始连续编号，不跳号、不重复。'))
  }
  return { shots, issues }
}
