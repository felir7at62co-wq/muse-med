import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { type ToolExecutionToken, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as Runtime from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import * as EpisodeSubtitles from '../src/index.ts'
import * as Rules from '../src/rules.ts'
import * as Handler from '../src/tool.ts'

afterEach(() => { vi.restoreAllMocks() })

async function fixture(config: EpisodeSubtitles.Config) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(Tools).await()
  await ctx.plugin(NativeToolExecutor).await()
  await ctx.plugin(LocalSubprocess).await()
  const account = {} as Context['museAccount']
  ctx.provide('museAccount', account)
  const plugin = ctx.plugin(EpisodeSubtitles, config)
  await plugin.await()
  const tool = ctx.tools.get('episode_subtitles')!
  const cwd = join(tmpdir(), 'subtitles-session')
  const agent = { session: { id: 'subtitles-session', header: { cwd } } } as ToolRunContext['agent'] & object
  const signal = new AbortController().signal
  const call = (source: 'local' | 'jingliu', activeAgent?: typeof agent) => {
    const callId = ToolCallId('test-subtitles')
    const args = { source, project: 'film-1', episodes: [1] }
    return tool.execute(args, { name: tool.name, arguments: args, callId, rootCallId: callId, signal,
      ...(activeAgent === undefined ? {} : { agent: activeAgent }), token: Symbol() as ToolExecutionToken,
      deferContext() {}, concludeTurn() {} })
  }
  return { ctx, plugin, tool, cwd, agent, signal, account, call }
}

it('requires a configured interpreter and registers the current tool and delivery guidance', async () => {
  expect(() => { EpisodeSubtitles.apply(new Context(), {}) }).toThrow('needs source (bundled runtime) or pythonPath')
  const rules = vi.spyOn(Rules, 'pythonRules')
  const runtime = vi.spyOn(Runtime, 'resolvePrimaryRuntime')
  const f = await fixture({ source: join(tmpdir(), 'runtime'), pythonPath: 'provided-python', maxChars: 12, jingliuMaxChars: 18 })
  expect(rules.mock.calls.map(([options]) => options.maxChars)).toEqual([12, 18])
  for (const [options] of rules.mock.calls) expect(await options.python()).toBe('provided-python')
  expect(runtime).not.toHaveBeenCalled()
  const guide = async () => (await f.ctx.systemPrompt.assemble()).sections.find(section => section.name === 'tool:episode_subtitles')
  expect((await guide())?.text).toContain('jianying_draft')
  expect(f.tool.output.render({}, { status: 'waiting' })).toEqual([{ type: 'text', text: '{"status":"waiting"}' }])
  await f.plugin.dispose()
  expect(f.ctx.tools.get('episode_subtitles')).toBeUndefined()
  expect(await guide()).toBeUndefined()
})

it('locates the application interpreter consistently in Windows and other packaged runtimes', async () => {
  const rules = vi.spyOn(Rules, 'pythonRules')
  const source = join(tmpdir(), 'packaged-runtime', 'desktop')
  const packaged = join(source, 'bin', 'python3')
  const runtime = vi.spyOn(Runtime, 'resolvePrimaryRuntime').mockResolvedValue({ python: packaged, pythonPackages: source,
    nodePackages: source, pythonDistributions: {} })
  await fixture({ source })
  const python = rules.mock.calls[0]![0].python
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
    expect(await python()).toBe(join(dirname(source), 'media', 'python', 'python.exe'))
    expect(runtime).not.toHaveBeenCalled()
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' })
    expect(await python()).toBe(packaged)
    expect(runtime).toHaveBeenCalledWith(source)
  } finally { Object.defineProperty(process, 'platform', descriptor) }
})

it('passes the owning session and blocks a subtitle request aimed at a different Jingliu project', async () => {
  const run = vi.spyOn(Handler, 'runEpisodeSubtitles').mockImplementation(async (args, _settings, services) => {
    if (args.source === 'local') return { status: 'local' }
    const session = await services.jingliu?.(args.project)
    return { identity: session?.identity ?? null }
  })
  const f = await fixture({ pythonPath: 'provided-python' })
  await expect(f.call('local')).resolves.toEqual({ status: 'local' })
  expect(run.mock.calls.at(-1)?.[2]).toMatchObject({ account: f.account, cwd: undefined })
  await expect(f.call('jingliu', f.agent)).resolves.toEqual({ identity: null })
  const studio = {
    connection: vi.fn<Context['jingliuConnection']['connection']>().mockResolvedValue({ identity: 'current-account', request: async () => ({}) }),
    selected: vi.fn<Context['jingliuConnection']['selected']>().mockResolvedValueOnce({ id: 'other-project', title: '其他片' })
      .mockResolvedValueOnce({ id: 'film-1', title: '雨夜' }),
  }
  const connection: Pick<Context['jingliuConnection'], 'connection' | 'selected'> = studio
  f.ctx.provide('jingliuConnection', connection as Context['jingliuConnection'])
  await expect(f.call('jingliu', f.agent)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_PROJECT' })
  await expect(f.call('jingliu', f.agent)).resolves.toEqual({ identity: 'current-account' })
  await expect(f.call('jingliu')).resolves.toEqual({ identity: 'current-account' })
  expect(studio.selected).toHaveBeenCalledTimes(2)
  expect(studio.selected).toHaveBeenCalledWith('subtitles-session', 'current-account')
  expect(run.mock.calls[3]?.[2].cwd).toBe(f.cwd)
  expect(run.mock.calls[3]?.[3]).toBe(f.signal)
})
