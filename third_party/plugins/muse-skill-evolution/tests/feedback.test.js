import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createEvolutionStore } from '../src/store.js'
import { Config } from '../src/config.js'
import { mountEvolutionTools } from '../src/tools.js'
import { parseReview } from '../src/reviewer.js'
import { parseFeedback, feedbackIdentity, feedbackFailure, validateFeedbackRecord } from '../src/feedback.js'

const candidate = (overrides = {}) => ({ kind: 'suggestion', title: 'Summarize verification results',
  observed: 'Users need to compare separate save and read results.', expected: 'Show one compact verification summary.',
  steps: ['Save a file and compare the read result.'], acceptance: ['The summary distinguishes saved bytes from a verified match.'], evidenceRefs: [0], ...overrides })
const now = Date.UTC(2026, 0, 2, 12)
const receipt = { id: 'a'.repeat(32), revision: 1, deduplication: 'available' }
const limits = { evidenceCount: 2, submit: true, maxPerDay: 4, now }
const processFixtureTimeoutMs = 60_000

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'muse-learning-feedback-'))
  const stores = new Set(), children = new Set()
  t.after(async () => {
    await Promise.all([...children].map(async ({ child, closed }) => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await closed
    }))
    await Promise.all([...stores].map(store => store.close()))
    await rm(root, { recursive: true, force: true })
  })
  const options = { home: join(root, 'state'), skillsRoot: join(root, 'skills'), writable: () => true,
    maxSkillChars: 8000, maxDescriptionChars: 300, maxSkills: 20, maxRuns: 1000, maxProposals: 200, maxVersions: 1000 }
  const store = createEvolutionStore(options)
  stores.add(store)
  await store.ready()
  const addRun = async (id, source = id) => { const run = { id, state: 'none', source: { sessionId: source }, lines: ['PRIVATE SOURCE EXCERPT'] }; await store.recordRun(run); return run }
  return { root, options, store, addRun, ownStore: store => stores.add(store), ownChild: entry => children.add(entry) }
}

test('legacy review actions stay compatible while feedback-only and combined outputs retain validated evidence references', () => {
  const config = Config({})
  assert.deepEqual(parseReview('{"action":"none"}', config), { action: 'none' })
  const feedback = candidate()
  assert.deepEqual(parseReview(JSON.stringify({ action: 'none', feedback }), config, ['observed']), { action: 'none', feedback })
  const skill = { action: 'create', name: 'muse-learned-verify-result', description: 'Verify saved output', content: 'Read saved bytes before reporting a match.', why: 'A result was checked.' }
  assert.deepEqual(parseReview(JSON.stringify({ ...skill, feedback }), config, ['observed']), { ...skill, feedback })
  const result = parseReview(JSON.stringify({ ...skill, feedback: candidate({ observed: 'password=private-value' }) }), config, ['observed'])
  assert.deepEqual(result, { ...skill, feedbackProblem: { state: 'rejected', code: 'invalid-feedback' } })
  assert.doesNotMatch(JSON.stringify(result), /private-value/)
})

test('parsed Skill validation failures return only a safe rejection and independent feedback', () => {
  const config = Config({}), feedback = candidate()
  const skill = { action: 'create', name: 'muse-learned-verify-result', description: 'Verify saved output', content: 'Read saved bytes before reporting a match.', why: 'A result was checked.' }
  for (const [invalid, code] of [[{ action: 'delete' }, 'invalid-skill-action'], [{ action: null }, 'invalid-skill-action'],
    [{ name: 'manual-skill' }, 'invalid-skill-name'], [{ name: 'Invalid-Name' }, 'invalid-skill-name'],
    [{ name: 'muse-learned-' + 'x'.repeat(128) }, 'invalid-skill-name'],
    [{ description: '' }, 'invalid-skill-text'], [{ content: null }, 'invalid-skill-text'],
    [{ content: 'x'.repeat(config.contentMaxChars + 1) }, 'invalid-skill-text'],
    [{ why: 'password=private-proposal-value' }, 'invalid-skill-text'], [{ content: 'Invalid\0text' }, 'invalid-skill-text']]) {
    const result = parseReview(JSON.stringify({ ...skill, ...invalid, feedback }), config, ['observed work'])
    assert.deepEqual(result, { action: 'rejected', code, feedback })
    assert.doesNotMatch(JSON.stringify(result), /private-proposal-value|manual-skill|Invalid-Name/)
  }
  assert.deepEqual(parseReview(JSON.stringify({ ...skill, name: 'manual-skill' }), config), { action: 'rejected', code: 'invalid-skill-name' })
  assert.deepEqual(parseReview(JSON.stringify({ ...skill, name: 'manual-skill', feedback: { ...feedback, evidenceRefs: [1] } }), config, ['observed work']),
    { action: 'rejected', code: 'invalid-skill-name', feedbackProblem: { state: 'rejected', code: 'invalid-feedback' } })
})

test('malformed JSON and non-object reviews still fail as a whole rather than recovering partial feedback', () => {
  const feedback = candidate()
  for (const text of ['{', JSON.stringify([{ action: 'none', feedback }]), 'null', '42', JSON.stringify(JSON.stringify({ action: 'none', feedback }))]) {
    assert.throws(() => parseReview(text, Config({}), ['observed work']))
  }
})

