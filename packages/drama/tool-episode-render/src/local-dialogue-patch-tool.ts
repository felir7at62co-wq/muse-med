/** Make one offline dialogue repair candidate from two current Session observations. */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createFileCaptureChannel, createMediaToolkit } from './ffmpeg.ts'
import { patchLocalDialogue } from './local-dialogue-patch.ts'
import { measuredPronunciationCovers, type OfflinePronunciationEvidence, type OfflinePronunciationVerifier } from './offline-pronunciation-evidence.ts'
import { jsonEvidenceOutput } from './tool-json-output.ts'
import type { RenderSettings } from './types.ts'

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Register a local producer of review candidates. The existing source and delivery checks stay in charge of approval.
 * @param scope - Tools, filesystem, and Session sandbox services.
 * @param settings - Media subprocess configuration.
 * @param verify - Current ordinary Session's offline pronunciation receipts.
 */
export function registerLocalDialoguePatchTool(scope: Context, settings: RenderSettings, verify: OfflinePronunciationVerifier): void {
  scope.tools.register(defineTool({
    name: 'drama_patch_dialogue',
    description: '对同一集、同一句台词的两份选片做一次本地短窗换音候选。先在当前普通会话分别用 audio_transcribe pronunciation 核对同一句，目标纸面读音须在原片中疑似错读、在供体中匹配。'
      + '按两份实际声音确定等长的词音边界，再填写起点和时长。工具只根据当前会话的实际检测证据生成新候选。画面和窗外原声保留。'
      + '工具不判定说话人。随后复核输出读音、听接缝和声线、复看口型，并按实际选片重算字幕。正式选源审核以前只保留为候选。',
    parameters: {
      project: { type: 'string', required: true, description: '当前工作区内的项目根目录。' },
      episode: { type: 'integer', required: true, description: '两份片段对应的同一集正整数集号。' },
      target_evidence_id: { type: 'string', required: true, description: '当前普通会话中原片疑似错读的读音检查编号。' },
      donor_evidence_id: { type: 'string', required: true, description: '当前普通会话中同一句在供体片中匹配正确读音的检查编号。' },
      target_start_ms: { type: 'integer', required: true, description: '原片实际需换音的起点，毫秒。' },
      donor_start_ms: { type: 'integer', required: true, description: '供体片对应词音的起点，毫秒。' },
      duration_ms: { type: 'integer', required: true, description: '两份时间窗相同的长度，80–600 毫秒，不能拉伸。' },
    },
    output: jsonEvidenceOutput,
    execute: async ({ project, episode, target_evidence_id, donor_evidence_id, target_start_ms, donor_start_ms, duration_ms }, exec) => {
      const session = exec.agent?.session
      if (session === undefined || session.header.origin === 'subagent') throw new Error('请在持有本机读音记录的普通 Muse 会话制作修音候选。')
      const policy = scope.sandboxPolicy.resolve({ session })
      if (policy.mode === 'read-only') throw new Error('当前 Muse 会话仅可读取文件，不能写入修音候选。')
      const { signal } = exec
      const targetEvidence = verify(session, target_evidence_id, signal)
      const donorEvidence = verify(session, donor_evidence_id, signal)
      if (targetEvidence.status !== 'suspected_mismatch' || donorEvidence.status !== 'matching_in_windows'
        || targetEvidence.source.sha256 === donorEvidence.source.sha256
        || targetEvidence.expected !== donorEvidence.expected || targetEvidence.alternative !== donorEvidence.alternative
        || targetEvidence.target_index !== donorEvidence.target_index || targetEvidence.tokens.length !== donorEvidence.tokens.length
        || targetEvidence.tokens.some((token, index) => token !== donorEvidence.tokens[index])
        || targetEvidence.minimum_margin !== donorEvidence.minimum_margin
        || !measuredPronunciationCovers(targetEvidence, targetEvidence.alternative, target_start_ms, duration_ms)
        || !measuredPronunciationCovers(donorEvidence, donorEvidence.expected, donor_start_ms, duration_ms)) {
        throw new Error('DIALOGUE_PATCH_EVIDENCE: 同一句的疑似错读、正确读音和拟替换时间窗需分别有两次可靠测量。')
      }
      const [workspace, directory] = await Promise.all([
        scope.fs.resolve(policy.workspaceRoot, { signal }),
        scope.fs.resolve(project, { cwd: policy.workspaceRoot, signal }),
      ])
      const projectPath = scope.fs.processPath(directory)
      if (!isAbsolute(projectPath) || !scope.fs.contains(workspace, directory)
        || (await scope.fs.stat(directory, signal))?.type !== 'directory') {
        throw new Error('项目必须位于当前授权工作区内。')
      }
      const source = async (evidence: OfflinePronunciationEvidence, startMs: number) => {
        const file = await scope.fs.resolve(evidence.source.path, { cwd: projectPath, signal })
        const path = scope.fs.processPath(file)
        if (!samePath(evidence.project, projectPath) || !samePath(evidence.source.path, path) || !isAbsolute(path)
          || !scope.fs.contains(directory, file) || (await scope.fs.stat(file, signal))?.type !== 'file') {
          throw new Error('DIALOGUE_PATCH_SOURCE: 两份读音证据都须绑定当前项目中实际核对过的原文件。')
        }
        return { path, sha256: evidence.source.sha256, startMs }
      }
      const [target, donor] = await Promise.all([source(targetEvidence, target_start_ms), source(donorEvidence, donor_start_ms)])
      const toolkit = createMediaToolkit({ ffmpeg: settings.ffmpeg, ffprobe: settings.ffprobe,
        channel: settings.channel ?? createFileCaptureChannel(signal) })
      const result = await patchLocalDialogue(toolkit, { project: projectPath, episode, target, donor, durationMs: duration_ms }, signal)
      return { ...result, pronunciation_evidence: { target: targetEvidence.evidence_id, donor: donorEvidence.evidence_id } }
    },
  }))
}
