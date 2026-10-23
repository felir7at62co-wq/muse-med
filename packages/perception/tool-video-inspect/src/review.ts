/** Complete-episode image observation, with durable progress and delivery enforcement. */
import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { isAgentLoopRequest, IMAGE_OFFLOAD_REQUIRED_CODE } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { probeVideo, runMedia } from './media.ts'
import { scanReviewFrames } from './review-scan.ts'
import { installReviewState, reviewsOf, saveReview, reviewImage, pendingReview, reviewFrameSchema, VideoReviewId, type VideoReview } from './review-state.ts'
import type { Config } from './index.ts'

const parameters = z.object({ method: z.enum(['scan', 'next', 'observe', 'status', 'metadata']).default('scan'),
  file_path: z.string().min(1), episode: z.string().min(1).max(100).optional(),
  observations: z.array(z.object({ frame_id: z.string(), visible: z.string().trim().min(8).max(2000),
    change: z.string().trim().min(2).max(1000), uncertainty: z.string().trim().max(1000) })).optional() })

function taskResult(review: VideoReview, limit: number, batch = false) {
  const pending = review.frames.filter(frame => frame.observation === undefined)
  const selected = (pending.length ? pending : review.frames).filter(frame => !batch || frame.image !== undefined).slice(0, limit)
  return { review_id: review.id, episode: review.episode, path: review.path, source_version: review.source_version,
    scan_complete: review.scan_complete, scanned_until: review.scanned_until, duration: review.duration,
    total: review.frames.length, recorded: review.frames.length - pending.length, pending: pending.length,
    complete: pendingReview(review) === 0,
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
      + '画面变化候选不是人物身份或动作结论；正文仅采用有画面依据的有效动作，独立动作写▲，同步短动作写人物括注。',
  }
}
type ReviewResult = ReturnType<typeof taskResult> & { observation_report?: string }

const resultSchema = z.object({ review_id: z.string(), episode: z.string(), total: z.number(), recorded: z.number(), pending: z.number(),
  complete: z.boolean(), frames: z.array(reviewFrameSchema.extend({ status: z.string() })) }).loose()

function content(serialized: string): ContentBlock[] {
  const value = resultSchema.parse(JSON.parse(serialized))
  const text = { ...value, frames: value.frames.map(({ image: _image, ...frame }) => frame) }
  const result: ContentBlock[] = [{ type: 'text', text: JSON.stringify(text) }]
  for (const frame of value.frames) {
    const image = reviewImage(frame)
    if (image !== undefined && frame.observation === undefined) {
      result.push({ type: 'text', text:  `VIDEO_FRAME ${value.review_id}/${frame.id} ${value.episode} ${frame.time}s附近：待逐图观察记录。` },
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
    for (const message of options.messages) {
      let label: string | undefined
      for (const block of message.content) {
        if (block.type === 'text') {
          const marker = /^VIDEO_FRAME (\S+) /.exec(block.text)
          if (marker !== null) label = marker[1]
        }
        if (block.type === 'image' && block.offloaded !== true && label !== undefined) {
          delivered.set(label, block.attachment.attachmentId)
        }
      }
    }
    const admitted = session === undefined || !model?.inputModalities?.includes('image') ? []
      : Object.values(reviewsOf(ctx, session)).flatMap(review => review.frames
        .filter(frame => !frame.exposed && frame.image !== undefined
          && delivered.get(`${review.id}/${frame.id}`) === frame.image.attachmentId)
        .map(frame => ({ path: review.path, review: review.id, frame: frame.id, image: frame.image?.attachmentId })))
    let successful = false
    for await (const chunk of next()) {
      if (chunk.type === 'finish') {
        successful = chunk.reason.kind === 'stop' || chunk.reason.kind === 'tool-calls'
        if (chunk.reason.kind === 'error' && chunk.reason.failure.code === IMAGE_OFFLOAD_REQUIRED_CODE && session !== undefined) {
          batchLimits.set(session.id, 1)
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
      + '所有检测帧进入图像模型并留下记录后才允许Word导出和present；中间稿可以保存。不把声学编号当角色身份，不凭单帧编造动作。',
    parameters: { file_path: { type: 'string', required: true, description: '当前集实际完整视频路径。' },
      episode: { type: 'string', description: '首次scan时标记集号；省略则使用实际视频路径。' },
      method: { type: 'string', enum: ['scan', 'next', 'observe', 'status', 'metadata'], description: '默认scan；scan扫描整集并返回首批，next查看下一批，observe记录本批每张画面，status读取进度。metadata仅查询，不建立已看过记录。' },
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
        const describe = async (review: VideoReview, batch = false): Promise<ReviewResult> => {
          const result: ReviewResult = taskResult(review, batchFrames, batch)
          if (!result.complete) return result
          const contents = JSON.stringify(review, null, 2) + '\n'
          const notes = review.frames.map(({ id, observation }) => ({ id, observation }))
          const digest = createHash('sha256').update(JSON.stringify(notes)).digest('hex')
          const report = await ctx.fs.resolve(`.muse/video-observations/${review.id}-${digest}.json`,
            { cwd: policy.workspaceRoot, signal })
          if (await ctx.fs.stat(report, signal) === undefined) {
            await ctx.fs.writeText(report, contents, { kind: 'createIfAbsent' }, signal, policy)
          } else if (await ctx.fs.readText(report, signal) !== contents) {
            throw Error('VIDEO_OBSERVATION_REPORT_CHANGED: observation report bytes changed; retain the Session record')
          }
          return { ...result, observation_report: report.displayPath }
        }
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
          const contextual = review.frames.filter(frame => notes.has(frame.id) && frame.observation?.uncertainty
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
