/** Record actual learning decline ownership through the shipped tool and model services. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install as installLearning } from '../../../third_party/plugins/ds-bot/src/host/learning.js'
import { install as installMemory } from '../../../third_party/plugins/ds-bot/src/host/memory.js'
import { install as installStore } from '../../../third_party/plugins/ds-bot/src/host/store.js'
import { resolveMuseConfig } from '../../../third_party/plugins/ds-bot/src/host/muse-config.js'
import { output } from '../../../third_party/plugins/ds-bot/src/host/tools.js'

/** Loader name for the real learning module fixture. */
export const name = 'snapshot-bot-learning-privacy'
/** Real profile services and the separately mounted keyless provider. */
export const inject = ['tools', 'systemPrompt', 'llm', 'snapshotLearningRequests']

/**
 * Mount actual Bot persistence, one-shot requests and learning in an isolated home.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless profile context.
 * @returns {Promise<void>} Completion after tool registration.
 */
export async function apply(ctx) {
  const home = await mkdtemp(join(tmpdir(), 'muse-learning-snapshot-'))
  const path = join(home, 'learning', 'state.json')
  const bots = {
    diary: { id: 'diary', name: 'Private Diary', private: true, model: 'snapshot-learning/diary', capabilities: [] },
    writer: { id: 'writer', name: 'Public Writer', model: 'snapshot-learning/writer', capabilities: [] },
  }
  await mkdir(join(home, 'learning'))
  await writeFile(join(home, 'state.json'), JSON.stringify({ version: 1, mainBotIds: [], bots, rooms: {}, agents: {}, capabilities: { items: {} }, revision: 1, whaleStored: true }))
  await writeFile(path, JSON.stringify({ pending: { diary: ['diary'] }, declined: [{ name: 'legacy-rule', description: 'Legacy ownerless marker.' }] }))
  let statusListener
  const seq = new Map()
  const runtime = {
    ctx: {
      tools: ctx.tools, systemPrompt: ctx.systemPrompt, llm: ctx.llm,
      effect: (execute, label) => ctx.effect(execute, label),
      on: (event, listener, ...options) => {
        if (event === 'agent/status') statusListener = listener
        return ctx.on(event, listener, ...options)
      },
    },
    config: resolveMuseConfig({ memoryReview: false, agentsMd: false, learningTimes: { minTurnMs: 0, tickMs: 100_000 } }),
    home, dshHome: home, statePath: join(home, 'state.json'),
    desiredModel: async bot => bot.model,
    defaultModel: async () => 'snapshot-learning/writer',
    redactSecrets: text => text,
    workView: () => ({}),
    sessionFolder: () => undefined,
    capabilityDelete: async () => { throw new Error('The recording must not delete a capability') },
    capabilityEndpoint: async () => { throw new Error('The recording must not attach a capability') },
    warn: (...args) => { throw new Error(args.map(String).join(' ')) },
    partLines: async function* (id) {
      const through = (seq.get(id) ?? 0) + 1
      seq.set(id, through)
      yield { seq: through, who: 'user', text: 'User: Check the recurring project work.' }
    },
  }
  ctx.effect(() => async () => {
    try { await runtime.learningDispose?.() } finally { await rm(home, { recursive: true, force: true }) }
  }, 'learning recording: temporary files')
  installStore(runtime)
  await runtime.load()
  installMemory(runtime)
  installLearning(runtime)
  const markTurn = id => {
    statusListener({ agent: { id }, status: 'running' })
    statusListener({ agent: { id }, status: 'idle' })
  }
  ctx.effect(() => ctx.tools.register({
    name: 'learning_review_context',
    description: 'Review which declined learning rules the public Writer may read.',
    parameters: { type: 'object', properties: {} },
    output,
    async execute() {
      assert.equal(runtime.botOf('diary').private, true)
      await runtime.learningRun()
      const proposal = runtime.learningView().diary[0]
      await runtime.learningEndpoint('learning-answer', { id: proposal.id, approve: false })
      markTurn('writer')
      await runtime.learningRun()
      markTurn('diary')
      await runtime.learningRun()
      const calls = ctx.get('snapshotLearningRequests').calls
      const publicPrompt = calls.find(call => call.model === 'writer').text
      const ownPrompt = calls.filter(call => call.model === 'diary').at(-1).text
      assert.doesNotMatch(publicPrompt, /private diary marker ALPHA|Legacy ownerless marker/)
      assert.match(ownPrompt, /private diary marker ALPHA/)
      const saved = JSON.parse(await readFile(path, 'utf8'))
      assert.equal(saved.declined.at(-1).botId, 'diary')
      assert.equal(saved.declined[0].name, 'legacy-rule')
      return JSON.stringify({ publicReviewPrompt: publicPrompt, declinedOwners: saved.declined.map(row => row.botId ?? null), ownDeclineRetained: true, legacyDeclineRetainedOnDisk: true }, null, 2)
    },
  }))
}
