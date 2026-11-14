/** Required performance budgets for compiled Client history folding and live Assistant updates. */

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  runBuiltBenchmarkWorker,
  type BuiltBenchmarkWorkerRun,
} from '../support/built-worker.ts'
import {
  ciTimeBudget,
  PERFORMANCE_BUDGET_HEADROOM,
} from '../support/calibration.ts'
import { recordPeakMemory, recordTimings, type BenchmarkCase } from '../support/scaling-report.ts'
import type { ConversationFoldWorkerReport, PreparingToolWorkerReport, StreamingAssistantWorkerReport } from './conversation-fold.worker.client.ts'
import { accumulatedTrimControl } from './accumulated-trim-control.client.ts'

/** Replies in the folded window; each carries one reasoning block and one text block. */
const TURNS = 200
/** Text deltas per reply in the large workload; each reply adds one quarter as many reasoning deltas. */
const LARGE_DELTAS = 2_000
/** Text deltas per reply in the small workload used as the scaling reference. */
const SMALL_DELTAS = 100
/** Fresh object graphs measured in one compiled worker; the fastest sample removes scheduler delay. */
const ATTEMPTS = 3
/** Folding and argument preparation run on in-memory Client state without storage access. */
const IO_SHARE = 0
const LARGE_WINDOW_CASE: BenchmarkCase = {
  id: 'conversation-fold/large-window',
  measures: 'Client fold of 200 replies whose 500,000 streamed deltas are compacted into 1,600 records.',
  affects: 'Opening or scrolling a long conversation in the Web GUI.',
}
const PREPARING_AFFECTS = { write: 'Watching the model stream a large file write.', bash: 'Watching the model stream a long shell command.' } as const
/** A stuck fold worker is reaped before the outer benchmark deadline. */
const WORKER_TIMEOUT_MS = 60_000

/**
 * The large window contains 500,000 streamed deltas compacted into 1,600
 * stream records. The budget separates the record-proportional fold from the
 * per-delta replay that needs hundreds of milliseconds for the same window.
 */
const EXPECTED_LARGE_FOLD_MS = 16
const LARGE_FOLD_BUDGET_MS = ciTimeBudget(EXPECTED_LARGE_FOLD_MS)

/**
 * Both windows contain equal event and compact-record counts. A fold over
 * records plus joined text measures about 2.5×; replaying every delta measures
 * about 11× as the delta count grows 20×.
 */
const EXPECTED_DELTA_SCALING = 2.5
const MAX_DELTA_SCALING = EXPECTED_DELTA_SCALING * PERFORMANCE_BUDGET_HEADROOM

const PREPARING_SAMPLES = 3
const PREPARING_CASES = [
  { tool: 'write', characters: 512 * 1024, expectedMs: 300, expectedMb: 30 },
  { tool: 'bash', characters: 128 * 1024, expectedMs: 150, expectedMb: 8 },
] as const

const STREAMING_CHARACTERS = 256 * 1024
const STREAMING_SAMPLES = 5
/** Fixed hosted expectations from repeated Node 24 / EPYC 7763 runs; only variance headroom applies. */
const STREAMING_WORKLOADS = [
  { fragments: 4_096, hostedExpectedMs: 32 },
  { fragments: 16_384, hostedExpectedMs: 91 },
] as const
const STREAMING_CASES = STREAMING_WORKLOADS.flatMap(workload => [
  { ...workload, blockType: 'text', pattern: 'ordinary' },
  { ...workload, blockType: 'reasoning', pattern: 'leading-whitespace' },
] as const)
/** Incremental heap while the Assembler, live entries, and published Chat state remain reachable. */
const EXPECTED_STREAMING_RETAINED_MB = 16

