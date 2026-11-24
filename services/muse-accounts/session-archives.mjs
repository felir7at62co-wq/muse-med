/** Account-private, immutable archives of committed desktop Session prefixes. */
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {link,lstat,mkdir,open,readdir,realpath,rm} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';

const accountPattern=/^[a-f0-9]{16}$/,devicePattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sessionPattern=/^[A-Za-z0-9_-]{1,128}$/,digestPattern=/^[a-f0-9]{64}$/;
const mediaPattern=/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const keys=(value,allowed,required=[])=>object(value)&&Object.keys(value).every(key=>allowed.includes(key))&&required.every(key=>Object.hasOwn(value,key));
const headerKeys=['version','id','createdAt','cwd','parentSession','isSeeded','origin','delegationDepth','agentPreset'];
const eventKeys=['type','seq','time','data','ignorable','surfaceOp','sourceEventSeqs'];
const receiptKeys=['version','deviceId','sessionId','digest','parentDigest','eventCount','storedAt','header','attachments'];
// Two recent validations bound retained transcript bytes; eviction changes only the next read's I/O.
const VALIDATION_MEMO_SESSIONS=2;

/** Stable archive failures never include transcript, filesystem paths or credentials. */
export class ArchiveError extends Error{
 /** @param {string} code Public machine code. @param {number} status HTTP status. @param {object} options Optional cause. */
 constructor(code,status,options={}){super(`Muse session archive: ${code}`,options);this.name='ArchiveError';this.code=code;this.status=status;}
}
const invalid=()=>new ArchiveError('invalid_archive',400);
const conflict=()=>new ArchiveError('archive_conflict',409);
const missing=()=>new ArchiveError('archive_not_found',404);
const oversized=()=>new ArchiveError('archive_too_large',413);
const quotaExceeded=()=>new ArchiveError('archive_quota_exceeded',413);
const unavailable=error=>error instanceof ArchiveError?error:new ArchiveError('archive_unavailable',503,{cause:error});

