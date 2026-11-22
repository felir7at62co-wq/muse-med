/** Move studio files between the conversation's workspace and the studio's media store. */
import { isAbsolute, resolve } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { projectMediaFolder } from '@deepseek-ai/dsh-jingliu-connection'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Dependencies } from './index.ts'

// The studio resolves at most this many addresses per request; one call stays within one batch.
const MAX_PATHS = 200

/**
 * Download studio files into `<workspace>/jingliu/<project>` or upload a local file to the studio.
 * @param deps - Current studio and user confirmation service.
 * @returns The `jingliu_media` tool.
 */
export function mediaTool(deps: Dependencies): ToolDefinition {
  return defineTool({ name: 'jingliu_media',
    description: '把镜流素材下载到本机工作区（同一文件只下载一次），或把本机图片、音频、视频上传到镜流。上传返回的 path 可填入需要素材地址的镜流工作流参数。',
    parameters: {
      action: { type: 'string', required: true, enum: ['download', 'upload'] },
      project_id: { type: 'string', description: '镜流项目；省略时用本会话关联的项目。download 必须有项目。' },
      paths: { type: 'array', items: { type: 'string' }, description: 'download：镜流结果中的 /fw/media/ 地址，最多 200 个。' },
      file: { type: 'string', description: 'upload：本机文件，相对路径从工作区解析。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, result: Record<string, JsonValue>) => [{ type: 'text', text: JSON.stringify(result) }] },
    async execute({ action, project_id, paths, file }, exec): Promise<Record<string, JsonValue>> {
      if (!exec.agent) throw new HarnessError('请在 Muse 会话中使用镜流。', 'JINGLIU_SESSION_REQUIRED')
      const session = await deps.connect()
      const selected = await deps.selected?.(exec.agent.session.id, session.identity)
      const project = project_id?.trim() || selected?.id
      if (project && selected && selected.id !== project) throw new HarnessError('这个操作指向另一个云项目，请先确认要切换的项目。', 'JINGLIU_INVALID_PROJECT')
      const workspace = exec.agent.session.header.cwd
      if (action === 'download') {
        if (!session.download) throw new HarnessError('只有桌面版 Muse 能把镜流素材下载到本机。', 'JINGLIU_MEDIA_LOCAL_DISABLED')
        if (!project) throw new HarnessError('请先确认镜流项目。', 'JINGLIU_INVALID_PROJECT')
        if (!workspace) throw new HarnessError('这段对话没有本机工作区。', 'JINGLIU_WORKSPACE_REQUIRED')
        if (!paths?.length || paths.length > MAX_PATHS) throw new HarnessError('请提供 1 到 200 个镜流素材地址。', 'JINGLIU_INVALID_ARGUMENTS')
        const files = await session.download(paths, projectMediaFolder(workspace, project), exec.signal)
        return { project_id: project, files: [...files.values()].map(local => ({
          path: local.path, file: local.file, size: local.size, content_type: local.contentType,
        })) }
      }
      if (!session.upload) throw new HarnessError('当前镜流连接不支持上传。', 'JINGLIU_UPLOAD_UNSUPPORTED')
      if (!file?.trim()) throw new HarnessError('请指定要上传的本机文件。', 'JINGLIU_INVALID_ARGUMENTS')
      if (!isAbsolute(file) && !workspace) throw new HarnessError('这段对话没有本机工作区，请使用绝对路径。', 'JINGLIU_WORKSPACE_REQUIRED')
      const target = isAbsolute(file) ? file : resolve(workspace ?? '', file)
      if (!await deps.approve(exec, '将本机文件上传到镜流' + (project ? '项目 ' + project : '') + '\n' + target)) {
        throw new HarnessError('本次上传未获确认。', 'JINGLIU_APPROVAL_REQUIRED')
      }
      exec.signal.throwIfAborted()
      const uploaded = await session.upload(target, project, exec.signal)
      return { path: uploaded.path, size: uploaded.size, file: target }
    },
    presentCall: args => ({ card: 'generic', title: '镜流 · 素材' + (args.action === 'upload' ? '上传' : '下载'), kind: 'other', rawInput: args }),
  })
}
