/**
 * Muse console HTTP server: read-only generation-record, spend and service pages for administrators, served behind nginx under the configured base path.
 * Tasks, accounts, usage and feedback stay on the existing site pages that the navigation links to.
 *
 * Identity and administrator status come from the account gateway using the viewer's own session cookie
 * (`gateway.mjs`). Request metadata comes from the export database written by `export.mjs`.
 */
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';
import {loadConfig} from './config.mjs';
import {createGatewayReader} from './gateway.mjs';
import {loadPrices} from './prices.mjs';
import {openRecords,summary,list,byAccount,byModel,byProvider,dailySeries,choices,exportedAt} from './records.mjs';
import {serviceStates} from './status.mjs';
import {dayStart} from './export.mjs';
import {layout,messagePage,recordsBody,spendBody,servicesBody} from './html.mjs';

const HEADERS={'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
 'x-content-type-options':'nosniff','referrer-policy':'same-origin','cache-control':'no-store'};
const DAY=86_400_000;
const RANGES=[{id:'today',label:'今天'},{id:'7d',label:'7 天'},{id:'30d',label:'30 天'}];
const SPEND_RANGES=[{id:'month',label:'本月'},{id:'last',label:'上月'},{id:'7d',label:'7 天'},{id:'30d',label:'30 天'}];

function rangeOf(id,now){
 const today=dayStart(now);
 return {from:id==='7d'?today-6*DAY:id==='30d'?today-29*DAY:today,to:now+1};
}

function monthStart(ms,offset=0){
 const local=new Date(ms+8*3_600_000);
 return Date.UTC(local.getUTCFullYear(),local.getUTCMonth()+offset,1)-8*3_600_000;
}

function spendRangeOf(id,now){
 if(id==='last')return {from:monthStart(now,-1),to:monthStart(now)};
 if(id==='7d'||id==='30d')return rangeOf(id,now);
 return {from:monthStart(now),to:now+1};
}

const text=(value,max=200)=>typeof value==='string'&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value)?value:'';

function filtersOf(params){
 const before=/^(\d{1,15})\.(.{1,200})$/.exec(params.get('before')??'');
 return {range:RANGES.some(item=>item.id===params.get('range'))?params.get('range'):'today',department:text(params.get('department')),account:text(params.get('account')),
  provider:text(params.get('provider')),model:text(params.get('model')),status:['failed','completed','active','interrupted'].includes(params.get('status'))?params.get('status'):'',
  before:before?{startedAt:Number(before[1]),id:before[2]}:null};
}

function directory(organization){
 const members=organization?.members??[];
 const names=new Map(members.map(member=>[member.id,member.name||member.username]));
 const departments=new Map(members.map(member=>[member.id,member.departmentPaths?.[0]?.map(node=>node.name).join(' / ')||'—']));
 return {members,nameOf:id=>names.get(id)??'账号 '+String(id).slice(0,8),departmentOf:id=>departments.get(id)??'—',
  departmentOptions:(organization?.organization?.departments??[]).map(item=>[item.id,item.name]),
  membersOf:department=>members.filter(member=>(member.departmentPaths??[]).some(path=>path.some(node=>node.id===department))).map(member=>member.id)};
}

