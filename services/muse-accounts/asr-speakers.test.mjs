/** Speaker separation requests and safe utterance normalization. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {submitAsr,queryAsr} from './asr-provider.mjs';

const config={appId:'test-app',accessToken:'fixture-only',timeoutMs:1000,speakerDiarization:true,speakerDiarizationVersion:'200',speakerLongAudioSeconds:180};
const response=body=>Response.json(body,{headers:{'X-Api-Status-Code':'20000000'}});

test('screenplay recognition enables speaker separation for short and long non-meeting audio',async()=>{
 for(const [durationSeconds,mode] of [[100,0],[600,1]]){
  let request;
  await submitAsr(config,{id:'fixture-id',url:'https://example.test/audio',language:'zh',purpose:'screenplay',durationSeconds},async(_url,init)=>{request=JSON.parse(init.body).request;return response({});});
  assert.equal(request.enable_speaker_info,true);assert.equal(request.show_utterances,true);
  assert.equal(request.ssd_version,'200');assert.equal(request.ssd_mode,mode);
  assert.equal(request.language,undefined);
 }
});
test('legacy and subtitle recognition do not gain a speaker-separation request',async()=>{
 for(const purpose of [undefined,'subtitles']){
  let request;
  await submitAsr(config,{id:'fixture-id',url:'https://example.test/audio',language:'zh',purpose,durationSeconds:100},async(_url,init)=>{request=JSON.parse(init.body).request;return response({});});
  assert.equal(request.enable_speaker_info,undefined);
 }
});
test('disabled separation omits speaker options and the 300 model omits the 200-only mode',async()=>{
 for(const [extra,expected] of [[{speakerDiarization:false},{}],[{speakerDiarizationVersion:'300'},{enable_speaker_info:true,ssd_version:'300'}]]){
  let request;
  await submitAsr({...config,...extra},{id:'fixture-id',url:'https://example.test/audio',language:'zh',purpose:'screenplay',durationSeconds:600},async(_url,init)=>{request=JSON.parse(init.body).request;return response({});});
  assert.equal(request.enable_speaker_info,expected.enable_speaker_info);assert.equal(request.ssd_version,expected.ssd_version);
  assert.equal(request.ssd_mode,undefined);
 }
});
test('retains available speaker IDs without copying provider additions',async()=>{
 const result=await queryAsr(config,'fixture',async()=>response({result:{utterances:[
  {start_time:0,end_time:1000,text:'你好',additions:{speaker_id:'0',private_debug:'provider-only'}},
  {start_time:1000,end_time:2000,text:'再见',speaker_id:'1'},
  {start_time:2000,end_time:3000,text:'未知声音'},
  {start_time:3000,end_time:4000,text:'AUC实际字段',additions:{speaker:'2',private_debug:'provider-only'}},
  {start_time:4000,end_time:5000,text:'同号字段',speaker_id:'3',additions:{speaker_id:'3',speaker:'3'}},
 ]}}));
 assert.deepEqual(result.segments.map(segment=>segment.speaker_id),['0','1',undefined,'2','3']);
 assert.equal(JSON.stringify(result).includes('provider-only'),false);
});
test('rejects invalid or conflicting speaker IDs instead of silently merging identities',async()=>{
 for(const fields of [{speaker_id:''},{speaker_id:{name:'malformed'}},{speaker_id:'1',additions:{speaker_id:'2'}},{additions:{speaker:''}},{additions:{speaker:1}},{speaker_id:'1',additions:{speaker:'2'}}]){
  await assert.rejects(queryAsr(config,'fixture',async()=>response({result:{utterances:[{start_time:0,end_time:1000,text:'你好',...fields}]}})),{code:'provider_unavailable'});
 }
});
