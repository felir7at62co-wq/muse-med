/** Observe native idle learning and the production account client's private inbox delivery. */
import assert from 'node:assert/strict'
import { cp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyLoopbackServerEffect } from '../../session/loopback-fixture-server.mjs'
import { advanceReviewClock } from './clock.mjs'

const built = !process.execArgv.some(arg => arg.includes('tsx'))
if (process.env.DSH_EXAMPLE_MODE === 'lib') assert.equal(built, true, 'The built lane must not fall back to a TSX source Host')
if (built) await import('../../../third_party/plugins/muse-skill-evolution/tests/resolve.mjs')
const account = await import(new URL(built
  ? '../../../packages/host/muse-account/lib/index.js'
  : '../../../packages/host/muse-account/src/index.ts', import.meta.url).href)
const { writeMuseSession } = await import(new URL(built
  ? '../../../packages/host/muse-account/lib/types/session.js'
  : '../../../packages/host/muse-account/src/session.ts', import.meta.url).href)
const artifact = process.env.MUSE_SKILL_EVOLUTION_PACKAGE
  ? join(process.cwd(), '.dsh', 'muse-skill-evolution') : undefined
if (artifact) await cp(process.env.MUSE_SKILL_EVOLUTION_PACKAGE, artifact, { recursive: true })
const evolution = await import(artifact
  ? pathToFileURL(join(artifact, 'src', 'index.js')).href
  : new URL('../../../third_party/plugins/muse-skill-evolution/src/index.js', import.meta.url).href)

const cookie = '__Host-muse=skill-feedback-fixture-only'
const username = 'skill-feedback-fixture'
const receiptId = '82000000000040008000000000000001'
const skillName = 'muse-learned-verify-file'
const skillBody = '# Verify a saved file\n\nAfter writing a file, read it back through the file tool. Compare the saved text with the requested text before claiming completion. Report a mismatch instead of treating a successful write call as content verification.'

/** Scenario identity loaded by the shipped SDK profile. */
export const name = 'snapshot-muse-skill-feedback'
/** Native services used by the real account client and idle reviewer. */
export const inject = ['commands', 'agents', 'sessions', 'tools', 'skills', 'llm', 'sessionPersistence',
  'systemPrompt', 'sandboxPolicy', 'sessionProjections', 'agentDefaultModel']

/**
 * Retain native model turns, Skill publication and account delivery while replacing the external inbox.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated SDK Host context.
 * @returns {Promise<void>} Completion after the production services are mounted.
 */
