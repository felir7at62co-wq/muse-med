import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {modelFailure,readModelFailure,readModelFailureDetails} from './model-errors.mjs';

test('provider refusals preserve distinct recovery codes without echoing private diagnostics',()=>{
 const cases=[
  [429,{code:'insufficient_quota',message:'synthetic-private-key balance exhausted'},'insufficient_quota'],
  [429,{message:'Rate limit exceeded for synthetic-private-key'},'rate_limit_exceeded'],
  [400,{message:'max_tokens exceeds maximum supported output'},'output_limit_exceeded'],
  [400,{message:'maximum context length exceeded'},'context_length_exceeded'],
  [400,{message:'余额不足 synthetic-private-key'},'insufficient_quota'],
  [400,{message:'检查配置或额度 synthetic-private-key'},'invalid_request_error'],
  [400,{message:'Unsupported thinking type synthetic-private-key'},'invalid_request_error'],
  [401,{message:'synthetic-private-key'},'authentication_error'],
  [500,{message:'synthetic-private-key insufficient quota'},'upstream_error'],
 ];
 for(const [status,error,code]of cases){const failure=modelFailure(status,JSON.stringify({error}));assert.equal(failure.error.code,code);assert.doesNotMatch(JSON.stringify(failure),/synthetic-private-key/);}
 assert.equal(modelFailure(429,'not JSON').error.code,'rate_limit_exceeded');
});

test('oversized provider diagnostics remain bounded and cannot change classification',async()=>{
 const response=Readable.from([Buffer.alloc(65536,32),Buffer.from('{"error":{"code":"insufficient_quota"}}')]);response.statusCode=400;
 assert.equal((await readModelFailure(response)).error.code,'invalid_request_error');
 const ordinary=Readable.from([Buffer.from('{"error":{"code":"insufficient_quota"}}')]);ordinary.statusCode=429;
 assert.equal((await readModelFailure(ordinary)).error.code,'insufficient_quota');
});

test('only bounded explicit API key codes with an authentication type mark credential rejection',async()=>{
 const classify=async(status,body)=>{const response=Readable.from([Buffer.from(body)]);response.statusCode=status;return readModelFailureDetails(response);};
 for(const [status,body,expected]of [
  [401,'{"error":{"code":"invalid_api_key"}}',true],
  [401,'{"error":{"code":"invalid_api_key_error","type":"authentication_error"}}',true],
  [401,'{"error":{"code":"invalid_api_key","type":"permission_error"}}',false],
  [401,'{"error":{"type":"authentication_error"}}',false],
  [401,'{"error":{"message":"invalid_api_key"}}',false],
  [401,'invalid_api_key',false],
  [401,'null',false],
  [403,'{"error":{"code":"invalid_api_key"}}',false],
  [500,'{"error":{"code":"invalid_api_key"}}',false],
  [401,' '.repeat(65536)+'{"error":{"code":"invalid_api_key"}}',false],
 ])assert.equal((await classify(status,body)).credentialsRejected,expected,`${status}: ${body.slice(0,80)}`);
});
