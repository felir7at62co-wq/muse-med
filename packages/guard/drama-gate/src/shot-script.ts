/**
 * Shot-script and matched-JSON content checks.
 *
 * The counting contract is deliberately the one `compile_director_shots.py`
 * already implements — on-screen `台词` only, 9 effective characters per second,
 * one integer duration of 1–4 seconds, at most 36 effective characters per shot —
 * so this gate can never refuse a file the compiler would accept, and every
 * refusal names the same repair the compiler would demand.
 *
 * Nothing here judges pixels, framing, or taste: the visual review stays in the
 * shot-script skill, because a gate that guessed would block correct work.
 *
 * @module @deepseek-ai/dsh-guard-drama/src/shot-script
 */

/** Effective characters: Han, Latin letters, and digits. Punctuation, spaces, and every other symbol do not count. */
const EFFECTIVE_CHARACTER = /[\u4e00-\u9fffA-Za-z0-9]/g

/**
 * Off-screen narration markers as whole tokens: 画外音 / 画外声 / 心声 / 旁白, plus
 * the ASCII tags `VO` / `OS`. The letter lookarounds keep `voice_type`, `visual`,
 * and `props` from matching, because a marker must stand alone to be one. The
 * classes are written as `[a-z]` under `/i` rather than `[A-Za-z]`, which is the
 * same set without a case-insensitive duplicate-class lint error.
 */
const OFFSCREEN_MARKER = /画外音|画外声|心声|旁白|(?<![a-z])(?:vo|os)(?![a-z])/i

/** A `【镜头N】` heading, as the compiler's block splitter reads it. */
const SHOT_HEADING = /^【镜头(\d+)】[ \t]*$/gm

/** A declared duration line inside one shot block. */
const DURATION_LINE = /^[ \t]*时长[：:][ \t]*(.*?)[ \t]*$/m

/** The on-screen dialogue labels the compiler accepts; every other label is narration and forbidden. */
const DIALOGUE_LINE = /^[ \t]*(?:台词|dialogue)[：:][ \t]*(.*)$/gim

/** The compiler's `角色：原文` split, applied only inside the director format. */
const SPEAKER_PREFIX = /^([^：:]{1,30})[：:](.+)$/

/** The block marker that selects the director format whose `台词` line carries `角色：原文`. */
const DIRECTOR_FORMAT = '主体状态追踪：'

/** The one integer-second duration a shot may declare. */
const ALLOWED_SECONDS = /^[1-4]秒$/

/** Effective characters per second, and the per-shot ceiling, shared with the compiler. */
const CHARS_PER_SECOND = 9
const MAX_SHOT_CHARS = 36

/** The narration repair every narration refusal repeats, verbatim from the pipeline contract. */
const NARRATION_REPAIR =
  '本格式没有旁白：把该台词落成画面内台词（角色在画面中当场说出，文字逐字不改）后重写；'
  + '落不进画面内的段落回报失败，不要静默丢弃、不要改写成叙述字幕。'

/** The dialogue-counting rule, spelled out for a model that must recompute its own durations. */
const COUNTING_RULE = `有效字只数汉字/字母/数字，标点和空格不计，按 ${CHARS_PER_SECOND} 有效字/秒折算。`

/** One `【镜头N】` block of a director-format script. */
interface ShotBlock {
  /** The shot number as written in the heading. */
  readonly number: string
  /** The raw `时长：` value, or undefined when the block declares none. */
  readonly duration: string | undefined
  /** Every on-screen dialogue line's body, in file order. */
  readonly dialogue: readonly string[]
  /** Whether this block is written in the director format whose dialogue line carries a speaker prefix. */
  readonly directorFormat: boolean
}

/** One shot record of a matched/package JSON. */
interface MatchedShot {
  /** The shot's `shot` field, echoed in refusals. */
  readonly number: unknown
  /** The declared shot duration (`script_duration`, falling back to `duration`). */
  readonly duration: unknown
  /** The on-screen dialogue text, when the record states one. */
  readonly spoken: string
  /** Every prose field the narration scan reads. */
  readonly prose: readonly string[]
}

