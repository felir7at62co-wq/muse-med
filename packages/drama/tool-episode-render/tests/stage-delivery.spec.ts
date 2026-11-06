import { mkdir, readdir, readFile, realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { createMediaToolkit } from '../src/ffmpeg.ts'
import { resolveCall, resolveSettings } from '../src/index.ts'
import { episodePaths } from '../src/paths.ts'
import { buildSourceRecord, readSourceRecord, sourceRecordPathFor, writeSourceRecord, type DeliveryRenderInputs } from '../src/source-record.ts'
import { verifySelectedSourceReviews } from '../src/approved-sources.ts'
import { summarizeSourceQa } from '../src/source-qa.ts'
import { reviewSpeechCoverage } from '../src/speech-coverage.ts'
import { stageEpisodeDelivery } from '../src/stage-delivery.ts'
import { readTimeline } from '../src/timeline.ts'
import { runDramaVideo } from '../src/video.ts'
import { cleanup, decodeHandler, probeHandler, srtDocument, stubChannel, tempProject, timelineJson, writePlaceholder } from './harness.ts'
import { sourceQaFixture, verifiedSourceQaFixture } from './source-qa-fixture.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (directory) => { await cleanup(directory) }))
})

async function fixture(clips = [{ shot: 1, startUs: 0, durationUs: 5_000_000 }],
  subtitle: { explicitVisual: boolean
    text: string
    requireNoPunctuation?: boolean
    requireSpeechCoverage?: boolean
    display?: 'external' | 'overlay' | 'unknown'
    missingStreamClock?: boolean
    cues?: Parameters<typeof srtDocument>[0]
  } = { explicitVisual: false, text: '台词' }, musicKind?: string) {
  const project = await realpath(await tempProject())
  temporary.push(project)
  const episode = '26'
  const paths = episodePaths(project, episode)
  const shots = clips.map(clip => join(paths.videoDir, `shot_${String(clip.shot).padStart(3, '0')}.mp4`))
  const draft = join(project, '02_剪映草稿', '第26集')
  const draftSourcePath = join(draft, 'muse-episode-source.json')
  const upload = join(project, '01_可交付视频')
  const video = join(upload, '第26集.mp4')
  const receipt = join(project, '成片与草稿回执.json')
  const timeline = timelineJson(clips, 5)
  const delivery = { width: 1440, height: 2560, fps: 60,
    ...(subtitle.explicitVisual ? { subtitle_visual: {
      schema_version: 1, reference_width: 1080, reference_height: 1920,
      font_size_px: 40, outline_px: 2, center_y_ratio: 0.75, max_width_ratio: 0.9,
    } } : {}),
    subtitle: { ...(subtitle.requireNoPunctuation === undefined ? {} : { require_no_punctuation: subtitle.requireNoPunctuation }),
      ...(subtitle.requireSpeechCoverage === undefined ? {} : { require_speech_coverage: subtitle.requireSpeechCoverage }) },
    ...(musicKind === undefined ? {} : { audio: { require_music_decision: musicKind !== 'legacy' } }),
  }
  await Promise.all([
    writePlaceholder(paths.output, 'verified render bytes'),
    writePlaceholder(paths.timeline, musicKind !== undefined || subtitle.explicitVisual
      || subtitle.requireNoPunctuation !== undefined || subtitle.requireSpeechCoverage !== undefined
      ? JSON.stringify({ ...JSON.parse(timeline), delivery }) : timeline),
    writePlaceholder(paths.subtitle, srtDocument(subtitle.cues ?? [{ start: '00:00:01,000', end: '00:00:02,000', text: subtitle.text }])),
    writePlaceholder(paths.masterAudio, 'verified master bytes'),
    ...shots.map(shot => writePlaceholder(shot, 'selected shot bytes')),
    writePlaceholder(join(draft, 'draft_content.json'), '{}'),
    writePlaceholder(join(draft, 'draft_meta_info.json'), '{}'),
  ])
  const mediaPaths = [paths.timeline, paths.subtitle, paths.masterAudio, ...shots]
  const materials = await Promise.all(mediaPaths.map(async path => ({ path, sha256: await fileSha256(path) })))
  const files = await Promise.all(['draft_content.json', 'draft_meta_info.json'].map(async path => ({
    path, sha256: await fileSha256(join(draft, path)),
  })))
  const deliveryInputs = {
    timeline_sha256: await fileSha256(paths.timeline),
    subtitle_sha256: await fileSha256(paths.subtitle),
    master_audio_sha256: await fileSha256(paths.masterAudio),
    videos: await Promise.all(shots.map(async (path, index) => ({ shot: clips[index]!.shot, sha256: await fileSha256(path) }))),
  }
  await writePlaceholder(paths.sources, JSON.stringify({ shots: deliveryInputs.videos.map((row, index) => ({
    ...row, video: shots[index], audio: shots[index],
  })), ...(subtitle.requireSpeechCoverage === true ? { master_audio_sha256: deliveryInputs.master_audio_sha256,
    timeline_clips: clips.map(clip => ({ shot: clip.shot, start_us: clip.startUs, duration_us: clip.durationUs })) } : {}) }))
  const source = { version: 1, episode, audio_mode: 'independent', ...deliveryInputs, files, materials,
    ...(subtitle.requireSpeechCoverage === true ? { track_verification: 'independent-v1' } : {}) }
  await writePlaceholder(draftSourcePath, JSON.stringify(source))
  let music: DeliveryRenderInputs['music']
  const musicFiles: string[] = []
  if (musicKind !== undefined && musicKind !== 'legacy') {
    const plan = join(project, 'bgm-plan.json'), bed = join(project, 'bgm.wav'), generation = join(project, 'bgm.generation.json')
    const none = ['justified no_bgm', 'missing plan', 'blank reason', 'mode conflicts'].includes(musicKind)
    const sourceSha = '1'.repeat(64)
    const identity = musicKind === 'missing track identity' ? {} : musicKind === 'catalog music'
      ? { source_sha256: sourceSha, track_id: `sha256:${sourceSha}` } : musicKind === 'nonmatching catalog id'
        ? { source_sha256: sourceSha, track_id: `sha256:${'2'.repeat(64)}` }
        : { source_sha256: sourceSha, selection_origin: 'approved_reuse', reason: '沿用已认可的本剧主题曲' }
    const planRow = { episode, body_duration_seconds: 5, music_decision: none ? 'none' : 'music',
      decision_reason: musicKind === 'blank reason' ? '   ' : '本集对白与画面采用已确认决定',
      segments: none ? [] : [{ track: '主题曲', source: 'music/theme.wav', start_seconds: 0, end_seconds: 5, source_start_seconds: 1,
        ...identity }] }
    if (musicKind !== 'missing plan') {
      await writePlaceholder(plan, JSON.stringify({ episodes: [planRow] }))
      musicFiles.push(plan)
    }
    music = { mode: none && musicKind !== 'mode conflicts' ? 'none' : 'music',
      gain: none || musicKind === 'muted music' ? 0 : 0.2,
      ...(musicKind === 'missing plan' ? {} : { plan_path: plan }) }
    if (!none || musicKind === 'mode conflicts') {
      await writePlaceholder(bed, 'music chosen by composer')
      const bedSha = await fileSha256(bed)
      musicFiles.push(bed)
      music = { ...music, bed_path: bed }
      if (musicKind !== 'missing generation') {
        await writePlaceholder(generation, JSON.stringify({ method: 'compose', episode, plan, timeline: paths.timeline,
          body_duration_seconds: 5, media: { sha256: musicKind === 'different bed' ? '0'.repeat(64) : bedSha },
          segments: [{ ...planRow.segments[0], source: join(project, 'music/theme.wav'), source_sha256: sourceSha,
            source_start_seconds: musicKind === 'different source cut' ? 2 : 1 }] }))
        musicFiles.push(generation)
        music = { ...music, generation_path: generation }
      }
    }
  }
  const renderFiles = [...materials, ...await Promise.all(musicFiles.map(async path => ({ path, sha256: await fileSha256(path) }))),
    ...(subtitle.requireSpeechCoverage === true ? [{ path: paths.sources, sha256: await fileSha256(paths.sources) }] : [])]
  const sha256 = await fileSha256(paths.output)
  await writeSourceRecord(sourceRecordPathFor(paths.output), buildSourceRecord({
    episode, output: paths.output, outputSha256: sha256, sizeBytes: 21, durationSeconds: 7,
    inputs: [deliveryInputs.videos[0]!.sha256],
    inputFiles: renderFiles,
    deliveryInputs: { ...deliveryInputs,
      ...(subtitle.requireSpeechCoverage === true && subtitle.display !== 'unknown'
        ? { subtitle_display: subtitle.display ?? 'external' } : {}),
      ...(music === undefined ? {} : { music }),
    },
    encoder: 'libx264', checks: [], now: new Date('2026-11-04T00:00:00Z'),
  }))
  const toolkit = createMediaToolkit({
    ffmpeg: 'ffmpeg', ffprobe: 'ffprobe',
    channel: stubChannel([probeHandler({ [paths.output]: { durationSeconds: 7,
      video: subtitle.requireSpeechCoverage && !subtitle.missingStreamClock ? { startSeconds: 0, durationSeconds: 7 } : {},
      audio: subtitle.requireSpeechCoverage && !subtitle.missingStreamClock ? { startSeconds: 0, durationSeconds: 7 } : {},
    } }),
    call => call.args.some(argument => argument.includes('bbox=min_val=1')) ? {
      stderr: 'fontselect: (SimHei, 400, 0) -> SimHei, 0, SimHei\n'
          + '[Parsed_bbox] x1:1200 x2:1299 y1:1800 y2:1839 w:100 h:40',
      after: async () => {
        for (const path of call.args.filter(argument => argument.endsWith('.png'))) await writePlaceholder(path, 'measured glyph image')
      },
    } : undefined,
    decodeHandler(), () => ({})]).channel,
  })
  const input = {
    toolkit, settings: resolveSettings({}), project, episode,
    output: paths.output, timelinePath: paths.timeline, subtitleSrt: paths.subtitle,
  }
  return { project, paths, shot: shots[0]!, input, draft, draftSourcePath, source, upload, video, receipt, sha256 }
}

