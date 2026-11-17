/** Loopback account-data-v1 gateway with private authentication and two usage cursor pages. */
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';

/**
 * Start the legacy account protocol without external services or account storage.
 * @returns {Promise<object>} Private Host login, observed request metadata and awaited shutdown.
 */
export async function startLegacyAccountDetailsStack(){
 const username='legacy_browser_writer',accountId='a123456789abcdef';
 const cookie='__Host-muse='+randomBytes(32).toString('base64url');
 const requests=[],violations=[],nextCursor='fixture-next-page';
 const summary={requests:7,completedRequests:5,failedRequests:1,pendingRequests:0,unknownRequests:1,
  reportedUsageRequests:5,partialUsageRequests:1,unreportedUsageRequests:1,inputTokens:41100,outputTokens:420,totalTokens:40520};
 const ids=Array.from({length:7},(_,index)=>'12345678-1234-4123-8123-'+String(index+1).padStart(12,'0'));
 const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
 const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  const query=Object.fromEntries(url.searchParams);
  requests.push({path:url.pathname,query,authenticated:req.headers.cookie===cookie});
  if(req.headers.cookie!==cookie){violations.push('missing-private-login');json(res,401,{error:{code:'account_session_expired'}});return;}
  if(req.method!=='GET'){violations.push('unexpected-mutation');json(res,405,{});return;}
  if(url.pathname==='/api/muse.account'){
   json(res,200,{username,accountId,environment:'fixture',workspaceLabel:username});return;
  }
  if(url.pathname==='/api/desktop-models/providers'){json(res,200,{providers:[]});return;}
  if(url.pathname==='/api/muse.account/details'){res.writeHead(404,{'content-type':'text/plain'});res.end('Not Found');return;}
  if(url.pathname==='/api/muse/identity'){json(res,200,{version:1,accountId,username,admin:false});return;}
  if(url.pathname==='/api/muse/usage'){
   if(Object.keys(query).some(key=>!['from','to','limit','cursor'].includes(key))){
    violations.push('account-scope-overridden');json(res,400,{error:{code:'invalid_usage_query'}});return;
   }
   if(!/^\d{4}-\d{2}-\d{2}$/.test(query.from)||!/^\d{4}-\d{2}-\d{2}$/.test(query.to)||query.limit!=='50'
    ||query.cursor!==undefined&&query.cursor!==nextCursor){violations.push('invalid-usage-query');json(res,400,{});return;}
   const rows=ids.map((requestId,index)=>({requestId,accountId,startedAt:query.to+'T01:0'+index+':00.000Z',
    finishedAt:index===6?null:query.to+'T01:0'+index+':01.000Z',channel:index===6?'cloud-relay':'desktop-relay',route:'fixture-route',
    state:index===1?'failed':index===6?'unknown':'completed',usageStatus:index===1?'unreported':index===6?'partial':'reported',
    usage:index===1?null:index===6?{prompt_tokens:1000}:index===0?{prompt_tokens:100,completion_tokens:20,total_tokens:120}
     :{prompt_tokens:10000,completion_tokens:100,total_tokens:10100},
    requestedModel:'legacy-model-'+(index+1),forwardedModel:null,responseModel:null,
    upstreamStatus:index===1?502:index===6?null:200,clientStatus:index===1?502:index===6?null:200,errorKind:index===1?'transport':null}));
   json(res,200,{version:1,coverage:{transport:'relay-only',direct:'unobserved'},from:query.from,to:query.to,
    summary,items:query.cursor===undefined?rows.slice(0,2):rows.slice(2),nextCursor:query.cursor===undefined?nextCursor:null,health:{state:'ok'}});return;
  }
  violations.push('unexpected-route:'+url.pathname);json(res,404,{});
 });
 const close=async()=>{
  server.closeAllConnections();
  if(server.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 };
 try{
  const listening=once(server,'listening');server.listen(0,'127.0.0.1');await listening;
  return {origin:'http://127.0.0.1:'+server.address().port,cookie,username,accountId,requests,violations,close};
 }catch(error){await close();throw error;}
}
