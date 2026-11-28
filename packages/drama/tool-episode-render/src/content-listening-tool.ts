/** Offer local preparation and an explicitly provisioned advisory listening route. */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { prepareContentListeningAudio } from './content-listening-audio.ts'
import { preflightContentListening } from './content-listening-preflight.ts'
import { readContentListeningAttempt, reviewContentListening } from './content-listening-review.ts'
import { createFileCaptureChannel, createMediaToolkit } from './ffmpeg.ts'
import { jsonEvidenceOutput } from './tool-json-output.ts'
import type { RenderSettings } from './types.ts'

/**
 * Register the native listening candidate tool when deployment opts in.
 * @param scope - Current scoped registry, filesystem, sandbox, and optional Host audio transport.
 * @param settings - The renderer's subprocess configuration.
 */
export function registerContentListeningTool(scope: Context, settings: RenderSettings): void {
  scope.tools.register(defineTool({
    name: 'drama_review_audio',
    description: '准备并检查当前成片的整集声音。prepare 从实际成片和来源回执提取完整混音。'
      + 'preflight 在本机比较已绑定的正文母轨和成片混音，定位掉声和错位候选，无需调用模型。'
      + 'review 仅用已明确配置的专用音频线路，可能产生模型费用。优先用 blind_dialogue 先盲听并在本机核对原稿；'
      + '中断后用 review_status 回读同版原尝试、回复编号及已知模型用量，无需再次请求。'
      + '如需核对说话人，提供同一制作分包有登记且经核准的原始声线。只输出待核意见与费用对账记录，不作为交付批准。',
    parameters: {
      method: { type: 'string', enum: ['prepare', 'preflight', 'review', 'review_status'], required: true,
        description: '提取播放轨、本机预检、请求专用听校或只读查看原听校尝试。' },
      project: { type: 'string', required: true, description: '当前授权工作区内的项目根目录。' },
      episode: { type: 'integer', required: true, description: '单集正整数集号。' },
      output: { type: 'string', required: true, description: '当前实际工作成片 MP4，有同版渲染来源回执。' },
      preparation: { type: 'string', description: 'review 必填。prepare 返回的本次试听回执。' },
      attempt: { type: 'string', description: 'review_status 必填。review 返回或错误提示中的原尝试记录路径。' },
      subtitle_srt: { type: 'string', description: '实际成片绑定的显示字幕文件。review 必填，preflight 可选以检查片尾字幕时间。' },
      authored_dialogue: { type: 'string', description: 'review 必填。实际成片绑定的本集原稿对白计划 JSON。' },
      mode: { type: 'string', enum: ['blind_dialogue'], description: '先听实际混音再核对原稿，不能与声线上下文同用。' },
      voice_context: { type: 'object', additionalProperties: false, properties: {
        source_script: { type: 'string', required: true, description: '正式制作分包绑定的原分镜文件。' },
        references: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          character_id: { type: 'string', required: true, description: '正式角色 ID。' },
          voice_period_id: { type: 'string', description: '角色当前声线阶段。' },
          asset_id: { type: 'integer', required: true, description: '已核准原始声音素材编号。' },
          path: { type: 'string', required: true, description: '项目内与登记摘要一致的原始 WAV。' },
        } }, description: '每位说话人一份当前版本的已核准声线，最多三份。' },
      }, description: '可选的当前正式分包及批准声线。' },
    },
    output: jsonEvidenceOutput,
    execute: async (args, exec) => {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('请在当前 Muse 制作会话中准备或检查成片声音。')
      const policy = scope.sandboxPolicy.resolve({ session })
      if (policy.mode === 'read-only' && args.method !== 'review_status') {
        throw new Error('声音检查需在项目内保留试听材料或结果；当前会话仅可读取。')
      }
      if (!Number.isSafeInteger(args.episode) || args.episode < 1) throw new Error('episode 必须是正整数。')
      const { signal } = exec
      const [workspace, project] = await Promise.all([
        scope.fs.resolve(policy.workspaceRoot, { signal }),
        scope.fs.resolve(args.project, { cwd: policy.workspaceRoot, signal }),
      ])
      const projectPath = scope.fs.processPath(project)
      if (!isAbsolute(projectPath) || !scope.fs.contains(workspace, project)
        || (await scope.fs.stat(project, signal))?.type !== 'directory') {
        throw new Error('项目必须位于当前授权工作区内。')
      }
      const file = async (candidate: string) => {
        const handle = await scope.fs.resolve(candidate, { cwd: projectPath, signal })
        const path = scope.fs.processPath(handle)
        if (!isAbsolute(path) || !scope.fs.contains(project, handle)
          || (await scope.fs.stat(handle, signal))?.type !== 'file') {
          throw new Error('请选用当前项目内实际存在的文件。')
        }
        return path
      }
      const output = await file(args.output)
      const episode = String(args.episode).padStart(2, '0')
      if (args.method === 'review_status') {
        if (args.attempt === undefined) throw new Error('review_status 需提供 review 的原听校尝试记录。')
        return { ...await readContentListeningAttempt({ project: projectPath, episode, output,
          attemptPath: await file(args.attempt), signal }) }
      }
      if (args.attempt !== undefined) throw new Error('attempt 仅用于 review_status。')
      const toolkit = createMediaToolkit({ ffmpeg: settings.ffmpeg, ffprobe: settings.ffprobe,
        channel: settings.channel ?? createFileCaptureChannel(signal) })
      const base = { toolkit, project: projectPath, episode, output, signal }
      if (args.method === 'prepare') return { ...await prepareContentListeningAudio(base) }
      if (args.method === 'preflight') {
        if (args.preparation !== undefined || args.authored_dialogue !== undefined
          || args.mode !== undefined || args.voice_context !== undefined) {
          throw new Error('preflight 从当前成片生成本地材料，仅接受可选的实际字幕，不需要听校配置。')
        }
        const subtitleSrt = args.subtitle_srt === undefined ? undefined : await file(args.subtitle_srt)
        return { ...await preflightContentListening({ ...base, ...(subtitleSrt === undefined ? {} : { subtitleSrt }) }) }
      }
      if (args.preparation === undefined || args.subtitle_srt === undefined || args.authored_dialogue === undefined
        || (args.mode === 'blind_dialogue' && args.voice_context !== undefined)) {
        throw new Error('review 需提供试听准备回执、实际字幕、原稿对白计划；盲听和声线上下文不能同用。')
      }
      const [preparationPath, subtitleSrt, authoredDialoguePath] = await Promise.all([
        file(args.preparation), file(args.subtitle_srt), file(args.authored_dialogue),
      ])
      const voiceContext = args.voice_context === undefined ? undefined : {
        source_script: await file(args.voice_context.source_script),
        references: await Promise.all(args.voice_context.references.map(async reference => ({
          ...reference, path: await file(reference.path),
        }))),
      }
      const transport = scope.get('audioReviewTransport')
      const parseVoiceScript = voiceContext === undefined ? undefined : scope.get('shotScriptVoice')
      const review = await reviewContentListening({ ...base, preparationPath, subtitleSrt, authoredDialoguePath,
        ...(args.mode === undefined ? {} : { mode: args.mode }),
        ...(voiceContext === undefined ? {} : { voiceContext }),
        ...(parseVoiceScript === undefined ? {} : { parseVoiceScript }),
        ...(transport === undefined ? {} : { transport }) })
      return { ...review }
    },
  }))
}
