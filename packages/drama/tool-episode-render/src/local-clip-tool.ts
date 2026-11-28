/** Session tool for a bounded local video edit with matched source sound. */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { VideoSourceQaVerifier } from '@deepseek-ai/dsh-tool-video-inspect/source-qa'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { fileSha256 } from './cache.ts'
import { createFileCaptureChannel, createMediaToolkit } from './ffmpeg.ts'
import { localClipRepairBindingSchema } from './local-clip-evidence.ts'
import { repairLocalClip } from './local-clip.ts'
import { endingRestoreBindingSchema, restoreEnding } from './restore-ending.ts'
import { registerSourceClockConformTool } from './source-clock-conform-tool.ts'
import { jsonEvidenceOutput } from './tool-json-output.ts'
import type { RenderSettings } from './types.ts'

const regionPoint = {
  type: 'object', required: true, additionalProperties: false,
  properties: {
    frame_id: { type: 'string', required: true },
    region: { type: 'object', required: true, additionalProperties: false, properties: {
      x: { type: 'number', required: true }, y: { type: 'number', required: true },
      width: { type: 'number', required: true }, height: { type: 'number', required: true },
    } },
  },
} as const

/**
 * Optional Host policy that a repair was preceded by a paired, current regional observation of the same source.
 * Deployments without it expose only the bounded clip and clock tools.
 */
export type VisualRepairEvidenceVerifier = (session: Parameters<VideoSourceQaVerifier>[0], mediaPath: string,
  evidence: unknown, signal: AbortSignal) => Promise<void>

/** The two actual crop observations used to bind a local visual repair to a source. */
export const regionalEvidence = {
  type: 'object', required: true, additionalProperties: false,
  description: '直接调用revisit的region，实看疑点前后两个不同解码时刻。两帧须来自同一个实际审核中的影片，后图矩形保持相同或扩大。',
  properties: {
    review_id: { type: 'string', required: true }, defect_seconds: { type: 'number', required: true },
    focus: { type: 'string', description: '使用observe_repair记录两帧局部时，填写相同的缺陷描述。' },
    before: regionPoint, after: regionPoint,
  },
} as const

/**
 * Offer local editing in Sessions with a resolved workspace and sandbox.
 * @param scope - Owner of the tools, filesystem and sandbox policy.
 * @param settings - Configured media command paths and channel.
 * @param verifyVisualRepair - Optional Host policy for a paired, current regional observation.
 */
