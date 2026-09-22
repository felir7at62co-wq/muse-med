/**
 * Types shared by the shot-script parser, the asset binder, the episode
 * packer, and the model-facing `drama_shot` result.
 *
 * Parsed and compiled shots use camelCase; the fields of {@link DramaShotReport}
 * keep the pipeline's own snake_case spellings, because the result is read by
 * the model and by the drama skills next to `content_duration_ms` and
 * `assets_manifest.json`.
 *
 * @module @deepseek-ai/dsh-tool-shot-script/types
 */

/** How one shot produces sound, as the format declares it. */
export type VoiceType =
  /** On-screen dialogue the character speaks in frame. */
  | 'dialogue'
  /** Off-screen speech, including narration and inner monologue. */
  | 'vo'
  /** No speech at all; the shot is an action, a reaction, or a silent insert. */
  | 'action'

/** Which rule produced a shot's packing duration. */
export type DurationSource =
  /** Derived from the spoken text at nine effective characters per second. */
  | 'speech'
  /** Explicit positive whole-second duration in the script. */
  | 'declared'
  /** Derived from the shot's own `动作复杂度` label. */
  | 'complexity'
  /** The compiler default for a silent shot that declares no `动作复杂度`. */
  | 'default'

/** The three operations `drama_shot` accepts. */
export type DramaShotMethod = 'validate' | 'preview' | 'compile'

/** Whether an issue blocks compilation or only asks for a better script. */
export type IssueSeverity = 'failure' | 'warning'

/**
 * Every code this package emits. Codes are stable machine keys: the drama
 * skills, tests, and this package's README all name them, so a message may be
 * reworded while its code keeps its meaning.
 */
export type IssueCode =
  | 'no_shots'
  | 'shot_numbering'
  | 'missing_style_line'
  | 'seconds_in_shot_body'
  | 'legacy_duration_invalid'
  | 'legacy_duration_mismatch'
  | 'missing_negative_prompt'
  | 'narration_marker'
  | 'multiple_speech_lines'
  | 'empty_dialogue_line'
  | 'placeholder_dialogue'
  | 'missing_voice_type'
  | 'action_voice_with_dialogue'
  | 'speech_too_long'
  | 'speech_exceeds_project_limit'
  | 'shot_exceeds_package_budget'
  | 'speech_above_writing_threshold'
  | 'unknown_action_complexity'
  | 'action_complexity_on_speaking_shot'
  | 'characters_placeholder'
  | 'unregistered_scene'
  | 'no_scene_bound'
  | 'unconfirmed_asset'
  | 'incomplete_asset'

/** One decidable problem found in a shot script or its asset binding. */
export interface ShotIssue {
  /** Whether the problem blocks compilation. */
  severity: IssueSeverity
  /** Stable machine key for this rule. */
  code: IssueCode
  /** 1-based script line the problem starts on, or 0 for a script-level problem. */
  line: number
  /** Shot number the problem belongs to, or 0 for a script-level problem. */
  shot: number
  /** Chinese instruction naming the offending value and the repair. */
  message: string
}

/** One shot parsed from the director-format script, before asset binding. */
export interface ParsedShot {
  /** 1-based shot number from the `【镜头N】` marker. */
  shot: number
  /** 1-based script line holding that marker. */
  line: number
  /** Whether the shot carries on-screen speech, off-screen speech, or none. */
  voiceType: VoiceType
  /** Speaker name resolved from the speech line or the `说话人` field. */
  speaker: string
  /** Speech text with the speaker prefix and any off-screen suffix removed. */
  text: string
  /** Han characters, Latin letters, and digits in {@link ParsedShot.text}. */
  effectiveChars: number
  /** Whole seconds this shot occupies in a package. */
  durationSeconds: number
  /** Which rule produced {@link ParsedShot.durationSeconds}. */
  durationSource: DurationSource
  /** Whether the speech continues off screen after a cut. */
  offscreen: boolean
  /** Raw `出镜人物` field value, or an empty string when the line is omitted. */
  charactersField: string
  /** `核心场景` field value, or an empty string when the line is omitted. */
  sceneField: string
  /** Raw `关键道具` field value, or an empty string when the line is omitted. */
  propsField: string
  /** Prompt text: the style line plus the shot block without any duration line. */
  visual: string
  /** Whether the shot declares `主体状态追踪`, which selects the director format. */
  directorFormat: boolean
  /** Whether `子任务边界：是` closes a package after this shot. */
  breakAfter: boolean
}