describe('stageEpisodeDelivery', () => {
  it('refuses an unreviewed episode when the project requires source review', async () => {
    const f = await fixture()
    await writePlaceholder(join(f.project, 'project_config.json'), JSON.stringify({
      project_bible: { delivery: { require_source_review: true } },
    }))
    await expect(stageEpisodeDelivery(f.input, f.draft)).rejects.toThrow(/缺少本集选源审核/u)
    expect(await readdir(f.project)).not.toContain('01_可交付视频')
  })

  it('requires an episode-contained draft after the selected original passes source review', async () => {
    const f = await fixture()
    const packagePath = join(f.project, 'episode_packages', '26', 'package.json')
    const reviewPath = join(f.project, 'reviews', 'ep26-p01.json')
    const frame = join(f.project, 'review.png')
    const download = join(f.project, 'download.json')
    const sha = f.source.videos[0]!.sha256
    const qa = await sourceQaFixture(f.project, f.shot)
    await Promise.all([
      writePlaceholder(join(f.project, 'project_config.json'), JSON.stringify({
        project_bible: { delivery: { require_source_review: true } },
      })),
      writePlaceholder(frame, 'review frame'),
      writePlaceholder(packagePath, JSON.stringify({ episode: '26', video_tasks: [{ shots: [1] }] })),
      writePlaceholder(download, JSON.stringify({ version: 1, kind: 'video', media_type: 'video/mp4',
        path: f.shot, sha256: `sha256:${sha}`, source_sha256: 'b'.repeat(64) })),
    ])
    await writePlaceholder(reviewPath, JSON.stringify({ episode: '26', package: 1, status: 'approved',
      subtitle_cleanup: 'not_required', video_path: f.shot, video_sha256: sha,
      package_sha256: await fileSha256(packagePath), original_download_receipt_path: download, review_frames: [frame],
      source_qa: { version: 1, selected: qa.declaration },
      content_review: { identity: 'pass', wardrobe: 'pass', scene: 'pass', prop: 'pass', action_and_dialogue: 'pass',
        visible_artifacts: 'pass', continuity: 'pass', voice_and_speaker: 'pass', av_sync: 'pass',
        sensitive_content: 'pass', embedded_subtitles: 'absent' },
    }))
    await writePlaceholder(f.paths.sources, JSON.stringify({ shots: [{ shot: 1, package: 1, video: f.shot, audio: f.shot,
      sha256: sha, audio_sha256: sha, review_sha256: await fileSha256(reviewPath) }],
    master_audio_sha256: f.source.master_audio_sha256, timeline_clips: [{ shot: 1, start_us: 0, duration_us: 5_000_000 }] }))
    await expect(stageEpisodeDelivery(f.input, f.draft)).rejects.toThrow(/真实OCR执行/u)
    const verifiedQa = summarizeSourceQa(await verifySelectedSourceReviews(f.paths,
      [{ shot: 1, package: 1, video: f.shot, audio: f.shot }], true, true, verifiedSourceQaFixture))
    const recordPath = sourceRecordPathFor(f.paths.output)
    const record = (await readSourceRecord(recordPath))!
    await writeSourceRecord(recordPath, { ...record, delivery_inputs: { ...record.delivery_inputs!, source_qa_sha256: verifiedQa.sha256 },
      input_files: [...record.input_files!, ...verifiedQa.files] })
    const input = { ...f.input, sourceQaVerifier: verifiedSourceQaFixture }
    await expect(stageEpisodeDelivery(input, f.draft)).rejects.toThrow(/保留同集素材/u)
    await writePlaceholder(f.draftSourcePath, JSON.stringify({ ...f.source, material_scope: 'episode' }))
    expect((await stageEpisodeDelivery(input, f.draft)).delivery_package?.status).toBe('candidate')
  })

  it.each([
    { kind: 'legacy', decision: undefined }, { kind: 'justified no_bgm', decision: 'none' },
    { kind: 'adopted reused music', decision: 'music' }, { kind: 'catalog music', decision: 'music' },
    { kind: 'missing plan', error: /配乐计划 bgm_plan/u }, { kind: 'blank reason', error: /decision_reason/u },
    { kind: 'mode conflicts', error: /混音模式不符/u }, { kind: 'missing generation', error: /bgm_generation/u },
    { kind: 'different bed', error: /实际采用的 BGM 字节/u }, { kind: 'muted music', error: /非零实际混音增益/u },
    { kind: 'different source cut', error: /选用区间/u },
    { kind: 'missing track identity', error: /每段配乐须有曲库 track_id/u },
    { kind: 'nonmatching catalog id', error: /每段配乐须有曲库 track_id/u },
  ])('enforces the rendered music decision when opted in: $kind', async ({ kind, error, decision }) => {
    const f = await fixture(undefined, undefined, kind)
    const attempt = stageEpisodeDelivery(f.input, f.draft)
    if (error !== undefined) {
      await expect(attempt).rejects.toThrow(error)
      const entries = await readdir(f.project)
      expect(entries).not.toContain('01_可交付视频')
      expect(entries).not.toContain('成片与草稿回执.json')
      expect(await fileSha256(f.input.output)).toBe(f.sha256)
    } else {
      expect((await attempt).delivery_package?.status).toBe('candidate')
      const receipt = JSON.parse(await readFile(f.receipt, 'utf8')) as { music_decision?: unknown }
      if (decision === undefined) expect(receipt).not.toHaveProperty('music_decision')
      else expect(receipt.music_decision).toMatchObject({ decision, plan_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) as string })
      if (decision === 'music') expect(receipt.music_decision).toMatchObject({ mix_gain: 0.2,
        bed_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) as string,
        generation_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) as string,
      })
    }
  })

  it.each(['unreviewed separate', 'pending embedded', 'legacy picture review separate',
    'approved separate with embedded draft', 'approved separate with banned audio',
    'approved separate with old clock', 'approved separate'] as const)
  ('enforces selected-source review without changing legacy preparation: %s', async (kind) => {
    const clips = kind === 'approved separate with old clock'
      ? [{ shot: 1, startUs: 0, durationUs: 2_000_000 }, { shot: 2, startUs: 2_000_000, durationUs: 3_000_000 }]
      : [{ shot: 1, startUs: 0, durationUs: 5_000_000 }]
    const f = await fixture(clips)
    const source = join(f.project, 'picked.mp4')
    const audio = join(f.project, 'original-audio.mp4')
    await writePlaceholder(source, 'selected shot bytes')
    await writePlaceholder(audio, 'approved original sound')
    const separate = kind !== 'pending embedded'
    const row = { shot: 1, package: 1, video: source, audio: separate ? audio : source,
      sha256: await fileSha256(source), audio_sha256: await fileSha256(separate ? audio : source) }
    let reviewSha256: string | undefined
    if (kind !== 'unreviewed separate') {
      const packagePath = join(f.project, 'episode_packages', '26', 'package.json')
      const reviewPath = join(f.project, 'reviews', 'ep26-p01.json')
      await writePlaceholder(packagePath, JSON.stringify({ episode: '26', video_tasks: [{ shots: [1] }] }))
      await writePlaceholder(reviewPath, JSON.stringify({
        episode: '26', package: 1, status: separate ? 'approved' : 'pending',
        subtitle_cleanup: 'clean', package_sha256: await fileSha256(packagePath),
        video_path: source, video_sha256: row.sha256,
        ...(kind === 'legacy picture review separate' ? {} : { audio_path: row.audio, audio_sha256: row.audio_sha256 }),
      }))
      reviewSha256 = await fileSha256(reviewPath)
    }
    await writePlaceholder(f.paths.sources, JSON.stringify({
      shots: clips.map(clip => ({ ...row, shot: clip.shot, review_sha256: reviewSha256 })),
      master_audio_sha256: f.source.master_audio_sha256,
      timeline_clips: kind === 'approved separate with old clock'
        ? [{ shot: 1, start_us: 0, duration_us: 3_000_000 }, { shot: 2, start_us: 3_000_000, duration_us: 2_000_000 }]
        : clips.map(clip => ({ shot: clip.shot, start_us: clip.startUs, duration_us: clip.durationUs })),
    }))
    if (kind === 'approved separate with embedded draft') {
      await writePlaceholder(f.draftSourcePath, JSON.stringify({ ...f.source, audio_mode: 'embedded', master_audio_sha256: undefined }))
    }
    if (kind === 'approved separate with banned audio') {
      await runDramaVideo({ method: 'ban', project: f.project, video: audio, labels: ['错配原声'] })
    }
    if (kind === 'approved separate') {
      expect((await stageEpisodeDelivery(f.input, f.draft)).delivery_package?.status).toBe('candidate')
    } else {
      await expect(stageEpisodeDelivery(f.input, f.draft)).rejects.toThrow(
        /缺少本集选源审核|缺少已审核的独立原声音频|整集原声版本不符|时间线切点不符|错配原声/,
      )
      expect(await readdir(f.project)).not.toContain('01_可交付视频')
    }
  })

  it('publishes only one verified MP4 and gives identical concurrent callers the same candidate', async () => {
    const f = await fixture()
    const reports = await Promise.all([stageEpisodeDelivery(f.input, f.draft), stageEpisodeDelivery(f.input, f.draft)])
    expect(reports.map(report => report.delivery_package?.reused).sort()).toEqual([false, true])
    for (const report of reports) expect(report).toMatchObject({
      ok: true, method: 'stage_delivery', output: f.video,
      delivery_package: { status: 'candidate', video: f.video, draft: f.draft, receipt: f.receipt, sha256: f.sha256 },
    })
    expect(await readdir(f.upload)).toEqual(['第26集.mp4'])
    expect(await fileSha256(f.video)).toBe(f.sha256)
    expect(JSON.parse(await readFile(f.receipt, 'utf8'))).toMatchObject({ status: 'candidate', episode: '26' })
    expect(await readFile(f.paths.output, 'utf8')).toBe('verified render bytes')
    expect(await readFile(join(f.draft, 'draft_content.json'), 'utf8')).toBe('{}')
  })

  it('resumes an interrupted publication with an identical receipt and empty upload folder', async () => {
    const f = await fixture()
    await stageEpisodeDelivery(f.input, f.draft)
    await unlink(f.video)
    const report = await stageEpisodeDelivery(f.input, f.draft)
    expect(report.written).toEqual([f.video])
    expect(report.delivery_package?.reused).toBe(false)
    expect(await fileSha256(f.video)).toBe(f.sha256)
  })

  it('rejects a valid same-source draft saved inside another episode folder', async () => {
    const f = await fixture()
    const wrongEpisode = join(f.project, '第25集')
    const wrongDraft = join(wrongEpisode, '02_剪映草稿', '第26集')
    for (const name of ['draft_content.json', 'draft_meta_info.json', 'muse-episode-source.json']) {
      await writePlaceholder(join(wrongDraft, name), await readFile(join(f.draft, name), 'utf8'))
    }

    await expect(stageEpisodeDelivery(f.input, wrongDraft)).rejects.toThrow(/目录集号.*25.*26/u)
    expect(await readdir(wrongEpisode)).toEqual(['02_剪映草稿'])
  })

  it.each([
    { explicitVisual: true, text: '第一行\n第二行', blocked: true },
    { explicitVisual: true, text: '第一行\\N第二行', blocked: true },
    { explicitVisual: true, text: '第一行\\n第二行', blocked: true },
    { explicitVisual: true, text: '保持一行', blocked: false },
    { explicitVisual: false, text: '第一行\n第二行', blocked: false },
  ])('enforces the explicit single-line layout for the bound burned SRT: $explicitVisual / $blocked',
    async ({ explicitVisual, text, blocked }) => {
      const f = await fixture(undefined, { explicitVisual, text })
      const authored = await readFile(f.paths.subtitle)
      if (blocked) {
        const report = await stageEpisodeDelivery(f.input, f.draft)
        expect(report.ok).toBe(false)
        expect(report).not.toHaveProperty('delivery_package')
        expect(report.checks.find(check => check.id === 'subtitle_display_text')).toMatchObject({ ok: false, severity: 'failure' })
        const entries = await readdir(f.project)
        expect(entries).not.toContain('01_可交付视频')
        expect(entries).not.toContain('成片与草稿回执.json')
        expect(await fileSha256(f.input.output)).toBe(f.sha256)
      } else {
        expect((await stageEpisodeDelivery(f.input, f.draft)).delivery_package?.status).toBe('candidate')
      }
      expect(await readFile(f.paths.subtitle)).toEqual(authored)
    })

  it.each([
    { explicitVisual: false, requireNoPunctuation: true, text: '还想吹空调，', blocked: true },
    { explicitVisual: false, requireNoPunctuation: true, text: '快吃吧!', blocked: true },
    { explicitVisual: false, requireNoPunctuation: true, text: '快吃吧', blocked: false },
    { explicitVisual: true, requireNoPunctuation: false, text: '快吃吧！', blocked: true },
    { explicitVisual: true, requireNoPunctuation: undefined, text: '快吃吧！', blocked: true },
    { explicitVisual: true, requireNoPunctuation: false, text: '概率99.9%', blocked: false },
    { explicitVisual: false, requireNoPunctuation: false, text: '快吃吧！', blocked: false },
  ])('checks ordinary punctuation for active visuals and the legacy opt-in: $text / $requireNoPunctuation',
    async ({ explicitVisual, requireNoPunctuation, text, blocked }) => {
      const f = await fixture(undefined, { explicitVisual, text,
        ...(requireNoPunctuation === undefined ? {} : { requireNoPunctuation }),
      })
      const authored = await readFile(f.paths.subtitle)
      if (blocked) {
        if (explicitVisual) {
          const report = await stageEpisodeDelivery(f.input, f.draft)
          expect(report.ok).toBe(false)
          expect(report).not.toHaveProperty('delivery_package')
          expect(report.checks.find(check => check.id === 'subtitle_display_text')).toMatchObject({ ok: false, severity: 'failure' })
        } else await expect(stageEpisodeDelivery(f.input, f.draft)).rejects.toThrow(/第 1 条.*标点/u)
        const entries = await readdir(f.project)
        expect(entries).not.toContain('01_可交付视频')
        expect(entries).not.toContain('成片与草稿回执.json')
        expect(await fileSha256(f.input.output)).toBe(f.sha256)
      } else {
        expect((await stageEpisodeDelivery(f.input, f.draft)).delivery_package?.status).toBe('candidate')
      }
      expect(await readFile(f.paths.subtitle)).toEqual(authored)
    })

  it.each([
    { kind: 'same-source aligned' }, { kind: 'subtitle appears early', error: /字幕或发声待核/u },
    { kind: 'recorded keep' }, { kind: 'recorded unresolved', error: /字幕或发声待核/u },
    { kind: 'stale keep', error: /字幕或发声待核/u }, { kind: 'missing transcript map', error: /缺少 speech_transcripts/u },
    { kind: 'wrong picture declaration', error: /完整显示字幕声明/u },
    { kind: 'missing display declaration', error: /完整显示字幕声明/u },
    { kind: 'missing word evidence', error: /完整词级证据/u },
    { kind: 'wrong selected audio evidence', error: /完整词级证据/u },
    { kind: 'renderer overlay', error: /保留原片字幕/u }, { kind: 'legacy unknown subtitle source', error: /未记录字幕来源/u },
    { kind: 'changed source manifest', error: /已变化/u },
    { kind: 'old draft without track verification', error: /独立原声与字幕轨道核查/u },
    { kind: 'missing stream clock', error: /实测起止时间/u },
  ])('enforces fresh word coverage before staging: $kind', async ({ kind, error }) => {
    const f = await fixture(undefined, { explicitVisual: false, text: '现在做饭', requireSpeechCoverage: true,
      display: kind === 'renderer overlay' ? 'overlay' : kind === 'legacy unknown subtitle source' ? 'unknown' : 'external',
      missingStreamClock: kind === 'missing stream clock',
    })
    const transcriptsPath = join(f.project, 'coverage.json')
    const receipt = 'transcript/jobs/shot-v1.json'
    const sha = f.source.videos[0]!.sha256
    const display = { embedded: false, subtitle_sha256: f.source.subtitle_sha256,
      video_sha256: [kind === 'wrong picture declaration' ? '0'.repeat(64) : sha] }
    const needsReview = kind === 'subtitle appears early' || kind.startsWith('recorded') || kind === 'stale keep'
    const start = needsReview ? 2.7 : 1
    const end = needsReview ? 3.2 : 2
    const wordsPath = join(f.project, 'transcript/raw/shot-v1.json')
    await Promise.all([
      writePlaceholder(transcriptsPath, JSON.stringify({ shots: [{ shot: 1, receipt }],
        ...(kind === 'missing display declaration' ? {} : { display }) })),
      writePlaceholder(join(f.project, receipt), JSON.stringify({ status: 'complete', stem: 'shot', version: 1,
        source: f.shot, sourceSha256: kind === 'wrong selected audio evidence' ? '0'.repeat(64) : sha })),
      writePlaceholder(wordsPath, JSON.stringify([{ start, end,
        words: kind === 'missing word evidence' ? [] : [{ text: '现在做饭', start, end }] }])),
    ])
    if (kind === 'changed source manifest') await writePlaceholder(f.paths.sources, (await readFile(f.paths.sources, 'utf8')) + '\n')
    if (kind === 'old draft without track verification') {
      await writePlaceholder(f.draftSourcePath, JSON.stringify({ ...f.source, track_verification: undefined }))
    }
    const call = resolveCall({ method: 'stage_delivery', project: f.project, episode: 26, output: f.input.output,
      timeline: f.input.timelinePath, subtitleSrt: f.input.subtitleSrt, draft: f.draft, speechTranscripts: 'coverage.json' })
    expect(call).toHaveProperty('transcriptsPath', transcriptsPath)
    let decisionsPath: string | undefined
    if (kind.startsWith('recorded') || kind === 'stale keep') {
      const coverage = await reviewSpeechCoverage({ project: f.project, timeline: await readTimeline(f.input.timelinePath),
        sources: new Map([[1, f.shot]]), subtitleSrt: f.input.subtitleSrt, transcriptsPath })
      decisionsPath = join(f.project, 'decisions.json')
      await writePlaceholder(decisionsPath, JSON.stringify({ schema_version: 1, evidence_sha256: coverage.evidence_sha256,
        decisions: coverage.findings.map(item => ({ item_id: item.id, decision: kind === 'recorded unresolved' ? 'unresolved' : 'keep',
          reason: 'fixture listening statement', observed_text: item.text,
          reviewed_start_seconds: item.start_seconds, reviewed_end_seconds: item.end_seconds })) }))
      if (kind === 'stale keep') await writePlaceholder(wordsPath, (await readFile(wordsPath, 'utf8')) + '\n')
    }
    const attempt = stageEpisodeDelivery({ ...f.input, ...(kind === 'missing transcript map' ? {} : { transcriptsPath }),
      ...(decisionsPath === undefined ? {} : { decisionsPath }),
    }, f.draft)
    if (error !== undefined) {
      await expect(attempt).rejects.toThrow(error)
      const entries = await readdir(f.project)
      expect(entries).not.toContain('01_可交付视频')
      expect(entries).not.toContain('成片与草稿回执.json')
    } else {
      expect((await attempt).delivery_package?.status).toBe('candidate')
      expect(JSON.parse(await readFile(f.receipt, 'utf8'))).toHaveProperty('speech_evidence_sha256', expect.stringMatching(/^[0-9a-f]{64}$/u))
    }
  })

  it.each(['strict spanning', 'strict split at rounded cut', 'legacy spanning'] as const)
  ('enforces timeline cut boundaries on the actual SRT only in strict staging: %s', async (kind) => {
    const strict = kind !== 'legacy spanning'
    const clips = [{ shot: 1, startUs: 0, durationUs: 1_500_333 }, { shot: 2, startUs: 1_500_333, durationUs: 3_499_667 }]
    const cues = kind === 'strict split at rounded cut' ? [
      { text: '现在', start: '00:00:01,000', end: '00:00:01,500' },
      { text: '做饭', start: '00:00:01,500', end: '00:00:02,000' },
    ] : [{ text: '现在做饭', start: '00:00:01,000', end: '00:00:02,000' }]
    const f = await fixture(clips, { explicitVisual: false, text: '', cues, requireSpeechCoverage: strict })
    const transcriptsPath = join(f.project, 'coverage.json')
    const words = [{ text: '现在', start: 1, end: 1.49 }, { text: '做饭', start: 0, end: 0.499667 }]
    const sources = new Map(clips.map(clip => [clip.shot, join(f.paths.videoDir, `shot_00${String(clip.shot)}.mp4`)]))
    const shots = await Promise.all(clips.map(async (clip, index) => {
      const stem = `clip${String(clip.shot)}`
      const receipt = `transcript/jobs/${stem}-v1.json`
      const word = words[index]!
      const source = sources.get(clip.shot)!
      await writePlaceholder(join(f.project, receipt), JSON.stringify({ status: 'complete', stem, version: 1,
        source, sourceSha256: await fileSha256(source) }))
      await writePlaceholder(join(f.project, 'transcript/raw', `${stem}-v1.json`), JSON.stringify([{ ...word, words: [word] }]))
      return { shot: clip.shot, receipt }
    }))
    await writePlaceholder(transcriptsPath, JSON.stringify({ shots, display: { embedded: false,
      subtitle_sha256: f.source.subtitle_sha256, video_sha256: f.source.videos.map(video => video.sha256) } }))
    const coverage = await reviewSpeechCoverage({ project: f.project, timeline: await readTimeline(f.input.timelinePath),
      sources, subtitleSrt: f.input.subtitleSrt, transcriptsPath })
    expect(coverage.evidence_complete).toBe(true)
    expect(coverage.findings).toEqual([])
    const attempt = stageEpisodeDelivery({ ...f.input, ...(strict ? { transcriptsPath } : {}) }, f.draft)
    if (kind === 'strict spanning') {
      await expect(attempt).rejects.toThrow(/第 1 条字幕.*跨越.*1\.500333 秒/u)
      const entries = await readdir(f.project)
      expect(entries).not.toContain('01_可交付视频')
      expect(entries).not.toContain('成片与草稿回执.json')
    } else expect((await attempt).delivery_package?.status).toBe('candidate')
  })

  it.each(['other episode', 'different subtitle', 'changed saved draft', 'missing retained shot', 'changed render source'] as const)
  ('rejects %s before writing a delivery', async (defect) => {
    const f = await fixture()
    if (defect === 'other episode') f.source.episode = '25'
    if (defect === 'different subtitle') f.source.subtitle_sha256 = '0'.repeat(64)
    if (defect === 'changed saved draft') await writePlaceholder(join(f.draft, 'draft_content.json'), '{"changed":true}')
    if (defect === 'missing retained shot') f.source.materials.pop()
    if (defect === 'changed render source') await writePlaceholder(f.shot, 'new bytes at same path')
    await writePlaceholder(f.draftSourcePath, JSON.stringify(f.source))
    await expect(stageEpisodeDelivery(f.input, f.draft)).rejects.toThrow(/不符|已变化|缺少/)
    expect(await readdir(f.project)).not.toContain('01_可交付视频')
  })

  it('refuses to publish over other files in the upload folder', async () => {
    const f = await fixture()
    await mkdir(f.upload)
    const previous = join(f.upload, '第26集.mp4')
    await writePlaceholder(previous, 'previous delivery')
    await expect(stageEpisodeDelivery(f.input, f.draft)).rejects.toThrow('冲突的成片')
    expect(await readFile(previous, 'utf8')).toBe('previous delivery')
    expect(await readdir(f.project)).not.toContain('成片与草稿回执.json')
  })

  it('reports a banned output without publishing any candidate', async () => {
    const f = await fixture()
    await runDramaVideo({ method: 'ban', project: f.project, video: f.paths.output, labels: ['字幕错误'] })
    const report = await stageEpisodeDelivery(f.input, f.draft)
    expect(report).toMatchObject({ method: 'stage_delivery', ok: false, written: [] })
    expect(report.delivery_package).toBeUndefined()
    expect(await readdir(f.project)).not.toContain('01_可交付视频')
  })
})
