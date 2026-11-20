/** Versioned per-million-token prices used to estimate spend; requests without a matching price stay unpriced. */
import {readFileSync} from 'node:fs';

const fail=message=>{throw Error('Invalid price table: '+message);};
const amount=(value,label)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>10_000)fail(label+' must be a non-negative number');return value;};

/**
 * Load and validate a price table file.
 * @param {string} path JSON file `{version, currency, rows:[{provider, model, inputMissPerMillion, inputHitPerMillion, outputPerMillion}]}`; `model` may be `*`.
 * @returns {{version:string,currency:string,priceOf(provider:string,model:string):object|null,cost(row:object):number|null}} Price lookup and per-request estimate.
 */
export function loadPrices(path){
 let table;
 try{table=JSON.parse(readFileSync(path,'utf8'));}catch{fail('file must be readable JSON');}
 return createPrices(table);
}

/**
 * Build a price lookup from an already parsed table.
 * @param {object} table Parsed price table.
 * @returns {{version:string,currency:string,priceOf(provider:string,model:string):object|null,cost(row:object):number|null}} Price lookup and per-request estimate.
 */
export function createPrices(table){
 if(!table||typeof table!=='object')fail('table must be an object');
 if(typeof table.version!=='string'||!/^[A-Za-z0-9._-]{1,40}$/.test(table.version))fail('version is required');
 if(table.currency!=='CNY')fail('currency must be CNY');
 if(!Array.isArray(table.rows)||table.rows.length>500)fail('rows must be an array');
 const prices=new Map();
 for(const row of table.rows){
  if(typeof row?.provider!=='string'||!row.provider||typeof row?.model!=='string'||!row.model)fail('each row needs provider and model');
  const key=row.provider+'\0'+row.model;
  if(prices.has(key))fail('duplicate row '+row.provider+' '+row.model);
  prices.set(key,Object.freeze({inputMiss:amount(row.inputMissPerMillion,'inputMissPerMillion'),inputHit:amount(row.inputHitPerMillion,'inputHitPerMillion'),output:amount(row.outputPerMillion,'outputPerMillion')}));
 }
 const priceOf=(provider,model)=>prices.get(provider+'\0'+model)??prices.get(provider+'\0*')??null;
 /**
  * Estimate one request or one aggregate of requests in yuan.
  * @param {{provider:string,model:string,input_tokens?:number|null,cache_read_tokens?:number|null,output_tokens?:number|null}} row Token counts.
  * @returns {number|null} Estimated yuan, or null when the model has no price.
  */
 function cost(row){
  const price=priceOf(row.provider,row.model);
  if(!price)return null;
  const input=Number(row.input_tokens??0),hit=Math.min(input,Number(row.cache_read_tokens??0)),output=Number(row.output_tokens??0);
  return ((input-hit)*price.inputMiss+hit*price.inputHit+output*price.output)/1_000_000;
 }
 return Object.freeze({version:table.version,currency:table.currency,priceOf,cost});
}