const csvCell=value=>{let cell=String(value??'');if(/^[=+\-@\t\r]/.test(cell))cell="'"+cell;return /[",\n]/.test(cell)?'"'+cell.replace(/"/g,'""')+'"':cell;};

/**
 * Create the request handler.
 * @param {{config:object,prices:object,gateway:{viewer:Function},records:()=>import('node:sqlite').DatabaseSync,states?:typeof serviceStates,now?:()=>number}} deps Configuration and data sources.
 * @returns {(req:import('node:http').IncomingMessage,res:import('node:http').ServerResponse)=>Promise<void>} Handler.
 */
export function createConsole({config,prices,gateway,records,states=serviceStates,now=Date.now}){
 const base=config.basePath;
 const send=(res,status,body,type='text/html; charset=utf-8',extra={})=>{res.writeHead(status,{...HEADERS,'content-type':type,...extra});res.end(body);};
 return async function handle(req,res){
  try{
   const url=new URL(req.url??'/','http://console.invalid');
   if(url.pathname===base+'/healthz'){send(res,200,'ok','text/plain; charset=utf-8');return;}
   if(url.pathname!==base&&!url.pathname.startsWith(base+'/')){send(res,404,messagePage({title:'找不到页面',text:''}));return;}
   if(req.method!=='GET'&&req.method!=='HEAD'){send(res,405,'',undefined,{allow:'GET, HEAD'});return;}
   const viewer=await gateway.viewer(req.headers.cookie);
   if(viewer.state==='anonymous'){send(res,401,messagePage({title:'请先登录',text:'用飞书登录主站后再打开管理台。',href:config.loginPath,label:'去登录'}));return;}
   if(viewer.state!=='admin'){send(res,403,messagePage({title:'没有权限',text:'管理台目前只对管理员开放。'}));return;}
   const org=directory(viewer.organization);
   const path=url.pathname.slice(base.length)||'/';
   if(path==='/'){res.writeHead(302,{...HEADERS,location:base+'/records'});res.end();return;}
   if(path==='/records'||path==='/records.csv'){
    const filters=filtersOf(url.searchParams),range=rangeOf(filters.range,now());
    const accountIds=filters.account?[filters.account]:filters.department?org.membersOf(filters.department):null;
    const scope={...range,accountIds,provider:filters.provider,model:filters.model,status:filters.status};
    const db=records();
    if(path==='/records.csv'){
     const page=list(db,prices,{...scope,limit:10_000});
     const lines=[['时间','人','部门','模型','线路','状态','HTTP','输入','缓存命中','输出','耗时秒','估算元'].join(',')].concat(page.rows.map(row=>[new Date(row.started_at).toISOString(),org.nameOf(row.account_id),org.departmentOf(row.account_id),row.model,row.provider,row.failed?'失败':row.outcome,row.http_status,row.input_tokens,row.cache_read_tokens,row.output_tokens,row.finished_at?((row.finished_at-row.started_at)/1000).toFixed(1):'',row.cost===null?'':row.cost.toFixed(6)].map(csvCell).join(',')));
     send(res,200,'﻿'+lines.join('\n'),'text/csv; charset=utf-8',{'content-disposition':'attachment; filename="muse-records.csv"'});return;
    }
    const page=list(db,prices,{...scope,before:filters.before,limit:100});
    const seen=choices(db,range);
    const query=changes=>{const params=new URLSearchParams();const merged={...filters,before:filters.before?filters.before.startedAt+'.'+filters.before.id:null,...changes};
     for(const key of ['range','department','account','provider','model','status','before'])if(merged[key])params.set(key,merged[key]);return params.toString();};
    send(res,200,layout({base,active:'records',viewer:viewer.account,title:'生成记录',body:recordsBody({base,range:filters.range,ranges:RANGES,totals:summary(db,prices,{...range,accountIds}),filters,
     options:{departments:org.departmentOptions,accounts:org.members.map(member=>[member.id,member.name||member.username]).sort((a,b)=>a[1].localeCompare(b[1],'zh-CN')),providers:seen.providers,models:seen.models},
     rows:page.rows,next:page.next,nameOf:org.nameOf,departmentOf:org.departmentOf,exportedAt:exportedAt(db),priceVersion:prices.version,query})}));
    return;
   }
   if(path==='/spend'){
    const params=url.searchParams,id=SPEND_RANGES.some(item=>item.id===params.get('range'))?params.get('range'):'month';
    const group=['department','person','model'].includes(params.get('group'))?params.get('group'):'department';
    const range=spendRangeOf(id,now()),db=records();
    let ranking;
    if(group==='model')ranking=byModel(db,prices,range).map(item=>({key:item.provider+'/'+item.model,label:item.model,sub:item.provider+(item.unpricedRequests?' · 未定价':''),requests:item.requests,yuan:item.yuan}));
    else{
     const perAccount=byAccount(db,prices,range);
     if(group==='person')ranking=[...perAccount].map(([key,item])=>({key,label:org.nameOf(key),sub:org.departmentOf(key),requests:item.requests,yuan:item.yuan}));
     else{
      const grouped=new Map();
      for(const [key,item] of perAccount){const label=org.departmentOf(key),entry=grouped.get(label)??{key:label,label,people:0,requests:0,yuan:0};entry.people++;entry.requests+=item.requests;entry.yuan+=item.yuan;grouped.set(label,entry);}
      ranking=[...grouped.values()].map(item=>({...item,sub:item.people+' 人'}));
     }
    }
    ranking.sort((a,b)=>b.yuan-a.yuan||b.requests-a.requests);
    send(res,200,layout({base,active:'spend',viewer:viewer.account,title:'花费',body:spendBody({base,range:id,ranges:SPEND_RANGES,group,totals:summary(db,prices,range),series:dailySeries(db,prices,range),ranking,priceVersion:prices.version})}));
    return;
   }
   if(path==='/services'){
    const current=now();
    send(res,200,layout({base,active:'services',viewer:viewer.account,title:'服务',body:servicesBody({services:await states(config.services),routes:byProvider(records(),{from:current-DAY,to:current+1})})}));return;
   }
   send(res,404,messagePage({title:'找不到页面',text:''}));
  }catch(error){
   const unavailable=error?.status===502;
   send(res,unavailable?502:500,messagePage({title:unavailable?'暂时读不到账号信息':'出错了',text:unavailable?(error?.message==='gateway_timeout'?'账号网关响应太慢，请稍后刷新。':'账号网关没有响应，请稍后刷新。'):'请稍后刷新；问题持续请联系管理员。'}));
   console.error(JSON.stringify({level:'error',code:error?.message?.slice(0,80)??'unknown'}));
  }
 };
}

async function main(){
 const config=loadConfig();
 const prices=loadPrices(config.pricesFile);
 const gateway=createGatewayReader({origin:config.gatewayOrigin,cookieName:config.cookieName});
 let db=null;
 const records=()=>db??=openRecords(config.exportDb);
 const server=createServer(createConsole({config,prices,gateway,records}));
 server.listen(config.port,'127.0.0.1',()=>console.log(JSON.stringify({level:'info',listening:config.port,base:config.basePath,prices:prices.version})));
 const stop=()=>{server.close();server.closeAllConnections();db?.close();setTimeout(()=>process.exit(0),2000).unref();};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
}

// Compare real paths: deployments start the file through the `current` release symlink.
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href)
 main().catch(error=>{console.error(JSON.stringify({level:'fatal',message:String(error?.message??error).slice(0,300)}));process.exitCode=1;});
