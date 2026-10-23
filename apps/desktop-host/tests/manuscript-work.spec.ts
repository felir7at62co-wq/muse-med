/** Actual files reproduce insertion, hook, nonadjacent-event, and adopted-version failures. */
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Config } from '../src/manuscript-revisions.ts'
import { ManuscriptWork } from '../src/manuscript-work.ts'
import { manuscriptRepetitions, manuscriptScenes } from '../src/manuscript-scenes.ts'

const roots: string[] = [], signal = new AbortController().signal
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const sceneSchema = z.object({ id: z.string(), text: z.string(), sha256: z.string() })
const reportSchema = z.object({ version: z.string(), semantic_assessment: z.string(), scenes: z.array(sceneSchema.omit({ text: true })),
  literal_repetitions: z.object({ findings: z.array(z.object({ kind: z.string() })), total: z.number(), omitted: z.number() }),
  changes: z.array(z.unknown()), invalidated_event_notes: z.number(), repeated_advance_events: z.array(z.unknown()) })
const parse = (text: string) => reportSchema.parse(JSON.parse(text))

async function fixture(text: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'manuscript-work-')); roots.push(cwd)
  await writeFile(join(cwd, 'source.txt'), '顾淮进门问好。\n他约定体检后离开。\n林悦被带走，警车驶离。\n程父决定先查孙永茂。')
  await writeFile(join(cwd, 'current.md'), text)
  const work = new ManuscriptWork(Config({}))
  const request = (args: object) => work.request(args, cwd, SessionId('session-A'), signal)
  const bind = (paths = ['current.md']) => request({ action: 'bind', task_key: '换梗', mode: 'adapt',
    source_paths: ['source.txt'], candidate_paths: paths })
  return { cwd, work, request, bind }
}

it('returns the complete scene and neighbors before proposing replacement, preserving the adopted file', async () => {
  const f = await fixture('第6集\n6-1 客厅 日 内\n▲顾淮进门问好。\n顾淮：今晚做体检。\n▲他转身离开。\n▲顾淮又进门向长辈问好。\n【集尾钩子】\n▲程父走向书房。\n第7集\n7-1 书房 夜 内\n▲程父拿起电话。')
  const report = parse(await f.bind())
  const context = z.object({ current: sceneSchema, next: sceneSchema.nullable() }).parse(JSON.parse(await f.request({ action: 'scene', scene_id: report.scenes[0]!.id })))
  expect(context.current.text).toContain('他转身离开')
  expect(context.current.text).toContain('顾淮又进门')
  expect(context.current.text).not.toContain('第6集')
  expect(context.next?.text).toContain('拿起电话')
  const replacement = context.current.text.replace('▲顾淮又进门向长辈问好。\n', '')
  const proposed = z.object({ state: z.string(), before: z.string(), after: z.string() }).parse(JSON.parse(
    await f.request({ action: 'propose_scene', scene_id: context.current.id, expected_sha256: context.current.sha256, replacement })))
  expect(proposed.state).toBe('proposed_not_written')
  expect(proposed.before).toBe(context.current.text)
  expect(proposed.after).toBe(replacement)
  expect(await readFile(join(f.cwd, 'current.md'), 'utf8')).toContain('顾淮又进门')
  await writeFile(join(f.cwd, 'current.md'), (await readFile(join(f.cwd, 'current.md'), 'utf8')).replace(context.current.text, replacement))
  const notice = await f.work.refresh(f.cwd, SessionId('session-A'), signal)
  expect(await readFile(join(f.cwd, 'current.md'), 'utf8')).toContain('第6集')
  expect(notice).toContain('顾淮又进门')
  expect(notice).toContain('before_sha256')
  expect(await f.work.refresh(f.cwd, SessionId('session-A'), signal)).toBeUndefined()
  await expect(f.request({ action: 'propose_scene', scene_id: context.current.id,
    expected_sha256: context.current.sha256, replacement })).rejects.toThrow('MANUSCRIPT_SCENE_STALE')
})

