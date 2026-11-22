/**
 * REAL composition for a Jingliu project: episode_subtitles and the batch jianying_draft through the Loader, against
 * the Jingliu backend of this repository on a temporary database (`tests/fixtures/jingliu-server.py`), reached through
 * the real Jingliu connection with its loopback preview session and local media. FFmpeg, the managed subprocess
 * provider and the shared rules Python are real; only the Muse transcription gateway is scripted.
 *
 * Runs when `MUSE_JINGLIU_TEST_PYTHON` names an interpreter with the Jingliu backend requirements.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import JingliuConnection from '@deepseek-ai/dsh-jingliu-connection'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as EpisodeSubtitles from '@deepseek-ai/dsh-tool-episode-subtitles'
import { expect, it } from 'vitest'
import { hasMedia, makeShot, scriptedAccount } from '../../../packages/drama/tool-episode-subtitles/tests/real-project.ts'
import * as JianyingDraft from '../src/jianying-draft.ts'

type Agent = NonNullable<Parameters<typeof executeModelToolFixture>[1]['agent']>

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const repository = resolve(import.meta.dirname, '..', '..', '..')
const jingliuPython = [process.env.MUSE_JINGLIU_TEST_PYTHON].find((python): python is string => python !== undefined
  && spawnSync(python, ['-c', 'import fastapi, uvicorn, pyJianYingDraft, importlib.metadata as m; assert m.version("pypinyin") == "0.55.0"'],
    { stdio: 'ignore' }).status === 0)
const which = (command: string) => { try { return execFileSync('which', [command], { encoding: 'utf8' }).trim() } catch { return command } }

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  await new Promise<void>(done => server.close(() => { done() }))
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

class FixtureCommands extends Service {
  constructor(ctx: Context) { super(ctx, 'commands') }
  register(): () => void { return () => undefined }
}

it.runIf(hasMedia && jingliuPython !== undefined)('stores Jingliu subtitles, installs planned drafts and refuses a regenerated shot until it is rebuilt', async () => {
  const base = await mkdtemp(join(tmpdir(), 'muse-episode-subtitles-jingliu-real-'))
  const workspace = join(base, 'workspace'), drafts = join(base, 'jianying-drafts'), media = join(base, 'media')
  await mkdir(workspace); await mkdir(drafts); await mkdir(media)
  const files = [join(media, 'a.mp4'), join(media, 'b.mp4'), join(media, 'c.mp4')]
  makeShot(files[0]!, 2, 300); makeShot(files[1]!, 2, 400); makeShot(files[2]!, 2, 500)
  const token = 'muse-real-composition-token'
  await writeFile(join(base, 'seed.json'), JSON.stringify({ token, project: 'p1', title: '测试剧', characters: ['林晨'], shots: [
    { order: 1, episode: 1, file: files[0], line: '林晨：林晨回来了', clip_in_sec: 0, clip_dur_sec: 2, speed: 1, duration_sec: 2 },
    { order: 2, episode: 1, file: files[1], line: '沈母：妈在等你', clip_in_sec: 0.5, clip_dur_sec: 1.2, speed: 1.5, duration_sec: 2 }] }))
  const port = await freePort(), origin = `http://127.0.0.1:${String(port)}`
  const server = spawn(jingliuPython!, ['-I', join(import.meta.dirname, 'fixtures', 'jingliu-server.py'),
    join(repository, 'services', 'jingliu', 'backend'), join(base, 'studio'), String(port), join(base, 'seed.json')],
  { stdio: ['ignore', 'ignore', 'pipe'] })
  let serverLog = ''
  server.stderr.on('data', (chunk: Buffer) => { serverLog += chunk.toString('utf8') })
  const studio = async (path: string, body?: unknown) => {
    const response = await fetch(`${origin}/fwp${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!response.ok) throw new Error(`${path}: HTTP ${String(response.status)} ${await response.text()}`)
    return await response.json() as Record<string, unknown>
  }
  const previousToken = process.env.MUSE_JINGLIU_SESSION_TOKEN
  process.env.MUSE_JINGLIU_SESSION_TOKEN = token
  const ctx = new Context()
  try {
    for (let attempt = 0; ; attempt++) {
      try { if ((await fetch(`${origin}/fwp/health`)).ok) break } catch (error) { if (attempt > 120) throw new Error(`${String(error)}\n${serverLog}`) }
      await new Promise(done => setTimeout(done, 500))
    }
    const root = join(workspace, 'jingliu', 'p1')
    const heard = (text: string) => Array.from(text, (char, index) => ({ start: 0.6 + index * 0.15, end: 0.72 + index * 0.15, text: char }))
    const words = new Map<string, ReturnType<typeof heard>>([[sha(await readFile(files[0]!)), heard('林晨回来了')],
      [sha(await readFile(files[1]!)), heard('妈在等他')], [sha(await readFile(files[2]!)), heard('妈在等你呀')]])
    await mkdir(root, { recursive: true })
    const gateway = await scriptedAccount(root, words)
    const python = jingliuPython!, ffmpeg = which('ffmpeg'), ffprobe = which('ffprobe')
    const config = join(base, 'cordis.yml')
    await writeFile(config, ["- name: '@deepseek-ai/dsh-system-prompt'", "- name: '@deepseek-ai/dsh-tools'", "- name: '@deepseek-ai/dsh-subprocess-local'",
      '- name: fixture-account', '- name: fixture-commands', "- name: '@deepseek-ai/dsh-jingliu-connection'", '  config:',
      `    studioOrigin: ${JSON.stringify(origin)}`, '    localPreviewToken: true', '    localMedia: true',
      "- name: '@deepseek-ai/dsh-tool-episode-subtitles'", '  config:', `    pythonPath: ${JSON.stringify(python)}`,
      `    ffmpegPath: ${JSON.stringify(ffmpeg)}`, `    ffprobePath: ${JSON.stringify(ffprobe)}`, '    pollIntervalMs: 1000',
      '- name: jianying-draft', '  config:', `    source: ${JSON.stringify(base)}`, `    pythonPath: ${JSON.stringify(python)}`,
      `    ffmpegPath: ${JSON.stringify(ffmpeg)}`, `    ffprobePath: ${JSON.stringify(ffprobe)}`, '    timeoutMs: 240000', '    graceMs: 1000',
      '    maxInputBytes: 1048576', '    maxOutputBytes: 1048576', ''].join('\n'))
    ctx.baseUrl = pathToFileURL(base).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools],
      ['@deepseek-ai/dsh-subprocess-local', LocalSubprocess], ['fixture-account', gateway.plugin], ['fixture-commands', FixtureCommands],
      ['@deepseek-ai/dsh-jingliu-connection', JingliuConnection], ['@deepseek-ai/dsh-tool-episode-subtitles', EpisodeSubtitles],
      ['jianying-draft', JianyingDraft]])
    ctx.loader.internal = { version: 'v2', loadCache: new Map(),
      register() { throw new Error('Unexpected loader hooks') }, getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
      resolveSync() { throw new Error('Unexpected loader resolution') }, load() { throw new Error('Unexpected loader load') },
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
        return modules.get(specifier)
      } }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    await ctx.plugin(NativeToolExecutor)
    const agent = { session: { id: SessionId('jingliu-real-composition'), header: { cwd: workspace } } } as Agent
    let calls = 0
    const run = async (name: string, args: Record<string, unknown>) => {
      const result = await executeModelToolFixture(ctx, { name, callId: ToolCallId(`call-${String(++calls)}`), signal: new AbortController().signal,
        arguments: args, agent })
      return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
    }
    const subtitles = (args: Record<string, unknown> = {}) => run('episode_subtitles', { source: 'jingliu', project: 'p1', episodes: [1], ...args })
    const draft = () => run('jianying_draft', { source: 'jingliu', project: 'p1', episodes: [1], drafts_dir: drafts })

    expect(await draft()).toMatchObject({ created: [], refused: [{ episode: 1, reason: 'subtitles_missing', shots: [1, 2] }],
      next: { tool: 'episode_subtitles' } })
    expect(await subtitles()).toMatchObject({ status: 'waiting' })
    gateway.complete()
    const built = await subtitles()
    expect(built).toMatchObject({ files: 'jingliu/p1/subtitles/epNN.srt' })
    expect(['ready', 'needs_review']).toContain(built.status)

    // The review list is Jingliu's; the same words through the vendored rules give the same item IDs.
    const review = await subtitles({ method: 'review' })
    const plan = await studio('/v2/projects/p1/edit-plan', { episodes: [1] }) as { names: string[]; episodes: { shots: { order: number; lines: string[]; subtitles: { status: string } }[] }[] }
    expect(plan.episodes[0]!.shots.map(shot => shot.subtitles.status)).toEqual(['fresh', 'fresh'])
    const rulesInput = { max_chars: 20, space_width: 0.5, shots: await Promise.all(plan.episodes[0]!.shots.map(async (shot, index) => {
      const audio = sha(await readFile(files[index]!))
      const transcript = JSON.parse(await readFile(join(root, 'transcript', 'shots', `${audio}.json`), 'utf8')) as { words: unknown[]; flags: unknown[] }
      return { key: String(shot.order), audio_sha256: audio, words: transcript.words, lines: shot.lines, names: plan.names, decisions: [],
        flags: transcript.flags }
    })) }
    const local = JSON.parse(execFileSync(python, ['-B', '-I', join(repository, 'packages', 'drama', 'skills', 'skills', 'tweet-drama-draft-build',
      'scripts', 'subtitle_rules', 'run.py')], { input: JSON.stringify(rulesInput), encoding: 'utf8' })) as { shots: { key: string; items: { id: string }[] }[] }
    const listed = (review.items as { id: string; shot: number }[]).map(item => `${String(item.shot)}:${item.id}`).sort()
    expect(listed).toEqual(local.shots.flatMap(shot => shot.items.map(item => `${shot.key}:${item.id}`)).sort())
    expect(review.pending).toBe(listed.length)
    expect(listed.length).toBeGreaterThan(0)
    if (listed.length > 0) {
      const decisions = (review.items as { id: string }[]).map(item => ({ id: item.id, action: 'script' }))
      expect(await subtitles({ method: 'review', decisions })).toMatchObject({ pending: 0, status: 'ready' })
    }
    const clips = (await studio('/v2/projects/p1/subtitle-clips')).clips as { text: string; start_shot_order: number }[]
    expect(clips.map(clip => clip.start_shot_order)).toEqual(expect.arrayContaining([1, 2]))

    const first = await draft()
    expect(first).toMatchObject({ refused: [], needs_review: [], music_missing: [1] })
    expect(first).not.toHaveProperty('unsupported')
    const path = (first.created as { path: string }[])[0]!.path
    expect(path.startsWith(drafts)).toBe(true)
    const linked = await readdir(join(path, 'media'))
    expect(linked).toHaveLength(2)
    const generated = await readdir(join(root, 'generated'))
    for (const name of linked) {
      const inode = (await stat(join(path, 'media', name))).ino
      expect(await Promise.all(generated.map(async file => (await stat(join(root, 'generated', file))).ino))).toContain(inode)
    }
    expect((await stat(join(path, 'draft_cover.jpg'))).size).toBeGreaterThan(0)
    const content = await readFile(join(path, 'draft_content.json'), 'utf8')
    expect(content).not.toContain('__SFMAT__')
    expect(content).toContain(`${path}/media/`)
    expect(await draft()).toMatchObject({ created: [], existing: [{ episode: 1, path }] })

    await studio('/__test/shots/2/video', { file: files[2] })
    expect(await draft()).toMatchObject({ created: [], refused: [{ episode: 1, reason: 'subtitles_stale', changed_shots: [2] }],
      next: { tool: 'episode_subtitles', args: { method: 'build', source: 'jingliu', episodes: [1] } } })
    expect(await subtitles()).toMatchObject({ status: 'waiting', changed: { 1: [2] } })
    expect(gateway.submits.slice(1)).toEqual([[sha(await readFile(files[2]!))]])
    gateway.complete()
    expect(['ready', 'needs_review']).toContain((await subtitles()).status)
    const second = await draft()
    expect(second).toMatchObject({ refused: [], created: [{ episode: 1 }] })
    expect((second.created as { path: string }[])[0]!.path).not.toBe(path)

    // A row from before the subtitle columns may be hand-added: both tools ask, and nothing replaces it unasked.
    const legacy = await studio('/__test/subtitles/legacy', { order: 1, text: '老字幕' })
    await studio('/v2/subtitle-clips', { project_id: 'p1', text: '三年后', start_shot_order: 1, start_offset_sec: 0, duration: 2 })
    const asked = await draft()
    expect(asked).toMatchObject({ created: [], refused: [{ episode: 1, reason: 'subtitles_unverified', shots: [1] }],
      ask: { keep: { args: { keep_legacy_subtitles: true } }, remake: { args: { replace_legacy: true } } } })
    expect(asked).not.toHaveProperty('next')
    expect(await subtitles()).toMatchObject({ status: 'needs_choice', unverified: [{ episode: 1, shots: [1] }] })
    const kept = await run('jianying_draft', { source: 'jingliu', project: 'p1', episodes: [1], drafts_dir: drafts, keep_legacy_subtitles: true })
    expect(kept).toMatchObject({ refused: [], created: [{ episode: 1 }] })
    expect(await readFile(join((kept.created as { path: string }[])[0]!.path, 'draft_content.json'), 'utf8')).toContain('老字幕')

    const remade = await subtitles({ replace_legacy: true })
    expect(remade.status).toBe('needs_review')
    const overlap = await subtitles({ method: 'review' })
    expect((overlap.items as { kind: string; script: string }[]).filter(item => item.kind === 'manual_overlap').map(item => item.script))
      .toContain('三年后')
    const texts = ((await studio('/v2/projects/p1/subtitle-clips')).clips as { id: string; text: string; origin: string | null }[])
    expect(texts.find(clip => clip.id === legacy.id)).toBeUndefined()
    expect(texts.filter(clip => clip.origin === 'manual').map(clip => clip.text)).toEqual(['三年后'])
  } finally {
    await ctx.fiber.dispose()
    server.kill()
    if (previousToken === undefined) delete process.env.MUSE_JINGLIU_SESSION_TOKEN
    else process.env.MUSE_JINGLIU_SESSION_TOKEN = previousToken
    await new Promise((done) => { if (server.exitCode !== null || server.signalCode !== null) done(undefined); else server.once('exit', done) })
    await rm(base, { recursive: true, force: true })
  }
}, 600_000)
