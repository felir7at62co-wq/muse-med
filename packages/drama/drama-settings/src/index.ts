/** Short-drama Settings page configuration and validated draft-root tool. */

import type { Context, Volatile } from '@deepseek-ai/cordis'
// Type-only: resolves the `settings` service and its Context merge.
import type {} from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { draftDirectory } from './draft-directory.ts'
import { DramaSettingsSchema, type DramaDeliverySpec } from './settings.ts'
import { PROJECT_BIBLE_CHANGES, readProjectBible, previewProjectBible, updateProjectBible, createProjectBinding } from './project-bible.ts'
import type { ProjectBudgetReader } from './project-bible.ts'
import { standaloneScriptTool } from './standalone-script.ts'

export {
  DEFAULT_BGM_DIR, DEFAULT_DELIVERY_SPEC, DEFAULT_JIANYING_DRAFT_DIR, DELIVERY_SPEC_FIELD,
  DRAMA_SETTINGS_DEFAULTS, DRAMA_SETTINGS_NAMESPACE, DramaSettingsSchema,
} from './settings.ts'
export { readProjectBible } from './project-bible.ts'
export type { DramaDeliverySpec, DramaSettings, DramaSettingsField } from './settings.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'drama-settings'

/** Resolved composition options and live settings for short-drama work. */
export interface Config {
  /** IPv4 loopback origin of the optional production studio; omit to leave it unavailable. */
  readonly standaloneStudioAddress?: string
  /** Limit project edits to local production metadata. */
  readonly localProjectOnly?: boolean
  /** Absolute episode delivery directory, or empty to use the project directory. */
  readonly deliveryDir: Volatile<string>
  /** Absolute JianyingPro draft root, or empty while unconfigured. */
  readonly jianyingDraftDir: Volatile<string>
  /** Dimensions, frame rate, and bitrate floor for delivery. */
  readonly deliverySpec: Volatile<DramaDeliverySpec>
  /** Absolute local BGM library, or empty to use the default catalogue. */
  readonly bgmDir: Volatile<string>
  /** Optional paid image-route row selected by the operator. */
  readonly imageStandardId: Volatile<number | undefined>
  /** Default CNY cents for a project without its own authorization. */
  readonly seriesBudgetCents: Volatile<number>
}

/**
 * The durable short-drama section as this row's composition config.
 *
 * The settings service builds one namespace per owned entry from that entry's
 * own `Config` and the values the profile document stores for it, so this export
 * is what puts {@link DramaSettingsSchema} behind the `drama-settings`
 * namespace; the schema's defaults are the values an unconfigured deployment
 * reads.
 */
export const Config = DramaSettingsSchema

/**
 * Mark this row as one that ships its own Settings page, when a settings
 * provider is composed.
 *
 * The automatic form is suppressed because the browser half renders the same
 * section explicitly: leaving `auto` on would expose the namespace twice, once
 * through the page and once through the generated form. The registration is an
 * effect on this row's fiber, so a late-loading or replaced Settings service
 * adopts the policy and unloading the row removes it.
 * @param ctx - Host context that may acquire the settings service.
 * @param config - Resolved studio address, project editing mode and live settings.
 */
