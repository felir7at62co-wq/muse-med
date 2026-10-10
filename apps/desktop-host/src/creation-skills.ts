/** Scope-isolated creative skill discovery, forwarding the Host's original resource locations. */
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate } from '@deepseek-ai/dsh-skill'

/** Cordis plugin identity. */
export const name = 'muse-creation-skills'
/** Isolated skill registry populated by this provider. */
export const inject = ['skills']

/** Reviewed creative and Office skills, with no runtime/plugin-authoring skill discovery. */
export const CREATION_SKILL_NAMES: readonly string[] = [
  'audio-transcribe',
  'douyin-download',
  'jubian-asset-library',
  'jubian-snatch',
  'media-link-import',
  'muse-creation',
  'muse-dialogue-polish',
  'muse-episode-design',
  'muse-llm-wiki',
  'muse-project-participation',
  'muse-script-doctor',
  'muse-script-editing',
  'novel-to-script',
  'office-docx',
  'office-pptx',
  'office-xlsx',
  'screenplay-format',
  'screenplay-project',
  'shot-script-creator-9-16',
  'transcript-to-novel',
  'transcript-to-script',
  'trope-adaptation',
  'tweet-drama-asset-extract',
  'tweet-drama-asset-vision-check',
  'tweet-drama-background-render',
  'tweet-drama-core',
  'tweet-drama-delivery',
  'tweet-drama-draft-build',
  'tweet-drama-early-shot-script',
  'tweet-drama-pipeline',
  'tweet-drama-project-bible',
  'tweet-drama-project-inspect',
  'tweet-drama-script-convert',
  'tweet-drama-script-split',
  'tweet-drama-shot-asset-match',
  'tweet-drama-voice-continuity',
  'video-review',
  'wechat-shortdrama-harvest',
  'xiaohongshu-reference',
]
const allowed = new Set(CREATION_SKILL_NAMES)
const forwardingChanges = new WeakSet<Context>()
/**
 * Populate only the isolated creation registry from the Host's approved resources.
 * @param ctx - Context in the creation-skills isolated realm.
 */
export function apply(ctx: Context): void {
  const source = ctx.root.get('skills')
  if (source === undefined || source === ctx.skills) throw new Error('creation-skills requires an isolated registry and a Host skill source')
  ctx.skills.registerProvider((control) => {
    ctx.on('skills/change', () => {
      if (forwardingChanges.has(ctx.root)) return
      forwardingChanges.add(ctx.root)
      try { control.invalidate() } finally { forwardingChanges.delete(ctx.root) }
    })
    return {
      name: 'muse-creation',
      async list(options) {
        const catalog = await source.snapshot({ cwd: options.cwd, signal: options.signal })
        const candidates: SkillCandidate[] = catalog.skills.filter(skill => allowed.has(skill.name)).map(skill => ({
          ...skill, provider: 'muse-creation', rank: BUNDLED_SKILL_RANK, locator: skill.name,
        }))
        return { candidates, complete: catalog.complete }
      },
      async get(candidate, options) {
        if (!allowed.has(candidate.name)) return undefined
        const skill = await source.get(candidate.name, { cwd: options.cwd, signal: options.signal })
        if (skill === undefined) return undefined
        return { ...skill, provider: 'muse-creation' }
      },
    }
  })
}
