// End-to-end acceptance: drive the deployed cloud knowledge base with the real
// MCP client library (@modelcontextprotocol/client), over public HTTPS.
//
// Run from the release tree so the client SDK resolves. Writes one clearly
// labelled test packet into the shared vault and removes it again.
import {readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {kbToken} from './kb-token.mjs';
import {searchVault} from './kb-vault.mjs';
import {openVectorIndex} from './kb-embedding.mjs';

const accountsFile = process.env.MUSE_ACCOUNTS_FILE ?? '/var/lib/muse-dev/accounts/accounts.json';
const secretFile = process.env.MUSE_KB_SECRET ?? '/var/lib/muse-dev/accounts/kb-secret';
const url = process.argv[2] ?? 'https://dev.muse.aigc-pipeline.cn/api/kb/mcp';
const wanted = process.argv[3];

const secret = (await readFile(secretFile, 'utf8')).trim();
const {accounts} = JSON.parse(await readFile(accountsFile, 'utf8'));
const account = (wanted ? accounts.find(a => a.username === wanted) : accounts.find(a => !a.disabled));
if (!account || account.disabled) throw Error('No usable account for the acceptance run');
const token = kbToken(secret, account.id, account.revision);
const vaultRoot = process.env.MUSE_KB_VAULT ?? '/var/lib/muse-dev/shared/.llm-wiki';

const marker = `KB-E2E-${Date.now()}`;
const transport = new StreamableHTTPClientTransport(new URL(url), {requestInit: {headers: {authorization: 'Bearer ' + token}}});
const client = new Client({name: 'muse-kb-acceptance', version: '1.0.0'});
const packetIds = [];
function recordNewPacket(result) {
  const message = result.content?.[0]?.text ?? '';
  const id = message.match(/来源包：(SRC-\d{4}-\d{2}-\d{2}-\d{3})\b/)?.[1];
  if (result.isError || !message.startsWith('已写入云端知识库') || !id) throw Error('acceptance fixture was not newly ingested');
  packetIds.push(id);
  return id;
}
try {
  await client.connect(transport);
  console.log('connected:', JSON.stringify(client.getServerVersion?.() ?? {}));

  const tools = (await client.listTools()).tools;
  console.log('tools:', tools.map(tool => tool.name).sort().join(', '));
  if (tools.map(tool => tool.name).sort().join(',') !== 'ingest,search,status') throw Error('Unexpected tool set');

  const before = await client.callTool({name: 'status', arguments: {}});
  console.log('status:', before.content[0].text.replace(/\s+/g, ' '));

  const ingest = await client.callTool({name: 'ingest', arguments: {
    title: `${marker} 验收来源包`,
    text: `这条记录由端到端验收写入，用于确认本地 agent 能通过 MCP 把会话写进云端知识库。标记：${marker}`,
    source: `acceptance/${marker}`,
  }});
  console.log('ingest:', ingest.content[0].text.replace(/\s+/g, ' '));
  recordNewPacket(ingest);

  const search = await client.callTool({name: 'search', arguments: {query: marker}});
  console.log('search:', search.content[0].text.replace(/\s+/g, ' ').slice(0, 200));
  if (!search.content[0].text.includes(marker)) throw Error('search did not recall the ingested packet');

  // This paraphrase shares no search word with the document. Recalling it
  // verifies actual vector participation, rather than just a vectorized label.
  const semanticQuery = '怎样避免主角毫无缘由地变心？';
  const semanticIngest = await client.callTool({name: 'ingest', arguments: {
    title: '人物连贯性复核',
    text: '核对人物动机与行动因果，保持性格变化的连贯性。',
    source: `acceptance/${marker}/semantic`,
  }});
  const semanticId = recordNewPacket(semanticIngest);
  const lexical = await searchVault(vaultRoot, {query: semanticQuery, limit: 20});
  if (lexical.results.some(result => result.id === semanticId)) throw Error('semantic fixture is reachable lexically; acceptance is not meaningful');
  const semantic = await client.callTool({name: 'search', arguments: {query: semanticQuery, limit: 20}});
  if (!semantic.content[0].text.includes(`id: ${semanticId}`)) {
    const returned = [...semantic.content[0].text.matchAll(/id: ([^\s]+)/g)].map(match => match[1]);
    throw Error(`semantic-only paraphrase ${semanticId} was not recalled (${semantic.content[0].text.slice(0, 24).replace(/\s+/g, ' ')}); returned ${returned.length} ids: ${returned.join(',')}`);
  }
  console.log('semantic-only recall:', semanticId);

  const longQuery = '航天员通过什么线索发现外星生命？';
  const longIngest = await client.callTool({name: 'ingest', arguments: {
    title: '异域遗迹档案',
    text: '平静的小镇里，清晨的面包店照常营业。'.repeat(400)
      + '科考团队从红色天体的岩石里鉴别出非地球的微小有机体。'.repeat(250),
    source: `acceptance/${marker}/long`,
  }});
  const longId = recordNewPacket(longIngest);
  const longLexical = await searchVault(vaultRoot, {query: longQuery, limit: 20});
  if (longLexical.results.some(result => result.id === longId)) throw Error('long fixture is reachable lexically');
  const longSearch = await client.callTool({name: 'search', arguments: {query: longQuery, limit: 20}});
  if (!longSearch.content[0].text.includes(`id: ${longId}`)) throw Error(`long-document tail was not recalled: ${longId}`);
  console.log('long-tail semantic recall:', longId);

  const duplicate = await client.callTool({name: 'ingest', arguments: {
    title: `${marker} 验收来源包`,
    text: `这条记录由端到端验收写入，用于确认本地 agent 能通过 MCP 把会话写进云端知识库。标记：${marker}`,
    source: `acceptance/${marker}`,
  }});
  if (!/已存在|重复/.test(duplicate.content[0].text)) throw Error('duplicate ingest was not detected');

  console.log('E2E_OK');
} finally {
  await client.close().catch(() => {});
  for (const id of packetIds) {
    // Never delete a path returned by the MCP server: restrict cleanup to a
    // freshly created test id whose on-disk manifest carries this run's marker.
    const path = join(vaultRoot, 'raw', 'sources', id);
    const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
    if (manifest.id !== id || ![`acceptance/${marker}`, `acceptance/${marker}/semantic`, `acceptance/${marker}/long`].includes(manifest.source)) {
      throw Error(`refusing to remove a packet not owned by this acceptance run: ${id}`);
    }
    await rm(path, {recursive: true});
    console.log('cleaned test packet:', id);
  }
  if (packetIds.length) {
    const file = process.env.MUSE_KB_VECTORS ?? '/var/lib/muse-dev/kb/embeddings.json';
    let model;
    try { model = JSON.parse(await readFile(file, 'utf8')).model; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (model !== undefined) {
      if (typeof model !== 'string' || !model) throw Error('refusing to clean an index without a valid model');
      const vectors = openVectorIndex({file, model});
      vectors.refresh();
      const keep = vectors.ids();
      for (const id of packetIds) keep.delete(id);
      vectors.prune(keep);
      await vectors.save();
    }
  }
}
