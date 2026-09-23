/**
 * Deployment paths for the emotion model.
 *
 * The interpreter is configuration, never a model parameter: a model must not be
 * able to point this plugin at an arbitrary executable. Resolution order is an
 * explicit configuration value, then the environment variable, and nothing else —
 * a silently guessed interpreter would turn a deployment mistake into a confusing
 * runtime failure much later.
 *
 * Registration resolves paths without requiring model resources. Only index and
 * inspect start Python; match/download use local or public data without a model.
 */
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { CatalogConfig } from './types.ts'

/** Deployment settings for track matching, downloads, and optional local emotion analysis. */
export interface BgmConfig {
  /** Absolute path to the Python interpreter that has the model's dependencies. */
  pythonExecutable?: string
  /** Directory holding `tag_list.npy`, `run_config.yaml` and the chord model. */
  dataDir?: string
  /** The Music2Emo emotion head checkpoint (`J_all.ckpt`). */
  weightsPath?: string
  /** Override for the analysed-track index location. */
  indexPath?: string
  /** Optional public HTTPS catalogue; omitted keeps local-index matching. */
  catalogUrl?: string
  /** Absolute download cache directory; defaults under DSH_HOME. */
  cacheDir?: string
  /** Deadline covering one catalogue/download operation, default 60000 ms. */
  networkTimeoutMs?: number
  /** Maximum decoded catalogue size, default 2 MiB. */
  maxCatalogBytes?: number
  /** Maximum track size accepted from the catalogue, default 128 MiB. */
  maxTrackBytes?: number
  /**
   * Extra environment for the model process, most importantly `HF_HOME`.
   *
   * Stated here rather than inherited: a deployment that keeps the ~360 MB
   * backbone cache outside the default location would otherwise re-download it on
   * every fresh host, and the failure mode — a long silent download — looks like a
   * hang. Only these entries plus a fixed ambient allowlist reach the child;
   * do not put credentials in this explicit environment.
   */
  env?: Record<string, string>
  /** Deadline for one Python analysis request; defaults to 300000 ms and kills the worker on expiry. */
  callTimeoutMs?: number
}

/**
 * Resolve optional public-library settings and reject invalid deployment values.
 * @param config - Plugin configuration, never model-supplied URLs or paths.
 * @returns Validated remote settings, or undefined for local-index mode.
 */
export function resolveCatalogConfig(config: BgmConfig): CatalogConfig | undefined {
  if (config.catalogUrl === undefined) return undefined
  const url = new URL(config.catalogUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.href !== config.catalogUrl) throw new Error('catalogUrl must be a canonical public HTTPS URL without credentials, query or fragment')
  const resolved = {
    catalogUrl: url.href,
    cacheDir: config.cacheDir ?? dshHomePath('perception', 'bgm', 'cache'),
    networkTimeoutMs: config.networkTimeoutMs ?? 60000,
    maxCatalogBytes: config.maxCatalogBytes ?? 2 * 1024 * 1024,
    maxTrackBytes: config.maxTrackBytes ?? 128 * 1024 * 1024,
  }
  if (!isAbsolute(resolved.cacheDir)) throw new Error('cacheDir must be absolute')
  for (const key of ['networkTimeoutMs', 'maxCatalogBytes', 'maxTrackBytes'] as const) {
    if (!Number.isSafeInteger(resolved[key]) || resolved[key] < 1) throw new Error(`${key} must be a positive safe integer`)
  }
  if (resolved.networkTimeoutMs > 2147483647) throw new Error('networkTimeoutMs exceeds the timer limit')
  return resolved
}

/** Deployment environment variable supplying the analysis interpreter path. */
export const PYTHON_ENV_VAR = 'DSH_PERCEPTION_PYTHON'
/** Deployment environment variable supplying the emotion-head checkpoint path. */
export const WEIGHTS_ENV_VAR = 'DSH_PERCEPTION_BGM_WEIGHTS'

/**
 * Locate the emotion head cache when no path is configured.
 * @returns The checkpoint path under the harness home; the file need not exist yet.
 */
export function defaultWeightsPath(): string {
  return dshHomePath('perception', 'bgm', 'J_all.ckpt')
}

/**
 * Where the analysed-track index lives by default.
 *
 * Under the harness home, not inside the package: the index is user data that a
 * fresh install must not carry, that an upgrade must not overwrite, and that a
 * read-only package install could not accept at all. It is also shared across
 * sessions, which is what makes one indexing run reusable by the next.
 * @returns The writable-location convention under the harness home; no file is created.
 */
export function defaultIndexPath(): string {
  return dshHomePath('perception', 'bgm', 'bgm-index.json')
}

/**
 * Resolve the interpreter.
 * @param configured - Value from plugin configuration.
 * @returns An absolute existing path, or an empty string when none is usable.
 */
export function resolvePython(configured: string | undefined): string {
  const candidate = configured ?? process.env[PYTHON_ENV_VAR]
  if (candidate === undefined || candidate.trim() === '') return ''
  return isAbsolute(candidate) && existsSync(candidate) ? candidate : ''
}

/**
 * Resolve the emotion head checkpoint.
 * @param configured - Value from plugin configuration.
 * @returns The configured path when it exists, otherwise the cache location.
 */
export function resolveWeights(configured: string | undefined): string {
  const candidate = configured ?? process.env[WEIGHTS_ENV_VAR]
  if (candidate !== undefined && isAbsolute(candidate) && existsSync(candidate)) return candidate
  return defaultWeightsPath()
}
