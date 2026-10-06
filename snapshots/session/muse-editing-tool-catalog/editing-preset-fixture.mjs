/** Mount the editing preset and discover the source Muse MCP catalog over loopback. */
import { Service } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PERSONA_SUFFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import NativePreset from '../../../apps/desktop-host/src/native-preset.ts'
import * as McpClient from '../../../packages/mcp/mcp-client/src/index.ts'
import { createMuseAccountMcpServer } from '../../../packages/host/muse-account/src/mcp-server.ts'
import { createMuseKbReader } from '../../../packages/host/muse-account/src/kb.ts'
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'

export const name = 'snapshot-editing-preset'
export const inject = ['agentPresets', 'tools', 'systemPrompt']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Snapshot composition.
 * @param config - Platform-shell visibility and whether the recording includes clock messages.
 */
export async function apply(ctx, config) {
  let productBaseUrl
  let productPresetDirectory
  await ctx.effect(async () => {
    // Native package lookup and inventory both read the retained source manifest.
    const anchor = await mkdtemp(fileURLToPath(new URL('../../../apps/desktop-host/.snapshot-hongguo-', import.meta.url)))
    try {
      await mkdir(join(anchor, 'node_modules'))
      for (const plugin of ['muse-hongguo-search', 'muse-hongguo-download', 'muse-douyin-download']) {
        await symlink(fileURLToPath(new URL(`../../../third_party/plugins/${plugin}/`, import.meta.url)), join(anchor, 'node_modules', plugin), process.platform === 'win32' ? 'junction' : 'dir')
      }
      await writeFile(join(anchor, 'package.json'), '{"name":"snapshot-editing-resolution","version":"0.0.0","type":"module"}\n')
      productBaseUrl = pathToFileURL(join(anchor, 'package.json')).href
      productPresetDirectory = join(anchor, 'editing')
      await mkdir(productPresetDirectory)
      const sourceDirectory = new URL('../../../apps/desktop-host/presets/editing/', import.meta.url)
      const source = (await readFile(new URL('agent.cordis.yml', sourceDirectory), 'utf8')).replaceAll('\r\n', '\n')
      const clockRow = "- id: time-context\n  name: '@deepseek-ai/dsh-time-context'\n"
      if (!source.includes(clockRow) || source.indexOf(clockRow) !== source.lastIndexOf(clockRow)) {
        throw new Error('The source editing preset must declare one request clock')
      }
      // This catalog recording predates clock messages; the clock recording keeps the current preset contribution.
      await writeFile(join(productPresetDirectory, 'agent.cordis.yml'), config.keepClock === true
        ? source.replace(clockRow, `${clockRow}  config:\n    timeZone: UTC\n`)
        : source.replace(clockRow, `${clockRow}  disabled: true\n`))
      await writeFile(join(productPresetDirectory, 'preset.yml'), await readFile(new URL('preset.yml', sourceDirectory)))
    } catch (error) {
      await rm(anchor, { recursive: true, force: true })
      throw error
    }
    return () => rm(anchor, { recursive: true, force: true })
  }, 'snapshot-hongguo-source-resolver')
  class SnapshotAccount extends Service { constructor(ctx) { super(ctx, 'museAccount') } }
  await ctx.plugin(SnapshotAccount)
  const requireSdk = createRequire(new URL('../../../packages/mcp/mcp-client/package.json', import.meta.url))
  const importSdk = async name => {
    const manifestUrl = new URL('../package.json', pathToFileURL(requireSdk.resolve(name)))
    const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
    return import(new URL(manifest.exports['.'].import.default, manifestUrl).href)
  }
  const [{ createMcpHandler }, { toNodeHandler }] = await Promise.all([
    importSdk('@modelcontextprotocol/server'),
    importSdk('@modelcontextprotocol/node'),
  ])
  let kb
  await ctx.effect(async () => {
    const accountHome = await mkdtemp(join(tmpdir(), 'dsh-snapshot-muse-account-'))
    kb = createMuseKbReader({
      baseUrl: 'https://snapshot-muse.invalid',
      sessionFile: join(accountHome, 'session.json'),
      requestTimeoutMs: 15_000,
      fetcher: async () => { throw new Error('Snapshot Muse gateway requests are unavailable') },
    })
    return () => rm(accountHome, { recursive: true, force: true })
  }, 'snapshot-muse-account-home')
  const handler = createMcpHandler(() => createMuseAccountMcpServer({ status: async () => ({ state: 'signed-out' }) }, kb), {
    onerror: error => console.error('Snapshot Muse MCP handler failed:', error),
  })
  ctx.effect(() => () => handler.close(), 'snapshot-muse-mcp-handler')
  const handle = toNodeHandler(handler)
  let mcpUrl
  await applyLoopbackServerEffect(ctx, {
    label: 'snapshot-muse-mcp-server',
    requestListener: (req, res) => {
      handle(req, res).catch(error => {
        console.error('Snapshot Muse MCP request failed:', error)
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
    },
    onListening: address => { mcpUrl = `http://127.0.0.1:${address.port}/mcp` },
    onCleanup: () => {},
  })
  await ctx.plugin(McpClient, McpClient.Config({
    serverName: 'muse-account',
    transport: 'streamable-http',
    url: mcpUrl,
    failOnStartupError: true,
    reconnect: { enabled: false },
  })).await()
  const productCtx = ctx.extend({baseUrl: productBaseUrl})
  await productCtx.plugin(NativePreset, {
    id: 'editing',
    directory: productPresetDirectory,
  })
  ctx.on('agent/created', async ({ agent }) => {
    await ctx.agentPresets.mount(agent.ctx, 'editing')
    // The product suffix puts Chinese punctuation directly after {{cwd}};
    // this snapshot-only shadow keeps the same meaning with a path boundary.
    agent.ctx.effect(() => agent.ctx.systemPrompt.section({
      name: PERSONA_SUFFIX_SECTION,
      order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
      text: '当前工作目录是 {{cwd}} 。',
    }))
    if (config.hidePlatformShellTools === true) {
      agent.ctx.effect(() => agent.ctx.tools.restrict({ futureDeny: ['bash', 'pwsh'] }))
      for (const [name, order] of [
        ['tool:bash', 'TOOL_BASH'],
        ['tool:pwsh', 'TOOL_PWSH'],
      ]) {
        agent.ctx.effect(() => agent.ctx.systemPrompt.section({
          name,
          order: agent.ctx.systemPrompt.getSectionOrder(order),
          text: '',
        }))
      }
    }
  })
}
