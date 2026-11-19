/** Build reviewable profile overlays from explicitly recognized local production sources. */
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {copyFile,lstat,mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execute=promisify(execFile),home=dirname(fileURLToPath(import.meta.url));
const digest=value=>createHash('sha256').update(value).digest('hex');
const owns=(parent,path)=>{const child=relative(parent,path);return child===''||child!=='..'&&!child.startsWith('..'+sep)&&!isAbsolute(child);};
const filenames=definition=>[...Object.keys(definition.patchedFiles),...Object.keys(definition.modules)];

async function regularBytes(file,optional=false){
 try{if(!(await lstat(file)).isFile())throw Error('Expected a regular source file: '+basename(file));return await readFile(file);}
 catch(error){if(optional&&error.code==='ENOENT')return;throw error;}
}

async function hashes(source,definition){
 return Object.fromEntries(await Promise.all(filenames(definition).map(async name=>[name,await regularBytes(join(source,name),true).then(value=>value===undefined?null:digest(value))])));
}

async function targets(definition,moduleRoot){
 const values=Object.fromEntries(Object.entries(definition.patchedFiles).map(([name,item])=>[name,item.after]));
 for(const name of Object.keys(definition.modules))values[name]=digest(await regularBytes(join(moduleRoot,name)));
 return values;
}

function knownSource(actual,definition,target){
 const patched=Object.entries(definition.patchedFiles),modules=Object.entries(definition.modules);
 if(filenames(definition).every(name=>actual[name]===target[name]))return 'current-overlay';
 if(patched.every(([name,item])=>actual[name]===item.after)&&modules.every(([name,hash])=>actual[name]===hash))return definition.verifiedRelease;
 if(patched.every(([name,item])=>actual[name]===item.before)&&modules.every(([name])=>actual[name]===null))return definition.baseRelease;
 throw Error('Unsupported source: profile overlay hashes do not match a supported baseline');
}

/** Verify only the five overlay-owned files without reading credentials or changing a release.
 * @param {object} options Local source directory, pinned baseline definition, and current profile module directory.
 * @returns {Promise<object>} Recognized baseline and whether the current overlay is already present.
 */
export async function inspectProfileOverlay({source,definition,moduleRoot}){
 const actual=await hashes(source,definition),target=await targets(definition,moduleRoot);
 const baseline=knownSource(actual,definition,target);
 return {baseline,alreadyCurrent:baseline==='current-overlay',files:actual,target};
}

/** Build five overlay files into a new local directory, preserving the supplied release.
 * @param {object} options Explicit source/output directories, fixed definition, patch directory, and current module directory.
 * @returns {Promise<object>} Deterministic candidate manifest; unknown source hashes and existing output paths refuse.
 */
export async function buildProfileOverlay({source,output,definition,patchRoot,moduleRoot}){
 source=resolve(source);output=resolve(output);
 if(owns(source,output)||owns(output,source))throw Error('Source and output directories must be separate');
 const verified=await inspectProfileOverlay({source,definition,moduleRoot});
 const temporary=await mkdtemp(join(tmpdir(),'muse-profile-overlay-'));let created=false;
 try{
  for(const name of Object.keys(definition.patchedFiles))await copyFile(join(source,name),join(temporary,name));
  if(verified.baseline===definition.baseRelease){
   for(const item of Object.values(definition.patchedFiles)){
    const patch=join(patchRoot,item.patch);
    await execute('git',['-c','core.autocrlf=false','apply','--check','-p1',patch],{cwd:temporary});
    await execute('git',['-c','core.autocrlf=false','apply','-p1',patch],{cwd:temporary});
   }
  }
  for(const name of Object.keys(definition.modules))await copyFile(join(moduleRoot,name),join(temporary,name));
  const built=await hashes(temporary,definition);
  if(filenames(definition).some(name=>built[name]!==verified.target[name]))throw Error('Candidate hashes differ from the declared profile overlay');
  const after=await hashes(source,definition);
  if(filenames(definition).some(name=>after[name]!==verified.files[name]))throw Error('Source changed while building the profile overlay');
  for(const name of filenames(definition))await execute(process.execPath,['--check',join(temporary,name)]);
  const manifest={version:1,base:verified.baseline,scope:'five-file-profile-overlay',files:built};
  await mkdir(dirname(output),{recursive:true});await mkdir(output);created=true;
  for(const name of filenames(definition))await copyFile(join(temporary,name),join(output,name),constants.COPYFILE_EXCL);
  await writeFile(join(output,'profile-overlay.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return manifest;
 }catch(error){if(created)await rm(output,{recursive:true,force:true});throw error;}
 finally{await rm(temporary,{recursive:true,force:true});}
}

/** Validate a candidate and run isolated profile/group behavior checks without booting a production gateway.
 * @param {object} options Candidate directory and fixed definition/current module directory.
 * @returns {Promise<void>} Completion after hash, syntax and synthetic behavior checks pass.
 */
export async function preflightProfileOverlay({candidate,definition,moduleRoot}){
 const verified=await inspectProfileOverlay({source:candidate,definition,moduleRoot});
 if(!verified.alreadyCurrent)throw Error('Candidate does not contain the current profile overlay');
 for(const name of filenames(definition))await execute(process.execPath,['--check',join(candidate,name)]);
 await execute(process.execPath,['--test',join(home,'profile-candidate.test.mjs')],{
  env:{...process.env,MUSE_PROFILE_CANDIDATE:resolve(candidate)},maxBuffer:1024*1024,
 });
}

async function main(args){
 const [command,...rest]=args,values=new Map();
 for(let index=0;index<rest.length;index+=2){
  const key=rest[index],value=rest[index+1];
  if(!['--source','--output','--candidate'].includes(key)||value===undefined||values.has(key))throw Error('Expected explicit --source/--output or --candidate paths');
  values.set(key,resolve(value));
 }
 const definition=JSON.parse(await readFile(join(home,'baselines.json'),'utf8')),moduleRoot=resolve(home,'..');
 if(command==='verify'&&values.size===1&&values.has('--source'))return await inspectProfileOverlay({source:values.get('--source'),definition,moduleRoot});
 if(command==='build'&&values.size===2&&values.has('--source')&&values.has('--output'))return await buildProfileOverlay({source:values.get('--source'),output:values.get('--output'),definition,moduleRoot,patchRoot:join(home,'patches')});
 if(command==='preflight'&&values.size===1&&values.has('--candidate')){await preflightProfileOverlay({candidate:values.get('--candidate'),definition,moduleRoot});return {preflight:'passed'};}
 throw Error('Use verify --source, build --source --output, or preflight --candidate');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{console.log(JSON.stringify(await main(process.argv.slice(2)),null,2));}
 catch(error){console.error(error.code==='ENOENT'?'Profile overlay input is unavailable':error.message);process.exitCode=1;}
}
