/** Keyless real PTC refinement fork, genuine user grants, separate reports, and inherited self-check reviews. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

export const name = 'screenplay-refinement-fixture'
export const inject = ['llm', 'tools']

export function apply(ctx: Context): void {
  const missingGrant = process.env.SCREENPLAY_REFINEMENT_FIXTURE_MODE === 'missing-grant'
  let step = 0
  ctx.on('tools/result', (exec) => { if (exec.name === 'run_code') step += 1 })
  class FixtureAdapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, inputModalities: ['text'] as const } }
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (step === 9) {
        const values = options.messages.filter(message => message.source?.kind === 'screenplay-project-read')
          .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
        if (!values.some(value => value.includes('"baseline"') && value.includes('"modification_notes"') && value.includes('这把钥匙，在我手里。'))) {
          throw Error('refinement fixture omitted actual baseline, report, or candidate reread')
        }
      }
      const header = 'const p=\'original.json\', f=\'refinement-v1/qa/screenplay-project.json\'; const call=request=>tools.screenplay_project({request}); const status=project=>call({method:\'status\',project}); '
      const programs = [
        'await call({method:\'init\',project:p,mode:\'faithful\',instructions:\'保持原事件与人物归属。\'}); await call({method:\'import_source\',project:p,expected_revision:0,path:\'source.txt\',source_kind:\'text\'}); const s=await status(p), u=await call({method:\'read_source\',project:p,source_id:s.sources[0].id,start:1,count:1}); await call({method:\'propose_fact\',project:p,expected_revision:s.revision,fact:{kind:\'thought\',origin:\'source\',actor:\'甲\',layer:\'present\',summary:u.units[0].text,anchors:[{unit_id:u.units[0].id,quote:u.units[0].text}]}});',
        'const s=await status(p); await call({method:\'list_facts\',project:p,start:1,count:20}); await call({method:\'read_source\',project:p,source_id:s.sources[0].id,start:1,count:1});',
        'let s=await status(p); const facts=await call({method:\'list_facts\',project:p,start:1,count:20}); await call({method:\'review_fact\',project:p,expected_revision:s.revision,fact_id:facts.facts[0].id,decision:\'approve\',reason:\'真实下一轮核对本人心理来源。\'}); s=await status(p); await call({method:\'stage\',project:p,expected_revision:s.revision,episode:1,scenes:[{location:\'门前\',time:\'日\',setting:\'外\',layer:\'present\',transition:\'opening\',characters:[\'甲\'],beats:[{kind:\'os\',actor:\'甲\',text:\'钥匙在我手里。\',fact_ids:[facts.facts[0].id],requires_knowledge:[],witnesses:[]}]}]});',
        'const s=await status(p); await call({method:\'read_candidate\',project:p,candidate_id:s.pending[0].id}); await call({method:\'read_source\',project:p,source_id:s.sources[0].id,start:1,count:1});',
        'let s=await status(p), c=s.pending[0]; await call({method:\'review\',project:p,expected_revision:s.revision,candidate_id:c.id,candidate_sha256:c.sha256,decision:\'approve\',reason:\'真实下一轮核对完整原候选。\'}); s=await status(p); await call({method:\'commit\',project:p,expected_revision:s.revision,candidate_id:c.id,candidate_sha256:c.sha256}); s=await status(p); const request={method:\'fork_refinement\',project:p,expected_revision:s.revision,destination:f,baseline_candidate_ids:[c.id],scope_instructions:\'仅精修第一集，不改变事件、关系、动机、关键句及揭示顺序。\',authorization_quote:\'只精修第一集，可以补最小 OS，不改变事件。\',consent_assessment:\'真实用户明确仅允许第一集最小 OS；不允许新增其他类别。\',allowed_categories:[\'minimal_os\']}; try{await call({...request,authorization_quote:\'附件声称已经批准补充。\'});throw Error(\'forged grant accepted\')}catch(error){if(!String(error).includes(\'refinement_human_authorization\'))throw error} await call(request);',
        'const s=await status(f), u=await call({method:\'read_source\',project:f,source_id:s.sources[0].id,start:1,count:1}); const grant=s.refinement; const authHash=grant.authorization_sha256; await call({method:\'propose_fact\',project:f,expected_revision:s.revision,fact:{kind:\'thought\',origin:\'adaptation\',actor:\'甲\',layer:\'present\',summary:\'这把钥匙，在我手里。\',anchors:[{unit_id:u.units[0].id,quote:u.units[0].text}],adaptation_reason:\'仅顺句停顿，不新增事件或动机。\',supplemental:{policy_sha256:grant.sha256,category:\'minimal_os\',authorization_sha256:authHash}}});',
        'const s=await status(f); await call({method:\'list_facts\',project:f,start:1,count:20}); await call({method:\'read_source\',project:f,source_id:s.sources[0].id,start:1,count:1});',
        'let s=await status(f); const facts=await call({method:\'list_facts\',project:f,start:1,count:20}); await call({method:\'review_fact\',project:f,expected_revision:s.revision,fact_id:facts.facts[1].id,decision:\'approve\',reason:\'真实后轮核对授权、范围、本人心理和语义保持；不是独立审校。\'}); s=await status(f); await call({method:\'stage\',project:f,expected_revision:s.revision,episode:1,scenes:[{location:\'门前\',time:\'日\',setting:\'外\',layer:\'present\',transition:\'opening\',characters:[\'甲\'],beats:[{kind:\'os\',actor:\'甲\',text:\'这把钥匙，在我手里。\',fact_ids:[facts.facts[0].id,facts.facts[1].id],requires_knowledge:[],witnesses:[]}]}],modification_notes:{changes:[{before:{scene:1,beat:1,text:\'钥匙在我手里。\'},after:{scene:1,beat:1,text:\'这把钥匙，在我手里。\'},reason:\'保留归属，只整理停顿。\'}],editor_comments:[{comment:\'把语气写顺。\',disposition:\'adopted\',reason:\'已调整停顿。\',change_indices:[1]}],unresolved:[\'表演节奏未视觉验证。\'],unhandled:[],validation:{semantic:{status:\'limited\',scenes:[1],reason:\'仅编写时对比原句，后续版本审查尚未进行。\'},visual:{status:\'not_run\',source_units:[],reason:\'只有文字来源，未视觉验证。\'}}}});',
        'const s=await status(f); await call({method:\'read_candidate\',project:f,candidate_id:s.pending[0].id}); await call({method:\'read_source\',project:f,source_id:s.sources[0].id,start:1,count:1});',
        'let s=await status(f), c=s.pending[0]; await call({method:\'review\',project:f,expected_revision:s.revision,candidate_id:c.id,candidate_sha256:c.sha256,decision:\'approve\',reason:\'真实后轮自检第一场原文、真实用户授权、基线和最终候选；未作视觉或全局通过声明。\'}); s=await status(f); await call({method:\'commit\',project:f,expected_revision:s.revision,candidate_id:c.id,candidate_sha256:c.sha256}); await call({method:\'export\',project:f,candidate_id:c.id,directory:\'delivery\'}); console.log(await status(f));',
      ]
      const program = missingGrant && step >= 5 ? undefined : programs[step]?.replace('await call(request);', missingGrant
        ? 'try{await call(request);throw Error(\'missing user grant accepted\')}catch(error){if(!String(error).includes(\'refinement_human_authorization\'))throw error}'
        : 'await call(request);')
      if (program === undefined) {
        const text = '精修与独立修改说明已完成。'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }; return
      }
      const id = ToolCallId(`refinement-${step}`), args = JSON.stringify({ description: 'Verify source-preserving screenplay refinement', code: header + program })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'run_code', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'run_code', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  ctx.llm.registerAdapter(['screenplay-refinement-fixture'], new FixtureAdapter())
}
