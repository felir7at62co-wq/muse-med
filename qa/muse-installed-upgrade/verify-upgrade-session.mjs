import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'

const scratch = dirname(fileURLToPath(import.meta.url))
const baselineCommits = new Map([
  ['1.3.0', '88029bebe0eab736519c847c88c5003223d2bcec'],
  ['1.3.1', 'ba18143ec0f72a8a563e72d3421a1b1cdd909b8d'],
])
const maxFileBytes = 8 * 1024 ** 2
const maxSessionBytes = 16 * 1024 ** 2
const maxLogCandidates = 128
const id = '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}'
const uuid = new RegExp(`^${id}$`, 'u')
const sessionPattern = new RegExp(`^session-${id}$`, 'u')
const userMarkerPattern = new RegExp(`^Verify preserved user message (${id})$`, 'u')
const logFilename = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/u
const decoder = new TextDecoder('utf-8', { fatal: true })
const { values } = parseArgs({
  options: {
    home: { type: 'string' }, seed: { type: 'string' }, 'local-synthetic': { type: 'boolean', default: false },
  },
})

function check(value, message) {
  if (!value) throw new Error(message)
}

function requiredPath(path, label) {
  check(typeof path === 'string' && isAbsolute(path), `${label} must be an absolute path`)
  return resolve(path)
}

async function ownedPath(root, path) {
  const fragment = relative(root, path)
  check(fragment && fragment !== '..' && !fragment.startsWith(`..${sep}`) && !isAbsolute(fragment),
    'Read path is outside the isolated test directory')
  for (let entry = path; relative(root, entry) !== ''; entry = dirname(entry)) {
    check(!(await lstat(entry)).isSymbolicLink(), 'Read path crosses a symlink or junction')
  }
  return path
}

async function readPlain(file, limit = maxFileBytes) {
  const before = await lstat(file)
  check(before.isFile() && before.size > 0 && before.size <= limit, 'Invalid or over-limit test evidence file')
  const bytes = await readFile(file)
  check(bytes.length === before.size, 'Test evidence changed while being read')
  return bytes
}

async function readJson(file, limit) {
  return JSON.parse(decoder.decode(await readPlain(file, limit)))
}

function equalPath(value, expected) {
  return typeof value === 'string' && isAbsolute(value) && relative(expected, value) === ''
}

function validateReceipt(seed) {
  const nonce = typeof seed?.userText === 'string' && userMarkerPattern.exec(seed.userText)?.[1]
  check(seed?.schemaVersion === 1 && seed.synthetic === true && seed.guiStarted === false && seed.gracefulShutdown === true
    && baselineCommits.get(seed.version) === seed.commit && typeof seed.commit === 'string'
    && sessionPattern.test(seed.sessionId) && uuid.test(seed.workspaceId) && nonce
    && seed.assistantText === 'Verified deterministic answer ' + nonce
    && seed.workspaceTitle === 'Muse Upgrade QA ' + nonce.slice(0, 8)
    && (seed.sessionTitle === 'Muse QA Session ' + nonce.slice(0, 8)
      || (seed.sessionTitle === undefined && values['local-synthetic'])), 'Receipt does not describe the exact synthetic seed')
}

function countId(ids, expected) {
  return Array.isArray(ids) ? ids.filter(value => value === expected).length : 0
}

async function verifyWorkspace(root, home, seed, workspacePath) {
  const path = await ownedPath(root, join(home, 'storages', 'workspace-owned-v1', 'state.json'))
  const state = await readJson(path)
  const workspace = state?.workspaces?.[seed.workspaceId]
  const ownerRecords = Object.values(state?.workspaces ?? {}).filter(row => countId(row?.sessionIds, seed.sessionId) > 0)
  check(state?.schemaVersion === 1 && state?.global?.initialized === true
    && countId(state.global.workspaceIds, seed.workspaceId) === 1
    && equalPath(workspace?.path, workspacePath) && workspace.title === seed.workspaceTitle
    && countId(workspace.sessionIds, seed.sessionId) === 1 && ownerRecords.length === 1,
  'The seeded workspace and session binding are missing or ambiguous')
}

async function verifySkills(root, home, workspace, seed) {
  const nonce = userMarkerPattern.exec(seed.userText)?.[1]
  check(nonce && seed.skills?.name === `muse-upgrade-qa-${nonce}`, 'The synthetic skill identity is missing')
  const insideHome = relative(home, workspace)
  const insideWorkspace = relative(workspace, home)
  check(insideHome && (insideHome === '..' || insideHome.startsWith(`..${sep}`) || isAbsolute(insideHome))
    && insideWorkspace && (insideWorkspace === '..' || insideWorkspace.startsWith(`..${sep}`) || isAbsolute(insideWorkspace)),
  'Workspace and product home must be separate')
  for (const [role, path, expected] of [
    ['user', join(home, 'skills', `${seed.skills.name}-user`, 'SKILL.md'), seed.skills.userSha256],
    ['workspace', join(workspace, '.agents', 'skills', `${seed.skills.name}-workspace`, 'SKILL.md'), seed.skills.workspaceSha256],
  ]) {
    const owned = await ownedPath(root, path)
    const bytes = await readPlain(owned, 4096)
    const expectedBytes = Buffer.from(`---\nname: ${seed.skills.name}-${role}\ndescription: Isolated ${role} upgrade sentinel\n---\n\nSynthetic ${role} skill ${nonce}.\n`)
    const digest = createHash('sha256').update(bytes).digest('hex')
    check(typeof expected === 'string' && digest === expected && bytes.equals(expectedBytes),
      `The synthetic ${role} skill changed or disappeared`)
  }
}

