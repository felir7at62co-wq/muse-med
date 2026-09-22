/**
 * End-to-end verification of the BGM path against the real model.
 *
 * This drives the **real** `EmotionWorker` over the **real** Python worker with the
 * **real** MERT backbone; nothing here is stubbed. It exists because a unit-tested
 * protocol can still be wired to the wrong pipeline, and because the crash fix has
 * to hold on the same file that breaks upstream.
 *
 * Prerequisites, all provided by environment variables so the suite skips cleanly
 * where the model is absent:
 *   DSH_PERCEPTION_PYTHON   absolute path to the Python with the model's deps
 *   DSH_PERCEPTION_WEIGHTS  absolute path to J_all.ckpt
 *   DSH_PERCEPTION_E2E_DIR  directory of staged audio with its expected.json
 *
 * Expected values come from the library measurement that the differential test
 * validated against upstream, so they are not self-referential.
 */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EmotionWorker } from '../src/worker.ts'

const python = process.env.DSH_PERCEPTION_PYTHON ?? ''
const weights = process.env.DSH_PERCEPTION_WEIGHTS ?? ''
const audioDir = process.env.DSH_PERCEPTION_E2E_DIR ?? ''
const dataDir = process.env.DSH_PERCEPTION_DATA_DIR ?? ''
const scriptPath = join(import.meta.dirname, '..', 'python', 'worker_main.py')
const indexPath = join(audioDir, 'e2e-index.json')

const ready = python !== '' && weights !== '' && audioDir !== '' && dataDir !== ''

interface Expected { source_name: string; valence: number; arousal: number }
interface Analysis { valence: number; arousal: number; moods: string[]; dropped_trailing_samples: number }

let worker: EmotionWorker
let expected: Record<string, Expected>

describe.skipIf(!ready)('BGM end to end (real model)', () => {
  beforeAll(async () => {
    expected = JSON.parse(await readFile(join(audioDir, 'expected.json'), 'utf8')) as Record<string, Expected>
    await rm(indexPath, { force: true })
    worker = new EmotionWorker({ pythonExecutable: python, scriptPath,
      env: { HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' }, callTimeoutMs: 600000 })
    const handshake = await worker.start()
    expect(handshake.ready, `worker missing: ${handshake.missing.join(', ')}`).toBe(true)
  }, 300000)

  afterAll(async () => { await worker?.dispose() })

  it('reproduces the measured numbers for every staged track', async () => {
    const failures: string[] = []
    for (const [file, want] of Object.entries(expected)) {
      const got = await worker.call('analyse', { audio_path: join(audioDir, file),
        weights_path: weights, data_dir: dataDir }) as Analysis
      const dv = Math.abs(got.valence - want.valence)
      const da = Math.abs(got.arousal - want.arousal)
      const ok = dv < 0.01 && da < 0.01
      console.log(`${file.padEnd(26)} got v=${got.valence.toFixed(3)} a=${got.arousal.toFixed(3)} `
        + `want v=${want.valence} a=${want.arousal} ${ok ? 'OK' : 'MISMATCH'}`)
      if (!ok) failures.push(`${file}: v delta ${dv.toFixed(4)}, a delta ${da.toFixed(4)}`)
    }
    expect(failures).toEqual([])
  }, 900000)

  it('analyses the file that makes upstream crash, and reports the dropped tail', async () => {
    const crashCase = join(audioDir, 'zz_known_crash_case.mp3')
    const got = await worker.call('analyse', { audio_path: crashCase,
      weights_path: weights, data_dir: dataDir }) as Analysis
    // 706 samples is the 0.12 s remainder that collapses upstream's tensor axes.
    expect(got.dropped_trailing_samples).toBe(706)
    expect(got.valence).toBeGreaterThan(1)
    expect(got.valence).toBeLessThan(9)
    expect(got.arousal).toBeGreaterThan(1)
    expect(got.arousal).toBeLessThan(9)
  }, 600000)
})
