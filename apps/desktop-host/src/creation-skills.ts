/** Scope-isolated creative skill discovery, forwarding the Host's original resource locations. */
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillSummary } from '@deepseek-ai/dsh-skill'

/** Cordis plugin identity. */
export const name = 'muse-creation-skills'
/** Isolated skill registry populated by this provider. */
export const inject = ['skills']

/** Built-in creative and Office names; user-configured filesystem skills are also available. */
export const CREATION_SKILL_NAMES: readonly string[] = [
  'anime-3d-assets',
  'audio-transcribe',
  'character-reference-library',
  'douyin-download',
  'jubian-snatch',
  'media-link-import',
  'muse-dialogue-polish',
  'muse-episode-design',
  'muse-llm-wiki',
  'muse-project-participation',
  'muse-script-doctor',
  'novel-to-script',
  'office-docx',
  'office-pptx',
  'office-xlsx',
  'screenplay-format',
  'shot-script-creator-16-9-3d',
  'shot-script-creator-9-16',
  'tweet-drama-asset-vision-check',
  'tweet-drama-background-render',
  'tweet-drama-core',
  'tweet-drama-delivery',
  'tweet-drama-draft-build',
  'tweet-drama-project-bible',
  'tweet-drama-project-inspect',
  'tweet-drama-script-convert',
  'tweet-drama-script-split',
  'tweet-drama-shot-asset-match',
  'tweet-drama-voice-continuity',
  'video-review',
  'wechat-shortdrama-harvest',
]
const allowed = new Set(CREATION_SKILL_NAMES)
const userSources = new Set(['custom', 'user-muse', 'user-dsh', 'user-agents', 'project-muse', 'project-dsh', 'project-agents'])
const forwardingChanges = new WeakSet<Context>()

/** Forward approved resources and skills selected by the user's configured directories. */
function available(skill: Pick<SkillSummary, 'name' | 'source'>): boolean {
  return allowed.has(skill.name) || userSources.has(skill.source)
}

/**
 * Forward approved built-in resources and user-configured skills into the isolated creation registry.
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
        const candidates: SkillCandidate[] = catalog.skills.filter(available).map(skill => ({
          ...skill, provider: 'muse-creation', rank: BUNDLED_SKILL_RANK, locator: skill.name,
        }))
        return { candidates, complete: catalog.complete }
      },
      async get(candidate, options) {
        if (!available(candidate)) return undefined
        const skill = await source.get(candidate.name, { cwd: options.cwd, signal: options.signal })
        if (skill === undefined || !available(skill)) return undefined
        return { ...skill, provider: 'muse-creation' }
      },
    }
  })
}
