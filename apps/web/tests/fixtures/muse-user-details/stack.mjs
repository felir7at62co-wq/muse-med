/** Real private account gateway used by the account-details browser scenario. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createAccountServer} from '../../../../../services/muse-accounts/gateway.mjs';
import {openStore} from '../../../../../services/muse-accounts/store.mjs';
import {openUsageLedger} from '../../../../../services/muse-accounts/account-details.mjs';

/**
 * Start an account gateway with current Feishu membership and one private usage receipt.
 * @param {string} root Per-test private directory owned by the browser scenario.
 * @returns {Promise<object>} Gateway identity, private Host login and awaited shutdown.
 */
export async function startAccountDetailsStack(root){
 const store=await openStore(join(root,'accounts.json')),ledger=await openUsageLedger(join(root,'usage.jsonl'));
 const account=await store.create('browser_writer','browser-test-password');
 await store.resolveFeishuIdentity({appId:'cli_browser',openId:'ou_browser_writer',tenantKey:'tenant_browser',name:'测试编剧',
  organization:{status:'available',syncedAt:new Date().toISOString(),departments:[{id:'od-writing',name:'编剧组',path:'内容中心/编剧组',pathIds:['od-content','od-writing']}]},
 },{bindAccountId:account.id});
 await store.recordLogin(account.id,{feishuIdentity:{appId:'cli_browser',openId:'ou_browser_writer',tenantKey:'tenant_browser'}});
 await store.setGroups(account.id,[{name:'短剧创作组',description:'负责剧本与分镜创作'}]);
 const carrier=createServer();let gateway;
 const close=async()=>{
  carrier.closeAllConnections();
  if(carrier.listening)await new Promise((resolve,reject)=>carrier.close(error=>error?reject(error):resolve()));
  await ledger.flush();
 };
 try{
  await new Promise((resolve,reject)=>{carrier.once('error',reject);carrier.listen(0,'127.0.0.1',resolve);});
  const origin='http://127.0.0.1:'+carrier.address().port;
  gateway=createAccountServer({httpServer:carrier,publicOrigin:origin,store,usageLedger:ledger,workspaceMode:'desktop'});
  const login=await fetch(origin+'/login',{method:'POST',redirect:'manual',headers:{origin},body:new URLSearchParams({username:account.username,password:'browser-test-password'})});
  assert.equal(login.status,303);
  const cookie=login.headers.getSetCookie().find(value=>value.startsWith('__Host-muse='))?.split(';')[0];assert.ok(cookie);
  const receipt=await fetch(origin+'/api/muse.account/usage',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({
   id:randomUUID(),provider:'browser-studio',model:'browser-writer',status:200,inputTokens:120,outputTokens:40,totalTokens:160,cachedInputTokens:30,reasoningTokens:10,
  })});
  assert.equal(receipt.status,204);
  return {origin,cookie,username:account.username,close};
 }catch(error){await close();throw error;}
}
