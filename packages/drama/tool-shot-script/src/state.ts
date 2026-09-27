/**
 * Character body state and the asset registration it must agree with.
 *
 * A shot declares, per on-screen character, the body state it renders — the
 * pregnancy stage, age band, costume, and hair — inside that character's
 * `主体状态追踪` section as `身体状态`. The asset manifest declares the same thing
 * for the version it registers: `state_or_costume` plus the name, and the
 * episodes that version serves. Both sides are free text, so this module
 * normalizes the two dimensions with a closed vocabulary — the ones that decide
 * the silhouette — and leaves everything else as costume text that must simply
 * appear in the registration.
 *
 * The rule this exists for: a shot naming 孕八周 must not bind an asset whose
 * board is a late-pregnancy body. 沈知意（孕期职场装） was bound for a scripted
 * 孕八周 on 2026-09-28 and rendered a full-term belly, because nothing compared
 * the asset's own board with the script's week. A dimension declared on one side
 * and not the other is `未标阶段`, not agreement.
 *
 * @module @deepseek-ai/dsh-tool-shot-script/state
 */

/** One declared body state, one value per dimension; an empty string means the side declared none. */
export interface StateFacts {
  /** Pregnancy stage: `孕早期`, `孕中期`, `孕晚期`, `非孕期`, `孕期待定`, or the conflict value. */
  pregnancy: string
  /** Age band: `儿童`, `少年`, `青年`, `中年`, or `老年`. */
  age: string
  /** Costume, hair, and anything else left after the dimensions above were read out. */
  costume: string[]
}

/** The value of a dimension that carries two contradictory declarations. */
export const CONFLICT = '冲突'

/** Pregnancy stages in week order, with the week range each one covers. */
const PREGNANCY_BY_WEEK: readonly { readonly tag: string; readonly max: number }[] = [
  { tag: '孕早期', max: 13 },
  { tag: '孕中期', max: 27 },
  { tag: '孕晚期', max: Number.POSITIVE_INFINITY },
]

/** The numerals a scripted week or age spells, in order. */
const NUMERALS = '一二三四五六七八九十'

/** Read one capture group of a successful match. */
function capture(match: readonly string[], index: number): string {
  /* v8 ignore next -- every pattern read through this helper requires the group it returns. */
  return match[index] ?? ''
}

/** The digit one numeral character spells; every character the patterns feed here is one of {@link NUMERALS}. */
function digit(character: string): number {
  /* v8 ignore next -- the patterns accept only the numerals above, so every lookup hits. */
  return NUMERALS.indexOf(character) + 1
}

/** The number one declared token spells, in digits or in the numerals a script uses. */
function toNumber(token: string): number {
  if (/^[0-9]+$/.test(token)) return Number(token)
  const ten = token.indexOf('十')
  if (ten < 0) return digit(token)
  const high = ten === 0 ? 1 : digit(token.slice(0, ten))
  const low = ten === token.length - 1 ? 0 : digit(token.slice(ten + 1))
  return high * 10 + low
}

/** A declaration that the character is pregnant with no stage stated. */
const PREGNANCY_UNSPECIFIED = '孕期待定'

/**
 * The dimensions read out of one free-text declaration, in the order they are
 * consumed: the earliest pattern to match a span owns it, so the 孕期 inside
 * `非孕期` never reads as an unspecified pregnancy.
 */
const DIMENSIONS: readonly { readonly dimension: 'pregnancy' | 'age'
  readonly pattern: RegExp
  readonly value: (match: readonly string[]) => string }[] = [
  { dimension: 'pregnancy', pattern: /非孕期|未孕|无孕|没有怀孕|未怀孕|无身孕|正常体态|平常体态|常人体态/g,
    value: () => '非孕期' },
  { dimension: 'pregnancy', pattern: /孕晚期|孕后期/g, value: () => '孕晚期' },
  { dimension: 'pregnancy', pattern: /孕中期/g, value: () => '孕中期' },
  { dimension: 'pregnancy', pattern: /孕早期|孕初期/g, value: () => '孕早期' },
  { dimension: 'pregnancy', pattern: /(?:怀孕|孕)\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})\s*周/g,
    value: match => pregnancyStage(toNumber(capture(match, 1))) },
  { dimension: 'age', pattern: /([0-9]{1,3}|[一二三四五六七八九十]{1,3})\s*(?:岁|周岁)/g,
    value: match => ageBand(toNumber(capture(match, 1))) },
  { dimension: 'age', pattern: /中老年|中年/g, value: () => '中年' },
  { dimension: 'age', pattern: /老年|老人|老龄/g, value: () => '老年' },
  { dimension: 'age', pattern: /少年|少女|青少年/g, value: () => '少年' },
  { dimension: 'age', pattern: /儿童|孩童|幼儿|婴儿/g, value: () => '儿童' },
  { dimension: 'age', pattern: /青年/g, value: () => '青年' },
]