export function apply(ctx: Context, config?: Config): void {
  const script = standaloneScriptTool(config?.standaloneStudioAddress ?? '')
  if (script !== undefined) {
    ctx.inject(['tools'], scope => scope.effect(() => scope.tools.register(script)))
  }
  ctx.inject(['settings', 'tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'drama_draft_dir',
      description: 'Read and validate the Jianying draft root from Settings, or save and reread the user-provided editor root. Read before creating drafts; when unconfigured use ask_user_question to ask for the installed editor draft root. Reuse a valid saved path without asking again.',
      parameters: {
        path: { type: 'string', description: 'To save: the user-provided existing absolute editor draft directory, readable and writable on this host. Omit to read.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          status: { type: 'string', required: true, enum: ['ready', 'unconfigured'] },
          path: { type: 'string', required: true, description: 'When ready, pass this path as drafts_dir to draft generation.' },
        } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async args => await draftDirectory(toolCtx.settings, args.path),
    })))
    const local = config?.localProjectOnly === true
    const characterFields = PROJECT_BIBLE_CHANGES.characters.items.properties
    const voiceFields = characterFields.voice_profile.properties
    const localVoiceFields = { speaker_id: voiceFields.speaker_id, description: voiceFields.description }
    const changeFields = local ? {
      title: PROJECT_BIBLE_CHANGES.title, style: PROJECT_BIBLE_CHANGES.style, visual_medium: PROJECT_BIBLE_CHANGES.visual_medium,
      aspect_ratio: { type: 'string' as const, description: 'Project aspect ratio.' },
      episode_plan: PROJECT_BIBLE_CHANGES.episode_plan, delivery: PROJECT_BIBLE_CHANGES.delivery,
      characters: { ...PROJECT_BIBLE_CHANGES.characters, items: { ...PROJECT_BIBLE_CHANGES.characters.items, properties: {
        character_id: characterFields.character_id, name: characterFields.name, aliases: characterFields.aliases,
        role_class: characterFields.role_class,
        voice_profile: { ...characterFields.voice_profile, properties: localVoiceFields },
        voice_profiles: { ...characterFields.voice_profiles, items: { ...characterFields.voice_profiles.items, properties: {
          voice_period_id: characterFields.voice_profiles.items.properties.voice_period_id,
          label: characterFields.voice_profiles.items.properties.label, ...localVoiceFields,
        } } },
      } } }, bgm_feedback: PROJECT_BIBLE_CHANGES.bgm_feedback,
    } : PROJECT_BIBLE_CHANGES
    const actions = ['read', 'preview', 'update'] as const
    const migrationFields = local ? {} : {
      migration_from: { type: 'object', additionalProperties: false,
        description: 'Preview/update to a different empty directory. Copy creative settings and local character identities while retaining the original project.',
        properties: {
          project_dir: { type: 'string', required: true, description: 'Existing absolute source project directory.' },
          script_id: { type: 'integer', required: true, description: 'Verified source Jubian script ID, different from the target in changes.' },
        } },
    } as const
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'drama_project',
      description: local ? 'Read, preview or update the local project bible, episode plan, character identities, aspect ratio, visual style and delivery settings. Historical provider identifiers belong to the original project. For operations on a Jingliu project use jingliu_workflows and its project ID.'
        : 'Read a project bible, preview confirmed changes, save the reviewed revision or create a minimal Jubian binding. Verify the project ID, model and video settings through Jubian before production.',
      parameters: {
        action: { type: 'string', required: true, enum: local ? actions : [...actions, 'bind_only'] as const,
          ...(local ? {} : { description: 'For bind_only, verify that the directory belongs to the target project and has no project_config.json. Pass only changes.jubian_script_id.' }) },
        project_dir: { type: 'string', required: true, description: 'Existing absolute project directory.' },
        changes: { type: 'object', additionalProperties: false, properties: changeFields, description: 'Fields to merge for preview/update; omit for read.' },
        ...migrationFields,
        reason: { type: 'string', description: 'Preview/update reason recorded in version history.' },
        expected_revision: { type: 'string', description: 'Update only: exact current-file revision from preview, including missing for first creation.' },
        preview_fingerprint: { type: 'string', description: 'Update only: fingerprint from the same reviewed preview.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        const budget = local ? undefined : toolCtx.get('jubianBudget') as ProjectBudgetReader | undefined
        if (args.action === 'bind_only') {
          const changes = args.changes
          if (args.migration_from !== undefined || !changes || Object.keys(changes).length !== 1
            || !('jubian_script_id' in changes) || typeof changes.jubian_script_id !== 'number')
            throw new Error('bind_only requires exactly changes.jubian_script_id and no migration_from.')
          return await createProjectBinding(args.project_dir, changes.jubian_script_id, exec.signal)
        }
        if (args.action === 'read') {
          if (args.migration_from !== undefined) throw new Error('migration_from is only valid for preview/update.')
          return await readProjectBible(toolCtx.settings, args.project_dir, budget)
        }
        if (!args.changes || !args.reason) throw new Error('Preview/update requires changes and reason.')
        if (local && Object.keys(args.changes).some(key => !Object.hasOwn(changeFields, key))) {
          throw new Error('The local project bible accepts only local production metadata.')
        }
        if (args.action === 'preview') return await previewProjectBible(toolCtx.settings, args.project_dir,
          args.changes, args.reason, budget, args.migration_from)
        if (!args.expected_revision || !args.preview_fingerprint) throw new Error('Update requires the expected_revision and preview_fingerprint from preview.')
        return await updateProjectBible(toolCtx.settings, args.project_dir, args.changes, args.reason,
          args.expected_revision, args.preview_fingerprint, exec.signal, budget, args.migration_from)
      },
    })))
  })
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
  })
}
