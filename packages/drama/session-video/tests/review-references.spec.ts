/** Bounded exact-version screenplay, casting and project settings reads. */
import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { stableSha256 } from '@deepseek-ai/dsh-jubian-api'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { expect, it, onTestFinished, vi } from 'vitest'
import { reviewReferences } from '../src/review-references.ts'

class Query extends SessionQueryEngine {
  async searchSessions(): Promise<never> { throw Error('This fixture only reads Session history') }
  async searchEvents(): Promise<never> { throw Error('This fixture only reads Session history') }
}

async function fixture(withWorkspace = true) {
  const root = await mkdtemp(join(tmpdir(), 'muse-review-references-')), ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await ctx.plugin(Sessions).await()
  await ctx.plugin(Projections).await()
  await ctx.plugin(Query).await()
  await ctx.plugin(LocalFileSystem, { cwd: root }).await()
  await ctx.plugin(Attachments, { dshHome: root }).await()
  const session = ctx.sessions.create(SessionId('review-references'), { meta: withWorkspace ? { cwd: root } : {} })
  const signal = new AbortController().signal
  const user = (text: string) => session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
  const tool = (name: string, args: Record<string, unknown>, value: unknown, isError = false) => {
    const callId = ToolCallId(`review-evidence-${session.seq}`)
    session.append('tool/call', { turn: 1, step: 1, name, callId, arguments: JSON.stringify(args) })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, isError,
      content: [{ type: 'text', text: JSON.stringify(value) }] }) }, { surfaceOp: 'append' })
  }
  return { root, ctx, session, signal, user, tool }
}