const SAVED_STREAMING_SAMPLES = [
  { run: 43370634776, fragments: 4096, kind: 'text', oldRejected: false, ms: [17.299061, 16.993920, 20.017342, 15.694259, 16.333243] },
  { run: 43370634776, fragments: 4096, kind: 'reasoning', oldRejected: false, ms: [16.380034, 17.258989, 18.557809, 23.578856, 41.131609] },
  { run: 43370634776, fragments: 16384, kind: 'text', oldRejected: false, ms: [55.041406, 54.476473, 54.315240, 51.992727, 54.596674] },
  { run: 43370634776, fragments: 16384, kind: 'reasoning', oldRejected: false, ms: [55.329510, 53.360640, 56.109177, 51.706623, 55.000203] },
  { run: 43385079062, fragments: 4096, kind: 'text', oldRejected: false, ms: [30.038195, 30.896053, 28.196559, 29.410911, 29.981384] },
  { run: 43385079062, fragments: 4096, kind: 'reasoning', oldRejected: true, ms: [29.325101, 35.061291, 31.806474, 32.092482, 29.500841] },
  { run: 43385079062, fragments: 16384, kind: 'text', oldRejected: true, ms: [88.945825, 87.864694, 92.414745, 84.672063, 82.491105] },
  { run: 43385079062, fragments: 16384, kind: 'reasoning', oldRejected: true, ms: [92.027728, 92.045491, 89.921680, 90.825057, 86.753776] },
  { run: 43401713553, fragments: 4096, kind: 'text', oldRejected: false, ms: [28.196195, 27.627897, 27.296975, 28.649976, 27.619551] },
  { run: 43401713553, fragments: 4096, kind: 'reasoning', oldRejected: false, ms: [27.273991, 30.118435, 28.415957, 31.435210, 29.371072] },
  { run: 43401713553, fragments: 16384, kind: 'text', oldRejected: true, ms: [77.857506, 76.011959, 80.162063, 81.856289, 95.069183] },
  { run: 43401713553, fragments: 16384, kind: 'reasoning', oldRejected: true, ms: [80.359447, 80.644824, 84.838171, 80.610368, 81.092785] },
] as const

const WORKER = join(
  import.meta.dirname,
  '..',
  '.dsh-build',
  'conversation-fold',
  'conversation-fold.worker.js',
)

function requireReport<Report>(
  run: BuiltBenchmarkWorkerRun<Report>,
): Report {
  if (run.report !== undefined) return run.report
  const stderrLines = run.stderr.trim().split('\n')
  throw new Error(
    `conversation-fold worker failed: exit=${String(run.exitCode)}, signal=${String(run.signal)}, `
    + `timedOut=${String(run.timedOut)}\n${stderrLines.slice(-10).join('\n')}`,
  )
}

function streamingTimeBudget(hostedExpectedMs: number): number {
  return Math.ceil(hostedExpectedMs * PERFORMANCE_BUDGET_HEADROOM)
}

function expectStreamingWithinBudget(value: number, budget: number): void {
  expect(value).toBeLessThanOrEqual(budget)
}

