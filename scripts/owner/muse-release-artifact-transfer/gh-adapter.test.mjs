/** Exercise the fixed GitHub CLI transport without invoking GitHub or exposing credentials. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import { createGitHubTransferAdapter } from './gh-adapter.mjs'

const token = 'synthetic-transfer-token'

test('fixed metadata and single-file commands receive only the owned GitHub environment', async () => {
  const calls = []
  const adapter = createGitHubTransferAdapter(token, {
    environment: { PATH: '/fixture/bin', HOME: '/fixture/home', TMPDIR: '/fixture/tmp', LANG: 'C',
      AWS_SECRET_ACCESS_KEY: 'unrelated-secret', GITHUB_TOKEN: 'unrelated-token', GH_DEBUG: 'api', SSH_AUTH_SOCK: '/fixture/socket' },
    execute(program, args, options) { calls.push({ program, args, options }); return '{"success":true}' },
  })
  assert.deepEqual(await adapter.json('actions/runs/42/jobs?per_page=100'), { success: true })
  await adapter.upload('v1.0.5', '/fixture/muse-med-1.0.5-win-x64.exe')
  assert.deepEqual(calls.map(call => call.program), ['gh', 'gh'])
  assert.deepEqual(calls[0].args, ['api', '--method', 'GET', 'repos/felir7at62co-wq/muse-med/actions/runs/42/jobs?per_page=100'])
  assert.deepEqual(calls[1].args, ['release', 'upload', 'v1.0.5', '/fixture/muse-med-1.0.5-win-x64.exe', '--repo', 'felir7at62co-wq/muse-med'])
  for (const call of calls) {
    assert.deepEqual(call.options.env, { PATH: '/fixture/bin', HOME: '/fixture/home', TMPDIR: '/fixture/tmp', LANG: 'C',
      GH_TOKEN: token, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' })
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe'])
    assert.equal(call.args.includes('--clobber'), false)
    assert.equal(call.args.some(argument => argument.includes(token)), false)
  }
})

test('unsupported endpoints and file labels cannot become GitHub operations', async () => {
  let calls = 0
  const adapter = createGitHubTransferAdapter(token, { execute() { calls++; return '{}' } })
  for (const route of ['https://other.example/', 'releases/1/assets', 'releases/0', 'actions/runs/1?token=secret',
    'actions/runs/1/../../releases/2', 'git/ref/tags/main', 'git/tags/not-a-sha', 'releases/1\nDELETE']) {
    await assert.rejects(adapter.json(route), /Unexpected GitHub transfer API route/u)
  }
  for (const path of ['--clobber', 'relative.exe', '/fixture/file.exe#label', '/fixture/metadata.yml', '/fixture/file.exe\nother']) {
    await assert.rejects(adapter.upload('v1.0.5', path), /Invalid single-file draft upload/u)
  }
  await assert.rejects(adapter.upload('other-release', '/fixture/file.exe'), /Invalid single-file draft upload/u)
  assert.equal(calls, 0)
})

test('child failures report status, signal and timeout without printing captured credentials', async () => {
  const adapter = createGitHubTransferAdapter(token, { execute() {
    throw Object.assign(new Error(`provider output ${token}`), { stderr: token, stdout: token,
      status: 0, signal: 'SIGTERM', code: 'ETIMEDOUT' })
  } })
  await assert.rejects(adapter.upload('v1.0.5', '/fixture/file.exe'), error => {
    assert.equal(error.message.includes(token), false)
    assert.match(error.message, /exit=0, signal=SIGTERM, timeout=true/u)
    return true
  })
})

test('malformed metadata does not print the response body', async () => {
  const adapter = createGitHubTransferAdapter(token, { execute() { return token } })
  await assert.rejects(adapter.json('releases/42'), error => {
    assert.equal(error.message, 'GitHub metadata response was not JSON')
    assert.equal(error.message.includes(token), false)
    return true
  })
})

test('Actions entry help is local and transfer refuses nonmanual local execution', () => {
  const entry = join(import.meta.dirname, 'run.mjs')
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME }
  assert.match(execFileSync(process.execPath, [entry, '--help'], { encoding: 'utf8', env: environment }), /Usage:/u)
  assert.throws(() => execFileSync(process.execPath, [entry, '--mode', 'transfer', '--manifest', 'not-read.json'],
    { encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'] }), error => {
    assert.match(error.stderr.toString(), /restricted to manual dispatch/u)
    return true
  })
})

test('Latest discovery uses the same fixed read-only metadata route', async () => {
  const calls = []
  const adapter = createGitHubTransferAdapter(token, { execute(program, args) { calls.push({ program, args }); return '{"id":42}' } })
  assert.deepEqual(await adapter.json('releases/latest'), { id: 42 })
  assert.deepEqual(calls, [{ program: 'gh', args: ['api', '--method', 'GET', 'repos/felir7at62co-wq/muse-med/releases/latest'] }])
})