it('supplies matching authored sections, planned character choices and the declared delivery requirements', async () => {
  const { root, ctx, session, signal } = await fixture()
  const body = `【镜头2】\n${'甲说“下一场见”。'.repeat(100)}\n\n场次 8-2：夜，室内\r\n【镜头3】\r\n乙看向窗边，随后转身。\n\n场次 8-3：日，室外\n【镜头4】\n丙走过桥。\n`
  const source_path = join(root, 'draft.txt'), source_sha256 = createHash('sha256').update(body).digest('hex')
  const plan = { version: 1, operation: 'muse_production', script_id: 45, episode: 8, episode_id: 82, source_path, source_sha256,
    packages: [{ index: 1, storyboard_id: 12, shots: [2, 3] }, { index: 2, storyboard_id: null, shots: [2] }],
    matches: [{ shot: 3, kind: 'character', name: '乙', state: '雨衣', selected_asset_id: 7, selection_basis: 'explicit' },
      { shot: 2, kind: 'character', name: '甲', selected_asset_id: 4, selection_basis: 'explicit' }] }
  const dir = join(root, '.muse', 'production'), fingerprint = stableSha256(plan), plan_path = join(dir, `${fingerprint}.json`)
  await mkdir(dir, { recursive: true })
  await writeFile(source_path, body)
  await writeFile(plan_path, JSON.stringify({ ...plan, fingerprint }))
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 45,
    project_bible: { aspect_ratio: '9:16', visual_medium: 'photorealistic', video: { resolution: '720p' },
      delivery: { width: 1440, height: 2560, fps: 60, min_bitrate_mbps: 4.6,
        subtitle: { require_speech_coverage: true }, unrecognized: 'OMIT_THIS_FIELD' } }, unrelated: 'OMIT_THIS_FIELD' }))
  const receipt = { method: 'preview', script_id: 45, episode: 8, source_path, source_sha256, plan_path, fingerprint }
  const callId = ToolCallId('production-preview')
  session.append('tool/call', { turn: 1, step: 1, name: 'muse_production', callId, arguments: JSON.stringify({ method: 'preview' }) })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId,
    content: [{ type: 'text', text: JSON.stringify(receipt) }], isError: false }) }, { surfaceOp: 'append' })
  const production = { scriptId: 45, episodeNumber: 8, episodeId: 82, storyboardId: 12, packageIndex: 1, shotNumbers: [3] }
  const result = await reviewReferences(ctx, session, production, signal, 1600, 16384)
  expect(result).toMatchObject({ screenplay: { status: 'available', basis: 'recorded_production', sha256: source_sha256,
    text: '场次 8-2：夜，室内\n【镜头3】\r\n乙看向窗边，随后转身。', authored_shots: [3] },
  character_bindings: { status: 'available', basis: 'planned_asset_choices', matches: [plan.matches[0]] },
  delivery: { status: 'available', footage: { aspect_ratio: '9:16', generation_resolution: '720p' },
    final_episode: { width: 1440, height: 2560, fps: 60, min_bitrate_mbps: 4.6, subtitle: { require_speech_coverage: true } } } })
  expect(JSON.stringify(result)).not.toContain('OMIT_THIS_FIELD')
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1600)
  expect(await reviewReferences(ctx, session, { ...production, shotNumbers: [2] }, signal, 16384))
    .toMatchObject({ screenplay: { status: 'available', text: `【镜头2】\n${'甲说“下一场见”。'.repeat(100)}`, authored_shots: [2] } })
  expect(await reviewReferences(ctx, session, { scriptId: 45, episodeNumber: 8, shotNumbers: [4] }, signal, 16384))
    .toMatchObject({ screenplay: { status: 'available', text: '场次 8-3：日，室外\n【镜头4】\n丙走过桥。', authored_shots: [4] },
      character_bindings: { status: 'unavailable' } })
  expect(await reviewReferences(ctx, session, { ...production, shotNumbers: [13] }, signal, 16384))
    .toMatchObject({ screenplay: { status: 'unavailable' }, character_bindings: { status: 'unavailable' } })
  expect(await reviewReferences(ctx, session, { ...production, shotNumbers: [2] }, signal, 1600, 16384))
    .toMatchObject({ screenplay: { status: 'unavailable', reason: 'The review references exceed the tool result limit' },
      delivery: { status: 'available' } })
  expect(await reviewReferences(ctx, session, { ...production, episodeId: 83 }, signal, 4096))
    .toMatchObject({ screenplay: { status: 'available' }, character_bindings: { status: 'unavailable' } })
  expect(await reviewReferences(ctx, session, { ...production, packageIndex: 9 }, signal, 4096))
    .toMatchObject({ screenplay: { status: 'available' }, character_bindings: { status: 'unavailable' } })
  expect(await reviewReferences(ctx, session, { ...production, storyboardId: 17 }, signal, 4096))
    .toMatchObject({ screenplay: { status: 'available' }, character_bindings: { status: 'unavailable' } })
  expect(await reviewReferences(ctx, session, { ...production, packageIndex: 2, storyboardId: 17, shotNumbers: [2] }, signal, 4096))
    .toMatchObject({ screenplay: { status: 'available' }, character_bindings: { status: 'available', matches: [plan.matches[1]] } })
  for (const planText of ['{', '[]', JSON.stringify({ ...plan, fingerprint, matches: [] })]) {
    await writeFile(plan_path, planText)
    expect(await reviewReferences(ctx, session, production, signal, 4096))
      .toMatchObject({ screenplay: { status: 'available' }, character_bindings: { status: 'unavailable' } })
  }
  await writeFile(plan_path, JSON.stringify({ ...plan, fingerprint }))
  expect(await reviewReferences(ctx, session, { ...production, shotNumbers: [] }, signal, 16384))
    .toMatchObject({ screenplay: { status: 'unavailable' }, character_bindings: { status: 'unavailable' } })
  expect(await reviewReferences(ctx, session, { ...production, episodeNumber: 9 }, signal, 16384))
    .toMatchObject({ screenplay: { status: 'unavailable' }, character_bindings: { status: 'unavailable' } })
  expect(await reviewReferences(ctx, session, { ...production, scriptId: 46 }, signal, 16384))
    .toMatchObject({ screenplay: { status: 'unavailable' }, character_bindings: { status: 'unavailable' }, delivery: { status: 'unavailable' } })
  await writeFile(source_path, body + '改稿')
  expect(await reviewReferences(ctx, session, production, signal, 16384))
    .toMatchObject({ screenplay: { status: 'unavailable' }, character_bindings: { status: 'unavailable' } })
  await rm(source_path)
  expect(await reviewReferences(ctx, session, production, signal, 16384))
    .toMatchObject({ screenplay: { status: 'unavailable' }, character_bindings: { status: 'unavailable' } })
})

