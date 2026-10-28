/** Literal episode endings and action locations; screenplay placement remains an editorial decision. */
import { manuscriptDialogue } from './manuscript-advisories.ts'
import type { ManuscriptScene } from './manuscript-scenes.ts'

type Scene = ManuscriptScene & { path: string }
interface Location { path: string; episode: string; scene: string; line: number; quote: string }
interface Material extends Location { kind: 'action_line' | 'dialogue'; parentheticals: string[] }
interface Group<T> { findings: T[]; total: number; omitted: number; budget_omitted: number }
interface Limits { maximumFindings: number; maxTextCharacters: number }
interface SourceEnding {
  episode: string
  draft_path?: string
  last_asr: { text: string; start_seconds: number; end_seconds: number } | null
  frames?: readonly { frame_id: string; time: number }[]
}

/**
 * Describe screenplay notation without imposing a creative workflow or a count requirement.
 * @returns Brief format references, with source fidelity distinct from authorized adaptation.
 */
export function manuscriptFormatReference() {
  return {
    action_line: '▲写观众需要看懂的画面事件：进出、走位、物品交接、无对白反应，以及改变局面的动作过程和结果。按剧情作用区分，不按动作长短或是否同步说话机械拆分。',
    parenthetical: '人物名（括注）：台词。括注服务于这句话怎样说，写语气、神态或局部伴随表现；重要事件不靠括注代替。同一动作不重复写，每句不必都有括注。',
    dialogue: '同一人连续表达同一层意思，不因ASR分段机械拆行；保留真实的插话、转折和动作节拍。',
    ending: '本集已有留悬内容时，【下集钩子】只是格式标注，不改变剧情；标在原有末段之前，下接正常动作或对白，不另抄一遍末段。标识存在不证明悬念有效，缺少标识不证明剧情有错；完全收束或大结局不强编悬念。',
    source_scope: '依用户当前任务区分忠实转写与改编；格式整理不授权新增或改写原片事实。',
  }
}

function locations(scene: Scene): Location[] {
  return scene.text.split('\n').map((quote, offset) => ({ path: scene.path, episode: scene.episode,
    scene: scene.id, line: scene.startLine + offset, quote }))
}

function material(location: Location): Material | undefined {
  if (/^\s*[▲△]/u.test(location.quote)) return { ...location, kind: 'action_line', parentheticals: [] }
  const speech = manuscriptDialogue(location)
  return speech ? { ...location, kind: 'dialogue', parentheticals: speech.parentheticals } : undefined
}

