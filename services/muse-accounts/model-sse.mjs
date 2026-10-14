/** Byte-preserving Chat Completions SSE termination without buffering event payloads. */

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
