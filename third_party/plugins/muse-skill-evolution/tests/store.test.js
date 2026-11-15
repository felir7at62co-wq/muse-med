import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink, stat } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { createEvolutionStore } from '../src/store.js'
import { mountEvolutionProvider } from '../src/provider.js'
import { mountEvolutionTools } from '../src/tools.js'
import { assertSkillWriteAllowed } from '../src/permissions.js'

const proposal = (overrides = {}) => ({ action: 'create', name: 'verify-file', description: 'Verify saved file contents.',
  content: '# Verify\n\nRead the saved file before reporting completion.', why: 'A successful write needs a content check.',
  source: { sessionId: 'source-session', turn: 1, fromSeq: 2, throughSeq: 8 }, reviewSessionId: 'review-session', ...overrides })
async function fixture(t, io, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'muse-learning-test-'))
  const cleanup = []
  t.after(async () => { for (const dispose of cleanup.reverse()) await dispose(); await rm(directory, { recursive: true, force: true }) })
  const options = { home: join(directory, 'state'), skillsRoot: join(directory, 'skills'), writable: () => true,
    maxSkillChars: 8000, maxDescriptionChars: 300, maxSkills: 20, maxRuns: 1000, maxProposals: 200, maxVersions: 1000, ...overrides }
  const store = createEvolutionStore(options, io)
  cleanup.push(() => store.close())
  await store.ready()
  return { store, options, directory, cleanup }
}
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const originalText = '---\nname: muse-learned-verify-file\ndescription: "Verify saved file contents."\n---\n\n# Verify\n\nRead the saved file before reporting completion.\n'

async function interrupted(t) {
  let failing = false
  const io = { async writeAtomic(path, text, options) {
    if (failing && path.endsWith('state.json')) { failing = false; throw new Error('fixture index commit interrupted') }
    return writeFileAtomic(path, text, options)
  } }
  const f = await fixture(t, io)
  const candidate = await f.store.addProposal(proposal())
  failing = true
  await assert.rejects(f.store.apply(candidate.id), /fixture index commit interrupted/)
  assert.ok(await readFile(join(f.options.home, 'transaction.json'), 'utf8'))
  await f.store.close()
  return { ...f, candidate }
}

test('creates one owned Skill, host frontmatter, immutable version and stable applied receipt', async t => {
  const { store, options } = await fixture(t)
  const candidate = await store.addProposal(proposal())
  const applied = await store.apply(candidate.id)
  assert.equal(applied.state, 'applied')
  assert.equal(applied.name, 'muse-learned-verify-file')
  assert.equal(await readFile(applied.path, 'utf8'), originalText)
  assert.equal((await store.apply(candidate.id)).versionId, applied.versionId)
  const versions = store.history(applied.name)
  assert.equal(versions.length, 1)
  assert.equal(versions[0].sha256, applied.sha256)
  assert.deepEqual(versions[0].source, proposal().source)
  assert.equal(versions[0].reviewSessionId, 'review-session')
  assert.equal((await readJson(join(options.home, 'versions', `${applied.versionId}.json`))).fileText, originalText)
  if (process.platform !== 'win32') assert.equal((await stat(applied.path)).mode & 0o777, 0o600)
})

test('updates only the previous write hash and rollback creates a new version', async t => {
  const { store } = await fixture(t)
  const created = await store.apply((await store.addProposal(proposal())).id)
  const update = await store.addProposal(proposal({ action: 'update', name: created.name, baseHash: created.sha256, content: '# Updated\n\nCheck saved bytes and report mismatches.' }))
  assert.equal((await store.apply(update.id, { baselineHash: '0'.repeat(64) })).state, 'blocked')
  const updated = await store.apply(update.id, { baselineHash: created.sha256 })
  assert.equal(updated.state, 'applied')
  assert.equal((await store.undo(created.name, { baselineHash: created.sha256, versionId: created.versionId })).state, 'blocked')
  const restored = await store.undo(created.name, { baselineHash: updated.sha256, versionId: created.versionId })
  assert.equal(restored.state, 'applied')
  assert.notEqual(restored.versionId, created.versionId)
  assert.equal(restored.sha256, created.sha256)
  assert.equal(store.history(created.name).length, 3)
  assert.equal(store.history(created.name)[2].restoredFrom, created.versionId)
})

