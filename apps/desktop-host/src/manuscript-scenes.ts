/** Complete scene indexing and literal repetition evidence; semantic decisions belong to the editor. */
import { createHash } from 'node:crypto'
import { measureManuscriptLength } from './manuscript-length.ts'

/** A contiguous, unabridged screenplay scene, including its trailing hook. */
export interface ManuscriptScene {
  id: string
  episode: string
  heading: string
  startLine: number
  endLine: number
  /** Episode headings preceding this scene, outside its editable text. */
  prefix: string
  text: string
  sha256: string
}

/** @param text - Exact UTF-8 reading text. @returns Stable text digest, independent of file metadata. */
export function manuscriptTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Partition every input line; an unrecognized manuscript remains one complete section.
 * @param text - Full reading text, never a preview.
 * @returns Ordered scene sections, retaining episode headings and hook lines.
 */
export function manuscriptScenes(text: string): ManuscriptScene[] {
  const lines = text.split('\n'), scenes: ManuscriptScene[] = []
  let start = 0, episode = 'unassigned', heading = '全文', sceneEpisode = episode, sceneNumber = 'body', prefix = ''
  const append = (end: number) => {
    const content = lines.slice(start, end).join('\n')
    if (content.trim()) scenes.push({ id: `${sceneEpisode}:${sceneNumber}`, episode: sceneEpisode, heading,
      startLine: start + 1, endLine: end, prefix, text: content, sha256: manuscriptTextHash(content) })
  }
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').replace(/^\s*#{1,6}\s*/u, '').trim()
    const ep = /^第\s*([\d一二三四五六七八九十百零〇]+)\s*集(?:\s|$|[：:])/u.exec(line)
    const scene = /^(\d+)\s*[-—－]\s*(\d+)(?:\s|[.、])/u.exec(line)
    if (!ep && !scene) continue
    if (i > start && lines.slice(start, i).some(value => value.trim() && !/^\s*(?:#{1,6}\s*)?第\s*[\d一二三四五六七八九十百零〇]+\s*集/u.test(value))) {
      append(i)
      start = i
      prefix = ''
    }
    if (scene && i > start) {
      prefix = lines.slice(start, i).join('\n') + '\n'
      start = i
    }
    if (ep?.[1]) episode = ep[1]
    else if (scene?.[1]) episode = scene[1]
    sceneEpisode = episode
    sceneNumber = scene?.[2] ?? 'body'
    heading = line
  }
  append(lines.length)
  const counts = new Map<string, number>()
  for (const scene of scenes) {
    const count = (counts.get(scene.id) ?? 0) + 1
    counts.set(scene.id, count)
    if (count > 1) scene.id += `:occurrence-${count}`
  }
  return scenes
}

interface Occurrence { scene: string; episode: string; line: number; quote: string; hook: boolean }
/** Literal evidence for a model to judge; repeated wording alone is not repeated story. */
export interface RepetitionFinding {
  kind: 'within_scene' | 'within_episode' | 'body_hook' | 'across_episodes'
  first: Occurrence
  second: Occurrence
}

/**
 * Index whole lines and sentences across all scenes, including nonadjacent episodes.
 * @param scenes - Full series in adopted-file order.
 * @param minCharacters - Deployment-selected minimum normalized letters and numbers.
 * @param maxFindings - Maximum returned pairs; total and overflow remain explicit.
 * @returns Literal candidate pairs and counts, never a semantic pass verdict.
 */
export function manuscriptRepetitions(scenes: readonly ManuscriptScene[], minCharacters: number, maxFindings: number) {
  const index = new Map<string, Occurrence>(), findings: RepetitionFinding[] = [], pairs = new Set<string>()
  let total = 0
  for (const scene of scenes) {
    let hook = false
    for (const [offset, line] of scene.text.split('\n').entries()) {
      if (/【(?:集尾|下集|结尾)?钩子】/u.test(line)) hook = true
      if (/^\s*(?:#{1,6}\s*)?(?:第.*集|\d+\s*[-—－]\s*\d+\s|人物[：:])/u.test(line)) continue
      const speech = line.replace(/^\s*[▲△]\s*/u, '').replace(/^[^：:\n]{1,30}[：:]/u, '')
      const segments = [speech, ...speech.split(/[。！？!?；;]/u)]
      for (const segment of segments) {
        const key = segment.replace(/[^\p{L}\p{N}]/gu, '')
        if (Array.from(key).length < minCharacters) continue
        const occurrence: Occurrence = { scene: scene.id, episode: scene.episode,
          line: scene.startLine + offset, quote: line, hook }
        const prior = index.get(key)
        if (!prior) { index.set(key, occurrence); continue }
        if (prior.scene === occurrence.scene && prior.line === occurrence.line) continue
        const pair = `${prior.scene}:${prior.line}|${occurrence.scene}:${occurrence.line}`
        if (pairs.has(pair)) continue
        pairs.add(pair)
        total++
        if (findings.length < maxFindings) findings.push({ kind: prior.episode !== occurrence.episode ? 'across_episodes'
          : prior.hook !== occurrence.hook ? 'body_hook' : prior.scene === occurrence.scene ? 'within_scene' : 'within_episode',
        first: prior, second: occurrence })
      }
    }
  }
  return { findings, total, omitted: total - findings.length }
}

/** @param scenes - Entire indexed manuscript. @returns Text counts grouped by actual episode labels. */
export function manuscriptEpisodeCounts(scenes: readonly ManuscriptScene[]) {
  const grouped = new Map<string, string[]>()
  for (const scene of scenes) grouped.set(scene.episode, [...grouped.get(scene.episode) ?? [], scene.prefix + scene.text])
  return [...grouped].map(([episode, texts]) => ({ episode, ...measureManuscriptLength(texts.join('\n')) }))
}

/**
 * Count actual headings without hiding repeated labels inside aggregated episode totals.
 * @param documents - Adopted files in reading order.
 * @returns Actual heading counts and all locations of repeated literal episode labels or numbered scenes.
 */
export function manuscriptStructure(documents: readonly { path: string; text: string }[]) {
  type Location = { path: string; line: number; quote: string }
  const episodes = new Map<string, Location[]>(), scenes = new Map<string, Location[]>()
  for (const document of documents) {
    for (const [index, raw] of document.text.split('\n').entries()) {
      const line = raw.replace(/^\s*#{1,6}\s*/u, '').trim()
      const episode = /^第\s*([\d一二三四五六七八九十百零〇]+)\s*集(?:\s|$|[：:])/u.exec(line)
      const scene = /^(\d+)\s*[-—－]\s*(\d+)(?:\s|[.、])/u.exec(line)
      const key = episode?.[1] ?? (scene ? `${scene[1]}-${scene[2]}` : undefined)
      if (!key) continue
      const map = episode ? episodes : scenes
      map.set(key, [...map.get(key) ?? [], { path: document.path, line: index + 1, quote: raw }])
    }
  }
  const count = (map: Map<string, Location[]>) => [...map.values()].reduce((total, locations) => total + locations.length, 0)
  const duplicates = (map: Map<string, Location[]>) => [...map].filter(([, locations]) => locations.length > 1)
    .map(([label, locations]) => ({ label, locations }))
  return { episode_heading_count: count(episodes), unique_episode_label_count: episodes.size,
    scene_heading_count: count(scenes), duplicate_episode_labels: duplicates(episodes), duplicate_scene_labels: duplicates(scenes) }
}
