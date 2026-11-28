/** Bind optional advisory voice samples to the current render and its authored speakers. */
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { audioReviewWavDuration, HarnessError } from '@deepseek-ai/dsh-llm'
import { parseShotScript } from '@deepseek-ai/dsh-tool-shot-script'
import { z } from 'zod'
import { requireProjectAudioFile } from './audio.ts'

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const stableId = z.string().trim().min(1).max(160)
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const productionName = /^production-([a-f0-9]{64})\.json$/u
const maxMetadataBytes = 256 * 1024
const maxReferenceBytes = 15 * 48_000 * 4 + 4096

export const voiceContextInput = z.strictObject({
  source_script: z.string().min(1),
  references: z.array(z.strictObject({
    character_id: stableId,
    voice_period_id: stableId.optional(),
    asset_id: positiveInteger,
    path: z.string().min(1),
  })).min(1).max(3),
})

export type ContentListeningVoiceContext = z.input<typeof voiceContextInput>

export const voiceContextEvidence = z.strictObject({
  production_sha256: sha256,
  script_sha256: sha256,
  project_config_sha256: sha256,
  clip_mapping: z.array(z.strictObject({ render_shot: positiveInteger, source_shots: z.array(positiveInteger).min(1) })).min(1).optional(),
  references: z.array(z.strictObject({
    character_id: stableId,
    voice_period_id: stableId.optional(),
    asset_id: positiveInteger,
    wav_sha256: sha256,
    duration_seconds: z.number().positive().max(15),
  })).min(1).max(3),
})

const production = z.object({
  version: z.literal(1), kind: z.literal('muse_production'), script_id: positiveInteger, episode: z.string(),
  source_sha256: sha256,
  video_tasks: z.array(z.object({ index: positiveInteger.optional(), shots: z.array(positiveInteger).min(1) })).min(1),
})
const projectBible = z.object({
  jubian_script_id: positiveInteger,
  project_bible: z.object({ characters: z.array(z.object({
    character_id: stableId, name: stableId, aliases: z.array(stableId).optional(),
    voice_profile: z.unknown().optional(),
    voice_profiles: z.array(z.looseObject({ voice_period_id: stableId })).optional(),
  })).optional() }),
})
const approvedProfile = z.object({
  reference_audio: z.url().refine((value) => {
    const url = URL.parse(value)
    return url?.protocol === 'https:' && !url.username && !url.password
  }),
  reference_audio_asset_id: positiveInteger,
  reference_audio_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/u),
  reference_audio_duration_seconds: z.number().positive().max(15),
})

type FileIdentity = { readonly path: string; readonly sha256: string | null }
type AuthoredShot = { readonly shot: number; readonly lines: readonly string[] }
type OriginalShot = ReturnType<typeof parseShotScript>['shots'][number]