/**
 * Count the effective characters of one spoken line.
 * @param text - the spoken text.
 * @returns how many characters the 9-per-second rule sees.
 */
export function countEffectiveChars(text: string): number {
  return text.match(EFFECTIVE_CHARACTER)?.length ?? 0
}

/**
 * Seconds one spoken line needs under the 9-effective-characters-per-second rule.
 * @param effectiveChars - a count from {@link countEffectiveChars}.
 * @returns the whole number of seconds, never below 1.
 */
export function requiredSeconds(effectiveChars: number): number {
  return Math.max(1, Math.ceil(effectiveChars / CHARS_PER_SECOND))
}

/**
 * Check one director-format shot script.
 * @param text - the complete file text a write or edit would produce.
 * @returns the model-facing Chinese refusal, or undefined when the content passes.
 */
export function checkShotScriptText(text: string): string | undefined {
  const narration = narrationRefusal(text, line => `第 ${line} 行`)
  if (narration !== undefined) return narration
  for (const block of shotBlocks(text)) {
    const refusal = blockRefusal(block)
    if (refusal !== undefined) return refusal
  }
  return undefined
}

/**
 * Check one matched/package JSON text.
 * @param text - the complete file text a write or edit would produce.
 * @returns the model-facing Chinese refusal, or undefined when the content passes.
 */
export function checkMatchedJsonText(text: string): string | undefined {
  const shots = parsedShots(text)
  if (shots === undefined) {
    // Unparseable JSON cannot be judged field by field, and a document with no
    // shots container states no shot the numeric rules could hold anything
    // against; the raw narration scan is still decidable, so it still runs.
    return narrationRefusal(text, () => 'matched JSON 原文里')
  }
  for (const shot of shots) {
    for (const prose of shot.prose) {
      const refusal = narrationRefusal(prose, () => `镜头${describeValue(shot.number)}的文本里`)
      if (refusal !== undefined) return refusal
    }
    const refusal = shotDurationRefusal(shot)
    if (refusal !== undefined) return refusal
  }
  return undefined
}

/** 1-based line number of a character offset inside `text`. */
function countLine(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length
}

/** Split a script into its `【镜头N】` blocks; a script with no heading yields no blocks. */
function shotBlocks(text: string): ShotBlock[] {
  const headings = [...text.matchAll(SHOT_HEADING)]
  return headings.map((heading, index) => {
    const start = heading.index
    const end = headings[index + 1]?.index ?? text.length
    const body = text.slice(start, end)
    return {
      number: heading[1] ?? '',
      duration: DURATION_LINE.exec(body)?.[1],
      dialogue: [...body.matchAll(DIALOGUE_LINE)].map(match => match[1] ?? ''),
      directorFormat: body.includes(DIRECTOR_FORMAT),
    }
  })
}

/** Refuse one shot block's duration and dialogue, or undefined when the block passes. */
function blockRefusal(block: ShotBlock): string | undefined {
  const declared = (block.duration ?? '').trim()
  if (!ALLOWED_SECONDS.test(declared)) return durationRefusal(block.number, declared)
  const seconds = Number.parseInt(declared, 10)
  for (const line of block.dialogue) {
    const refusal = dialogueRefusal(block, seconds, line)
    if (refusal !== undefined) return refusal
  }
  return undefined
}

/** The one duration message, covering a missing, non-integer, and out-of-range declaration. */
function durationRefusal(number: string, declared: string): string {
  const head = declared.length === 0
    ? `镜头${number}没有「时长：」声明`
    : `镜头${number}的时长「${declared}」不合法`
  return `${head}。每镜时长必须是 1–4 的整数秒（写成「时长：3秒」）：小数秒和 5 秒及以上都不接受。`
    + '长台词必须按语义拆成连续镜头，原文、说话人和顺序不变。'
}

