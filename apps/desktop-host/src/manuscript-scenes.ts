/** Complete scene indexing with source locations and stable text digests. */
import { createHash } from 'node:crypto'

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
