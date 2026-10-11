/** Synthetic-source screenplay creation through real headless PTC and decoded video frames; semantic judgments are scripted. */
import { readFile, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import type {} from '../../src/index.ts'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError, IMAGE_OFFLOAD_REQUIRED_CODE, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { VIDEO_INSPECTION } from '../../src/schema.ts'

export const name = 'screenplay-story-faithful-fixture'
export const inject = ['llm', 'tools']

const videoValue = z.object({ path: z.string(), source_version: z.string(), duration_seconds: z.number(),
  frames: z.array(z.object({ image: z.object({ attachmentId: z.string() }).loose() })) }).loose()
const requestMethod = z.object({ request: z.object({ method: z.string() }) })
const HEADER = "const fs=await import('node:fs/promises');const project='project.json'; const call=request=>tools.screenplay_project({request}); const current=()=>call({method:'status',project}); const allFacts=()=>call({method:'list_facts',project,start:1,count:30}); const readSources=async()=>{for(const source of (await current()).sources)await call({method:'read_source',project,source_id:source.id,start:1,count:source.units});}; const deny=async(expected,operation)=>{try{await operation();}catch(error){if(!String(error).includes(expected))throw error;console.log('EXPECTED_DENIAL '+expected);return;}throw Error('fixture unexpectedly accepted '+expected);};"
const INSPECT = "await tools.video_inspect({file_path:'original.mp4',method:'metadata',manifest_path:prefix+'metadata.json'}); await tools.video_inspect({file_path:'original.mp4',method:'sample',start_seconds:0,end_seconds:60,timestamps_seconds:[30],manifest_path:prefix+'sample-1.json'}); await tools.video_inspect({file_path:'original.mp4',method:'sample',start_seconds:60,end_seconds:120,timestamps_seconds:[65],manifest_path:prefix+'sample-2.json'}); await tools.video_inspect({file_path:'original.mp4',method:'sample',start_seconds:120,end_seconds:128,timestamps_seconds:[124],manifest_path:prefix+'sample-3.json'});"
const CANDIDATE_READ = "const s=await current(); await call({method:'read_candidate',project,candidate_id:s.pending.at(-1).id}); await call({method:'read_story_inventory',project,inventory_id:s.story_inventories.at(-1).id}); await readSources();"
const REPORT = "const s=await current(),c=s.pending.at(-1),r=await call({method:'read_candidate',project,candidate_id:c.id}); const inventory=r.inventory; const report={event_chain:'合成情节：蓝色提示屏变红，阿岚提出离开，阿远解释警报并挽留。',emotion_conflict:'合成对白由被排斥的愤怒转为得到解释；口语和情绪增强保持原冲突。',relationship_stance:'阿岚不愿被当外人，阿远明确挽留；没有变为驱逐或邀请离开。',causality_reveal:'红屏触发离开条件，随后解释红屏只是警报；揭晓顺序保持。',checks:inventory.items.map(item=>({item_id:item.id,status:'preserved',explanation:'固定合成语义报告：'+item.summary,source_units:item.source_units,outputs:r.candidate.story_adaptation.notes.mapping.find(mapping=>mapping.item_id===item.id).outputs})),deviations:[],unverified:[]}; const review=()=>call({method:'review',project,expected_revision:s.revision,candidate_id:c.id,candidate_sha256:c.sha256,decision:'approve',reason:'B轮实际读回完整合成候选、来源和五维清单；C轮为固定合成语义判断，代码只核定位、摘要和声明偏差。',semantic_report:report});"

/**
 * Register the keyless adapter; only its model output and authored source transcript are synthetic.
 * @param ctx - Real headless Loader services and persistent Session.
 */
export function apply(ctx: Context): void {
  const phase = process.env.SCREENPLAY_STORY_FIXTURE_MODE ?? 'full'
  const spillReview = process.env.SCREENPLAY_STORY_REVIEW_SPILL === '1'
  let step = 0
  let offloadInjected = false
  const samples: ContentBlock[][] = []
  const observations: { phase: string; step: number; images: string[]; canonical: boolean }[] = []
  const tools: { name: string; method?: string; isError: boolean }[] = []
  ctx.on('tools/result', (exec, result) => {
    if (exec.name === 'video_inspect' && !result.isError && videoValue.safeParse(result.value).success) {
      const value = videoValue.parse(result.value)
      if (value.frames.length > 0) samples.push(result.content)
    }
    tools.push({ name: exec.name, ...exec.name === 'screenplay_project' ? { method: requestMethod.parse(exec.arguments).request.method } : {}, isError: result.isError })
    if (exec.name === 'run_code') {
      step += 1
      writeFileSync(join(process.cwd(), 'story-fixture-tools.json'), JSON.stringify(tools))
    }
  })
  class FixtureAdapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, inputModalities: ['text', 'image'] as const }
    }
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const offloadStep = phase === 'offload-after-observation' ? 11 : phase === 'offload-before-observation' ? 10 : undefined
      if (!offloadInjected && step === offloadStep) {
        offloadInjected = true
        const offloadImages = options.messages.flatMap(message => message.content)
          .filter(block => block.type === 'image' && block.offloaded !== true).length
        throw new LlmError('fixture request image budget', IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages })
      }
      const imageRound = !['resume-pending', 'accepted-cold', 'export-negative'].includes(phase) && step === 1
      if (imageRound) {
        const content = options.messages.flatMap(message => message.content)
        const actualImages = content.filter(block => block.type === 'image').map(block => block.attachment.attachmentId)
        const expected = samples.flatMap(blocks => blocks.filter(block => block.type === 'image'))
        const counts = new Map<string, number>()
        for (const id of actualImages) counts.set(id, (counts.get(id) ?? 0) + 1)
        for (const block of expected) {
          const count = counts.get(block.attachment.attachmentId) ?? 0
          if (count === 0) throw Error('story fixture actual Adapter request omitted a returned frame attachment')
          counts.set(block.attachment.attachmentId, count - 1)
        }
        const canonical = samples.every(blocks => blocks.every(block =>
          content.some(actual => JSON.stringify(actual) === JSON.stringify(block))))
        if (expected.length !== 3 || !canonical) throw Error('story fixture actual Adapter request omitted canonical video-inspect text or images')
        observations.push({ phase, step, images: actualImages, canonical })
        await writeFile(join(process.cwd(), 'story-fixture-observations.json'), JSON.stringify(observations))
      }
      if ((phase === 'full' && step === 10) || (phase === 'resume-pending' && step === 2)) {
        const reads = options.messages.filter(message => message.source?.kind === 'screenplay-project-read')
          .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
        if (!reads.some(text => text.includes('"candidate"') && text.includes('"rendered"') && text.includes('别把我当外人！'))
          || !reads.some(text => text.includes('"inventory"') && text.includes('"story_policy"'))
          || !reads.some(text => text.includes('红屏只是警报，不是赶你走。')))
          throw Error('story fixture actual C model request omitted complete candidate, inventory, policy or original transcript')
      }
      if (phase.startsWith('offload-') && step === (phase === 'offload-after-observation' ? 11 : 10)) {
        const index = options.messages.findLastIndex(message => message.source?.kind === 'tool'
          && String(message.source.callId).startsWith('story-faithful-' + phase + '-9'))
        const images = options.messages.slice(index + 1).flatMap(message => message.content.filter(block => block.type === 'image'))
        if (images.length !== 3 || images.some(block => block.offloaded !== true)) throw Error('fixture source images were not offloaded: ' + JSON.stringify({ index, images: images.map(block => ({ id: block.attachment.attachmentId, offloaded: block.offloaded })) }))
      }
      if (phase === 'resume-pending' && step === 2) {
        const index = options.messages.findIndex(message => message.source?.kind === 'tool'
          && message.source.callId === 'story-faithful-resume-pending-1')
        const reads = options.messages.slice(index + 1).filter(message => message.source?.kind === 'screenplay-project-read')
        const images = reads.flatMap(message => message.content.filter(block => block.type === 'image'))
        if (index === -1 || images.length !== 3) throw Error('cold-resumed C request omitted fresh B source images')
        observations.push({ phase, step, images: images.map(block => block.attachment.attachmentId), canonical: true })
        await writeFile(join(process.cwd(), 'story-fixture-observations.json'), JSON.stringify(observations))
      }
      const programs: [
        string, string, string, string, string, string,
        string, string, string, string, string, string,
      ] = [
        "const prefix='';" + INSPECT,
        "console.log('Actual returned images and canonical inspection text reached this model round.');",
        "const meta=JSON.parse(await fs.readFile('metadata.json','utf8')); await call({method:'init_story_faithful',project,work_title:'合成提示屏的误会',videos:[{path:meta.path,source_version:meta.source_version}],episodes:[1],scope_instructions:'本作品是128秒原创合成色块视频和作者提供的合成对白，只测试实际取样与流程。保持事件、条件、关系、立场和揭晓，可增强情绪和口语，不宣称真实ASR或观看真实20集。',authorization_quote:'把这个原创合成视频写成故事忠实剧本，允许表演细节、短OS和承接对白；保留关键事件、关系、条件和揭晓。',consent_assessment:'真实本轮用户只授权此合成作品第一集的表达增强；不扩展故事后果。',allowed_categories:['performance_detail','minimal_os','supporting_dialogue']}); let s=await current(); for(const path of ['fake-inspection.json','fake-samples.json','forged-verified.json'])await deny('video_evidence_pending',()=>call({method:'import_source',project,expected_revision:s.revision,path,source_kind:'video_inspection'})); for(const path of ['sample-1.json','sample-2.json','sample-3.json']){s=await current();await call({method:'import_source',project,expected_revision:s.revision,path,source_kind:'video_inspection'});} s=await current();await call({method:'import_source',project,expected_revision:s.revision,path:'authored-transcript.json',source_kind:'transcript',story_video_path:meta.path}); s=await current();const units=[];for(const source of s.sources)units.push((await call({method:'read_source',project,source_id:source.id,start:1,count:source.units})).units); const facts=[{kind:'action',origin:'source',layer:'present',summary:'原创合成提示屏显示蓝色。',anchors:[{unit_id:units[0][0].id,quote:units[0][0].text}]},{kind:'action',origin:'source',layer:'present',summary:'原创合成提示屏切换为红色。',anchors:[{unit_id:units[1][0].id,quote:units[1][0].text}]},{kind:'speech',origin:'source',actor:'阿岚',layer:'present',summary:units[3][0].text,anchors:[{unit_id:units[3][0].id,quote:units[3][0].text}]},{kind:'speech',origin:'source',actor:'阿远',layer:'present',summary:units[3][1].text,anchors:[{unit_id:units[3][1].id,quote:units[3][1].text}]}];await call({method:'propose_facts',project,expected_revision:s.revision,facts}); s=await current();await allFacts();await readSources();await deny('self_check_step',async()=>call({method:'review_facts',project,expected_revision:s.revision,reviews:(await allFacts()).facts.map(fact=>({fact_id:fact.id,decision:'approve',reason:'同run_code A/B/C不能成立。'}))}));",
        "await allFacts();await readSources();throw Error('fixture successful inner read but failed outer');",
        "const s=await current(),facts=(await allFacts()).facts;await deny('self_check_read_required',()=>call({method:'review_facts',project,expected_revision:s.revision,reviews:facts.map(fact=>({fact_id:fact.id,decision:'approve',reason:'失败outer读回不算B轮。'}))}));await allFacts();await readSources();",
        "let s=await current();const facts=(await allFacts()).facts;await call({method:'review_facts',project,expected_revision:s.revision,reviews:facts.map(fact=>({fact_id:fact.id,decision:'approve',reason:'真实前一轮读回全部原作者文本及实际帧，固定合成语义判断。'}))});s=await current();const item=(id,dimension,indices,depends_on=[])=>({id,dimension,summary:{event:'提示屏蓝转红，触发误会再解释。',action_result:'提示屏确实由蓝色变红。',emotion_conflict:'阿岚因被当外人而愤怒并提出离开。',relationship_stance:'阿远挽留，没有驱逐阿岚。',causality_reveal:'红屏是警报，不是赶走的信号。'}[dimension],critical:true,evidence:'confirmed',fact_ids:indices.map(i=>facts[i].id),source_units:indices.map(i=>facts[i].anchors[0].unit_id),depends_on,knowledge:[]});await call({method:'propose_story_inventory',project,expected_revision:s.revision,episode:1,coverage:{windows:s.sources.map(source=>({source_id:source.id,start:1,count:source.units})),required_beats:[{fact_id:facts[0].id,kind:'action'},{fact_id:facts[1].id,kind:'action'}]},not_applicable:[],items:[item('event','event',[0,1]),item('screen','action_result',[0,1]),item('emotion','emotion_conflict',[2]),item('stance','relationship_stance',[3]),item('reveal','causality_reveal',[3],['screen'])]});",
        "const s=await current();await call({method:'read_story_inventory',project,inventory_id:s.story_inventories.at(-1).id});await readSources();",
        "const s=await current(),i=s.story_inventories.at(-1);await call({method:'review_story_inventory',project,expected_revision:s.revision,inventory_id:i.id,inventory_sha256:i.sha256,decision:'approve',reason:'前一模型轮完整读回五维清单、原作者对白与全部计划窗图片，不声明未采样时刻。'});",
        "const s=await current(),facts=(await allFacts()).facts,i=(await call({method:'read_story_inventory',project,inventory_id:s.story_inventories.at(-1).id})).inventory; const texts=['提示屏亮着蓝光。','别把我当外人！屏幕变红，我就走。','提示屏由蓝色切换为红色。','别走！红屏只是警报，不是赶你走。'];const indices=[0,2,1,3];const scenes=[{location:'合成提示屏前',time:'日',layer:'present',transition:'opening',characters:['阿岚','阿远'],beats:texts.map((text,index)=>({kind:index%2===0?'action':'dialogue',...(index%2===0?{}:{actor:index===1?'阿岚':'阿远'}),text,fact_ids:[facts[indices[index]].id],requires_knowledge:[],witnesses:index%2===0?[]:[index===1?'阿远':'阿岚']}))}];const position=beat=>({scene:1,beat,text:texts[beat-1]}); const mapping=[{item_id:'event',outputs:[position(1),position(3)]},{item_id:'screen',outputs:[position(1),position(3)]},{item_id:'emotion',outputs:[position(2)]},{item_id:'stance',outputs:[position(4)]},{item_id:'reveal',outputs:[position(4)]}];await call({method:'stage',project,expected_revision:s.revision,episode:1,scenes,coverage:i.coverage,story_notes:{inventory_id:i.id,mapping,dispositions:facts.map(fact=>({fact_id:fact.id,disposition:'retained',reason:'合成原来源保持，只增强可拍或口语表达。'})),changes:indices.map((i,index)=>({source:{unit_id:facts[i].anchors[0].unit_id,fact_id:facts[i].id},after:position(index+1),reason:'实际来源→成稿定位，没有逐字剧本before。'})),editor_comments:[{comment:'挽留更口语且情绪更明确。',disposition:'adopted',reason:'增强语气保持挽留立场。',change_indices:[4]}],scene_changes:[{scene:1,reason:'合成屏幕颜色镜头与对白交替，事件结果先于解释。'}],unresolved:['该合成夹具只核采样窗，未验证真实人物表演或未采样帧。']}});",
        CANDIDATE_READ,
        REPORT + "await deny('story_semantic_deviation',()=>call({method:'review',project,expected_revision:s.revision,candidate_id:c.id,candidate_sha256:c.sha256,decision:'approve',reason:'报告声明偏差不得批准。',semantic_report:{...report,deviations:['合成负例：把挽留改为驱逐。']}})); await review(); const updated=await current();await deny('story_approval_log_pending',()=>call({method:'commit',project,expected_revision:updated.revision,candidate_id:c.id,candidate_sha256:c.sha256}));",
        "const s=await current(),c=s.pending.at(-1);await call({method:'commit',project,expected_revision:s.revision,candidate_id:c.id,candidate_sha256:c.sha256});console.log(await call({method:'export',project,candidate_id:c.id,directory:'delivery'}));",
      ]
      if (spillReview) {
        programs[8] = programs[8].replace('未验证真实人物表演或未采样帧。', '未验证真实人物表演或未采样帧。' + 'Synthetic observation limit. '.repeat(4000))
        programs[10] = programs[10].replace('await review();', "const reviewed=await review(); if(reviewed.candidate.story_adaptation.notes.unresolved[0].length<100000)throw Error('PTC lost the complete canonical review value'); console.log(JSON.stringify(reviewed));")
      }
      if (!phase.startsWith('offload-')) programs[8] += '{' + REPORT + "await readSources();await deny('self_check_step',review);}"
      let program = programs[step]
      if (phase === 'checkpoint' && step >= 10) program = undefined
      if (phase === 'offload-after-observation' && step >= 10) program = [
        'console.log("Source images reached this successful model response before offloading.");', programs[10], programs[11],
      ][step - 10]
      if (phase === 'offload-before-observation' && step >= 10) program = step === 10
        ? REPORT + "await deny('self_check_read_required',review);" : undefined
      if (phase === 'accepted-cold') program = step === 0 ? "const s=await current();console.log(await call({method:'export',project,candidate_id:s.accepted[0].id,directory:'cold-delivery'}));" : undefined
      if (phase === 'export-negative') program = step === 0 ? "await deny(processExpected,async()=>{const s=await current();await call({method:'export',project,candidate_id:s.accepted[0].id,directory:'forbidden-delivery'});});".replace('processExpected', JSON.stringify(process.env.SCREENPLAY_STORY_EXPECTED_ERROR)) : undefined
      if (phase === 'resume-pending') {
        // Saved Host observations restore source trust; a fresh B read still precedes C approval.
        program = [
          REPORT + "await deny('self_check_read_required',review);",
          CANDIDATE_READ + 'await allFacts();',
          programs[10], programs[11],
        ][step]
      }
      if (!['resume-pending', 'accepted-cold', 'export-negative'].includes(phase) && step === 2) {
        const sample = VIDEO_INSPECTION.parse(JSON.parse(await readFile(join(process.cwd(), 'sample-1.json'), 'utf8')))
        await writeFile(join(process.cwd(), 'fake-inspection.json'), JSON.stringify({ ...sample, duration_seconds: 256, verified_readback: true }))
        await writeFile(join(process.cwd(), 'fake-samples.json'), JSON.stringify({ ...sample, verified_readback: true,
          frames: sample.frames.map(frame => ({ ...frame, requested_seconds: 31, timestamp_seconds: 31 })) }))
        await writeFile(join(process.cwd(), 'forged-verified.json'), JSON.stringify({ ...sample, verified_readback: true,
          manifest_path: join(process.cwd(), 'forged-verified.json') }))
      }
      if (program === undefined) {
        const text = '原创合成夹具流程完成。语义报告是固定测试输入，不是代码理解剧情或真实20集视觉验收。'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }; return
      }
      const id = ToolCallId(`story-faithful-${phase}-${step}`)
      const args = JSON.stringify({ description: 'Verify synthetic story-faithful creation with real video evidence', code: HEADER + program })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'run_code', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'run_code', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  ctx.llm.registerAdapter(['screenplay-story-faithful-fixture'], new FixtureAdapter())
}
