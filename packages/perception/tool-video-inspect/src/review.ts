/** Complete-episode image observation, with durable progress and delivery enforcement. */
import { randomUUID, createHash } from 'node:crypto'
import { dirname, relative } from 'node:path'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { isAgentLoopRequest, IMAGE_OFFLOAD_REQUIRED_CODE } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { probeVideo, runMedia } from './media.ts'
import { scanReviewFrames } from './review-scan.ts'
import { installReviewState, reviewsOf, saveReview, reviewImage, pendingReview, hasReviewUncertainty,
  reviewFrameSchema, VideoReviewId, type VideoReview } from './review-state.ts'
import type { Config } from './index.ts'
import { compareReviewDraft } from './review-compare.ts'
import { bindReviewEvents, reviewEventCurrent, reviewEventEvidence, reviewEventNoteSchema } from './review-events.ts'
import { reviewSpeech, type ReviewSpeech, type ReviewSpeechLink, type ReviewSpeechUnavailable } from './review-speech.ts'
import { reviewBatchAfterOffload } from './review-batch.ts'
import { buildVideoSourceTimeline, type VideoSourceTimeline } from './review-timeline.ts'

const parameters = z.object({ method: z.enum(['scan', 'next', 'revisit', 'observe', 'events', 'status', 'metadata', 'timeline', 'compare']).default('scan'),
  file_path: z.string().min(1), episode: z.string().min(1).max(100).optional(),
  draft_path: z.string().min(1).optional(), transcript_path: z.string().min(1).optional(),
  event_groups: z.array(reviewEventNoteSchema).optional(),
  timeline_start_seconds: z.number().nonnegative().optional(), timeline_end_seconds: z.number().positive().optional(),
  frame_ids: z.array(z.string().min(1)).optional(),
  observations: z.array(z.object({ frame_id: z.string(), visible: z.string().trim().min(8).max(2000),
    change: z.string().trim().min(2).max(1000), uncertainty: z.string().trim().max(1000) })).optional() })

function taskResult(review: VideoReview, limit: number, batch = false) {
  const pending = review.frames.filter(frame => frame.observation === undefined)
  const selected = (pending.length ? pending : review.frames).filter(frame => !batch || frame.image !== undefined).slice(0, limit)
  return { review_id: review.id, episode: review.episode, path: review.path, source_version: review.source_version,
    scan_complete: review.scan_complete, scanned_until: review.scanned_until, duration: review.duration,
    total: review.frames.length, recorded: review.frames.length - pending.length, pending: pending.length,
    complete: pendingReview(review) === 0,
    event_groups: (review.event_groups ?? []).map(event => ({ ...event, evidence_current: reviewEventCurrent(event, review.frames),
      evidence_source: 'model_authored_observations', evidence: reviewEventEvidence(event, review.frames) })),
    ...review.transcript_reference === undefined ? {} : { transcript_reference: review.transcript_reference },
    frames_not_shown: review.frames.length - selected.length,
    frames: selected.map((frame) => {
      const { image, decode: _decode, ...data } = frame
      return { ...data, ...batch && image !== undefined ? { image } : {},
        status: frame.observation !== undefined ? '已记录' : frame.exposed ? '待记录' : '待查看' }
    }),
    next: !review.scan_complete ? 'scan' : pending.length ? 'next' : 'complete',
    notice: '逐张记录画面中可见的人物、位置、动作、神态或道具，以及相对前后画面的变化；不清楚的内容写入uncertainty并定点补看。'
      + '图片进入模型请求不代表语义判断正确。全部检测帧须实际呈现并留下观察记录后，才能正式导出或交付当前任务。'
      + 'frames仅列本批；其余仍保留在完整清单，不能据此声称全片已看完。'
      + '画面变化候选不是人物身份或动作结论；独立画面交代、人物进出、位置变化、道具操作和无对白反应按实际先后写入▲，括注只交代这句台词的表演，不重复同一动作或按帧数凑行。'
      + '可用events将连续帧归为动作事件；transcript_path保留原ASR分段并列出连续发言候选。'
      + '正文保存后可用compare和draft_path核对动作、对白和承接；可选提示，不新增交付条件。',
  }
}
type ReviewResult = ReturnType<typeof taskResult> & {
  observation_report?: string
  comparison?: ReturnType<typeof compareReviewDraft>
  source_timeline?: VideoSourceTimeline
  source_timeline_index?: {
    available: true
    source_version: string
    total_windows: number
    pending_frames: number
    scan_complete: boolean
    window_seconds: number
    index_omitted_for_budget: boolean
    speech_status: 'available' | 'unavailable' | 'not_linked'
    speech_segment_count?: number
    windows?: {
      window_id: string
      start_seconds: number
      end_seconds: number
      frame_count: number
      recorded_count: number
      event_note_count: number
      speech_segment_ids: string[]
      continuous_speech_candidate_indexes: number[]
    }[]
  }
  speech?: ReviewSpeech
  speech_unavailable?: ReviewSpeechUnavailable
}

