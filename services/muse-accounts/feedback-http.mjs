import {readFile} from 'node:fs/promises';
import {feedbackPage} from './feedback-page.mjs';
export async function feedbackRoute({req,res,path,actor,environment,feedback,rate}){
 if(path!=='/feedback'&&!path.startsWith('/feedback/')&&path!=='/api/muse.feedback'&&!path.startsWith('/api/muse.feedback/'))return false;
 const send=(status,body,type='application/json; charset=utf-8',extra={})=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',...extra});res.end(type.startsWith('application/json')?JSON.stringify(body):body);};
 try{
  if(!feedback){send(503,{error:'意见箱暂不可用'});return true;}
  if(path==='/feedback'&&req.method==='GET'){send(200,feedbackPage(actor,environment),'text/html; charset=utf-8',{'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});return true;}
  if(req.method==='GET'&&['/feedback/client.js','/feedback/style.css'].includes(path)){const js=path.endsWith('.js');send(200,await readFile(new URL(js?'./feedback-client.js':'./feedback-style.css',import.meta.url)),js?'text/javascript; charset=utf-8':'text/css; charset=utf-8');return true;}
  if(path==='/api/muse.feedback/export'&&req.method==='GET'){send(200,await feedback.export(actor),'application/json; charset=utf-8',{'content-disposition':'attachment; filename="muse-feedback.json"'});return true;}
  const match=path.match(/^\/api\/muse\.feedback\/([a-f0-9]{32})(?:\/attachments\/(\d))?$/);
  if(req.method==='GET'){
   if(path==='/api/muse.feedback'){const url=new URL(req.url,'http://localhost');send(200,await feedback.list(actor,{offset:Number(url.searchParams.get('offset')||0),status:url.searchParams.get('status')||undefined}));}
   else if(match&&match[2]!==undefined){const shot=await feedback.attachment(actor,match[1],Number(match[2]));send(200,shot.data,shot.type,{'content-disposition':`attachment; filename="screenshot.${shot.file.split('.').at(-1)}"`,'content-security-policy':"default-src 'none'; sandbox"});}
   else if(match)send(200,await feedback.get(actor,match[1]));else send(404,{error:'页面不存在'});return true;
  }
  const create=path==='/api/muse.feedback'&&req.method==='POST',update=match&&match[2]===undefined&&req.method==='PATCH';
  if(!create&&!update){send(405,{error:'操作不支持'});return true;}
  if(update&&!actor.admin){send(403,{error:'仅管理员可处理意见'});return true;}
  if(!rate(req,'feedback:'+actor.id,12)){send(429,{error:'提交过于频繁，请稍后重试'});return true;}
  const limit=create?9*1024*1024:16384;if(Number(req.headers['content-length'])>limit){send(413,{error:'提交内容过大'});req.resume();return true;}
  let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>limit){send(413,{error:'提交内容过大'});return true;}chunks.push(chunk);}
  let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{send(400,{error:'提交格式不正确'});return true;}
  send(create?201:200,create?await feedback.create(actor,input):await feedback.update(actor,match[1],input));
 }catch(error){send(error.status||500,{error:error.status?error.message:'意见保存或读取失败，请稍后重试'});}return true;
}