/** The stage one declared week falls in, clamped at the last stage for an out-of-range week. */
function pregnancyStage(week: number): string {
  const stage = PREGNANCY_BY_WEEK.find(candidate => week <= candidate.max)
  /* v8 ignore next -- the last stage's bound is infinite, so the search always matches. */
  return stage?.tag ?? '孕晚期'
}

/** The age band one declared age falls in. */
function ageBand(years: number): string {
  if (years <= 12) return '儿童'
  if (years <= 17) return '少年'
  if (years <= 40) return '青年'
  if (years <= 60) return '中年'
  return '老年'
}

/** The pregnancy stage one free-text span declares, or an empty string when it declares none. */
function unspecifiedPregnancy(text: string): string {
  return /孕期|怀孕|孕妇|有孕|身孕|妊娠/.test(text) ? PREGNANCY_UNSPECIFIED : ''
}

/**
 * Read one declaration into its dimensions plus the costume and hair left over.
 *
 * Reads `孕八周` as `孕早期` and the costume that follows it as `孕期职场装`, so a
 * late-pregnancy board registering `孕晚期` contradicts the shot's week rather
 * than agreeing with it on the shared word 孕期.
 * @param text - One `身体状态` value, a `state_or_costume` value, or an asset name.
 * @returns Every dimension the text declares plus the costume items left after them.
 */
export function readStateFacts(text: string): StateFacts {
  let rest = text.replace(/\s+/g, ' ')
  const facts: StateFacts = { pregnancy: '', age: '', costume: [] }
  const declared: Record<'pregnancy' | 'age', Set<string>> = { pregnancy: new Set(), age: new Set() }
  for (const { dimension, pattern, value } of DIMENSIONS) {
    for (const match of [...rest.matchAll(pattern)]) {
      declared[dimension].add(value(match))
      rest = rest.replace(match[0], ' ')
    }
  }
  if (declared.pregnancy.size === 0) {
    const unspecified = unspecifiedPregnancy(rest)
    if (unspecified !== '') declared.pregnancy.add(unspecified)
  }
  for (const dimension of ['pregnancy', 'age'] as const) {
    const values = declared[dimension]
    facts[dimension] = values.size > 1 ? CONFLICT : [...values][0] ?? ''
  }
  facts.costume = rest.split(/[；;、,，/／|｜]+/).map(item => item.trim())
    // A value written as `服装：孕期职场装` still names the costume, not the key.
    .map(item => item.replace(/^[\u4e00-\u9fffA-Za-z]{1,6}\s*[:：]\s*/, ''))
    .filter(item => /[\u4e00-\u9fffA-Za-z0-9]/.test(item))
  return facts
}

/**
 * Whether one declaration states any body dimension at all.
 * @param facts - One declaration read by {@link readStateFacts}.
 * @returns True when it names a pregnancy stage or an age band.
 */
export function hasBodyDimension(facts: StateFacts): boolean {
  return facts.pregnancy !== '' || facts.age !== ''
}

/**
 * One costume or hair item as it is compared: without spaces or separators.
 * @param text - One costume or hair item, or a registration's whole costume text.
 * @returns The item with the separators and spaces removed.
 */
export function costumeNeedle(text: string): string {
  return text.replace(/[\s；;、,，/／|｜（）()【】]/g, '')
}

/** The line that opens one on-screen subject's section of a `主体状态追踪` block. */
const SUBJECT_SECTION = /^[ \t]*【([^】\n]+)】/gm

/** The `身体状态` line of one subject's section, written bare or with the subject's name. */
const BODY_STATE = /身体状态\s*[:：]\s*(?:【([^】\n]*)】|([^\n]*))/