test('manual edits and unrelated Skills stay untouched and remain reviewable proposals', async t => {
  const { store, options } = await fixture(t)
  const created = await store.apply((await store.addProposal(proposal())).id)
  await writeFile(created.path, '---\nname: user-controlled\n---\n\nUser edits.')
  const update = await store.addProposal(proposal({ action: 'update', name: created.name, baseHash: created.sha256 }))
  assert.equal((await store.apply(update.id)).state, 'blocked')
  assert.equal(store.get(update.id).state, 'blocked')
  assert.match(await readFile(created.path, 'utf8'), /User edits/)
  assert.equal((await store.catalog())[0].owned, false)
  assert.equal((await store.catalog())[0].content, '')
  const external = await store.addProposal(proposal({ action: 'update', name: 'project-existing', baseHash: 'a'.repeat(64) }))
  assert.equal((await store.apply(external.id)).state, 'blocked')
  assert.equal(store.get(external.id).name, 'project-existing')
  const collision = join(options.skillsRoot, 'muse-learned-collision')
  await mkdir(collision); await writeFile(join(collision, 'asset.txt'), 'user asset')
  const candidate = await store.addProposal(proposal({ name: 'collision' }))
  assert.equal((await store.apply(candidate.id)).state, 'blocked')
  assert.deepEqual(await readdir(collision), ['asset.txt'])
})

test('finishes an interrupted Skill/index transaction once after restart', async t => {
  const f = await interrupted(t)
  const restarted = createEvolutionStore(f.options); t.after(() => restarted.close())
  await restarted.ready()
  assert.equal(restarted.get(f.candidate.id).state, 'applied')
  assert.equal(restarted.history(f.candidate.name).length, 1)
  assert.equal((await restarted.apply(f.candidate.id)).state, 'applied')
  assert.equal(restarted.history(f.candidate.name).length, 1)
  await assert.rejects(readFile(join(f.options.home, 'transaction.json')), { code: 'ENOENT' })
})

test('recovery preserves a user edit made after an interrupted file write', async t => {
  const f = await interrupted(t)
  const path = join(f.options.skillsRoot, f.candidate.name, 'SKILL.md')
  await writeFile(path, 'User-owned correction after crash.')
  const restarted = createEvolutionStore(f.options); t.after(() => restarted.close())
  await restarted.ready()
  assert.equal(restarted.get(f.candidate.id).state, 'blocked')
  assert.equal(restarted.state().lastRecovery.state, 'blocked')
  assert.equal(restarted.history(f.candidate.name).length, 0)
  assert.equal(await readFile(path, 'utf8'), 'User-owned correction after crash.')
})

test('two stores reload the locked index and retain all concurrent proposals and versions', async t => {
  const { store, options } = await fixture(t)
  const second = createEvolutionStore(options); t.after(() => second.close())
  await second.ready()
  const candidates = await Promise.all(Array.from({ length: 12 }, (_, n) => (n % 2 ? second : store).addProposal(proposal({ name: `check-${n}` }))))
  await Promise.all(candidates.map((candidate, n) => (n % 2 ? store : second).apply(candidate.id)))
  await store.ready(); await second.ready()
  assert.equal(store.proposals().length, 12)
  assert.equal((await second.catalog()).length, 12)
  assert.equal((await readJson(join(options.home, 'state.json'))).revision, 24)
})

