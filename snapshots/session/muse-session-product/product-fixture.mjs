/** Ordinary product Sessions retain Jobs, collection discovery and a separately configured MCP connection. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'
import { importSnapshotModule, importSnapshotPackage } from '../muse-fixture-import.mjs'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'

const { loadOverlayPatches } = await importSnapshotPackage('@deepseek-ai/dsh-app-boot',
  new URL('../../../apps/desktop-host/package.json', import.meta.url))

const { PiAiAdapter, resolveProfiles } = await importSnapshotModule(
  new URL('../../../packages/llm/llm-pi-ai/src/index.ts', import.meta.url),
  new URL('../../../packages/llm/llm-pi-ai/lib/index.js', import.meta.url),
)
const Discovery = await importSnapshotModule(new URL('../../../packages/core/tool-discovery/src/index.ts', import.meta.url),
  new URL('../../../packages/core/tool-discovery/lib/index.js', import.meta.url))
const McpClient = await importSnapshotModule(new URL('../../../packages/mcp/mcp-client/src/index.ts', import.meta.url),
  new URL('../../../packages/mcp/mcp-client/lib/index.js', import.meta.url))
const botTools = ['list_bots', 'message_bot', 'create_bot', 'update_bot', 'stop_bot', 'show_view', 'ask_user',
  'request_secret', 'list_secrets', 'list_bot_models', 'create_group', 'update_group', 'delete_group', 'post_to_group',
  'group_relay', 'read_own_chat', 'read_group_chat', 'remember', 'forget', 'recall', 'read_browser', 'list_capabilities',
  'save_capability', 'delete_capability', 'attach_capability', 'detach_capability']
const mcpTool = 'mcp__user-fixture__project_lookup'
const provider = 'deepseek-official', model = 'deepseek-v4-flash'

/** Loader identity for ordinary Session acceptance. */
export const name = 'snapshot-muse-session-product'
/** All Session, task, permission and tool services remain real. */
export const inject = ['llm', 'tools', 'agents', 'agentPresets', 'systemPrompt']

/**
 * Mount production composition and replace only external model/MCP responses.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated shipped-profile context.
 * @returns {Promise<void>} Completion after owned listeners and product services are ready.
 */
