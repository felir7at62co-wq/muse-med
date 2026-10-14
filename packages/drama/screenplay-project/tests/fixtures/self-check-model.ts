/** Keyless sequential self-check through actual PTC, including unprinted reads and failed outer programs. */
import { readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type StreamChunk, type GenerateOptions } from '@deepseek-ai/dsh-llm'

export const name = 'screenplay-self-check-fixture'
export const inject = ['llm', 'tools', 'fs', 'attachments']

export async function apply(ctx: Context, config: { cwd?: string } = {}): Promise<void> {
  const workspace = config.cwd ?? process.cwd()
  const phase = process.env.SCREENPLAY_SELF_CHECK_FIXTURE_MODE ?? 'full'
  const binding = process.env.SCREENPLAY_SELF_CHECK_FIXTURE_VIDEO_BINDING ?? 'after-ptc'
  const mutation = process.env.SCREENPLAY_SELF_CHECK_FIXTURE_VIDEO_MUTATION
  const expectedVideoChange = mutation === 'post-bind' || (binding === 'apply' && mutation === 'pre-init')
  let image: Awaited<ReturnType<typeof ctx.attachments.saveImage>> | undefined
  let prepareInspection: (() => Promise<void>) | undefined
  if (phase === 'full') {
    const video = join(workspace, 'source.mp4'), signal = new AbortController().signal
    await writeFile(video, 'fixture video bytes')
    const target = await ctx.fs.resolve(video, { signal })
    const frame = await ctx.attachments.saveImage({ mediaType: 'image/png',
      data: await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).png().toBuffer() })
    image = frame
    const beforePtc = (await ctx.fs.stat(target, signal))!.version
    const beforeBytes = await readFile(video)
    let boundVersion = beforePtc
    const bind = async () => {
      boundVersion = (await ctx.fs.stat(target, signal))!.version
      await writeFile(join(workspace, 'inspection.json'), JSON.stringify({ path: video, source_version: boundVersion,
        inspection: 'sampled_frames', verified_readback: true, duration_seconds: 10,
        frames: [{ requested_seconds: 1, timestamp_seconds: 1, image: frame }] }))
    }
    const mutateMetadata = async () => {
      const info = await stat(video)
      await utimes(video, info.atime, new Date(info.mtimeMs + 1000))
    }
    if (binding === 'apply') await bind()
    prepareInspection = async () => {
      if (mutation === 'pre-init') await mutateMetadata()
      if (binding !== 'apply') await bind()
      if (mutation === 'post-bind') await mutateMetadata()
      const afterBytes = await readFile(video)
      if (!beforeBytes.equals(afterBytes)) throw Error('fixture metadata mutation changed source bytes')
      await writeFile(join(workspace, 'self-check-video-binding.json'), JSON.stringify({ binding, mutation,
        before_ptc_version: beforePtc, bound_version: boundVersion, current_version: (await ctx.fs.stat(target, signal))!.version,
        before_sha256: createHash('sha256').update(beforeBytes).digest('hex'),
        after_sha256: createHash('sha256').update(afterBytes).digest('hex') }))
    }
  }
  let step = 0
  let interruptedRead = false
  ctx.on('tools/execute', async (exec, next) => {
    if (phase !== 'full' || exec.name !== 'screenplay_project') return next()
    const method = z.object({ request: z.object({ method: z.string() }) }).parse(exec.arguments).request.method
    // This Host tool is reached after the first PTC worker's Windows workspace ACL grant.
    if (method === 'init' && prepareInspection !== undefined) { await prepareInspection(); prepareInspection = undefined }
    if (step !== 4 || method !== 'read_source') return next()
    const controller = new AbortController()
    exec.signal = controller.signal
    const result = next()
    controller.abort('fixture source read interrupted')
    interruptedRead = true
    return result
  })
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    if (phase !== 'full' || exec.name !== 'screenplay_project' || ![4, 6, 8].includes(step)) return next()
    const method = z.object({ request: z.object({ method: z.string() }) }).parse(exec.arguments).request.method
    if (method !== 'read_source') return next()
    if (step === 4) return { kind: 'block', feedback: [{ type: 'text', text: 'fixture source read policy denial' }] }
    if (step === 6) return { kind: 'accept', value: { replaced: true } }
    return { kind: 'accept', content: [{ type: 'text', text: 'fixture replaced source read content' }] }
  })
  ctx.on('tools/result', (exec) => { if (exec.name === 'run_code') step += 1 })
  class FixtureAdapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, inputModalities: ['text', 'image'] as const }
    }
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (phase === 'full' && step === 5 && !interruptedRead) throw Error('fixture did not exercise interrupted read signal')
      if (phase === 'full' && [11, 16].includes(step)) {
        const reads = options.messages.filter(message => message.source?.kind === 'screenplay-project-read')
        const values = reads.flatMap(message => message.content.filter(block => block.type === 'text').map(block => z.unknown().parse(JSON.parse(block.text))))
        const source = values.some(value => z.object({ units: z.array(z.object({ text: z.literal('甲想：钥匙在我手里。') })) }).safeParse(value).success)
        const facts = values.some(value => z.object({ facts: z.array(z.object({ summary: z.literal('甲想：钥匙在我手里。') })).min(1) }).safeParse(value).success)
        if (!source || !facts) throw Error('fixture actual model request omitted complete source/fact reread')
        const images = reads.flatMap(message => message.content.filter(block => block.type === 'image'))
        if (images.length !== (step === 11 ? 1 : 2) || !images.every(block => block.attachment.attachmentId === image?.attachmentId)) {
          throw Error('fixture actual image-capable model request omitted or duplicated canonical frame image')
        }
        if (step === 16 && !values.some(value => z.object({ candidate: z.object({ scenes: z.array(z.object({ beats: z.array(z.object({ text: z.literal('钥匙在我手里。') })).min(1) })).min(1) }),
          rendered: z.object({ script: z.string().includes('第1集').includes('甲（OS）：钥匙在我手里。') }) }).safeParse(value).success)) {
          throw Error('fixture actual model request omitted complete candidate reread')
        }
      }
      const call = 'const project=\'project.json\'; const call=request=>tools.screenplay_project({request});'
      const state = 'const status=await call({method:\'status\',project}); const facts=await call({method:\'list_facts\',project,start:1,count:20});'
      let codes: string[] = []
      switch (step) {
        case 0: codes = [call + `await call({method:'init',project,mode:'faithful',instructions:'保留来源、人物和内心归属。'});
          await call({method:'import_source',project,expected_revision:0,path:'source.txt',source_kind:'text'});
          await call({method:'import_source',project,expected_revision:1,path:'inspection.json',source_kind:'video_inspection'});
          const status=await call({method:'status',project});
          const source=await call({method:'read_source',project,source_id:status.sources[0].id,start:1,count:1});
          await call({method:'propose_fact',project,expected_revision:source.revision,fact:{kind:'thought',origin:'source',actor:'甲',layer:'present',summary:source.units[0].text,anchors:[{unit_id:source.units[0].id,quote:source.units[0].text}]}});`,
        call + state + `await call({method:'read_source',project,source_id:status.sources[0].id,start:1,count:1});
          try {await call({method:'review_fact',project,expected_revision:status.revision,fact_id:facts.facts[0].id,decision:'approve',reason:'同轮另一run_code尝试。'})}catch(error){console.log(String(error))}`]; break
        case 2: codes = [call + state + 'await call({method:\'read_source\',project,source_id:status.sources[0].id,start:1,count:1}); throw Error(\'fixture outer read failure\');']; break
        case 3: codes = [call + state + 'try {await call({method:\'review_fact\',project,expected_revision:status.revision,fact_id:facts.facts[0].id,decision:\'approve\',reason:\'失败外层程序后的尝试。\'})}catch(error){console.log(String(error))}']; break
        case 4:
        case 6:
        case 8: codes = [call + state + 'try {await call({method:\'read_source\',project,source_id:status.sources[0].id,start:1,count:1})}catch(error){console.log(String(error))}']; break
        case 5:
        case 7:
        case 9: codes = [call + state + 'try {await call({method:\'review_fact\',project,expected_revision:status.revision,fact_id:facts.facts[0].id,decision:\'approve\',reason:\'拒绝或替换读回不算实际证据。\'})}catch(error){console.log(String(error))}']; break
        case 10: codes = [call + state + 'await call({method:\'read_source\',project,source_id:status.sources[0].id,start:1,count:1}); await call({method:\'read_source\',project,source_id:status.sources[1].id,start:1,count:1});']; break
        case 11: codes = [call + state + 'await call({method:\'review_fact\',project,expected_revision:status.revision,fact_id:facts.facts[0].id,decision:\'approve\',reason:\'已在上一真实模型轮完整读回心理原文，再自检归属。\'});']; break
        case 12: codes = [call + state + 'await call({method:\'stage\',project,expected_revision:status.revision,episode:1,scenes:[{location:\'门前\',time:\'日\',layer:\'present\',transition:\'opening\',characters:[\'甲\'],beats:[{kind:\'os\',actor:\'甲\',text:\'钥匙在我手里。\',fact_ids:[facts.facts[0].id],requires_knowledge:[],witnesses:[]}]}]});']; break
        case 13: codes = [call + state + `await call({method:'read_candidate',project,candidate_id:status.pending[0].id});
          await call({method:'read_source',project,source_id:status.sources[0].id,start:1,count:1}); throw Error('fixture outer candidate failure');`]; break
        case 14: codes = [call + state + 'try {await call({method:\'review\',project,expected_revision:status.revision,candidate_id:status.pending[0].id,candidate_sha256:status.pending[0].sha256,decision:\'approve\',reason:\'失败程序不能提供读回证据。\'})}catch(error){console.log(String(error))}']; break
        case 15: codes = [call + state + `await call({method:'read_candidate',project,candidate_id:status.pending[0].id});
          await call({method:'read_source',project,source_id:status.sources[0].id,start:1,count:1}); await call({method:'read_source',project,source_id:status.sources[1].id,start:1,count:1});`]; break
        case 16: codes = [call + state + `const candidate=status.pending[0];
          await call({method:'review',project,expected_revision:status.revision,candidate_id:candidate.id,candidate_sha256:candidate.sha256,decision:'approve',reason:'上一模型轮已读回完整候选与心理原文，实际会话分轮自检。'});
          const updated=await call({method:'status',project});
          await call({method:'commit',project,expected_revision:updated.revision,candidate_id:candidate.id,candidate_sha256:candidate.sha256});
          console.log(await call({method:'export',project,candidate_id:candidate.id,directory:'delivery'}));`]; break
      }
      if (phase === 'checkpoint') {
        codes = step === 0 ? [call + `await call({method:'init',project,mode:'faithful',instructions:'冷恢复保留真实自检身份。'});
          await call({method:'import_source',project,expected_revision:0,path:'source.txt',source_kind:'text'});
          const status=await call({method:'status',project}); const source=await call({method:'read_source',project,source_id:status.sources[0].id,start:1,count:1});
          await call({method:'propose_fact',project,expected_revision:source.revision,fact:{kind:'thought',origin:'source',actor:'甲',layer:'present',summary:source.units[0].text,anchors:[{unit_id:source.units[0].id,quote:source.units[0].text}]}});`]
          : step === 1 ? [call + state + 'await call({method:\'read_source\',project,source_id:status.sources[0].id,start:1,count:1});'] : []
      } else if (phase === 'resume') {
        codes = step === 0 ? [call + state + 'try {await call({method:\'review_fact\',project,expected_revision:status.revision,fact_id:facts.facts[0].id,decision:\'approve\',reason:\'重启后不能使用旧缓存。\'})}catch(error){console.log(String(error))}']
          : step === 1 ? [call + state + 'await call({method:\'read_source\',project,source_id:status.sources[0].id,start:1,count:1});']
            : step === 2 ? [call + state + 'await call({method:\'review_fact\',project,expected_revision:status.revision,fact_id:facts.facts[0].id,decision:\'approve\',reason:\'冷恢复后已重新读回，当前真实模型轮自检。\'});'] : []
      }
      if (expectedVideoChange && step >= 2) codes = []
      if (codes.length > 0) {
        for (const [index, code] of codes.entries()) {
          const id = ToolCallId(`self-check-${step}-${index}`), args = JSON.stringify({ description: 'Verify sequential screenplay self-check', code })
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id, name: 'run_code', argumentsDelta: args }
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name: 'run_code', arguments: args } }
        }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const text = expectedVideoChange ? '已验证视频源版本变化被拒绝。' : '同会话分轮自检已验收并导出；不是独立审校。'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['screenplay-self-check-fixture'], new FixtureAdapter())
}
