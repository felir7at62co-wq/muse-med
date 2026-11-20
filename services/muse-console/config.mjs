/** Validated console configuration read once at startup; any invalid value stops the process. */
import {isAbsolute} from 'node:path';
import {readFileSync} from 'node:fs';

const fail=message=>{throw Error('Invalid console configuration: '+message);};

function required(env,name){
 const value=env[name];
 if(typeof value!=='string'||!value.trim())fail(name+' is required');
 return value.trim();
}

function absolutePath(env,name){
 const value=required(env,name);
 if(!isAbsolute(value))fail(name+' must be an absolute path');
 return value;
}

function port(env,name){
 const value=Number(required(env,name));
 if(!Number.isInteger(value)||value<1024||value>65535)fail(name+' must be a port between 1024 and 65535');
 return value;
}

function loopbackOrigin(env,name){
 let url;
 try{url=new URL(required(env,name));}catch{fail(name+' must be a URL');}
 if(url.protocol!=='http:'||!['127.0.0.1','[::1]','localhost'].includes(url.hostname)||url.pathname!=='/'||url.search||url.hash||url.username)fail(name+' must be a plain http loopback origin');
 return url.origin;
}

/** Each watched unit: `{id, name, unit, release?}`; `release` is an absolute symlink whose target names the running version. */
function services(path){
 let list;
 try{list=JSON.parse(readFileSync(path,'utf8'));}catch{fail('MUSE_CONSOLE_SERVICES_FILE must be readable JSON');}
 if(!Array.isArray(list)||list.length>40)fail('services file must be an array of at most 40 entries');
 const ids=new Set();
 return Object.freeze(list.map(item=>{
  if(!item||typeof item!=='object')fail('service entries must be objects');
  const {id,name,unit,release}=item;
  if(typeof id!=='string'||!/^[a-z0-9-]{1,40}$/.test(id)||ids.has(id))fail('service id must be unique lowercase text');
  if(typeof name!=='string'||!name.trim()||name.length>40)fail('service '+id+' needs a name');
  if(typeof unit!=='string'||!/^[A-Za-z0-9@._-]{1,120}\.service$/.test(unit))fail('service '+id+' needs a systemd unit name');
  if(release!==undefined&&(typeof release!=='string'||!isAbsolute(release)))fail('service '+id+' release must be an absolute path');
  ids.add(id);
  return Object.freeze({id,name:name.trim(),unit,release:release??null});
 }));
}

/**
 * Read the console configuration from environment variables.
 * @param {Record<string,string|undefined>} env Process environment.
 * @returns {Readonly<object>} Port, paths, gateway origin, cookie name, base path, login path and watched services.
 */
export function loadConfig(env=process.env){
 const basePath=(env.MUSE_CONSOLE_BASE_PATH??'/console').trim();
 if(!/^\/[a-z0-9-]{1,40}$/.test(basePath))fail('MUSE_CONSOLE_BASE_PATH must look like /console');
 const cookieName=(env.MUSE_CONSOLE_COOKIE_NAME??'__Host-muse').trim();
 if(!/^[A-Za-z0-9_.-]{1,64}$/.test(cookieName))fail('MUSE_CONSOLE_COOKIE_NAME is invalid');
 const loginPath=(env.MUSE_CONSOLE_LOGIN_PATH??'/account').trim();
 if(!/^\/[A-Za-z0-9/_-]{0,80}$/.test(loginPath))fail('MUSE_CONSOLE_LOGIN_PATH must be a site path');
 return Object.freeze({
  port:port(env,'MUSE_CONSOLE_PORT'),
  basePath,
  cookieName,
  loginPath,
  gatewayOrigin:loopbackOrigin(env,'MUSE_CONSOLE_GATEWAY_ORIGIN'),
  exportDb:absolutePath(env,'MUSE_CONSOLE_EXPORT_DB'),
  pricesFile:absolutePath(env,'MUSE_CONSOLE_PRICES_FILE'),
  services:services(absolutePath(env,'MUSE_CONSOLE_SERVICES_FILE')),
 });
}