it('identifies body-hook and nonadjacent episode wording without claiming paraphrase or semantic coverage', () => {
  const text = '第7集\n7-1 书房 日 内\n程父：先查孙永茂，一件一件来，事情必须查清楚。\n【集尾钩子】\n程父：先查孙永茂，一件一件来，事情必须查清楚。\n第46集\n46-1 门口 日 外\n▲林悦被带走，警车离开小区，车门重重关上。\n第47集\n47-1 客厅 日 内\n▲他放下茶杯。\n第48集\n48-1 门口 日 外\n▲林悦被带走，警车离开小区，车门重重关上。'
  const result = manuscriptRepetitions(manuscriptScenes(text), 12, 40)
  expect(result.findings.map(entry => entry.kind)).toContain('body_hook')
  expect(result.findings.some(entry => entry.first.episode === '46' && entry.second.episode === '48')).toBe(true)
  expect(manuscriptRepetitions(manuscriptScenes(text), 12, 1).omitted).toBeGreaterThan(0)
})

it('carries exact adopted-return bytes across resume and does not choose the newest historical file', async () => {
  const f = await fixture('第1集\n1-1 客厅 日 内\n甲：保留用户返稿。')
  const first = parse(await f.bind())
  await writeFile(join(f.cwd, 'old-v8.md'), '第1集\n甲：已删除的旧话。')
  const resumed = new ManuscriptWork(Config({}))
  const result = parse(await resumed.request({ action: 'audit' }, f.cwd, SessionId('session-A'), signal))
  expect(result.version).toBe(first.version)
  expect(await resumed.request({ action: 'scene', scene_id: result.scenes[0]!.id }, f.cwd, SessionId('session-A'), signal)).toContain('保留用户返稿')
  expect(await resumed.refresh(f.cwd, SessionId('session-B'), signal)).toBeUndefined()
  expect(await resumed.refresh(f.cwd, SessionId('session-A'), signal, true)).toContain('版本未变，不重复查重')
  expect(await resumed.refresh(f.cwd, SessionId('session-A'), signal, true)).toContain('current.md')
  await writeFile(join(f.cwd, 'returned-v6.md'), '第1集\n1-1 客厅 日 内\n甲：最新明确采用返稿。')
  const next = parse(await f.bind(['returned-v6.md']))
  expect(await f.request({ action: 'scene', scene_id: next.scenes[0]!.id })).toContain('最新明确采用返稿')
  const dir = join(f.cwd, '.muse', 'manuscript-work')
  const sessions = await readdir(dir)
  const history = await readdir(join(dir, sessions[0]!, 'history'))
  expect(history.length).toBeGreaterThanOrEqual(3)
})

it('records quote-bound event purposes, invalidates changed scenes and permits explicit recaps', async () => {
  const f = await fixture('第46集\n46-1 门口 日 外\n▲林悦被带走。\n第48集\n48-1 客厅 日 内\n甲：她已被带走。')
  const report = parse(await f.bind())
  const note = { event_id: '被带走', scene_id: report.scenes[0]!.id, quote: '林悦被带走',
    source_quote: '林悦被带走，警车驶离。', source_path: 'source.txt', purpose: 'advance', end_state: '已离开现场' }
  await f.request({ action: 'event', event: note })
  const duplicate = parse(await f.request({ action: 'event', event: { ...note, scene_id: report.scenes[1]!.id, quote: '她已被带走' } }))
  expect(duplicate.repeated_advance_events).toHaveLength(1)
  const recap = parse(await f.request({ action: 'event', event: { ...note, scene_id: report.scenes[1]!.id,
    quote: '她已被带走', purpose: 'recap' } }))
  expect(recap.repeated_advance_events).toHaveLength(0)
  await expect(f.request({ action: 'event', event: { ...note, source_quote: '凭空出现的证据' } })).rejects.toThrow('MANUSCRIPT_EVENT_QUOTE')
  await writeFile(join(f.cwd, 'current.md'), '第46集\n46-1 门口 日 外\n▲林悦站在门口。')
  const invalidated = parse(await f.request({ action: 'audit' }))
  expect(invalidated.invalidated_event_notes).toBe(2)
  expect(invalidated.semantic_assessment).toBe('not_performed')
})