const resultSchema = z.object({ review_id: z.string(), episode: z.string(), total: z.number(), recorded: z.number(), pending: z.number(),
  complete: z.boolean(), frames: z.array(reviewFrameSchema.extend({ status: z.string(), revisited: z.boolean().optional() })) }).loose()

function content(serialized: string): ContentBlock[] {
  const value = resultSchema.parse(JSON.parse(serialized))
  const text = { ...value, frames: value.frames.map(({ image: _image, ...frame }) => frame) }
  const result: ContentBlock[] = [{ type: 'text', text: JSON.stringify(text) }]
  for (const frame of value.frames) {
    const image = reviewImage(frame)
    if (image !== undefined && (frame.observation === undefined || frame.revisited === true)) {
      result.push({ type: 'text', text:  `VIDEO_FRAME ${value.review_id}/${frame.id} ${value.episode} ${frame.time}s附近：`
        + (frame.revisited === true ? '重看缓存原图；原观察保留，供核对。' : '待逐图观察记录。') },
      { type: 'image', attachment: image })
    }
  }
  return result
}

/**
 * Register the Muse whole-episode video tool, actual image admission and final-delivery guard.
 * @param ctx - Agent-scoped tools and Host observation services.
 * @param config - Validated product settings; model arguments cannot reduce coverage.
 * @param run - Existing lifecycle owner that bounds media work and waits for shutdown.
 * @param imageRoute - Requires the current Session's image-capable route.
 */