export async function apply(ctx) {
  const row = loadOverlayPatches('ordinary-session-discovery', fileURLToPath(new URL(
    '../../../apps/desktop-host/config/desktop.cordis.patch.yml', import.meta.url,
  ))).flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'tool-discovery')
  assert.ok(row)
  await ctx.plugin(Discovery, Discovery.Config(row.config))
  await mountPreset(ctx, { presetId: 'short-drama', hidePlatformShellTools: true })
  assert.equal(ctx.agentPresets.defaultId, 'short-drama', 'A saved retired default cannot select a new Bot conversation')
  const sdkOwner = new URL('../../../packages/mcp/mcp-client/package.json', import.meta.url)
  const requireSdk = createRequire(sdkOwner)
  const importSdk = async name => {
    const manifestUrl = new URL('../package.json', pathToFileURL(requireSdk.resolve(name)))
    const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
    return import(new URL(manifest.exports['.'].import.default, manifestUrl).href)
  }
  const [{ McpServer, createMcpHandler }, { toNodeHandler }, { z }] = await Promise.all([
    importSdk('@modelcontextprotocol/server'), importSdk('@modelcontextprotocol/node'), import(pathToFileURL(requireSdk.resolve('zod')).href),
  ])
  let mcpCalls = 0, mcpUrl, rejected
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'user-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.registerTool('project_lookup', { description: 'Read synthetic project material from the user-configured MCP connection.',
      inputSchema: z.object({}).strict() }, async () => {
      mcpCalls++
      return { content: [{ type: 'text', text: 'Synthetic user project material; no Muse knowledge-base service was used.' }] }
    })
    return server
  })
  ctx.effect(() => () => handler.close())
  const handle = toNodeHandler(handler)
  await applyLoopbackServerEffect(ctx, { label: 'snapshot-user-mcp', onCleanup() {},
    onListening: address => { mcpUrl = `http://127.0.0.1:${address.port}/mcp` },
    requestListener: (request, response) => {
      handle(request, response).catch(error => {
        rejected = error
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
    },
  })
  await ctx.plugin(McpClient, McpClient.Config({ serverName: 'user-fixture', transport: 'streamable-http', url: mcpUrl,
    failOnStartupError: true, reconnect: { enabled: false } })).await()
  let requests = 0, modelUrl
  await applyLoopbackServerEffect(ctx, { label: 'snapshot-session-product-model', onCleanup() {},
    onListening: address => { modelUrl = `http://127.0.0.1:${address.port}` },
    requestListener: (request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk.toString('utf8') })
      request.once('end', () => {
        try {
          assert.equal(request.url, '/chat/completions'); assert.equal(request.headers.authorization, 'Bearer snapshot-fake-key')
          const payload = JSON.parse(body), results = payload.messages.filter(message => message.role === 'tool')
          requests++; assert.ok(requests <= 5); assert.equal(results.length, requests - 1)
          const calls = [
            ['job_list', {}],
            ['tool_search', { query: '七猫榜单', capability: 'data-sourcing' }],
            ['tool_search', { query: mcpTool, capability: 'knowledge' }],
            [mcpTool, {}],
          ]
          if (requests === 5) assert.ok(results[3].content.includes('Synthetic user project material'))
          const call = calls[requests - 1]
          const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `session-product-${requests}`, type: 'function',
            function: { name: call[0], arguments: JSON.stringify(call[1]) } }] }
            : { role: 'assistant', content: '普通会话已检查后台任务，并找到七猫采集工具；用户单独配置的 MCP 项目资料读取成功。没有使用 Bot 服务或 Muse 自带知识库。' }
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end([
            { choices: [{ index: 0, delta, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
          ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n')
        } catch (error) {
          rejected = error; console.error(error)
          response.writeHead(500); response.end('{"error":{"message":"Ordinary Session fixture mismatch"}}')
        }
      })
    },
  })
  const profiles = resolveProfiles({ [provider]: { api: 'openai-completions', baseURL: modelUrl,
    compat: { maxTokensField: 'max_tokens' }, models: [{ id: model, contextWindow: 1000000, maxTokens: 256000, reasoningEfforts: false }] } })
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: () => Promise.resolve('snapshot-fake-key'), auth: {
    credentials: { read: () => Promise.resolve(undefined), list: () => Promise.resolve([]),
      modify: () => { throw new Error('No credential writes') }, delete: () => { throw new Error('No credential deletion') } },
    authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) },
  } })
  ctx.effect(() => ctx.llm.registerAdapter([provider], adapter))
  ctx.on('llm/stream', async function* (options, next) {
    const names = options.tools.map(tool => tool.name)
    for (const tool of botTools) assert.ok(!names.includes(tool), `Retired Bot tool reached the model: ${tool}`)
    assert.ok(!names.some(name => name.startsWith('mcp__muse-account__')))
    for (const tool of ['read', 'write', 'present', 'ask_user_question', 'job_list', 'job_output', 'subagent', 'subagent_fork', 'web_search']) assert.ok(names.includes(tool), tool)
    yield* next()
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (rejected) throw rejected
    assert.equal(requests, 5); assert.equal(mcpCalls, 1)
    assert.equal(ctx.agentPresets.composedPreset(agent.ctx), 'short-drama')
    const registered = ctx.tools.schemas(agent).map(tool => tool.name)
    for (const tool of ['qimao_rankings', 'source_snapshot', 'source_report', 'work_mapping', 'lvpaopao', 'douyin_download', 'douyin_download_task']) assert.ok(registered.includes(tool), tool)
    const calls = agent.session.snapshotEvents().filter(event => event.type === 'tool/call')
    assert.deepEqual(calls.map(event => event.data.name), ['job_list', 'tool_search', 'tool_search', mcpTool])
  })
}
