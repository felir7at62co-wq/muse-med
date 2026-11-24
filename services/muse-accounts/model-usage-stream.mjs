/** Bounded Chat Completions usage observation; no request or response text is persisted. */
import {StringDecoder} from 'node:string_decoder';
import {closeModelUpstream} from './model-sse.mjs';

const integer=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const first=(...values)=>values.map(integer).find(value=>value!==null)??null;

/** Read only provider-reported token fields; cache and reasoning counts are subsets, never added to totals.
 * @param {object} value Parsed provider response or SSE data object.
 * @returns {object|null} Nullable token counts, or null when no valid usage field was reported.
 */
export function reportedModelUsage(value){
 const u=value?.usage;if(!u||typeof u!=='object'||Array.isArray(u))return null;
 const sample={inputTokens:first(u.prompt_tokens,u.input_tokens),outputTokens:first(u.completion_tokens,u.output_tokens),
  totalTokens:integer(u.total_tokens),cacheReadTokens:first(u.prompt_tokens_details?.cached_tokens,u.input_tokens_details?.cached_tokens,u.prompt_cache_hit_tokens),
  cacheWriteTokens:integer(u.cache_creation_input_tokens),reasoningTokens:integer(u.completion_tokens_details?.reasoning_tokens)};
 return Object.values(sample).some(value=>value!==null)?sample:null;
}

/** Observe bounded JSON or SSE payloads without changing, delaying or retaining forwarded bytes.
 * @param {object} options Streaming flag and maximum UTF-8 bytes retained per JSON body or SSE event.
 * @returns {object} Chunk observer, EOF finalizer and latest cumulative usage snapshot.
 */
export function createModelUsageObserver({stream,maxBytes=1024*1024}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<64)throw Error('Invalid model usage observation limit');
 const decoder=new StringDecoder('utf8');
 let sample=null,complete=false,omitted=false,ended=false,status=null;
 let line='',lineBytes=0,eventBytes=0,data=[],overflow=false,skipLF=false,firstLine=true,json=[],jsonBytes=0;
 function accept(text){try{const value=JSON.parse(text),next=reportedModelUsage(value);if(next)sample=next;else if(value?.usage!==undefined&&value.usage!==null)omitted=true;}catch(error){omitted=true;}}
 function endLine(){
  if(firstLine){line=line.replace(/^\ufeff/,'');firstLine=false;}
  const blank=lineBytes===0;
  if(blank&&!overflow){
   if(data.length){const text=data.join('\n');if(text==='[DONE]')complete=true;else accept(text);}
   data=[];eventBytes=0;
  }else if(line==='data'||line.startsWith('data:')){
   const text=line==='data'?'':line.slice(5).replace(/^ /,'');eventBytes+=lineBytes;
   if(!overflow&&eventBytes<=maxBytes)data.push(text);else{omitted=true;overflow=true;data=[];}
  }
  // An oversized line/event is discarded until its blank separator.
  if(blank&&overflow){overflow=false;data=[];eventBytes=0;}
  line='';lineBytes=0;
 }
 function scan(text){
  for(const char of text){
   if(complete)return;
   if(skipLF){skipLF=false;if(char==='\n')continue;}
   if(char==='\r'||char==='\n'){skipLF=char==='\r';endLine();continue;}
   lineBytes+=Buffer.byteLength(char);if(lineBytes<=maxBytes)line+=char;else{omitted=true;overflow=true;}
  }
 }
 return {
  observe(chunk){
   if(ended||complete)return;
   if(stream)scan(decoder.write(chunk));
   else{jsonBytes+=chunk.length;if(jsonBytes<=maxBytes)json.push(Buffer.from(chunk));else{omitted=true;json=[];}}
  },
  upstream(value){status=value;},
  end(){if(ended)return;ended=true;if(stream)scan(decoder.end());else if(!omitted){const text=Buffer.concat(json).toString('utf8');try{const value=JSON.parse(text);sample=reportedModelUsage(value);complete=true;}catch(error){/* A truncated JSON body has unknown usage. */}json=[];}},
  snapshot(){return {sample,complete:complete&&!omitted,omitted,status};},
 };
}

/** Forward unchanged chunks while observing usage alongside the existing pipeline.
 * @param {AsyncIterable<Buffer>} source Existing JSON or SSE response iterator.
 * @param {object} observer Optional request-owned usage observer.
 * @returns {AsyncGenerator<Buffer>} The original chunks in their original order.
 */
export async function* observeModelUsageBytes(source,observer){
 try{for await(const chunk of source){observer?.observe(chunk);yield chunk;}observer?.end();}
 finally{if(typeof source.destroy==='function')await closeModelUpstream(source);}
}
