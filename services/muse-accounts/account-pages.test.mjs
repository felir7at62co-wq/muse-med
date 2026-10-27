/** Account/admin page projections use synthetic identities and no external requests. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {renderAccountIdentity,renderAdminAccounts} from './account-pages.mjs';

const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const account=(id,overrides={})=>({id,username:'writer-'+id,admin:false,disabled:false,createdAt:'2026-10-20T00:00:00.000Z',lastLoginAt:null,lastActivityAt:null,passwordLogin:true,feishuIdentities:[],...overrides});
const identity=(overrides={})=>({appId:'cli_synthetic',tenantKey:'synthetic_tenant',openId:'ou_synthetic',name:'测试编剧',boundAt:'2026-10-25T00:00:00.000Z',lastLoginAt:'2026-10-26T00:00:00.000Z',...overrides});
function fixture(overrides={}){
 const admin=account('administrator',{admin:true,username:'ylk'});
 return {accounts:[admin],session:{id:admin.id,account:admin},devicesOf:()=>[],adminCentre:false,adminHosts:{},now:Date.parse('2026-10-26T00:30:00.000Z'),feishuEnabled:true,escape,page:(title,body)=>`<!doctype html><title>${escape(title)}</title><main>${body}</main>`,environment:'production',...overrides};
}
const totals=html=>[...html.match(/<section aria-label="使用概览">[\s\S]*?<\/section>/)[0].matchAll(/<strong>(\d+)<\/strong>/g)].map(match=>Number(match[1]));

test('account identity renders escaped verified names and organizations without external avatars',()=>{
 const html=renderAccountIdentity({account:account('writer',{passwordLogin:false,feishuIdentities:[identity({name:'<img src=x onerror=alert(1)>',tenantKey:'tenant"<&',avatarUrl:'https://external.example.test/private-avatar.png'})]}),feishuEnabled:true,escape});
 assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.match(html,/tenant&quot;&lt;&amp;/);
 assert.doesNotMatch(html,/<img|<script|external\.example/);assert.match(html,/action="\/auth\/feishu\/bind" method="post"/);
 assert.match(html,/尚未设置密码/);assert.match(html,/账号权限保持不变/);
});

test('unbound, organization-free and disabled-configuration identity states stay explicit',()=>{
 const missing=renderAccountIdentity({account:account('writer'),feishuEnabled:false,escape});
 assert.match(missing,/尚未绑定飞书账号/);assert.match(missing,/飞书登录暂未启用/);assert.doesNotMatch(missing,/<form/);
 const personal=renderAccountIdentity({account:account('personal',{feishuIdentities:[identity({tenantKey:null,boundAt:undefined,lastLoginAt:undefined})]}),feishuEnabled:true,escape});
 assert.match(personal,/未提供组织标识/);assert.match(personal,/首次绑定：未记录/);assert.doesNotMatch(personal,/Invalid Date|个人用户/);
});

test('the internal self-built application explains its member scope without changing unconfigured pages',()=>{
 const options={account:account('writer'),feishuEnabled:true,escape};
 const custom=renderAccountIdentity({...options,feishuAppType:'custom'});assert.match(custom,/仅限本企业应用可用范围内的成员/);
 assert.doesNotMatch(renderAccountIdentity({...options,feishuAppType:'store'}),/仅限本企业/);
 assert.doesNotMatch(renderAccountIdentity(options),/仅限本企业/);
});

test('administrator overview separates accounts, bound users and deduplicated live desktops',()=>{
 const options=fixture(),writer=account('writer',{feishuIdentities:[identity(),identity({openId:'ou_second',tenantKey:null})]}),disabled=account('disabled',{disabled:true,feishuIdentities:[identity({openId:'ou_disabled'})]});
 options.accounts.push(writer,disabled);
 options.devicesOf=id=>id==='writer'?[{id:'one',state:'online'},{id:'one',state:'online'},{id:'two',state:'online'},{id:'offline',state:'offline'}]:id==='disabled'?[{id:'disabled-device',state:'online'}]:[];
 const html=renderAdminAccounts(options);
 assert.deepEqual(totals(html),[3,2,1,1,1,2,2,0,0]);
 assert.match(html,/注册数含测试账号，不等于独立用户人数/);assert.match(html,/后台心跳不计使用/);
 assert.match(html,/最近登录/);assert.match(html,/最近使用/);assert.doesNotMatch(html,/Invalid Date|undefined/);
});

test('usage windows use Beijing day boundaries and only explicit activity from enabled accounts',()=>{
 const options=fixture({now:Date.parse('2026-10-26T00:30:00.000Z')});
 options.accounts.push(
  account('today',{lastActivityAt:'2026-10-25T16:00:00.000Z'}),
  account('yesterday',{lastActivityAt:'2026-10-25T15:59:59.999Z'}),
  account('week-start',{lastActivityAt:'2026-10-19T16:00:00.000Z'}),
  account('before-week',{lastActivityAt:'2026-10-19T15:59:59.999Z'}),
  account('login-only',{lastLoginAt:'2026-10-26T00:00:00.000Z'}),
  account('future',{lastActivityAt:'2026-10-26T01:00:00.000Z'}),
  account('disabled-active',{disabled:true,lastActivityAt:'2026-10-26T00:00:00.000Z'})
 );
 const html=renderAdminAccounts(options);assert.deepEqual(totals(html).slice(-2),[1,3]);
 assert.match(html,/按北京时间/);
});

test('existing self protection, password reset and elevated management forms remain separate',()=>{
 const options=fixture({adminCentre:true,adminHosts:{server:{},'local"<&':{}},environment:'development'});options.accounts.push(account('other'),account('disabled',{disabled:true}));
 const html=renderAdminAccounts(options);
 assert.match(html,/当前账号/);assert.match(html,/href="\/account">修改密码/);
 assert.doesNotMatch(html,/<form action="\/admin\/disable"[^]*?name="id" value="administrator"/);
 assert.match(html,/action="\/admin\/reset" method="post"/);assert.match(html,/placeholder="新密码"/);
 assert.match(html,/action="\/admin\/control\/open" method="post" target="_blank"/);assert.match(html,/验证独立口令/);
 assert.match(html,/value="local&quot;&lt;&amp;"/);assert.match(html,/开发验证环境/);
 const noCentre=renderAdminAccounts({...options,adminCentre:false});assert.doesNotMatch(noCentre,/\/admin\/control|整机入口/);
 assert.throws(()=>renderAdminAccounts({...options,session:{id:'other',account:account('other')}}),/Administrator account required/);
});

test('administrator table escapes identity and account text without exposing unknown credential fields',()=>{
 const options=fixture();options.accounts.push(account('row"<&',{username:'<script>alert(1)</script>',feishuIdentities:[identity({name:'<b>name</b>',tenantKey:'tenant<script>',accessToken:'synthetic-secret'})]}));
 const html=renderAdminAccounts(options);
 assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);assert.match(html,/&lt;b&gt;name&lt;\/b&gt;/);assert.match(html,/tenant&lt;script&gt;/);
 assert.match(html,/value="row&quot;&lt;&amp;"/);assert.doesNotMatch(html,/<script|synthetic-secret/);
});

test('the current Feishu-only administrator has no unusable password-change link',()=>{
 const options=fixture();options.accounts[0].passwordLogin=false;
 const html=renderAdminAccounts(options);assert.match(html,/<td>飞书登录<\/td>/);assert.doesNotMatch(html,/href="\/account">修改密码/);
});