/**
 * Read the `身体状态` every on-screen subject of one shot block declares.
 *
 * A section starts at its `【角色名】` line and holds that character's fields —
 * `位置`, `动作状态`, `四层朝向链`, `手部状态`, `情绪状态`, and now `身体状态` — until the
 * next `【角色名】`. The declaration is written the way the other fields are, either
 * bare (`身体状态：【孕早期（孕八周）；孕期职场装】；`) or with the subject's name in
 * front of it, so the character it belongs to is the section it sits in. A
 * character declared twice contributes both values, which reads as a conflict
 * rather than silently keeping the first.
 * @param blockText - One `【镜头N】` block, exactly as the script writes it.
 * @returns One entry per declared character, in script order.
 */
export function declaredBodyStates(blockText: string): Map<string, string> {
  const states = new Map<string, string>()
  const sections = [...blockText.matchAll(SUBJECT_SECTION)]
  for (const [index, section] of sections.entries()) {
    const name = capture(section, 1).trim()
    const body = blockText.slice(section.index, sections[index + 1]?.index ?? blockText.length)
    const declared = BODY_STATE.exec(body)
    if (declared === null) continue
    // Without the wrapping brackets the entry ends with its line, so the trailing
    // separator that closed it is not part of the value.
    const value = (declared[1] ?? capture(declared, 2).replace(/[；;]\s*$/, '')).trim()
    const previous = states.get(name)
    states.set(name, previous === undefined || previous === value ? value : `${previous}；${value}`)
  }
  return states
}

/** One asset's declared episode coverage. */
export type EpisodeList =
  /** The row declares no episode: its coverage is unknown, which is not the same as every episode. */
  | { readonly kind: 'missing' }
  /** The row declares every episode with the all-episodes marker. */
  | { readonly kind: 'all' }
  /** The row declares these episodes. */
  | { readonly kind: 'list'; readonly numbers: number[] }
  /** The row declares an episode value that is neither a number nor the all-episodes marker. */
  | { readonly kind: 'invalid'; readonly raw: string }

/** The spellings that mean "this asset serves every episode"; `jubian_organize` reads the same ones. */
const ALL_EPISODES = new Set(['all', '*', '全剧'])

/** Read one episode entry: a number, the all-episodes marker, or neither. */
function episodeEntry(value: unknown): number | 'all' | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 1 ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (ALL_EPISODES.has(text.toLowerCase())) return 'all'
  return /^[0-9]{1,3}$/.test(text) && Number(text) >= 1 ? Number(text) : null
}

/** One episode value as a failure message spells it. */
function describeEntry(entry: unknown): string {
  if (typeof entry === 'string') return entry
  return JSON.stringify(entry)
}

/**
 * Read one manifest row's `episodes` value.
 * @param value - The row's `episodes` field, as the manifest wrote it.
 * @returns The declared coverage; a value that declares nothing is `missing`, and an
 *   unreadable one is `invalid` with the text that failed.
 */
export function readEpisodes(value: unknown): EpisodeList {
  if (value === undefined || value === null || value === '') return { kind: 'missing' }
  if (!Array.isArray(value) && typeof value !== 'number' && typeof value !== 'string') {
    return { kind: 'invalid', raw: describeEntry(value) }
  }
  const entries = (Array.isArray(value) ? value : [value])
    .filter(entry => !(typeof entry === 'string' && entry.trim() === ''))
  const numbers: number[] = []
  for (const entry of entries) {
    const read = episodeEntry(entry)
    if (read === 'all') return { kind: 'all' }
    if (read === null) return { kind: 'invalid', raw: describeEntry(entry) }
    numbers.push(read)
  }
  return numbers.length === 0 ? { kind: 'missing' } : { kind: 'list', numbers }
}

/**
 * Whether one declared coverage includes one episode.
 * @param coverage - The row's declared coverage.
 * @param episode - The episode being compiled, or undefined when the call names none.
 * @returns True when the asset serves that episode, or when the call named no episode to check.
 */
export function coversEpisode(coverage: EpisodeList, episode: number | undefined): boolean {
  if (coverage.kind === 'all' || episode === undefined) return true
  return coverage.kind === 'list' && coverage.numbers.includes(episode)
}

/**
 * How one coverage reads in a failure message.
 * @param coverage - The row's declared coverage.
 * @returns The episodes it names, or what is wrong with the declaration.
 */
export function describeEpisodes(coverage: EpisodeList): string {
  if (coverage.kind === 'all') return '全剧'
  if (coverage.kind === 'list') return `第 ${coverage.numbers.join('、')} 集`
  if (coverage.kind === 'invalid') return `读不出集号（episodes: ${coverage.raw}）`
  return '未登记 episodes'
}
