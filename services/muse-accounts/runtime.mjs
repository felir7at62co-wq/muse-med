import http from 'node:http';
export function createRuntime(){
  const pending=new Map(),cache=new Map();
  function call(action,id){return new Promise((resolve,reject)=>{
    if(!/^[a-f0-9]{16}$/.test(id)){reject(Error('Invalid account'));return;}
    const req=http.request({socketPath:process.env.MUSE_RUNTIME_SOCKET??'/run/muse-runtime/broker.sock',path:`/${action}?id=${id}`,method:'POST',timeout:60000},res=>{
      let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);
      res.on('end',()=>{try{const result=JSON.parse(body);if(res.statusCode!==200)reject(Error(result.error||'工作间暂不可用'));else resolve(result);}catch{reject(Error('工作间服务异常'));}});
    });
    req.on('timeout',()=>req.destroy(Error('工作间启动超时')));req.on('error',reject);req.end();
  });}
  return {ensure:async id=>{const cached=cache.get(id);if(cached&&cached.until>Date.now())return cached.value;if(pending.has(id))return pending.get(id);const task=call('ensure',id).then(value=>{cache.set(id,{value,until:Date.now()+5000});return value;}).finally(()=>pending.delete(id));pending.set(id,task);return task;},touch:id=>call('touch',id).catch(()=>{}),stop:async id=>{cache.delete(id);return call('stop',id);}};
}
