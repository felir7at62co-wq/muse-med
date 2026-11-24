import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm,link,symlink,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createCompanyCliDownloads} from './company-cli-downloads.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function setup(t){
 const root=await mkdtemp(join(tmpdir(),'muse-download-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config={root:join(root,'private'),maxBytes:2048,chunkBytes:7,maxResponseBytes:8192},downloads=createCompanyCliDownloads(config);
 return {root,config,downloads};
}

test('completed files have opaque stable identities and verified chunks after reopening',async t=>{
 const f=await setup(t),directory=await f.downloads.allocate('job-a'),source=join(directory,'高清 video.mp4'),bytes=Buffer.from('ftypisom-fixture-download-contents');
 await writeFile(source,bytes);
 const files=await f.downloads.capture('job-a',{records:[{local_file:source}],kind:'video'}),file=files[0];
 assert.equal(file.bytes,bytes.length);assert.equal(file.sha256,hash(bytes));assert.match(file.fileId,/^[a-z0-9-]+$/u);assert.match(file.name,/^1-[a-f0-9]{12}\.mp4$/u);
 assert.equal(JSON.stringify(files).includes(directory),false);assert.equal(JSON.stringify(files).includes('local_file'),false);
 assert.deepEqual((await readdir(directory)).sort(),[file.fileId+'.bin',file.fileId+'.json'].sort());
 const reopened=createCompanyCliDownloads(f.config),chunks=[];
 for(let index=0;index<file.chunkCount;index++){
  const chunk=await reopened.readChunk('job-a',file,index),value=Buffer.from(chunk.data_base64,'base64');
  assert.equal(chunk.fileId,file.fileId);assert.equal(chunk.index,index);assert.equal(chunk.bytes,value.length);assert.equal(chunk.sha256,hash(value));assert.ok(Buffer.byteLength(JSON.stringify(chunk))<f.config.maxResponseBytes);chunks.push(value);
 }
 assert.deepEqual(Buffer.concat(chunks),bytes);
});

test('outside paths, relative paths, multiple files and unsupported media are refused',async t=>{
 const f=await setup(t),directory=await f.downloads.allocate('job-a'),outside=join(f.root,'outside.mp4');await writeFile(outside,'ftypisom');
 await assert.rejects(f.downloads.capture('job-a',{records:[{local_file:outside}],kind:'video'}),{code:'company_cli_download_unsafe_path'});
 await assert.rejects(f.downloads.capture('job-a',{records:[{local_file:'relative.mp4'}],kind:'video'}),{code:'company_cli_download_unsafe_path'});
 await assert.rejects(f.downloads.capture('job-a',{records:[{local_file:outside},{local_file:outside}],kind:'video'}),{code:'company_cli_download_unsupported_output'});
 const archive=join(directory,'all.zip');await writeFile(archive,'pkzip');
 await assert.rejects(f.downloads.capture('job-a',{records:[{local_file:archive}],kind:'video'}),{code:'company_cli_download_unsupported_output'});
 assert.equal(await readFile(outside,'utf8'),'ftypisom');
});

test('per-request byte ceilings reject oversized data before publishing a file',async t=>{
 const f=await setup(t),directory=await f.downloads.allocate('job-a'),source=join(directory,'video.mp4');await writeFile(source,Buffer.alloc(100));
 await assert.rejects(f.downloads.capture('job-a',{records:[{local_file:source}],kind:'video',maxBytes:99}),{code:'company_cli_download_size_limit'});
 assert.deepEqual(await readdir(directory),['video.mp4']);
 await assert.rejects(f.downloads.capture('job-a',{records:[{local_file:source}],kind:'video',maxBytes:4096}),{code:'company_cli_download_unsupported_output'});
});

test('hard links cannot publish files outside their original ownership',async t=>{
 const f=await setup(t),directory=await f.downloads.allocate('job-a'),outside=join(f.root,'outside.mp4'),source=join(directory,'video.mp4');await writeFile(outside,'ftypisom');await link(outside,source);
 await assert.rejects(f.downloads.capture('job-a',{records:[{local_file:source}],kind:'video'}),{code:'company_cli_download_integrity_error'});
 assert.equal(await readFile(outside,'utf8'),'ftypisom');
});

test('symbolic link output cannot publish an outside file',async t=>{
 const f=await setup(t),directory=await f.downloads.allocate('job-a'),outside=join(f.root,'outside.mp4'),source=join(directory,'video.mp4');await writeFile(outside,'ftypisom');
 try{await symlink(outside,source,'file');}catch(error){if(process.platform==='win32'&&error.code==='EPERM'){t.skip('Creating file symlinks requires Windows developer mode or privilege.');return;}throw error;}
 await assert.rejects(f.downloads.capture('job-a',{records:[{local_file:source}],kind:'video'}),{code:'company_cli_download_unsafe_path'});
});

test('changed data and changed chunk evidence refuse retrieval without rewriting the manifest',async t=>{
 const f=await setup(t),directory=await f.downloads.allocate('job-a'),source=join(directory,'video.mp4');await writeFile(source,'ftypisom-fixture');
 const [file]=await f.downloads.capture('job-a',{records:[{local_file:source}],kind:'video'}),manifest=JSON.stringify(file);
 const target=join(directory,file.fileId+'.bin'),original=await readFile(target);await writeFile(target,Buffer.alloc(file.bytes,1));
 await assert.rejects(f.downloads.readChunk('job-a',file,0),{code:'company_cli_download_integrity_error'});
 await writeFile(target,original);const sidecar=join(directory,file.fileId+'.json');await writeFile(sidecar,'{}');
 await assert.rejects(f.downloads.readChunk('job-a',file,0),{code:'company_cli_download_integrity_error'});
 assert.equal(JSON.stringify(file),manifest);
});

test('unknown files and invalid chunk identifiers cannot escape a job directory',async t=>{
 const f=await setup(t),directory=await f.downloads.allocate('job-a'),source=join(directory,'video.mp4');await writeFile(source,'ftypisom-fixture');
 const [file]=await f.downloads.capture('job-a',{records:[{local_file:source}],kind:'video'});
 await assert.rejects(f.downloads.readChunk('../job-a',file,0),{code:'company_cli_download_invalid_identifier'});
 await assert.rejects(f.downloads.readChunk('job-a',{...file,fileId:'../file'},0),{code:'company_cli_download_invalid_chunk'});
 await assert.rejects(f.downloads.readChunk('job-a',file,file.chunkCount),{code:'company_cli_download_invalid_chunk'});
 await unlink(join(directory,file.fileId+'.bin'));
 await assert.rejects(f.downloads.readChunk('job-a',file,0),{code:'company_cli_download_unavailable'});
});

test('cleanup removes only the checked job and allocation never reuses an existing directory',async t=>{
 const f=await setup(t),first=await f.downloads.allocate('job-a'),second=await f.downloads.allocate('job-b');await writeFile(join(second,'keep'),'preserved');
 await assert.rejects(f.downloads.allocate('job-a'),{code:'company_cli_download_directory_exists'});
 await f.downloads.discard('job-a');assert.equal(await readFile(join(second,'keep'),'utf8'),'preserved');
 await assert.rejects(readFile(join(first,'anything')),{code:'ENOENT'});await f.downloads.discard('job-a');
 assert.throws(()=>createCompanyCliDownloads({...f.config,chunkBytes:8192}),{code:'company_cli_download_invalid_configuration'});
});
