import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function check(value, code) {
  if (!value) throw new Error(code)
}

function textOf(event) {
  const message = event.data?.message ?? event.data
  return Array.isArray(message?.content)
    ? message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    : ''
}

export async function apply(ctx) {
  const config = JSON.parse(await readFile(process.env.MUSE_ROUNDTRIP_CONFIG, 'utf8'))
  const library = await import(pathToFileURL(join(process.env.MUSE_ROUNDTRIP_PACKAGED_RUNTIME, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')).href)
  const provider = 'muse-session-roundtrip-local'
  const model = 'recorded-response'
  let modelCalls = 0
  class FixtureAdapter extends library.LlmAdapter {
    resolveModel(_provider, id) { return Promise.resolve({ provider, id, name: id }) }
    listModels() { return Promise.resolve([{ id: model, name: model }]) }
    async * stream() {
      modelCalls++
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, blockType: 'text', text: config.assistantText }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: config.assistantText } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter([provider], new FixtureAdapter()), 'muse-session-roundtrip-adapter')

  async function verify(sessionId, workspaceId) {
    const work = ctx.workspaceRegistry.get(workspaceId)
    check(work && work.id === workspaceId && work.title === config.workspaceTitle
      && work.path === await realpath(config.workspace) && work.sessionIds.includes(sessionId), 'ROUNDTRIP_WORKSPACE_BINDING')
    const signal = AbortSignal.timeout(20_000)
    const found = await ctx.sessionController.list({}, signal)
    check(found.items.filter(item => item.sessionId === sessionId).length === 1, 'ROUNDTRIP_SESSION_LIST')
    const before = modelCalls
    const page = await ctx.sessionController.events({ address: { kind: 'session', sessionId }, maxMessages: 30 }, signal)
    const events = page.records.map(record => record.event)
    check(events.filter(event => event.type === 'user/message' && textOf(event) === config.userText).length === 1, 'ROUNDTRIP_USER_TEXT')
    check(events.filter(event => event.type === 'assistant/message' && textOf(event) === config.assistantText).length === 1, 'ROUNDTRIP_ASSISTANT_TEXT')
    check(modelCalls === before, 'ROUNDTRIP_READ_STARTED_MODEL')
    const owner = await ctx.sessionController.resolveAgent(sessionId)
    check(owner && !('error' in owner) && owner.agent.id === sessionId, 'ROUNDTRIP_SESSION_RESUME')
    return { sessionId, workspaceId, modelCalls, sessionListed: true, userMessageVerified: true, assistantMessageVerified: true,
      workspaceVerified: true, sessionResumed: true, processNetworkBlocked: globalThis[Symbol.for('muse-session-roundtrip-network')]?.denied }
  }

  async function create() {
    const work = await ctx.workspaceRegistry.create(config.workspace)
    await work.setTitle(config.workspaceTitle)
    const created = await ctx.sessionController.create({ workspaceId: work.id, agentPreset: 'short-drama' })
    const owner = await ctx.sessionController.resolveAgent(created.sessionId)
    check(owner && !('error' in owner), 'ROUNDTRIP_CREATE_SESSION')
    owner.agent.model.select({ provider, model })
    owner.agent.followup(library.createUserMessage({ content: [{ type: 'text', text: config.userText }], source: { kind: 'user' } }))
    await Promise.race([owner.agent.whenIdle(), new Promise((_, reject) => {
      setTimeout(() => reject(new Error('ROUNDTRIP_TURN_TIMEOUT')), 45_000).unref()
    })])
    check(modelCalls >= 1, 'ROUNDTRIP_LOCAL_MODEL_NOT_CALLED')
    const renamed = await ctx.sessionController.rename({ sessionId: created.sessionId, title: config.sessionTitle })
    check(renamed?.title === config.sessionTitle, 'ROUNDTRIP_SESSION_TITLE')
    const report = await verify(created.sessionId, work.id)
    return report
  }

  ctx.effect(() => {
    const handle = async command => {
      if (command?.type !== 'muse-session-roundtrip') return
      try {
        check(command.mode === process.env.MUSE_ROUNDTRIP_PHASE, 'ROUNDTRIP_WRONG_PHASE')
        const report = command.mode === 'write' ? await create() : await verify(command.sessionId, command.workspaceId)
        if (command.mode === 'read') check(report.modelCalls === 0, 'ROUNDTRIP_NEW_RUNTIME_GENERATED')
        process.send?.({ type: 'muse-session-roundtrip-result', report })
      } catch (error) {
        const message = error instanceof Error && /^ROUNDTRIP_[A-Z_]+$/u.test(error.message) ? error.message : String(error?.code ?? error?.name)
        process.send?.({ type: 'muse-session-roundtrip-result', error: message })
      }
    }
    process.on('message', handle)
    return () => { process.off('message', handle) }
  }, 'muse-session-roundtrip-ipc')
}