test('feedback rejects malformed evidence, transcript excerpts, private locations, sensitive text and command payloads', () => {
  for (const feedback of [null, candidate({ evidenceRefs: [2] }), candidate({ evidenceRefs: [-1] }), candidate({ evidenceRefs: [0, 0] }),
    candidate({ evidenceRefs: [] }), candidate({ acceptance: [] }), candidate({ title: 'x'.repeat(121) }), candidate({ observed: 'User: copied conversation' }),
    candidate({ observed: 'The file is /Users/person/private/report.txt' }), candidate({ observed: 'Save to C:\\Users\\person\\report.txt' }),
    candidate({ observed: 'Email person@example.com' }), candidate({ observed: 'Bearer private-access' }), candidate({ observed: 'Run sudo rm files' }),
    candidate({ observed: 'Run `some command`' }), candidate({ expected: 'x'.repeat(6000) }), candidate({ surprise: 'unreviewed' })]) {
    assert.throws(() => parseFeedback(feedback, 2), /invalid|limit/)
  }
  assert.deepEqual(feedbackFailure({ code: 'muse-feedback/account-changed' }), { state: 'unknown', code: 'account-changed' })
  assert.deepEqual(feedbackFailure({ code: 'muse-feedback/request-conflict' }), { state: 'rejected', code: 'request-conflict' })
  assert.deepEqual(feedbackFailure({ code: 'private-server-diagnostic' }), { state: 'unknown', code: 'unavailable' })
})

test('exact normalized content identity excludes Session and evidence position but binds the complete sent summary', () => {
  const first = feedbackIdentity(candidate(), 'first-session')
  const second = feedbackIdentity(candidate({ evidenceRefs: [1] }), 'second-session')
  assert.equal(first.hash, second.hash)
  assert.equal(first.requestId, second.requestId)
  assert.notEqual(first.request.sessionId, second.request.sessionId)
  assert.equal(first.request.includeDiagnostics, false)
  assert.match(first.request.text, /not independently reproduced/)
  assert.doesNotMatch(first.request.text, /PRIVATE|evidenceRefs|first-session/)
  assert.notEqual(first.hash, feedbackIdentity(candidate({ expected: 'A different observable result.' }), 'first-session').hash)
})

test('two stores atomically reserve a single original POST and stale run writes retain the durable intent and receipt', async t => {
  const f = await fixture(t)
  const staleRecords = [await f.addRun('first', 'source-first'), await f.addRun('second', 'source-second')]
  const other = createEvolutionStore(f.options); f.ownStore(other); await other.ready()
  const results = await Promise.all([f.store.claimFeedback('first', candidate(), limits), other.claimFeedback('second', candidate({ evidenceRefs: [1] }), limits)])
  assert.equal(results.filter(result => result.send).length, 1)
  const senderIndex = results.findIndex(result => result.send), sender = ['first', 'second'][senderIndex]
  const claimant = [f.store, other][senderIndex]
  const disk = JSON.parse(await readFile(join(f.options.home, 'state.json'), 'utf8'))
  assert.equal(disk.runs[sender].feedback.state, 'sending')
  const duplicate = ['first', 'second'].find(id => id !== sender)
  assert.equal(disk.runs[duplicate].feedback.state, 'duplicate')
  assert.equal(disk.runs[duplicate].feedback.duplicateOf, sender)
  await claimant.settleFeedback(sender, results[senderIndex].feedback.hash, { state: 'submitted', receipt }, now + 1)
  await f.store.recordRun({ ...staleRecords[senderIndex], state: 'applied' })
  const retained = f.store.runs().find(run => run.id === sender).feedback
  assert.equal(retained.state, 'submitted'); assert.deepEqual(retained.receipt, receipt)
})

test('independent Host processes share the same exact-content claim', { timeout: processFixtureTimeoutMs }, async t => {
  const f = await fixture(t); await f.addRun('first'); await f.addRun('second')
  const source = `import {createEvolutionStore} from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)}; const [options,id,candidate,limits]=JSON.parse(process.argv[1]); const store=createEvolutionStore({...options,writable:()=>true}); try { await store.ready(); process.stdout.write(JSON.stringify(await store.claimFeedback(id,candidate,limits))); } finally { await store.close(); }`
  const run = id => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', new URL('./resolve.mjs', import.meta.url).href, '--input-type=module', '--eval', source,
      JSON.stringify([f.options, id, candidate(), limits])], { stdio: ['ignore', 'pipe', 'pipe'] })
    const closed = new Promise(resolve => { child.once('close', resolve) })
    f.ownChild({ child, closed })
    let output = '', error = ''
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { error += bytes })
    child.on('error', reject); child.on('close', (code, signal) => code === 0 && signal === null ? resolve(JSON.parse(output)) : reject(new Error(`fixture child ${code}/${signal}: ${error}`)))
  })
  const completed = await Promise.allSettled([run('first'), run('second')])
  const results = completed.map(result => { if (result.status === 'rejected') throw result.reason; return result.value })
  assert.equal(results.filter(result => result.send).length, 1)
  await f.store.ready(); assert.equal(f.store.runs().filter(run => run.feedback.state === 'duplicate').length, 1)
})

