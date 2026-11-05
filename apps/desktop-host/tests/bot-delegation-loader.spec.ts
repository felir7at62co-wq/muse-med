/** Real Loader + AgentLoop + Bot routing; only the external LLM is scripted. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Llm from '@deepseek-ai/dsh-llm'
import * as Sessions from '@deepseek-ai/dsh-session'
import * as Projections from '@deepseek-ai/dsh-session-projection'
import * as Prompt from '@deepseek-ai/dsh-system-prompt'
import * as Tools from '@deepseek-ai/dsh-tools'
import * as Agents from '@deepseek-ai/dsh-agent'
import * as Loop from '@deepseek-ai/dsh-agent-loop'
import * as DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import * as Title from '@deepseek-ai/dsh-session-title'
import * as Fs from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as Todo from '@deepseek-ai/dsh-tool-todo'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Query from '@deepseek-ai/dsh-session-query-sqlite'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Workspace from '@deepseek-ai/dsh-workspace'
import * as Typert from '@deepseek-ai/dsh-typert-registry'
import * as Attachments from '@deepseek-ai/dsh-attachment-local'
import * as Credentials from '@deepseek-ai/dsh-credentials-local'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import * as Commands from '@deepseek-ai/dsh-commands'
import * as Upload from '@deepseek-ai/dsh-client-file-upload'
import * as Controller from '@deepseek-ai/dsh-api-session-controller'
// @ts-expect-error Native DS Bot is runtime JavaScript without a declaration artifact; Loader owns its plugin boundary.
import * as Bot from '../../../third_party/plugins/ds-bot/index.js'
import * as Scripted from './fixtures/bot-delegation/scripted-llm.ts'
import { mainEvents, todoSnapshots } from './fixtures/bot-delegation/state-observer.ts'
import { expect, it, vi } from 'vitest'

it('routes partial work back to Main, verifies files and todos, and explicitly delegates only the unfinished range', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-bot-delegation-loader-'))
  const ctx = new Context()
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden in offline Bot composition'))
  try {
    await mkdir(join(root, 'team'))
    const bot = (id: string, name: string) => ({ id, sessionId: id, name, instructions: '',
      model: 'delegation-fixture/delegation-fixture', workDir: root, createdAt: 1 })
    await writeFile(join(root, 'team/state.json'), JSON.stringify({ version: 1, revision: 0,
      mainBotIds: ['delegation-main'], whaleStored: true,
      bots: { 'delegation-main': bot('delegation-main', 'Chief'), 'delegation-writer': bot('delegation-writer', 'Writer') },
      rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
    }))
    const configPath = join(root, 'cordis.yml')
    const fixture = await readFile(new URL('./fixtures/bot-delegation/cordis.yml', import.meta.url), 'utf8')
    await writeFile(configPath, fixture.replaceAll('@ROOT@', root.replaceAll('\\', '/')))
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-llm', Llm], ['@deepseek-ai/dsh-session', Sessions],
      ['@deepseek-ai/dsh-session-projection', Projections], ['@deepseek-ai/dsh-system-prompt', Prompt],
      ['@deepseek-ai/dsh-tools', Tools], ['@deepseek-ai/dsh-agent', Agents], ['@deepseek-ai/dsh-agent-loop', Loop],
      ['@deepseek-ai/dsh-agent-default-model', DefaultModel], ['@deepseek-ai/dsh-session-title', Title],
      ['@deepseek-ai/dsh-fs-local', Fs], ['@deepseek-ai/dsh-tool-fs', ToolFs], ['@deepseek-ai/dsh-tool-todo', Todo],
      ['@deepseek-ai/dsh-session-persistence-jsonl', Persistence], ['@deepseek-ai/dsh-session-query-sqlite', Query],
      ['@deepseek-ai/dsh-storage', Storage], ['@deepseek-ai/dsh-storage-json', StorageJson],
      ['@deepseek-ai/dsh-storage-domain', StorageDomain], ['@deepseek-ai/dsh-workspace', Workspace],
      ['@deepseek-ai/dsh-typert-registry', Typert], ['@deepseek-ai/dsh-attachment-local', Attachments],
      ['@deepseek-ai/dsh-credentials-local', Credentials], ['@deepseek-ai/dsh-client-connection', Connection],
      ['@deepseek-ai/dsh-commands', Commands], ['@deepseek-ai/dsh-client-file-upload', Upload],
      ['@deepseek-ai/dsh-api-session-controller', Controller], ['ds-bot', Bot], ['fixture:scripted-llm', Scripted],
    ])
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2', loadCache: new Map(),
      register() { throw new Error('Unexpected Loader hook') },
      getOrCreateModuleJob() { throw new Error('Unexpected Loader module job') },
      resolveSync() { throw new Error('Unexpected Loader resolution') },
      load() { throw new Error('Unexpected Loader load') },
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected Loader module ${specifier}`)
        return modules.get(specifier)
      },
    }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect([...ctx.loader.entries()].filter(entry => !entry.disabled && entry.fiber === undefined)
      .map(entry => entry.options.name)).toEqual([])
    const selection = { provider: 'delegation-fixture', model: 'delegation-fixture' }
    const main = await ctx.agentLoop.create(Sessions.SessionId('delegation-main'), selection, { cwd: root })
    const writerAgent = await ctx.agentLoop.create(Sessions.SessionId('delegation-writer'), selection, { cwd: root })
    main.followup(Llm.createUserMessage({ content: [{ type: 'text', text: 'Complete and verify EP1–7. Continue safe unfinished work.' }], source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(JSON.stringify(mainEvents(ctx))).toContain('Verified all seven saved manuscripts')
    }, { timeout: 10000, interval: 20 })
    await main.whenIdle()
    await writerAgent.whenIdle()
    await ctx.sessions.flush(main.session)
    await ctx.sessions.flush(writerAgent.session)
    for (let episode = 1; episode <= 7; episode++) {
      expect(await readFile(join(root, `ep${episode}.md`), 'utf8')).toBe(Scripted.episodeText(episode))
    }
    const events = mainEvents(ctx)
    const callEvents = events.filter(event => event.type === 'tool/call')
    const calls = callEvents.map(event => event.data)
    const resultEvents = events.filter(event => event.type === 'tool/result')
    expect(resultEvents).toHaveLength(calls.length)
    expect(resultEvents.every(event => event.data.message.isError !== true)).toBe(true)
    expect(calls.filter(call => call.name === 'message_bot').map(call =>
      (JSON.parse(call.arguments) as Record<string, unknown>).request_id)).toEqual(['ep1-7', 'ep4-7'])
    expect(calls.filter(call => call.name === 'read').map(call =>
      (JSON.parse(call.arguments) as Record<string, unknown>).file_path)).toEqual(
      Array.from({ length: 7 }, (_, i) => `ep${i + 1}.md`))
    const snapshots = todoSnapshots(ctx)
    expect(snapshots[1]?.slice(0, 3).every(todo => todo.status === 'completed')).toBe(true)
    expect(snapshots[1]?.slice(3).every(todo => todo.status !== 'completed')).toBe(true)
    expect(snapshots.at(-1)?.every(todo => todo.status === 'completed')).toBe(true)
    const incomplete = events.find(event => event.type === 'user/message'
      && JSON.stringify(event.data).includes('assigned work is not confirmed complete'))
    expect(incomplete).toBeDefined()
    const reads = callEvents.filter(event => event.data.name === 'read')
    expect(incomplete!.seq).toBeLessThan(reads[0]!.seq)
    for (const [index, read] of reads.entries()) {
      const result = resultEvents.find(event => event.data.message.toolCallId === read.data.callId)
      expect(result).toBeDefined()
      expect(JSON.stringify(result!.data.message.content)).toContain(Scripted.episodeText(index + 1).trim())
    }
    const remainingTodo = events.filter(event => event.type === 'todo/write')[1]!
    const continuation = callEvents.filter(event => event.data.name === 'message_bot')[1]!
    const thirdReadResult = resultEvents.find(event => event.data.message.toolCallId === reads[2]!.data.callId)!
    expect(thirdReadResult.seq).toBeLessThan(remainingTodo.seq)
    expect(remainingTodo.seq).toBeLessThan(continuation.seq)
    const writer = ctx.sessions.get(Sessions.SessionId('delegation-writer'))!
    const writerEvents = writer.snapshotEvents()
    expect(writerEvents.filter(event => event.type === 'tool/call' && event.data.name === 'write')).toHaveLength(7)
    expect(writerEvents.filter(event => event.type === 'tool/result').every(event => event.data.message.isError !== true)).toBe(true)
    expect(writerEvents.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['max-tokens', 'completed'])
    expect(network).not.toHaveBeenCalled()
  } finally {
    await ctx.fiber.dispose()
    network.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
