/** Operator-selected Feishu bindings admit company members without copying external identities into operation receipts. */
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const externalId=value=>typeof value==='string'&&value.length>0&&value.length<=512&&value.trim()===value&&!/[\x00-\x1f\x7f]/u.test(value);
const invalid=()=>Object.assign(Error('native_jubian_admission_invalid_member_directory'),{code:'native_jubian_admission_invalid_member_directory',status:500});

/** Validate optional automatic membership against existing trusted account bindings.
 * @param {object|undefined} value Operator-owned Feishu app, company tenant, non-privileged role and explicit allowances.
 * @returns {object|undefined} Detached directory settings, or disabled when absent.
 */
export function resolveNativeJubianMemberDirectory(value){
 if(value===undefined)return;
 const keys=['kind','appId','tenantKey','active','role','limitMinor','maxParallel'];
 if(!object(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key))
  ||value.kind!=='feishu'||!externalId(value.appId)||!externalId(value.tenantKey)||typeof value.active!=='boolean'
  ||!['editor','viewer'].includes(value.role)||!Number.isSafeInteger(value.limitMinor)||value.limitMinor<0||!positive(value.maxParallel))throw invalid();
 return Object.fromEntries(keys.map(key=>[key,value[key]]));
}

/** Resolve one company member; explicit entries, including denials, take precedence over verified Feishu bindings.
 * @param {object|undefined} company Current operator policy with optional directory settings.
 * @param {string} accountId Internal account identity derived from the authenticated session or a checked budget target.
 * @param {object} accounts Trusted account store; caller-supplied external identities are never consulted.
 * @returns {object|undefined} Existing explicit member or a non-privileged directory member, without external identity fields.
 */
export function nativeJubianMember(company,accountId,accounts){
 const explicit=company?.members.find(member=>member.accountId===accountId);
 if(explicit!==undefined)return explicit;
 const directory=company?.memberDirectory;
 if(directory===undefined||!directory.active)return;
 const record=accounts.get(accountId);
 if(!record||record.disabled||!record.feishuIdentities?.some(identity=>identity.appId===directory.appId&&identity.tenantKey===directory.tenantKey))return;
 return {accountId,role:directory.role,active:true,limitMinor:directory.limitMinor,maxParallel:directory.maxParallel};
}
