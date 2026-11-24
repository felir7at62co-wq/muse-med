/** Chat Completions SSE termination and tool-call finish correction for relayed model streams. */

function doneScanner(){
 let line='',oversized=false,firstLine=true,skipLF=false,hasData=false,doneData=false;
 function endLine(){
  const value=firstLine?line.replace(/^\xef\xbb\xbf/,''):line;
  firstLine=false;
  const blank=!oversized&&!value.length;
  if(!blank&&(value==='data'||value.startsWith('data:'))){
   doneData=!hasData&&!oversized&&(value==='data: [DONE]'||value==='data:[DONE]');hasData=true;
  }
  const done=blank&&doneData;
  if(blank){hasData=false;doneData=false;}
  line='';oversized=false;
  return done;
 }
 return chunk=>{
  for(let index=0;index<chunk.length;index++){
   const byte=chunk[index];
   if(skipLF){skipLF=false;if(byte===10)continue;}
   if(byte===13||byte===10){
    skipLF=byte===13;
    if(endLine())return index+1+(byte===13&&chunk[index+1]===10?1:0);
   }else if(line.length<16)line+=String.fromCharCode(byte);else oversized=true;
  }
 };
}

/** Stop an owned Node stream and await its close, including asynchronous destruction.
 * @param {import('node:stream').Stream} stream Owned upstream request or response.
 * @returns {Promise<void>} Resolves only after the stream is closed.
 */
export async function closeModelUpstream(stream){
 if(stream.closed)return;
 const closed=new Promise(resolve=>stream.once('close',resolve));
 stream.destroy();await closed;
}

/** Relay bytes through a complete, single-data-field [DONE] event or ordinary EOF.
 * @param {import('node:stream').Readable} response Owned upstream response.
 * @returns {AsyncGenerator<Buffer>} Unchanged bytes, respecting downstream backpressure.
 * A final CR terminates immediately; its optional LF is retained when already buffered.
 * Returning, throwing or cancelling closes the upstream before the iterator settles.
 */
export async function* modelSseBytes(response){
 const scan=doneScanner();
 try{
  for await(const chunk of response.iterator({destroyOnReturn:false})){
   const end=scan(chunk);
   if(end!==undefined){
    await closeModelUpstream(response);
    yield chunk.subarray(0,end);return;
   }
   yield chunk;
  }
 }finally{await closeModelUpstream(response);}
}

const FINISH_FIELD=Buffer.from('"finish_reason"');
// Larger events are forwarded as they arrive; holding them would delay delivery without a finish to correct.
const MAX_INSPECTED_EVENT_BYTES=8*1024*1024;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

function singleDataField(event){
 let field=null;
 for(let start=0;start<event.length;){
  let end=start;while(end<event.length&&event[end]!==10&&event[end]!==13)end++;
  const name=event.toString('latin1',start,Math.min(end,start+5));
  if(name==='data:'||name==='data'&&end-start===4){
   if(field)return null;
   field={start:Math.min(end,start+(end-start>5&&event[start+5]===32?6:5)),end};
  }
  start=end+(event[end]===13&&event[end+1]===10?2:1);
 }
 return field;
}

/** Keep a choice's tool_calls finish authoritative in a Chat Completions SSE stream.
 * Some relay exits append a second chunk with finish_reason content_filter or stop after tool_calls;
 * OpenAI-compatible clients keep the last finish and then discard the completed tool calls.
 * @param {AsyncIterable<Buffer>} source SSE bytes; returning or throwing closes it before the iterator settles.
 * @returns {AsyncGenerator<Buffer>} The same bytes released at event delimiters, except that a single-data-field
 * event naming a later finish_reason for a choice that already finished with tool_calls carries null instead.
 * A choice without index is identified by its array position. Unparseable, multi-data-field and oversized events,
 * and an unterminated final event, pass through unchanged.
 */
export async function* toolCallFinishBytes(source){
 const finished=new Set();
 let held=[],heldBytes=0,lineLength=0,skipLF=false,passing=false;
 function inspect(event){
  if(event.indexOf(FINISH_FIELD)<0)return event;
  const field=singleDataField(event);if(!field)return event;
  let value;
  try{value=JSON.parse(event.toString('utf8',field.start,field.end));}
  catch(error){if(!(error instanceof SyntaxError))throw error;return event;}
  if(!object(value)||!Array.isArray(value.choices))return event;
  let changed=false;
  value.choices.forEach((choice,position)=>{
   if(!object(choice)||choice.finish_reason===null||choice.finish_reason===undefined)return;
   const key=Number.isSafeInteger(choice.index)?choice.index:position;
   if(finished.has(key)){choice.finish_reason=null;changed=true;}
   else if(choice.finish_reason==='tool_calls')finished.add(key);
  });
  return changed?Buffer.concat([event.subarray(0,field.start),Buffer.from(JSON.stringify(value)),event.subarray(field.end)]):event;
 }
 for await(const chunk of source){
  const output=[];let from=0;
  for(let index=0;index<chunk.length;index++){
   const byte=chunk[index];
   if(skipLF){skipLF=false;if(byte===10)continue;}
   if(byte!==13&&byte!==10){lineLength++;continue;}
   skipLF=byte===13;
   if(lineLength){lineLength=0;continue;}
   const tail=chunk.subarray(from,index+1);from=index+1;
   if(passing){passing=false;output.push(tail);continue;}
   held.push(tail);output.push(inspect(Buffer.concat(held)));held=[];heldBytes=0;
  }
  const rest=chunk.subarray(from);
  if(passing){if(rest.length)output.push(rest);}
  else if(rest.length){
   held.push(rest);heldBytes+=rest.length;
   if(heldBytes>MAX_INSPECTED_EVENT_BYTES){passing=true;output.push(...held);held=[];heldBytes=0;}
  }
  if(output.length)yield output.length===1?output[0]:Buffer.concat(output);
 }
 if(held.length)yield Buffer.concat(held);
}
