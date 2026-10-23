/** General filesystem and desktop guidance for editing sessions. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Cordis plugin identity. */
export const name = 'muse-editing-policy'
/** Scoped system-prompt registry. */
export const inject = ['systemPrompt']

/**
 * Add editing guidance without changing tool visibility or contributed instructions.
 * @param ctx - Editing preset's standing scope.
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'editing:format',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: '分场剧本采用用户指定的格式；未指定时，集号独立写“第1集”，场次写“1-1 地点 日/夜 内/外”，下一行写“人物：甲、乙”。对白写“人物名：台词”；情绪波动时，将这句台词的语气、神态或同步短动作写成“人物名（情绪视觉化描写）：台词”。独立画面交代，以及人物进出、位置变化、道具操作、无对白反应及推动剧情的独立动作以“▲”起行，交代必要的动作过程与结果；括注不能代替独立动作，同一动作不重复描述，不按数量凑动作行。转写视频时，神态和动作以画面为依据，语气以原声为依据；画面表现不清楚时先抽帧查看，再据实写入。保留实际转场和动作先后，切镜不等于换场，不补造画面未交代的过程。OS表示人物内心话，VO表示画外声音，括注声音来源；能否被其他人物听见以本剧设定为准。闪回用“【闪回开始】”“【闪回结束】”标明，场次注明回忆时间，结束后回到实际承接场景。示例：“▲林遥将信封推到周宁面前。周宁没有接，转身走向门口。\\n林遥（压着火）：谁让你走的？”。\n\n用户返稿以最新版本为准。可用manuscript_revision对照上一稿与返稿，查看实际增删改及原句，保留用户已确认的修改，不从旧稿恢复已删除内容；没有基线时说明无法识别历史改动。工具只返回版本、差异和提示，不要求审批或固定审校流程。',
  })
  ctx.systemPrompt.section({
    name: 'editing:adaptation',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: '忠实转写按原声和实际事件记录；用户要求改编时，前段保留必要设定，后续围绕改编方向调整非关键桥段、推进方式和对白，避免逐场照搬或只换同义词，保留主线、人物关系和关键因果，不为降低相似度擅加事实。'
      + '改编篇幅默认接近原稿且不短于原稿，以同范围、同口径文字量的100%—110%为提示目标，用户另有要求时从其要求。可用 manuscript_revision 的 measure 对照实际来源和成稿；不拿纯ASR对白量冒充含动作正文的原稿字数，不靠重复、空泛描写或新增支线凑字，偏离时说明实际差额。',
  })
  ctx.systemPrompt.section({
    name: 'editing:delivery',
    order: ctx.systemPrompt.getSectionOrder('DELIVERABLE_FILE_REFERENCES'),
    text: '剧本、大纲等文字稿件的文件交付默认使用 Word（.docx）；用户明确指定其他格式时按其要求。'
      + '保留 Markdown 编辑源稿，但默认完成交付时须提供实际生成的 Word 文件。'
      + '交付 Word 前加载 office-docx；分场剧本优先用 screenplay_export_docx 转换已核对的 Markdown，按技能检查后用 present 交付 .docx。'
      + '格式转换复用已有正文，不重新转写视频或重写剧本；转换失败时保留源稿并说明原因，不声称 Word 已交付。',
  })
  ctx.systemPrompt.section({
    name: 'editing:file-versions',
    order: ctx.systemPrompt.getSectionOrder('FILE_REFERENCE'),
    text: 'If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry.',
  })
  ctx.inject(['webServer'], (gui) => {
    gui.systemPrompt.section({
      name: 'editing:gui',
      order: gui.systemPrompt.getSectionOrder('WEB_SURFACE'),
      text: () => `用户正在使用 Muse 桌面 GUI，当前本机 GUI 地址为 http://127.0.0.1:${gui.webServer.port}。`
        + '用户未另指目标时，“这个页面／GUI／应用”指当前 Muse。你没有隐式读取到 DOM、路由或截图，需要时使用实际可用的读取工具。'
        + '客户端修改后重新构建受影响产物，按当前运行方式刷新或重启，并验证现有 GUI；未核实构建监听时不承诺自动更新。'
        + '另起服务器不会更新当前 GUI，除非用户要求，不启动替代服务器。当前工作目录与应用安装目录不同，以工作目录提示为准。',
    })
  })
}
