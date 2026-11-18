/** Read only visible projects and adopted videos from Jingliu's project detail response. */
import { cutImportLimits, type CutEpisode, type CutShot } from './cut-import-protocol.ts'

type Row = Record<string, unknown>
const row = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v)
const validId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.test(v)
const number = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? v : fallback

/** Reduce the visible list to displayable identifiers and titles.
 * @param value - Decoded Jingliu projects response.
 * @returns Project choices in server order.
 */
export function cutProjects(value: unknown): { id: string; title: string }[] {
  if (!row(value) || !Array.isArray(value.projects)) throw Error('catalog')
  return value.projects.filter((p): p is Row => row(p)).flatMap(p => validId(p.id) && typeof p.title === 'string'
    ? [{ id: p.id, title: p.title.slice(0, 256) }] : [])
}

/** Resolve a gateway media key to its production mount, never to user-selected hosts.
 * @param origin - Configured studio origin.
 * @param value - Adopted shot's video_url.
 * @returns Local studio media URL when the shot has a supported media reference.
 */
export function cutMediaUrl(origin: string, value: unknown): URL | undefined {
  if (typeof value !== 'string' || /[\\?#]|%(?:25|2e|2f|5c)|(?:^|\/)\.{1,2}(?:\/|$)/iu.test(value)) return
  let url: URL
  try { url = new URL(value, origin) } catch { return }
  if (url.origin !== origin || url.username || url.password || !/^\/fwp?\/media\/.+\.(?:mp4|mov|webm)$/iu.test(url.pathname)) return
  url.pathname = url.pathname.replace(/^\/fwp?\/media\//u, '/fwp/media/')
  return url
}

interface EpisodeSource {
  title: string
  aspect: string
  episodes: CutEpisode[]
  select(order: number): { edit: CutShot; url: URL }[]
}

/** Collect episode counts or a specific ordered edit list.
 * @param value - Authenticated project detail JSON.
 * @param project - Selected project ID.
 * @param origin - Trusted Jingliu origin.
 * @returns Episode choices and complete server-owned media records.
 */
export function cutProjectDetail(value: unknown, project: string, origin: string): EpisodeSource {
  if (!row(value) || value.id !== project || typeof value.title !== 'string' || !Array.isArray(value.shots)) throw Error('catalog')
  const episodes = new Map<number, CutEpisode>()
  const shots: { episode: number; url: URL; edit: CutShot }[] = []
  for (const s of value.shots) {
    if (!row(s) || s.disabled) continue
    const ep = number(s.episode, 1)
    if (!Number.isSafeInteger(ep) || ep < 1) continue
    const count = episodes.get(ep) ?? { order: ep, ready: 0, total: 0 }
    episodes.set(ep, count)
    count.total++
    const url = cutMediaUrl(origin, s.video_url)
    if (!url) continue
    const speed = number(row(s.transform_meta) ? s.transform_meta.speed : null, 1)
    const durationSec = number(s.clip_dur_sec, number(s.duration_sec, 0))
    const inSec = number(s.clip_in_sec, 0)
    const track = number(s.track_index, 0)
    const overlayStart = number(s.overlay_start_sec, 0)
    const order = number(s.order, -1)
    if (durationSec <= 0 || inSec < 0 || speed <= 0 || speed > 16 || !Number.isSafeInteger(order) || order < 0 ||
      !Number.isSafeInteger(track) || track < 0 || track > 128 || overlayStart < 0) continue
    count.ready++
    shots.push({ episode: ep, url, edit: { order, speed, inSec, durationSec, track, overlayStart } })
  }
  return {
    title: value.title.slice(0, 230), aspect: typeof value.base_aspect === 'string' ? value.base_aspect : '',
    episodes: [...episodes.values()].sort((a, b) => a.order - b.order),
    select: (order: number) => {
      const clips = shots.filter(s => s.episode === order).sort((a, b) => a.edit.order - b.edit.order)
      if (!clips.length || clips.length > cutImportLimits.shots) throw Error('selection')
      return clips
    },
  }
}
