import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'

const scratch = dirname(fileURLToPath(import.meta.url))
const probe = 'muse-session-roundtrip-proof'
const baselines = [
  {
    version: '1.3.0',
    commit: '88029bebe0eab736519c847c88c5003223d2bcec',
    executableSha256: '23121a39c3abf9d53bef0a824411d5567fea395b0d4b98619a57a67ca267b50e',
    asarSha256: '11f064f8b88187986ea5e6597d825d86ba71cdcc70f50460966f416595c456f6',
    local: null,
  },
  {
    version: '1.3.1',
    commit: 'ba18143ec0f72a8a563e72d3421a1b1cdd909b8d',
    executableSha256: 'eb8a8f98fe4fe9d01dab1f4851710b86e87b6ce774906c4d0d972ff406b4da2c',
    asarSha256: '4ebcaf6be57f41e925faa823d7ad910564abbd252d0f71e602631555d1a40399',
    local: null,
  },
  {
    version: '1.3.2',
    commit: 'c9f60d1466bfdad798584c149b5ff04e440923d4',
    executableSha256: 'de2de44b66a3f0d4ba9e9e095bc52a439447481006d8c69376ee5009f022ebaa',
    asarSha256: 'cba06e339f6f399d992ee6e9accae480880081f9814bc2ef40a1cc8aec7e4d45',
    local: null,
  },
]
const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-ffmpeg', '@wenbin_wb/dsh-bridge',
  '@deepseek-ai/dsh-feishu-settings', 'dsh-skill-mcp-panel', '@deepseek-ai/dsh-desktop-host', 'muse-hongguo-search',
  '@xmanrui/dsh-im', 'dsh-plugin-subscriptions', 'muse-skill-evolution', 'deep-view', '@nagi-ovo/dsh-visualize']

function check(value, message) {
  if (!value) throw new Error(message)
}

const { values } = parseArgs({
  options: {
    'install-root': { type: 'string' },
    home: { type: 'string' },
    output: { type: 'string' },
    'local-extracted-baseline': { type: 'boolean', default: false },
  },
})

function requiredPath(option) {
  const path = values[option]
  check(typeof path === 'string' && isAbsolute(path), `--${option} must be an absolute path`)
  return resolve(path)
}

function ownedBy(owner, path) {
  const fragment = relative(owner, path)
  return fragment !== '' && fragment !== '..' && !fragment.startsWith(`..${sep}`) && !isAbsolute(fragment)
}

async function statIfPresent(path) {
  try { return await lstat(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function ownedPath(owner, path) {
  check(ownedBy(owner, path), 'Seed path is outside its dedicated directory')
  for (let entry = path; relative(owner, entry) !== ''; entry = dirname(entry)) {
    const stat = await statIfPresent(entry)
    check(!stat?.isSymbolicLink(), 'Seed path must not cross a symlink or junction')
  }
  return path
}

const exactFile = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })

async function digest(path) {
  const stat = await lstat(path)
  check(stat.isFile(), 'Expected a plain baseline file')
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    size += chunk.length
    hash.update(chunk)
  }
  check(size === stat.size, 'A baseline file changed while being hashed')
  return hash.digest('hex')
}

function environment(home, config, runtime) {
  const inherited = /^(?:SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|PATH|SYSTEMDRIVE|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|PROGRAMFILES(?:\(X86\))?|PROGRAMDATA|PROGRAMW6432)$/iu
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => inherited.test(name)))
  for (const key of ['DSH_HOME', 'MUSE_HOME', 'MUSE_MED_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) env[key] = home
  return { ...env, ELECTRON_RUN_AS_NODE: '1', MUSE_ROUNDTRIP_CONFIG: config, MUSE_ROUNDTRIP_PACKAGED_RUNTIME: runtime,
    MUSE_ROUNDTRIP_PHASE: 'write', NARB_NATIVE_CACHE_DIR: join(home, 'native'), NARB_DISABLE_NATIVE_CACHE: '0',
    MUSE_BASE_URL: 'http://127.0.0.1:1', TEMP: join(home, 'tmp'), TMP: join(home, 'tmp') }
}

function awaitMessage(child, type, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      reject(new Error(`SEED_HOST_EXIT ${String(child.exitCode ?? child.signalCode)}`))
      return
    }
    function clean() {
      clearTimeout(timer)
      child.off('message', message)
      child.off('exit', exit)
      child.off('error', error)
    }
    function message(value) {
      if (value?.type === type) { clean(); resolve(value) }
      else if (value?.type === 'fatal') { clean(); reject(new Error('SEED_HOST_BOOT')) }
    }
    function exit(code, signal) { clean(); reject(new Error('SEED_HOST_EXIT ' + String(code ?? signal))) }
    function error() { clean(); reject(new Error('SEED_HOST_SPAWN')) }
    const timer = setTimeout(() => { clean(); reject(new Error('SEED_TIMEOUT ' + type)) }, timeoutMs)
    child.on('message', message).once('exit', exit).once('error', error)
  })
}

