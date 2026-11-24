/** Private loopback companion; credentials arrive only on the owned parent IPC channel. */
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {timingSafeEqual} from 'node:crypto';
import {randomUUID} from 'node:crypto';
import {open,readFile,unlink,lstat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {workerPath,validateLocalMedia,localGenerationReferences} from './security.mjs';
import {trackBackgroundWork} from './background-work.mjs';
import {installOutboundGuard} from './outbound.mjs';

if(!process.send)throw new Error('Muse studio worker requires its parent IPC channel');
async function ownWorker(){
 const path=join(process.cwd(),'worker.owner'),owner={version:1,pid:process.pid,nonce:randomUUID()};
 async function publish(){const file=await open(path,'wx',0o600);try{await file.writeFile(JSON.stringify(owner));await file.sync();}finally{await file.close();}}
 try{await publish();}catch(error){
  if(error.code!=='EEXIST')throw error;const entry=await lstat(path);if(!entry.isFile()||entry.isSymbolicLink())throw new Error('Invalid studio worker ownership');
  const old=JSON.parse(await readFile(path,'utf8'));if(old.version!==1||!Number.isSafeInteger(old.pid)||old.pid<=0||typeof old.nonce!=='string')throw new Error('Invalid studio worker ownership');
  let dead=false;try{process.kill(old.pid,0);}catch(error){if(error.code==='ESRCH')dead=true;}
  if(!dead){process.send({type:'failed',code:'studio_worker_busy'});process.disconnect();return null;}
  await unlink(path);await publish();
 }
 return async()=>{const current=JSON.parse(await readFile(path,'utf8'));if(current.nonce!==owner.nonce)throw new Error('Studio worker ownership changed');await unlink(path);};
}
process.once('message',async message=>{
 if(message?.type!=='start')throw new Error('Invalid studio worker startup');
 const {backendRoot,webDistRoot,token,limits,publicOrigin,outboundOrigins,trustedLocalOrigins}=message;
 if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid studio worker credential');
 const release=await ownWorker();if(!release)return;
 process.env.WEB_DIST_PATH=webDistRoot;
 const require=createRequire(join(backendRoot,'package.json')),network=installOutboundGuard({outboundOrigins,trustedLocalOrigins,maxOutboundRequests:limits.maxOutboundRequests},require),express=require('express'),tracker=trackBackgroundWork();
 const {createApp}=require(join(backendRoot,'src/app.js')),{closeDb}=require(join(backendRoot,'src/db/index.js'));
 const {app,db}=createApp(),outer=express(),admissionFile=join(backendRoot,'src/services/museAdmission.js'),admission=existsSync(admissionFile)?require(admissionFile):undefined,libtvFile=join(backendRoot,'src/services/museLibTv.js'),libtv=existsSync(libtvFile)?require(libtvFile):undefined,cliFile=join(backendRoot,'src/services/museLibTvCli.js'),cli=existsSync(cliFile)?require(cliFile):undefined;let requests=0,stopping=false,disconnected=false;
 const state=()=>({requests,background:tracker.count(),tasks:db.prepare("SELECT COUNT(*) AS count FROM async_tasks WHERE status IN ('pending','processing','queued','running') AND deleted_at IS NULL").get().count
   +db.prepare("SELECT COUNT(*) AS count FROM video_generations WHERE status IN ('pending','processing','queued','running') AND deleted_at IS NULL").get().count
   +db.prepare("SELECT COUNT(*) AS count FROM image_generations WHERE status IN ('pending','processing','queued','running') AND deleted_at IS NULL").get().count
   +(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='muse_tts_generations'").get()?db.prepare("SELECT COUNT(*) AS count FROM muse_tts_generations WHERE state='generating'").get().count:0)
   +(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='muse_native_operations'").get()?db.prepare("SELECT COUNT(*) AS count FROM muse_native_operations WHERE state='reserved'").get().count:0)
   +(admission?admission.getActiveOperationCount(db):0)+(libtv?libtv.activeCount(db):0)+(cli?cli.activeCount(db):0)});
 const answer=(res,status,code)=>res.status(status).json({error:{code}});
 outer.use((req,res,next)=>{
  const value=req.headers['x-muse-studio-worker'];if(typeof value!=='string'||value.length!==token.length||!timingSafeEqual(Buffer.from(value),Buffer.from(token))){answer(res,403,'studio_worker_forbidden');return;}
  delete req.headers['x-muse-studio-worker'];if(stopping){answer(res,503,'studio_closing');return;}
  try{workerPath(req.url);}catch(error){answer(res,error.status??400,error.code??'studio_invalid_path');return;}
  requests++;let complete=false;const done=()=>{if(complete)return;complete=true;requests--;};res.once('finish',done);res.once('close',done);next();
 });
 outer.use(express.json({limit:limits.maxRequestBytes}));
 outer.use((req,res,next)=>{try{validateLocalMedia(req.body);if(req.body?.base_url)network.policy.target(req.body.base_url);if(req.method==='POST')localGenerationReferences(req.body,req.path,publicOrigin);next();}catch(error){answer(res,error.status??400,error.code??'studio_invalid_media_path');}});
 outer.use('/static',express.static(join(process.cwd(),'storage'),{fallthrough:false,dotfiles:'deny'}));
 outer.use(app);
 outer.use((error,req,res,next)=>{if(res.headersSent){res.destroy();return;}const status=error.status===404?404:error.type==='entity.too.large'?413:400;answer(res,status,status===404?'studio_media_not_found':status===413?'studio_request_too_large':'studio_invalid_request');});
 const server=createServer(outer);server.requestTimeout=limits.requestTimeoutMs;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 process.send({type:'ready',port:server.address().port});
 async function stop(){if(stopping)return;const current=state();if(current.requests||current.background||current.tasks)return false;stopping=true;
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));closeDb();tracker.close();await network.close();await release();if(process.connected){process.send({type:'stopped'});process.disconnect();}process.exitCode=0;return true;
 }
 process.on('message',async value=>{
  if(value?.type==='inspect'&&typeof value.id==='string'){try{process.send({type:'state',id:value.id,...state()});}catch(error){if(!disconnected)throw error;}}
  if(value?.type==='stop')await stop();
 });
 let cleanup;
 process.once('disconnect',()=>{disconnected=true;if(stopping)return;cleanup=setInterval(()=>{void stop().then(stopped=>{if(stopped)clearInterval(cleanup);});},limits.idleSweepMs);void stop();});
});
