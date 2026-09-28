export function catalogRpc(action,fields){
 const fail=()=>{throw Object.assign(Error('无效的会话操作'),{status:400});};
 if(action==='create')return {method:'session/create',args:{request:{cwd:'/workspace'}}};
 if(action==='search'){if(typeof fields.query!=='string'||!fields.query.trim()||fields.query.length>2000)fail();return {method:'session/search',args:{request:{query:fields.query}}};}
 if(!['rename','archive','fork'].includes(action)||!/^[-a-zA-Z0-9_]{1,128}$/.test(fields.sessionId||''))fail();
 const request={sessionId:fields.sessionId};
 if(action==='rename'){if(typeof fields.title!=='string'||!fields.title.trim()||fields.title.length>500)fail();request.title=fields.title;}
 return {method:{rename:'session/rename',archive:'workspace/archiveSession',fork:'session/fork'}[action],args:{request}};
}