test('restart records uncertainty without retry and late original receipts can settle the same intent', async t => {
  const f = await fixture(t); await f.addRun('first')
  const claim = await f.store.claimFeedback('first', candidate(), limits)
  await f.store.close()
  const restarted = createEvolutionStore(f.options); f.ownStore(restarted); await restarted.ready(); await restarted.recoverFeedback()
  assert.equal(restarted.runs()[0].feedback.state, 'unknown')
  await restarted.recordRun({ id: 'later', state: 'none', source: { sessionId: 'later-source' } })
  const later = await restarted.claimFeedback('later', candidate(), { ...limits, now: now + 86_400_000 })
  assert.equal(later.send, false); assert.equal(later.feedback.state, 'duplicate')
  const settled = await restarted.settleFeedback('first', claim.feedback.hash, { state: 'submitted', receipt }, now + 2)
  assert.equal(settled.state, 'submitted'); assert.equal(settled.code, undefined)
  await assert.rejects(restarted.settleFeedback('first', claim.feedback.hash, { state: 'unknown', code: 'unconfirmed' }, now + 3), /outstanding/)
})

test('attempt quotas include unknowns while disabled and limited candidates remain retained without later automatic submission', async t => {
  const f = await fixture(t); await f.addRun('first'); await f.addRun('second'); await f.addRun('disabled')
  const first = await f.store.claimFeedback('first', candidate(), { ...limits, maxPerDay: 1 })
  await f.store.settleFeedback('first', first.feedback.hash, { state: 'unknown', code: 'unconfirmed' }, now + 1)
  const secondCandidate = candidate({ title: 'A different product issue' })
  const second = await f.store.claimFeedback('second', secondCandidate, { ...limits, maxPerDay: 1 })
  assert.equal(second.send, false); assert.equal(second.feedback.state, 'limited')
  assert.equal((await f.store.claimFeedback('second', secondCandidate, { ...limits, now: now + 86_400_000 })).send, false)
  const disabledCandidate = candidate({ title: 'A retained proposal' })
  const disabled = await f.store.claimFeedback('disabled', disabledCandidate, { ...limits, submit: false, reason: 'disabled' })
  assert.equal(disabled.feedback.state, 'proposed'); assert.equal(disabled.feedback.attemptedAt, undefined)
  assert.equal((await f.store.claimFeedback('disabled', disabledCandidate, limits)).send, false)
})

test('present malformed or future feedback state fails rather than discarding immutable request history', async t => {
  const f = await fixture(t); await f.addRun('first')
  const claim = await f.store.claimFeedback('first', candidate(), limits)
  const file = join(f.options.home, 'state.json'), original = await readFile(file, 'utf8')
  for (const feedback of [null, { ...claim.feedback, version: 2 }, { ...claim.feedback, hash: '0'.repeat(64) },
    { ...claim.feedback, request: { ...claim.feedback.request, includeDiagnostics: true } },
    { ...claim.feedback, candidate: { ...candidate(), evidenceRefs: [10] } }, { ...claim.feedback, state: 'submitted' }]) {
    const state = JSON.parse(original); state.runs.first.feedback = feedback; await writeFile(file, JSON.stringify(state))
    const invalid = createEvolutionStore(f.options)
    await assert.rejects(invalid.ready(), /feedback/i); await invalid.close()
  }
  await writeFile(file, original)
  validateFeedbackRecord(claim.feedback)
})


test('read-only management retains both earlier parse rejections and confirmed receipts without exposing source excerpts', async t => {
  const f = await fixture(t); await f.addRun('first'); await f.addRun('second')
  const claim = await f.store.claimFeedback('first', candidate(), limits)
  await f.store.settleFeedback('first', claim.feedback.hash, { state: 'submitted', receipt }, now + 1)
  await f.store.recordRun({ id: 'second', state: 'none', source: { sessionId: 'second' }, lines: ['PRIVATE SOURCE EXCERPT'],
    feedbackProblem: { state: 'rejected', code: 'invalid-feedback' } })
  await f.addRun('newest')
  let tool
  const ctx = { tools: { register(value) { tool = value } }, sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) } }
  mountEvolutionTools(ctx, f.store, { outputMaxChars: 24000, enabled: true, autoApplyOwned: true, maxReviewsPerDay: 4, autoSubmitFeedback: true, maxFeedbackPerDay: 4 })
  const result = await tool.execute({ action: 'feedback' }, { agent: { session: { id: 'reader' } } })
  assert.equal(result.total, 2)
  assert.equal(result.items[0].feedback.state, 'submitted')
  assert.deepEqual(result.items[1].feedbackProblem, { state: 'rejected', code: 'invalid-feedback' })
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE SOURCE EXCERPT/)
  const status = await tool.execute({ action: 'status' }, {})
  assert.deepEqual(status.data.feedbackStates, { submitted: 1, rejected: 1 })
})
