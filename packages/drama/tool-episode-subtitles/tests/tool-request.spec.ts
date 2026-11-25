import { basename, dirname } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { runEpisodeSubtitles, type EpisodeSubtitlesArgs } from '../src/tool.ts'
import { fakeRules, gateway, project, services, settings } from './fixture.ts'

const local: EpisodeSubtitlesArgs = { source: 'local', project: 'film', episodes: [1] }

async function fixture(shots = 1) {
  const f = await project(shots)
  onTestFinished(f.cleanup)
  const g = gateway(f.root, f.script)
  const deps = services(g.account, fakeRules())
  return { f, g, deps }
}

it('rejects invalid request fields before accessing the project workspace or starting recognition', async () => {
  const { g, deps } = await fixture()
  for (const [overrides, message] of [
    [{ episodes: [] }, 'episodes must list'],
    [{ episodes: [0, 1.5] }, 'episodes must be positive integers'],
    [{ episodes: [1, 1] }, 'episodes must not repeat'],
    [{ wait_seconds: Number.NaN }, 'wait_seconds must be 0 to 30'],
    [{ wait_seconds: -1 }, 'wait_seconds must be 0 to 30'],
    [{ wait_seconds: 31 }, 'wait_seconds must be 0 to 30'],
    [{ method: 'review', offset: 0.5 }, 'offset must be a non-negative integer'],
    [{ method: 'review', offset: -1 }, 'offset must be a non-negative integer'],
    [{ method: 'build', decisions: [] }, 'decisions and offset belong to method review'],
    [{ method: 'build', replace_legacy: true }, 'replace_legacy belongs to method build of source jingliu'],
    [{ method: 'review', source: 'jingliu', replace_legacy: true }, 'replace_legacy belongs to method build of source jingliu'],
    [{ project: ' ' }, 'project must name a project'],
    [{ source: 'jingliu' }, 'source jingliu needs a Session workspace'],
    [{ source: 'local' }, 'pass an absolute project path'],
  ] satisfies [Partial<EpisodeSubtitlesArgs>, string][]) {
    await expect(runEpisodeSubtitles({ ...local, ...overrides }, settings, deps)).rejects.toThrow(message)
  }
  expect(g.submits).toEqual([])
})

it('resolves a relative workspace path and reports review as blocked for an episode without packages', async () => {
  const { f, g, deps } = await fixture()
  const args = { ...local, project: basename(f.root), method: 'review' as const, episodes: [1, 2] }
  const job = { ...deps, cwd: dirname(f.root) }
  const result = await runEpisodeSubtitles({ ...args, decisions: [] }, settings, job)
  expect(result).toMatchObject({ pending: 0, items: [], applied: 0, blocked: [{ episode: 2, reason: 'package_missing' }] })
  expect(result).not.toHaveProperty('next')
  await expect(runEpisodeSubtitles({ ...args, decisions: [{ id: 'before-review', action: 'drop' }] }, settings, job))
    .resolves.toMatchObject({ applied: 0, unknown: ['before-review'], blocked: [{ episode: 2, reason: 'package_missing' }] })
  expect(g.submits).toEqual([])
})

it('reports unavailable Jingliu and respects cancellation without submitting recognition', async () => {
  const { f, g, deps } = await fixture()
  const result = await runEpisodeSubtitles({ ...local, source: 'jingliu', wait_seconds: 0 }, settings,
    { account: deps.account, rules: deps.rules, cwd: f.root }, new AbortController().signal)
  expect(result).toMatchObject({ status: 'blocked', blocked: [{ episode: 1, reason: 'jingliu_outdated' }] })
  const cancelled = new Error('Cancelled before allocating a subtitle writer')
  await expect(runEpisodeSubtitles({ ...local, project: f.root }, settings, deps, AbortSignal.abort(cancelled))).rejects.toBe(cancelled)
  expect(g.submits).toEqual([])
})

it('pages unresolved items and merges multiple decisions for one episode without new recognition', async () => {
  const { f, g, deps } = await fixture(2)
  await f.speak(1, '好吗')
  await f.speak(2, '去吗')
  const args = { ...local, project: f.root }
  await runEpisodeSubtitles(args, settings, deps)
  g.complete()
  await runEpisodeSubtitles(args, settings, deps)
  const config = { ...settings, reviewPageSize: 1 }
  const first = await runEpisodeSubtitles({ ...args, method: 'review', offset: 0 }, config, deps)
  expect(first).toMatchObject({ pending: 2, next_offset: 1, items: [{ shot: 1, heard: '吗' }] })
  const next = await runEpisodeSubtitles({ ...args, method: 'review', offset: 1 }, config, deps)
  expect(next).toMatchObject({ pending: 2, items: [{ shot: 2, heard: '吗' }] })
  const [{ id: firstId }] = first.items as [{ id: string }]
  const [{ id: secondId }] = next.items as [{ id: string }]
  const updated = await runEpisodeSubtitles({ ...args, method: 'review', decisions: [
    { id: firstId, action: 'drop' }, { id: secondId, action: 'heard' },
  ] }, config, deps)
  expect(updated).toMatchObject({ pending: 0, items: [], applied: 2, status: 'ready', next: { tool: 'jianying_draft' } })
  expect(g.submits).toHaveLength(1)
})