function identity(accountId,deviceId,sessionId){
 if(typeof accountId!=='string'||!accountPattern.test(accountId)
  ||deviceId!==undefined&&(typeof deviceId!=='string'||!devicePattern.test(deviceId))
  ||sessionId!==undefined&&(typeof sessionId!=='string'||!sessionPattern.test(sessionId)))throw invalid();
}
function digestId(digest){if(typeof digest!=='string'||!digestPattern.test(digest))throw invalid();return digest;}
function positive(value){if(!Number.isSafeInteger(value)||value<1)throw new Error('Invalid Muse archive limit');return value;}
function validHeader(header,sessionId){
 return keys(header,headerKeys,['version','id','createdAt','isSeeded'])&&integer(header.version)&&header.id===sessionId
  &&integer(header.createdAt)&&typeof header.isSeeded==='boolean'
  &&(header.cwd===undefined||typeof header.cwd==='string'&&header.cwd.length<=32768)
  &&(header.parentSession===undefined||typeof header.parentSession==='string'&&sessionPattern.test(header.parentSession))
  &&(header.origin===undefined||header.origin==='subagent')
  &&(header.delegationDepth===undefined||integer(header.delegationDepth))
  &&(header.agentPreset===undefined||typeof header.agentPreset==='string'&&header.agentPreset.length<=1024);
}
function validEvent(event,seq){
 return keys(event,eventKeys,['type','seq','time','data'])&&typeof event.type==='string'&&event.type.length>0&&event.type.length<=256
  &&event.seq===seq&&integer(event.time)&&(event.ignorable===undefined||event.ignorable===true)
  &&(event.sourceEventSeqs===undefined||Array.isArray(event.sourceEventSeqs)&&event.sourceEventSeqs.every(value=>integer(value)&&value<seq));
}
function validAttachment(attachment,limits){
 return keys(attachment,['sha256','sizeBytes','mediaType'],['sha256','sizeBytes','mediaType'])
  &&typeof attachment.sha256==='string'&&digestPattern.test(attachment.sha256)&&integer(attachment.sizeBytes)&&attachment.sizeBytes<=limits.maxAttachmentBytes
  &&typeof attachment.mediaType==='string'&&attachment.mediaType.length<=127&&mediaPattern.test(attachment.mediaType);
}
function validateArchive(bytes,sessionId,limits){
 if(bytes.length>limits.maxRevisionBytes)throw oversized();
 let text,archive;
 try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);archive=JSON.parse(text);}catch(error){throw invalid();}
 const values=[{value:archive,depth:0}];while(values.length){const {value,depth}=values.pop();if(typeof value==='number'&&!Number.isFinite(value)||depth>128)throw invalid();if(value!==null&&typeof value==='object')for(const item of Object.values(value))values.push({value:item,depth:depth+1});}
 if(!keys(archive,['version','parentDigest','header','inheritedEventCount','events','attachments'],['version','parentDigest','header','inheritedEventCount','events','attachments'])
  ||archive.version!==1||archive.parentDigest!==null&&(typeof archive.parentDigest!=='string'||!digestPattern.test(archive.parentDigest))
  ||!validHeader(archive.header,sessionId)||!integer(archive.inheritedEventCount)||!Array.isArray(archive.events)
  ||!Array.isArray(archive.attachments))throw invalid();
 if(archive.events.length>limits.maxEvents||archive.attachments.length>limits.maxAttachmentsPerRevision)throw oversized();
 if(archive.inheritedEventCount>archive.events.length||!archive.header.isSeeded&&archive.inheritedEventCount!==0)throw invalid();
 for(const [seq,event]of archive.events.entries())if(!validEvent(event,seq))throw invalid();
 const seen=new Set();
 for(const attachment of archive.attachments){
  if(!validAttachment(attachment,limits)||seen.has(attachment.sha256))throw invalid();
  seen.add(attachment.sha256);
 }
 return {archive,text};
}
function extendsPrefix(previous,next){
 if(!isDeepStrictEqual(previous.header,next.header)||previous.inheritedEventCount!==next.inheritedEventCount||next.events.length<previous.events.length)throw conflict();
 for(let index=0;index<previous.events.length;index++)if(!isDeepStrictEqual(previous.events[index],next.events[index]))throw conflict();
 const attachments=new Map(next.attachments.map(item=>[item.sha256,item]));
 for(const attachment of previous.attachments)if(!isDeepStrictEqual(attachments.get(attachment.sha256),attachment))throw conflict();
}
async function directory(path,create=false){
 const created=[];
 if(create){
  let ancestor=path;
  while(true){try{const entry=await lstat(ancestor),actual=await realpath(ancestor),same=process.platform==='win32'?actual.toLowerCase()===ancestor.toLowerCase():actual===ancestor;if(!entry.isDirectory()||entry.isSymbolicLink()||!same)throw new Error('Invalid archive ancestor');break;}catch(error){if(error.code!=='ENOENT')throw error;created.push(ancestor);const parent=resolve(ancestor,'..');if(parent===ancestor)throw error;ancestor=parent;}}
  await mkdir(path,{recursive:true,mode:0o700});
 }
 const entry=await lstat(path),actual=await realpath(path),same=process.platform==='win32'?actual.toLowerCase()===path.toLowerCase():actual===path;
 if(!entry.isDirectory()||entry.isSymbolicLink()||!same||process.platform!=='win32'&&(entry.mode&0o077)!==0)throw new Error('Archive directory is not private');
 for(const createdPath of created){await syncDirectory(createdPath);await syncDirectory(resolve(createdPath,'..'));}
}
async function readPrivate(path,maxBytes){
 const entry=await lstat(path);
 if(!entry.isFile()||entry.isSymbolicLink()||entry.size>maxBytes||process.platform!=='win32'&&(entry.mode&0o077)!==0)throw new Error('Invalid archive file');
 const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const info=await file.stat();if(!info.isFile()||info.size>maxBytes)throw new Error('Invalid archive file');
  const bytes=await file.readFile();if(bytes.length>maxBytes)throw new Error('Invalid archive file');return bytes;
 }finally{await file.close();}
}
async function syncDirectory(path){
 if(process.platform==='win32')return;
 const file=await open(path,constants.O_RDONLY);try{await file.sync();}finally{await file.close();}
}
async function publish(path,bytes){
 const parent=resolve(path,'..'),staged=join(parent,'.'+randomUUID()+'.tmp');let file;
 try{
  file=await open(staged,'wx',0o600);await file.writeFile(bytes);await file.sync();await file.close();file=undefined;
  await link(staged,path);await syncDirectory(parent);
 }finally{if(file)await file.close();await rm(staged,{force:true});}
}

