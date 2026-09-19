/**
 * Drama gate: the short-drama pipeline's hard rules as a tool-dispatch
 * interceptor rather than prompt discipline.
 *
 * `tools/pre-execute` hands this plugin the tool name and the already-parsed
 * arguments, and a host-plane plugin may read files, so the rules that are
 * genuinely decidable live here: a paid Jubian method must carry an idempotency
 * key, a write into the workshop's shot scripts and matched JSON must satisfy the
 * integer-second / 9-characters-per-second / 36-character contract and must not
 * reintroduce narration, and a paid storyboard submission must follow a recorded
 * `official=true` asset. Everything that needs pixels, taste, or a judgement
 * about the story stays in the shot-script skill.
 *
 * The plugin is a preset row: it is mounted for the drama session only, so no
 * other conversation pays for the checks. What it cannot decide is recorded in
 * the package README.
 *
 * @module @deepseek-ai/dsh-guard-drama
 */

import { readFileSync, readdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: resolves the `tools` service and the `tools/pre-execute` waterfall.
import type {} from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { evaluateCall } from './rules.ts'
import type { GateReader, RuleSwitches } from './rules.ts'

export { evaluateCall } from './rules.ts'
export type { GateCall, GateDecision, GateReader, RuleSwitches } from './rules.ts'
export { checkMatchedJsonText, checkShotScriptText, countEffectiveChars, requiredSeconds } from './shot-script.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'drama-gate'

/**
 * Hard dependency. `tools` owns the `tools/pre-execute` waterfall this plugin
 * intercepts and the registry view it consults before explaining a retired tool
 * name; without it there is nothing to gate.
 */
export const inject = ['tools']

/** Plugin config, validated by the same-named schemastery schema plus the load-time checks in `apply`. */
export interface Config {
  /**
   * Absolute workspace root used only when the session states no working
   * directory of its own (default: none). The session's own cwd always wins,
   * because treating a configured root as stronger would read one conversation's
   * project while judging another's call.
   */
  workspaceRoot?: string
  /** Directory name below the workspace root that holds the drama projects (default `short-drama`). */
  workshopDir?: string
  /** Absolute project root that overrides the workshop-root derivation (default: none). */
  projectRoot?: string
  /** Refuse a Jubian write/paid method that carries no `idempotency_key` (default `true`). */
  idempotencyKey?: boolean
  /** Refuse a write/edit that would land an invalid shot script or matched JSON (default `true`). */
  shotScript?: boolean
  /** Refuse a paid storyboard submission while no `official=true` asset record exists (default `true`). */
  officialAssets?: boolean
  /** Explain a call to a retired MUSE tool name instead of a bare `UNKNOWN_TOOL` (default `true`). */
  museToolNames?: boolean
}

export const Config: z<Config> = z.object({
  workspaceRoot: z.string().default(''),
  workshopDir: z.string().default('short-drama'),
  projectRoot: z.string().default(''),
  idempotencyKey: z.boolean().default(true),
  shotScript: z.boolean().default(true),
  officialAssets: z.boolean().default(true),
  museToolNames: z.boolean().default(true),
})

/**
 * The production reader: ordinary host filesystem reads, never a write and
 * never a throw. A half-written project is a normal state during a pipeline
 * run, so an unreadable path answers "unknown" instead of failing the call.
 */
const HOST_READER: GateReader = {
  readText(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  },
  listDirectoryNames(path) {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch {
      return []
    }
  },
}

/**
 * Reject a `workshopDir` that is not exactly one relative directory name.
 * A separator, an absolute path, or a dot segment would let configuration move
 * the gate's idea of the workshop outside the workspace it is meant to judge.
 * @param value - the configured directory name.
 * @returns the validated name.
 */
function validatedWorkshopDir(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0 || isAbsolute(trimmed) || /[\\/]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new Error(`drama-gate: workshopDir must be one relative directory name, got ${JSON.stringify(value)}`)
  }
  return trimmed
}

/**
 * Reject a configured root that is not absolute.
 * @param label - the config field name used in the failure message.
 * @param value - the configured path, possibly empty.
 * @returns the trimmed absolute path, or an empty string when unconfigured.
 */
function validatedRoot(label: string, value: string): string {
  const trimmed = value.trim()
  if (trimmed.length > 0 && !isAbsolute(trimmed)) {
    throw new Error(`drama-gate: ${label} must be an absolute path, got ${JSON.stringify(value)}`)
  }
  return trimmed
}

/**
 * Install the gate's pre-execute interceptor.
 * @param ctx - plugin context; the listener is scoped to it and disposed with it.
 * @param config - validated {@link Config}; the path fields are re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the fields are set after validation.
  const workshopDir = validatedWorkshopDir(config.workshopDir as string)
  const configuredRoot = validatedRoot('workspaceRoot', config.workspaceRoot as string)
  const projectRoot = validatedRoot('projectRoot', config.projectRoot as string)
  const switches: RuleSwitches = {
    idempotencyKey: config.idempotencyKey as boolean,
    shotScript: config.shotScript as boolean,
    officialAssets: config.officialAssets as boolean,
    museToolNames: config.museToolNames as boolean,
  }

  ctx.on('tools/pre-execute', async (exec: ToolExecution, next): Promise<PreToolDecision> => {
    const decision = evaluateCall({
      toolName: exec.name,
      arguments: exec.arguments,
      reader: HOST_READER,
      switches,
      sessionCwd: exec.agent?.session.header.cwd,
      configuredRoot,
      workshopDir,
      projectRoot,
      registered: ctx.tools.get(exec.name, exec.agent) !== undefined,
    })
    // A refusal never delegates: `next()` would let a later listener allow a call
    // this gate already proved wrong.
    if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason }
    return await next()
  })
}
