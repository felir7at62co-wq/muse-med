import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as Draft from '../src/jianying-draft.ts'

const fakePython = `
const fs = require('node:fs'), path = require('node:path');
const [request, root, failure] = process.argv.slice(1);
const input = JSON.parse(fs.readFileSync(request, 'utf8'));
if (failure) { console.log(JSON.stringify({ success:false,drafts_created:0,drafts:[],error:'save rejected' })); process.exit(0); }
const target = path.join(root, input.name_prefix + String(input.episode).padStart(2, '0'));
fs.mkdirSync(target); fs.writeFileSync(path.join(target,'draft_content.json'),JSON.stringify({})+String.fromCharCode(10));
console.log(JSON.stringify({success:true,drafts_created:1,drafts:[{episode:'95',name:'candidate-95',path:target,id:'draft-id',success:true,error:''}],library:{name:'pyJianYingDraft',version:'0.3.1'},editor_open_verified:false}));
`

async function fixture(maxInputBytes = 65536) {
  const root = await mkdtemp(join(tmpdir(), 'muse-jianying-draft-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(LocalSubprocessRuntime)
    const input = { request_file: join(root, 'request.json'), drafts_dir: join(root, 'drafts') }
    await mkdir(input.drafts_dir)
    await writeFile(input.request_file, JSON.stringify({ episode: 95, name_prefix: 'candidate-' }))
    const config: Draft.Config = { source: root, pythonPath: process.execPath, timeoutMs: 30000,
      graceMs: 100, maxInputBytes, maxOutputBytes: 65536 }
    return { root, ctx, input, config }
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

it('runs the draft bridge directly with managed argv and removes its tool on disposal', async () => {
  const f = await fixture()
  const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  // Only the external Python/library is substituted; process collection and teardown are real.
  const spy = vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation(spec => spawn({ ...spec,
    argv: [process.execPath, '-e', fakePython, f.input.request_file, f.input.drafts_dir] }))
  try {
    const fiber = await f.ctx.plugin(Draft, f.config)
    expect(f.ctx.tools.get('jianying_draft')).toBeDefined()
    const result = await Draft.generateJianyingDraft(f.ctx.subprocess, f.input, f.config)
    expect(result).toMatchObject({ success: true, drafts_created: 1, editor_open_verified: false,
      library: { name: 'pyJianYingDraft', version: '0.3.1' } })
    expect(await readFile(join(result.drafts[0]!.path, 'draft_content.json'), 'utf8')).toBe('{}\n')
    const request = spy.mock.calls[0]![0]
    expect(request.argv.slice(0, 2)).toEqual([process.execPath, '-B'])
    expect(request.argv[2]).toMatch(/generate_draft_request\.py$/u)
    expect(request.argv).not.toContain('pwsh')
    await fiber.dispose()
    expect(f.ctx.tools.get('jianying_draft')).toBeUndefined()
  } finally {
    spy.mockRestore()
    await f.ctx.fiber.dispose()
    await rm(f.root, { recursive: true, force: true })
  }
})

it('rejects a library save failure even when the child exits zero', async () => {
  const f = await fixture()
  const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  const spy = vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation(spec => spawn({ ...spec,
    argv: [process.execPath, '-e', fakePython, f.input.request_file, f.input.drafts_dir, 'fail'] }))
  try {
    await expect(Draft.generateJianyingDraft(f.ctx.subprocess, f.input, f.config)).rejects.toThrow('save rejected')
  } finally {
    spy.mockRestore()
    await f.ctx.fiber.dispose()
    await rm(f.root, { recursive: true, force: true })
  }
})

it('rejects oversized requests before starting a generator', async () => {
  const f = await fixture(1)
  const spy = vi.spyOn(f.ctx.subprocess, 'spawn')
  try {
    await expect(Draft.generateJianyingDraft(f.ctx.subprocess, f.input, f.config))
      .rejects.toThrow('input limit')
    expect(spy).not.toHaveBeenCalled()
  } finally {
    spy.mockRestore()
    await f.ctx.fiber.dispose()
    await rm(f.root, { recursive: true, force: true })
  }
})

it('awaits the managed generator exit when the caller cancels', async () => {
  const f = await fixture()
  const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  const started = Promise.withResolvers<SubprocessHandle>()
  const exiting = Promise.withResolvers<undefined>()
  const releaseExit = Promise.withResolvers<undefined>()
  const controller = new AbortController()
  const spy = vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const handle = spawn({ ...spec, argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] })
    started.resolve(handle)
    return { stdin: handle.stdin, stdout: handle.stdout, stderr: handle.stderr, control: handle.control,
      collected: handle.collected, done: handle.done, terminate: () => { handle.terminate() },
      async waitForExit(signal) {
        exiting.resolve(undefined)
        await releaseExit.promise
        return handle.waitForExit(signal)
      } }
  })
  let settled = false
  try {
    const operation = Draft.generateJianyingDraft(f.ctx.subprocess, f.input, f.config, controller.signal)
    const observed = operation.then(() => { settled = true }, () => { settled = true })
    const handle = await started.promise
    const cancelled = expect(operation).rejects.toThrow('draft cancelled')
    controller.abort(new Error('draft cancelled'))
    await exiting.promise
    expect(settled).toBe(false)
    releaseExit.resolve(undefined)
    await cancelled
    await observed
    expect(await handle.waitForExit()).toBe(true)
  } finally {
    releaseExit.resolve(undefined)
    spy.mockRestore()
    await f.ctx.fiber.dispose()
    await rm(f.root, { recursive: true, force: true })
  }
})
