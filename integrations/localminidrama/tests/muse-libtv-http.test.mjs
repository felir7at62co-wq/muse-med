/** Account-free HTTP exchanges verify independent JSON and result-download deadlines. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createServer} from 'node:http'
import {compileFunction} from 'node:vm'

test('result downloads use the media deadline while Agent requests use the HTTP deadline',async t=>{
 const deadlines=[],module={exports:{}}
 compileFunction(readFileSync(new URL('../extensions/muse-libtv-http.cjs',import.meta.url),'utf8'),['module','exports','AbortSignal'])(module,module.exports,{timeout:duration=>{deadlines.push(duration);return new AbortController().signal}})
 const service=module.exports,headers=[],server=createServer((req,res)=>{headers.push(req.headers);if(req.url==='/openapi/session'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{sessionId:'fixture-session',projectUuid:'fixture-project'}}))}else res.end('verified fixture bytes')})
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port,limits=service.limits({muse_libtv:{http_timeout_ms:125,media_timeout_ms:950,api_origins:[origin],media_origins:[origin],trusted_local_origins:[origin]}})
 assert.equal((await service.create({base_url:origin,api_key:'fixture-private-only'},limits).bind()).session_id,'fixture-session');assert.equal((await service.download(origin+'/result.png',limits)).toString(),'verified fixture bytes');assert.deepEqual(deadlines,[125,950]);assert.equal(headers[0].authorization,'Bearer fixture-private-only');assert.equal(headers[1].authorization,undefined);assert.equal(headers[1].cookie,undefined)
 await assert.rejects(service.create({base_url:origin,api_key:'fixture-private-only'},limits).bind('other-session'),{code:'libtv_session_changed'})
})
