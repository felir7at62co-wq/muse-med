/** Keep a real SDK Host alive while its native Skill reviewer finishes between turns. */
import assert from 'node:assert/strict'
import { cp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// The SDK selects a built Host when available; a clean checkout uses its TSX source launcher.
if (!process.execArgv.some(arg => arg.includes('tsx'))) {
  await import('../../../third_party/plugins/muse-skill-evolution/tests/resolve.mjs')
}

const artifact = process.env.MUSE_SKILL_EVOLUTION_PACKAGE
  ? join(process.cwd(), '.dsh', 'muse-skill-evolution') : undefined
if (artifact) await cp(process.env.MUSE_SKILL_EVOLUTION_PACKAGE, artifact, { recursive: true })
const evolution = await import(artifact
  ? pathToFileURL(join(artifact, 'src', 'index.js')).href
  : new URL('../../../third_party/plugins/muse-skill-evolution/src/index.js', import.meta.url).href)

const skillName = 'muse-learned-verify-file'
const skillBody = '# Verify a saved file\n\nAfter writing a file, read it back through the file tool. Compare the saved text with the requested text before claiming completion. Report a mismatch instead of treating a successful write call as content verification.'

/** Scenario identity used by the shipped SDK profile loader. */
export const name = 'snapshot-muse-skill-evolution'
/** Real native services observed by this fixture. */
export const inject = ['commands', 'agents', 'sessions', 'tools', 'skills', 'llm', 'sessionPersistence', 'systemPrompt', 'sandboxPolicy']

/**
 * Observe actual review Sessions and wait without manufacturing proposals or model turns.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated SDK Host context.
 * @returns {Promise<void>} Completion after production learning is active.
 */
export async function apply(ctx) {
  const cwd = process.cwd()
  const childSessions = []
  const childCalls = []
  const childEndings = []
  const rootCalls = []
  const rootResults = []
  let waitCount = 0, reviewRequests = 0, catalogSeen = false, loadedBodySeen = false
  ctx.on('session/created', session => {
    if (session.header.origin === 'subagent') childSessions.push(session)
  })
  ctx.on('session/event', (session, event) => {
    if (session.header.origin === 'subagent' && event.type === 'turn/end') childEndings.push(event.data.reason)
    if (session.header.origin !== 'subagent' && event.type === 'tool/result' && event.data.message.isError !== true) {
      rootResults.push(event.data.message.source.callId)
    }
    if (event.type !== 'tool/call') return
    const calls = session.header.origin === 'subagent' ? childCalls : rootCalls
    calls.push(event.data.name)
  })
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.origin === 'subagent') return
    agent.ctx.tools.restrict({ allow: ['read', 'write', 'skill', 'muse_skill_evolution'], includeOwn: true })
    const permission = ctx.commands.find(agent, 'permission')
    assert.ok(permission, 'The shipped SDK profile must expose its native permission command')
    const handler = async invocation => {
      await waitForReview(invocation.agent)
      return permission.handler(invocation)
    }
    await agent.ctx.plugin({
      name: 'snapshot-evolution-idle-barrier',
      inject: ['commands'],
      apply(inner) {
        inner.effect(() => inner.commands.register({ ...permission, handler }))
      },
    }).await()
    assert.equal(ctx.commands.find(agent, 'permission').handler, handler, 'The idle barrier must wrap the native definition')
  })
  ctx.on('llm/stream', async function* (options, next) {
    assert.equal(options.provider, 'snapshot-evolution')
    assert.equal(options.model, 'learning-fixture')
    const agent = ctx.agents.get(options.sessionId)
    assert.ok(agent)
    if (agent.session.header.origin === 'subagent') {
      reviewRequests += 1
      assert.deepEqual(options.tools ?? [], [], 'Background review cannot execute tools')
      assert.equal(agent.session.header.delegationDepth, 1)
      const input = options.messages.find(message => message.source?.kind === 'muse-skill-evolution')
      assert.ok(input, 'Review evidence must be a persisted native message')
      const evidence = JSON.parse(input.content.find(block => block.type === 'text').text)
      assert.equal(evidence.source.turn, 2, 'Review must refer to the completed tool-using source turn')
      assert.equal(evidence.source.sessionId, agent.session.header.parentSession)
      assert.ok(evidence.work.includes('Tool: write'))
      assert.ok(evidence.work.includes('Tool: read'))
      assert.ok(evidence.work.includes('Tool result: completed'))
      assert.ok(evidence.work.includes('Assistant: VERIFIED_FILE_WRITTEN_AND_READ'))
      assert.ok(!evidence.work.some(line => line.includes('CHAT_ONLY')))
    } else {
      const catalog = options.messages.findLast(message => message.source?.kind === 'skill-catalog')
      if (catalog?.source.entries.some(entry => entry.name === skillName)) catalogSeen = true
      const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'call_load_learned')
      if (result) {
        const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        assert.ok(text.includes(`<skill_instructions>\n${skillBody}\n</skill_instructions>`),
          'The next model request must contain the actual generated Skill body')
        loadedBodySeen = true
      }
    }
    yield* next()
  })
  await ctx.plugin(evolution, evolution.Config({
    home: join(cwd, '.dsh', 'evolution'), skillsRoot: join(cwd, 'skills'),
    idleMs: 0, minToolCalls: 2, maxReviewsPerDay: 1,
  })).await()
  let runtime
  await ctx.inject(['museSkillEvolution'], inner => { runtime = inner.get('museSkillEvolution') }).await()
  async function waitForReview(agent) {
      assert.equal(agent.status, 'idle', 'A standalone command must leave its source Agent idle')
      await runtime.whenIdle()
      waitCount += 1
      if (waitCount === 1) {
        assert.equal(childSessions.length, 0, 'A chat-only turn must not schedule a review')
        assert.deepEqual(rootCalls, [])
        return
      }
      assert.equal(waitCount, 2)
      assert.equal(childSessions.length, 1)
      assert.equal(reviewRequests, 1)
      assert.deepEqual(rootResults, ['call_write_verified', 'call_read_verified'])
      assert.deepEqual(childCalls, [])
      const child = childSessions[0]
      assert.equal(child.header.parentSession, agent.session.id)
      assert.equal(child.requestHeader().tools, undefined, 'A tool-free request omits the native header tools field')
      const reply = child.deriveMessages().findLast(message => message.role === 'assistant')
      assert.ok(reply, `Native review must produce a completed assistant response: ${JSON.stringify(childEndings)}`)
      assert.equal(JSON.parse(reply.content.find(block => block.type === 'text').text).action, 'create')
      const disk = await readFile(join(cwd, 'skills', skillName, 'SKILL.md'), 'utf8')
      assert.ok(disk.includes(skillBody), 'The model proposal must create real Skill bytes')
      const catalog = await ctx.skills.snapshot({ cwd, scope: agent })
      assert.equal(catalog.complete, true)
      assert.ok(catalog.skills.some(skill => skill.name === skillName))
  }
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent.session.header.origin === 'subagent' || !loadedBodySeen) return
    assert.equal(waitCount, 2)
    assert.equal(catalogSeen, true)
    assert.deepEqual(rootCalls, ['write', 'read', 'skill'])
    assert.deepEqual(childCalls, [])
    assert.equal(await readFile(join(cwd, 'verified.txt'), 'utf8'), 'verified content\n')
    await writeFile(join(cwd, 'learning-proof.json'), JSON.stringify({
      chatOnlyReviews: 0, completedToolCalls: 2, nativeReviewSessions: childSessions.length,
      reviewRequests, reviewTools: childCalls.length, sameRoute: true,
      createdSkill: skillName, nextTurnCatalog: catalogSeen, nextTurnLoadedBody: loadedBodySeen,
    }, null, 2) + '\n', { flag: 'wx' })
  })
  ctx.provide('snapshotEvolutionReady', { ready: true })
}
