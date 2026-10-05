/** Poll account-owned devices; an offline selection reconnects only to that installation. */
(() => {
 const list=document.getElementById('computer-list'),status=document.getElementById('computer-status');
 const selected=list.dataset.selected;
 const platforms={win32:'Windows',darwin:'macOS',linux:'Linux',unknown:'电脑'};
 let pending,timer,stopped=false;
 function render(devices){
  const fragment=document.createDocumentFragment();
  for(const device of devices){
   const row=document.createElement('li');row.className='computer';
   const detail=document.createElement('div'),name=document.createElement('span'),meta=document.createElement('span');
   name.className='computer-name';name.textContent=device.name;
   meta.className='computer-meta';meta.textContent=platforms[device.platform]+' · '+(device.state==='online'?'在线':'离线');
   detail.append(name,meta);
   if(device.lastSeenAt!==null){const seen=document.createElement('span');seen.className='computer-meta';seen.textContent='最近连接：'+new Date(device.lastSeenAt).toLocaleString();detail.append(seen);}
   const action=document.createElement(device.state==='online'?'a':'button');
   if(device.state==='online'){action.className='computer-open';action.href='/desktop/'+device.id+'/';action.textContent='进入';}
   else {action.type='button';action.disabled=true;action.textContent='离线';}
   row.append(detail,action);fragment.append(row);
  }
  // Keep the focused action while an unchanged list is refreshed.
  const fingerprint=JSON.stringify(devices);
  if(list.dataset.fingerprint!==fingerprint){list.replaceChildren(fragment);list.dataset.fingerprint=fingerprint;}
 }
 async function check(){
  if(pending||stopped||document.hidden)return;
  const controller=new AbortController();pending=controller;
  const deadline=setTimeout(()=>controller.abort(),10000);
  try{
   const response=await fetch('/api/desktop/devices',{cache:'no-store',redirect:'manual',signal:controller.signal});
   if(stopped)return;
   if(response.type==='opaqueredirect'||response.status===401||(response.status>=300&&response.status<400)){location.assign('/login');return;}
   if(!response.ok)throw Error('Computer list unavailable');
   const {devices}=await response.json();
   if(stopped)return;
   if(selected&&devices.some(d=>d.id===selected&&d.state==='online')){location.assign('/desktop/'+selected+'/');return;}
   if(location.pathname==='/'&&!selected&&devices.filter(d=>d.state==='online').length===1){location.assign('/desktop/'+devices.find(d=>d.state==='online').id+'/');return;}
   render(devices);status.textContent=devices.some(d=>d.state==='online')?'点击“进入”打开对应电脑':'正在等待您的电脑上线…';
  }catch(error){if(!stopped)status.textContent='暂时无法更新电脑列表，请重试';}
  finally{clearTimeout(deadline);if(pending===controller)pending=undefined;}
 }
 function start(){stopped=false;clearInterval(timer);timer=setInterval(()=>void check(),5000);void check();}
 document.getElementById('retry-computers').addEventListener('click',()=>void check());
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)void check();});
 window.addEventListener('pagehide',()=>{stopped=true;clearInterval(timer);pending?.abort();});
 window.addEventListener('pageshow',event=>{if(event.persisted)start();});start();
})();