test('independent Host processes coordinate writes through the same private index', { timeout: 15_000 }, async t => {
  const { store, options, cleanup } = await fixture(t)
  const childCode = `
    import { once } from 'node:events'
    import { createEvolutionStore } from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)}
    const options = JSON.parse(process.argv[1]), prefix = process.argv[2]
    const store = createEvolutionStore({ ...options, writable: () => true })
    const start = once(process, 'message'); process.send('ready'); await start
    try {
      for (let n = 0; n < 2; n++) {
        const proposal = await store.addProposal({ action: 'create', name: prefix + '-' + n, description: 'Verify outputs.', content: 'Read outputs before claiming completion.', why: 'Verify evidence.', source: {} })
        await store.apply(proposal.id)
      }
    } finally { await store.close(); process.disconnect() }
  `
  const children = ['first', 'second'].map(prefix => {
    const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./resolve.mjs', import.meta.url)), '--input-type=module', '-e', childCode,
      JSON.stringify(options), prefix], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let stderr = ''; child.stderr.on('data', data => { stderr += data })
    const exited = once(child, 'exit')
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited })
    const ready = Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Host exited before ready: ' + stderr) })])
    return { child, exited, ready, stderr: () => stderr }
  })
  await Promise.all(children.map(child => child.ready))
  for (const { child } of children) child.send('start')
  for (const child of children) assert.deepEqual(await child.exited, [0, null], child.stderr())
  await store.ready()
  assert.equal(store.proposals().length, 4)
  assert.equal((await store.catalog()).length, 4)
})

test('corrupt, future and missing persisted indexes fail instead of resetting ownership', async t => {
  const { store, options } = await fixture(t)
  const made = await store.apply((await store.addProposal(proposal())).id)
  const saved = await readFile(join(options.home, 'state.json'), 'utf8')
  for (const invalid of ['{broken', JSON.stringify({ ...JSON.parse(saved), version: 999 }), JSON.stringify({ ...JSON.parse(saved), versions: {} })]) {
    await writeFile(join(options.home, 'state.json'), invalid)
    await assert.rejects(store.ready())
    assert.equal(await readFile(join(options.home, 'state.json'), 'utf8'), invalid)
  }
  await writeFile(join(options.home, 'state.json'), saved)
  await rm(join(options.home, 'state.json'))
  const restarted = createEvolutionStore(options); t.after(() => restarted.close())
  await assert.rejects(restarted.ready(), /index is missing/)
  assert.equal(await readFile(made.path, 'utf8'), originalText)
})

test('future and traversal journals fail without writing outside the generated directory', async t => {
  const f = await interrupted(t)
  const original = await readJson(join(f.options.home, 'transaction.json'))
  for (const altered of [{ ...original, version: 999 }, { ...original, entry: { ...original.entry, id: '../escape' } }]) {
    await writeFile(join(f.options.home, 'transaction.json'), JSON.stringify(altered))
    const restarted = createEvolutionStore(f.options)
    await assert.rejects(restarted.ready(), /Invalid or future Skill transaction/)
    await restarted.close()
  }
})

test('disabled writes, invalid names and prototype keys never change Skill files', async t => {
  const { store, options } = await fixture(t, undefined, { writable: () => false })
  const candidate = await store.addProposal(proposal())
  assert.equal((await store.apply(candidate.id)).state, 'blocked')
  await assert.rejects(readFile(join(options.skillsRoot, candidate.name, 'SKILL.md')), { code: 'ENOENT' })
  await assert.rejects(store.addProposal(proposal({ name: '../AGENTS' })), /Invalid/)
  assert.equal(store.get('__proto__'), undefined)
  assert.deepEqual(store.history('__proto__'), [])
  await assert.rejects(store.apply('__proto__'), /Unknown/)
  await assert.rejects(store.reject('__proto__'), /Unknown/)
  await store.close()
  await assert.rejects(store.addProposal(proposal()), /closed/)
})

test('symlinked Skill bundles are not adopted', { skip: process.platform === 'win32' && 'symlink creation requires Windows privileges' }, async t => {
  const { store, options, directory } = await fixture(t)
  await mkdir(options.skillsRoot)
  await symlink(directory, join(options.skillsRoot, 'muse-learned-linked'), 'dir')
  const linked = await store.addProposal(proposal({ name: 'linked' }))
  await assert.rejects(store.apply(linked.id), /symbolic link/)
  assert.equal((await readdir(directory)).includes('SKILL.md'), false)
})