it('returns only visible asset facts from a matching saved storyboard readback', async () => {
  const { ctx, session, signal, tool } = await fixture()
  const callId = ToolCallId('saved-card')
  const material = { materialAssetId: '482', materialKey: 'character_yi', assetId: 'm.113', materialType: 'image',
    materialName: '乙雨衣', materialUrl: 'https://invalid.example/private-image', arbitrary: 'DROP_PRIVATE_FIELD' }
  const incomplete = { materialAssetId: 'invalid', materialKey: 'legacy_reference', assetId: -1, materialType: 'other', fileName: '' }
  const snapshot = { episodeId: '82', storyboardMaterialList: JSON.stringify([material, incomplete]) }
  session.append('tool/call', { turn: 1, step: 1, name: 'jubian_storyboard', callId,
    arguments: JSON.stringify({ method: 'get', storyboard_id: 12 }) })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, isError: false,
    content: [{ type: 'text', text: JSON.stringify({ storyboard: { storyboard_id: 12, script_id: 45, snapshot } }) }] }) }, { surfaceOp: 'append' })
  const production = { scriptId: 45, episodeId: 82, episodeNumber: 8, storyboardId: 12 }
  tool('jubian_storyboard', { method: 'get', storyboard_id: 'unrecognized' }, { storyboard: { storyboard_id: 12, script_id: 45, snapshot } })
  tool('jubian_storyboard', { method: 'save', storyboard_id: 12 }, { storyboard: { storyboard_id: 12, script_id: 45, snapshot } })
  tool('jubian_storyboard', { method: 'get', storyboard_id: 12 }, { storyboard: { storyboard_id: 12, script_id: 99, snapshot } })
  tool('jubian_storyboard', { method: 'get', storyboard_id: 12 }, { storyboard: { storyboard_id: 99, script_id: 45, snapshot } })
  tool('jubian_storyboard', { method: 'get', storyboard_id: 12 }, { storyboard: { storyboard_id: 12, script_id: 45 } })
  tool('jubian_storyboard', { method: 'get', storyboard_id: 12 }, { storyboard: { storyboard_id: 12, script_id: 45 } }, true)
  const result = await reviewReferences(ctx, session, production, signal, 4096)
  expect(result.saved_bindings).toEqual({ status: 'available', basis: 'recorded_storyboard_readback', storyboard_id: 12,
    assets: [{ material_key: 'character_yi', name: '乙雨衣', type: 'image', asset_id: 482, material_id: 'm.113' },
      { material_key: 'legacy_reference', name: null, type: null, asset_id: null, material_id: null }] })
  expect(result.character_bindings).toMatchObject({ status: 'unavailable' })
  expect(await reviewReferences(ctx, session, { ...production, episodeId: 81 }, signal, 4096))
    .toMatchObject({ saved_bindings: { status: 'unavailable' } })
  tool('jubian_storyboard', { method: 'get', storyboard_id: 12 }, { storyboard: { storyboard_id: 12, script_id: 45,
    snapshot: { ...snapshot, storyboardMaterialList: '{' } } })
  expect(await reviewReferences(ctx, session, production, signal, 4096)).toMatchObject({
    saved_bindings: { status: 'unavailable', reason: 'The recorded storyboard materials are unavailable or invalid' },
  })
})

