// Read-only acceptance of the deployed Wiki MCP endpoint through its public SDK.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {kbToken} from './kb-token.mjs';

const accountsFile = process.env.MUSE_ACCOUNTS_FILE;
const secretFile = process.env.MUSE_KB_SECRET;
if (!accountsFile || !secretFile) throw Error('MUSE_ACCOUNTS_FILE and MUSE_KB_SECRET are required');
const {accounts} = JSON.parse(await readFile(accountsFile, 'utf8'));
const wanted = process.argv[3];
const account = accounts.find(a => !a.disabled && (!wanted || a.username === wanted));
if (!account) throw Error('No usable account for the acceptance run');
const token = kbToken((await readFile(secretFile, 'utf8')).trim(), account.id, account.revision);
const transport = new StreamableHTTPClientTransport(
  new URL(process.argv[2] ?? 'https://muse.aigc-pipeline.cn/api/kb/mcp'),
  {requestInit: {headers: {authorization: 'Bearer ' + token}}},
);
const client = new Client({name: 'muse-wiki-acceptance', version: '1.0.0'});
const required = ['wiki_capture_source', 'wiki_directory', 'wiki_search', 'wiki_read',
  'wiki_write_page', 'wiki_history', 'wiki_links', 'wiki_status', 'wiki_migration_preview'];
async function call(name, args) {
  const result = await client.callTool({name, arguments: {...args, scope: 'shared'}});
  assert.equal(result.isError ?? false, false, name);
  return JSON.parse(result.content.find(item => item.type === 'text').text);
}
try {
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(item => item.name);
  for (const name of required) assert.ok(names.includes(name), name);
  assert.ok(!names.includes('semantic_search') && !names.includes('rerank'));
  const directory = await call('wiki_directory', {limit: 1});
  assert.ok(Number.isSafeInteger(directory.total));
  assert.ok(Array.isArray(directory.items));
  const search = await call('wiki_search', {query: '验收导航', limit: 1});
  assert.equal(search.retrieval, 'fulltext');
  const migration = await call('wiki_migration_preview', {});
  assert.equal(migration.originals_preserved, true);
  assert.equal(migration.grants_preserved, true);
  const first = directory.items[0];
  if (first) {
    const read = await call('wiki_read', {id: first.id});
    assert.equal(read.id, first.id);
  }
  console.log(JSON.stringify({status: 'WIKI_MCP_OK', required_tools: required.length,
    granted_shared_items: directory.total, retrieval: search.retrieval, writes: 0}));
} finally {
  await client.close();
}