function requireVoice(condition: unknown, message: string): asserts condition {
  if (!condition) throw new HarnessError(message, 'CONTENT_LISTENING_VOICE_CONTEXT')
}
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function json(bytes: Buffer): unknown { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')) as unknown }
function authoredText(value: string): string { return value.normalize('NFKC').trim() }

function sameOrder<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function explicitLegacyVo(shot: OriginalShot): { speaker: string; text: string } | undefined {
  if (shot.voiceType !== 'vo' || shot.directorFormat || shot.speaker !== '') return undefined
  // The old prop-only format left this explicit speaker in the parsed text. Read only the original 台词 field.
  const source = [...shot.visual.matchAll(/^台词[：:][ \t]*([^\r\n]+)$/gmu)]
  if (source.length !== 1 || authoredText(source[0]?.[1] ?? '') !== authoredText(shot.text)) return undefined
  const parts = /^([^：:\r\n]{1,30})[：:](.+)$/u.exec(shot.text)
  const speaker = parts?.[1]?.trim(), text = parts?.[2]?.trim()
  return speaker && text ? { speaker, text } : undefined
}

/** Match the exact render order to individual authored shots or to the complete formal package order. */
function resolveAuthoredLayout(original: readonly OriginalShot[], packages: z.infer<typeof production>['video_tasks'],
  authored: readonly AuthoredShot[], rendered: readonly number[]) {
  const sourceShots = original.map(({ shot }) => shot)
  requireVoice(sourceShots.length > 0 && new Set(sourceShots).size === sourceShots.length
    && sameOrder(packages.flatMap(task => task.shots), sourceShots)
    && packages.every((task, index) => task.index === undefined || task.index === index + 1),
  '正式制作分包必须按原分镜顺序完整覆盖每一镜，不得重排、重复或漏镜。')
  const authoredByShot = new Map(authored.map(row => [row.shot, row]))
  requireVoice(authoredByShot.size === authored.length && rendered.length === authored.length
    && new Set(rendered).size === rendered.length && rendered.every(shot => authoredByShot.has(shot)),
  '原稿对白计划的镜号与当前成片不符。')
  const grouped = !sameOrder(rendered, sourceShots)
  if (grouped) requireVoice(sameOrder(rendered, packages.map(task => task.index)),
    '成片分包编号或顺序与本集正式制作清单不符。')

  const groups = grouped ? packages.map(task => task.shots) : sourceShots.map(shot => [shot])
  const byShot = new Map(original.map(shot => [shot.shot, shot]))
  const clipMapping: { render_shot: number; source_shots: number[] }[] = []
  const lines = groups.flatMap((ids, index) => {
    const plan = authoredByShot.get(rendered[index] ?? -1)
    requireVoice(plan !== undefined, '当前成片缺少此分包对白。')
    clipMapping.push({ render_shot: plan.shot, source_shots: ids })
    const spoken = ids.flatMap((id) => {
      const shot = byShot.get(id)
      requireVoice(shot !== undefined, '原分镜与正式制作分包不符。')
      if (shot.text === '') return []
      return [{ shot, voice: grouped ? explicitLegacyVo(shot) ?? shot : shot }]
    })
    requireVoice(spoken.length === plan.lines.length
      && spoken.every(({ voice }, i) => authoredText(voice.text) === authoredText(plan.lines[i] ?? '')),
    '原分镜实际对白与当前对白计划不符，须逐句保留原分包和顺序。')
    return spoken.map(({ shot, voice }, i) => ({ shot: shot.shot, voice_type: shot.voiceType, speaker: voice.speaker,
      ...(grouped ? { render_shot: plan.shot, line_index: i + 1 } : {}) }))
  })
  return { lines, clipMapping: grouped ? clipMapping : undefined }
}

/** Resolve one independently identified approved local sample for every authored speaking role. */
export async function resolveContentListeningVoices(input: {
  readonly project: string
  readonly episode: string
  readonly context: ContentListeningVoiceContext
  readonly authored: readonly AuthoredShot[]
  readonly renderedShots: readonly number[]
  readonly authoredPath: string
  readonly authoredSha256: string
  readonly renderedInputs: readonly FileIdentity[]
  readonly read: (path: string, limit: number) => Promise<Buffer>
}) {
  const context = voiceContextInput.safeParse(input.context)
  requireVoice(context.success, '声线听校须提供原分镜文件及 1–3 份项目内已登记的原始 WAV。')
  const project = input.project
  const directory = join(project, 'episode_packages', input.episode)
  const manifests = input.renderedInputs.filter(file => isAbsolute(file.path) &&
    relative(directory, dirname(file.path)) === '' && productionName.test(basename(file.path)))
  const manifest = manifests[0]
  requireVoice(manifests.length === 1 && manifest !== undefined && manifest.sha256 === productionName.exec(basename(manifest.path))?.[1],
    '成片回执缺少当前集唯一的正式制作分包清单。')
  requireVoice(input.renderedInputs.some(file => isAbsolute(file.path)
    && relative(input.authoredPath, file.path) === '' && file.sha256 === input.authoredSha256),
  '当前成片未绑定本次逐镜原稿对白。')
  const [manifestPath, configPath, scriptPath] = await Promise.all([
    requireProjectAudioFile(project, manifest.path), requireProjectAudioFile(project, 'project_config.json'),
    requireProjectAudioFile(project, context.data.source_script),
  ])
  const [manifestBytes, configBytes, scriptBytes] = await Promise.all([
    input.read(manifestPath, maxMetadataBytes), input.read(configPath, maxMetadataBytes),
    input.read(scriptPath, maxMetadataBytes),
  ])
  const productionSha = digest(manifestBytes), configSha = digest(configBytes), scriptSha = digest(scriptBytes)
  requireVoice(productionSha === manifest.sha256, '当前制作分包清单与成片回执不符。')
  requireVoice(input.renderedInputs.some(file => isAbsolute(file.path)
    && relative(configPath, file.path) === '' && file.sha256 === configSha),
  '当前人物声线登记与成片回执不符。')
  const plan = production.safeParse(json(manifestBytes)), bible = projectBible.safeParse(json(configBytes))
  requireVoice(plan.success && bible.success && plan.data.episode === input.episode
    && plan.data.script_id === bible.data.jubian_script_id && plan.data.source_sha256 === scriptSha,
  '原分镜、剧变项目或角色登记与本次正式制作分包不符。')

  const parsed = parseShotScript(scriptBytes.toString('utf8').replace(/^\uFEFF/u, ''), { actionShotSeconds: 2 })
  requireVoice(!parsed.issues.some(issue => issue.severity === 'failure' &&
    ['multiple_speech_lines', 'speaker_mismatch', 'missing_speaker', 'empty_dialogue_line', 'shot_numbering',
      'placeholder_dialogue', 'action_voice_with_dialogue', 'missing_voice_type'].includes(issue.code)),
  '原分镜须提供完整、可识别的逐镜说话人和对白。')
  const layout = resolveAuthoredLayout(parsed.shots, plan.data.video_tasks, input.authored, input.renderedShots)
  const registry = bible.data.project_bible.characters
  requireVoice(registry !== undefined && registry.length > 0, '当前成片缺少本集角色及声线登记。')
  requireVoice(new Set(registry.map(row => row.character_id)).size === registry.length, '当前项目角色编号不得重复。')
  const speaking = layout.lines.map(({ speaker, ...line }) => {
    const matches = registry.filter(character =>
      [character.name, ...character.aliases ?? []].some(name => authoredText(name) === authoredText(speaker)))
    const character = matches[0]
    requireVoice(matches.length === 1 && character !== undefined, '原稿说话人须唯一对应当前项目角色。')
    return { ...line, character }
  })
  const characters = new Map(speaking.map(row => [row.character.character_id, row.character]))
  const refs = new Map(context.data.references.map(ref => [ref.character_id, ref]))
  requireVoice(refs.size === context.data.references.length && refs.size === characters.size,
    '声线参考须为本集每位已确认说话人各提供一份，不得缺漏、重复或附加其他角色。')
  const samples = await Promise.all([...characters].map(async ([id, character]) => {
    const ref = refs.get(id)
    requireVoice(ref !== undefined, '声线参考角色与原稿说话人不符。')
    const periods = character.voice_profiles ?? []
    const period = periods.length === 0 ? undefined : periods[0]
    requireVoice(periods.length <= 1 && ref.voice_period_id === period?.voice_period_id,
      '本集声线样本需与项目唯一明确的人生阶段一致。多个阶段的角色须保留待听校。')
    const approved = approvedProfile.safeParse(period ?? character.voice_profile)
    requireVoice(approved.success && approved.data.reference_audio_asset_id === ref.asset_id,
      '声线资产必须是本项目该角色及阶段已登记的批准 WAV。')
    const path = await requireProjectAudioFile(project, ref.path)
    const wav = await input.read(path, maxReferenceBytes)
    const hash = digest(wav), duration = audioReviewWavDuration(wav)
    requireVoice(hash === approved.data.reference_audio_sha256.toLowerCase() && duration !== undefined && duration <= 15
      && Math.abs(duration - approved.data.reference_audio_duration_seconds) <= 0.001,
    '本地声线 WAV 的原始字节或实际时长与已批准的项目样本不符。')
    return { wav, file: { path, sha256: hash }, identity: {
      character_id: id, ...(ref.voice_period_id === undefined ? {} : { voice_period_id: ref.voice_period_id }),
      asset_id: ref.asset_id, wav_sha256: hash, duration_seconds: duration,
    } }
  }))
  requireVoice(new Set(samples.map(sample => sample.identity.wav_sha256)).size === samples.length,
    '不同说话人须有可区分的独立声线样本。')
  const clipByCharacter = new Map(samples.map((sample, index) => [sample.identity.character_id, index + 2]))
  return {
    wav: samples.map(sample => sample.wav),
    files: [{ path: manifestPath, sha256: productionSha }, { path: configPath, sha256: configSha },
      { path: scriptPath, sha256: scriptSha }, ...samples.map(sample => sample.file)],
    evidence: { production_sha256: productionSha, script_sha256: scriptSha, project_config_sha256: configSha,
      ...(layout.clipMapping === undefined ? {} : { clip_mapping: layout.clipMapping }),
      references: samples.map(sample => sample.identity) },
    spoken: speaking.map(({ character, ...line }) => ({ ...line, character_id: character.character_id,
      reference_attachment: clipByCharacter.get(character.character_id) })),
  }
}
