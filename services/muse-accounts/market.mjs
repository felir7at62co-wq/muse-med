import {readFile,lstat} from 'node:fs/promises';
import {createMarketProxy} from './market-proxy.mjs';

/** Connect the optional cloud catalog through an explicit deployment policy file.
 * @param {object} environment Gateway environment.
 * @returns {Promise<object|undefined>} Owned proxy route, or undefined when disabled.
 */
export async function loadMarket(environment=process.env){
 if(!environment.MUSE_MARKET_CONFIG)return;
 const metadata=await lstat(environment.MUSE_MARKET_CONFIG);
 if(!metadata.isFile()||metadata.isSymbolicLink()||(process.platform!=='win32'&&(metadata.mode&0o022)!==0))throw Error('Market policy must be a regular administrator-owned file');
 const config=JSON.parse(await readFile(environment.MUSE_MARKET_CONFIG,'utf8'));
 if(!config||typeof config!=='object'||Array.isArray(config)||typeof config.upstream!=='string'||typeof config.secretFile!=='string')throw Error('Invalid market deployment policy');
 return await createMarketProxy(config);
}

/** Public website shell; all publication text is rendered through textContent. */
export const marketPage=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skills 市场 · MUSE</title><link rel="stylesheet" href="/market/style.css"><script src="/market/client.js" defer></script></head><body><header><a class="brand" href="/market">MUSE <span>创作市场</span></a><nav><a href="/">工作间</a><a href="/account">我的账号</a><a href="/login" id="login">登录</a></nav></header><main><section class="hero"><div class="eyebrow">由创作者共建</div><h1>把好方法，变成创作能力。</h1><p>发现制作团队分享的 Skills，下载到 Muse 使用。</p></section><section class="toolbar" aria-label="筛选"><div class="tabs"><button data-view="public" aria-pressed="true">发现</button><button data-view="mine" aria-pressed="false">创作者中心</button></div><form id="search"><label class="sr" for="query">搜索市场</label><input id="query" type="search" maxlength="200" placeholder="搜索名称、用途或制作团队"><button>搜索</button></form></section><p id="notice" role="status" aria-live="polite"></p><section id="creator" hidden><h2>上传新版本</h2><p>上传完整的 Muse 发布包（ZIP）。上传后保存为私有草稿，请检查详情后提交审核。</p><form id="upload"><label>发布团队<select id="publisher" required></select></label><label>发布包<input id="package" type="file" accept=".zip,application/zip" required></label><button>上传为私有草稿</button></form><details id="invite" hidden><summary>管理员：开通发布团队</summary><form id="invitation"><label>团队名称<input id="team" maxlength="100" required></label><label>成员账号 ID<input id="member" pattern="[a-f0-9]{16}" required></label><button>开通发布权限</button></form></details></section><section id="catalog" class="grid" aria-label="市场内容"></section><dialog id="detail"><button id="close" aria-label="关闭详情">×</button><div id="detail-body"></div></dialog><footer>Skill 提供可复用的方法与资源。发布内容经过审核，版本保持独立。</footer></main></body></html>`;
