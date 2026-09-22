/**
 * The delivery requirements one project declares for itself.
 *
 * The pipeline's rule tiers are separate on purpose: this tool's structural
 * failures hold in every project, its built-in pacing numbers are advice, and a
 * *project's* own requirements are neither. A project states those in the
 * `project_config.json` that already marks its root, so the tool that compiles
 * the episode reads the ceiling the project chose instead of relying on prose.
 *
 * @module @deepseek-ai/dsh-tool-shot-script/src/delivery
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** The file whose presence marks a project root. */
const PROJECT_CONFIG = 'project_config.json'

/** How many parent directories a script may sit below its project root. */
const MAX_HOPS = 4

/** The one delivery requirement this tool enforces today. */
export interface ProjectDelivery {
  /** Per-shot spoken-text ceiling the project declares, in effective characters. */
  maxEffectiveChars: number
  /** The `project_config.json` that declares it, for the repair text. */
  declaredIn: string
}

/**
 * Read the delivery requirements of the project a script belongs to.
 *
 * An explicit `project` wins; otherwise the search walks up from the script's own
 * directory to the nearest `project_config.json`, which is how the pipeline's own
 * scripts locate a project root. No config and no declared ceiling both mean the
 * project states no requirement, and the caller keeps its own number as advice. A
 * ceiling that is present but unusable is an error rather than a silently
 * ignored requirement.
 * @param scriptPath - Absolute path of the shot script being judged.
 * @param project - Absolute project root, when the call already names one.
 * @returns The declared ceiling, or undefined when the project declares none.
 * @throws {Error} When the ceiling is declared but is not a positive integer.
 */
export async function readProjectDelivery(
  scriptPath: string,
  project?: string,
): Promise<ProjectDelivery | undefined> {
  const found = await projectConfig(scriptPath, project)
  if (found === undefined) return undefined
  const declared = record(record(found.document)?.['delivery'])?.['max_effective_chars_per_shot']
  if (declared === undefined) return undefined
  if (typeof declared !== 'number' || !Number.isSafeInteger(declared) || declared < 1) {
    throw new Error(`${found.path} 的 delivery.max_effective_chars_per_shot 必须是正整数（每镜有效字上限），`
      + `收到 ${JSON.stringify(declared)}。`)
  }
  return { maxEffectiveChars: declared, declaredIn: found.path }
}

/** One project config: where it is and what it parsed to. */
interface FoundConfig {
  /** Absolute path of the `project_config.json`. */
  path: string
  /** Its parsed JSON, or undefined when it is not parseable. */
  document: unknown
}

/** The project config an explicit `project` names, else the nearest one at or above the script. */
async function projectConfig(scriptPath: string, project?: string): Promise<FoundConfig | undefined> {
  if (project !== undefined) {
    const path = join(resolve(project), PROJECT_CONFIG)
    return await readConfig(path) ?? { path, document: undefined }
  }
  let directory = dirname(resolve(scriptPath))
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    const path = join(directory, PROJECT_CONFIG)
    const found = await readConfig(path)
    if (found !== undefined) return found
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
  return undefined
}

/** Read and parse one candidate config, or undefined when no file is there. */
async function readConfig(path: string): Promise<FoundConfig | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    return { path, document: JSON.parse(text) as unknown }
  } catch {
    return { path, document: undefined }
  }
}

/** Narrow one parsed JSON value to a string-keyed record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
