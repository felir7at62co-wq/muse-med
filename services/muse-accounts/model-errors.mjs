/** Allowlisted model failures keep retry decisions without exposing upstream diagnostics. */
const messages={
 authentication_error:'Upstream authentication failed. 请联系管理员检查模型凭据。',
 insufficient_quota:'Upstream insufficient_quota. 请联系管理员检查模型余额或套餐。',
 rate_limit_exceeded:'Upstream rate limit exceeded. 请求过于频繁，请稍后重试。',
 context_length_exceeded:'Upstream context length exceeded. 请缩短上下文后重试。',
 output_limit_exceeded:'Upstream invalid_request: output token limit exceeded. 请联系管理员检查输出上限。',
 invalid_request_error:'Upstream invalid_request. 请联系管理员检查模型参数。',
 upstream_error:'Upstream server error. 模型服务暂不可用，请稍后重试。',
};

/** Classify a bounded provider refusal into a fixed public code and message.
 * @param {number} status Provider HTTP status.
 * @param {string} body Complete response body, or empty for an oversized or malformed response.
 * @returns {object} OpenAI-compatible error containing no provider-controlled text.
 */
export function modelFailure(status,body){
 let parsed;try{parsed=JSON.parse(body);}catch{parsed=undefined;}
 const error=parsed?.error??parsed;
 const fields=error&&typeof error==='object'?['code','type','message'].map(key=>typeof error[key]==='string'?error[key]:''):[];
 const detail=fields.join(' '),tags=fields.slice(0,2);
 let code='upstream_error';
 if(status===401||status===403)code='authentication_error';
 else if(status>=400&&status<500){
  if(status===402||tags.some(tag=>['insufficient_quota','insufficient_balance','quota_exceeded'].includes(tag)))code='insufficient_quota';
  else if(tags.some(tag=>['rate_limit_exceeded','rate_limit_error','too_many_requests'].includes(tag))
   ||/\b(?:rate[\s_-]+limit|(?:tokens?|requests?) per (?:minute|second))\b|请求(?:频率|速率)|并发.*(?:上限|限制)/i.test(detail))code='rate_limit_exceeded';
  else if(/\bcontext[\s_-]+(?:length|window)[\s_-]+(?:exceeded|overflow)\b|\bmaximum context length\b|上下文.*(?:超过|超出|上限)/i.test(detail))code='context_length_exceeded';
  else if(tags.includes('output_limit_exceeded')||/\b(?:max_tokens|max_completion_tokens|max_output_tokens|output[\s_-]+(?:token[\s_-]+)?limit)\b.{0,80}\b(?:exceed\w*|too (?:large|high)|greater than|at most|maximum)\b/i.test(detail))code='output_limit_exceeded';
  else if(/\binsufficient[\s_-]+(?:quota|balance|credits?)\b|\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b|\bexceed(?:ed|s)? (?:your |the )?(?:current )?quota\b|\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b|余额不足|(?:额度|配额).*(?:已用尽|耗尽)/i.test(detail))code='insufficient_quota';
  else code=status===429?'rate_limit_exceeded':'invalid_request_error';
 }
 return {error:{code,message:messages[code]}};
}

/** Consume at most 64 KiB of an upstream refusal for classification.
 * @param {import('node:http').IncomingMessage} response Provider response.
 * @returns {Promise<object>} Fixed public failure; oversized bodies remain unclassified.
 */
export async function readModelFailure(response){
 const chunks=[];let size=0;
 for await(const chunk of response){size+=chunk.length;if(size>65536)return modelFailure(response.statusCode,'');chunks.push(chunk);}
 return modelFailure(response.statusCode,Buffer.concat(chunks).toString('utf8'));
}