/** One asset row read from the project's asset manifest. */
export interface ManifestAsset {
  /** Declared asset name, which is also the prompt's `@[name](key)` label. */
  name: string
  /** Manifest id, falling back to the asset name. */
  id: string
  /** Declared type, such as `角色`, `场景`, or `道具`. */
  type: string
  /** Whether the asset passed the official-asset gate. */
  official: boolean
  /** Jubian parent asset id, or an empty string when the manifest omits it. */
  assetId: string
  /** Jubian generated material id, or an empty string when the manifest omits it. */
  materialId: string
  /** Jubian asset URL, or an empty string when the manifest omits it. */
  url: string
  /** Local image path, or an empty string when the asset is remote. */
  localPath: string
}

/** One asset bound to a shot, with the current manifest values. */
export interface BoundAsset {
  /** Declared asset name. */
  name: string
  /** Manifest id, falling back to the asset name. */
  id: string
  /** Declared type. */
  type: string
  /** Whether the asset passed the official-asset gate. */
  official: boolean
  /** Jubian parent asset id. */
  assetId: string
  /** Jubian generated material id. */
  materialId: string
  /** Jubian asset URL. */
  url: string
  /** Local image path the episode package copies, or an empty string. */
  localPath: string
}

/** One shot with its bound assets and its position on the episode timeline. */
export interface CompiledShot {
  /** The parsed shot. */
  shot: ParsedShot
  /** Bound character asset names, in manifest order. */
  characters: string[]
  /** Resolved scene asset name, or an empty string. */
  scene: string
  /** Bound prop asset names, in manifest order. */
  props: string[]
  /** Assets this shot binds, in prompt order: characters, scene, props. */
  assets: BoundAsset[]
  /** Inclusive start second on the episode timeline. */
  start: number
  /** Exclusive end second on the episode timeline. */
  end: number
}

/** One package of continuous shots, the unit one Jubian submission renders. */
export interface PackedTask {
  /** 1-based package number within the episode. */
  index: number
  /** Shot numbers in this package, in script order. */
  shots: number[]
  /** Content seconds this package renders, at most the configured maximum. */
  contentSeconds: number
  /** Clip seconds the submission requests: content plus the natural hold. */
  submitSeconds: number
  /** Ordered `@[name](key)` placeholder keys of this package's prompt. */
  materialKeys: string[]
  /** Ordered bound asset names of this package's shots. */
  materialNames: string[]
}

/** One issue as the model reads it. */
export interface IssueReport {
  /** Whether the issue blocks compilation. */
  severity: IssueSeverity
  /** Stable machine key for the rule that fired. */
  code: string
  /** 1-based script line, or 0 for a script-level issue. */
  line: number
  /** Shot number, or 0 for a script-level issue. */
  shot: number
  /** Chinese instruction naming the offending value and the repair. */
  message: string
}

/** One bound asset as the model reads it. */
export interface BindingReport {
  /** Declared asset name. */
  name: string
  /** Declared type. */
  type: string
  /** Whether the asset passed the official-asset gate. */
  official: boolean
  /** Jubian parent asset id, or an empty string. */
  asset_id: string
  /** Jubian generated material id, or an empty string. */
  material_id: string
  /** Jubian asset URL, or an empty string. */
  url: string
}

/** One shot's derived facts as the model reads them. */
export interface ShotReport {
  /** 1-based shot number. */
  shot: number
  /** 1-based script line of the `【镜头N】` marker. */
  line: number
  /** How the shot produces sound. */
  voice_type: VoiceType
  /** Speaker name, or an empty string for a silent shot. */
  speaker: string
  /** Spoken text, or an empty string for a silent shot. */
  text: string
  /** Han characters, Latin letters, and digits in the spoken text. */
  effective_chars: number
  /** Whole seconds the shot occupies in a package. */
  duration_seconds: number
  /** Which rule produced the duration. */
  duration_source: DurationSource
  /** Whether the speech continues off screen after a cut. */
  offscreen: boolean
  /** Raw `出镜人物` field value, or an empty string. */
  characters_field: string
  /** Resolved scene asset name, or an empty string. */
  scene: string
  /** Raw `关键道具` field value, or an empty string. */
  props_field: string
  /** Assets bound to this shot, in prompt order; empty when none are bound. */
  bindings: BindingReport[]
}

