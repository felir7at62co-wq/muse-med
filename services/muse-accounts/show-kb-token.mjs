#!/usr/bin/env node
// Issue cloud knowledge base tokens for local agents.
//
//   node show-kb-token.mjs                # list every account and its token
//   node show-kb-token.mjs ylk            # one account
//
// Tokens are derived, not stored: a password reset, administrator reset or
// account disable bumps the revision and retires the old token automatically.
import {readFile} from 'node:fs/promises';
import {kbToken} from './kb-token.mjs';

const accountsFile = process.env.MUSE_ACCOUNTS_FILE ?? '/var/lib/muse/accounts/accounts.json';
const secretFile = process.env.MUSE_KB_SECRET ?? '/var/lib/muse/accounts/kb-secret';
const endpoint = process.env.MUSE_KB_URL ?? 'https://muse.aigc-pipeline.cn/api/kb/mcp';

const secret = (await readFile(secretFile, 'utf8').catch(() => '')).trim();
if (secret.length < 32) {
  console.error(`知识库密钥缺失或过短：${secretFile}（需 ≥32 字符）`);
  process.exit(1);
}
const {accounts} = JSON.parse(await readFile(accountsFile, 'utf8'));
const wanted = process.argv[2];
const rows = accounts.filter(account => !wanted || account.username === wanted);
if (!rows.length) {
  console.error(wanted ? `没有名为 ${wanted} 的账号` : '没有账号');
  process.exit(1);
}
console.log(`端点：${endpoint}`);
console.log('本地 DSH 配置（headers 里放这一行；不要写进 URL 或提交到仓库）：');
for (const account of rows) {
  if (account.disabled) {
    console.log(`\n${account.username}：账号已停用，令牌不可用`);
    continue;
  }
  console.log(`\n${account.username}`);
  console.log(`  Authorization: Bearer ${kbToken(secret, account.id, account.revision)}`);
  console.log(`  # 工具名前缀：mcp__kb__search / mcp__kb__ingest / mcp__kb__status`);
}
