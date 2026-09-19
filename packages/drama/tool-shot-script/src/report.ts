/**
 * Builders from the compiler's internal shapes to the model-facing result.
 *
 * The result keeps the pipeline's own snake_case spellings, because it is read
 * next to `content_duration_ms`, `assets_manifest.json`, and the Jubian tool
 * arguments it feeds.
 *
 * @module @deepseek-ai/dsh-tool-shot-script/report
 */

import { HOLD_INSTRUCTION, NATURAL_HOLD_SECONDS } from './episode.ts'
import type {
  CompiledShot,
  DramaShotMethod,
  DramaShotReport,
  IssueReport,
  PackedTask,
  PackageReport,
  ShotIssue,
  ShotReport,
} from './types.ts'

/** Everything one call's report is built from. */
export interface ReportInput {
  /** The operation that produced the result. */
  method: DramaShotMethod
  /** Absolute path of the judged shot script. */
  script: string
  /** Absolute path of the asset manifest, or an empty string when none was given. */
  assetsManifest: string
  /** Whether asset binding was judged. */
  assetsChecked: boolean
  /** Compiled shots in script order. */
  shots: readonly CompiledShot[]
  /** Every issue found, failures and warnings together. */
  issues: readonly ShotIssue[]
  /** Packages in submission order; empty when the script has failures. */
  tasks: readonly PackedTask[]
  /** Absolute paths this call wrote. */
  written: readonly string[]
}

/** One issue as the model reads it. */
function issueReport(issue: ShotIssue): IssueReport {
  return {
    severity: issue.severity,
    code: issue.code,
    line: issue.line,
    shot: issue.shot,
    message: issue.message,
  }
}

/** One shot's derived facts as the model reads them. */
function shotReport(item: CompiledShot): ShotReport {
  return {
    shot: item.shot.shot,
    line: item.shot.line,
    voice_type: item.shot.voiceType,
    speaker: item.shot.speaker,
    text: item.shot.text,
    effective_chars: item.shot.effectiveChars,
    duration_seconds: item.shot.durationSeconds,
    duration_source: item.shot.durationSource,
    offscreen: item.shot.offscreen,
    characters_field: item.shot.charactersField,
    scene: item.scene,
    props_field: item.shot.propsField,
    bindings: item.assets.map(asset => ({
      name: asset.name,
      type: asset.type,
      official: asset.official,
      asset_id: asset.assetId,
      material_id: asset.materialId,
      url: asset.url,
    })),
  }
}

/** One packaging plan as the model reads it. */
function packageReport(task: PackedTask): PackageReport {
  return {
    index: task.index,
    shots: task.shots,
    content_seconds: task.contentSeconds,
    content_duration_ms: task.contentSeconds * 1000,
    submit_seconds: task.submitSeconds,
    natural_hold_seconds: NATURAL_HOLD_SECONDS,
    hold_instruction: HOLD_INSTRUCTION,
    material_keys: task.materialKeys,
    material_names: task.materialNames,
  }
}

/**
 * Build the canonical result of one `drama_shot` call.
 *
 * `ok` is true exactly when no failure-severity issue was found; warnings ride
 * along without changing it.
 * @param input - Operation identity, compiled shots, issues, packages, and written paths.
 * @returns The result the tool returns and renders.
 */
export function buildReport(input: ReportInput): DramaShotReport {
  const failures = input.issues.filter(issue => issue.severity === 'failure').map(issueReport)
  const warnings = input.issues.filter(issue => issue.severity === 'warning').map(issueReport)
  return {
    method: input.method,
    ok: failures.length === 0,
    script: input.script,
    assets_manifest: input.assetsManifest,
    assets_checked: input.assetsChecked,
    shots: input.shots.map(shotReport),
    packages: input.tasks.map(packageReport),
    failures,
    warnings,
    written: [...input.written],
    summary: {
      shots: input.shots.length,
      packages: input.tasks.length,
      content_seconds: input.tasks.reduce((total, task) => total + task.contentSeconds, 0),
      failures: failures.length,
      warnings: warnings.length,
    },
  }
}
