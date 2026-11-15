/** Private Skill proposals, immutable versions and recoverable file/index transactions. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rm, rmdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { feedbackIdentity, parseFeedback, validateFeedbackRecord } from './feedback.js'

const VERSION = 1
const hash = text => createHash('sha256').update(text).digest('hex')
const clone = value => structuredClone(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const ownedName = name => isSkillName(name) && name.startsWith('muse-learned-') && name.length > 'muse-learned-'.length
const versionId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const own = (value, key) => Object.hasOwn(value, key) ? value[key] : undefined
const validateFeedbackProblem = record => {
  if (Object.hasOwn(record, 'feedbackProblem') && (!object(record.feedbackProblem) || record.feedbackProblem.state !== 'rejected'
    || record.feedbackProblem.code !== 'invalid-feedback' || Object.keys(record.feedbackProblem).length !== 2)) throw new Error('Invalid feedback validation outcome')
}
const render = (name, description, content) => `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${content.trim()}\n`
async function optional(path) {
  try { return await readFile(path, 'utf8') } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}
async function info(path) {
  try { return await lstat(path) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}
function validateState(state) {
  if (!object(state) || state.version !== VERSION) throw new Error('Unsupported Skill evolution state version')
  if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !['skills', 'proposals', 'versions', 'runs'].every(key => object(state[key]))) throw new Error('Invalid Skill evolution state')
  for (const [name, skill] of Object.entries(state.skills)) {
    if (!object(skill) || !ownedName(name) || skill.name !== name || !sha(skill.writeHash) || !Array.isArray(skill.versions)
      || !skill.versions.every(versionId) || !skill.versions.includes(skill.currentVersion)
      || !skill.versions.every(id => state.versions[id]?.name === name)
      || state.versions[skill.currentVersion]?.sha256 !== skill.writeHash) throw new Error('Invalid owned Skill record')
  }
  for (const [id, proposal] of Object.entries(state.proposals)) {
    if (!object(proposal) || proposal.id !== id || !versionId(id) || !isSkillName(proposal.name) || !['create', 'update'].includes(proposal.action)
      || !['pending', 'blocked', 'applied', 'rejected'].includes(proposal.state)
      || typeof proposal.description !== 'string' || typeof proposal.content !== 'string') throw new Error('Invalid Skill proposal record')
  }
  for (const [id, version] of Object.entries(state.versions)) {
    if (!object(version) || version.id !== id || !versionId(id) || !ownedName(version.name) || !sha(version.sha256)
      || typeof version.description !== 'string' || typeof version.content !== 'string'
      || hash(render(version.name, version.description, version.content)) !== version.sha256) throw new Error('Invalid Skill version record')
  }
  for (const [id, record] of Object.entries(state.runs)) {
    if (!object(record) || record.id !== id) throw new Error('Invalid Skill review run')
    validateFeedbackProblem(record)
    if (Object.hasOwn(record, 'feedback')) {
      validateFeedbackRecord(record.feedback)
      if (record.feedback.request.sessionId !== record.source?.sessionId) throw new Error('Feedback source does not match its original run')
    }
    if (record.feedback?.state === 'duplicate' && state.runs[record.feedback.duplicateOf]?.feedback?.hash !== record.feedback.hash) throw new Error('Invalid duplicate feedback reference')
  }
  if (state.root !== undefined && (typeof state.root !== 'string' || !isAbsolute(state.root))) throw new Error('Invalid generated Skill root')
  if (state.lastRecovery !== undefined && (!object(state.lastRecovery) || state.lastRecovery.state !== 'blocked'
    || !ownedName(state.lastRecovery.name) || !versionId(state.lastRecovery.versionId) || typeof state.lastRecovery.reason !== 'string')) throw new Error('Invalid Skill recovery record')
}

/**
 * Create an owned store without touching any global instructions or unrelated Skills.
 * @param {object} options - Private home, generated root, write predicate and validated content limits.
 * @param {object} io - Atomic writer dependency; defaults to the shared filesystem implementation.
 * @returns {object} Serialized storage operations and detached query results.
 */
