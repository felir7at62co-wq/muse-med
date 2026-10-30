// The scoped registration follows DS Bot 0.2.4; these tests exercise Muse's tool runtime.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { install as installTools } from '../src/host/tools.js'
import { install as installAgents } from '../src/host/agents.js'

const owner = createRequire(import.meta.url)
const toolPeers = createRequire(owner.resolve('@deepseek-ai/dsh-tools/package.json'))
const { createScope, scopeTarget } = await import(toolPeers.resolve('@deepseek-ai/dsh-scope'))

async function setup(t) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  t.after(async () => ctx.fiber.dispose())
  let rt
  const plugin = await ctx.plugin({ inject: ['tools'], apply(inner) {
    rt = {
      ctx: inner, config: { goals: 'host' },
      state: { agents: { plain: { id: 'plain', sessions: ['classic'] } }, questions: {}, views: {}, exchangeTurns: {} },
      groupOwners: new Map([['group', { roomId: 'room' }]]),
      chatOwners: new Map([['bot', 'writer']]), live: new Map(),
      load: async () => {}, save: async () => {},
      selfOf: id => id === 'bot' || id === 'group' ? 'writer' : undefined,
      botOf: id => id === 'writer' ? { id, interactionSource: 'bot' } : undefined,
      isBotSession: id => id === 'bot' || id === 'group',
      isMain: () => false,
      warn: (...args) => { throw new Error(args.join(' ')) },
    }
    installTools(rt)
    installAgents(rt)
    rt.indexAgents()
  } })
  await plugin.await()
  const agent = async id => {
    const value = { id, session: { id } }
    const scope = createScope(rt.ctx, value)
    value.ctx = scope.ctx
    t.after(() => scope.dispose())
    await ctx.serial(scopeTarget(value), 'agent/created', { agent: value })
    // The native DSH-agent exclusion listener deliberately resolves its store asynchronously.
    await new Promise(resolve => setImmediate(resolve))
    return value
  }
  return { ctx, tools: rt.ctx.tools, rt, plugin, agent }
}

test('Bot cards shadow a global renderer without affecting an ordinary agent', async t => {
  const f = await setup(t)
  await f.ctx.plugin({ inject: ['tools'], apply(inner) {
    inner.tools.register(defineTool({ name: 'show_view', description: 'External renderer', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'external',
    }))
  } }).await()
  const bot = await f.agent('bot')
  const stranger = await f.agent('stranger')
  assert.notEqual(f.tools.get('show_view', bot)?.description, 'External renderer')
  assert.equal(f.tools.get('show_view', stranger)?.description, 'External renderer')
  const shown = await f.tools.get('show_view', bot).execute({ title: 'Progress', view: { type: 'metric', label: 'Done', value: 4 } }, { agent: bot })
  assert.equal(shown, 'The view is on screen.')
  await f.plugin.dispose()
  assert.equal(f.tools.get('show_view', bot)?.description, 'External renderer')
})

test('plain DSH Agents have no Bot management schemas while ordinary Bots retain Main-Bot checks', async t => {
  const f = await setup(t)
  const classic = await f.agent('classic')
  const bot = await f.agent('bot')
  const classicNames = f.tools.schemas(classic).map(tool => tool.name)
  for (const name of ['show_view', 'create_bot', 'message_bot', 'update_bot']) assert.equal(classicNames.includes(name), false, name)
  assert.equal(f.tools.schemas(bot).some(tool => tool.name === 'create_bot'), true)
  const refused = await f.tools.get('create_bot', bot).execute({ name: 'Not created', role: 'Test', instructions: 'test' }, { agent: bot })
  assert.equal(refused, 'Only the Main Bot can create Bots. Ask the Main Bot instead.')
})

test('Bot-session disposal removes its card registration', async t => {
  const f = await setup(t)
  const bot = await f.agent('bot')
  assert.ok(f.tools.get('show_view', bot))
  await f.ctx.parallel(scopeTarget(bot), 'agent/disposed', { agent: bot })
  assert.equal(f.tools.get('show_view', bot), undefined)
})


test('a delayed Bot load cannot restore card tools after plugin unload', async t => {
  const f = await setup(t)
  let release
  f.rt.load = () => new Promise(resolve => { release = resolve })
  const bot = { id: 'bot', session: { id: 'bot' } }
  const scope = createScope(f.rt.ctx, bot)
  bot.ctx = scope.ctx
  t.after(() => scope.dispose())
  const starting = f.ctx.serial(scopeTarget(bot), 'agent/created', { agent: bot })
  await Promise.resolve()
  await f.plugin.dispose()
  release()
  await starting
  assert.equal(f.tools.get('show_view', bot), undefined)
})