it('separates faithful video transcription from adaptation and watches a future shell-written file', async () => {
  const f = await fixture('暂存')
  const bind = z.object({ missing_files: z.array(z.string()) }).parse(JSON.parse(await f.request({ action: 'bind', task_key: '视频', mode: 'transcribe',
    source_paths: ['source.txt'], candidate_paths: ['new.md'] })))
  expect(bind.missing_files).toHaveLength(1)
  expect(bind).not.toHaveProperty('growth_assessment')
  await writeFile(join(f.cwd, 'new.md'), '第1集\n1-1 家 日 内\n甲：新的实际稿。')
  expect(await f.work.refresh(f.cwd, SessionId('session-A'), signal)).toContain('new.md')
  expect(await f.work.refresh(f.cwd, SessionId('session-A'), signal)).toBeUndefined()
  expect(await readFile(join(f.cwd, 'source.txt'), 'utf8')).toContain('顾淮进门问好')
})

it('returns exact selected source lines and expires notes after a source change', async () => {
  const f = await fixture('第6集\n6-1 客厅 日 内\n▲顾淮进门问好。\n6-2 走廊 日 内\n▲他转身离开。')
  const bound = parse(await f.bind())
  const scene = z.object({ source_alignment: z.string(), source_excerpts: z.array(z.object({ text: z.string() })) }).parse(
    JSON.parse(await f.request({ action: 'scene', scene_id: bound.scenes[0]!.id,
      source_ranges: [{ path: 'source.txt', start_line: 1, end_line: 2 }] })))
  expect(scene.source_excerpts[0]?.text).toBe('顾淮进门问好。\n他约定体检后离开。')
  expect(scene.source_alignment).toBe('model_selected_ranges')
  await expect(f.request({ action: 'scene', scene_id: bound.scenes[0]!.id,
    source_ranges: [{ path: 'source.txt', start_line: 1, end_line: 100 }] })).rejects.toThrow('MANUSCRIPT_SOURCE_RANGE')
  await f.request({ action: 'event', event: { event_id: '初次见面', scene_id: bound.scenes[0]!.id,
    quote: '顾淮进门问好', source_quote: '顾淮进门问好。', source_path: 'source.txt', purpose: 'advance', end_state: '人在客厅' } })
  await writeFile(join(f.cwd, 'source.txt'), '顾淮已离开。')
  const changed = parse(await f.request({ action: 'audit' }))
  expect(changed.invalidated_event_notes).toBe(1)
})

it('keeps unedited later scene identities after adding lines to an earlier scene', async () => {
  const before = manuscriptScenes('第1集\n1-1 客厅 日 内\n▲她坐下。\n1-2 门口 日 外\n▲他出门。')
  const after = manuscriptScenes('第1集\n1-1 客厅 日 内\n▲她坐下。\n甲：等一下。\n1-2 门口 日 外\n▲他出门。')
  expect(after[1]?.id).toBe(before[1]?.id)
  expect(after[1]?.sha256).toBe(before[1]?.sha256)
})

it('sends actual changed passages without copying both complete manuscripts back into context', async () => {
  const body = Array.from({ length: 400 }, (_, i) => `▲第${i}行，他看向窗外等待消息。`).join('\n')
  const f = await fixture('第1集\n1-1 家 日 内\n' + body)
  await f.bind()
  const before = await readFile(join(f.cwd, 'current.md'), 'utf8')
  await writeFile(join(f.cwd, 'current.md'), before.replace('▲第200行，他看向窗外等待消息。', '▲他接起电话，朝门口走去。'))
  const notice = await f.work.refresh(f.cwd, SessionId('session-A'), signal)
  expect(notice).toContain('第200行')
  expect(notice).toContain('他接起电话')
  expect(notice).not.toContain('第199行')
  expect(notice).not.toContain('第201行')
  expect(notice?.length).toBeLessThan(2000)
})