it('reads a successful PTC storyboard response and ignores failed, malformed or oversize results', async () => {
  const { ctx, session, signal } = await fixture()
  const rootCallId = ToolCallId('storyboard-root')
  const production = { scriptId: 45, episodeId: 82, episodeNumber: 8, storyboardId: 12 }
  const args = { method: 'get', storyboard_id: 12 }
  const attachment = await ctx.attachments.saveFile({ data: Buffer.from('storyboard evidence'), name: 'card.txt' })
  const valid = { storyboard: { storyboard_id: 12, script_id: 45, snapshot: { episodeId: 82, storyboardMaterialList: [
    { materialKey: 'legacy_image', fileName: 'image.png' },
  ] } } }
  const dispatches = [
    { arguments: args, isError: true, name: 'jubian_storyboard', text: JSON.stringify(valid) },
    { arguments: args, isError: false, name: 'other_tool', text: JSON.stringify(valid) },
    { arguments: '{', isError: false, name: 'jubian_storyboard', text: JSON.stringify(valid) },
    { arguments: args, isError: false, name: 'jubian_storyboard', text: '{' },
    { arguments: args, isError: false, name: 'jubian_storyboard', text: 'x'.repeat(4097) },
    { arguments: args, isError: false, name: 'jubian_storyboard', text: JSON.stringify(valid) },
  ]
  for (const { text, ...dispatch } of dispatches) {
    session.append('tool/ptc-dispatch', { rootCallId, parentCallId: rootCallId, subCallId: ToolCallId(`storyboard-child-${session.seq}`),
      ...dispatch, content: [{ type: 'file', attachment }, { type: 'text', text }] })
  }
  const invalidCall = ToolCallId('invalid-storyboard-request')
  session.append('tool/call', { turn: 1, step: 1, name: 'jubian_storyboard', callId: invalidCall, arguments: '{' })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: invalidCall, isError: false,
    content: [{ type: 'text', text: '{"storyboard":{"storyboard_id":99}}' }] }) }, { surfaceOp: 'append' })
  expect(await reviewReferences(ctx, session, production, signal, 4096)).toMatchObject({
    saved_bindings: { status: 'available', storyboard_id: 12, assets: [{ material_key: 'legacy_image', name: 'image.png' }] },
  })
})

it('reads the explicitly attached text and keeps its production mapping unverified', async () => {
  const { ctx, session, signal } = await fixture()
  const screenplay = '第八集，人物乙在下雨时走进办公室。'
  const attachment = await ctx.attachments.saveFile({ name: '剧本.txt', data: Buffer.from(screenplay) })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'file', attachment }] }), { surfaceOp: 'append' })
  expect(await reviewReferences(ctx, session, { scriptId: 45, episodeNumber: 8, shotNumbers: [3] }, signal, 4096))
    .toMatchObject({ screenplay: { status: 'available', basis: 'user_attachment', text: screenplay, authored_shots: [] },
      character_bindings: { status: 'unavailable' }, delivery: { status: 'unavailable' } })
})

it('falls back to an explicit attachment without a workspace and rejects damaged attachment content', async () => {
  const { ctx, session, signal, user } = await fixture(false)
  user('@draft.md')
  expect(await reviewReferences(ctx, session, undefined, signal, 4096)).toMatchObject({
    screenplay: { status: 'unavailable' }, delivery: { status: 'unavailable', reason: 'This conversation has no project directory' },
  })
  const attach = async (text: string) => {
    const attachment = await ctx.attachments.saveFile({ name: 'script.txt', data: Buffer.from(text) })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'file', attachment }] }),
      { surfaceOp: 'append' })
  }
  await attach('  ')
  expect(await reviewReferences(ctx, session, undefined, signal, 4096)).toMatchObject({ screenplay: { status: 'unavailable' } })
  await attach('original')
  const stream = vi.spyOn(ctx.attachments, 'readFileStream')
  for (const changed of ['short', 'replaced', 'the stored bytes grew']) {
    stream.mockImplementationOnce(async function* () { yield Buffer.from(changed) })
    expect(await reviewReferences(ctx, session, undefined, signal, 4096)).toMatchObject({ screenplay: { status: 'unavailable' } })
  }
  expect(await reviewReferences(ctx, session, undefined, signal, 4096, 3)).toMatchObject({ screenplay: { status: 'unavailable' } })
  expect(await reviewReferences(ctx, session, undefined, signal, 4096)).toMatchObject({
    screenplay: { status: 'available', basis: 'user_attachment', text: 'original' },
  })
})

