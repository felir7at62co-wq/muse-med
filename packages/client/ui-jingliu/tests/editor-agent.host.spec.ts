import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Client } from '@modelcontextprotocol/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { registerEditorAgent } from '../src/editor-agent.ts'

it('binds a real editor view to its conversation, fixes manual review and releases the connection on close', async () => {
  const ctx = new Context()
  const directory = await mkdtemp(join(tmpdir(), 'muse-cut-'))
  const tokenFile = join(directory, 'mcp-token')
  await writeFile(tokenFile, 'test-only')
  const tools = new Map<string, ToolDefinition>()
  let route: WebRoute | undefined
  class Web extends Service {
    constructor(c: Context) { super(c, 'webServer') }
    register(r: WebRoute) { route = r; return () => { route = undefined } }
  }
  class Trust extends Service {
    constructor(c: Context) { super(c, 'connection') }
    requestRejection(request: { headers: { cookie?: string } }) { return request.headers.cookie === 'scope=test' ? undefined : 401 }
  }
  class Tools extends Service {
    constructor(c: Context) { super(c, 'tools') }
    register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => tools.delete(tool.name) }
  }
  const server = createServer((req, res) => { if (route) void route.handler(req, res); else { res.writeHead(404); res.end() } })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('missing server port')
  const root = 'http://127.0.0.1:' + address.port
  onTestFinished(async () => {
    server.closeAllConnections(); server.close(); await ctx.fiber.dispose(); vi.restoreAllMocks(); await rm(directory, { recursive: true })
  })
  for (const service of [Web, Trust, Tools]) await ctx.plugin(service).await()
  registerEditorAgent(ctx, root, tokenFile)
  await vi.waitFor(() => expect(tools.has('openchatcut_call')).toBe(true))
  vi.spyOn(Client.prototype, 'connect').mockResolvedValue()
  const listed = { name: 'begin_edit_session', inputSchema: { type: 'object' as const } }
  vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [listed, { ...listed, name: 'target_project' }, { ...listed, name: 'run_code' }] })
  const upstream = vi.spyOn(Client.prototype, 'callTool').mockImplementation(async request => ({
    content: [{ type: 'text', text: 'ok' }], structuredContent: request.name === 'target_project'
      ? { bindingMode: 'browser', binding: { projectId: request.arguments?.projectId, editorInstanceId: 'browser1', ownershipEpoch: 1 } } : { status: 'drafting' },
  }))
  const invoke = (session: string, name: string, args: Record<string, unknown>) => tools.get(name)!.execute(args,
    { agent: { session: { id: session } }, signal: new AbortController().signal } as ToolRunContext)
  const path = root + '/api/openchatcut/view?session=alpha&project=demo&owner=browser1&epoch=1'
  const headers = { cookie: 'scope=test', 'x-muse-editor-view': '1' }
  expect((await fetch(path)).status).toBe(401)
  expect((await fetch(path, { headers: { cookie: headers.cookie } })).status).toBe(400)
  const controller = new AbortController()
  const visible = await fetch(path, { headers, signal: controller.signal })
  expect(visible.status).toBe(200)
  const result = await invoke('alpha', 'openchatcut_tools', {})
  expect(result).toMatchInlineSnapshot(`
    {
      "project_id": "demo",
      "tools": [
        "begin_edit_session",
      ],
      "total": 1,
    }
  `)
  await expect(invoke('beta', 'openchatcut_tools', {})).rejects.toThrow('当前 Muse 会话')
  const run = (project_id: string, tool: string, args = {}) => invoke('alpha', 'openchatcut_call', { project_id, tool, args })
  await expect(run('other', 'begin_edit_session')).rejects.toThrow('当前 Muse 会话')
  await expect(run('demo', 'target_project')).rejects.toThrow('没有此剪辑工具')
  await expect(run('demo', 'run_code')).rejects.toThrow('没有此剪辑工具')
  await expect(run('demo', 'begin_edit_session', { approvalMode: 'auto' })).rejects.toThrow('manual')
  await run('demo', 'begin_edit_session')
  expect(upstream.mock.calls.map(([request]) => request)).toEqual([
    { name: 'target_project', arguments: { projectId: 'demo' } },
    { name: 'begin_edit_session', arguments: { approvalMode: 'manual', clientName: 'Muse' } },
  ])
  controller.abort()
  await vi.waitFor(async () => await expect(invoke('alpha', 'openchatcut_tools', {})).rejects.toThrow('当前 Muse 会话'))
})
