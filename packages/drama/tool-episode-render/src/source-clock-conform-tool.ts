/** Ordinary Muse entry for a local, source-bound processed picture with the original sound. */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { fileSha256 } from './cache.ts'
import { createFileCaptureChannel, createMediaToolkit } from './ffmpeg.ts'
import { conformSourceClock, sourceClockConformBindingSchema } from './source-clock-conform.ts'
import { jsonEvidenceOutput } from './tool-json-output.ts'
import type { RenderSettings } from './types.ts'

/**
 * Register an authorized local clip conform operation.
 * @param scope - Owner of the tools, filesystem and Session sandbox.
 * @param settings - Configured media binaries and subprocess channel.
 */
export function registerSourceClockConformTool(scope: Context, settings: RenderSettings): void {
  scope.tools.register(defineTool({
    name: 'drama_conform_clip',
    description: '处理片去字幕或转高清后，核实相同帧率或更高帧率的每一帧对应关系，恢复原片画面时钟并保留原有声轨。'
      + '先核实两份来源，再提供同项目的原片与处理片。另存候选并返回实际来源回执，继续实看和复检字幕；'
      + '不能对不对应的片段拉伸或补声。',
    parameters: {
      project: { type: 'string', required: true, description: '当前工作区内的项目根目录。' },
      episode: { type: 'integer', required: true, description: '本集正整数集号。' },
      original: { type: 'string', required: true, description: '项目内的原始下载视频，须包含原声。' },
      processed: { type: 'string', required: true, description: '对应的项目内最终处理视频。' },
    },
    output: jsonEvidenceOutput,
    execute: async ({ project, episode, original, processed }, exec) => {
      const { signal } = exec
      const session = exec.agent?.session
      if (session === undefined || session.header.origin === 'subagent') throw new Error('请在普通 Muse 会话内恢复源片时钟。')
      const policy = scope.sandboxPolicy.resolve({ session })
      if (policy.mode === 'read-only') throw new Error('当前 Muse 会话仅可读取文件，不能写入恢复时钟候选。')
      const [workspace, target] = await Promise.all([
        scope.fs.resolve(policy.workspaceRoot, { signal }),
        scope.fs.resolve(project, { cwd: policy.workspaceRoot, signal }),
      ])
      const projectPath = scope.fs.processPath(target)
      if (!isAbsolute(projectPath) || !scope.fs.contains(workspace, target)
        || (await scope.fs.stat(target, signal))?.type !== 'directory') throw new Error('项目必须位于当前授权工作区内。')
      const source = async (path: string) => {
        const file = await scope.fs.resolve(path, { cwd: projectPath, signal })
        const absolute = scope.fs.processPath(file)
        if (!isAbsolute(absolute) || !scope.fs.contains(target, file)
          || (await scope.fs.stat(file, signal))?.type !== 'file') throw new Error('原片和处理片必须是项目内的文件。')
        return { path: absolute, sha256: await fileSha256(absolute, signal) }
      }
      const [originalFile, processedFile] = await Promise.all([source(original), source(processed)])
      const toolkit = createMediaToolkit({ ffmpeg: settings.ffmpeg, ffprobe: settings.ffprobe,
        channel: settings.channel ?? createFileCaptureChannel(signal) })
      return sourceClockConformBindingSchema.parse(await conformSourceClock(toolkit,
        { project: projectPath, episode, original: originalFile, processed: processedFile }, signal))
    },
  }))
}