function marker(location: Location) {
  const pattern = /^\s*(?:#{1,6}\s*)?(?:【(下集钩子|集尾钩子|结尾钩子|钩子|下集悬念)】|\[(下集钩子|集尾钩子|结尾钩子|钩子|下集悬念)\]|(下集钩子|集尾钩子|结尾钩子|下集悬念)\s*(?:[：:]|$))\s*/u
  const match = pattern.exec(location.quote), label = match?.[1] ?? match?.[2] ?? match?.[3]
  return match && label ? { ...location, marker: label,
    inline_content: location.quote.slice(match[0].length) } : undefined
}

function budget(limits: Limits) {
  let characters = 0
  return {
    take<T extends { quote: string }>(all: readonly T[], tail = false): Group<T> {
      const findings: T[] = []
      for (const entry of tail ? [...all].reverse() : all) {
        if (findings.length >= limits.maximumFindings || characters + entry.quote.length > limits.maxTextCharacters) continue
        characters += entry.quote.length
        findings.push(entry)
      }
      if (tail) findings.reverse()
      return { findings, total: all.length, omitted: all.length - findings.length, budget_omitted: all.length - findings.length }
    },
    characters: () => characters,
  }
}

function endpoints<T extends Location>(all: readonly T[], materialLines: readonly Material[]) {
  const selected = new Set([all[0]?.line, all.at(-1)?.line,
    materialLines.findLast(line => line.kind === 'action_line')?.line,
    materialLines.findLast(line => line.kind === 'dialogue')?.line,
    materialLines.findLast(line => line.parentheticals.length > 0)?.line])
  return all.filter(line => selected.has(line.line))
}

/**
 * Return exact ending lines and action/parenthetical locations without rating suspense or moving text.
 * @param scenes - Complete current scenes in document order, including file paths.
 * @param limits - Existing result-count and text budgets; omitted quotes remain explicitly counted.
 * @param changedLines - Optional saved-file lines limiting action locations and affected episodes.
 * @param endingEpisodes - Explicit current-file episode labels retaining endings for deletions with no new action line.
 * @returns Structural evidence and original quotes; no action quota, semantic verdict, or manuscript mutation.
 */
export function manuscriptPresentationEvidence(scenes: readonly Scene[], limits: Limits,
  changedLines?: ReadonlyMap<string, ReadonlySet<number>>, endingEpisodes?: ReadonlyMap<string, ReadonlySet<string>>) {
  const grouped = new Map<string, Scene[]>()
  for (const scene of scenes) {
    const key = JSON.stringify([scene.path, scene.episode])
    grouped.set(key, [...grouped.get(key) ?? [], scene])
  }
  const affected = [...grouped.values()].filter(episode => changedLines === undefined || episode.some(scene =>
    endingEpisodes?.get(scene.path)?.has(scene.episode)
    || locations(scene).some(location => changedLines.get(location.path)?.has(location.line))))
  const selected = affected.slice(0, limits.maximumFindings), quotes = budget(limits)
  const episodes = selected.map((episode) => {
    const last = episode.at(-1)
    if (!last) return []
    const all = episode.flatMap(locations), actual = all.flatMap(line => material(line) ?? [])
    const hooks = all.flatMap(line => marker(line) ?? []), lastHook = hooks.at(-1)
    const finalScene = [...episode].reverse().find(scene => actual.some(line => line.scene === scene.id)) ?? last
    const endingLines = actual.filter(line => line.scene === finalScene.id)
    const following = lastHook ? all.filter(line => line.line > lastHook.line && line.quote.trim()) : []
    const lastAction = endingLines.findLast(line => line.kind === 'action_line')
    const lastDialogue = endingLines.findLast(line => line.kind === 'dialogue')
    const lastParenthetical = endingLines.findLast(line => line.parentheticals.length > 0)
    const lastMaterials = new Set([lastAction?.line, lastDialogue?.line, lastParenthetical?.line])
    const position = (line: Material | undefined) => line === undefined ? null : { scene: line.scene, line: line.line }
    const takeSelection = <T extends { quote: string }>(allLines: readonly T[], selection: readonly T[]) => {
      const group = quotes.take(selection, true)
      return { ...group, total: allLines.length, omitted: allLines.length - group.findings.length,
        selection_omitted: allLines.length - selection.length }
    }
    const ending = { marker_status: hooks.length ? 'present' : 'not_found', marker_count: hooks.length,
      last_scene: { id: finalScene.id, start_line: finalScene.startLine, end_line: finalScene.endLine },
      last_material_locations: { action: position(lastAction), dialogue: position(lastDialogue),
        parenthetical: position(lastParenthetical) },
      last_scene_lines: takeSelection(endingLines, endingLines.filter(line => lastMaterials.has(line.line))),
      hook_markers: quotes.take(hooks, true),
      following_last_marker: takeSelection(following, endpoints(following,
        actual.filter(line => lastHook !== undefined && line.line > lastHook.line))),
      excerpt_selection: 'last_material_roles_and_marker_content_endpoints', suspense_assessment: 'not_performed' }
    const actionLocations = actual.filter(line => (line.kind === 'action_line' || line.parentheticals.length)
      && (changedLines === undefined || changedLines.get(line.path)?.has(line.line)))
    const associated = actionLocations.map((line) => {
      const index = actual.indexOf(line), previous = actual[index - 1], next = actual[index + 1]
      return { ...line, adjacent_material: [previous, next].flatMap(neighbor => neighbor?.scene === line.scene
        ? [{ line: neighbor.line, kind: neighbor.kind }] : []) }
    })
    const relatedLines = new Set(associated.flatMap(line => line.adjacent_material.map(neighbor => neighbor.line)))
    return [{ path: last.path, episode: last.episode, ending,
      action_locations: quotes.take(associated), adjacent_lines: quotes.take(actual.filter(line => relatedLines.has(line.line))),
      adjacent_line_relation: 'same_scene_neighbors_not_event_alignment' }]
  }).flat()
  return { advisory: true, semantic_assessment: 'not_performed',
    scope: changedLines === undefined ? 'whole_current_episodes' : 'changed_episodes_and_action_lines',
    episodes, episode_count: affected.length, omitted_episodes: affected.length - episodes.length,
    truncated: affected.length > episodes.length || episodes.some(({ ending, action_locations: actions, adjacent_lines: adjacent }) =>
      [ending.last_scene_lines, ending.hook_markers, ending.following_last_marker, actions, adjacent]
        .some(group => group.budget_omitted > 0)),
    quote_characters: quotes.characters(), max_quote_characters: limits.maxTextCharacters,
    notice: '只返回格式、位置和原句；▲与括注的相邻关系不证明同一事件、重复或遗漏。不按数量报警，不自动搬运、删除或合并。结尾标识与原句不证明悬念质量，原片收束或大结局不构成违规。' }
}

/**
 * Present the current episode ending before structured evidence, retaining complete literal quotes or explicit omissions.
 * @param presentation - Current-file ending evidence, including actual line locations and structural marker status.
 * @param sourceEndings - Exact episode source candidates; the last ASR and last cached frame need not coincide.
 * @param limits - Existing entry and total-text limits; a budget too small for a notice returns only an omission symbol.
 * @returns Bounded advisory text; it does not certify suspense, invent a hook, modify text or require another step.
 */
export function manuscriptEndingCue(presentation: ReturnType<typeof manuscriptPresentationEvidence>,
  sourceEndings: readonly SourceEnding[], limits: Limits): string {
  const entries: { text: string; fallback?: string }[] = [], episodes = presentation.episodes.slice(0, limits.maximumFindings)
  const reference = manuscriptFormatReference()
  for (const episode of episodes) {
    const ending = episode.ending, current = ending.last_scene_lines.findings
    entries.push({ text: `第${episode.episode}集当前结尾：${ending.marker_status === 'not_found'
      ? '未找到【下集钩子】标识' : `已有钩子标识${ending.marker_count}处`}（只记结构，不判悬念质量）。` })
    const positions = [
      { role: '末动作', kind: 'action_line', location: ending.last_material_locations.action },
      { role: '末对白', kind: 'dialogue', location: ending.last_material_locations.dialogue },
    ]
    const quotes = positions.flatMap(({ role, kind, location }) => location === null ? [] : [{ role, line: location.line,
      quote: current.find(line => line.kind === kind && line.scene === location.scene && line.line === location.line)?.quote }])
    const omittedQuote = (line: typeof quotes[number]) => `${line.role}第${line.line}行（原句因预算省略）`
    entries.push(quotes.length ? {
      text: '当前稿原句：' + quotes.map(line => line.quote === undefined ? omittedQuote(line)
        : `${line.role}第${line.line}行「${line.quote}」`).join('；'),
      fallback: '当前稿位置：' + quotes.map(omittedQuote).join('；'),
    } : { text: `当前稿末场${ending.last_scene.id}：${ending.last_scene_lines.total > 0
      ? '原句因选择或预算省略，见结构证据' : '没有返回可识别的动作或对白原句'}。` })
    const sources = sourceEndings.filter(source => source.episode === episode.episode
      && (source.draft_path === undefined || source.draft_path === episode.path))
    const source = sources.length === 1 ? sources[0] : undefined
    if (source === undefined) {
      entries.push({ text: sources.length > 1 ? `来源末段有${sources.length}份候选，未选择唯一来源。` : '来源末段：没有可用候选，未推定原片结尾。' })
      continue
    }
    const asr = source.last_asr, frame = source.frames?.reduce<{ frame_id: string; time: number } | undefined>((latest, candidate) =>
      latest === undefined || candidate.time > latest.time ? candidate : latest, undefined)
    const frameRef = frame === undefined ? '末图引用未提供' : `末图引用${frame.time}秒/${frame.frame_id}`
    entries.push(asr === null ? { text: `来源最后已有ASR：没有可用末句；${frameRef}，不代表无声或台词同步。` } : {
      text: `来源最后已有ASR（${asr.start_seconds}—${asr.end_seconds}秒）：「${asr.text}」；${frameRef}，两者不作同步认定。`,
      fallback: `来源ASR位置：${asr.start_seconds}—${asr.end_seconds}秒（原句因预算省略）；${frameRef}，两者不作同步认定。`,
    })
  }
  const omittedEpisodes = presentation.omitted_episodes + presentation.episodes.length - episodes.length
  if (omittedEpisodes > 0) entries.push({ text: `另有${omittedEpisodes}集因条目预算未列，未作结尾判断。` })
  if (episodes.length) {
    entries.push({ text: `标注参考：${reference.ending}${reference.source_scope}` })
    entries.push({ text: `动作与括注参考：${reference.action_line}${reference.parenthetical}` })
  }
  const full = entries.map(entry => entry.text).join('\n')
  if (full.length <= limits.maxTextCharacters) return full
  const omitted = '部分材料因预算省略，原句和位置见后续结构证据。'
  if (omitted.length > limits.maxTextCharacters) return limits.maxTextCharacters > 0 ? '…' : ''
  const result: string[] = []
  let characters = omitted.length
  for (const entry of entries) {
    const room = limits.maxTextCharacters - characters - 1
    const text = entry.text.length <= room ? entry.text : entry.fallback !== undefined && entry.fallback.length <= room
      ? entry.fallback : undefined
    if (text === undefined) continue
    result.push(text)
    characters += text.length + 1
  }
  return [...result, omitted].join('\n')
}
