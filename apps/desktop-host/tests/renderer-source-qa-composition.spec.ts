/** Source-review rendering acquires and releases the actual Host service scope. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as Renderer from '@deepseek-ai/dsh-tool-episode-render'
import { sourceQaFixture } from '../../../packages/drama/tool-episode-render/tests/source-qa-fixture.ts'

it('uses late Host services for registered strict rendering and releases them without disabling legacy tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'renderer-source-qa-'))
  const ctx = new Context()
  const signal = new AbortController().signal
  let calls = 0
  try {
    const write = async (path: string, text: string) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text)
      return createHash('sha256').update(text).digest('hex')
    }
    const media = join(root, 'source.mp4')
    const mediaSha = await write(media, 'untrusted source fixture; no encoder should run')
    const qa = await sourceQaFixture(root, media)
    const packageSha = await write(join(root, 'episode_packages', '24', 'package.json'),
      JSON.stringify({ episode: '24', video_tasks: [{ shots: [1] }] }))
    const frame = join(root, 'review-frame.png')
    await write(frame, 'declared frame; not actual Session image evidence')
    const receipt = join(root, 'download.json')
    await write(receipt, JSON.stringify({ version: 1, kind: 'video', media_type: 'video/mp4',
      path: media, sha256: `sha256:${mediaSha}`, source_sha256: '1'.repeat(64) }))
    const content = Object.fromEntries(['identity', 'wardrobe', 'scene', 'prop', 'action_and_dialogue',
      'visible_artifacts', 'continuity', 'voice_and_speaker', 'av_sync', 'sensitive_content'].map(key => [key, 'pass']))
    await write(join(root, 'reviews', 'ep24-p01.json'), JSON.stringify({ episode: '24', package: 1,
      status: 'approved', package_sha256: packageSha, video_path: media, video_sha256: mediaSha,
      subtitle_cleanup: 'not_required', content_review: { ...content, embedded_subtitles: 'absent' },
      review_frames: [frame], original_download_receipt_path: receipt, source_qa: { version: 1, selected: qa.declaration } }))
    await write(join(root, 'editing', '24-sources.json'), JSON.stringify({ shots: [{ shot: 1, package: 1, video: media }] }))
    const timeline = join(root, 'editing', '24-timeline.json')
    await write(timeline, JSON.stringify({ clips: [{ shot: 1, start_us: 0, duration_us: 5_000_000 }], body_end: 5,
      delivery: { visual_medium: 'animation_3d', width: 480, height: 854, fps: 24, require_source_review: true } }))
    const subtitle = join(root, 'editing', '24.srt')
    await write(subtitle, '1\n00:00:01,000 --> 00:00:02,000\n你好\n')

    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins['renderer-source-qa'] = Renderer
    const config = join(root, 'cordis.yml')
    await write(config, '- name: cordis:renderer-source-qa\n  config:\n    preferNvenc: false\n')
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    const renderer = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:renderer-source-qa')?.fiber
    if (renderer === undefined) throw Error('renderer was not loaded')
    await renderer.await()

    const id = SessionId('test-source-session')
    const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: root, isSeeded: false })
    let scope: Scope
    const agent: Agent = { id, options: {}, session, inbox: unsupportedInbox(), status: 'idle',
      get ctx() { return scope.ctx }, send() {}, followup() {}, inject() {}, cancel() {}, whenIdle: () => Promise.resolve(),
      steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }), runMaintenance: task => task(signal) }
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools'] }))
    await ctx.agents.register(agent)
    session.append('turn/start', { turn: 1 })
    const render = () => executeModelToolFixture(ctx, { name: 'drama_render', callId: ToolCallId(`source-qa-${++calls}`), agent,
      arguments: { method: 'render', project: root, episode: 24, timeline, subtitle_srt: subtitle, last_shot: 1,
        bgm: join(root, 'not-opened-before-source-review.wav') }, signal })
    const requireError = async (message: string) => {
      const result = await render()
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain(message)
      expect(JSON.stringify(result.content)).not.toContain('without inject')
    }
    await requireError('SOURCE_QA_HOST_UNAVAILABLE')

    const provideServices = async () => ctx.plugin(async (inner: Context) => {
      await inner.plugin(LocalFileSystem, { cwd: root })
      // The policy result is fixed; filesystem identity and Session review verification are real.
      inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) } as never)
    })
    const first = await provideServices()
    await vi.waitFor(() => requireError('SOURCE_QA_REVIEW'))
    await first.dispose()
    await requireError('SOURCE_QA_HOST_UNAVAILABLE')
    const second = await provideServices()
    await vi.waitFor(() => requireError('SOURCE_QA_REVIEW'))
    await second.dispose()
    await requireError('SOURCE_QA_HOST_UNAVAILABLE')

    // The optional strict-review scope must not remove the legacy tool registration.
    expect(ctx.tools.get('drama_render')).toBeDefined()
    const legacy = await executeModelToolFixture(ctx, { name: 'drama_render', callId: ToolCallId(`source-qa-${++calls}`), agent,
      arguments: { method: 'subtitle_overlay', project: root, episode: 24,
        timeline: join(root, 'missing-legacy-timeline.json'), subtitle_srt: subtitle, subtitle_plan: 'missing-plan.json' }, signal })
    expect(legacy.isError).toBe(true)
    expect(JSON.stringify(legacy.content)).not.toContain('SOURCE_QA_HOST_UNAVAILABLE')
    await renderer.dispose()
    expect(ctx.tools.get('drama_render')).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
