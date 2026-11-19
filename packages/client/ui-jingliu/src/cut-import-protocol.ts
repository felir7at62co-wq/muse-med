/** Public Muse-side selection and the media fields sent to the local editor. */
export const cutImportRoute = '/api/jingliu/cut-import'
/** Bound one browser handoff even when a remote asset omits Content-Length. */
export const cutImportLimits = { shots: 120, clipBytes: 256 * 1024 * 1024, episodeBytes: 1024 * 1024 * 1024 } as const

/** A project visible to the logged-in Jingliu user. */
export interface CutProject { id: string; title: string }
/** Counts shown before the user imports the episode's available shots. */
export interface CutEpisode { order: number; ready: number; total: number }
/** Timeline positions use seconds in the original Jingliu project. */
export interface CutShot {
  order: number
  inSec: number
  durationSec: number
  speed: number
  track: number
  overlayStart: number
}
/** A short-lived selection whose clip bytes are read by index. */
export interface CutSelection { ticket: string; name: string; aspect: string; shots: CutShot[] }