describe('hosted streaming calibration controls', () => {
  it.each(SAVED_STREAMING_SAMPLES)('classifies run $run $fragments $kind samples against old and hosted limits', (saved) => {
    const workload = STREAMING_WORKLOADS.find(value => value.fragments === saved.fragments)!
    const median = saved.ms.toSorted((a, b) => a - b)[Math.floor(saved.ms.length / 2)]!
    const oldBudget = saved.fragments === 4096 ? 30 : 80
    const oldVerdict = () => expectStreamingWithinBudget(median, oldBudget)
    if (saved.oldRejected) expect(oldVerdict).toThrow()
    else oldVerdict()
    expectStreamingWithinBudget(median, streamingTimeBudget(workload.hostedExpectedMs))
  })

  it.each(STREAMING_WORKLOADS)('rejects the hosted limit plus one and a 50% slowdown at $fragments fragments', (workload) => {
    const budget = streamingTimeBudget(workload.hostedExpectedMs)
    expect(budget).toBe(workload.fragments === 4096 ? 40 : 114)
    expect(() => expectStreamingWithinBudget(budget + 1, budget)).toThrow()
    const slowest = Math.max(...SAVED_STREAMING_SAMPLES
      .filter(value => value.fragments === workload.fragments)
      .map(value => value.ms.toSorted((a, b) => a - b)[Math.floor(value.ms.length / 2)]!))
    expect(() => expectStreamingWithinBudget(slowest * 1.5, budget)).toThrow()
  })

  it('changes exactly the two compiled visibility expressions and preserves all other bytes', () => {
    const text = 'nextVisible = previous?.kind === "text" && previousVisible || chunk.text.trim() !== "";'
    const reasoning = 'nextVisible = previous?.kind === "reasoning" && previousVisible || chunk.text.trim() !== "";'
    const fixture = `before\n${text}\nbetween\n${reasoning}\nafter\n`
    expect(accumulatedTrimControl(fixture)).toBe('before\nnextVisible = blockIsVisible(blocks[chunk.index]);\nbetween\nnextVisible = blockIsVisible(blocks[chunk.index]);\nafter\n')
    for (const rejected of [text, reasoning, `${fixture}${text}`, `${fixture}${reasoning}`]) {
      expect(() => accumulatedTrimControl(rejected)).toThrow('exactly one compiled expression per block kind')
    }
  })
})

describe('cold Chat fold of a large v2 history window', () => {
  it(`folds ${String(TURNS)} replies with ${String(LARGE_DELTAS)} deltas each within ${String(LARGE_FOLD_BUDGET_MS)} ms and scales with compact records`, async () => {
    const report = requireReport(await runBuiltBenchmarkWorker<ConversationFoldWorkerReport>({
      worker: WORKER,
      args: [String(TURNS), String(SMALL_DELTAS), String(LARGE_DELTAS), String(ATTEMPTS)],
      timeoutMs: WORKER_TIMEOUT_MS,
    }))
    console.log(JSON.stringify({
      benchmark: 'conversation-fold/large-window',
      ...report,
      budgetMs: LARGE_FOLD_BUDGET_MS,
      maxScaling: MAX_DELTA_SCALING,
    }))
    recordTimings(LARGE_WINDOW_CASE, { largeFoldMs: { ms: report.largeFoldMs, ioShare: IO_SHARE } }, { largeFoldMs: LARGE_FOLD_BUDGET_MS })
    expect(report.chatNodes).toBeGreaterThan(0)
    expect(report.largeFoldMs).toBeLessThanOrEqual(LARGE_FOLD_BUDGET_MS)
    expect(report.scaling).toBeLessThanOrEqual(MAX_DELTA_SCALING)
  })
})

describe('preparing tool arguments', () => {
  it.each(PREPARING_CASES)('publishes streamed $tool arguments within bounded CPU and heap costs', async (workload) => {
    const samples: PreparingToolWorkerReport[] = []
    for (let index = 0; index < PREPARING_SAMPLES; index++) {
      const run = await runBuiltBenchmarkWorker<PreparingToolWorkerReport>({
        worker: WORKER, args: ['preparing', workload.tool, String(workload.characters)],
        exposeGc: true, timeoutMs: WORKER_TIMEOUT_MS,
      })
      expect(run.timedOut, run.stderr).toBe(false)
      expect(run.signal, run.stderr).toBeNull()
      expect(run.exitCode, run.stderr).toBe(0)
      const report = requireReport(run)
      expect(report.characters).toBe(workload.characters)
      if (workload.tool === 'write') {
        expect(report.progressKb).toBe(workload.characters / 1024)
        expect(report.filePath).toBe('preview.md')
      }
      expect(report.detail).toBe(workload.tool === 'write' ? 'preview.md' : `${'abcdefghijklmno '.repeat(10).slice(0, 159)}…`)
      samples.push(report)
    }
    const medianMs = samples.map(sample => sample.elapsedMs).toSorted((a, b) => a - b)[1]!
    const retainedMb = samples.map(sample => sample.retainedMb).toSorted((a, b) => a - b)[1]!
    const budgetMs = ciTimeBudget(workload.expectedMs)
    const budgetMb = workload.expectedMb * PERFORMANCE_BUDGET_HEADROOM
    console.log(JSON.stringify({ benchmark: `conversation-fold/preparing-${workload.tool}`, samples, medianMs, retainedMb, budgetMs, budgetMb }))
    recordTimings({
      id: `conversation-fold/preparing-${workload.tool}`,
      measures: `Client publishing of ${String(workload.characters / 1024)} KiB of streamed ${workload.tool} tool arguments.`,
      affects: PREPARING_AFFECTS[workload.tool],
    }, { medianMs: { ms: medianMs, ioShare: IO_SHARE } }, { medianMs: budgetMs })
    expect(medianMs).toBeLessThanOrEqual(budgetMs)
    expect(retainedMb).toBeLessThanOrEqual(budgetMb)
  })
})

