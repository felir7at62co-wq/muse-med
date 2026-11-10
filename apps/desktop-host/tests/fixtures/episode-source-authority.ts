/** Offline native owners and protected source-evidence issuance for Host/worker tests. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { expect, onTestFinished, vi } from 'vitest'
import { createSessionTestController } from '../../../../packages/api/session-controller/tests/test-remote.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { installReviewState, reviewEvidenceJson, saveReview, VideoReviewId, type VideoReview } from '../../../../packages/perception/tool-video-inspect/src/review-state.ts'
import * as WorkspaceOwned from '../../src/workspace-owned-storage.ts'
import { createEpisodeSourceAuthorityResolver } from '../../src/episode-source-authority.ts'
import type { EpisodeSourceAuthorityFactory } from '../../src/episode-source-authority-types.ts'

/** Caller-owned media stays unchanged; only the requested evidence files are created. */
export interface EpisodeSourceReviewInput {
  readonly mediaPath: string
  readonly ocrPath?: string
  readonly inspectionPath?: string
  readonly reviewId?: string
  readonly episode?: string
  readonly durationSeconds?: number
}

/** The helper owns its Context; a supplied root remains caller-owned after teardown. */
export interface EpisodeSourceAuthorityFixtureOptions {
  readonly root?: string
  readonly project?: string
  readonly inputs?: readonly EpisodeSourceReviewInput[]
}

const selection = { provider: 'mock', model: 'original-model' }
const digest = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')

/**
 * Mount real native owners and issue each review through the actual Agent tool pipeline.
 * @param options - Existing project/media inputs, or a private temporary fixture with one source.
 * @returns One Host Context plus exact source bindings, review registration and the source authority factory.
 */
