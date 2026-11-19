/** Project-bound OpenChatCut tools for the Muse conversation showing the editor. */
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { IncomingMessage } from 'node:http'
import { editorAgentViewRoute, editorProjectId, type EditorOwner } from './editor-agent-protocol.ts'

const excludedTools = new Set(['target_project', 'create_project', 'list_projects', 'get_editor_url', 'openchatcut_status', 'run_code'])
const endpointError = () => new HarnessError('请打开当前会话的剪辑工程，并检查 OpenChatCut 的本地连接。', 'OPENCHATCUT_CONNECTION')
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

class ProjectConnection {
  private client = new Client({ name: 'Muse', version: '1' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
  readonly lifetime = new AbortController()
  private stale = false
  private transport: StreamableHTTPClientTransport | undefined
  private ready: Promise<Tool[]> | undefined

  constructor(readonly project: string, readonly owner: EditorOwner, private readonly endpoint: URL, private readonly tokenFile: string) {}

  catalog(): Promise<Tool[]> {
    return this.ready ??= this.open().catch(async (error) => {
      try { await this.disconnect() } finally { this.ready = undefined }
      throw error instanceof HarnessError ? error : endpointError()
    })
  }

  private async open(): Promise<Tool[]> {
    const signal = this.lifetime.signal
    signal.throwIfAborted()
    let token: string
    try { token = (await readFile(this.tokenFile, { encoding: 'utf8', signal })).trim() }
    catch (_error) { throw endpointError() }
    if (!token || /\s/u.test(token)) throw endpointError()
    const transport = new StreamableHTTPClientTransport(this.endpoint, {
      requestInit: { headers: { Authorization: 'Bearer ' + token }, redirect: 'error' },
    })
    this.transport = transport
    await this.client.connect(transport, { signal })
    const target = await this.client.callTool({ name: 'target_project', arguments: { projectId: this.project } }, { signal })
    const value = target.structuredContent
    if (target.isError || !record(value) || value.bindingMode !== 'browser' || !record(value.binding) || value.binding.projectId !== this.project ||
      value.binding.editorInstanceId !== this.owner.id || value.binding.ownershipEpoch !== this.owner.epoch) {
      throw new HarnessError('剪辑器尚未接管这个工程。请打开工程并等时间线载入后重试。', 'OPENCHATCUT_EDITOR_REQUIRED')
    }
    const tools: Tool[] = []
    let cursor: string | undefined
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined, { signal })
      tools.push(...page.tools.filter(tool => !excludedTools.has(tool.name)))
      cursor = page.nextCursor
    } while (cursor)
    return tools
  }

  async call(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    if (name === 'begin_edit_session' && this.stale) {
      await this.disconnect()
      this.ready = undefined
      this.stale = false
      await this.catalog()
    }
    signal.throwIfAborted()
    try {
      const result = await this.client.callTool({ name, arguments: args }, { signal })
      if (result.isError && record(result.structuredContent) && result.structuredContent.outcome === 'stale') this.stale = true
      return result
    } catch (_error) {
      this.stale = true
      signal.throwIfAborted()
      throw new HarnessError('剪辑连接中断，本次结果未知。请查看工程或原草稿状态后再决定是否修改。', 'OPENCHATCUT_OUTCOME_UNKNOWN')
    }
  }

  private async disconnect(): Promise<void> {
    const transport = this.transport
    if (!transport) return
    this.transport = undefined
    try {
      if (transport.sessionId) await transport.terminateSession()
    } finally { await this.client.close() }
  }

  async close(): Promise<void> {
    this.lifetime.abort()
    await this.disconnect()
  }
}

/** Install live editor selection and the two conversation tools together.
 * @param ctx - Host owning HTTP access checks, tool registration and teardown.
 * @param origin - Validated local editor endpoint.
 * @param tokenFile - Host-local OpenChatCut MCP credential.
 */
