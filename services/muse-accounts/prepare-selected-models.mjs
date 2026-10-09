/** Offline preparation of private shared-model configuration; this CLI never deploys it. */
import {constants} from 'node:fs';
import {open,lstat,realpath,link,unlink} from 'node:fs/promises';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {prepareSelectedModels} from './selected-models.mjs';

const options = new Set(['source','output','deepseek-key-file','yunying-key-file','zhipu-key-file','yunying-base-url']);
const distributionDirectory=/^(?:\.artifacts|artifacts|build|dist|downloads|node_modules|out|public|publish|release|releases|win-unpacked|mac(?:-arm64)?|.*\.app)$/i;

async function candidateDirectory(path){
 const parent=dirname(path),stat=await lstat(parent);
 if(!stat.isDirectory()||stat.isSymbolicLink()||process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.getuid()))throw Error('Candidate parent directory must be owner-only');
 const physical=await realpath(parent),repository=await realpath(fileURLToPath(new URL('../../',import.meta.url)));
 const inside=relative(repository,physical);
 if(inside===''||!inside.startsWith('..'+sep)&&inside!=='..'&&!isAbsolute(inside)
  ||physical.split(/[\\/]/).some(part=>distributionDirectory.test(part)))throw Error('Private candidates must stay outside repositories and distribution directories');
 for(let directory=physical;;directory=dirname(directory)){
  try{await lstat(resolve(directory,'.git'));throw Error('Private candidates must stay outside repositories');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(dirname(directory)===directory)break;
 }
}

async function refuseExistingOutput(path){
 try{await lstat(path);throw Error('Candidate or backup already exists');}
 catch(error){if(error.code!=='ENOENT')throw error;}
}

/** Read an owner-only regular file without following a final-path symbolic link.
 * @param {string} path Absolute configuration or credential path.
 * @returns {Promise<string>} File text bounded to eight MiB.
 * @throws {Error} The file is linked, non-private, too large, or unavailable.
 */
export async function readPrivateModelFile(path){
 if(!isAbsolute(path))throw Error('Private model paths must be absolute');
 const before=await lstat(path);
 if(!before.isFile()||before.isSymbolicLink())throw Error('Private model input must be a regular file');
 const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const stat=await file.stat();
  if(!stat.isFile()||stat.dev!==before.dev||stat.ino!==before.ino||stat.size>8*1024*1024
   ||process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.getuid()))throw Error('Private model input must be owner-only and no larger than eight MiB');
  const bytes=await file.readFile();
  if(bytes.length>8*1024*1024)throw Error('Private model input grew beyond eight MiB');
  const text=bytes.toString('utf8');
  if(!Buffer.from(text,'utf8').equals(bytes))throw Error('Private model input must be UTF-8');
  return text;
 }finally{await file.close();}
}

async function publishNewPrivateFile(path,text){
 const temporary=path+'.'+randomBytes(8).toString('hex')+'.tmp';
 const file=await open(temporary,'wx',0o600);
 try{
  try{await file.writeFile(text,'utf8');await file.sync();}finally{await file.close();}
  await link(temporary,path);
 }finally{await unlink(temporary);}
}

/** Produce an exclusive candidate and an exact private source backup without changing the source.
 * @param {string[]} args CLI options whose values are paths or a public API root, never keys.
 * @param {object} environment Optional operator-process credentials; never included in the receipt.
 * @returns {Promise<object>} Public preparation receipt without credentials or upstream addresses.
 * @throws {Error} Options or private inputs are invalid, or an output already exists.
 */
export async function prepareSelectedModelsFiles(args,environment=process.env){
 const parsed={};
 for(let i=0;i<args.length;i+=2){
  const key=args[i]?.startsWith('--')?args[i].slice(2):'';
  if(!options.has(key)||Object.hasOwn(parsed,key)||typeof args[i+1]!=='string'||args[i+1].startsWith('--'))throw Error('Invalid selected-model preparation options');
  parsed[key]=args[i+1];
 }
 if(!parsed.source||!parsed.output||!isAbsolute(parsed.output))throw Error('Absolute source and output paths are required');
 const source=resolve(parsed.source),output=resolve(parsed.output),backup=output+'.source-backup';
 if(source===output||source===backup)throw Error('Candidate and backup must be separate from the source');
 await candidateDirectory(output);
 await refuseExistingOutput(output);await refuseExistingOutput(backup);
 const original=await readPrivateModelFile(parsed.source);
 const deepseekKey=parsed['deepseek-key-file']?(await readPrivateModelFile(parsed['deepseek-key-file'])).trim():environment.DEEPSEEK_API_KEY;
 const yunyingKey=parsed['yunying-key-file']?(await readPrivateModelFile(parsed['yunying-key-file'])).trim():environment.MUSE_YUNYING_API_KEY;
 const zhipuKey=parsed['zhipu-key-file']?(await readPrivateModelFile(parsed['zhipu-key-file'])).trim():environment.MUSE_ZHIPU_API_KEY;
 let current;
 try{current=JSON.parse(original);}catch(_error){throw Error('Private model input must contain valid JSON');}
 const prepared=prepareSelectedModels(current,{deepseekKey,yunyingKey,zhipuKey,yunyingBaseURL:parsed['yunying-base-url']});
 const candidate=JSON.stringify(prepared,null,2)+'\n';
 await publishNewPrivateFile(backup,original);
 await publishNewPrivateFile(output,candidate);
 return {prepared:true,deployed:false,revision:prepared.revision,metadataRevision:prepared.metadataRevision,
  sourceSha256:createHash('sha256').update(original).digest('hex'),candidateSha256:createHash('sha256').update(candidate).digest('hex'),
  default:{provider:'deepseek-official',model:'deepseek-flash'},
  providers:Object.entries(prepared.providers).map(([id,provider])=>({id,models:provider.models.map(model=>model.id)}))};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 prepareSelectedModelsFiles(process.argv.slice(2)).then(receipt=>console.log(JSON.stringify(receipt)),()=>{
  console.error(JSON.stringify({prepared:false,deployed:false,code:'selected_model_preparation_failed'}));process.exitCode=1;
 });
}