export async function createEpisodeSourceAuthorityFixture(options: EpisodeSourceAuthorityFixtureOptions = {}) {
  const root = await realpath(options.root ?? await mkdtemp(join(tmpdir(), 'muse-source-authority-')))
  const ctx = new Context(), project = options.project ?? join(root, 'project')
  await mkdir(project, { recursive: true })
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    if (options.root === undefined) await rm(root, { recursive: true, force: true })
  })
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'))
  onTestFinished(() => { expect(fetch).not.toHaveBeenCalled(); fetch.mockRestore() })
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeRuntimeContext: false } })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(WorkingDirectory)
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: root })
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await createSessionTestController(ctx, { cwd: root, defaultModelSelection: () => ({ provider: 'mock', model: 'different-default' }) })
  const agent = await ctx.agentLoop.create(SessionId('original-review-session'), selection, { cwd: root })
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session === agent.session) events.push(event) })
  await ctx.sessions.flush(agent.session)
  const legacy = join(root, 'legacy')
  await mkdir(legacy, { recursive: true })
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root: legacy })
  await ctx.plugin(WorkspaceOwned, { root: join(root, 'owned'), sourceBackend: 'json' })
  await ctx.plugin(StorageDomain, { backend: 'json', routes: { workspace: 'muse-workspace-owned' } })
  await ctx.plugin(WorkspaceRegistry)
  const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(agent.id))
  if (workspace === undefined) throw new Error('native workspace was not registered')
  const readReviews = await installReviewState(ctx)
  const script: StreamChunk[][] = [], adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const issued = new Map<string, {
    ocr: Record<string, string>
    inspection: {
      complete: true
      path: string
      source_version: string
      review_id: string
      observation_session_id: string
      observation_report: string
      observation_report_sha256: string
    }
  }>()
  for (const name of ['video_ocr', 'video_inspect'] as const) {
    ctx.tools.register(defineTool({ name, description: 'Offline source evidence producer.',
      parameters: { file_path: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: true }, preserveBodyMeta: true,
        render: (_args, data) => [{ type: 'text', text: JSON.stringify(data) }],
        presentationMeta: (_args, data) => data },
      execute: async (args) => {
        const value = issued.get(args.file_path)
        if (value === undefined) throw new Error('No source evidence was prepared for the requested file')
        return name === 'video_ocr' ? value.ocr : value.inspection
      },
    }))
  }

  let nextReview = 1
  const recordReview = async (input: EpisodeSourceReviewInput) => {
    const index = nextReview++
    const mediaPath = await realpath(input.mediaPath)
    const ocrPath = input.ocrPath ?? join(project, `ocr-${index}.json`)
    const inspectionPath = input.inspectionPath ?? join(project, `review-${index}.json`)
    const source = await ctx.fs.resolve(mediaPath)
    const info = await ctx.fs.stat(source)
    if (info?.type !== 'file') throw new Error('source fixture missing')
    const duration = input.durationSeconds ?? 3
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('source fixture duration must be positive')
    const count = Math.ceil(duration / 0.5)
    const ocr = { schema_version: 1, evidence_algorithm: 'decoded-pts-spatial-v2', path: mediaPath,
      source_version: info.version, duration_seconds: duration, text_source: 'ocr',
      language_requested: 'zh-Hans-CN', language_used: 'zh-Hans-CN',
      interval: { start_seconds: 0, end_seconds: duration }, scan_status: 'complete', text_status: 'no_text_detected',
      coverage: { planned_frame_count: count, processed_frame_count: count, failed_frame_count: 0,
        frame_interval_seconds: 0.5, scanned_ranges: [{ start_seconds: 0, end_seconds: duration }],
        unscanned_ranges: [], failed_timestamps_seconds: [] },
      frames: Array.from({ length: count }, (_, offset) => ({ id: `ocr-frame-${offset + 1}`,
        requested_seconds: offset * 0.5, timestamp_seconds: offset * 0.5,
        image_width: 720, image_height: 1280, lines: [] })), segments: [] }
    const review: VideoReview = { id: VideoReviewId(input.reviewId ?? `review-${index}`), episode: input.episode ?? '01',
      path: mediaPath, source_version: info.version, duration, scanned_until: duration, scan_complete: true,
      frames: [{ id: 'F00001', time: duration / 2, decoded_time: duration / 2, reasons: ['fixture'], exposed: true,
        image: { attachmentId: `fixture-image-${index}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
        observation: { visible: '画面中的人物站在门口等待', change: '人物转头', uncertainty: '' } }] }
    saveReview(readReviews, agent.session, review)
    await writeFile(ocrPath, JSON.stringify(ocr))
    await writeFile(inspectionPath, reviewEvidenceJson(review))
    const binding = { mediaPath, mediaSha256: digest(await readFile(mediaPath)), ocrPath,
      ocrSha256: digest(await readFile(ocrPath)), inspectionPath, inspectionSha256: digest(await readFile(inspectionPath)),
      sessionId: agent.id, reviewId: review.id }
    issued.set(mediaPath, { ocr: { path: mediaPath, source_version: info.version,
      raw_json_path: ocrPath, raw_json_sha256: binding.ocrSha256 },
    inspection: { complete: true, path: mediaPath, source_version: info.version, review_id: review.id,
      observation_session_id: agent.id, observation_report: inspectionPath, observation_report_sha256: binding.inspectionSha256 } })
    script.push(toolCallResponse(`ocr-${index}`, 'video_ocr', { file_path: mediaPath }),
      toolCallResponse(`review-${index}`, 'video_inspect', { file_path: mediaPath }), textResponse('Evidence recorded.'))
    const before = adapter.requests.length
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect the fixed source.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(before + 3)
    const results = events.filter(event => event.type === 'tool/result').slice(-2)
    expect(results.map(event => event.data.message.isError)).toEqual([false, false])
    return { binding, review, ocr }
  }

  let inputs = options.inputs
  if (inputs === undefined) {
    const mediaPath = join(project, 'source.mp4')
    await writeFile(mediaPath, 'fixed source bytes; this test does not encode or request media')
    inputs = [{ mediaPath, ocrPath: join(project, 'ocr.json'), inspectionPath: join(project, 'review.json'), reviewId: 'original-review' }]
  }
  const reviews = []
  for (const input of inputs) reviews.push(await recordReview(input))
  const first = reviews[0]
  if (first === undefined) throw new Error('source fixture needs at least one review input')
  let factory: EpisodeSourceAuthorityFactory | undefined
  const scope = ctx.plugin({ inject: ['sessionController', 'agents', 'sessions', 'generationWorkspaceAuthority',
    'workingDirectory', 'fs', 'sandboxPolicy', 'sessionProjections', 'tools'],
  apply: async (inner: Context) => { factory = await createEpisodeSourceAuthorityResolver(inner) } })
  await scope.await()
  if (factory === undefined) throw new Error('source authority factory not ready')
  return { root, project, ctx, agent, workspace, factory, scope, binding: first.binding, review: first.review, events,
    readReviews, adapter, reviews, recordReview, queueReply: (text: string) => { script.push(textResponse(text)) } }
}
