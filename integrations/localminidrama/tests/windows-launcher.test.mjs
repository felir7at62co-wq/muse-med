/** Exercise Windows shortcut startup with private deployments and real child processes. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const launcher = fileURLToPath(new URL('../windows/start-studio.ps1', import.meta.url))
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD|NODE_OPTIONS/i.test(key)))
const fixtureSource = String.raw`
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const root = process.cwd();
const config = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json')));
fs.appendFileSync(path.join(root, 'starts.jsonl'), JSON.stringify({pid: process.pid}) + '\n');
fs.watch(root, () => { if (fs.existsSync(path.join(root, 'stop'))) process.exit(0); });
if (fs.existsSync(path.join(root, 'stop'))) process.exit(0);
if (config.mode === 'exit') process.exit(7);
const server = http.createServer((req, res) => {
  fs.writeFileSync(path.join(root, 'health-observed'), 'yes');
  if (config.mode === 'non-json') { res.end('not-json'); return; }
  const ready = config.mode !== 'hold' && (config.mode !== 'barrier' || fs.existsSync(path.join(root, 'ready')));
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({app: config.mode === 'foreign' ? 'Foreign fixture' : 'Muse LocalMiniDrama isolated', status: ready ? 'ok' : 'starting'}));
});
server.on('error', error => { fs.writeFileSync(path.join(root, 'server-error'), error.code || error.message); process.exit(8); });
server.listen(config.port, '127.0.0.1', () => fs.writeFileSync(path.join(root, 'address.json'), JSON.stringify(server.address())));
`

async function exists(path) {
  try { await access(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

async function until(predicate, message, milliseconds = 25000) {
  const end = Date.now() + milliseconds
  while (Date.now() < end) {
    if (await predicate()) return
    await delay(40)
  }
  throw new Error(message)
}

function command(executable, args, options = {}) {
  const child = spawn(executable, args, { windowsHide: true, env: environment, ...options })
  let stdout = '', stderr = '', timedOut = false
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const deadline = setTimeout(() => { timedOut = true; child.kill() }, 50000)
  const done = new Promise((resolveResult, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      // Windows background descendants may retain inherited pipe handles after the launcher exits.
      child.stdout.destroy()
      child.stderr.destroy()
      resolveResult({ code, signal, timedOut, stdout, stderr })
    })
  }).finally(() => clearTimeout(deadline))
  return { child, done }
}

async function fixture(t, mode = 'ready', prestart = false) {
  const root = await mkdtemp(join(tmpdir(), 'muse studio launcher '))
  const studio = join(root, 'deployment', 'studio')
  const deployment = dirname(studio)
  const worktree = join(root, 'worktree with spaces')
  const serverPath = join(worktree, '.local/localminidrama/backend-node/src/server.js')
  const frontend = join(worktree, '.local/localminidrama/frontweb/dist/index.html')
  const children = []
  t.after(async () => {
    for (const owner of children) if (owner.child.exitCode === null && owner.child.signalCode === null) owner.child.kill()
    await Promise.all(children.map(owner => owner.done))
    await writeFile(join(studio, 'stop'), 'stop')
    const starts = await readStarts()
    await until(() => starts.every(({ pid }) => { try { process.kill(pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error } }), 'Owned fixture server did not exit', 15000)
    const inside = relative(tmpdir(), root)
    assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside), 'Cleanup stays inside the allocated temporary directory')
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  await Promise.all([mkdir(dirname(serverPath), { recursive: true }), mkdir(dirname(frontend), { recursive: true }), mkdir(studio, { recursive: true })])
  await writeFile(serverPath, fixtureSource)
  await writeFile(frontend, '<html>fixture</html>')
  let port = 0
  await writeFile(join(studio, 'fixture.json'), JSON.stringify({ port, mode }))
  if (prestart) {
    const owner = command(process.execPath, [serverPath], { cwd: studio })
    children.push(owner)
    await until(() => exists(join(studio, 'address.json')), 'Fixture did not bind its private port')
    port = JSON.parse(await readFile(join(studio, 'address.json'), 'utf8')).port
  }
  const url = `http://127.0.0.1:${port}`
  await writeFile(join(deployment, 'deployment.json'), JSON.stringify({ worktree, node: process.execPath, studioUrl: url }))
  const wrapper = join(root, 'invoke-launcher.ps1')
  // The external deployment format fixes its port before launch. Translate only the
  // placeholder health address so the real fixture child can atomically bind port 0.
  await writeFile(wrapper, String.raw`param([string]$Launcher,[string]$Deployment,[string]$AddressFile)
$ErrorActionPreference='Stop'
function Invoke-RestMethod {
  param([string]$Uri,[int]$TimeoutSec)
  if ($Uri -eq 'http://127.0.0.1:0/health') {
    if (-not (Test-Path -LiteralPath $AddressFile)) { throw 'Fixture server has not bound yet.' }
    $address=Get-Content -LiteralPath $AddressFile -Raw | ConvertFrom-Json
    $Uri='http://127.0.0.1:'+$address.port+'/health'
  }
  Microsoft.PowerShell.Utility\Invoke-RestMethod -Uri $Uri -TimeoutSec $TimeoutSec
}
[IO.File]::WriteAllText((Join-Path $Deployment ('attempt-' + $PID)), 'started')
& $Launcher -DeploymentPath $Deployment -NoDialog -StartupTimeoutSeconds 5
`)
  async function readStarts() {
    if (!await exists(join(studio, 'starts.jsonl'))) return []
    return (await readFile(join(studio, 'starts.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  }
  function launch() {
    const owner = command('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper, '-Launcher', launcher, '-Deployment', deployment, '-AddressFile', join(studio, 'address.json')])
    children.push(owner)
    return owner.done
  }
  async function successful(result) {
    if (await exists(join(studio, 'server-error'))) assert.fail(`Fixture resource failure: ${await readFile(join(studio, 'server-error'), 'utf8')}`)
    assert.equal(result.timedOut, false, result.stderr)
    assert.equal(result.signal, null, result.stderr)
    assert.equal(result.code, 0, result.stderr)
  }
  async function actualUrl() { return `http://127.0.0.1:${JSON.parse(await readFile(join(studio, 'address.json'), 'utf8')).port}` }
  return { studio, deployment, url, launch, readStarts, successful, actualUrl }
}

test('Windows studio launcher', { skip: process.platform !== 'win32' }, async t => {
  await t.test('cold startup accepts paths with spaces and ignores an unrelated saved PID', async t => {
    const f = await fixture(t)
    await writeFile(join(f.deployment, 'studio.pid'), String(process.pid))
    await f.successful(await f.launch())
    assert.equal((await f.readStarts()).length, 1)
    assert.equal((await (await fetch(`${await f.actualUrl()}/health`)).json()).status, 'ok')
    await f.successful(await f.launch())
    assert.equal((await f.readStarts()).length, 1)
  })
  await t.test('concurrent launches share one server while readiness is pending', async t => {
    const f = await fixture(t, 'barrier')
    const first = f.launch()
    await until(() => exists(join(f.studio, 'health-observed')), 'First startup never reached readiness')
    const second = f.launch()
    await until(async () => (await import('node:fs/promises')).readdir(f.deployment).then(names => names.filter(name => name.startsWith('attempt-')).length === 2), 'Second launch never entered while the first was pending')
    await writeFile(join(f.studio, 'ready'), 'ready')
    await Promise.all([first, second]).then(results => Promise.all(results.map(result => f.successful(result))))
    assert.equal((await f.readStarts()).length, 1)
  })
  for (const mode of ['foreign', 'non-json']) await t.test(`refuses an occupied ${mode} service without starting or stopping it`, async t => {
    const f = await fixture(t, mode, true)
    const result = await f.launch()
    assert.equal(result.timedOut, false)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /another application|port.*busy/i)
    assert.equal((await f.readStarts()).length, 1)
    assert.equal((await fetch(`${f.url}/health`)).status, 200)
  })
  await t.test('child exit is reported with its exit code and releases the launch lock', async t => {
    const f = await fixture(t, 'exit')
    const result = await f.launch()
    assert.equal(result.timedOut, false)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /exit code 7/)
    await writeFile(join(f.studio, 'fixture.json'), JSON.stringify({ port: Number(new URL(f.url).port), mode: 'ready' }))
    await f.successful(await f.launch())
    assert.equal((await f.readStarts()).length, 2)
  })
  await t.test('readiness timeout preserves the process and a later launch can reuse it', async t => {
    const f = await fixture(t, 'barrier')
    const result = await f.launch()
    assert.equal(result.timedOut, false)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /did not become ready.*left running/s)
    assert.equal((await f.readStarts()).length, 1)
    await writeFile(join(f.studio, 'ready'), 'ready')
    await f.successful(await f.launch())
    assert.equal((await f.readStarts()).length, 1)
    assert.match(await readFile(join(f.deployment, 'logs/studio-launcher.log'), 'utf8'), /ERROR:.*did not become ready/)
  })
})
