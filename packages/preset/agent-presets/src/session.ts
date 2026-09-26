/**
 * The session-log record of which preset a session actually runs.
 *
 * The creation header names the preset a session STARTED with, and it is
 * deep-frozen because that is a creation fact. A session may still change
 * preset while it is blank, and the effect of that change outlives the blank
 * window: the first turn — and every turn after it — runs under the newly
 * mounted composition. Recording the change is what keeps the log honest, and
 * it is required outright by the repo's model-visible ⟺ logged rule, since the
 * preset decides the tool schemas and prompt sections the model sees.
 *
 * Reconstruction reads the `agentPreset` Session projection, never the header
 * alone.
 * @module @deepseek-ai/dsh-agent-presets/session
 */

import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { DEPRECATED_PRESET_IDS } from './display.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's agent preset was chosen after creation, while the session
     * was still blank. Log-only: it records the composition later turns ran
     * under, so a resumed or forked session rebuilds the same one instead of
     * the header's creation-time value.
     */
    'agent-preset/selected': { agentPreset: string }
  }
}

const agentPresetSchema = z.union([z.string(), z.null()])

/**
 * Current Session preset, initialized from its header and advanced by selection events.
 *
 * The wire view resolves a renamed id to its successor so every surface that
 * renders "what this session runs" — the header label and the picker's current
 * mode — reads the id the roster actually carries rather than the id a durable
 * record happened to store. Only the view moves: the durable state, and the
 * state host readers reconstruct the composition from, keep the recorded value.
 */
export const agentPresetProjectionDefinition = {
  key: 'agentPreset',
  stateSchema: agentPresetSchema,
  init: header => header.agentPreset ?? null,
  apply: (state, event) => event.type === 'agent-preset/selected'
    ? event.data.agentPreset
    : state,
  wire: { viewSchema: agentPresetSchema, view: state => state === null ? null : DEPRECATED_PRESET_IDS[state] ?? state },
  stateVersion: 1,
} satisfies ProjectionDefinition<'agentPreset', string | null>