it('rejects screenplay data changed during read, moved or outside the evidence size limit', async () => {
  const { root, ctx, session, signal, user } = await fixture()
  const draft = join(root, 'current draft.md'), moved = join(root, 'previous.md')
  await writeFile(draft, 'review criteria')
  await writeFile(moved, 'previous draft')
  await writeFile(join(root, 'blank.md'), '\n')
  user('@"current draft.md" @https://invalid.example/different.md')
  expect(await reviewReferences(ctx, session, undefined, signal, 4096, 3)).toMatchObject({ screenplay: { status: 'unavailable' } })
  const read = ctx.fs.readBytes.bind(ctx.fs)
  const spy = vi.spyOn(ctx.fs, 'readBytes')
  spy.mockImplementationOnce(async (...args) => {
    const bytes = await read(...args)
    await appendFile(draft, 'updated during read')
    return bytes
  })
  expect(await reviewReferences(ctx, session, undefined, signal, 4096)).toMatchObject({ screenplay: { status: 'unavailable' } })
  const resolve = ctx.fs.resolve.bind(ctx.fs)
  spy.mockImplementationOnce(async (...args) => {
    const bytes = await read(...args)
    vi.spyOn(ctx.fs, 'resolve').mockImplementationOnce((_input, options) => resolve(moved, options))
    return bytes
  })
  expect(await reviewReferences(ctx, session, undefined, signal, 4096)).toMatchObject({ screenplay: { status: 'unavailable' } })
  user('@blank.md')
  expect(await reviewReferences(ctx, session, undefined, signal, 4096)).toMatchObject({ screenplay: { status: 'unavailable' } })
  vi.spyOn(ctx.fs, 'resolve').mockRejectedValueOnce(Error('workspace is offline'))
  expect(await reviewReferences(ctx, session, undefined, signal, 4096)).toMatchObject({
    delivery: { status: 'unavailable', reason: 'This conversation has no project directory' },
  })
})

it('keeps footage requirements separate from final delivery and rejects conflicting project identity', async () => {
  const { root, ctx, session, signal } = await fixture()
  const config = join(root, 'project_config.json')
  const production = { scriptId: 45, episodeNumber: 8, storyboardId: 12 }
  await writeFile(config, '{"project_bible":{"jubian_script_id":45}}')
  expect(await reviewReferences(ctx, session, production, signal, 4096)).toMatchObject({
    saved_bindings: { status: 'unavailable' }, delivery: { status: 'unavailable', reason: 'The project has no recorded delivery requirements' },
  })
  await writeFile(config, '{"project_bible":{"jubian_script_id":45},"delivery":{"max_effective_chars_per_shot":24}}')
  const result = await reviewReferences(ctx, session, production, signal, 4096)
  expect(result.delivery).toMatchObject({ status: 'available', footage: { max_effective_chars_per_shot: 24 } })
  expect(result.delivery).not.toHaveProperty('final_episode')
  await writeFile(config, '{"jubian_script_id":45,"project_bible":{"jubian_script_id":44,"aspect_ratio":"9:16"}}')
  expect(await reviewReferences(ctx, session, production, signal, 4096)).toMatchObject({
    delivery: { status: 'unavailable', reason: 'The workspace project does not match the selected video project' },
  })
})

it('declines ambiguous, unreferenced and out-of-workspace text and honors cancellation', async () => {
  const { root, ctx, session, signal } = await fixture(), text = '外部资料'
  await writeFile(join(root, 'unreferenced.txt'), text)
  const user = (message: string) => session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: message }] }), { surfaceOp: 'append' })
  const spy = vi.spyOn(ctx.fs, 'readBytes')
  user('Review the selected video.')
  expect(await reviewReferences(ctx, session, undefined, signal, 4096)).toMatchObject({ screenplay: { status: 'unavailable' } })
  user('@one.txt @two.txt')
  expect(await reviewReferences(ctx, session, undefined, signal, 4096))
    .toMatchObject({ screenplay: { status: 'unavailable',
      reason: 'More than one screenplay reference was supplied; identify one as the review basis' } })
  user('@../escape.txt')
  expect(await reviewReferences(ctx, session, undefined, signal, 4096)).toMatchObject({ screenplay: { status: 'unavailable' } })
  expect(spy).not.toHaveBeenCalled()
  user('@unreferenced.txt')
  expect(await reviewReferences(ctx, session, undefined, signal, 4096))
    .toMatchObject({ screenplay: { status: 'available', basis: 'user_reference', text, authored_shots: [] } })
  const cancellation = new Error('review canceled')
  await expect(reviewReferences(ctx, session, undefined, AbortSignal.abort(cancellation), 4096)).rejects.toBe(cancellation)
})