describe('live Assistant text publication', () => {
  it.each(STREAMING_CASES)('publishes $fragments $blockType deltas with $pattern content within bounded CPU and heap costs', async (workload) => {
    const samples: StreamingAssistantWorkerReport[] = []
    for (let index = 0; index < STREAMING_SAMPLES; index++) {
      const run = await runBuiltBenchmarkWorker<StreamingAssistantWorkerReport>({
        worker: WORKER,
        args: ['streaming', workload.blockType, workload.pattern, String(STREAMING_CHARACTERS), String(workload.fragments)],
        exposeGc: true, timeoutMs: WORKER_TIMEOUT_MS,
      })
      expect(run.timedOut, run.stderr).toBe(false)
      expect(run.signal, run.stderr).toBeNull()
      expect(run.exitCode, run.stderr).toBe(0)
      const report = requireReport(run)
      expect(report.characters).toBe(STREAMING_CHARACTERS)
      expect(report.fragments).toBe(workload.fragments)
      samples.push(report)
    }
    const median = samples.toSorted((a, b) => a.elapsedMs - b.elapsedMs)[Math.floor(STREAMING_SAMPLES / 2)]!
    const retainedMb = samples.map(sample => sample.retainedMb).toSorted((a, b) => a - b)[Math.floor(STREAMING_SAMPLES / 2)]!
    const budgetMs = streamingTimeBudget(workload.hostedExpectedMs)
    const budgetMb = EXPECTED_STREAMING_RETAINED_MB * PERFORMANCE_BUDGET_HEADROOM
    const benchmarkCase: BenchmarkCase = {
      id: `conversation-fold/streaming-${workload.blockType}-${workload.pattern}-${String(workload.fragments)}`,
      measures: `Client append, final Chat publication, and complete text read for ${String(STREAMING_CHARACTERS / 1024)} KiB in ${String(workload.fragments)} ${workload.blockType} deltas with ${workload.pattern} content.`,
      affects: 'Local processing of a long active model response; excludes model pacing, network transport, and browser rendering.',
    }
    console.log(JSON.stringify({ benchmark: benchmarkCase.id, samples, medianMs: median.elapsedMs, retainedMb, budgetMs, budgetMb }))
    recordTimings(benchmarkCase, {
      medianMs: { ms: median.elapsedMs, cpuMs: median.cpuUserMs + median.cpuSystemMs },
    }, { medianMs: budgetMs })
    recordPeakMemory(benchmarkCase, { peakRssMb: Math.max(...samples.map(sample => sample.maxRssMb)) })
    expectStreamingWithinBudget(median.elapsedMs, budgetMs)
    expect(retainedMb).toBeLessThanOrEqual(budgetMb)
  })
})

