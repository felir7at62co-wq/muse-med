/** Publish only the verified Muse 1.1.1 native builds from the completed producer run. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createMuseMirrorPlan } from '../../apps/desktop/scripts/muse-release-mirror.mjs'
const root=resolve(process.env.MUSE_ARTIFACT_ROOT ?? '.release')
const version='1.1.1', sourceCommit='63421116448b136b7bd66fb90e22f0fe704dbe80'
const repo='felir7at62co-wq/muse-med'
function api(path) {return JSON.parse(execFileSync('gh',['api',`repos/${repo}/${path}`],{encoding:'utf8'}))}
const producer=api('actions/runs/38766474574')
assert.equal(producer.head_sha,sourceCommit);assert.equal(producer.conclusion,'success')
const plan=await createMuseMirrorPlan({version,sourceCommit,legacyRcDiscovery:true,artifactDirectories:{'mac-arm64':join(root,'mac-arm64'),'win-x64':join(root,'win-x64')}})
const capabilities=JSON.parse(process.env.MUSE_TOS_PLAN)
assert.equal(capabilities.sourceCommit,sourceCommit)
const operations=[...plan.artifacts.map(f=>({...f,kind:'binary'})),...plan.metadata.map(f=>({...f,kind:'metadata'}))]
for(const op of operations){
 const cap=capabilities.operations.find(c=>c.key===op.key)
 assert.ok(cap);assert.equal(cap.sha256,op.sha256)
 const url=new URL(cap.url);assert.equal(url.protocol,'https:');assert.equal(url.hostname,'muse.tos-s3-cn-beijing.volces.com');assert.equal(decodeURIComponent(url.pathname),'/' + op.key)
 if(process.env.GITHUB_ACTIONS==='true')console.log('::add-mask::'+cap.url)
}
const expected=new Map()
for(const name of await readdir(join(root,'publish'))){
 const hash=createHash('sha256');let size=0
 for await(const b of createReadStream(join(root,'publish',name))){hash.update(b);size+=b.length}
 expected.set(name,{size,digest:'sha256:'+hash.digest('hex')})
}
const releases=['414014136','414014161']
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
for(const op of operations){
 const cap=capabilities.operations.find(c=>c.key===op.key)
 const body=op.kind==='binary'?createReadStream(op.path):op.contents
 const response=await fetch(cap.url,{method:'PUT',headers:cap.headers,body,duplex:'half',signal:AbortSignal.timeout(1800000)})
 assert.ok(response.ok || op.kind==='binary' && response.status===412,'Mirror upload failed: HTTP '+response.status)
 await response.arrayBuffer();await verifyPublic(op)
 console.log(JSON.stringify({stage:op.kind==='binary'?'mirror-binary-verified':'mirror-feed-verified',key:op.key}))
}
execFileSync('gh',['release','edit','v1.1.1-rc.muse-stable','--draft=false','--prerelease','--latest=false','--repo',repo],{stdio:'inherit'})
execFileSync('gh',['release','edit','v1.1.1','--draft=false','--latest','--repo',repo],{stdio:'inherit'})
for(const id of releases){const r=api('releases/'+id);assert.equal(r.draft,false);validateAssets(r)}
console.log(JSON.stringify({stage:'published',version,sourceCommit,files:expected.size}))
