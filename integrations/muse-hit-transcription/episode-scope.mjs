/** Keep the batch's speech admission and file actions bound to the current source. */
import { existsSync, lstatSync, readdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const name = 'transcription-episode-scope'
export const inject = ['tools']

const tools = new Set([
  'skill', 'read', 'write', 'edit', 'glob', 'grep', 'todo_write',
  'audio_transcribe', 'video_inspect', 'video_ocr', 'manuscript_revision',
  'screenplay_export_docx', 'load_workspace_dependencies', 'present',
])
const manuscript = new Set(['transcript_coverage', 'delivery', 'snapshot', 'history'])

function at(base, value) {
  return typeof value === 'string' && value.length > 0 ? resolve(base, value) : undefined
}

function inside(base, target) {
  if (!target) return false
  const path = relative(base, target)
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)
}

function denial(reason) {
  return { reason, info: { name: 'TranscriptionScope', code: 'TRANSCRIPTION_SCOPE' } }
}

export function episodeGuard({ workspace, video, referenceFiles, skillFiles }) {
  const jobs = resolve(workspace, 'transcript/jobs')
  const marker = resolve(workspace, '.recognition-admitted.json')
  const reference = new Set(referenceFiles)
  return execution => {
    const args = execution.arguments ?? {}
    if (!tools.has(execution.name)) return denial('只使用该集的原生转写和文件工具。')
    if (['read', 'write', 'edit', 'glob', 'grep'].includes(execution.name)) {
      const target = at(workspace, args.file_path ?? args.path ?? (['glob', 'grep'].includes(execution.name) ? '.' : undefined))
      const reading = ['read', 'glob', 'grep'].includes(execution.name)
      const skillDocument = reading && skillFiles && inside(skillFiles, target) && target.endsWith('.md')
      if ((!inside(workspace, target) && !(reading && (reference.has(target) || target === video)) && !skillDocument)
        || target === marker || (!reading && (inside(jobs, target) || inside(resolve(workspace, 'transcript/raw'), target)))) {
        return denial('只处理本集文件，前情和技能只读；原始语音证据由原生工具保存。')
      }
    }
    if (execution.name === 'manuscript_revision' && (!manuscript.has(args.action)
      || (args.action === 'delivery' && (args.delivery_mode !== 'draft' || args.source_mode !== 'video' || at(workspace,args.video_dir) !== resolve(video,'..'))))) {
      return denial('只登记本集草稿或做本集来源核对；不声明正式验收。')
    }
    if (['video_inspect', 'video_ocr'].includes(execution.name)) {
      if ((execution.name === 'video_ocr' || args.file_path !== undefined) && at(workspace, args.file_path) !== video) {
        return denial('看帧和字幕核对只允许本集原片。')
      }
      for (const key of ['raw_json_path', 'merged_text_path', 'manifest_path', 'transcript_path']) {
        if (args[key] !== undefined && !inside(workspace, at(workspace, args[key]))) {
          return denial('本集来源记录保存到本集工作区。')
        }
      }
    }
    if (execution.name === 'screenplay_export_docx' && !inside(workspace, at(workspace, args.output))) {
      return denial('Word 输出应在本集工作区。')
    }
    if (execution.name !== 'audio_transcribe') return undefined
    if (at(workspace, args.project) !== workspace) return denial('语音收据必须保存在本集工作区。')
    if (args.method === 'inspect') {
      const receipt = at(workspace, args.receipt)
      if (inside(jobs, receipt) && /^\d{4}-v\d+\.json$/u.test(relative(jobs, receipt))
        && existsSync(receipt) && lstatSync(receipt).isFile()) return undefined
      return denial('请用本集工具实际返回的原收据查询。')
    }
    if (args.method !== 'start' || args.purpose !== 'screenplay') {
      return denial('只允许一次 screenplay 标准识别，之后用 inspect 查询原任务。')
    }
    const input = args.inputs === undefined ? args.input
      : args.input === undefined && Array.isArray(args.inputs) && args.inputs.length === 1 ? args.inputs[0] : undefined
    if (at(workspace, input) !== video) return denial('本集只允许提交清单绑定的原片。')
    if (existsSync(jobs) && readdirSync(jobs).some(name => name.endsWith('.json'))) {
      return denial('已有语音收据，查询原任务并沿用结果。')
    }
    try {
      writeFileSync(marker, JSON.stringify({ callId: execution.callId, video }) + '\n', { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (error?.code === 'EEXIST') return denial('本集已经提交。原收据缺失时保留现场并报告，不要重开任务。')
      throw error
    }
    return undefined
  }
}

export function apply(ctx, config) {
  if (!isAbsolute(config.workspace) || !Array.isArray(config.referenceFiles)
    || (config.reviewOnly !== true && !isAbsolute(config.video))) {
    throw Error('Invalid authorized episode scope')
  }
  ctx.effect(() => ctx.tools.guard(config.reviewOnly === true
    ? () => denial('选材复核只使用已提供的剧目资料。')
    : episodeGuard(config)))
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.effect(() => agent.ctx.tools.restrict({
      futureAllow: config.reviewOnly === true ? [] : [...tools], includeOwn: true,
    }))
  })
  ctx.provide('museTranscriptionScopeReady', true)
}
