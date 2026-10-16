/** Read every published binary and compare it with the native build manifest. */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
const manifest=JSON.parse(await readFile(new URL('./muse-113-mirror-manifest.json',import.meta.url),'utf8'))
assert.equal(manifest.version,'1.1.3');assert.equal(manifest.sourceCommit,'3285b48b3e0c632736cb54af32f7427646d42684')
const producer=JSON.parse(execFileSync('gh',['api','repos/felir7at62co-wq/muse-med/actions/runs/'+manifest.producerRunId],{encoding:'utf8'}))
assert.equal(producer.conclusion,'success');assert.equal(producer.head_sha,manifest.sourceCommit)
const results=await Promise.allSettled(manifest.operations.filter(op=>op.kind==='binary').map(async op=>{
 const response=await fetch('https://muse.tos-cn-beijing.volces.com/'+op.key,{signal:AbortSignal.timeout(1800000)});assert.equal(response.status,200)
 const hash=createHash('sha256');let bytes=0
 const progress=setInterval(()=>console.log(JSON.stringify({stage:'readback-progress',key:op.key,bytes})),30000)
 try{for await(const chunk of response.body){hash.update(chunk);bytes+=chunk.length}}finally{clearInterval(progress)}
 assert.equal(bytes,op.size);assert.equal(hash.digest('hex'),op.sha256)
 const result={key:op.key,bytes,sha256:op.sha256,verified:true};console.log(JSON.stringify(result));return result
}))
for(const result of results)if(result.status==='rejected')throw result.reason
await mkdir('.release',{recursive:true})
await writeFile('.release/mirror-full-verification.json',JSON.stringify({version:manifest.version,sourceCommit:manifest.sourceCommit,objects:results.map(result=>result.value)},null,2)+'\n')
