/** Short-drama Settings page configuration and validated draft-root tool. */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: resolves the `settings` service and its Context merge.
import type {} from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { draftDirectory } from './draft-directory.ts'
import { DramaSettingsSchema } from './settings.ts'
import { PROJECT_BIBLE_CHANGES, readProjectBible, previewProjectBible, updateProjectBible } from './project-bible.ts'
import type { ProjectBudgetReader } from './project-bible.ts'

export {
  DEFAULT_BGM_DIR, DEFAULT_DELIVERY_SPEC, DEFAULT_JIANYING_DRAFT_DIR, DELIVERY_SPEC_FIELD,
  DRAMA_SETTINGS_DEFAULTS, DRAMA_SETTINGS_NAMESPACE, DramaSettingsSchema,
} from './settings.ts'
export type { DramaDeliverySpec, DramaSettings, DramaSettingsField } from './settings.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'drama-settings'

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
 */
export function apply(ctx: Context): void {
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
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'drama_project',
      description: 'Read the authoritative project bible, preview a confirmed change and its downstream impact, or save the reviewed revision. Preserves legacy project bindings, stable package/storyboard IDs, completed tasks and version history. Validate exact model/platform/ratio/resolution through Jubian catalogue tools before selecting video settings.',
      parameters: {
        action: { type: 'string', required: true, enum: ['read', 'preview', 'update'] },
        project_dir: { type: 'string', required: true, description: 'Existing absolute project directory.' },
        changes: { type: 'object', additionalProperties: false, properties: PROJECT_BIBLE_CHANGES, description: 'Fields to merge for preview/update; omit for read.' },
        reason: { type: 'string', description: 'Preview/update reason recorded in version history.' },
        expected_revision: { type: 'string', description: 'Update only: exact current-file revision from preview, including missing for first creation.' },
        preview_fingerprint: { type: 'string', description: 'Update only: fingerprint from the same reviewed preview.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        const budget = toolCtx.get('jubianBudget') as ProjectBudgetReader | undefined
        if (args.action === 'read') return await readProjectBible(toolCtx.settings, args.project_dir, budget)
        if (!args.changes || !args.reason) throw new Error('Preview/update requires changes and reason.')
        if (args.action === 'preview') return await previewProjectBible(toolCtx.settings, args.project_dir, args.changes, args.reason, budget)
        if (!args.expected_revision || !args.preview_fingerprint) throw new Error('Update requires the expected_revision and preview_fingerprint from preview.')
        return await updateProjectBible(toolCtx.settings, args.project_dir, args.changes, args.reason,
          args.expected_revision, args.preview_fingerprint, exec.signal, budget)
      },
    })))
  })
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
  })
}
