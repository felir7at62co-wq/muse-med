/** Literal episode endings and action locations; screenplay placement remains an editorial decision. */
import { manuscriptDialogue } from './manuscript-advisories.ts'
import type { ManuscriptScene } from './manuscript-scenes.ts'

type Scene = ManuscriptScene & { path: string }
interface Location { path: string; episode: string; scene: string; line: number; quote: string }
interface Material extends Location { kind: 'action_line' | 'dialogue'; parentheticals: string[] }
interface Group<T> { findings: T[]; total: number; omitted: number; budget_omitted: number }
interface Limits { maximumFindings: number; maxTextCharacters: number }
type Mode = 'adapt' | 'transcribe' | 'edit' | 'unknown'

/**
 * Describe screenplay notation without imposing a creative workflow or a count requirement.
 * @param mode - Explicit work mode, when selected; an absent mode does not imply permission to adapt.
 * @returns Brief format references, with source fidelity distinct from authorized adaptation.
 */
export function manuscriptFormatReference(mode: Mode = 'unknown') {
  return {
    action_line: '▲写观众需要看懂的画面事件：进出、走位、物品交接、无对白反应，以及改变局面的动作过程和结果。按剧情作用区分，不按动作长短或是否同步说话机械拆分。',
    parenthetical: '人物名（括注）：台词。括注服务于这句话怎样说，写语气、神态或局部伴随表现；重要事件不靠括注代替。同一动作不重复写，每句不必都有括注。',
    dialogue: '同一人连续表达同一层意思，不因ASR分段机械拆行；保留真实的插话、转折和动作节拍。',
    ending: '【下集钩子】标在本集实际留悬内容之前，下接正常动作或对白；它属于本集结尾，不另抄一遍末段。标识存在不证明悬念有效，缺少标识不证明剧情有错。',
    source_scope: mode === 'transcribe'
      ? '忠实转写只整理原片已有的结尾信息，不新增事实、不提前搬入下一集；原片完全收束或大结局时如实保留，不强编悬念。'
      : mode === 'adapt'
        ? '改编可在用户已授权的故事材料内调整结尾落点；没有来源支持的动作、事实和人物表现不凭空补写。'
        : '依用户当前任务区分忠实转写与改编；未明确授权改编时，格式参考不构成新增事实或改动结尾的授权。',
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
    const lastMaterials = new Set([endingLines.findLast(line => line.kind === 'action_line')?.line,
      endingLines.findLast(line => line.kind === 'dialogue')?.line,
      endingLines.findLast(line => line.parentheticals.length > 0)?.line])
    const takeSelection = <T extends { quote: string }>(allLines: readonly T[], selection: readonly T[]) => {
      const group = quotes.take(selection, true)
      return { ...group, total: allLines.length, omitted: allLines.length - group.findings.length,
        selection_omitted: allLines.length - selection.length }
    }
    const ending = { marker_status: hooks.length ? 'present' : 'not_found', marker_count: hooks.length,
      last_scene: { id: finalScene.id, start_line: finalScene.startLine, end_line: finalScene.endLine },
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