export function registerEditorAgent(ctx: Context, origin: string, tokenFile: string): void {
  ctx.inject(['tools'], (scope) => {
    const endpoint = new URL('/api/external-mcp/mcp', origin)
    type Entry = { name: string; view: ProjectConnection; holds: Set<() => void> }
    const conversations = new Map<string, Map<string, Entry>>()
    function clear() {
      for (const projects of conversations.values()) for (const entry of projects.values()) for (const end of entry.holds) end()
    }
    scope.effect(() => clear, 'OpenChatCut: release views')
    scope.on('muse-account/session-changed', clear)
    scope.inject(['connection', 'webServer'], (web) => {
      const trust = Reflect.get(web, 'connection') as { requestRejection(req: IncomingMessage): number | undefined }
      web.effect(() => clear, 'OpenChatCut: release disconnected views')
      web.effect(() => web.webServer.register({ kind: 'exact', path: editorAgentViewRoute, handler(req, res) {
        const rejection = trust.requestRejection(req)
        const url = new URL(req.url ?? '', 'http://localhost')
        const session = url.searchParams.get('session') ?? ''
        const project = url.searchParams.get('project') ?? ''
        const name = url.searchParams.get('name')?.trim().slice(0, 256) || project
        const owner = url.searchParams.get('owner') ?? ''
        const epoch = url.searchParams.get('epoch') ?? ''
        if (rejection || req.method !== 'GET' || url.pathname !== editorAgentViewRoute ||
          req.headers['x-muse-editor-view'] !== '1' || !/^[\w.:-]{1,200}$/u.test(session) || !editorProjectId.test(project) ||
          !editorProjectId.test(owner) || !/^\d{1,15}$/u.test(epoch)) {
          res.writeHead(rejection ?? 400); res.end(); return
        }
        const projects = conversations.get(session) ?? new Map<string, Entry>()
        conversations.set(session, projects)
        const prior = projects.get(project)
        if (prior && (prior.view.owner.id !== owner || prior.view.owner.epoch !== Number(epoch))) {
          for (const close of prior.holds) close()
          conversations.set(session, projects)
        }
        const entry = projects.get(project) ?? {
          name,
          view: new ProjectConnection(project, { id: owner, epoch: Number(epoch) }, endpoint, tokenFile),
          holds: new Set<() => void>(),
        }
        entry.name = name
        projects.set(project, entry)
        const end = () => {
          if (!entry.holds.delete(end)) return
          if (!entry.holds.size) {
            projects.delete(project)
            if (!projects.size) conversations.delete(session)
            void entry.view.close().catch(() => scope.logger.warn('OpenChatCut session cleanup failed'))
          }
          res.end()
        }
        entry.holds.add(end)
        res.once('close', end)
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        res.write('data: ready\n\n')
      } }), 'OpenChatCut: conversation selection')
    })

    function selected(session?: string, project?: string): ProjectConnection {
      const projects = session ? conversations.get(session) : undefined
      const entry = project ? projects?.get(project) : projects?.size === 1 ? projects.values().next().value : undefined
      if (!entry) throw new HarnessError('请在当前 Muse 会话右侧的「剪辑」打开工程，再从主聊天框发送指令。', 'OPENCHATCUT_PROJECT_REQUIRED')
      return entry.view
    }

    const discovery = defineTool({
      name: 'openchatcut_tools', description: '查找当前 Muse 会话中打开的 OpenChatCut 剪辑工具。用 name 查完整参数，返回的 project_id 用于后续调用。读写时间线前先 begin_edit_session，然后用 editSessionId。',
      parameters: {
        project_id: { type: 'string', description: '当前会话的工程 ID。省略时自动使用唯一打开的工程，有多个时返回名称和 ID 供选择。' },
        query: { type: 'string', description: '搜索英文名称或说明，例如 audio、transition 或 split。' },
        name: { type: 'string', description: '查看指定工具的完整参数。' },
        offset: { type: 'integer', description: '目录的下一页起点。' },
      },
      isConcurrencySafe: () => true,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute({ project_id, query, name, offset = 0 }, exec) {
        if (offset < 0) throw new HarnessError('目录起点必须大于等于零。', 'OPENCHATCUT_INVALID_CALL')
        const session = exec.agent?.session.id
        const projects = session && conversations.get(session)
        if (!project_id && projects && projects.size > 1) {
          return { projects: Array.from(projects, ([id, entry]) => ({ project_id: id, name: entry.name })) }
        }
        const view = selected(session, project_id)
        const tools = await view.catalog()
        exec.signal.throwIfAborted()
        view.lifetime.signal.throwIfAborted()
        if (name) {
          const tool = tools.find(item => item.name === name)
          if (!tool) throw new HarnessError('当前工程没有此剪辑工具。', 'OPENCHATCUT_TOOL_UNKNOWN')
          if (!isJsonValue(tool.inputSchema)) throw endpointError()
          return { project_id: view.project, name, description: tool.description ?? '', parameters: tool.inputSchema as JsonValue }
        }
        const search = query?.trim().toLowerCase() ?? ''
        const matches = tools.filter(item => (item.name + ' ' + (item.description ?? '')).toLowerCase().includes(search))
        const page = matches.slice(offset, offset + 24)
        return { project_id: view.project, total: matches.length, tools: page.map(item => item.name),
          ...(offset + page.length < matches.length ? { next_offset: offset + page.length } : {}) }
      },
    })
    const run = createMcpToolDefinition(scope, {
      name: 'openchatcut_call', rawName: 'OpenChatCut',
      description: '在当前会话的指定剪辑工程调用原生工具。begin_edit_session 创建手动审阅草稿，返回的 editSessionId 放入剪辑工具的 args。完成后 review_edit_session 显示预览，用户应用后 get_edit_session 才会返回 applied。调用结果未知时先核对，不要重复修改。',
      inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, tool: { type: 'string' }, args: { type: 'object', additionalProperties: true } },
        required: ['project_id', 'tool'], additionalProperties: false },
      async call(input, exec) {
        if (typeof input.project_id !== 'string' || !editorProjectId.test(input.project_id) || typeof input.tool !== 'string' ||
          (input.args !== undefined && !record(input.args))) throw new HarnessError('请传入有效工程、工具名称和参数。', 'OPENCHATCUT_INVALID_CALL')
        const view = selected(exec.agent?.session.id, input.project_id)
        const tools = await view.catalog()
        if (!tools.some(item => item.name === input.tool)) throw new HarnessError('当前工程没有此剪辑工具。', 'OPENCHATCUT_TOOL_UNKNOWN')
        const args = { ...input.args }
        if ('editorProjectId' in args && args.editorProjectId !== view.project) throw new HarnessError('工具参数指向其他工程。', 'OPENCHATCUT_WRONG_PROJECT')
        if (input.tool === 'begin_edit_session') {
          if (args.approvalMode !== undefined && args.approvalMode !== 'manual') throw new HarnessError('请使用 manual，在剪辑器里预览和应用改动。', 'OPENCHATCUT_MANUAL_REVIEW')
          args.approvalMode = 'manual'
          args.clientName = 'Muse'
        }
        const signal = AbortSignal.any([exec.signal, view.lifetime.signal])
        signal.throwIfAborted()
        return await view.call(input.tool, args, signal)
      },
    })
    for (const tool of [discovery, run]) scope.effect(() => scope.tools.register(tool))
  })
}
