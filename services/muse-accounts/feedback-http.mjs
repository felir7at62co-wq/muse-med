/** Authenticated feedback routes; analysis and automation controls are administrator-only. */
import {readFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {feedbackPage} from './feedback-page.mjs';

/** Dispatch feedback requests after gateway session and Origin checks.
 * @param {object} context HTTP request, authenticated actor and gateway-owned stores.
 * @returns {Promise<boolean>} Whether the request belongs to the feedback routes.
 */
export async function feedbackRoute({req,res,path,actor,environment,feedback,feedbackAutomation,rate}){
 if(path!=='/feedback'&&!path.startsWith('/feedback/')&&path!=='/api/muse.feedback'&&!path.startsWith('/api/muse.feedback/'))return false;
 const send=(status,body,type='application/json; charset=utf-8',extra={})=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',...extra});res.end(type.startsWith('application/json')?JSON.stringify(body):body);};
 const reject=(message,status=400)=>{throw Object.assign(Error(message),{status});};
 const requireAdmin=()=>{if(!actor.admin)reject('仅管理员可使用此功能',403);};
 const automation=()=>{requireAdmin();if(!feedbackAutomation)reject('自动巡检暂不可用',503);return feedbackAutomation;};
 const enrich=async item=>actor.admin&&feedbackAutomation?{...item,triage:await feedbackAutomation.triage(item.id)}:item;
 try{
  if(!feedback){send(503,{error:'意见箱暂不可用'});return true;}
  if(path==='/feedback'&&req.method==='GET'){send(200,feedbackPage(actor,environment),'text/html; charset=utf-8',{'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});return true;}
  if(req.method==='GET'&&['/feedback/client.js','/feedback/style.css'].includes(path)){const js=path.endsWith('.js');send(200,await readFile(new URL(js?'./feedback-client.js':'./feedback-style.css',import.meta.url)),js?'text/javascript; charset=utf-8':'text/css; charset=utf-8');return true;}
  if(path==='/api/muse.feedback/export'&&req.method==='GET'){send(200,await feedback.export(actor),'application/json; charset=utf-8',{'content-disposition':'attachment; filename="muse-feedback.json"'});return true;}
  const control=path==='/api/muse.feedback/automation',run=path==='/api/muse.feedback/automation/run';
  const packages=path==='/api/muse.feedback/packages';
  const packageAction=/^\/api\/muse\.feedback\/packages\/(\d{4}-\d{2}-\d{2})\/(download|confirm-download)$/.exec(path);
  const match=path.match(/^\/api\/muse\.feedback\/([a-f0-9]{32})(?:\/(attachments\/([0-2])|triage|archive))?$/);
  if(req.method==='GET'){
   if(control)send(200,await automation().status());
   else if(packages)send(200,await automation().packages.list());
   else if(path==='/api/muse.feedback'){
    const url=new URL(req.url,'http://localhost'),offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||30),status=url.searchParams.get('status')||undefined,view=url.searchParams.get('view')||'all';
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100||!['all','active','archived','review','duplicates','needs_info','failed'].includes(view)||status&&!['new','reviewing','planned','resolved','closed'].includes(status))reject('筛选参数无效');
    if(['all','active','archived'].includes(view)){
     const result=await feedback.list(actor,{offset,limit,status,archive:view});send(200,{...result,items:await Promise.all(result.items.map(enrich))});
    }else{
     automation();const rows=await Promise.all((await feedback.snapshot()).filter(item=>!item.archivedAt&&(!status||item.status===status)).map(enrich));
     const filtered=rows.filter(item=>view==='review'?item.triage?.state==='done'&&item.triage.review==='pending':view==='duplicates'?Boolean(item.triage?.result?.duplicateOf):view==='needs_info'?Boolean(item.triage?.result?.missingInfo?.length):item.triage?.state==='failed').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
     send(200,{total:filtered.length,items:filtered.slice(offset,offset+limit)});
    }
   }else if(match?.[3]!==undefined){const shot=await feedback.attachment(actor,match[1],Number(match[3]));send(200,shot.data,shot.type,{'content-disposition':`attachment; filename="screenshot.${shot.file.split('.').at(-1)}"`,'content-security-policy':"default-src 'none'; sandbox"});}
   else if(match&&!match[2])send(200,await enrich(await feedback.get(actor,match[1])));
   else send(404,{error:'页面不存在'});
   return true;
  }
  const create=path==='/api/muse.feedback'&&req.method==='POST',update=match&&!match[2]&&req.method==='PATCH';
  const action=match&&['triage','archive'].includes(match[2])&&req.method==='POST';
  if(!create&&!update&&!action&&!(control&&req.method==='PATCH')&&!(run&&req.method==='POST')&&!(packageAction&&req.method==='POST')){send(405,{error:'操作不支持'});return true;}
  if(!create)requireAdmin();
  if(!rate(req,'feedback:'+actor.id,12)){send(429,{error:'提交过于频繁，请稍后重试'});return true;}
  const limit=create?9*1024*1024:16384;if(Number(req.headers['content-length'])>limit){send(413,{error:'提交内容过大'});req.resume();return true;}
  let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>limit){send(413,{error:'提交内容过大'});return true;}chunks.push(chunk);}
  let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch(error){reject('提交格式不正确');}
  if(!input||typeof input!=='object'||Array.isArray(input))reject('提交格式不正确');
  if(packageAction){
   const [,day,action]=packageAction,service=automation().packages;
   if(action==='confirm-download'){
    if(Object.keys(input).some(key=>key!=='receipt')||typeof input.receipt!=='string'||input.receipt.length>80)reject('下载回执无效');
    send(200,await service.confirm(day,actor,input.receipt));
   }else{
    if(Object.keys(input).length)reject('下载参数无效');
    const download=await service.download(day,actor);
    res.writeHead(200,{'content-type':'application/zip','cache-control':'no-store','x-content-type-options':'nosniff','content-length':download.size,'content-disposition':`attachment; filename="muse-feedback-${day}.zip"`,...download.receipt?{'x-muse-download-receipt':download.receipt}:{}});
    await pipeline(createReadStream(download.path),res);
   }
  }
  else if(control){await automation().configure(input);send(200,await feedbackAutomation.status());}
  else if(run){if(Object.keys(input).some(key=>key!=='retryFailed')||input.retryFailed!==undefined&&typeof input.retryFailed!=='boolean')reject('巡检操作无效');const result=await(input.retryFailed?automation().retryFailed():automation().run());send(202,result);}
  else if(match?.[2]==='triage'){await feedback.get(actor,match[1]);send(200,await automation().review(match[1],{...input,by:actor.username}));}
  else if(match?.[2]==='archive')send(200,await enrich(await feedback.setArchived(actor,match[1],input)));
  else send(create?201:200,await enrich(create?await feedback.create(actor,input):await feedback.update(actor,match[1],input)));
 }catch(error){if(res.headersSent||res.destroyed)res.destroy();else send(error.status||500,{error:error.status?error.message:'意见保存或读取失败，请稍后重试'});}
 return true;
}
