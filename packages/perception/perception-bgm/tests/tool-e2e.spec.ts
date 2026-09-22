/**
 * End-to-end exercise of the `bgm_match` tool itself: index a real directory, then
 * rank against two known extremes.
 *
 * The earlier end-to-end suite proves the worker reproduces the model's numbers.
 * This one proves the tool around it does something useful with them — that
 * indexing writes a resumable index, and that `match` ranks by measured distance
 * rather than returning an arbitrary order. The two query points are chosen from
 * opposite corners of the library on purpose: a matcher that ignored its arguments
 * would still pass a single-query check.
 *
 * Same environment variables as `e2e.spec.ts`; skips where the model is absent.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, inject } from '../src/index.ts'

const python = process.env.DSH_PERCEPTION_PYTHON ?? ''
const weights = process.env.DSH_PERCEPTION_WEIGHTS ?? ''
const audioDir = process.env.DSH_PERCEPTION_E2E_DIR ?? ''
const dataDir = process.env.DSH_PERCEPTION_DATA_DIR ?? ''
const indexPath = join(audioDir, 'tool-index.json')
const ready = python !== '' && weights !== '' && audioDir !== '' && dataDir !== ''

interface Candidate { path: string; valence: number; arousal: number; distance: number }
interface IndexResult {
  scanned: number
  indexed: number
  analysed: number
  unchanged: number
  failures: { path: string; error: string }[]
}
interface MatchResult { candidates: Candidate[]; evaluated_tracks: number }

/** Pull the registered definition's execute out of a mounted plugin. */
async function mountTool(): Promise<(args: Record<string, unknown>) => Promise<unknown>> {
  const ctx = new Context()
  let definition: { execute: (args: unknown, exec: unknown) => Promise<unknown> } | undefined
  ctx.provide('tools', {
    register: (registered: unknown) => {
      definition = registered as typeof definition
      return () => {}
    },
  })
  await ctx.plugin({ apply, inject, name: 'perception-bgm' },
    { pythonExecutable: python, weightsPath: weights, dataDir, indexPath, callTimeoutMs: 600000 })
  if (definition === undefined) throw new Error('bgm_match registered nothing')
  const captured = definition
  return async args => await captured.execute(args, { signal: undefined })
}

let run: (args: Record<string, unknown>) => Promise<unknown>

describe.skipIf(!ready)('bgm_match tool end to end', () => {
  beforeAll(async () => {
    process.env.HF_HUB_OFFLINE = '1'
    await rm(indexPath, { force: true })
    run = await mountTool()
  }, 120000)

  afterAll(async () => { await rm(indexPath, { force: true }) })

  it('indexes the directory, then re-indexes without redoing the work', async () => {
    const first = await run({ method: 'index', directory: audioDir }) as IndexResult
    console.log('first index:', JSON.stringify(first))
    // The known-crash file is in this directory, so a failure entry would show the
    // fix did not hold on a real run.
    expect(first.failures).toEqual([])
    expect(first.analysed).toBeGreaterThanOrEqual(6)
    expect(first.unchanged).toBe(0)

    const second = await run({ method: 'index', directory: audioDir }) as IndexResult
    console.log('second index:', JSON.stringify(second))
    expect(second.analysed).toBe(0)
    expect(second.unchanged).toBe(first.indexed)
  }, 1200000)

  it('ranks opposite query points to opposite ends of the library', async () => {
    // Lowest-valence, lowest-arousal corner.
    const calm = await run({ method: 'match', valence: 3.5, arousal: 2.2, limit: 3 }) as MatchResult
    // Highest-valence, highest-arousal corner.
    const lively = await run({ method: 'match', valence: 7.2, arousal: 7.0, limit: 3 }) as MatchResult

    const calmTop = calm.candidates[0]
    const livelyTop = lively.candidates[0]
    console.log('calm top  :', JSON.stringify(calmTop))
    console.log('lively top:', JSON.stringify(livelyTop))

    expect(calm.evaluated_tracks).toBeGreaterThanOrEqual(6)
    expect(calmTop).toBeDefined()
    expect(livelyTop).toBeDefined()
    // The library's measured extremes: sad_low_arousal sits at v3.99/a2.27 and
    // upbeat_funk at v7.18/a6.39, so the two queries must not return the same track.
    expect(calmTop?.path).not.toBe(livelyTop?.path)
    expect(calmTop?.arousal).toBeLessThan(livelyTop?.arousal ?? 0)
    expect(calmTop?.valence).toBeLessThan(livelyTop?.valence ?? 0)
    // And the winner must actually be the nearest one, not merely the first row.
    for (const candidate of calm.candidates) {
      expect(candidate.distance).toBeGreaterThanOrEqual(calmTop?.distance ?? 0)
    }
  }, 120000)
})
