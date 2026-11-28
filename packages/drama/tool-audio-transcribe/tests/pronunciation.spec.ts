/** Verify pronunciation request bounds, local ownership, and advisory abstention. */
import { mkdir, mkdtemp, realpath, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { offlineLibraryDigest } from '../src/pronunciation-runtime.ts'
import { inspectPronunciation, pronunciationStatus, validatePronunciationRequest } from '../src/pronunciation.ts'

const request = {
  tokens: ['wo3', 'dai4', 'ding4'], target_index: 1, alternative: 'zai4',
  windows: [{ start: 2.2, end: 3.4 }, { start: 2, end: 3.5 }],
}
const workspaces: string[] = []
afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
})

it('requires a tone-labelled target and distinct overlapping phrase windows', () => {
  expect(() => validatePronunciationRequest(request, 20)).not.toThrow()
  for (const override of [
    { target_index: 0 }, { target_index: 2 }, { alternative: 'dai4' }, { alternative: '载' },
    { tokens: ['wo3', 'dai', 'ding4'] }, { windows: request.windows.slice(0, 1) },
    { windows: [request.windows[0]!, request.windows[0]!] },
    { windows: [{ start: 2, end: 2.3 }, request.windows[1]!] },
    { windows: [{ start: 5, end: 6 }, request.windows[0]!] },
    { windows: [{ start: 2, end: 13 }, request.windows[0]!] },
    { windows: [{ start: Number.NaN, end: 3.4 }, request.windows[1]!] },
  ]) {
    expect(() => validatePronunciationRequest({ ...request, ...override }, 20)).toThrow('OFFLINE_PRONUNCIATION_ARGS')
  }
})

it('needs two anchored votes agreeing on a time with a directionally consistent margin', () => {
  const window = (observed: string, target_seconds: number, alternative_minus_expected: number) =>
    ({ observed, target_seconds, alternative_minus_expected })
  const vote = (...windows: Parameters<typeof pronunciationStatus>[0]) => pronunciationStatus(windows, 'dai4', 'zai4', 8)
  expect(vote(window('zai4', 3, 10), window('zai4', 3.06, 12))).toBe('suspected_mismatch')
  expect(vote(window('dai4', 3, -10), window('dai4', 3.06, -12), {})).toBe('matching_in_windows')
  expect(vote(window('zai4', 3, 10), { alternative_minus_expected: 30 })).toBe('uncertain')
  expect(vote(window('zai4', 3, 10), window('zai4', 3.06, 3))).toBe('uncertain')
  expect(vote(window('zai4', 3, 10), window('zai4', 3.25, 12))).toBe('uncertain')
  expect(vote(window('zai4', 3, 10), window('zai4', 3.06, 12), window('dai4', 3.02, -9))).toBe('uncertain')
  expect(vote(window('zai4', 3, 10), window('zai4', 3.06, 12), window('zai4', 3.02, -9))).toBe('uncertain')
  expect(vote(window('zhai1', 3, 10), window('zhai1', 3.06, 12))).toBe('uncertain')
  expect(vote({}, {})).toBe('uncertain')
})

it('will only decode a project-owned source with provisioned and verified assets', async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'muse-local-pronunciation-')))
  workspaces.push(workspace)
  const project = join(workspace, 'project')
  const libraryDir = join(workspace, 'library')
  const modelDir = join(workspace, 'model')
  await Promise.all([mkdir(project), mkdir(libraryDir), mkdir(modelDir)])
  const pythonPath = join(workspace, 'not-executed-python')
  await Promise.all([writeFile(pythonPath, 'not executed'), writeFile(join(project, 'shot.mp4'), 'not decoded'),
    writeFile(join(libraryDir, 'fixture.py'), 'not imported'), writeFile(join(modelDir, 'sensevoice_dual_int8.onnx'), 'wrong model')])
  const signal = new AbortController().signal
  const librarySha256 = await offlineLibraryDigest(libraryDir, signal)
  const config = { ffmpegPath: 'unused-ffmpeg', ffprobePath: 'unused-ffprobe',
    commandTimeoutMs: 1000, maxDurationSeconds: 120, maxAudioBytes: 1_000_000 }
  const runtime = { pythonPath, modelDir, libraryDir, librarySha256 }
  await expect(inspectPronunciation(workspace, project, pythonPath, request, config, runtime, signal))
    .rejects.toThrow('OFFLINE_ASR_SCOPE')
  await expect(inspectPronunciation(workspace, project, 'shot.mp4', request, config, runtime, signal))
    .rejects.toThrow('OFFLINE_PRONUNCIATION_UNAVAILABLE')
  expect(await readdir(project)).toEqual(['shot.mp4'])
})