describe('compiled accumulated-trim regression control', () => {
  it.each(STREAMING_WORKLOADS)('rejects accumulated trimming at $fragments ordinary-text fragments', async (workload) => {
    const source = await readFile(WORKER, 'utf8')
    const control = accumulatedTrimControl(source)
    const root = await mkdtemp(join(dirname(WORKER), 'accumulated-trim-'))
    try {
      const controlWorker = join(root, 'control.worker.js')
      await writeFile(controlWorker, control)
      const originalSha256 = createHash('sha256').update(source).digest('hex')
      const regressionSha256 = createHash('sha256').update(control).digest('hex')
      console.log(JSON.stringify({ benchmark: 'conversation-fold/accumulated-trim-control-build', fragments: workload.fragments, originalSha256, regressionSha256, replacements: 2 }))
      const original: StreamingAssistantWorkerReport[] = []
      const regression: StreamingAssistantWorkerReport[] = []
      for (let index = 0; index < STREAMING_SAMPLES; index++) {
        for (const worker of index % 2 === 0 ? [WORKER, controlWorker] : [controlWorker, WORKER]) {
          const run = await runBuiltBenchmarkWorker<StreamingAssistantWorkerReport>({
            worker,
            args: ['streaming', 'text', 'ordinary', String(STREAMING_CHARACTERS), String(workload.fragments)],
            exposeGc: true, timeoutMs: WORKER_TIMEOUT_MS,
          })
          expect(run.timedOut, run.stderr).toBe(false)
          expect(run.signal, run.stderr).toBeNull()
          expect(run.exitCode, run.stderr).toBe(0)
          const report = requireReport(run)
          expect(report.characters).toBe(STREAMING_CHARACTERS)
          expect(report.fragments).toBe(workload.fragments)
          const destination = worker === WORKER ? original : regression
          destination.push(report)
          console.log(JSON.stringify({ benchmark: 'conversation-fold/accumulated-trim-control-sample', variant: worker === WORKER ? 'original' : 'regression', attempt: index, ...report }))
        }
      }
      const ordered = (samples: readonly StreamingAssistantWorkerReport[]) => samples.toSorted((a, b) => a.elapsedMs - b.elapsedMs)
      const originalMedian = ordered(original)[Math.floor(STREAMING_SAMPLES / 2)]!
      const regressionMedian = ordered(regression)[Math.floor(STREAMING_SAMPLES / 2)]!
      const budgetMs = streamingTimeBudget(workload.hostedExpectedMs)
      const originalCase: BenchmarkCase = {
        id: `conversation-fold/accumulated-trim-original-${String(workload.fragments)}`,
        measures: `Unmodified production text publication paired with the accumulated-trim control at ${String(workload.fragments)} fragments.`,
        affects: 'Local processing of a long active model response; excludes model pacing, network transport, and browser rendering.',
      }
      recordTimings(originalCase, {
        medianMs: { ms: originalMedian.elapsedMs, cpuMs: originalMedian.cpuUserMs + originalMedian.cpuSystemMs },
      }, { medianMs: budgetMs })
      recordPeakMemory(originalCase, { peakRssMb: Math.max(...original.map(report => report.maxRssMb)) })
      console.log(JSON.stringify({
        benchmark: 'conversation-fold/accumulated-trim-control', fragments: workload.fragments,
        originalSha256, regressionSha256,
        replacements: 2, original, regression, originalMedianMs: originalMedian.elapsedMs,
        regressionMedianMs: regressionMedian.elapsedMs, budgetMs,
      }))
      expect(original.map(value => value.checksum)).toEqual(regression.map(value => value.checksum))
      expect(() => expectStreamingWithinBudget(regressionMedian.elapsedMs, budgetMs)).toThrow()
      expectStreamingWithinBudget(originalMedian.elapsedMs, budgetMs)
      for (const report of [...original, ...regression]) {
        expect(report.retainedMb).toBeLessThanOrEqual(EXPECTED_STREAMING_RETAINED_MB * PERFORMANCE_BUDGET_HEADROOM)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