async function baselineIdentity(install, owner) {
  const executable = await ownedPath(owner, join(install, 'muse-med.exe'))
  const archive = await ownedPath(owner, join(install, 'resources', 'app.asar'))
  const [executableSha256, asarSha256] = await Promise.all([digest(executable), digest(archive)])
  const source = baselines.find(row => row.executableSha256 === executableSha256 && row.asarSha256 === asarSha256)
  check(source, 'Installed executable and ASAR do not match a pinned Windows baseline')
  if (values['local-extracted-baseline']) {
      check(source.local !== null && relative(resolve(source.local), install) === '',
        'Local testing is limited to the original extracted baseline directory')
  }
  return { version: source.version, commit: source.commit, executable, executableSha256, asarSha256 }
}

async function seedFromHost(install, baseline, profile, home, config) {
  const support = join(install, 'resources', 'runtime')
  const primary = join(support, 'primary-runtime')
  const runtime = join(install, 'resources', 'app.asar', 'dsh')
  const child = spawn(baseline.executable, ['--expose-internals', '--import',
    pathToFileURL(join(scratch, 'upgrade-session-network-guard.mjs')).href,
    join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js'), runtime, profile, primary,
    join(primary, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'), join(support, 'bin')], {
    cwd: profile, env: environment(home, config, runtime), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  const exitDeadline = () => new Promise(resolve => setTimeout(() => resolve(undefined), 22_000).unref())
  let diagnostics = ''
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-8192) })
  try {
    const ready = await awaitMessage(child, 'ready', 120_000)
    const origin = new URL(ready.url)
    check(origin.protocol === 'http:' && origin.hostname === '127.0.0.1', 'SEED_HOST_NOT_LOOPBACK')
    const wait = awaitMessage(child, 'muse-session-roundtrip-result', 90_000)
    child.send({ type: 'muse-session-roundtrip', mode: 'write' })
    const result = await wait
    if (result.error) throw new Error('SEED_HOST_RESULT ' + result.error)
    check(result.report?.sessionResumed && result.report?.workspaceVerified && result.report.modelCalls > 0, 'SEED_HOST_MISSING_RESULT')
    const stopped = awaitMessage(child, 'shutdown-complete', 22_000)
    child.send({ type: 'shutdown' })
    await stopped
    const exit = await Promise.race([exited, exitDeadline()])
    check(exit?.code === 0 && exit.signal === null, 'SEED_HOST_UNCLEAN_EXIT')
    return result.report
  } catch (error) {
    const diagnosticsSafe = diagnostics.split(/\r?\n/).filter(line => /ROUNDTRIP_|Error:|Cannot find|ERR_MODULE/.test(line)).slice(-6)
      .map(line => line.replace(/[A-Z]:\\[^"' \t]*/gi, '[path]').replace(/https?:\/\/\S+/giu, '[url]').slice(0, 300))
    throw new Error([error.message, ...diagnosticsSafe].join(' | '))
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ type: 'shutdown' })
      if (!await Promise.race([exited, exitDeadline()])) { child.kill(); await exited }
    }
  }
}

async function persistedSession(home, markers, sessionId) {
  const rows = await readdir(join(home, 'sessions'), { withFileTypes: true, recursive: true })
  const matches = []
  for (const row of rows) {
    if (!row.isFile() || !/^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/u.test(row.name)) continue
    const path = join(row.parentPath, row.name)
    const bytes = await readFile(path)
    const text = (row.name.endsWith('.zstd') ? zstdDecompressSync(bytes, { maxOutputLength: 8 * 1024 ** 2 }) : bytes).toString('utf8')
    if (markers.every(marker => text.includes(marker))) matches.push(path)
  }
  check(matches.length === 1 && matches[0].includes(sessionId), 'SEED_PERSISTENCE_NOT_UNIQUE')
  return { sessionPath: relative(home, matches[0]), sessionSha256: await digest(matches[0]) }
}

