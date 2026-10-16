/** Safe source failures retain platform status while catalog discovery remains unverified. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { HongguoDownloadClient } from '../src/client.js';
import { safeError } from '../src/errors.js';
const reply=value=>Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]),{statusCode:200,headers:{}});
const signal=()=>new AbortController().signal;
const box=(type,data=Buffer.alloc(0))=>{const header=Buffer.alloc(8);header.writeUInt32BE(data.length+8);header.write(type,4);return Buffer.concat([header,data]);};
const media=Buffer.concat([box('ftyp',Buffer.from('isom\0\0\0\0isom')),box('moov',box('trak',box('mdia'))),box('mdat',Buffer.from('fixture'))]);
const video=vids=>({Code:0,BaseResp:{StatusCode:0},data:Object.fromEntries(vids.map(vid=>[vid,{video_model:JSON.stringify({video_list:[{main_url:`https://v1.qznovelvod.com/${vid}?token=SOURCE_PRIVATE`,video_meta:{size:media.length}}]})}]))});
const detail=(id,count)=>({code:0,data:{[id]:{video_data:{series_id:id,series_title:'Synthetic',episode_cnt:count,video_list:Array.from({length:count},(_,i)=>({vid_index:i+1,vid:`video-${i+1}`}))}}}});
async function fixture(t,respond,{retries=0,count=2}={}){
 const root=await mkdtemp(join(tmpdir(),'muse-hongguo-status-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const legacy=join(root,'source');await mkdir(legacy);
 await writeFile(join(legacy,'config.json'),JSON.stringify({api_host:'api.example.org',base_query:{app:1},session_headers:{}}));
 await writeFile(join(legacy,'devices.json'),JSON.stringify([0,1].map(i=>({query:{device:`synthetic-${i}`}}))));
 const calls=[];
 const client=new HongguoDownloadClient({legacyAppDir:legacy,signServer:'http://127.0.0.1:1234',outputRoot:root,retries,retryDelayMs:0,mediaRequestIntervalMs:0},{
  sign:async()=>reply({}),processMedia:async(_media,{inputPath})=>({processedPath:inputPath,durationSeconds:1,fullDecodeChecked:true,validationLevel:'ffprobe-full-decode-sha256'}),
  request:async(url,kind,active,options)=>{
   active.throwIfAborted();calls.push({kind,url});
   if(kind==='media')return Object.assign(Readable.from([media]),{statusCode:200,headers:{'content-length':String(media.length),'content-type':'video/mp4'}});
   const body=JSON.parse(options.body);
   if(new URL(url).pathname.includes('multi_video_detail'))return reply(detail(body.series_id,count));
   return reply(await respond(body.mixed_video_id_map['1004'],active,calls));
  },
 });
 t.after(()=>client.dispose());
 client.source.randomIndex=()=>0;
 return {client,root,calls};
}
for(const response of [
 {Code:110001,Message:'SOURCE_PRIVATE'},
 {Code:'110001',Message:'SOURCE_PRIVATE'},
 {BaseResp:{StatusCode:110001,StatusMessage:'SOURCE_PRIVATE'}},
 {code:0,Code:110001,data:{unused:'SOURCE_PRIVATE'}},
 {Code:0,BaseResp:{StatusCode:'110001'}},
])test(`platform envelope ${JSON.stringify(response)} cannot become a missing-media error`,async t=>{
 const f=await fixture(t,()=>response);
 await assert.rejects(f.client.source.videoUrls(['synthetic'],signal()),error=>{
  assert.deepEqual(safeError(error),{code:'platform_error',message:'红果原源 API 返回业务错误；请检查失败阶段与错误码，不要立即重复下载',upstreamCode:110001,sourceStage:'video_model',retryable:false});return true;
 });
 assert.equal(f.calls.length,1);
});
for(const code of [true,1.5,'','invalid','9007199254740993'])test(`rejects malformed source status ${JSON.stringify(code)} before media resolution`,async t=>{
 const f=await fixture(t,()=>({Code:code}));
 await assert.rejects(f.client.source.videoUrls(['synthetic'],signal()),error=>error.code==='platform_json'&&error.sourceStage==='video_model'&&error.retryable===false);
});
test('authorization failures do not rotate or retry the retained device',async t=>{
 const f=await fixture(t,()=>({Code:'403',Message:'SOURCE_PRIVATE'}),{retries:2});
 await assert.rejects(f.client.source.videoUrls(['synthetic'],signal()),error=>error.code==='platform_error'&&error.upstreamCode===403);
 assert.equal(f.calls.length,1);assert.equal(f.client.source.deviceIndex,0);
});
test('an explicit risk response uses bounded retries and preserves successful media resolution',async t=>{
 let tries=0;const f=await fixture(t,vids=>++tries===1?{BaseResp:{StatusCode:110001,StatusMessage:'rate limit'}}:video(vids),{retries:2});
 const urls=await f.client.source.videoUrls(['synthetic'],signal());
 assert.equal(urls.size,1);assert.equal(tries,2);
 assert.deepEqual(f.calls.map(c=>new URL(c.url).searchParams.get('device')),['synthetic-0','synthetic-1']);
});
test('unknown upstream errors stop after one request and clean partial output',async t=>{
 const f=await fixture(t,()=>({Code:110001,Message:'SOURCE_PRIVATE',BaseResp:{StatusCode:110001}}),{retries:2});
 await writeFile(join(f.root,'existing.txt'),'keep');
 const result=await f.client.download({seriesIds:['123']});
 assert.equal(result.code,'platform_error');assert.equal(result.upstreamCode,110001);assert.equal(result.sourceStage,'video_model');assert.equal(result.retryable,false);
 assert.equal(f.calls.filter(c=>c.kind==='api'&&new URL(c.url).pathname.includes('video_model')).length,1);
 assert.equal(f.client.source.deviceIndex,0);
 assert.equal(f.calls.some(c=>c.kind==='media'),false);
 assert.equal(JSON.stringify(result).includes('SOURCE_PRIVATE'),false);
 assert.equal(await readFile(join(f.root,'existing.txt'),'utf8'),'keep');
 assert.deepEqual(await readdir(join(f.root,'downloads')),[]);
});
test('a later failed media batch removes already downloaded files without publishing success',async t=>{
 let saved;const completed=new Promise(resolve=>{saved=resolve;});
 const f=await fixture(t,async vids=>{if(vids.includes('video-6')){await completed;return {BaseResp:{StatusCode:110001}};}return video(vids);},{count:7});
 const original=f.client.saveEpisode.bind(f.client);
 f.client.saveEpisode=async(...args)=>{const result=await original(...args);saved();return result;};
 const result=await f.client.download({seriesIds:['123']});
 assert.equal(result.code,'platform_error');assert.equal(result.complete,false);
 assert.ok(f.calls.filter(c=>c.kind==='media').length>=1);
 assert.deepEqual(await readdir(join(f.root,'downloads')),[]);
});
test('cancelled source retries stop dispatch and await partial cleanup',async t=>{
 let started;const entered=new Promise(resolve=>{started=resolve;});
 const f=await fixture(t,async(_vids,active)=>{started();await new Promise((_,reject)=>active.addEventListener('abort',()=>reject(active.reason),{once:true}));},{retries:2});
 const controller=new AbortController();const pending=f.client.download({seriesIds:['123']},controller.signal);
 await entered;controller.abort();const result=await pending;await f.client.dispose();
 assert.equal(result.code,'cancelled');assert.equal(f.calls.length,2);assert.deepEqual(await readdir(join(f.root,'downloads')),[]);
});
test('a successful envelope with no media remains a genuine missing-address failure',async t=>{
 const f=await fixture(t,()=>({code:0,Code:0,BaseResp:{StatusCode:0},data:{}}));
 await assert.rejects(f.client.source.videoUrls(['synthetic'],signal()),error=>error.code==='missing_episode_url');
});
test('complete legacy catalogs report unknown media availability without sending a media query',async t=>{
 const f=await fixture(t,()=>{throw new Error('media must not be queried by info');});
 const result=await f.client.info({seriesIds:['123','456']});
 assert.equal(result.ok,true);assert.equal(result.verifiedDownload,false);
 for(const row of result.items){assert.equal(row.completeCatalog,true);assert.equal(row.fullSeriesAvailable,null);assert.equal(row.accessibleEpisodeCount,null);assert.equal(row.mediaUrlsVerified,false);assert.equal(row.downloaded,false);}
 assert.equal(f.calls.length,2);assert.match(result.note,/目录完整不代表媒体可下载/);
});
test('conflicting nonzero status codes fail without retrying an authorization error',async t=>{
 const f=await fixture(t,()=>({code:110001,Code:403}),{retries:2});
 await assert.rejects(f.client.source.videoUrls(['synthetic'],signal()),error=>error.code==='platform_json'&&error.retryable===false);
 assert.equal(f.calls.length,1);
});
test('catalog failures retain their stage without claiming media or downloads are available',async t=>{
 const f=await fixture(t,()=>video([]));
 f.client.source.request=async()=>reply({BaseResp:{StatusCode:110001,StatusMessage:'SOURCE_PRIVATE'}});
 const result=await f.client.info({seriesIds:['123']});
 assert.equal(result.ok,false);assert.equal(result.sourceStage,'catalog');assert.equal(result.upstreamCode,110001);assert.equal(result.retryable,false);
 assert.equal(JSON.stringify(result).includes('SOURCE_PRIVATE'),false);
});

test('explicit risk responses stop at the configured budget and report no immediate retry',async t=>{
 const f=await fixture(t,()=>({BaseResp:{StatusCode:110001,StatusMessage:'rate limit SOURCE_PRIVATE'}}),{retries:2});
 const result=await f.client.download({seriesIds:['123']});
 assert.equal(result.code,'platform_error');assert.equal(result.upstreamCode,110001);assert.equal(result.retryable,false);
 assert.equal(f.calls.filter(c=>c.kind==='api'&&new URL(c.url).pathname.includes('video_model')).length,3);
 assert.match(result.message,/重试已用尽/);assert.equal(JSON.stringify(result).includes('SOURCE_PRIVATE'),false);
 assert.deepEqual(await readdir(join(f.root,'downloads')),[]);
});

test('preload resolution rejects obsolete unkeyed single-video models',async t=>{
 const old=video(['synthetic']);
 const f=await fixture(t,()=>({Code:0,data:old.data.synthetic}));
 await assert.rejects(f.client.source.videoUrls(['synthetic'],signal()),error=>error.code==='missing_episode_url');
 assert.equal(f.calls.length,1);
});
test('preload resolution rejects malformed model JSON before media dispatch',async t=>{
 const f=await fixture(t,()=>({Code:0,data:{synthetic:{video_model:'{"video_list":'}}}));
 await assert.rejects(f.client.source.videoUrls(['synthetic'],signal()),error=>error.code==='platform_json');
 assert.equal(f.calls.some(call=>call.kind==='media'),false);
});

test('empty successful HTTP media replies report their stage without retrying or rotating the device',async t=>{
 const f=await fixture(t,()=>video([]),{retries:2});
 const original=f.client.source.request;
 f.client.source.request=async(url,kind,active,options)=>{
  if(kind==='api'&&new URL(url).pathname.includes('video_model')){
   f.calls.push({kind,url});return Object.assign(Readable.from([]),{statusCode:200,headers:{'content-length':'0'}});
  }
  return original(url,kind,active,options);
 };
 const result=await f.client.download({seriesIds:['123'],episodes:[1]});
 assert.equal(result.ok,false);assert.equal(result.code,'empty_source_response');assert.equal(result.sourceStage,'video_model');
 assert.equal(result.httpStatus,200);assert.equal(result.responseBytes,0);assert.equal(result.retryable,false);
 assert.equal(f.calls.filter(call=>new URL(call.url).pathname.includes('video_model')).length,1);
 assert.equal(f.client.source.deviceIndex,0);assert.deepEqual(await readdir(join(f.root,'downloads')),[]);
});

test('nonempty invalid JSON preserves safe response facts without leaking source bytes',async t=>{
 const f=await fixture(t,()=>video([]),{retries:2});
 f.client.source.request=async()=>Object.assign(Readable.from([Buffer.from('SOURCE_PRIVATE')]),{statusCode:200,headers:{}});
 const result=await f.client.info({seriesIds:['123']});
 assert.equal(result.code,'platform_json');assert.equal(result.sourceStage,'catalog');assert.equal(result.responseBytes,14);
 assert.equal(result.httpStatus,200);assert.equal(result.retryable,false);assert.ok(!JSON.stringify(result).includes('SOURCE_PRIVATE'));
});
