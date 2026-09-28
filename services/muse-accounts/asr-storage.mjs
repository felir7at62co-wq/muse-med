/** Private temporary TOS storage used only by the account gateway. */
export function createTosAudioStore(settings,{TosClient,CancelToken},fetcher=fetch){
 const {bucket,region,endpoint,prefix,accessKeyId,secretAccessKey}=settings;
 if(!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)||!/^cn-[a-z0-9-]+$/.test(region)||endpoint!==`tos-${region}.volces.com`||!/^[a-zA-Z0-9/_-]+\/$/.test(prefix)||prefix.includes('..')||prefix.includes('//'))throw Error('Invalid private ASR TOS location');
 const client=new TosClient({accessKeyId,accessKeySecret:secretAccessKey,region,endpoint,enableCRC:true});
 const owns=key=>{if(!key.startsWith(prefix)||!/^[a-z0-9/_-]+\.mp3$/i.test(key))throw Error('ASR object is outside its temporary prefix');};
 return {
  key(id){return prefix+id+'.mp3';},
  async assertPrivateBeforeUpload(){
   const [{data:acl},{data:policy}]=await Promise.all([client.getBucketAcl(bucket),client.getBucketPolicy(bucket)]);
   const owner=acl?.Owner?.ID;
   if(!owner||!Array.isArray(acl.Grants)||acl.Grants.some(grant=>grant?.Grantee?.Type!=='CanonicalUser'||grant.Grantee.ID!==owner)
    ||!Array.isArray(policy?.Statement)||policy.Statement.some(statement=>statement?.Effect!=='Deny'))throw Error('ASR bucket is not proven private');
  },
  async upload(file,key){owns(key);const cancel=CancelToken.source();await client.uploadFile({bucket,key,file,acl:'private',taskNum:1,cancelToken:cancel.token});},
  async signedReadUrl(key){owns(key);return client.getPreSignedUrl({bucket,key,method:'GET',expires:settings.signedUrlTtlSeconds});},
  async assertPrivateAndReadable(key,url){
   owns(key);const unsigned=`https://${bucket}.${endpoint}/${key.split('/').map(encodeURIComponent).join('/')}`;
   const options={method:'GET',headers:{Range:'bytes=0-0'},redirect:'manual',signal:AbortSignal.timeout(settings.timeoutMs)};
   const anonymous=await fetcher(unsigned,options);await anonymous.body?.cancel();
   if(anonymous.status!==403)throw Error('ASR object is not proven private');
   const signed=await fetcher(url,options);await signed.body?.cancel();
   if(![200,206].includes(signed.status))throw Error('Signed ASR object is not readable');
  },
  async remove(key){owns(key);await client.deleteObject({bucket,key});},
 };
}