export function createEvolutionStore(options, io = { writeAtomic: writeFileAtomic }) {
  const { home, skillsRoot, writable, maxSkillChars, maxDescriptionChars, maxSkills, maxRuns, maxProposals, maxVersions } = options
  if (!isAbsolute(home) || !isAbsolute(skillsRoot)) throw new Error('Skill store locations must be absolute')
  if (![maxRuns, maxProposals, maxVersions].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Skill record capacities must be positive safe integers')
  const stateFile = join(home, 'state.json'), journalFile = join(home, 'transaction.json')
  let state = { version: VERSION, revision: 0, skills: {}, proposals: {}, versions: {}, runs: {} }
  let queue = Promise.resolve(), closed = false
  const listeners = new Set()
  const notify = () => { for (const listener of listeners) { try { listener() } catch (_error) { /* Committed state cannot be vetoed by a catalog observer. */ } } }
  const save = async next => { const changed = JSON.stringify(next.skills) !== JSON.stringify(state.skills); await io.writeAtomic(stateFile, JSON.stringify(next), { mode: 0o600, dirMode: 0o700 }); state = next; if (changed) notify() }
  const paths = name => ({ directory: join(skillsRoot, name), file: join(skillsRoot, name, 'SKILL.md') })
  const safeTarget = async name => {
    if (!ownedName(name)) throw new Error('Only plugin-owned muse-learned Skills can be written')
    const root = await info(skillsRoot)
    if (root?.isSymbolicLink() || root && !root.isDirectory()) throw new Error('Generated Skill root must be a regular directory')
    const target = paths(name), directory = await info(target.directory), file = await info(target.file)
    if (directory?.isSymbolicLink() || directory && !directory.isDirectory() || file?.isSymbolicLink() || file && !file.isFile()) throw new Error('Generated Skill path must not contain a symbolic link or special file')
    if (state.root !== undefined && root && await realpath(skillsRoot) !== state.root) throw new Error('Generated Skill root changed')
    return target
  }
  const readOwned = async name => {
    const target = await safeTarget(name), text = await optional(target.file)
    return { ...target, text, currentHash: text === undefined ? null : hash(text) }
  }
  const versionPayload = async id => {
    const text = await optional(join(home, 'versions', `${id}.json`))
    if (text === undefined) throw new Error('Saved Skill version is missing')
    const value = JSON.parse(text)
    if (!object(value)) throw new Error('Saved Skill version is damaged')
    const { fileText: _fileText, ...metadata } = value
    if (!object(value) || value.id !== id || typeof value.fileText !== 'string' || hash(value.fileText) !== value.sha256 || render(value.name, value.description, value.content) !== value.fileText
      || JSON.stringify(metadata) !== JSON.stringify(state.versions[id])
      || state.versions[id]?.sha256 !== value.sha256) throw new Error('Saved Skill version is damaged')
    return value
  }
  const recover = async ({ write = false } = {}) => {
    const text = await optional(journalFile)
    if (text === undefined) return
    const transaction = JSON.parse(text)
    if (!object(transaction) || transaction.version !== VERSION || !ownedName(transaction.name)
      || typeof transaction.fileText !== 'string' || !sha(transaction.targetHash) || hash(transaction.fileText) !== transaction.targetHash
      || !(transaction.expectedHash === null || sha(transaction.expectedHash)) || !object(transaction.entry)
      || !versionId(transaction.entry.id) || transaction.entry.name !== transaction.name || transaction.entry.sha256 !== transaction.targetHash
      || render(transaction.entry.name, transaction.entry.description, transaction.entry.content) !== transaction.fileText) throw new Error('Invalid or future Skill transaction')
    validateState(transaction.next)
    if (transaction.next.skills[transaction.name]?.currentVersion !== transaction.entry.id
      || JSON.stringify(transaction.next.versions[transaction.entry.id]) !== JSON.stringify(transaction.entry)) throw new Error('Skill transaction does not match its next index')
    if (state.versions[transaction.entry.id]?.sha256 === transaction.targetHash) { await rm(journalFile); return }
    if (state.lastRecovery?.versionId === transaction.entry.id && state.revision === transaction.beforeRevision + 1) { await rm(journalFile); return }
    if (state.revision !== transaction.beforeRevision || transaction.next.revision !== state.revision + 1) throw new Error('Skill transaction conflicts with the current index')
    const target = await readOwned(transaction.name)
    if (target.currentHash !== transaction.expectedHash && target.currentHash !== transaction.targetHash
      || target.currentHash !== transaction.targetHash && (!write || !writable())) {
      const next = clone(state); next.revision++
      next.lastRecovery = { state: 'blocked', name: transaction.name, versionId: transaction.entry.id,
        ...(transaction.entry.restoredFrom ? { restoredFrom: transaction.entry.restoredFrom } : {}),
        reason: target.currentHash !== transaction.expectedHash ? 'The Skill changed during an interrupted transaction; user bytes were retained.' : 'The interrupted Skill write was not executed; review and apply it again under a live Session.' }
      if (transaction.expectedHash === null && target.currentHash === null) {
        try { await rmdir(target.directory) } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error }
      }
      if (transaction.proposalId && next.proposals[transaction.proposalId]) Object.assign(next.proposals[transaction.proposalId], { state: 'blocked', reason: next.lastRecovery.reason })
      await save(next); await rm(journalFile); return
    }
    if (target.currentHash !== transaction.targetHash) {
      await mkdir(skillsRoot, { recursive: true, mode: 0o700 })
      await safeTarget(transaction.name)
      const existingDirectory = await info(target.directory)
      if (transaction.expectedHash === null && existingDirectory && (await readdir(target.directory)).length) throw new Error('An interrupted Skill creation now contains unrelated files')
      await mkdir(target.directory, { recursive: true, mode: 0o700 })
      await io.writeAtomic(target.file, transaction.fileText, { mode: 0o600, dirMode: 0o700 })
    }
    const versionFile = join(home, 'versions', `${transaction.entry.id}.json`), savedVersion = JSON.stringify({ ...transaction.entry, fileText: transaction.fileText })
    const previousVersion = await optional(versionFile)
    if (previousVersion !== undefined && previousVersion !== savedVersion) throw new Error('An immutable Skill version conflicts with the transaction')
    if (previousVersion === undefined) await io.writeAtomic(versionFile, savedVersion, { mode: 0o600, dirMode: 0o700 })
    transaction.next.root = await realpath(skillsRoot)
    await save(transaction.next)
    await rm(journalFile)
  }
  const run = operation => {
    if (closed) return Promise.reject(new Error('Skill evolution store is closed'))
    const task = queue.then(async () => {
      await mkdir(home, { recursive: true, mode: 0o700 })
      return withFileLock(stateFile, async () => {
        const text = await optional(stateFile)
        if (text !== undefined) { const loaded = JSON.parse(text); validateState(loaded); const changed = JSON.stringify(loaded.skills) !== JSON.stringify(state.skills); state = loaded; if (changed) notify() }
        else if (state.revision !== 0 || await info(journalFile) || (await info(join(home, 'versions')) && (await readdir(join(home, 'versions'))).length)) throw new Error('Skill evolution index is missing; retained data was not reset')
        await recover()
        return operation()
      })
    })
    queue = task.catch(() => {})
    return task
  }
  const persist = async next => { next.revision = state.revision + 1; await save(next) }
  const blocked = async (proposal, reason) => {
    if (proposal) { const next = clone(state); Object.assign(next.proposals[proposal.id], { state: 'blocked', reason }); await persist(next) }
    return { state: 'blocked', ...(proposal ? { proposalId: proposal.id, name: proposal.name } : {}), reason }
  }
  const commit = async ({ name, description, content, expectedHash, source, reviewSessionId, proposalId, restoredFrom }) => {
    if (Object.keys(state.versions).length >= maxVersions) return { ...await blocked(proposalId ? state.proposals[proposalId] : undefined, 'The configured saved version limit was reached'), name, ...(restoredFrom ? { restoredFrom } : {}) }
    const fileText = render(name, description, content), id = randomUUID(), now = new Date().toISOString()
    const entry = { id, name, description, content, sha256: hash(fileText), at: now, source: clone(source ?? {}),
      ...(reviewSessionId === undefined ? {} : { reviewSessionId }), ...(restoredFrom === undefined ? {} : { restoredFrom }) }
    const next = clone(state), previous = next.skills[name]
    next.revision++
    next.versions[id] = entry
    next.skills[name] = { name, description, writeHash: entry.sha256, currentVersion: id, versions: [...(previous?.versions ?? []), id] }
    if (proposalId) Object.assign(next.proposals[proposalId], { state: 'applied', versionId: id, appliedAt: now })
    await io.writeAtomic(journalFile, JSON.stringify({ version: VERSION, beforeRevision: state.revision, name, expectedHash,
      targetHash: entry.sha256, fileText, entry, next, ...(proposalId ? { proposalId } : {}) }), { mode: 0o600, dirMode: 0o700 })
    await recover({ write: true })
    if (state.versions[id] === undefined) return { state: 'blocked', name, reason: state.lastRecovery?.reason }
    return { state: 'applied', name, versionId: id, sha256: entry.sha256, path: paths(name).file }
  }
  const store = {
    skillsRoot,
    ready: () => run(async () => {}),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    state: () => ({ revision: state.revision, skills: Object.keys(state.skills).length, versions: Object.keys(state.versions).length,
      proposals: Object.values(state.proposals).filter(proposal => ['pending', 'blocked'].includes(proposal.state)).length,
      retainedProposals: Object.keys(state.proposals).length, capacities: { maxSkills, maxRuns, maxProposals, maxVersions },
      runs: Object.keys(state.runs).length, ...(state.lastRecovery ? { lastRecovery: clone(state.lastRecovery) } : {}) }),
    get: id => clone(own(state.proposals, id)),
    proposals: () => clone(Object.values(state.proposals)),
    history: name => clone((own(state.skills, name)?.versions ?? []).map(id => state.versions[id])),
    runs: () => clone(Object.values(state.runs)),
    recordRun: record => run(async () => {
      if (!object(record) || typeof record.id !== 'string' || !record.id || !['queued', 'running', 'none', 'proposed', 'applied', 'failed', 'blocked'].includes(record.state)) throw new Error('Invalid Skill review run')
      if (!Object.hasOwn(state.runs, record.id) && Object.keys(state.runs).length >= maxRuns) throw new Error('The configured review run limit was reached; retained runs were not removed')
      validateFeedbackProblem(record)
      if (Object.hasOwn(record, 'feedback')) validateFeedbackRecord(record.feedback)
      const retained = own(state.runs, record.id)?.feedback
      if (retained !== undefined && record.feedback !== undefined && JSON.stringify(retained) !== JSON.stringify(record.feedback)) throw new Error('Feedback outcomes must use their owned settlement method')
      const next = clone(state); next.runs = { ...next.runs, [record.id]: { ...clone(record), ...(retained === undefined ? {} : { feedback: clone(retained) }) } }; await persist(next)
    }),
    /** Atomically retain a candidate and reserve at most one exact-content submission across Hosts. */
    claimFeedback: (runId, candidate, { evidenceCount, submit, maxPerDay, now, reason } = {}) => run(async () => {
      const current = own(state.runs, runId)
      if (!current || !object(current.source) || typeof current.source.sessionId !== 'string' || !current.source.sessionId) throw new Error('Feedback requires an existing source run')
      if (!Number.isSafeInteger(maxPerDay) || maxPerDay < 0 || !Number.isSafeInteger(now) || now < 0 || typeof submit !== 'boolean') throw new Error('Invalid feedback submission limits')
      const parsed = parseFeedback(candidate, evidenceCount)
      const identity = feedbackIdentity(parsed, current.source.sessionId)
      if (current.feedback !== undefined) {
        if (current.feedback.hash !== identity.hash) throw new Error('This run already owns different feedback')
        return { send: false, feedback: clone(current.feedback) }
      }
      const previous = Object.values(state.runs).find(entry => entry.feedback?.hash === identity.hash && entry.feedback.state !== 'duplicate')
      const day = new Date(now).toISOString().slice(0, 10)
      const used = Object.values(state.runs).filter(entry => entry.feedback?.attemptedAt !== undefined
        && new Date(entry.feedback.attemptedAt).toISOString().slice(0, 10) === day).length
      const feedback = { version: 1, ...identity, candidate: parsed, evidenceCount, createdAt: now,
        ...(previous ? { state: 'duplicate', duplicateOf: previous.id }
          : !submit || !writable() ? { state: 'proposed', code: reason ?? 'disabled' }
            : used >= maxPerDay ? { state: 'limited', code: 'daily-limit' }
              : { state: 'sending', attemptedAt: now }) }
      validateFeedbackRecord(feedback)
      const next = clone(state); next.runs[runId].feedback = feedback; await persist(next)
      return { send: feedback.state === 'sending', feedback: clone(feedback) }
    }),
    /** Settle only the original reserved request; confirmed late results can resolve an interrupted unknown. */
    settleFeedback: (runId, requestHash, outcome, now) => run(async () => {
      const current = own(state.runs, runId)?.feedback
      if (!current || current.hash !== requestHash || !['sending', 'unknown'].includes(current.state)
        || !object(outcome) || !['submitted', 'unknown', 'rejected', 'blocked'].includes(outcome.state)
        || !Number.isSafeInteger(now) || now < 0) throw new Error('Feedback settlement does not match an outstanding request')
      const feedback = { ...clone(current), ...clone(outcome), finishedAt: now }
      if (outcome.code === undefined) delete feedback.code
      if (Object.keys(outcome).some(key => !['state', 'code', 'receipt'].includes(key))) throw new Error('Invalid feedback settlement fields')
      validateFeedbackRecord(feedback)
      const next = clone(state); next.runs[runId].feedback = feedback; await persist(next); return clone(feedback)
    }),
    /** Mark interrupted intents uncertain without creating another send authorization. */
    recoverFeedback: () => run(async () => {
      const next = clone(state); let changed = false
      for (const record of Object.values(next.runs)) {
        if (record.feedback?.state !== 'sending') continue
        record.feedback = { ...record.feedback, state: 'unknown', code: 'interrupted' }; changed = true
      }
      if (changed) await persist(next)
    }),
    addProposal: candidate => run(async () => {
      if (Object.keys(state.proposals).length >= maxProposals) throw new Error('The configured Skill proposal limit was reached; retained proposals were not removed')
      if (!object(candidate) || !['create', 'update'].includes(candidate.action) || !isSkillName(candidate.name)) throw new Error('Invalid Skill proposal action or name')
      const name = candidate.action === 'create' && !candidate.name.startsWith('muse-learned-') ? `muse-learned-${candidate.name}` : candidate.name
      if (candidate.action === 'create' && !ownedName(name)) throw new Error('A learned Skill requires a muse-learned name')
      for (const [field, limit] of [['description', maxDescriptionChars], ['content', maxSkillChars], ['why', maxSkillChars]]) {
        if (typeof candidate[field] !== 'string' || !candidate[field].trim() || candidate[field].length > limit || candidate[field].includes('\0')) throw new Error(`Invalid Skill proposal ${field}`)
      }
      if (candidate.baseHash !== undefined && !sha(candidate.baseHash)) throw new Error('Invalid Skill proposal baseline hash')
      const proposal = { id: randomUUID(), action: candidate.action, name, description: candidate.description.trim(), content: candidate.content.trim(), why: candidate.why.trim(),
        state: 'pending', at: new Date().toISOString(), source: clone(candidate.source ?? {}),
        ...(candidate.baseHash === undefined ? {} : { baseHash: candidate.baseHash }),
        ...(candidate.reviewSessionId === undefined ? {} : { reviewSessionId: candidate.reviewSessionId }) }
      const next = clone(state); next.proposals[proposal.id] = proposal; await persist(next); return clone(proposal)
    }),
    apply: (id, { baselineHash } = {}) => run(async () => {
      const proposal = own(state.proposals, id)
      if (!proposal) throw new Error('Unknown Skill proposal')
      if (proposal.state === 'applied') return { state: 'applied', name: proposal.name, versionId: proposal.versionId }
      if (proposal.state === 'rejected') return blocked(undefined, 'The proposal was rejected')
      if (!writable()) return blocked(proposal, 'Skill file writes are disabled')
      const current = own(state.skills, proposal.name)
      if (proposal.action === 'update' && !current) return blocked(proposal, 'This Skill is not owned by the learning plugin')
      if (proposal.action === 'create' && (current || Object.keys(state.skills).length >= maxSkills)) return blocked(proposal, current ? 'A Skill with this name is already owned' : 'The configured learned Skill limit was reached')
      const target = await readOwned(proposal.name)
      if (proposal.action === 'create' && (target.text !== undefined || await info(target.directory))) return blocked(proposal, 'The destination already exists; no user files were changed')
      if (current && (target.currentHash !== current.writeHash || proposal.baseHash !== current.writeHash || baselineHash !== undefined && baselineHash !== current.writeHash)) return blocked(proposal, 'The Skill or baseline changed; user edits were retained')
      return commit({ ...proposal, proposalId: id, expectedHash: current?.writeHash ?? null })
    }),
    reject: id => run(async () => {
      if (!own(state.proposals, id)) throw new Error('Unknown Skill proposal')
      const next = clone(state)
      if (next.proposals[id].state === 'applied') throw new Error('An applied proposal cannot be rejected; use version rollback')
      Object.assign(next.proposals[id], { state: 'rejected' }); await persist(next); return { state: 'rejected', id }
    }),
    undo: (name, { baselineHash, versionId } = {}) => run(async () => {
      const current = own(state.skills, name)
      if (!writable()) return blocked(undefined, 'Skill file writes are disabled')
      if (!current || !current.versions.includes(versionId)) return blocked(undefined, 'This saved version is not owned by the learning plugin')
      const target = await readOwned(name)
      if (baselineHash !== current.writeHash || target.currentHash !== current.writeHash) return blocked(undefined, 'The Skill changed; user edits were retained')
      const previous = await versionPayload(versionId)
      return commit({ name, description: previous.description, content: previous.content, source: previous.source,
        reviewSessionId: previous.reviewSessionId, expectedHash: current.writeHash, restoredFrom: versionId })
    }),
    catalog: async () => {
      await store.ready()
      const records = clone(Object.values(state.skills)), result = []
      for (const skill of records) {
        const target = await readOwned(skill.name), saved = await versionPayload(skill.currentVersion)
        const owned = target.currentHash === skill.writeHash
        result.push({ name: skill.name, description: skill.description, content: owned ? saved.content : '',
          currentHash: target.currentHash, owned, path: target.file })
      }
      return result
    },
    list: async () => (await store.catalog()).map(({ content: _content, ...entry }) => entry),
    close: async () => { closed = true; await queue; listeners.clear() },
  }
  return store
}
