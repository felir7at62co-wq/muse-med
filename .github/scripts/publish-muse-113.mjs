/** Publish only the verified Muse 1.1.3 native builds from the completed producer run. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { execFileSync, execFile } from 'node:child_process'
const execFileAsync=promisify(execFile)
import { createMuseMirrorPlan } from '../../apps/desktop/scripts/muse-release-mirror.mjs'
const root=resolve(process.env.MUSE_ARTIFACT_ROOT ?? '.release')
const version='1.1.3', sourceCommit='3285b48b3e0c632736cb54af32f7427646d42684'
const repo='felir7at62co-wq/muse-med'
function api(path) {return JSON.parse(execFileSync('gh',['api',`repos/${repo}/${path}`],{encoding:'utf8'}))}
const producer=api('actions/runs/38852653581')
assert.equal(producer.head_sha,sourceCommit);assert.equal(producer.conclusion,'success')
const plan=await createMuseMirrorPlan({version,sourceCommit,legacyRcDiscovery:true,artifactDirectories:{'mac-arm64':join(root,'mac-arm64'),'win-x64':join(root,'win-x64')}})
const capabilities=JSON.parse(process.env.MUSE_TOS_PLAN)
assert.equal(capabilities.sourceCommit,sourceCommit)
const operations=[...plan.artifacts.map(f=>({...f,kind:'binary'})),...plan.metadata.map(f=>({...f,kind:'metadata'}))]
for(const op of operations){
 const cap=capabilities.operations.find(c=>c.key===op.key)
 assert.ok(cap);assert.equal(cap.sha256,op.sha256)
 const url=new URL(cap.url);assert.equal(url.protocol,'https:');assert.equal(url.hostname,'muse.tos-s3-cn-beijing.volces.com');assert.equal(decodeURIComponent(url.pathname),'/' + op.key)
 const md5=createHash('md5')
 if(op.kind==='binary')for await(const b of createReadStream(op.path))md5.update(b)
 else md5.update(op.contents)
 assert.equal(cap.headers['content-md5'],md5.digest('base64'))
 if(op.kind==='binary')assert.equal(cap.headers['if-none-match'],'*')
 if(process.env.GITHUB_ACTIONS==='true')console.log('::add-mask::'+cap.url)
}
const expected=new Map()
for(const name of await readdir(join(root,'publish'))){
 const hash=createHash('sha256');let size=0
 for await(const b of createReadStream(join(root,'publish',name))){hash.update(b);size+=b.length}
 expected.set(name,{size,digest:'sha256:'+hash.digest('hex')})
}
const releases=['414549584','414550220']
function validateAssets(release){
 assert.equal(release.target_commitish,sourceCommit)
 for(const asset of release.assets){const e=expected.get(asset.name);assert.ok(e);assert.equal(asset.state,'uploaded');assert.equal(asset.size,e.size);assert.equal(asset.digest,e.digest)}
}
for(const id of releases){const release=api('releases/'+id);assert.equal(release.draft,true);validateAssets(release)}
if(process.argv.includes('--verify-only')){console.log(JSON.stringify({stage:'publication-preflight',files:expected.size,operations:operations.length,sourceCommit}));process.exit(0)}
for(const id of releases){
 let release=api('releases/'+id)
 for(const [name] of expected){
  if(release.assets.some(a=>a.name===name))continue
  execFileSync('gh',['release','upload',release.tag_name,join(root,'publish',name),'--repo',repo],{stdio:'inherit'})
  release=api('releases/'+id);validateAssets(release)
 }
 assert.equal(release.assets.length,expected.size)
 console.log(JSON.stringify({stage:'github-draft-assets-verified',release:release.tag_name,files:release.assets.length}))
}
async function verifyPublic(op){
 const response=await fetch('https://muse.tos-cn-beijing.volces.com/'+op.key,{signal:AbortSignal.timeout(1800000)})
 assert.equal(response.status,200)
 const hash=createHash('sha256');let size=0
 for await(const b of response.body){hash.update(b);size+=b.length}
 assert.equal(hash.digest('hex'),op.sha256)
 assert.equal(size,op.kind==='binary'?op.size:Buffer.byteLength(op.contents))
}
async function uploadMirror(op){
 const publicUrl='https://muse.tos-cn-beijing.volces.com/'+op.key
 if(op.kind==='binary'){
  const existing=await fetch(publicUrl,{method:'HEAD',signal:AbortSignal.timeout(60000)})
  if(existing.ok){await verifyPublic(op);console.log(JSON.stringify({stage:'mirror-binary-reconciled',key:op.key}));return}
  assert.equal(existing.status,404)
 }
 const cap=capabilities.operations.find(c=>c.key===op.key)
 const temporary=await mkdtemp(join(tmpdir(),'muse-113-upload-'))
 const started=Date.now()
 const progress=setInterval(()=>console.log(JSON.stringify({stage:'mirror-upload-active',key:op.key,elapsedSeconds:Math.round((Date.now()-started)/1000)})),30000)
 try{
  const bodyPath=op.kind==='binary'?op.path:join(temporary,'metadata')
  if(op.kind!=='binary')await writeFile(bodyPath,op.contents,{mode:0o600})
  const configPath=join(temporary,'request.conf')
  const lines=['url = '+JSON.stringify(cap.url),...Object.entries(cap.headers).map(([key,value])=>'header = '+JSON.stringify(key+': '+value))]
  await writeFile(configPath,lines.join('\n')+'\n',{mode:0o600})
  const {stdout}=await execFileAsync('curl',['--config',configPath,'--http1.1','--silent','--show-error','--connect-timeout','30','--max-time','1200','--speed-limit','16384','--speed-time','90','--upload-file',bodyPath,'--output',join(temporary,'response'),'--write-out','%{http_code} %{size_upload} %{speed_upload} %{time_total}'],{maxBuffer:1024*1024})
  const [status,bytes,speed,seconds]=stdout.trim().split(' ')
  assert.ok(status==='200'||status==='204'||op.kind==='binary'&&status==='412','Mirror upload failed: HTTP '+status)
  console.log(JSON.stringify({stage:'mirror-upload-complete',key:op.key,status,bytes:Number(bytes),bytesPerSecond:Number(speed),seconds:Number(seconds)}))
 }finally{clearInterval(progress);await rm(temporary,{recursive:true,force:true})}
 await verifyPublic(op)
 console.log(JSON.stringify({stage:op.kind==='binary'?'mirror-binary-verified':'mirror-feed-verified',key:op.key}))
}
for(const op of operations)await uploadMirror(op)
execFileSync('gh',['release','edit','v1.1.3-rc.muse-stable','--draft=false','--prerelease','--latest=false','--repo',repo],{stdio:'inherit'})
execFileSync('gh',['release','edit','v1.1.3','--draft=false','--latest','--repo',repo],{stdio:'inherit'})
for(const id of releases){const r=api('releases/'+id);assert.equal(r.draft,false);validateAssets(r)}
console.log(JSON.stringify({stage:'published',version,sourceCommit,files:expected.size}))
