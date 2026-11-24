/** Refresh scoped workbench data without navigating away or discarding a populated page on errors. */
(()=>{
 const button=document.getElementById('wb-refresh'),status=document.getElementById('wb-refresh-status');
 if(!button||!status)return;
 let pending,stopped=false,fingerprint,activeAction=false;
 const toast=document.getElementById('wb-toast');let toastTimer;
 function notice(message){
  if(!toast)return;clearTimeout(toastTimer);toast.querySelector('span').textContent=message;toast.hidden=false;
  toastTimer=setTimeout(()=>{toast.hidden=true;},6000);
 }
 const current=()=>document.querySelector('[data-workbench-content]');
 const digest=model=>JSON.stringify({...model,serverTime:undefined});
 async function refresh(force=false){
  if(pending||stopped||document.hidden||activeAction)return;
  const controller=new AbortController();pending=controller;button.disabled=true;
  const deadline=setTimeout(()=>controller.abort(),10000);
  try{
   const options={cache:'no-store',redirect:'manual',signal:controller.signal};
   const response=await fetch('/api/workbench'+location.search,options);
   if(response.status===401||response.type==='opaqueredirect'){location.assign('/login');return;}
   if(!response.ok)throw Error('Workbench read failed');
   const model=await response.json(),next=digest(model);
   if(stopped)return;
   if(next===fingerprint){status.textContent=status.dataset.updated;return;}
   // Preserve an action the user is focusing while the server projection changes.
   if(!force&&current()?.contains(document.activeElement)&&document.activeElement!==document.body)return;
   const page=await fetch('/workbench'+location.search,options);
   if(page.status===401||page.type==='opaqueredirect'){location.assign('/login');return;}
   if(!page.ok)throw Error('Workbench page unavailable');
   const parsed=new DOMParser().parseFromString(await page.text(),'text/html'),replacement=parsed.querySelector('[data-workbench-content]');
   if(!replacement||stopped)throw Error('Workbench content unavailable');
   if(!force&&current()?.contains(document.activeElement)&&document.activeElement!==document.body)return;
   current().replaceWith(replacement);fingerprint=next;status.textContent=status.dataset.updated;
  }catch(error){if(!stopped)status.textContent=status.dataset.failed;}
  finally{clearTimeout(deadline);if(pending===controller)pending=undefined;button.disabled=false;}
 }
 async function proposalId(deviceId,prompt){
  const account=document.querySelector('[data-wb-account]')?.dataset?.wbAccount??'';
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(account+'\0'+deviceId+'\0'+prompt)));
  const key='muse-task-proposal:'+Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
  let id;try{id=sessionStorage.getItem(key);}catch(error){/* Storage may be disabled; the form still retains its request ID. */}
  if(!id)id=crypto.randomUUID();
  try{sessionStorage.setItem(key,id);}catch(error){/* A storage policy cannot silently submit a second request in this page. */}
  return {id,key};
 }
 document.addEventListener('submit',event=>{
  const form=event.target;if(!form.matches?.('form[data-wb-action]'))return;
  event.preventDefault();if(activeAction)return;
  void (async()=>{
   activeAction=true;const fields=Object.fromEntries(new FormData(form));
   if(event.submitter?.name)fields[event.submitter.name]=event.submitter.value;
   const buttons=[...form.querySelectorAll('button')],disabled=buttons.map(button=>button.disabled);
   buttons.forEach(button=>{button.disabled=true;});
   const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),60000);let cacheKey;
   try{
    let path,body;
    if(form.dataset.wbAction==='proposal'){
     const request=await proposalId(fields.deviceId,fields.prompt);cacheKey=request.key;
     form.dataset.requestId??=request.id;path='/api/bot-team/proposals';body={requestId:form.dataset.requestId,deviceId:fields.deviceId,prompt:fields.prompt};
    }else if(form.dataset.wbAction==='decision'){
     path='/api/bot-team/decision';body={deviceId:fields.deviceId,taskId:fields.taskId,accept:fields.accept==='true',details:fields.details??''};
    }else if(form.dataset.wbAction==='production'){
     path='/api/production/decision';body={key:fields.key,revision:fields.revision,decision:fields.decision,details:fields.details??'',...fields.decision==='approve'?{deviceId:fields.deviceId}:{}};
    }else if(form.dataset.wbAction==='sync'){path='/api/production/sync';body={};}
    else throw Error('Unsupported action');
    const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'manual',signal:controller.signal});
    if(response.status===401||response.type==='opaqueredirect'){location.assign('/login');return;}
    if(response.status===403){notice(toast.dataset.forbidden);return;}
    if(response.status===409){notice(toast.dataset.conflict);return;}
    if(!response.ok)throw Error('Operation outcome unavailable');
    const result=await response.json();if(result.ok!==true)throw Error('Operation not confirmed');
    if(cacheKey)try{sessionStorage.removeItem(cacheKey);}catch(error){/* Keeping a confirmed id remains idempotent. */}
    form.reset();delete form.dataset.requestId;notice(toast.dataset.success);activeAction=false;await refresh(true);
   }catch(error){notice(toast.dataset.failed);}
   finally{clearTimeout(deadline);activeAction=false;buttons.forEach((button,index)=>{button.disabled=disabled[index];});}
  })();
 });
 document.addEventListener('click',event=>{if(event.target.closest?.('[data-wb-toast-close]')&&toast)toast.hidden=true;});
 button.addEventListener('click',()=>void refresh());
 const timer=setInterval(()=>void refresh(),15000);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
 window.addEventListener('pagehide',()=>{stopped=true;clearInterval(timer);pending?.abort();});
 window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
})();
