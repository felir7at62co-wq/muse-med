/** Session-owned video generation choices shared with the composer. */
import type {} from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-session-projection/types'
import { z } from 'zod'

/** One live video-model specification offered to a person. */
export type VideoModelOption = {
  /** Stable catalogue row and resolution identity. */
  key: string
  modelId: string
  modelName: string
  platformId: string
  standardId: number
  resolution: string
  /** Supported generation types and aspect ratios. */
  genTypes: number[]
  ratios: string[]
  /** Known duration ceiling, or null when the catalogue supplies none. */
  maxDurationSeconds: number | null
}

/** Complete session choice; the revision identifies concurrent edits. */
export type SessionVideoSelection = VideoModelOption & {
  revision: number
}

/** Configured initial specification; catalogue identity is verified before it becomes a saved choice. */
export type VideoModelDefault = Pick<VideoModelOption, 'modelId' | 'platformId' | 'resolution'>

/** Parser for the durable selection's client projection. */
export const videoSelectionSchema: z.ZodType<SessionVideoSelection | null> = z.object({
  key: z.string(), modelId: z.string(), modelName: z.string(), platformId: z.string(),
  standardId: z.number(), resolution: z.string(), genTypes: z.array(z.number()), ratios: z.array(z.string()),
  maxDurationSeconds: z.number().nullable(), revision: z.number(),
}).nullable()

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { jubianVideoSelection: SessionVideoSelection | null }
  interface SessionProjectionMap { jubianVideoSelection: SessionVideoSelection | null }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Configured, delegated or explicit user video selection; independent of the dialogue model and remote project defaults. */
    'jubian/video-selection': { selection: SessionVideoSelection }
  }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The video catalogue, selected specification or caller could not be validated. */
    'jubian-video/rejected': {}
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Video-model selection and related advisory checks; consumers preserve the text as ordinary context.
     * @persistenceAttribution
     */
    'jubian-video-selection': { kind: 'jubian-video-selection' }
  }
}