/** One packaging plan as the model reads it. */
export interface PackageReport {
  /** 1-based package number within the episode. */
  index: number
  /** Shot numbers in this package, in script order. */
  shots: number[]
  /** Content seconds within the caller's explicit package budget. */
  content_seconds: number
  /** Content duration in whole milliseconds, the value `jubian_storyboard` `generate` takes. */
  content_duration_ms: number
  /** Whole seconds the submission requests, content plus the natural hold. */
  submit_seconds: number
  /** Extra seconds the prompt asks the provider to hold at the end. */
  natural_hold_seconds: number
  /** The hold instruction the submitted prompt carries. */
  hold_instruction: string
  /** Ordered `@[name](key)` placeholder keys; `select_assets` must match this order. */
  material_keys: string[]
  /** Ordered bound asset names of this package's shots. */
  material_names: string[]
}

/** The canonical result of one `drama_shot` call. */
export interface DramaShotReport {
  /** The operation that produced this report. */
  method: DramaShotMethod
  /** Whether the script compiled; true means no failure-severity issue was found. */
  ok: boolean
  /** Absolute path of the judged shot script. */
  script: string
  /** Absolute path of the asset manifest, or an empty string when none was given. */
  assets_manifest: string
  /** Whether asset binding was judged; false only for `validate` without a manifest. */
  assets_checked: boolean
  /** One row per parsed shot, in script order. */
  shots: ShotReport[]
  /** One row per package; empty for `validate` and for a script with failures. */
  packages: PackageReport[]
  /** Every issue that blocks compilation. */
  failures: IssueReport[]
  /** Every issue that does not block compilation. */
  warnings: IssueReport[]
  /** Absolute paths this call created or overwrote; empty unless `method` is `compile`. */
  written: string[]
  /** Counts and totals for the whole call. */
  summary: {
    /** Number of parsed shots. */
    shots: number
    /** Number of packages. */
    packages: number
    /** Sum of every package's content seconds. */
    content_seconds: number
    /** Number of failure-severity issues. */
    failures: number
    /** Number of warning-severity issues. */
    warnings: number
  }
}

/** One shot row of the matched JSON the drama skills and the pipeline read. */
export interface MatchedShot {
  /** 1-based shot number. */
  shot: number
  /** 1-based shot position in the episode, identical to `shot` for a complete script. */
  segment: number
  /** Always `live_action`. */
  production_mode: string
  /** Inclusive start second on the episode timeline. */
  start: number
  /** Exclusive end second on the episode timeline. */
  end: number
  /** Derived duration in whole seconds. */
  duration: number
  /** Derived duration in whole seconds, kept for older readers. */
  script_duration: number
  /** How the shot produces sound. */
  voice_type: VoiceType
  /** Speaker name, or an empty string. */
  speaker: string
  /** Spoken text, or an empty string. */
  text: string
  /** Bound character asset names, in manifest order. */
  characters: string[]
  /** Whether `子任务边界：是` closes a package after this shot. */
  task_break_after: boolean
  /** Resolved scene asset name, or an empty string. */
  scene: string
  /** Bound prop asset names, in manifest order. */
  props: string[]
  /** Prompt text of this shot. */
  visual: string
  /** Whether the shot uses the director format. */
  director_format: boolean
  /** Bound assets in prompt order, as the manifest records them. */
  assets: MatchedAsset[]
}

/** One bound asset row of the matched JSON. */
export interface MatchedAsset {
  /** Manifest id, falling back to the asset name. */
  id: string
  /** Declared asset name. */
  name: string
  /** Declared type. */
  type: string
  /** Local image path or remote URL, or an empty string. */
  image_path: string
  /** Jubian parent asset id. */
  jubian_asset_id: string
  /** Jubian generated material id. */
  jubian_material_id: string
  /** Whether the asset passed the official-asset gate. */
  official: boolean
}

/** One video task row of the matched JSON. */
export interface MatchedVideoTask {
  /** Shot numbers in this package, in script order. */
  shots: number[]
  /** Content seconds within the caller's explicit package budget. */
  content_duration: number
  /** Extra seconds the prompt asks the provider to hold at the end. */
  natural_hold_duration: number
  /** Whole seconds the submission requests. */
  requested_duration: number
  /** The hold instruction the submitted prompt carries. */
  hold_instruction: string
}

/** The matched JSON one episode compiles to. */
export interface MatchedPayload {
  /** Payload generation this reader set understands. */
  version: number
  /** Two-digit episode number. */
  episode: string
  /** Always `live_action`. */
  production_mode: string
  /** Absolute path of the compiled prompt file. */
  prompt_file: string
  /** Always null: this pipeline derives timing from the integer shot script. */
  timeline_file: null
  /** Always `integer_shot_script`. */
  timing_source: string
  /** One row per shot. */
  shots: MatchedShot[]
  /** One row per package. */
  video_tasks: MatchedVideoTask[]
}