async function selectGeneration(root, home, sessionId, workspacePath) {
  const sessions = await ownedPath(root, join(home, 'sessions'))
  const rows = await readdir(sessions, { withFileTypes: true, recursive: true })
  const candidates = rows.filter(row => (row.isFile() || row.isSymbolicLink()) && logFilename.test(row.name))
  check(candidates.length > 0 && candidates.length <= maxLogCandidates, 'Unexpected number of isolated session logs')
  const seenGenerations = new Set()
  let newest
  for (const row of candidates) {
    const [, generationSuffix, compressed] = logFilename.exec(row.name)
    const generation = generationSuffix ? Number(generationSuffix) : 0
    check(Number.isSafeInteger(generation), 'Invalid session-log generation')
    const path = await ownedPath(root, join(row.parentPath, row.name))
    const bytes = await readPlain(path)
    const text = decoder.decode(compressed ? zstdDecompressSync(bytes, { maxOutputLength: maxSessionBytes }) : bytes)
    const end = text.indexOf('\n')
    check(end > 0, 'Session log has no complete header')
    const header = JSON.parse(text.slice(0, end))
    if (header.id !== sessionId) continue
    check(header.type === 'session' && header.version === generation, 'Session log header disagrees with its generation')
    check(equalPath(header.cwd, workspacePath), 'A session generation is bound to a different workspace')
    check(!seenGenerations.has(generation), 'The logical session has ambiguous generations')
    seenGenerations.add(generation)
    if (!newest || generation > newest.generation) newest = { path, generation, text }
  }
  check(newest, 'The logical session is missing')
  return newest
}

function messageText(row) {
  const message = row.data?.message ?? row.data
  return Array.isArray(message?.content)
    ? message.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
    : ''
}

function verifyPayload(snapshot, seed) {
  const rows = snapshot.text.trimEnd().split(/\r?\n/u).map(row => JSON.parse(row))
  check(rows.filter(row => row?.type === 'session').length === 1, 'Session log contains ambiguous headers')
  const users = rows.flatMap((row, index) => row?.type === 'user/message' && messageText(row) === seed.userText ? [index] : [])
  const answers = rows.flatMap((row, index) => row?.type === 'assistant/message' && messageText(row) === seed.assistantText ? [index] : [])
  check(users.length === 1 && answers.length === 1 && answers[0] > users[0], 'Synthetic conversation messages are missing or ambiguous')
  const title = rows.findLast(row => row?.type === 'session/title' && typeof row.data?.title === 'string')?.data.title
  if (seed.sessionTitle !== undefined) {
    check(title === seed.sessionTitle, 'The seeded session title is missing or changed')
    return title
  }
  return title && (title === seed.assistantText || seed.userText.startsWith(title)) ? title : null
}

async function main() {
  check(process.platform === 'win32' && process.arch === 'x64', 'Session verification requires Windows x64')
  const env = process.env
  const local = values['local-synthetic']
  if (!local) {
    check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.RUNNER_ENVIRONMENT === 'github-hosted'
      && env.RUNNER_OS === 'Windows' && env.RUNNER_ARCH === 'X64' && /^\d+$/u.test(env.GITHUB_RUN_ID ?? '')
      && typeof env.RUNNER_TEMP === 'string' && isAbsolute(env.RUNNER_TEMP),
    'Session verification requires a disposable GitHub-hosted Windows manual job')
  }
  const root = await realpath(local ? scratch : resolve(env.RUNNER_TEMP))
  const home = await ownedPath(root, requiredPath(values.home, '--home'))
  const receipt = await ownedPath(root, requiredPath(values.seed, '--seed'))
  const seed = await readJson(receipt, 32 * 1024)
  validateReceipt(seed)
  const workspacePath = await ownedPath(root, requiredPath(seed.workspacePath, 'Seed workspace path'))
  check((await lstat(workspacePath)).isDirectory(), 'Seed workspace directory is missing')
  await verifyWorkspace(root, home, seed, workspacePath)
  await verifySkills(root, home, workspacePath, seed)
  const snapshot = await selectGeneration(root, home, seed.sessionId, workspacePath)
  const sessionTitle = verifyPayload(snapshot, seed)
  console.log(JSON.stringify({
    schemaVersion: 1, verified: true, sessionId: seed.sessionId, sessionTitle, workspaceId: seed.workspaceId,
    workspaceTitle: seed.workspaceTitle, sessionPath: relative(home, snapshot.path), sessionLogGeneration: snapshot.generation,
    userMessageVerified: true, assistantMessageVerified: true, workspaceBindingVerified: true,
    userSkillOriginalPathAndBytesVerified: true, workspaceSkillOriginalPathAndBytesVerified: true,
  }))
}

try {
  await main()
} catch (error) {
  process.stderr.write(`Muse session verification: ${error.message}\n`)
  process.exitCode = 1
}