async function main() {
  check(process.platform === 'win32' && process.arch === 'x64', 'Session seeding requires Windows x64')
  const install = requiredPath('install-root')
  const home = requiredPath('home')
  const output = requiredPath('output')
  check(!values['local-extracted-baseline'], 'This fixture requires the hosted Windows runner')
  const local = false
  const env = process.env
  if (!local) {
    check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.RUNNER_ENVIRONMENT === 'github-hosted'
      && env.RUNNER_OS === 'Windows' && env.RUNNER_ARCH === 'X64' && /^\d+$/u.test(env.GITHUB_RUN_ID ?? '')
      && typeof env.RUNNER_TEMP === 'string' && isAbsolute(env.RUNNER_TEMP),
    'Session seeding requires a disposable GitHub-hosted Windows manual job')
  }
  const owner = await realpath(local ? scratch : resolve(env.RUNNER_TEMP))
  const installOwner = local ? dirname(install) : owner
    if (local) check(baselines.some(row => row.local !== null && relative(resolve(row.local), install) === ''),
    'Local mode requires a pinned extracted package')
  await ownedPath(installOwner, install)
  await ownedPath(owner, home)
  await ownedPath(owner, output)
  check(!ownedBy(install, home) && !ownedBy(home, install) && relative(home, install) !== ''
    && !ownedBy(home, output) && !ownedBy(install, output), 'Seed home and receipt must be separate from the installed app')
  check((await lstat(install)).isDirectory(), 'Installed app directory missing')
  const priorHome = await statIfPresent(home)
  check(!priorHome || (priorHome.isDirectory() && (await readdir(home)).length === 0), 'Seed home must be empty')
  check(!await statIfPresent(output), 'The seed receipt already exists')
  check((await lstat(dirname(output))).isDirectory(), 'The seed receipt directory must already exist')

  const baseline = await baselineIdentity(install, installOwner)
  await mkdir(home, { recursive: true })
  const seed = await mkdtemp(join(dirname(home), 'muse-session-seed-profile-'))
  const workspace = await mkdtemp(join(dirname(home), 'muse-upgrade-workspace-'))
  const nonce = randomUUID()
  const skillName = `muse-upgrade-qa-${nonce}`
  const skillContents = role => `---\nname: ${skillName}-${role}\ndescription: Isolated ${role} upgrade sentinel\n---\n\nSynthetic ${role} skill ${nonce}.\n`
  check(!ownedBy(install, workspace) && !ownedBy(home, workspace) && !ownedBy(workspace, home),
    'Synthetic workspace must be separate from the install and product home')
  const userSkill = await ownedPath(owner, join(home, 'skills', `${skillName}-user`, 'SKILL.md'))
  const workspaceSkill = await ownedPath(owner, join(workspace, '.agents', 'skills', `${skillName}-workspace`, 'SKILL.md'))
  await Promise.all([mkdir(dirname(userSkill), { recursive: true }), mkdir(dirname(workspaceSkill), { recursive: true })])
  await Promise.all([
    writeFile(userSkill, skillContents('user'), { flag: 'wx', mode: 0o600 }),
    writeFile(workspaceSkill, skillContents('workspace'), { flag: 'wx', mode: 0o600 }),
  ])
  const skills = { name: skillName, userSha256: await digest(userSkill), workspaceSha256: await digest(workspaceSkill) }
  const marker = { workspace, workspaceTitle: 'Muse Upgrade QA ' + nonce.slice(0, 8),
    sessionTitle: 'Muse QA Session ' + nonce.slice(0, 8),
    userText: 'Verify preserved user message ' + nonce, assistantText: 'Verified deterministic answer ' + nonce }
  const profile = join(seed, 'desktop')
  const plugin = join(profile, 'node_modules', probe)
  const config = join(seed, 'fixture.json')
  try {
    await mkdir(plugin, { recursive: true })
    await mkdir(join(home, 'tmp'), { recursive: true })
    await exactFile(config, marker)
    await exactFile(join(profile, 'package.json'), { name: 'dsh-profile-desktop', private: true, dependencies: { [probe]: 'file:' + plugin },
      dsh: { profile: { bundles: [...bundles, probe] } } })
    await exactFile(join(plugin, 'package.json'), { name: probe, version: '1.0.0', type: 'module', exports: './index.mjs',
      dsh: { bundle: { patch: './bundle.yml' } } })
    await writeFile(join(plugin, 'bundle.yml'), '- insert:\n    - id: ' + probe + '\n      name: ' + probe
      + '\n      inject: [llm, sessionController, workspaceRegistry]\n', { flag: 'wx' })
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n', { flag: 'wx' })
    await writeFile(join(profile, 'pnpm-workspace.yaml'), 'offline: true\nupdateNotifier: false\n', { flag: 'wx' })
    await copyFile(join(scratch, 'upgrade-session-probe.mjs'), join(plugin, 'index.mjs'))
    const report = await seedFromHost(install, baseline, profile, home, config)
    const persisted = await persistedSession(home, [marker.userText, marker.assistantText, marker.sessionTitle], report.sessionId)
    const { executable: _executable, ...identity } = baseline
    const receipt = { schemaVersion: 1, ...identity, ...marker, workspacePath: workspace, skills,
      sessionId: report.sessionId, workspaceId: report.workspaceId, ...persisted,
      gracefulShutdown: true, synthetic: true, guiStarted: false, processNetworkBlocked: report.processNetworkBlocked }
    const temporary = output + '.' + nonce + '.tmp'
    try {
      await exactFile(temporary, receipt)
      await rename(temporary, output)
    } finally { await rm(temporary, { force: true }) }
    console.log(`Packaged Muse ${baseline.version} wrote and flushed the isolated synthetic session.`)
  } finally {
    const resolved = await realpath(seed)
    check(relative(seed, resolved) === '' && ownedBy(owner, resolved), 'Refusing to clean an unexpected seed profile')
    await rm(resolved, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (error) {
  process.stderr.write(`Muse session seed: ${error.message}\n`)
  process.exitCode = 1
}