/** Refuse one dialogue line against the 36-character ceiling and the 9-per-second duration rule. */
function dialogueRefusal(block: ShotBlock, seconds: number, line: string): string | undefined {
  const spoken = block.directorFormat ? splitSpeaker(line) : line.trim()
  if (spoken.length === 0) return undefined
  const chars = countEffectiveChars(spoken)
  if (chars > MAX_SHOT_CHARS) {
    return `镜头${block.number}的单镜有效字 ${chars} 超过 ${MAX_SHOT_CHARS}。必须按语义拆成连续镜头，原文、说话人和顺序不变。${COUNTING_RULE}`
  }
  const required = requiredSeconds(chars)
  if (seconds !== required) {
    return `镜头${block.number}声明的时长与台词不符：${chars} 个有效字按 ${CHARS_PER_SECOND} 有效字/秒应为 ${required} 秒，实际写成 ${seconds} 秒。`
      + `要么把「时长：」改成 ${required}秒，要么按语义拆分台词。${COUNTING_RULE}`
  }
  return undefined
}

/** Strip the director format's `角色：` prefix, mirroring the compiler's own split. */
function splitSpeaker(line: string): string {
  const match = SPEAKER_PREFIX.exec(line.trim())
  return match === null ? line.trim() : (match[2] ?? '').trim()
}

/**
 * The narration refusal, or undefined when no marker appears. `position` renders
 * where the marker was seen: a script reports its source line, while a JSON field
 * reports the field, because a line number inside one field's value would name a
 * line the reader cannot find in the document.
 */
function narrationRefusal(text: string, position: (line: number) => string): string | undefined {
  const marker = OFFSCREEN_MARKER.exec(text)
  if (marker === null) return undefined
  return `${position(countLine(text, marker.index))}出现旁白/心声标记「${marker[0]}」。${NARRATION_REPAIR}`
}

/** Parse a matched/package JSON into its shot records, or undefined when it states no shots. */
function parsedShots(text: string): MatchedShot[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const container = Array.isArray(parsed) ? parsed : record(parsed)?.['shots']
  if (!Array.isArray(container)) return undefined
  return container.map((entry) => {
    const shot = record(entry) ?? {}
    const spoken = shot['text']
    return {
      number: shot['shot'],
      duration: shot['script_duration'] ?? shot['duration'],
      spoken: typeof spoken === 'string' ? spoken : '',
      prose: [shot['text'], shot['visual'], shot['speaker'], ...stringList(shot['characters'])]
        .filter((value): value is string => typeof value === 'string'),
    }
  })
}

/** Refuse one matched-JSON shot whose declared duration contradicts the 1–4 integer and 9-per-second rules. */
function shotDurationRefusal(shot: MatchedShot): string | undefined {
  const duration = shot.duration
  if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 1 || duration > 4) {
    return `matched JSON 的镜头${describeValue(shot.number)}的时长不合法（${describeValue(duration)}）。`
      + '每镜必须是 1–4 的整数秒；小数秒和 5 秒及以上都不接受。长台词必须按语义拆成连续镜头。'
  }
  if (shot.spoken.length === 0) return undefined
  const chars = countEffectiveChars(shot.spoken)
  if (chars > MAX_SHOT_CHARS) {
    return `matched JSON 的镜头${describeValue(shot.number)}的单镜有效字 ${chars} 超过 ${MAX_SHOT_CHARS}。必须按语义拆成连续镜头，原文、说话人和顺序不变。${COUNTING_RULE}`
  }
  const required = requiredSeconds(chars)
  if (duration !== required) {
    return `matched JSON 的镜头${describeValue(shot.number)}的时长与台词不符：${chars} 个有效字按 ${CHARS_PER_SECOND} 有效字/秒应为 ${required} 秒，实际是 ${duration} 秒。${COUNTING_RULE}`
  }
  return undefined
}

/** Narrow one parsed JSON value to a string-keyed record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Every string member of a JSON array value, or an empty list for any other shape. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** Render one arbitrary JSON value for a refusal message without ever printing `[object Object]`. */
function describeValue(value: unknown): string {
  if (typeof value === 'string') return `「${value}」`
  const rendered: string | undefined = value === undefined ? undefined : JSON.stringify(value)
  return rendered === undefined || rendered.length === 0 ? '缺失' : rendered
}
