/** Textual first-pass review of actual native prepared prompts, including direct card authoring. */
import type { Context } from '@deepseek-ai/cordis'
import type { PostToolDecision, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { parseShotScript } from './script.ts'
import { NATURAL_HOLD_SECONDS } from './episode.ts'
import { reviewSceneTimes } from './quality.ts'

/**
 * Report speech, scene time, timing and declared physical-performance findings before paid generation.
 * @param ctx - Owning plugin context; disposal removes the post-execution listener.
 * @param definition - Compiler definition selected for the calling agent's scope.
 * @param actionShotSeconds - Deployment silent-shot estimate, used only while parsing.
 * @param speechCharsPerSecond - Deployment speech estimate, used only while parsing.
 */
export function installPreparedQualityReview(ctx: Context, definition: ToolDefinition,
  actionShotSeconds: number, speechCharsPerSecond: number): void {
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const decision = await next()
    const args = exec.arguments
    if (decision.kind !== 'accept' || decision.content !== undefined || result.isError || exec.name !== 'jubian_storyboard'
      || ctx.tools.get('drama_shot', exec.agent) !== definition
      || args === null || typeof args !== 'object' || !('method' in args)
      || !['prepare_video', 'generate'].includes(String(args.method))) return decision
    const value = decision.value ?? result.value
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || typeof value.preview_path !== 'string' || typeof value.payload !== 'object' || value.payload === null
      || Array.isArray(value.payload) || typeof value.payload.modelConfig !== 'string') return decision
    let config: unknown
    try { config = JSON.parse(value.payload.modelConfig) }
    catch (_error) { return decision } // Native preparation owns malformed provider configuration errors.
    if (config === null || typeof config !== 'object' || !('prompt' in config) || typeof config.prompt !== 'string'
      || !config.prompt.includes('【镜头')) return decision
    const parsed = parseShotScript(config.prompt, { actionShotSeconds, speechCharsPerSecond, sourceScope: 'prepared_package' })
    const relevant = new Set(['action_stages_invalid', 'action_stages_missing', 'continuity_declaration_invalid',
      'continuity_change_unexplained', 'timing_plan_invalid', 'timing_plan_exceeds_duration', 'no_shots',
      'performance_budget_missing', 'shot_numbering', 'legacy_duration_invalid', 'legacy_duration_mismatch',
      'multiple_speech_lines', 'speaker_mismatch', 'missing_speaker', 'empty_dialogue_line',
      'placeholder_dialogue', 'missing_voice_type', 'action_voice_with_dialogue', 'speech_too_long',
      'unknown_action_complexity', 'scene_time_declaration_invalid', 'scene_time_change_unexplained'])
    const findings = parsed.issues.filter(issue => relevant.has(issue.code))
    const timeReview = reviewSceneTimes(parsed.shots)
    if (timeReview.unresolved.length) findings.push({ code: 'scene_time_missing', severity: 'warning', shot: 0, line: 0,
      message: `镜头${timeReview.unresolved.join('、')}缺少可继承的原文场景时段；对照原文场次补明确时段并带入每个独立包，不能仅凭前包夕阳、场景图或台词猜测昼夜。` })
    const performanceSeconds = parsed.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0)
    const hasEstimates = parsed.shots.some(shot => shot.durationSource !== 'declared')
    if ('duration' in config && typeof config.duration === 'number' && performanceSeconds + NATURAL_HOLD_SECONDS > config.duration) {
      findings.push({ code: 'prepared_budget_exceeds_duration', severity: 'warning', shot: 0, line: 0,
        message: `镜头内容合计${performanceSeconds}秒${hasEstimates ? '（包含估算，须自然试读并排演）' : '（已声明）'}，加${NATURAL_HOLD_SECONDS}秒收束超过实际卡片${config.duration}秒；按原文表演核对时长或拆包，不删动作、台词或加速凑时长。` })
    }
    return { kind: 'accept', ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}),
      value: { ...value, first_pass_review: { status: findings.length ? 'needs_review' : 'text_checks_passed',
        scope: 'actual_prepared_prompt', media_acceptance: false,
        performance_seconds: performanceSeconds, timing_includes_estimates: hasEstimates,
        unchecked: ['source_mapping_and_exact_speech', 'actual_asset_scale_and_interaction', 'generated_visuals_and_audio'],
        findings: findings.map(issue => ({ code: issue.code, shot: issue.shot, message: issue.message })),
        next: '首次生成前完成来源映射和台词预检，实看绑定素材，解决本包发声、动作、时间或连续性冲突，再按相同标准审片；不要为清警告删改剧情或降低审查要求。此文本检查不修改预览、幂等key或付费权限，不签发成片验收。' } } }
  })
}
