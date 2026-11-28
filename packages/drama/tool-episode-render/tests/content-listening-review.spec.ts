/** Source-bound listening through actual local media and a controlled audio transport. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderRequestId, type AudioReviewRoute, type AudioReviewTransport } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { prepareContentListeningAudio } from '../src/content-listening-audio.ts'
import { readContentListeningAttempt, reviewContentListening } from '../src/content-listening-review.ts'
import { createMediaToolkit } from '../src/ffmpeg.ts'
import { sourceRecordPathFor, writeSourceRecord } from '../src/source-record.ts'
import { createMediaRunner, ffmpeg, ffprobe, hasFfmpeg } from './audio-ffmpeg-harness.ts'

it.skipIf(!hasFfmpeg)('uses current native media once and never converts pending notes into approval', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-listen-candidate-'))
  const runner = createMediaRunner()
  try {
    const output = join(project, 'rendered.mp4')
    const subtitleSrt = join(project, 'display.srt')
    const authoredDialoguePath = join(project, 'authored.json')
    const toolkit = createMediaToolkit({ ffmpeg, ffprobe, channel: { run: runner.runCommand } })
    const encoded = await runner.runCommand(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
      'color=black:s=24x24:r=24:d=0.5', '-f', 'lavfi', '-i',
      'aevalsrc=0.05*sin(2*PI*440*t)|0.08*sin(2*PI*550*t):s=48000:d=0.5:c=stereo',
      '-c:v', 'mpeg4', '-c:a', 'aac', output])
    expect(encoded.code, encoded.stderr).toBe(0)
    await writeFile(subtitleSrt, '1\n00:00:00,010 --> 00:00:00,400\n你好\n')
    const authored = JSON.stringify({ schema_version: 1, shots: [{ shot: 1, lines: ['你好'] }] })
    await writeFile(authoredDialoguePath, authored)
    const outputSha = await fileSha256(output)
    const authoredSha = await fileSha256(authoredDialoguePath)
    await writeSourceRecord(sourceRecordPathFor(output), {
      version: 1, episode: '21', rendered_at: new Date(0).toISOString(),
      output: { path: output, sha256: outputSha, size_bytes: (await stat(output)).size, duration_seconds: 0.5 },
      inputs: [authoredSha], encoder: 'mpeg4', checks: [],
      input_files: [{ path: authoredDialoguePath, sha256: authoredSha }],
      delivery_inputs: { timeline_sha256: outputSha, subtitle_sha256: await fileSha256(subtitleSrt),
        master_audio_sha256: outputSha, videos: [{ shot: 1, sha256: outputSha }] },
    })
    const base = { project, episode: '21', output, toolkit }
    const prepared = await prepareContentListeningAudio(base)
    const input = { ...base, subtitleSrt, authoredDialoguePath, preparationPath: prepared.receipt_path }
    await expect(reviewContentListening(input)).rejects.toMatchObject({ code: 'CONTENT_LISTENING_ROUTE_UNAVAILABLE' })
    const route = { provider: 'review-fixture', model: 'qualified-audio-fixture' }
    let routes: AudioReviewRoute[] = [route, { provider: 'second-fixture', model: 'other' }]
    const request = vi.fn<AudioReviewTransport['request']>(async (args) => {
      const audio = args.wav[0]
      expect(audio?.subarray(0, 4).toString()).toBe('RIFF')
      expect(args.prompt).toContain('你好')
      const ids = args.wav.map(wav => createHash('sha256').update(wav).digest('hex'))
      const ok = { status: 'ok', reason: '样例语音检测完成。' }
      return { ...route, audioSha256: ids, listeningVerified: false, grantsApproval: false,
        requestId: ProviderRequestId('fixture-audio-1'), usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        response: { ranges: [{ start_us: 0, end_us: 500_000, reason: '记录完整音频范围。' }],
          assessments: { pronunciation: ok, dialogue_completeness: ok, speaker: ok, continuity: ok }, findings: [] } }
    })
    const transport = { configuredRoutes: () => routes, request }
    await expect(reviewContentListening({ ...input, transport })).rejects.toMatchObject({ code: 'CONTENT_LISTENING_ROUTE_UNAVAILABLE' })
    routes = [route]
    await writeFile(authoredDialoguePath, authored.replace('你好', '再见'))
    await expect(reviewContentListening({ ...input, transport })).rejects.toMatchObject({ code: 'CONTENT_LISTENING_REVIEW_INPUT' })
    expect(request).not.toHaveBeenCalled()
    await writeFile(authoredDialoguePath, authored)
    const results = await Promise.allSettled([reviewContentListening({ ...input, transport }),
      reviewContentListening({ ...input, transport })])
    expect(request).toHaveBeenCalledTimes(1)
    const settled = results.find(result => result.status === 'fulfilled')
    if (settled === undefined) throw Error(JSON.stringify(results))
    expect(settled.value).toMatchObject({ status: 'needs_review', listening_verified: false, grants_approval: false,
      source_sha256: outputSha, findings_count: 1, cost_status: 'pending_reconciliation' })
    const saved = JSON.parse(await readFile(settled.value.receipt_path, 'utf8')) as unknown
    expect(saved).toMatchObject({ provider_request_id: 'fixture-audio-1', token_usage: { totalTokens: 30 },
      assessment: { assessments: { speaker: { status: 'uncertain' } } } })
    const reopen = { ...base, attemptPath: settled.value.attempt_path }
    await expect(readContentListeningAttempt(reopen)).resolves.toMatchObject({ status: 'candidate_available',
      candidate_path: settled.value.receipt_path, provider_request_id: 'fixture-audio-1', token_usage: { totalTokens: 30 },
      cost_status: 'pending_reconciliation', listening_verified: false, grants_approval: false })
    await expect(readContentListeningAttempt({ ...reopen, episode: '22' })).rejects.toMatchObject({ code: 'CONTENT_LISTENING_REVIEW_INPUT' })
    await writeFile(settled.value.receipt_path, JSON.stringify({ status: 'approved' }))
    await expect(reviewContentListening({ ...input, transport })).rejects.toMatchObject({ code: 'CONTENT_LISTENING_REVIEW_PENDING' })
    await expect(readContentListeningAttempt(reopen)).resolves.toMatchObject({ status: 'response_received',
      invalid_candidate: true, provider_request_id: 'fixture-audio-1', listening_verified: false, grants_approval: false })
    expect(request).toHaveBeenCalledTimes(1)

    const unusableRoute = { ...route, model: 'unusable-audio-fixture' }
    const unusableRequest = vi.fn<AudioReviewTransport['request']>(async ({ wav, onProviderResponse }) => {
      await onProviderResponse?.({ ...unusableRoute, audioSha256: wav.map(bytes => createHash('sha256').update(bytes).digest('hex')),
        requestId: ProviderRequestId('fixture-unusable-2'), usage: { inputTokens: 10, outputTokens: 7, totalTokens: 17 } })
      throw Error('Provider sent unparseable content after responding')
    })
    const unusableTransport = { configuredRoutes: () => [unusableRoute], request: unusableRequest }
    const unusableInput = { ...input, transport: unusableTransport }
    await expect(reviewContentListening(unusableInput)).rejects.toMatchObject({ code: 'CONTENT_LISTENING_REVIEW_PENDING' })
    const directory = join(project, 'audio', 'content-listening-reviews')
    const attemptPaths = (await readdir(directory)).map(entry => join(directory, entry, 'attempt.json'))
    const failedAttempt = attemptPaths.find(path => path !== settled.value.attempt_path)
    if (failedAttempt === undefined) throw Error('Missing original attempt after response rejection')
    await expect(readContentListeningAttempt({ ...base, attemptPath: failedAttempt })).resolves.toMatchObject({
      status: 'response_received', provider_request_id: 'fixture-unusable-2', token_usage: { totalTokens: 17 },
      cost_status: 'pending_reconciliation', listening_verified: false, grants_approval: false })
    await expect(reviewContentListening(unusableInput)).rejects.toMatchObject({ code: 'CONTENT_LISTENING_REVIEW_PENDING' })
    expect(unusableRequest).toHaveBeenCalledTimes(1)
  } finally {
    await runner.dispose()
    await rm(project, { recursive: true, force: true })
  }
}, 20_000)
