/** Read pinned upstream test sources from a release fixture or the local Git checkout. */
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {isAbsolute,relative,resolve,sep} from 'node:path';

/** Upstream revision used by every compatibility test fixture. */
export const PINNED_SOURCE_REVISION='3fbcda9713ca545979dff9e75d21bed53694188f';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validName=value=>typeof value==='string'&&value.length>0&&!value.includes('\\')&&!value.includes(':')&&!value.includes('\0')&&value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..');

/**
 * Return a cached source reader; an explicitly supplied fixture never falls back to Git.
 * @param root Absolute or relative companion checkout used to interpret requested source paths.
 * @param options Optional absolute release-fixture filename; defaults to MUSE_TEST_PRISTINE_SOURCE.
 * @returns A reader for files within root, normalized to LF for pinned patch comparisons.
 */
export function createPinnedSourceReader(root,{fixturePath=process.env.MUSE_TEST_PRISTINE_SOURCE}={}){
 root=resolve(root);let fixture;
 if(fixturePath!==undefined){
  if(typeof fixturePath!=='string'||!isAbsolute(fixturePath))throw Error('Pinned source fixture must be an absolute filename');
  const parsed=JSON.parse(readFileSync(fixturePath,'utf8'));
  if(!object(parsed)||parsed.revision!==PINNED_SOURCE_REVISION||!object(parsed.files)||Object.keys(parsed.files).length===0)throw Error('Pinned source fixture revision or files are invalid');
  for(const[name,source]of Object.entries(parsed.files))if(!validName(name)||typeof source!=='string')throw Error('Pinned source fixture contains an invalid file');
  fixture=parsed.files;
 }
 const cache=new Map();
 return path=>{
  const name=relative(root,resolve(path)).split(sep).join('/');
  if(!isAbsolute(path)||!validName(name))throw Error('Pinned source request must stay within the companion checkout');
  if(!cache.has(name)){
   if(fixture&&!Object.hasOwn(fixture,name))throw Error('Pinned source fixture is missing '+name);
   const source=fixture?fixture[name]:execFileSync('git',['-C',root,'show',PINNED_SOURCE_REVISION+':'+name],{encoding:'utf8',maxBuffer:3e6});
   cache.set(name,source.replaceAll('\r\n','\n'));
  }
  return cache.get(name);
 };
}