/**
 * Open a private archive directory owned by one gateway process; no existing transcript is read at startup.
 * @param {string} root Absolute durable directory outside the release and public media roots.
 * @param {object} options Request/event/revision limits and an optional millisecond clock.
 * @returns {Promise<object>} Account-scoped immutable revision and attachment operations, limits and flush().
 */
export async function openSessionArchives(root,{maxRevisionBytes=16777216,maxAttachmentBytes=67108864,maxEvents=100000,maxAttachmentsPerRevision=1024,maxRevisionsPerSession=1000,maxAccountBytes=268435456,now=Date.now}={}){
 if(typeof root!=='string'||!isAbsolute(root)||typeof now!=='function')throw new Error('Invalid Muse archive configuration');
 const base=resolve(root),limits={maxRevisionBytes:positive(maxRevisionBytes),maxAttachmentBytes:positive(maxAttachmentBytes),maxEvents:positive(maxEvents),maxAttachmentsPerRevision:positive(maxAttachmentsPerRevision),maxRevisionsPerSession:positive(maxRevisionsPerSession),maxAccountBytes:positive(maxAccountBytes)};
 try{
  await directory(base,true);const path=join(base,'schema.json'),expected={version:1,kind:'muse-session-archives'};let schema;
  try{schema=JSON.parse((await readPrivate(path,1024)).toString('utf8'));}catch(error){if(error.code!=='ENOENT')throw error;await publish(path,Buffer.from(JSON.stringify(expected)));schema=expected;}
  if(!isDeepStrictEqual(schema,expected))throw new Error('Unsupported archive storage schema');
 }catch(error){throw unavailable(error);}
 const tails=new Map(),states=new Map(),accountBytes=new Map();
 function remember(state){states.delete(state.key);states.set(state.key,state);while(states.size>VALIDATION_MEMO_SESSIONS)states.delete(states.keys().next().value);return state;}
 async function durableParents(path){let parent=resolve(path,'..');while(parent!==base){await syncDirectory(parent);const next=resolve(parent,'..');if(next===parent)throw new Error('Invalid archive parent');parent=next;}await syncDirectory(base);}
 async function serialized(accountId,operation){
  identity(accountId);const previous=tails.get(accountId)??Promise.resolve(),work=previous.then(operation);
  const settled=work.then(()=>{},error=>{void error;});tails.set(accountId,settled);
  try{return await work;}catch(error){throw unavailable(error);}finally{if(tails.get(accountId)===settled)tails.delete(accountId);}
 }
 async function accountPath(accountId,create=false){const path=join(base,accountId);await directory(path,create);return path;}
 async function usedBytes(accountId){
  if(accountBytes.has(accountId))return accountBytes.get(accountId);let total=0;
  async function visit(path){await directory(path);for(const name of await readdir(path)){const child=join(path,name),entry=await lstat(child);if(entry.isSymbolicLink())throw new Error('Invalid archive file');if(entry.isDirectory())await visit(child);else if(entry.isFile()){if(process.platform!=='win32'&&(entry.mode&0o077)!==0)throw new Error('Archive file is not private');total+=entry.size;if(!Number.isSafeInteger(total))throw new Error('Invalid archive byte total');}else throw new Error('Invalid archive file');}}
  let path;try{path=await accountPath(accountId);}catch(error){if(error.code!=='ENOENT')throw error;accountBytes.set(accountId,0);return 0;}await visit(path);
  accountBytes.set(accountId,total);return total;
 }
 async function checkQuota(accountId,additional){const used=await usedBytes(accountId);if(used+additional>limits.maxAccountBytes)throw quotaExceeded();return used;}
 async function sessionPath(accountId,deviceId,sessionId,create=false){
  identity(accountId,deviceId,sessionId);const account=await accountPath(accountId,create),devices=join(account,'devices'),device=join(devices,deviceId),session=join(device,hash(Buffer.from(sessionId)));
  for(const path of [devices,device,session])await directory(path,create);
  const descriptor=join(session,'session.json'),expected={version:1,deviceId,sessionId};let stored;
  try{stored=JSON.parse((await readPrivate(descriptor,1024)).toString('utf8'));}catch(error){if(error.code!=='ENOENT'||!create)throw error;await publish(descriptor,Buffer.from(JSON.stringify(expected)));stored=expected;}
  if(!isDeepStrictEqual(stored,expected))throw unavailable(new Error('Invalid archived session identity'));return session;
 }
 async function attachmentPath(accountId,digest,create=false){
  digestId(digest);const account=await accountPath(accountId,create),objects=join(account,'attachments');await directory(objects,create);return join(objects,digest);
 }
 async function readStored(path,deviceId,sessionId,digest){
  let stored;
  try{stored=JSON.parse((await readPrivate(path,limits.maxRevisionBytes*3+65536)).toString('utf8'));}catch(error){throw unavailable(error);}
  const manifestKeys=['version','header','inheritedEventCount','parentDigest','eventCount','eventsDelta','attachmentsDelta','attachmentOrder','receipt'];
  if(!keys(stored,['version','manifestHash','manifest'],['version','manifestHash','manifest'])||stored.version!==1||typeof stored.manifestHash!=='string'||!digestPattern.test(stored.manifestHash)
   ||!keys(stored.manifest,manifestKeys,manifestKeys)||hash(Buffer.from(JSON.stringify(stored.manifest)))!==stored.manifestHash)throw unavailable(new Error('Unsupported archive schema'));
  const manifest=stored.manifest,receipt=manifest.receipt,metadataKeys=receiptKeys.filter(key=>key!=='attachments');
  if(manifest.version!==1||!validHeader(manifest.header,sessionId)||!integer(manifest.inheritedEventCount)||!integer(manifest.eventCount)||manifest.eventCount>limits.maxEvents
   ||manifest.inheritedEventCount>manifest.eventCount||!manifest.header.isSeeded&&manifest.inheritedEventCount!==0
   ||manifest.parentDigest!==null&&(typeof manifest.parentDigest!=='string'||!digestPattern.test(manifest.parentDigest))
   ||!Array.isArray(manifest.eventsDelta)||manifest.eventsDelta.length>manifest.eventCount||manifest.eventsDelta.some((event,index)=>!validEvent(event,manifest.eventCount-manifest.eventsDelta.length+index))
   ||!Array.isArray(manifest.attachmentsDelta)||manifest.attachmentsDelta.length>limits.maxAttachmentsPerRevision||manifest.attachmentsDelta.some(item=>!validAttachment(item,limits))
   ||!Array.isArray(manifest.attachmentOrder)||manifest.attachmentOrder.length>limits.maxAttachmentsPerRevision||manifest.attachmentOrder.some(item=>typeof item!=='string'||!digestPattern.test(item))||new Set(manifest.attachmentOrder).size!==manifest.attachmentOrder.length
   ||!keys(receipt,metadataKeys,metadataKeys)||receipt.version!==1||receipt.deviceId!==deviceId||receipt.sessionId!==sessionId||receipt.digest!==digest
   ||receipt.parentDigest!==manifest.parentDigest||receipt.eventCount!==manifest.eventCount||typeof receipt.storedAt!=='string'||!Number.isFinite(Date.parse(receipt.storedAt))
   ||!isDeepStrictEqual(receipt.header,{id:sessionId,version:manifest.header.version,createdAt:manifest.header.createdAt}))throw unavailable(new Error('Invalid stored archive'));
  return {manifest,receipt,attachmentOrder:manifest.attachmentOrder};
 }
 function receiptFor(state,digest){const record=state.records.get(digest);return {...record.receipt,attachments:record.attachmentOrder.map(id=>state.attachments.get(id))};}
 async function load(accountId,deviceId,sessionId){
  const key=accountId+'/'+deviceId+'/'+sessionId;if(states.has(key))return remember(states.get(key));
  let path,names;
  try{path=await sessionPath(accountId,deviceId,sessionId);names=await readdir(path);}catch(error){if(error.code==='ENOENT')return {key,records:new Map(),head:null};throw error;}
  const files=names.filter(name=>digestPattern.test(name.replace(/\.json$/,''))&&name.endsWith('.json'));
  if(files.length>limits.maxRevisionsPerSession||names.some(name=>name!=='session.json'&&!files.includes(name)&&!/^\.[a-f0-9-]+\.tmp$/.test(name)))throw unavailable(new Error('Invalid archive directory'));
  const records=new Map(),children=new Map();let head=null;
  for(const name of files){const digest=name.slice(0,-5),{receipt,attachmentOrder}=await readStored(join(path,name),deviceId,sessionId,digest);records.set(digest,{receipt,attachmentOrder});}
  for(const [digest,record]of records){const parent=record.receipt.parentDigest;if(children.has(parent)||parent!==null&&!records.has(parent))throw unavailable(new Error('Invalid archive chain'));children.set(parent,digest);}
  let visited=0,cursor=children.get(null),archive;const attachments=new Map();
  while(cursor){
   const {manifest}=await readStored(join(path,cursor+'.json'),deviceId,sessionId,cursor),prefix=archive?.events.length??0;
   if(manifest.eventCount-manifest.eventsDelta.length!==prefix||archive&&(!isDeepStrictEqual(archive.header,manifest.header)||archive.inheritedEventCount!==manifest.inheritedEventCount))throw unavailable(new Error('Invalid committed archive prefix'));
   const order=new Set(manifest.attachmentOrder);if([...attachments.keys()].some(id=>!order.has(id)))throw unavailable(new Error('Invalid committed archive attachments'));
   for(const item of manifest.attachmentsDelta){if(attachments.has(item.sha256))throw unavailable(new Error('Invalid committed archive attachment delta'));attachments.set(item.sha256,item);}
   if(manifest.attachmentOrder.some(id=>!attachments.has(id))||attachments.size!==manifest.attachmentOrder.length)throw unavailable(new Error('Invalid committed archive attachments'));
   const events=archive?.events??[];for(const event of manifest.eventsDelta)events.push(event);archive={version:1,parentDigest:manifest.parentDigest,header:manifest.header,inheritedEventCount:manifest.inheritedEventCount,events,attachments:manifest.attachmentOrder.map(id=>attachments.get(id))};
   head=cursor;cursor=children.get(cursor);visited++;if(visited>records.size)throw unavailable(new Error('Invalid archive chain'));
  }
  if(visited!==records.size)throw unavailable(new Error('Invalid archive chain'));
  return remember({key,records,head,archive,attachments});
 }
 async function confirmAttachments(accountId,attachments){
  for(const attachment of attachments){let bytes;try{bytes=await readPrivate(await attachmentPath(accountId,attachment.sha256),limits.maxAttachmentBytes);}catch(error){if(error.code==='ENOENT')throw conflict();throw error;}
   if(bytes.length!==attachment.sizeBytes||hash(bytes)!==attachment.sha256)throw conflict();
  }
 }
 return {
  limits:Object.freeze({...limits}),
  /** Verify the exact request SHA and commit only its event/attachment deltas; repetition returns the original receipt. */
  async putRevision(accountId,deviceId,sessionId,digest,rawBody){
   identity(accountId,deviceId,sessionId);digestId(digest);
   if(!Buffer.isBuffer(rawBody)&&typeof rawBody!=='string')throw invalid();
   const bytes=Buffer.from(rawBody);if(bytes.length>limits.maxRevisionBytes)throw oversized();if(hash(bytes)!==digest)throw invalid();
   const {archive}=validateArchive(bytes,sessionId,limits);
   return serialized(accountId,async()=>{
    const state=await load(accountId,deviceId,sessionId);
    if(state.records.has(digest)){const path=await sessionPath(accountId,deviceId,sessionId);await durableParents(join(path,digest+'.json'));return structuredClone(receiptFor(state,digest));}
    if(archive.parentDigest!==state.head)throw conflict();
    if(state.head)extendsPrefix(state.archive,archive);
    if(state.records.size>=limits.maxRevisionsPerSession)throw oversized();
    await confirmAttachments(accountId,archive.attachments);
    const receipt={version:1,deviceId,sessionId,digest,parentDigest:archive.parentDigest,eventCount:archive.events.length,storedAt:new Date(now()).toISOString(),header:{id:sessionId,version:archive.header.version,createdAt:archive.header.createdAt},attachments:archive.attachments};
    const {attachments:receiptAttachments,...metadata}=receipt,known=state.attachments??new Map(),attachmentOrder=receiptAttachments.map(item=>item.sha256);
    const manifest={version:1,header:archive.header,inheritedEventCount:archive.inheritedEventCount,parentDigest:archive.parentDigest,eventCount:archive.events.length,eventsDelta:archive.events.slice(state.archive?.events.length??0),attachmentsDelta:archive.attachments.filter(item=>!known.has(item.sha256)),attachmentOrder,receipt:metadata};
    const stored=Buffer.from(JSON.stringify({version:1,manifestHash:hash(Buffer.from(JSON.stringify(manifest))),manifest}));
    let descriptorBytes=0;try{await sessionPath(accountId,deviceId,sessionId);}catch(error){if(error.code!=='ENOENT')throw error;descriptorBytes=Buffer.byteLength(JSON.stringify({version:1,deviceId,sessionId}));}
    const used=await checkQuota(accountId,stored.length+descriptorBytes);let path;
    try{path=await sessionPath(accountId,deviceId,sessionId,true);await publish(join(path,digest+'.json'),stored);}catch(error){states.delete(state.key);accountBytes.delete(accountId);throw error;}
    accountBytes.set(accountId,used+stored.length+descriptorBytes);state.records.set(digest,{receipt:metadata,attachmentOrder});state.head=digest;state.archive=archive;state.attachments=new Map(archive.attachments.map(item=>[item.sha256,item]));remember(state);return structuredClone(receipt);
   });
  },
  /** Return the latest committed prefix of one account-owned device/session pair. */
  async latest(accountId,deviceId,sessionId){
   identity(accountId,deviceId,sessionId);return serialized(accountId,async()=>{const state=await load(accountId,deviceId,sessionId);if(!state.head)throw missing();return structuredClone({receipt:receiptFor(state,state.head),archive:state.archive});});
  },
  /** Page immutable revision receipts from newest to oldest within the selected account-owned Session. */
  async revisions(accountId,deviceId,sessionId,{limit=50,cursor,summary=false}={}){
   identity(accountId,deviceId,sessionId);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw invalid();
   if(cursor!==undefined)digestId(cursor);
   return serialized(accountId,async()=>{
    const state=await load(accountId,deviceId,sessionId);if(!state.head)throw missing();
    if(cursor!==undefined&&!state.records.has(cursor))throw invalid();
    let next=cursor===undefined?state.head:state.records.get(cursor).receipt.parentDigest;const items=[];
    while(next&&items.length<limit){items.push(structuredClone(receiptFor(state,next)));next=state.records.get(next).receipt.parentDigest;}
    return {items:summary?items.map(({attachments,...row})=>({...row,attachmentCount:attachments.length})):items,nextCursor:next===null?null:items.at(-1).digest};
   });
  },
  /** Read one verified historical prefix; contentDigest covers the reconstructed JSON rather than the original upload serialization. */
  async revision(accountId,deviceId,sessionId,digest){
   identity(accountId,deviceId,sessionId);digestId(digest);return serialized(accountId,async()=>{
    const state=await load(accountId,deviceId,sessionId);if(!state.records.has(digest))throw missing();
    const path=await sessionPath(accountId,deviceId,sessionId),chain=[];let cursor=digest;
    while(cursor!==null){const item=await readStored(join(path,cursor+'.json'),deviceId,sessionId,cursor);chain.push(item);cursor=item.manifest.parentDigest;}
    const events=[],attachments=new Map();let archive;
    for(const {manifest} of chain.reverse()){
     for(const event of manifest.eventsDelta)events.push(event);
     for(const item of manifest.attachmentsDelta)attachments.set(item.sha256,item);
     archive={version:1,parentDigest:manifest.parentDigest,header:manifest.header,inheritedEventCount:manifest.inheritedEventCount,events,attachments:manifest.attachmentOrder.map(id=>attachments.get(id))};
    }
    await confirmAttachments(accountId,archive.attachments);
    const children=[];
    const devicePath=resolve(path,'..');
    for(const name of await readdir(devicePath)){
     if(!digestPattern.test(name))throw unavailable(new Error('Invalid archived session'));
     const childPath=join(devicePath,name);await directory(childPath);
     const descriptor=JSON.parse((await readPrivate(join(childPath,'session.json'),1024)).toString('utf8'));
     if(!keys(descriptor,['version','deviceId','sessionId'],['version','deviceId','sessionId'])||descriptor.version!==1||descriptor.deviceId!==deviceId||hash(Buffer.from(descriptor.sessionId))!==name)throw unavailable(new Error('Invalid archived session identity'));
     const child=await load(accountId,deviceId,descriptor.sessionId);
     if(child.archive?.header.origin!=='subagent'||child.archive.header.parentSession!==sessionId)continue;
     const descriptors=child.archive.events.filter(event=>event.type==='subagent/descriptor'&&event.seq>=child.archive.inheritedEventCount);
     children.push({childId:child.archive.header.id,childCreatedAt:child.archive.header.createdAt,descriptorCount:descriptors.length,descriptor:descriptors[0]?.data??null});
    }
    return structuredClone({receipt:receiptFor(state,digest),archive,contentDigest:hash(Buffer.from(JSON.stringify(archive))),children});
   });
  },
  /** Page latest receipts in stable device/session order; listing never exposes transcript bodies. */
  async list(accountId,{limit=50,cursor,summary=false}={}){
   identity(accountId);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw invalid();let after='';
   if(cursor!==undefined){try{if(typeof cursor!=='string'||cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(cursor))throw invalid();const parsed=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(!keys(parsed,['version','after'],['version','after'])||parsed.version!==1||typeof parsed.after!=='string')throw invalid();const parts=parsed.after.split('/');if(parts.length!==2)throw invalid();identity(accountId,parts[0],parts[1]);after=parsed.after;}catch(error){throw invalid();}}
   return serialized(accountId,async()=>{
    let account;try{account=await accountPath(accountId);}catch(error){if(error.code==='ENOENT')return {items:[],nextCursor:null};throw error;}
    const devices=join(account,'devices');let names;try{await directory(devices);names=await readdir(devices);}catch(error){if(error.code==='ENOENT')return {items:[],nextCursor:null};throw error;}
    const addresses=[];
    for(const deviceId of names){if(!devicePattern.test(deviceId))throw unavailable(new Error('Invalid archived device'));const path=join(devices,deviceId);await directory(path);for(const encoded of await readdir(path)){if(!digestPattern.test(encoded))throw unavailable(new Error('Invalid archived session'));const child=join(path,encoded);await directory(child);const descriptor=JSON.parse((await readPrivate(join(child,'session.json'),1024)).toString('utf8'));try{identity(accountId,deviceId,descriptor.sessionId);}catch(error){throw unavailable(new Error('Invalid archived session identity'));}if(!isDeepStrictEqual(descriptor,{version:1,deviceId,sessionId:descriptor.sessionId})||hash(Buffer.from(descriptor.sessionId))!==encoded)throw unavailable(new Error('Invalid archived session identity'));const sessionId=descriptor.sessionId;addresses.push({deviceId,sessionId,key:deviceId+'/'+sessionId});}}
    addresses.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);const items=[];let last;
    for(const address of addresses){if(address.key<=after)continue;const state=await load(accountId,address.deviceId,address.sessionId);if(!state.head)continue;if(items.length===limit)return {items,nextCursor:Buffer.from(JSON.stringify({version:1,after:last})).toString('base64url')};const {attachments,...row}=structuredClone(receiptFor(state,state.head));items.push(summary?{...row,attachmentCount:attachments.length}:{...row,attachments});last=address.key;}
    return {items,nextCursor:null};
   });
  },
  /** Store one immutable binary attachment, scoped to its authenticated account and content digest. */
  async putAttachment(accountId,digest,bytes){
   identity(accountId);digestId(digest);if(!Buffer.isBuffer(bytes))throw invalid();const body=Buffer.from(bytes);if(body.length>limits.maxAttachmentBytes)throw oversized();if(hash(body)!==digest)throw invalid();
   return serialized(accountId,async()=>{const path=await attachmentPath(accountId,digest,true);let previous;try{previous=await readPrivate(path,limits.maxAttachmentBytes);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(previous){if(!previous.equals(body))throw conflict();await durableParents(path);}else{const used=await checkQuota(accountId,body.length);try{await publish(path,body);}catch(error){accountBytes.delete(accountId);throw error;}accountBytes.set(accountId,used+body.length);}
    return {version:1,sha256:digest,sizeBytes:body.length};
   });
  },
  /** Return verified bytes from this account only; missing and other-account hashes are indistinguishable. */
  async getAttachment(accountId,digest){
   identity(accountId);digestId(digest);return serialized(accountId,async()=>{let bytes;try{bytes=await readPrivate(await attachmentPath(accountId,digest),limits.maxAttachmentBytes);}catch(error){if(error.code==='ENOENT')throw missing();throw error;}if(hash(bytes)!==digest)throw unavailable(new Error('Archive attachment changed'));return bytes;});
  },
  /** Wait for already accepted operations before gateway shutdown; operation callers own their failures. */
  async flush(){await Promise.all([...tails.values()]);},
 };
}
