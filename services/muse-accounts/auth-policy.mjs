/** Deployment policy for retiring legacy password authentication after a Feishu rollout. */

/**
 * Resolve the opt-in Feishu-only login policy without accepting truthy strings.
 * @param {string|undefined} value MUSE_FEISHU_ONLY_LOGIN, omitted, true or false.
 * @param {boolean} feishuEnabled Whether Feishu login is configured.
 * @returns {boolean} Whether new password logins and registrations are refused.
 */
export function resolveFeishuOnlyLogin(value,feishuEnabled){
 if(value!==undefined&&value!=='true'&&value!=='false')throw Error('MUSE_FEISHU_ONLY_LOGIN must be true or false');
 const enabled=value==='true';
 if(enabled&&!feishuEnabled)throw Error('MUSE_FEISHU_ONLY_LOGIN requires configured Feishu login');
 return enabled;
}
