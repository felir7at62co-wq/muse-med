import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { localEpisodeSelection } from '@deepseek-ai/dsh-tool-episode-subtitles/selection'
import { expect, it, onTestFinished } from 'vitest'
import { writeDecisions } from '../src/build.ts'
import { project, toolkit } from './fixture.ts'

it('returns the current clock and subtitle input digests for an approved draft', async () => {
  const f = await project(1)
  onTestFinished(f.cleanup)
  const initial = await localEpisodeSelection(f.root, 1, toolkit)
  if (initial.kind !== 'ok') throw new Error('Expected one approved shot')
  expect(initial.manifest).toBe(join(f.root, 'editing', '01-shots.json'))
  expect(JSON.parse(await readFile(initial.manifest, 'utf8'))).toMatchObject({ shots: [{ shot: 1, package: 1 }] })
  expect(initial.clock).toMatchObject([{ durationUs: 3_000_000 }])
  expect(initial.inputs.rules_sha256).toMatch(/^[0-9a-f]{64}$/u)

  await f.editLine(1, '林晨换了这句台词')
  await writeDecisions(join(f.root, 'subtitles', '01.decisions.json'), new Map([['selected-cue', 'script']]))
  const edited = await localEpisodeSelection(f.root, 1, toolkit)
  if (edited.kind !== 'ok') throw new Error('Expected the updated approval')
  expect(edited.inputs.lines_sha256).not.toBe(initial.inputs.lines_sha256)
  expect(edited.inputs.decisions_sha256).not.toBe(initial.inputs.decisions_sha256)
  expect(edited.inputs.names_sha256).toBe(initial.inputs.names_sha256)
  expect(edited.inputs.rules_sha256).toBe(initial.inputs.rules_sha256)
  expect(edited.clock).toEqual(initial.clock)
})

it('returns the affected package when its shot approval is missing', async () => {
  const f = await project(2)
  onTestFinished(f.cleanup)
  await unlink(join(f.root, 'reviews', 'ep01-p02.json'))
  await expect(localEpisodeSelection(f.root, 1, toolkit)).resolves.toMatchObject({
    kind: 'blocked', reason: 'selection_missing', shots: [2],
  })
  await expect(readFile(join(f.root, 'editing', '01-shots.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