test('permission checks use the live Session and physical writable roots without widening', { skip: process.platform === 'win32' && 'symlink creation requires Windows privileges' }, async t => {
  const { directory, options } = await fixture(t)
  const session = { id: 'source' }, calls = []
  let mode = 'read-only'
  const ctx = { sandboxPolicy: { resolve(request) { calls.push(request.session); return { mode, workspaceRoot: directory } } } }
  await assert.rejects(assertSkillWriteAllowed(ctx, undefined, options.skillsRoot), /live initiating/)
  await assert.rejects(assertSkillWriteAllowed(ctx, session, options.skillsRoot), /read-only/)
  mode = 'workspace-write'
  await assertSkillWriteAllowed(ctx, session, options.skillsRoot)
  const outside = join(directory, 'escape')
  await symlink(homedir(), outside, 'dir')
  await assert.rejects(assertSkillWriteAllowed(ctx, session, join(outside, 'forbidden-skill')), /outside/)
  mode = 'danger-full-access'
  await assertSkillWriteAllowed(ctx, session, join(outside, 'forbidden-skill'))
  assert.ok(calls.every(item => item === session))
})

test('native Skill registry sees committed creates and updates and detaches on unload', async t => {
  const { store } = await fixture(t)
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SkillRegistry)
  const handle = await ctx.plugin({ name: 'fixture-evolution-provider', inject: ['skills'], apply: scope => mountEvolutionProvider(scope, store) })
  assert.deepEqual(await ctx.skills.list(), [])
  const created = await store.apply((await store.addProposal(proposal())).id)
  assert.equal((await ctx.skills.list())[0].source, 'user-muse')
  assert.equal((await ctx.skills.get(created.name)).content, proposal().content)
  const updated = await store.addProposal(proposal({ action: 'update', name: created.name, baseHash: created.sha256, content: 'Read and compare every saved byte.' }))
  await store.apply(updated.id)
  assert.equal((await ctx.skills.get(created.name)).content, 'Read and compare every saved byte.')
  await handle.dispose()
  assert.deepEqual(await ctx.skills.list(), [])
})

test('management status hides review excerpts and read-only tools retain proposals', async t => {
  const { store } = await fixture(t)
  const candidate = await store.addProposal(proposal())
  await store.recordRun({ id: 'review-run', state: 'queued', lines: ['PRIVATE EXCERPT'], work: ['PRIVATE WORK'], source: { sessionId: 'source' } })
  let definition, mode = 'read-only'
  const ctx = { tools: { register(value) { definition = value } }, sandboxPolicy: { resolve: () => ({ mode }) } }
  mountEvolutionTools(ctx, store, { outputMaxChars: 24000, enabled: true, autoApplyOwned: true, maxReviewsPerDay: 4 })
  const execute = (action, args = {}) => definition.execute({ action, ...args }, { agent: { session: { id: 'source' } } })
  const status = await execute('status')
  assert.equal(status.data.enabled, true)
  assert.equal(status.data.maxReviewsPerDay, 4)
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE/)
  await assert.rejects(execute('apply', { id: candidate.id }), /read-only/)
  await assert.rejects(execute('reject', { id: candidate.id }), /read-only/)
  assert.equal(store.get(candidate.id).state, 'pending')
  mode = 'danger-full-access'
  assert.equal((await execute('apply', { id: candidate.id })).data.state, 'applied')
  assert.equal((await execute('proposals')).items[0].content, undefined)
})

test('review run capacity blocks new IDs but allows existing run settlement', async t => {
  const { store } = await fixture(t, undefined, { maxRuns: 1 })
  await store.recordRun({ id: 'one', state: 'queued' })
  await assert.rejects(store.recordRun({ id: 'two', state: 'queued' }), /review run limit/)
  await store.recordRun({ id: 'one', state: 'none' })
  assert.deepEqual(store.runs(), [{ id: 'one', state: 'none' }])
})

