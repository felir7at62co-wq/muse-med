/** Running state and version of the watched systemd services, read without privileges. */
import {execFile} from 'node:child_process';
import {readlink} from 'node:fs/promises';
import {basename} from 'node:path';

function systemctlShow(unit,run){
 return new Promise(resolve=>{
  run('systemctl',['show',unit,'--property=ActiveState,SubState,ActiveEnterTimestamp,NRestarts','--no-pager'],{timeout:5000},(error,stdout)=>{
   if(error){resolve(null);return;}
   resolve(Object.fromEntries(String(stdout).split('\n').filter(Boolean).map(line=>{const index=line.indexOf('=');return [line.slice(0,index),line.slice(index+1)];})));
  });
 });
}

/**
 * Read state and version for each configured service.
 * @param {ReadonlyArray<{id:string,name:string,unit:string,release:string|null}>} services Watched services from the configuration.
 * @param {{run?:typeof execFile,link?:typeof readlink}} [seams] Test seams.
 * @returns {Promise<Array<{id:string,name:string,state:string,since:string|null,restarts:number|null,version:string|null}>>} One entry per service; `state` is `unknown` when systemd could not be asked.
 */
export async function serviceStates(services,{run=execFile,link=readlink}={}){
 return Promise.all(services.map(async service=>{
  const shown=await systemctlShow(service.unit,run);
  let version=null;
  if(service.release){try{version=basename(await link(service.release));}catch{version=null;}}
  return {
   id:service.id,name:service.name,
   state:shown?.ActiveState==='active'?(shown.SubState==='running'?'running':shown.SubState||'active'):shown?.ActiveState||'unknown',
   since:shown?.ActiveEnterTimestamp||null,
   restarts:shown?.NRestarts===undefined?null:Number(shown.NRestarts),
   version,
  };
 }));
}
