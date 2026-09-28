// Feedback is user-authored data. Render text only, never HTML or Markdown.
const $=selector=>document.querySelector(selector),admin=document.body.dataset.admin==='true';
const statusNames={new:'待查看',reviewing:'处理中',planned:'已排期',resolved:'已解决',closed:'已关闭'},categoryNames={bug:'问题反馈',suggestion:'功能建议',other:'其他意见'};
let offset=0,loading=false,generation=0;
function el(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
async function api(path,options={}){const response=await fetch(path,{credentials:'same-origin',...options,headers:{'content-type':'application/json',...options.headers}});if(response.redirected||response.status===401)throw Error('登录已过期，请返回工作间重新登录');const body=await response.json().catch(()=>({error:'服务暂时不可用，请稍后重试'}));if(!response.ok)throw Error(body.error||'请求失败');return body;}
function note(node,message,error=false){node.textContent=message;node.className=error?'error':'success';}
function render(item){
 const card=el('article',undefined,'feedback-item'),top=el('div',undefined,'item-top'),badge=el('span',statusNames[item.status],'badge');badge.dataset.status=item.status;top.append(el('span',categoryNames[item.category],'category'),badge);card.append(top,el('h3',item.title),el('p',item.body,'item-body'));
 if(item.attachments.length){const images=el('div',undefined,'screenshots');item.attachments.forEach((shot,index)=>{const link=el('a'),img=el('img');link.href='/api/muse.feedback/'+item.id+'/attachments/'+index;link.target='_blank';link.rel='noopener';img.src=link.href;img.alt=shot.name;img.loading='lazy';link.append(img,el('span','下载截图 '+(index+1)));images.append(link);});card.append(images);}
 card.append(el('p',(admin?item.username+' · ':'')+new Date(item.createdAt).toLocaleString('zh-CN'),'meta'));
 if(item.reply){const reply=el('div',undefined,'response');reply.append(el('strong','管理员回复'),el('span',item.reply));card.append(reply);}
 if(admin){const details=el('details',undefined,'admin-editor');details.append(el('summary','处理这条意见'));const form=el('form'),select=el('select'),reply=el('textarea'),message=el('p'),button=el('button','保存处理结果');for(const [value,label]of Object.entries(statusNames)){const option=el('option',label);option.value=value;select.append(option);}select.value=item.status;reply.value=item.reply;reply.maxLength=2000;reply.rows=3;const stateLabel=el('label','处理状态'),replyLabel=el('label','回复用户');stateLabel.append(select);replyLabel.append(reply);form.append(stateLabel,replyLabel,button,message);
 form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;try{await api('/api/muse.feedback/'+item.id,{method:'PATCH',body:JSON.stringify({revision:item.revision,status:select.value,reply:reply.value})});await load(true);}catch(error){note(message,error.message,true);}finally{button.disabled=false;}});details.append(form);card.append(details);}
 return card;
}
async function load(reset=false){
 if(loading&&!reset)return;const mine=++generation;loading=true;$('#more').disabled=true;if(reset){offset=0;$('#feedback-list').replaceChildren();}const start=offset;note($('#list-status'),'加载中…');
 try{const data=await api('/api/muse.feedback?offset='+start+'&status='+encodeURIComponent($('#status-filter').value));if(mine!==generation)return;for(const item of data.items)$('#feedback-list').append(render(item));offset=start+data.items.length;$('#more').hidden=offset>=data.total;note($('#list-status'),data.total?'共 '+data.total+' 条意见':'');if(!data.total){const empty=el('div',undefined,'empty');empty.append(el('div','还没有意见'),el('p','写下你的第一条反馈，让 MUSE 更懂你的工作。'));$('#feedback-list').append(empty);}}
 catch(error){if(mine===generation)note($('#list-status'),error.message,true);}finally{if(mine===generation){loading=false;$('#more').disabled=false;}}
}
$('#feedback-form').addEventListener('submit',async event=>{
 event.preventDefault();const button=$('#submit');button.disabled=true;note($('#form-status'),'正在提交…');
 try{const files=[...$('#attachments').files];if(files.length>3)throw Error('最多上传 3 张截图');const attachments=[];for(const file of files){if(file.size>2*1024*1024)throw Error('每张截图最多 2 MB');const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(Error('截图读取失败'));reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(file);});attachments.push({name:file.name,data});}
 await api('/api/muse.feedback',{method:'POST',body:JSON.stringify({title:$('#title').value,category:$('#category').value,body:$('#body').value,attachments})});event.target.reset();note($('#form-status'),'意见已提交，感谢你的反馈。');$('#status-filter').value='';await load(true);
 }catch(error){note($('#form-status'),error.message,true);}finally{button.disabled=false;}
});
$('#refresh').addEventListener('click',()=>load(true));$('#status-filter').addEventListener('change',()=>load(true));$('#more').addEventListener('click',()=>load());void load(true);
