/** Resolved render inputs, reported without approving sound contents or visual style. */
import { deliveryRenderSettings, subtitleRenderStyle } from './delivery.ts'
import type { RenderPreview, RenderSettings, TimelineDelivery } from './types.ts'

/**
 * Describe the inputs the caller selected and the style the renderer will use.
 * @param input - Resolved paths, settings and delivery geometry.
 * @returns Preview facts; missing optional prepare music inputs remain visibly empty.
 */
export function buildRenderPreview(input: {
  readonly settings: RenderSettings
  readonly delivery: TimelineDelivery
  readonly subtitle: string
  readonly master: string
  readonly bgm?: string
  readonly bgmPlan?: string
}): RenderPreview {
  const settings = deliveryRenderSettings(input.settings, input.delivery)
  // Keep the public geometry schema stable; resolved style/gains have dedicated fields.
  const delivery = { ...input.delivery }
  delete delivery.subtitle
  delete delivery.audio
  return {
    delivery,
    subtitle: { path: input.subtitle, font_family: settings.subtitleFontFamily, ...subtitleRenderStyle(input.delivery) },
    audio: { master_path: input.master, bgm_path: input.bgm ?? '', bgm_plan_path: input.bgmPlan ?? '',
      master_gain: settings.masterVolume, bgm_gain: settings.bgmVolume },
  }
}

/**
 * Explain unprovided music inputs without blocking a preview or claiming that the audio has no music.
 * @param preview - Resolved prepare/render facts.
 * @param musicEnabled - Whether the selected profile permits added music.
 * @returns Non-blocking input and listening reminders.
 */
export function renderPreviewWarnings(preview: RenderPreview, musicEnabled = true): string[] {
  return [
    ...(!musicEnabled || preview.audio.bgm_path ? [] : ['尚未提供 BGM 文件；render 须显式传入已选纯配乐轨，不会自动从项目文件中挑选。']),
    ...(!musicEnabled || preview.audio.bgm_plan_path ? [] : ['未提供 bgm_plan，曲目、分段和许可尚未核对；空计划不表示没有混入 BGM，实际音轨见 render_preview.audio.bgm_path。']),
    'render_preview 列出交付规格、字幕设计单位及名义输出像素、音轨路径与增益；请与已认可版本核对。SRT 不携带字体样式，已有字幕审查片的观感不会自动继承；音轨是否为纯配乐、是否遮盖对白仍需试听。',
  ]
}
