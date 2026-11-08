/** Public episode observation options projected from Host deployment configuration. */
import { z } from 'zod'

/** No credentials or project data are included in this bootstrap value. */
export const EPISODE_UI_CONFIG_GLOBAL = '__DSH_JUBIAN_EPISODE_UI__'
/** Validated pending-status interval; readiness and history remain explicit. */
export const EpisodeUiConfig = z.strictObject({ episodePollIntervalMs: z.number().int().min(100).max(60000).default(1000) })
/** Parsed public browser observation settings. */
export type EpisodeUiConfig = z.infer<typeof EpisodeUiConfig>