export function registerLocalClipTool(scope: Context, settings: RenderSettings, verifyVisualRepair?: VisualRepairEvidenceVerifier): void {
  scope.tools.register(defineTool({
    name: 'drama_repair_clip',
    description: '用同一时钟局部裁切原片画面及原声，或同时修正错误构图。返回全新的候选文件和来源回执。'
      + '先实看原片并核定帧边界，处理后重新审看实际输出，并用当前选片重做字幕对齐。'
      + '这项工具只做本地裁切，不生成视频、不会修改原片，也不能代替审核。',
    parameters: {
      project: { type: 'string', required: true, description: '当前工作区内的项目根目录。' },
      episode: { type: 'integer', required: true, description: '本集正整数集号。' },
      input: { type: 'string', required: true, description: '项目内的原始下载视频。相对路径基于项目。' },
      start_ms: { type: 'integer', required: true, description: '起点，取实际视频帧边界，毫秒。' },
      end_ms: { type: 'integer', required: true, description: '不包含此时间点，取实际视频帧边界，毫秒。' },
      crop: { type: 'object', additionalProperties: false, description: '可选源画面裁切框，单位为像素。', properties: {
        x: { type: 'integer', required: true }, y: { type: 'integer', required: true },
        width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
      } },
      ...verifyVisualRepair === undefined ? {} : { visual_evidence: regionalEvidence },
    },
    output: jsonEvidenceOutput,
    execute: async ({ project, episode, input, start_ms, end_ms, crop, visual_evidence }, exec) => {
      const session = exec.agent?.session
      if (session === undefined || session.header.origin === 'subagent') throw new Error('请在普通 Muse 会话内制作局部裁切候选。')
      const policy = scope.sandboxPolicy.resolve({ session })
      if (policy.mode === 'read-only') throw new Error('当前 Muse 会话仅可读取文件，不能写入局部返工候选。')
      const workspace = await scope.fs.resolve(policy.workspaceRoot, { signal: exec.signal })
      const projectTarget = await scope.fs.resolve(project, { cwd: policy.workspaceRoot, signal: exec.signal })
      const projectPath = scope.fs.processPath(projectTarget)
      const source = await scope.fs.resolve(input, { cwd: projectPath, signal: exec.signal })
      const inputPath = scope.fs.processPath(source)
      const sourceInfo = await scope.fs.stat(source, exec.signal)
      if (!isAbsolute(projectPath) || !isAbsolute(inputPath) || !scope.fs.contains(workspace, projectTarget)
        || !scope.fs.contains(projectTarget, source) || (await scope.fs.stat(projectTarget, exec.signal))?.type !== 'directory'
        || sourceInfo?.type !== 'file') {
        throw new Error('项目和原片必须位于当前授权工作区内。')
      }
      let expectedInputSha256: string | undefined
      if (verifyVisualRepair !== undefined) {
        await verifyVisualRepair(session, inputPath, visual_evidence, exec.signal)
        expectedInputSha256 = await fileSha256(inputPath, exec.signal)
        if ((await scope.fs.stat(source, exec.signal))?.version !== sourceInfo.version) {
          throw new Error('VISUAL_REPAIR_EVIDENCE: 源片在复验期间变化，请重新审看。')
        }
      }
      const toolkit = createMediaToolkit({ ffmpeg: settings.ffmpeg, ffprobe: settings.ffprobe,
        channel: settings.channel ?? createFileCaptureChannel(exec.signal) })
      const repair = await repairLocalClip(toolkit, { project: projectPath, episode, input: inputPath,
        ...(expectedInputSha256 === undefined ? {} : { expectedInputSha256 }),
        startMs: start_ms, endMs: end_ms, ...(crop === undefined ? {} : { crop }) }, exec.signal)
      return { ...localClipRepairBindingSchema.parse(repair), pictureClock: repair.pictureClock }
    },
  }))
  registerSourceClockConformTool(scope, settings)
  if (verifyVisualRepair === undefined) return
  scope.tools.register(defineTool({
    name: 'drama_restore_ending',
    description: '已知正确的同集片尾仍在时，用其同一时间内的画面替换错误片尾，保留旧版正文画面与全片原声。'
      + '只用于两份同集、同分辨率、同帧钟的完整 MP4。先分别复看问题和正确片尾。输出全新的技术候选和来源回执，随后重看输出。',
    parameters: {
      project: { type: 'string', required: true, description: '当前授权工作区内的测试项目根目录。' },
      episode: { type: 'integer', required: true, description: '两份影片对应的同一集正整数集号。' },
      original: { type: 'string', required: true, description: '项目内带错误片尾的当前完整候选。' },
      donor: { type: 'string', required: true, description: '项目内同一集、同一时间线、保留正确片尾的完整候选。' },
      start_ms: { type: 'integer', required: true, description: '原片和正确片尾同时钟的替换首帧，取实际帧边界，最多为片尾三秒。' },
      visual_evidence: regionalEvidence,
      donor_evidence: { ...regionalEvidence, description: '正确片尾实际看到的两张局部图。defect_seconds 填对照区间内的片尾复看焦点。' },
    },
    output: jsonEvidenceOutput,
    execute: async ({ project, episode, original, donor, start_ms, visual_evidence, donor_evidence }, exec) => {
      const session = exec.agent?.session
      if (!session || session.header.origin === 'subagent') throw new Error('请在普通 Muse 会话内恢复实际片尾。')
      const policy = scope.sandboxPolicy.resolve({ session })
      if (policy.mode === 'read-only') throw new Error('当前 Muse 会话仅可读取文件，不能写入片尾候选。')
      const { signal } = exec
      const workspace = await scope.fs.resolve(policy.workspaceRoot, { signal })
      const target = await scope.fs.resolve(project, { cwd: policy.workspaceRoot, signal })
      const projectPath = scope.fs.processPath(target)
      if (!isAbsolute(projectPath) || !scope.fs.contains(workspace, target)
        || (await scope.fs.stat(target, signal))?.type !== 'directory') throw new Error('项目必须位于当前授权工作区内。')
      const checked = async (file: string, claim: typeof visual_evidence) => {
        if (Math.round(claim.defect_seconds * 1000) < start_ms) throw new Error('片尾复看时点必须处在拟替换区间内。')
        const source = await scope.fs.resolve(file, { cwd: projectPath, signal })
        const path = scope.fs.processPath(source), initial = await scope.fs.stat(source, signal)
        if (!isAbsolute(path) || !scope.fs.contains(target, source) || initial?.type !== 'file') {
          throw new Error('出错片和正确片尾来源必须是当前项目内的文件。')
        }
        await verifyVisualRepair(session, path, claim, signal)
        const sha256 = await fileSha256(path, signal)
        if ((await scope.fs.stat(source, signal))?.version !== initial.version) throw new Error('审看的片尾来源已变化，请重新复看。')
        return { path, sha256 }
      }
      const originalFile = await checked(original, visual_evidence)
      const donorFile = await checked(donor, donor_evidence)
      const toolkit = createMediaToolkit({ ffmpeg: settings.ffmpeg, ffprobe: settings.ffprobe,
        channel: settings.channel ?? createFileCaptureChannel(signal) })
      return endingRestoreBindingSchema.parse(await restoreEnding(toolkit, { project: projectPath, episode,
        original: originalFile, donor: donorFile, startMs: start_ms }, signal))
    },
  }))
}