export function applyCompleteReview(ctx: Context, config: Config,
  run: <T>(exec: ToolExecution, operation: (signal: AbortSignal) => Promise<T>) => Promise<T>,
  imageRoute: (ctx: Context, exec: ToolExecution) => Promise<void>): void {
  const llm = ctx.get('llm')
  if (ctx.get('sessionProjections') === undefined || llm === undefined) {
    throw Error('Complete video observation requires sessionProjections and llm')
  }
  installReviewState(ctx)
  const sessions = new Map<SessionId, Session>()
  const batchLimits = new Map<SessionId, number>()
  let active = true
  ctx.on('session/event', (session) => { sessions.set(session.id, session) })
  ctx.on('session/disposed', (session) => { sessions.delete(session.id); batchLimits.delete(session.id) })
  ctx.effect(() => () => { active = false; sessions.clear(); batchLimits.clear() })

  ctx.on('llm/stream', async function* (options, next) {
    const session = options.sessionId === undefined ? undefined : sessions.get(options.sessionId)
    const model = session === undefined || !isAgentLoopRequest(options) ? undefined
      : await llm.resolveModelInfo(options.provider, options.model, options.signal)
    const delivered = new Map<string, string>()
    const retained: { label: string | undefined; attachment: string }[] = []
    for (const message of options.messages) {
      let label: string | undefined
      for (const block of message.content) {
        if (block.type === 'text') {
          const marker = /^VIDEO_FRAME (\S+) /.exec(block.text)
          if (marker !== null) label = marker[1]
        }
        if (block.type === 'image' && block.offloaded !== true) {
          if (message.role === 'user' || message.role === 'tool') retained.push({ label, attachment: block.attachment.attachmentId })
          if (label !== undefined) delivered.set(label, block.attachment.attachmentId)
        }
      }
    }
    const admitted = session === undefined || !model?.inputModalities?.includes('image') ? []
      : Object.values(reviewsOf(ctx, session)).flatMap(review => review.frames
        .filter(frame => !frame.exposed && frame.image !== undefined
          && delivered.get(`${review.id}/${frame.id}`) === frame.image.attachmentId)
        .map(frame => ({ path: review.path, review: review.id, frame: frame.id, image: frame.image?.attachmentId })))
    const retainedPending = retained.map(image => admitted.some(frame => `${frame.review}/${frame.frame}` === image.label
      && frame.image === image.attachment) ? image.label : undefined)
    let successful = false
    for await (const chunk of next()) {
      if (chunk.type === 'finish') {
        successful = chunk.reason.kind === 'stop' || chunk.reason.kind === 'tool-calls'
        if (chunk.reason.kind === 'error' && chunk.reason.failure.code === IMAGE_OFFLOAD_REQUIRED_CODE
          && chunk.reason.failure.offloadImages !== undefined && session !== undefined) {
          const current = batchLimits.get(session.id) ?? config.reviewBatchFrames
          const reduced = reviewBatchAfterOffload(retainedPending, chunk.reason.failure.offloadImages, current)
          if (reduced < current) batchLimits.set(session.id, reduced)
        }
      }
      yield chunk
    }
    if (!active || !successful || options.signal?.aborted || session === undefined) return
    for (const path of new Set(admitted.map(frame => frame.path))) {
      // Review projections retain source keys until their owning plugin is disposed.
      const current = reviewsOf(ctx, session)[path] as VideoReview
      saveReview(ctx, session, { ...current, frames: current.frames.map(frame => admitted.some(row => row.review === current.id
        && row.frame === frame.id && row.image === frame.image?.attachmentId) ? { ...frame, exposed: true } : frame) })
    }
  })

  const denial = (exec: Readonly<ToolExecution>): string | undefined => {
    if (exec.name === 'video_contact_sheet') return 'VIDEO_REVIEW_REQUIRED: 本任务请使用 video_inspect；工具自动扫描整集，不能用概览取样替代逐图查看。'
    if (!['screenplay_export_docx', 'present'].includes(exec.name) || exec.agent === undefined) return undefined
    const incomplete = Object.values(reviewsOf(ctx, exec.agent.session)).filter(review => pendingReview(review) > 0)
    if (!incomplete.length) return undefined
    return 'VIDEO_REVIEW_PENDING: 尚不能正式导出或交付。' + incomplete.map(review =>
      `${review.episode}：${review.scan_complete ? `${pendingReview(review)}张待查看或记录` : '整集扫描未完成'}；`
      + `video_inspect file_path=${JSON.stringify(review.path)} method=${review.scan_complete ? 'next' : 'scan'}`).join('；')
  }
  ctx.tools.guard(denial)
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (['present', 'screenplay_export_docx'].includes(exec.name) && exec.agent !== undefined) {
      const policy = ctx.sandboxPolicy.resolve({ session: exec.agent.session })
      for (const review of Object.values(reviewsOf(ctx, exec.agent.session))) {
        const target = await ctx.fs.resolve(review.path, { cwd: policy.workspaceRoot, signal: exec.signal })
        if ((await ctx.fs.stat(target, exec.signal))?.version !== review.source_version) {
          return { kind: 'deny', reason: `VIDEO_REVIEW_SOURCE_CHANGED: ${review.episode}的视频已变化，请重新scan当前视频。` }
        }
      }
    }
    return next()
  })

  ctx.tools.register(defineTool({ name: 'video_inspect',
    description: '查看视频并完成逐集画面观察。scan自动扫描整集的切镜和镜头内显著画面变化，不能选择帧数或跳过区间；默认scan。'
      + 'next逐批返回全部关键帧的真实图片；observe按frame_id逐张记录具体画面、变化和疑点。status读取全部进度与记录。'
      + 'events可把已记录帧归为动作事件；transcript_path读取已保存ASR并保留原段，列出连续发言候选。'
      + 'timeline按实际时间并列记录、事件笔记和ASR；时间窗不是换场或动作分界，不自动编造动作。'
      + 'compare配合draft_path只读对照事件、对白时间与实际正文，不自动判定覆盖或拦截交付。'
      + '所有检测帧进入图像模型并留下记录后才允许Word导出和present；中间稿可以保存。不把声学编号当角色身份，不凭单帧编造动作。',
    parameters: { file_path: { type: 'string', required: true, description: '当前集实际完整视频路径。' },
      episode: { type: 'string', description: '首次scan时标记集号；省略则使用实际视频路径。' },
      method: { type: 'string', enum: ['scan', 'next', 'revisit', 'observe', 'events', 'status', 'metadata', 'timeline', 'compare'], description: '默认scan；next查看下一批，revisit按frame_ids重显已记录原图，observe逐图记录，events保存当前视频的完整动作事件表，status读取进度；timeline按时间并列画面记录、事件笔记与ASR；compare对照已记录画面、事件与当前稿；metadata不建立已查看记录。' },
      timeline_start_seconds: { type: 'number', description: 'timeline可选的来源开始秒数；仅选择核对材料，不改变全片扫描和观察进度。' },
      timeline_end_seconds: { type: 'number', description: 'timeline可选的来源结束秒数；局部材料不代表整集已核对。省略则到本集结尾。' },
      frame_ids: { type: 'array', items: { type: 'string' }, description: 'revisit需要重看的已记录frame_id，数量不超过当前批上限；返回缓存原图及原观察，不重新抽帧、不重置记录。' },
      draft_path: { type: 'string', description: 'compare使用的本集已保存UTF-8剧本路径；返回完整正文与时间顺序观察记录，不写稿、不自动审核。Word请使用其对应文本源稿。' },
      transcript_path: { type: 'string', description: '可选本集audio_transcribe已保存JSON路径；返回原段、时间、声学编号和相邻同号连续发言候选，不改原话、不推定角色姓名。任何method均可附带。' },
      event_groups: { type: 'array', description: 'events使用；替换当前完整事件表，空数组清空。连续多帧可支持一个动作；只引用已记录frame_id，保留不确定性，不按帧数凑事件。',
        items: { type: 'object', additionalProperties: false, properties: {
          event_id: { type: 'string', required: true }, frame_ids: { type: 'array', items: { type: 'string' }, required: true },
          actor: { type: 'string', required: true }, action: { type: 'string', required: true }, object: { type: 'string', required: true },
          before: { type: 'string', required: true }, after: { type: 'string', required: true }, uncertainty: { type: 'string', required: true },
        } } },
      observations: { type: 'array', description: 'observe时按实际返回的frame_id逐图记录；不能用“已查看”或“同上”代替内容。',
        items: { type: 'object', additionalProperties: false, properties: {
          frame_id: { type: 'string', required: true }, visible: { type: 'string', required: true, description: '具体可见人物、位置、动作、神态或道具；至少8个字符。' },
          change: { type: 'string', required: true, description: '与邻近画面的变化；无变化也需据实说明。' },
          uncertainty: { type: 'string', required: true, description: '无法确定的内容；无疑点填空字符串，不猜测。' },
        } } },
    }, output: { schema: { type: 'string' }, render: (_args, value) => content(value),
      presentationMeta: (_args, serialized) => {
        const value = resultSchema.parse(JSON.parse(serialized))
        return { episode: value.episode, total: value.total, recorded: value.recorded, pending: value.pending, complete: value.complete }
      } },
    isConcurrencySafe: () => false,
    async execute(raw, exec): Promise<string> {
      const args = parameters.strict().parse(raw)
      if (exec.agent === undefined) throw Error('Video observation requires an initiating Session')
      const session = exec.agent.session
      const batchFrames = batchLimits.get(session.id) ?? config.reviewBatchFrames
      sessions.set(session.id, session)
      const result = await run(exec, async (signal): Promise<ReviewResult> => {
        const policy = ctx.sandboxPolicy.resolve({ session })
        const unavailableNotice = '已保留原ASR引用，本次不使用不匹配或不可读的转写；可显式提供transcript_path重新关联。画面事件与正文对照可继续。'
        const speechFor = async (review: VideoReview): Promise<ReviewSpeechLink> => {
          const reference = review.transcript_reference, path = args.transcript_path ?? reference?.path
          if (path === undefined) return {}
          let currentVersion: string | undefined
          try {
            const target = await ctx.fs.resolve(path, { cwd: policy.workspaceRoot, signal })
            const before = await ctx.fs.stat(target, signal)
            currentVersion = before?.version
            if (args.transcript_path === undefined && before?.version !== reference?.version) {
              throw Error('VIDEO_TRANSCRIPT_CHANGED: 已关联ASR的版本变化或文件缺失。')
            }
            if (before?.type !== 'file' || before.size === undefined || before.size > config.maxTranscriptBytes) {
              throw Error('VIDEO_TRANSCRIPT_SIZE: ASR须为maxTranscriptBytes以内的完整本集JSON。')
            }
            const bytes = await ctx.fs.readBytes(target, signal, config.maxTranscriptBytes)
            const speech = reviewSpeech({ path: target.displayPath, version: before.version,
              text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }, review.duration)
            if ((await ctx.fs.stat(target, signal))?.version !== before.version) throw Error('VIDEO_TRANSCRIPT_CHANGED: ASR读取期间变化，请回读。')
            if (args.transcript_path === undefined && speech.source.sha256 !== reference?.sha256) {
              throw Error('VIDEO_TRANSCRIPT_CHANGED: 已关联ASR的文件摘要变化。')
            }
            ctx.emit('fs/observed', target, { kind: 'present', version: before.version }, exec)
            return { speech, transcript_reference: {
              path: speech.source.path, version: speech.source.version, sha256: speech.source.sha256,
            } }
          } catch (error) {
            if (args.transcript_path !== undefined || reference === undefined) throw error
            signal.throwIfAborted()
            return { speech_unavailable: { reference, ...currentVersion === undefined ? {} : { current_version: currentVersion },
              reason: (error instanceof Error ? error.message : String(error)).slice(0, 2000), notice: unavailableNotice } }
          }
        }
        const bounded = (result: ReviewResult): ReviewResult => {
          if (Buffer.byteLength(JSON.stringify(result)) > config.reviewCompareMaxBytes) {
            throw Error('VIDEO_COMPARE_SIZE: 完整事件、转写与正文超出reviewCompareMaxBytes；未截断材料，不影响保存与交付。')
          }
          return result
        }
        const boundedSpeech = (materialize: (link: ReviewSpeechLink) => ReviewResult, link: ReviewSpeechLink): ReviewResult => {
          try { return bounded(materialize(link)) } catch (error) {
            if (args.transcript_path !== undefined || link.speech === undefined || link.transcript_reference === undefined
              || !(error instanceof Error) || !error.message.startsWith('VIDEO_COMPARE_SIZE:')) throw error
            return bounded(materialize({ speech_unavailable: { reference: link.transcript_reference,
              current_version: link.transcript_reference.version, reason: error.message, notice: unavailableNotice } }))
          }
        }
        const indexed = (result: ReviewResult, review: VideoReview, link: ReviewSpeechLink): ReviewResult => {
          if (!review.id) return result
          const timeline = buildVideoSourceTimeline(review, { windowSeconds: config.reviewTimelineWindowSeconds },
            link.speech, link.speech_unavailable)
          const summary: NonNullable<ReviewResult['source_timeline_index']> = { available: true,
            source_version: review.source_version, total_windows: timeline.windows.length,
            pending_frames: review.frames.filter(frame => frame.observation === undefined).length, scan_complete: review.scan_complete,
            window_seconds: config.reviewTimelineWindowSeconds, index_omitted_for_budget: false,
            speech_status: link.speech !== undefined ? 'available' : link.speech_unavailable === undefined ? 'not_linked' : 'unavailable',
            ...link.speech === undefined ? {} : { speech_segment_count: link.speech.segments.length },
            windows: timeline.windows.map(window => ({ window_id: window.window_id, start_seconds: window.start_seconds,
              end_seconds: window.end_seconds, frame_count: window.frames.length,
              recorded_count: window.frames.filter(frame => frame.observation !== undefined).length,
              event_note_count: window.event_notes.length, speech_segment_ids: window.speech_segment_ids,
              continuous_speech_candidate_indexes: window.continuous_speech_candidate_indexes })) }
          const complete = { ...result, source_timeline_index: summary }
          if (Buffer.byteLength(JSON.stringify(complete)) <= config.reviewCompareMaxBytes) return complete
          const { windows: _windows, ...compact } = summary
          const reduced = { ...result, source_timeline_index: { ...compact, index_omitted_for_budget: true } }
          return Buffer.byteLength(JSON.stringify(reduced)) <= config.reviewCompareMaxBytes ? reduced : result
        }
        const reportFor = async (review: VideoReview) => {
          const contents = JSON.stringify(review, null, 2) + '\n'
          const notes = review.frames.map(({ id, observation }) => ({ id, observation }))
          const digest = createHash('sha256').update(JSON.stringify(review.event_groups === undefined && review.transcript_reference === undefined ? notes
            : { frames: notes, ...review.event_groups === undefined ? {} : { event_groups: review.event_groups },
              ...review.transcript_reference === undefined ? {} : { transcript_reference: {
                ...review.transcript_reference, path: relative(dirname(review.path), review.transcript_reference.path),
              } } })).digest('hex')
          const report = await ctx.fs.resolve(`.muse/video-observations/${review.id}-${digest}.json`,
            { cwd: policy.workspaceRoot, signal })
          return { contents, report }
        }
        const prepareDescription = async (review: VideoReview, batch = false,
          revisitedFrames?: (ReviewResult['frames'][number] & { revisited: true })[]) => {
          const link = await speechFor(review)
          const linked = link.transcript_reference === undefined ? review : { ...review, transcript_reference: link.transcript_reference }
          if (link.speech !== undefined) {
            const source = await ctx.fs.resolve(review.path, { cwd: policy.workspaceRoot, signal })
            if ((await ctx.fs.stat(source, signal))?.version !== review.source_version) throw Error('VIDEO_REVIEW_SOURCE_CHANGED: 视频在读取ASR期间变化，请回读。')
          }
          const report = revisitedFrames === undefined && pendingReview(linked) === 0 ? await reportFor(linked) : undefined
          const materialize = (link: ReviewSpeechLink): ReviewResult => ({ ...taskResult(linked, batchFrames, batch),
            ...revisitedFrames === undefined ? {} : {
              frames: revisitedFrames, frames_not_shown: linked.frames.length - revisitedFrames.length,
            },
            ...link.speech === undefined ? {} : { speech: link.speech },
            ...link.speech_unavailable === undefined ? {} : { speech_unavailable: link.speech_unavailable },
            ...report === undefined ? {} : { observation_report: report.report.displayPath } })
          const result = link.speech !== undefined || link.speech_unavailable !== undefined || linked.event_groups !== undefined
            || linked.transcript_reference !== undefined ? boundedSpeech(materialize, link) : materialize(link)
          const sourceLink = result.speech_unavailable === undefined ? link : { speech_unavailable: result.speech_unavailable }
          return { review: linked, result: indexed(result, linked, sourceLink), report }
        }
        const publishDescription = async (prepared: Awaited<ReturnType<typeof prepareDescription>>): Promise<ReviewResult> => {
          if (reviewsOf(ctx, session)[prepared.review.path]?.id === prepared.review.id) saveReview(ctx, session, prepared.review)
          if (prepared.report === undefined) return prepared.result
          const { contents, report } = prepared.report
          if (await ctx.fs.stat(report, signal) === undefined) {
            await ctx.fs.writeText(report, contents, { kind: 'createIfAbsent' }, signal, policy)
          } else if (await ctx.fs.readText(report, signal) !== contents) {
            throw Error('VIDEO_OBSERVATION_REPORT_CHANGED: observation report bytes changed; retain the Session record')
          }
          return prepared.result
        }
        const describe = async (review: VideoReview, batch = false): Promise<ReviewResult> =>
          publishDescription(await prepareDescription(review, batch))
        const target = await ctx.fs.resolve(args.file_path, { cwd: policy.workspaceRoot, signal })
        const info = await ctx.fs.stat(target, signal)
        if (!info || info.type !== 'file' || info.size === undefined || info.size > config.maxSourceBytes) throw Error('Video input must be a bounded regular file')
        await ctx.fs.readByteRange(target, { offset: 0, length: 1 }, signal)
        const path = target.displayPath, source = ctx.fs.processPath(target)
        let review = reviewsOf(ctx, session)[path]
        if (args.method === 'metadata' || args.method === 'scan' && (review === undefined || review.source_version !== info.version || !review.scan_complete)) {
          const metadata = await probeVideo(ctx, config.ffprobePath, source, policy, signal,
            { timeoutMs: config.commandTimeoutMs, graceMs: config.graceMs }, 'video')
          if (metadata.duration_seconds > config.maxDurationSeconds || metadata.width * metadata.height > config.maxSourcePixels) throw Error('Video exceeds deployment duration or pixel limits')
          if (args.method === 'metadata') return describe({ id: VideoReviewId(''), path, episode: args.episode ?? path, source_version: info.version,
            duration: metadata.duration_seconds, scanned_until: 0, scan_complete: false, frames: [] })
          await imageRoute(ctx, { ...exec, signal })
          review = { id: VideoReviewId(randomUUID()), path, episode: args.episode ?? path, source_version: info.version,
            duration: metadata.duration_seconds, scanned_until: 0, scan_complete: false, frames: [] }
          saveReview(ctx, session, review)
          const base = review
          const ffmpeg = await ctx.subprocess.resolveExecutable(config.ffmpegPath, undefined, signal)
          const frames = await scanReviewFrames(ctx, source, metadata.duration_seconds, ffmpeg, config, policy, signal,
            (end, frames) => { saveReview(ctx, session, { ...base, scanned_until: end, frames }) })
          if ((await ctx.fs.stat(target, signal))?.version !== info.version) throw Error('VIDEO_REVIEW_SOURCE_CHANGED: source changed while scanning')
          review = { ...base, scan_complete: true, scanned_until: metadata.duration_seconds, frames }
          saveReview(ctx, session, review)
        }
        if (review === undefined) throw Error('VIDEO_REVIEW_REQUIRED: 先使用scan扫描当前完整视频。')
        if (review.source_version !== info.version) throw Error('VIDEO_REVIEW_SOURCE_CHANGED: 视频版本已变，请重新scan。')
        if (args.method === 'timeline') {
          const link = await speechFor(review)
          const linked = link.transcript_reference === undefined ? review : { ...review, transcript_reference: link.transcript_reference }
          const selection = { windowSeconds: config.reviewTimelineWindowSeconds,
            ...args.timeline_start_seconds === undefined ? {} : { startSeconds: args.timeline_start_seconds },
            ...args.timeline_end_seconds === undefined ? {} : { endSeconds: args.timeline_end_seconds } }
          const result = boundedSpeech(link => ({ ...taskResult(linked, batchFrames),
            source_timeline: buildVideoSourceTimeline(linked, selection, link.speech, link.speech_unavailable) }), link)
          if ((await ctx.fs.stat(target, signal))?.version !== review.source_version) throw Error('VIDEO_REVIEW_SOURCE_CHANGED: 视频在读取时间线期间变化，请回读。')
          saveReview(ctx, session, linked)
          return result
        }
        if (args.method === 'compare') {
          if (args.draft_path === undefined) throw Error('VIDEO_COMPARE_DRAFT: compare需要本集已保存的draft_path。')
          const draft = await ctx.fs.resolve(args.draft_path, { cwd: policy.workspaceRoot, signal })
          const before = await ctx.fs.stat(draft, signal)
          if (before?.type !== 'file' || before.size === undefined || before.size > config.reviewCompareMaxBytes) {
            throw Error('VIDEO_COMPARE_SIZE: 剧本须为配置reviewCompareMaxBytes以内的完整UTF-8文本；未返回部分核对材料。')
          }
          const bytes = await ctx.fs.readBytes(draft, signal, config.reviewCompareMaxBytes)
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          const link = await speechFor(review)
          const linked = link.transcript_reference === undefined ? review : { ...review, transcript_reference: link.transcript_reference }
          const result = boundedSpeech(link => ({ ...taskResult(linked, batchFrames), comparison: compareReviewDraft(linked, {
            path: draft.displayPath, version: before.version, text,
          }, link.speech, link.speech_unavailable) }), link)
          if ((await ctx.fs.stat(draft, signal))?.version !== before.version
            || (await ctx.fs.stat(target, signal))?.version !== info.version) throw Error('VIDEO_COMPARE_CHANGED: 视频或剧本读取期间变化，请回读当前版本。')
          ctx.emit('fs/observed', draft, { kind: 'present', version: before.version }, exec)
          saveReview(ctx, session, linked)
          return result
        }
        if (args.method === 'revisit') {
          const current = review
          if (!args.frame_ids?.length || args.frame_ids.length > batchFrames || new Set(args.frame_ids).size !== args.frame_ids.length) {
            throw Error(`VIDEO_REVISIT_INPUT: frame_ids须为1至${batchFrames}个不重复的已记录帧。`)
          }
          const selected = args.frame_ids.map((id) => {
            const frame = current.frames.find(frame => frame.id === id)
            if (frame?.observation === undefined) throw Error(`VIDEO_REVISIT_FRAME: ${id}不是本集已记录帧；未记录画面请使用next。`)
            return frame
          })
          await imageRoute(ctx, { ...exec, signal })
          const frames: (ReviewResult['frames'][number] & { revisited: true })[] = []
          for (const frame of selected) {
            const image = reviewImage(frame)
            if (image === undefined) throw Error(`VIDEO_REVISIT_IMAGE_MISSING: ${frame.id}无原图缓存引用，不重新抽帧。`)
            try { await ctx.attachments.readImage(image, signal) } catch (error) {
              signal.throwIfAborted()
              throw Error(`VIDEO_REVISIT_IMAGE_MISSING: ${frame.id}原图缓存不可读取，不重新抽帧。`
                + (error instanceof Error ? error.message : String(error)))
            }
            const { image: _image, decode: _decode, ...data } = frame
            frames.push({ ...data, image, status: '重看原图', revisited: true })
          }
          const prepared = await prepareDescription(current, false, frames)
          bounded(prepared.result)
          if ((await ctx.fs.stat(target, signal))?.version !== info.version) throw Error('VIDEO_REVIEW_SOURCE_CHANGED: 视频在重看缓存期间变化，请重新scan。')
          return publishDescription(prepared)
        }
        if (args.method === 'events') {
          if (args.event_groups === undefined) throw Error('VIDEO_EVENT_INPUT: events需要event_groups完整表；空数组可清空。')
          const updated = { ...review, event_groups: bindReviewEvents(args.event_groups, review.frames) }
          const prepared = await prepareDescription(updated)
          if ((await ctx.fs.stat(target, signal))?.version !== info.version) throw Error('VIDEO_REVIEW_SOURCE_CHANGED: 视频在记录事件期间变化，请重新scan。')
          saveReview(ctx, session, prepared.review)
          return publishDescription(prepared)
        }
        if (args.method === 'observe') {
          if (!args.observations?.length || args.observations.length > config.reviewBatchFrames) throw Error('observe需要本批逐图记录，不能批量确认全部图片。')
          const notes = new Map(args.observations.map(note => [note.frame_id, note]))
          if (notes.size !== args.observations.length) throw Error('Duplicate observation frame_id')
          for (const [id, note] of notes) {
            const frame = review.frames.find(frame => frame.id === id)
            if (!frame?.exposed) throw Error(`VIDEO_FRAME_NOT_VIEWED: ${id}尚未进入成功的图像模型请求。`)
            if (/^(已查看|看完了|同上|已记录|无变化|same|viewed)[。.!\s]*$/iu.test(note.visible)) throw Error('请记录具体画面内容，不能只确认已查看。')
          }
          review = { ...review, frames: review.frames.map((frame) => {
            const note = notes.get(frame.id)
            return note === undefined ? frame : { ...frame, observation: {
              visible: note.visible, change: note.change, uncertainty: note.uncertainty,
            } }
          }) }
          const contextual = review.frames.filter(frame => notes.has(frame.id) && frame.observation !== undefined
            && hasReviewUncertainty(frame.observation.uncertainty)
            && !frame.reasons.includes('uncertainty_context'))
          const closing = review.frames.reduce((end, frame) => Math.max(end, frame.time), 0)
          const frames = [...review.frames]
          for (const frame of contextual) for (const offset of [-1, 1]) {
            const time = Math.max(0, Math.min(closing, frame.time + offset / config.reviewAnalysisFps))
            if (frames.some(existing => Math.abs(existing.time - time) < 0.001)) continue
            if (frames.length >= config.reviewMaxFrames) throw Error('VIDEO_SCAN_LIMIT: context observations exceed deployment budget')
            frames.push({ id: `F${String(frames.length + 1).padStart(5, '0')}`, time,
              reasons: ['uncertainty_context', `context_for:${frame.id}`], exposed: false })
          }
          review = { ...review, frames }
          saveReview(ctx, session, review)
          return describe(review)
        }
        if (args.method === 'status') return describe(review)
        if (!review.scan_complete) throw Error('VIDEO_SCAN_INCOMPLETE: 请先完成scan。')
        await imageRoute(ctx, { ...exec, signal })
        const next = review.frames.filter(frame => frame.observation === undefined).slice(0, batchFrames)
        const updated = new Map<string, (typeof review.frames)[number]>()
        const ffmpeg = await ctx.subprocess.resolveExecutable(config.ffmpegPath, undefined, signal)
        for (const frame of next) {
          if (frame.image !== undefined) { updated.set(frame.id, frame); continue }
          const output = await runMedia(ctx, [ffmpeg, '-nostdin', '-hide_banner', '-v', 'info', '-protocol_whitelist', 'file,pipe',
            '-ss', String(frame.decode?.start_seconds ?? frame.time), '-copyts', '-i', source, '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1',
            '-vf', `${frame.decode === undefined ? '' : `select='eq(n,${frame.decode.frame_index})',`}scale=w='min(${config.frameMaxDimension},iw)':h='min(${config.frameMaxDimension},ih)':force_original_aspect_ratio=decrease,showinfo`,
            '-c:v', config.frameFormat === 'png' ? 'png' : 'mjpeg',
            ...config.frameFormat === 'jpeg' ? ['-q:v', String(config.frameJpegQuality)] : [],
            '-f', 'image2pipe', 'pipe:1'], policy, signal,
          { timeoutMs: config.commandTimeoutMs, maxBytes: config.maxFrameBytes, graceMs: config.graceMs })
          const timestamp = /\bpts_time:([\d.e+-]+)/.exec(output.diagnostic)
          const time = timestamp === null ? NaN : Number(timestamp[1])
          if (!Number.isFinite(time) || time < 0 || time >= review.duration || !output.bytes.length) throw Error('Frame extraction did not return a source timestamp and image')
          const image = await ctx.attachments.saveImage({ data: output.bytes, mediaType: config.frameFormat === 'png' ? 'image/png' : 'image/jpeg',
            name: `video-${review.id}-${frame.id}.${config.frameFormat}` })
          const extracted = { ...frame, image, decoded_time: time }
          updated.set(frame.id, extracted)
          review = { ...review, frames: review.frames.map(existing => existing.id === frame.id ? extracted : existing) }
          saveReview(ctx, session, review)
        }
        if ((await ctx.fs.stat(target, signal))?.version !== review.source_version) throw Error('VIDEO_REVIEW_SOURCE_CHANGED: source changed during extraction')
        review = { ...review, frames: review.frames.map(frame => updated.get(frame.id) ?? frame) }
        saveReview(ctx, session, review)
        const result = await describe(review, true)
        return { ...result, frames: result.frames.filter(frame => updated.has(frame.id)) }
      })
      return JSON.stringify(result)
    },
  }))
}
