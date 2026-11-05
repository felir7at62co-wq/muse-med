/** Fail-closed tool availability and executor policy for the single-model creation preset. */
import type { Context } from '@deepseek-ai/cordis'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { apply as installEditingGuidance } from './editing-policy.ts'
import { CREATION_GUIDANCE, CREATION_GUIDANCE_SECTION } from './creation-guidance.ts'
import { apply as installShortDramaGuidance } from './short-drama-guidance.ts'

/** Cordis plugin identity. */
export const name = 'muse-creation-policy'
/** Host registries used through the preset's scoped context. */
export const inject = ['tools', 'systemPrompt']

/** Audited native creative capabilities; late registration does not broaden this set. */
export const CREATION_TOOL_NAMES: readonly string[] = [
  'ask_user_question',
  'audio_transcribe',
  'bash',
  'bgm_match',
  'create_goal',
  'douyin_data',
  'douyin_download',
  'douyin_download_task',
  'drama_assets',
  'drama_bgm',
  'drama_draft_dir',
  'drama_project',
  'drama_render',
  'drama_shot',
  'drama_video',
  'dsh_im_return_file',
  'edit',
  'exit_plan_mode',
  'fanqie_download',
  'fanqie_download_info',
  'fanqie_search',
  'ffmpeg_adjust',
  'ffmpeg_concat',
  'ffmpeg_cut',
  'ffmpeg_encode',
  'ffmpeg_extract',
  'ffmpeg_frames',
  'ffmpeg_gif',
  'ffmpeg_health',
  'ffmpeg_probe',
  'ffmpeg_subtitle',
  'get_goal',
  'glob',
  'grep',
  'hongguo_collections',
  'hongguo_detail',
  'hongguo_download',
  'hongguo_download_info',
  'hongguo_rankings',
  'hongguo_search',
  'job_kill',
  'job_list',
  'job_output',
  'jianying_draft',
  'jubian_asset',
  'jubian_budget',
  'jubian_catalog',
  'jubian_claim',
  'jubian_find',
  'jubian_media',
  'jubian_model',
  'jubian_organize',
  'jubian_snatch',
  'jubian_storyboard',
  'jubian_video',
  'jubian_watch',
  'list_mcp_resource_templates',
  'list_mcp_resources',
  'manuscript_revision',
  'source_recover',
  'muse_production',
  'muse_feedback_submit',
  'muse_feedback_status',
  'muse_media_data',
  'muse_media_download',
  'muse_media_task',
  'muse_media_import',
  'muse_skill_evolution',
  'present',
  'pwsh',
  'qimao_detail',
  'qimao_rankings',
  'qimao_search',
  'read',
  'send_file',
  'show_view',
  'visualize',
  'source_report',
  'source_snapshot',
  'read_image',
  'read_mcp_resource',
  'schedule_create',
  'schedule_delete',
  'schedule_list',
  'schedule_update',
  'screenplay_export_docx',
  'skill',
  'todo_update',
  'todo_write',
  'update_goal',
  'video_contact_sheet',
  'video_inspect',
  'video_ocr',
  'web_fetch',
  'web_search',
  'work_mapping',
  'write',
]
const allowed = new Set(CREATION_TOOL_NAMES)
// These audited policies describe a tool group rather than one registered name.
const allowedToolSections = new Set(['tool:goal', 'tool:jobs'])

/**
 * Restrict tools and their guidance to the creation preset, including Agent-local contributions.
 * @param ctx - The creation preset's standing scope.
 */
export function apply(ctx: Context): void {
  installShortDramaGuidance(ctx)
  installEditingGuidance(ctx)
  ctx.systemPrompt.section({ name: CREATION_GUIDANCE_SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), interpolate: false, text: CREATION_GUIDANCE })
  ctx.tools.restrict({ futureAllow: CREATION_TOOL_NAMES, includeOwn: true })
  ctx.tools.guard((exec) => {
    if (exec.name !== RUN_CODE_NAME && !allowed.has(exec.name)) return '创作模式不提供此能力；请使用当前创作工具。'
    return undefined
  })
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    return {
      ...assembled,
      sections: assembled.sections.filter(section => !section.name.startsWith('team:')
        && (!section.name.startsWith('tool:') || allowed.has(section.name.slice(5)) || allowedToolSections.has(section.name))),
      contexts: assembled.contexts.filter(section => !section.name.startsWith('subagent:') && !section.name.startsWith('team:')),
    }
  })
}