test('proposal capacity preserves existing proposals and still permits rejection', async t => {
  const { store } = await fixture(t, undefined, { maxProposals: 1 })
  const first = await store.addProposal(proposal())
  await assert.rejects(store.addProposal(proposal({ name: 'other' })), /proposal limit/)
  await store.reject(first.id)
  assert.equal(store.proposals().length, 1)
  assert.equal(store.get(first.id).state, 'rejected')
})

test('version capacity blocks apply and undo before any Skill or journal write', async t => {
  const { store, options } = await fixture(t, undefined, { maxVersions: 1 })
  const created = await store.apply((await store.addProposal(proposal())).id)
  const update = await store.addProposal(proposal({ action: 'update', name: created.name, baseHash: created.sha256, content: 'A new body.' }))
  assert.equal((await store.apply(update.id)).state, 'blocked')
  assert.equal(store.get(update.id).state, 'blocked')
  assert.equal((await store.undo(created.name, { versionId: created.versionId, baselineHash: created.sha256 })).state, 'blocked')
  assert.equal(await readFile(created.path, 'utf8'), originalText)
  assert.equal(store.history(created.name).length, 1)
  await assert.rejects(readFile(join(options.home, 'transaction.json')), { code: 'ENOENT' })
})

test('startup never executes a journaled but unwritten Skill modification', async t => {
  let fail = false
  const f = await fixture(t, { async writeAtomic(path, text, options) {
    if (fail && path.endsWith('SKILL.md')) throw new Error('fixture stopped before generated write')
    return writeFileAtomic(path, text, options)
  } })
  const candidate = await f.store.addProposal(proposal())
  fail = true
  await assert.rejects(f.store.apply(candidate.id), /fixture stopped/)
  const interruptedJournal = await readFile(join(f.options.home, 'transaction.json'), 'utf8')
  await f.store.close()
  const restarted = createEvolutionStore(f.options); t.after(() => restarted.close())
  await restarted.ready()
  assert.equal(restarted.get(candidate.id).state, 'blocked')
  assert.equal(restarted.history(candidate.name).length, 0)
  await assert.rejects(readFile(join(f.options.skillsRoot, candidate.name, 'SKILL.md')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(f.options.home, 'transaction.json')), { code: 'ENOENT' })
  const blockedRevision = restarted.state().revision
  await writeFile(join(f.options.home, 'transaction.json'), interruptedJournal)
  await restarted.ready()
  assert.equal(restarted.state().revision, blockedRevision)
  assert.equal(restarted.get(candidate.id).state, 'blocked')
  await assert.rejects(readFile(join(f.options.home, 'transaction.json')), { code: 'ENOENT' })
  assert.equal((await restarted.apply(candidate.id)).state, 'applied')
})

test('an interrupted unwritten rollback records its requested version for review', async t => {
  let fail = false
  const f = await fixture(t, { async writeAtomic(path, text, options) {
    if (fail && path.endsWith('SKILL.md')) throw new Error('fixture rollback stopped')
    return writeFileAtomic(path, text, options)
  } })
  const first = await f.store.apply((await f.store.addProposal(proposal())).id)
  const update = await f.store.addProposal(proposal({ action: 'update', name: first.name, baseHash: first.sha256, content: 'New body.' }))
  const second = await f.store.apply(update.id)
  fail = true
  await assert.rejects(f.store.undo(first.name, { baselineHash: second.sha256, versionId: first.versionId }), /fixture rollback/)
  await f.store.close()
  const restarted = createEvolutionStore(f.options); t.after(() => restarted.close())
  await restarted.ready()
  assert.equal(restarted.state().lastRecovery.restoredFrom, first.versionId)
  assert.equal(restarted.state().lastRecovery.name, first.name)
  assert.equal((await restarted.catalog())[0].content, 'New body.')
  assert.equal(restarted.history(first.name).length, 2)
})