export async function apply(ctx) {
  const cwd = process.cwd()
  const reviews = [], reviewCalls = [], rootCalls = [], completedCalls = []
  const submissions = [], records = new Map()
  let baseUrl, rejected, rootSession, runtime, rootRoute
  let waits = 0, reviewRequests = 0, catalogSeen = false, loadedBodySeen = false

  await applyLoopbackServerEffect(ctx, {
    label: 'snapshot-skill-feedback-inbox',
    onCleanup() {},
    onListening(address) { baseUrl = `http://127.0.0.1:${address.port}` },
    requestListener(request, response) {
      let body = ''
      request.on('data', chunk => { body += chunk.toString('utf8') })
      request.once('end', () => {
        const send = (status, value) => {
          response.writeHead(status, { 'content-type': 'application/json' })
          response.end(JSON.stringify(value))
        }
        try {
          assert.equal(request.headers.cookie, cookie)
          if (request.url === '/api/desktop-models/providers') { send(200, { providers: [] }); return }
          if (request.url === '/api/muse.account') { send(200, { username }); return }
          if (request.url === '/api/muse.activity') { response.writeHead(204); response.end(); return }
          assert.equal(request.url, '/api/muse.feedback')
          assert.equal(request.method, 'POST')
          assert.equal(request.headers.origin, baseUrl)
          const input = JSON.parse(body)
          assert.equal(input.category, 'suggestion')
          assert.equal(input.title, 'Summarize file verification')
          assert.match(input.requestId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)
          assert.ok(input.body.includes(rootSession.id), 'The account client must submit from the real source Session')
          assert.ok(input.body.includes('The task needed a write and a read before completion could be checked.'))
          assert.ok(!input.body.includes('Related user request'))
          assert.ok(!input.body.includes('Related assistant answer'))
          assert.ok(!input.body.includes('verified content'))
          assert.ok(!body.includes(cookie))
          submissions.push(input)
          const previous = records.get(input.requestId)
          if (previous) {
            assert.equal(previous.title, input.title)
            assert.equal(previous.body, input.body)
            assert.equal(previous.category, input.category)
            send(201, previous)
            return
          }
          const record = { ...input, id: receiptId, username, revision: 1 }
          records.set(input.requestId, record)
          send(201, record)
        } catch (error) {
          rejected = error
          if (!response.headersSent) send(500, { error: 'Skill feedback fixture mismatch' })
          else response.end()
        }
      })
    },
  })
  const accountHome = join(cwd, '.dsh', 'feedback-account')
  await writeMuseSession(join(accountHome, 'session.json'), { baseUrl, username, cookie })
  await ctx.plugin(account, account.Config({ baseUrl, accountHome, feedbackTools: true })).await()

  ctx.on('session/created', session => {
    if (session.header.origin === 'subagent') reviews.push(session)
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/call') {
      const calls = session.header.origin === 'subagent' ? reviewCalls : rootCalls
      calls.push(event.data.name)
    } else if (session.header.origin !== 'subagent' && event.type === 'tool/result' && event.data.message.isError !== true) {
      completedCalls.push(event.data.message.source.callId)
    }
  })
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.origin === 'subagent') return
    rootSession = agent.session
    agent.ctx.tools.restrict({ allow: ['read', 'write', 'skill', 'muse_skill_evolution'], includeOwn: true })
    const permission = ctx.commands.find(agent, 'permission')
    assert.ok(permission, 'The SDK profile must expose its native permission command')
    const handler = async invocation => {
      await waitForReviews(invocation.agent)
      return permission.handler(invocation)
    }
    await agent.ctx.plugin({
      name: 'snapshot-skill-feedback-idle-barrier',
      inject: ['commands'],
      apply(inner) { inner.effect(() => inner.commands.register({ ...permission, handler })) },
    }).await()
    assert.equal(ctx.commands.find(agent, 'permission').handler, handler)
  })
  ctx.on('llm/stream', async function* (options, next) {
    assert.equal(options.provider, 'snapshot-skill-feedback')
    assert.equal(options.model, 'learning-feedback-fixture')
    const agent = ctx.agents.get(options.sessionId)
    assert.ok(agent)
    assert.ok(!JSON.stringify(options.messages).includes(cookie))
    const route = { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort }
    if (agent.session.header.origin === 'subagent') {
      reviewRequests += 1
      assert.deepEqual(route, rootRoute, 'The review must retain the source model route and thinking effort')
      assert.deepEqual(options.tools ?? [], [], 'The reviewer cannot submit feedback or execute any tool')
      assert.equal(agent.session.header.delegationDepth, 1)
      const input = options.messages.find(message => message.source?.kind === 'muse-skill-evolution')
      assert.ok(input, 'Review evidence must be a persisted native message')
      const evidence = JSON.parse(input.content.find(block => block.type === 'text').text)
      assert.equal(evidence.source.turn, reviewRequests + 1)
      assert.equal(evidence.source.sessionId, agent.session.header.parentSession)
      assert.ok(evidence.work.includes('Tool: write'))
      assert.ok(evidence.work.includes('Tool: read'))
      assert.ok(evidence.work.includes('Tool result: completed'))
      assert.ok(evidence.work[0].includes('compact verification summary'))
      assert.ok(!evidence.work.some(line => line.includes('CHAT_ONLY')))
    } else {
      rootRoute ??= route
      assert.deepEqual(route, rootRoute)
      const catalog = options.messages.findLast(message => message.source?.kind === 'skill-catalog')
      if (catalog?.source.entries.some(entry => entry.name === skillName)) catalogSeen = true
      const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'call_load_learned')
      if (result) {
        const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        assert.ok(text.includes(`<skill_instructions>\n${skillBody}\n</skill_instructions>`))
        loadedBodySeen = true
      }
    }
    yield* next()
  })
  await ctx.plugin(evolution, evolution.Config({
    home: join(cwd, '.dsh', 'evolution'), skillsRoot: join(cwd, 'skills'),
    idleMs: 0, minToolCalls: 2, maxReviewsPerDay: 2, autoSubmitFeedback: true, maxFeedbackPerDay: 2,
  })).await()
  await ctx.inject(['museSkillEvolution'], inner => { runtime = inner.get('museSkillEvolution') }).await()

  async function waitForReviews(agent) {
    assert.equal(agent.status, 'idle')
    await runtime.whenIdle()
    if (rejected) throw rejected
    waits += 1
    assert.ok(waits <= 3)
    if (waits === 1) {
      assert.equal(reviews.length, 0, 'A chat-only turn must not schedule a review')
      assert.deepEqual(submissions, [])
      return
    }
    assert.equal(reviews.length, waits - 1)
    assert.equal(reviewRequests, waits - 1)
    assert.deepEqual(reviewCalls, [])
    for (const session of [rootSession, ...reviews]) {
      assert.ok(!JSON.stringify(session.snapshotEvents()).includes(cookie), 'Credentials cannot enter Session data')
    }
    assert.equal(submissions.length, 1, 'The second exact product candidate must not issue another POST')
    assert.equal(records.size, 1)
    const runs = runtime.store.runs()
    assert.equal(runs.length, waits - 1)
    assert.equal(runs.filter(run => run.feedback?.state === 'submitted').length, 1)
    assert.equal(runs.find(run => run.feedback?.state === 'submitted').feedback.receipt.id, receiptId)
    if (waits === 3) assert.equal(runs.filter(run => run.feedback?.state === 'duplicate').length, 1)
    const disk = await readFile(join(cwd, 'skills', skillName, 'SKILL.md'), 'utf8')
    assert.ok(disk.includes(skillBody), 'The reviewed Skill must be real saved Markdown')
    const catalog = await ctx.skills.snapshot({ cwd, scope: agent })
    assert.equal(catalog.complete, true)
    assert.ok(catalog.skills.some(skill => skill.name === skillName))
    for (const child of reviews) {
      assert.equal(child.requestHeader().tools, undefined)
      assert.equal(child.header.parentSession, agent.session.id)
    }
    if (waits === 2) advanceReviewClock()
  }

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent.session.header.origin === 'subagent' || !loadedBodySeen) return
    if (rejected) throw rejected
    assert.equal(waits, 3)
    assert.equal(catalogSeen, true)
    assert.deepEqual(rootCalls, ['write', 'read', 'write', 'read', 'skill'])
    assert.deepEqual(completedCalls, ['call_write_verified', 'call_read_verified',
      'call_write_verified_again', 'call_read_verified_again', 'call_load_learned'])
    assert.deepEqual(reviewCalls, [])
    assert.equal(await readFile(join(cwd, 'verified.txt'), 'utf8'), 'verified content\n')
    assert.equal(await readFile(join(cwd, 'verified-again.txt'), 'utf8'), 'verified content\n')
    await writeFile(join(cwd, 'learning-feedback-proof.json'), JSON.stringify({
      chatOnlyReviews: 0, completedTaskToolCalls: 4, nativeReviewSessions: reviews.length,
      reviewRequests, reviewTools: reviewCalls.length, sameRoute: true,
      createdSkill: skillName, nextTurnCatalog: catalogSeen, nextTurnLoadedBody: loadedBodySeen,
      feedbackSubmissions: submissions.length, feedbackRecords: records.size, receiptId,
      repeatedCandidatePosts: 0, localFeedbackStates: ['duplicate', 'submitted'],
      diagnosticsIncluded: false, credentialsLogged: false,
    }, null, 2) + '\n', { flag: 'wx' })
  })
  ctx.provide('snapshotSkillFeedbackReady', { ready: true })
}
