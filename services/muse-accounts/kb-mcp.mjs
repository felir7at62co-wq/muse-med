// Minimal MCP endpoint (JSON-RPC over HTTP) for the cloud knowledge base.
//
// The response contract is taken from the real client this must satisfy —
// @modelcontextprotocol/client 2.0.0 StreamableHTTPClientTransport:
//   * requests (with an id) must answer 200 with `application/json` or
//     `text/event-stream`; plain JSON is accepted, so no SSE is implemented;
//   * notifications must answer 202 with no body, after which the client opens a
//     GET stream — answering 405 there is the documented "no server push" reply
//     and the client returns cleanly instead of erroring;
//   * initialize must carry `mcp-session-id` when the response is ok.
import {randomBytes} from 'node:crypto';
import {ingestSession, searchVault, collectDocuments, documentContent} from './kb-vault.mjs';
import {verifyKbToken} from './kb-token.mjs';
import {embeddingChunks} from './kb-embedding.mjs';

const LATEST = '2025-11-25';
const SUPPORTED = [LATEST, '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const MAX_BODY = 2 * 1024 * 1024;
const MAX_BATCH = 8;
const MAX_QUERY = 1000;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const TOOLS = [
  {
    name: 'search',
    description: '检索云端知识库：同时搜索原始会话包与已沉淀的知识页，返回命中标题、来源 id 与摘要。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {type: 'string', maxLength: MAX_QUERY, description: '检索关键词或问题，例如「法医线索设计」'},
        limit: {type: 'integer', minimum: 1, maximum: 20, description: '返回条数，默认 8'},
      },
      required: ['query'],
    },
  },
  {
    name: 'ingest',
    description: '把一段会话或资料写入云端知识库的原始层（不可变来源包）。相同内容重复提交不会重复入库。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: {type: 'string', description: '要归档的正文，建议先整理成 Markdown'},
        title: {type: 'string', description: '简短标题，用于检索与展示'},
        source: {type: 'string', description: '来源标识，如 local-agent/session/<会话号>'},
      },
      required: ['text'],
    },
  },
  {
    name: 'status',
    description: '查看云端知识库规模：来源包数量与知识页数量。',
    inputSchema: {type: 'object', additionalProperties: false, properties: {}},
  },
];

const text = value => ({content: [{type: 'text', text: value}]});
const failure = value => ({content: [{type: 'text', text: value}], isError: true});

function reply(id, result) { return {jsonrpc: '2.0', id, result}; }
function fault(id, code, message) { return {jsonrpc: '2.0', id, error: {code, message}}; }

export function createKbMcp({vaultRoot, accounts, secret, serverName = 'muse-kb', embedder, vectors, semanticWeight = 0.5, semanticFloor = 0.5, onWarn = () => {}} = {}) {
  if (!vaultRoot) throw new Error('vaultRoot is required');

  /** Best-effort: a vector is an enhancement, never a reason to lose a session. */
  async function remember(id, content) {
    if (!embedder?.enabled || !vectors) return false;
    try {
      const chunks = [];
      for (const part of embeddingChunks(content.title, content.text)) chunks.push(await embedder.embed(part));
      vectors.put(id, {hash: content.hash, vector: chunks.length === 1 ? chunks[0] : chunks});
      await vectors.save();
      return true;
    } catch (error) {
      onWarn(`embedding failed for ${id}: ${error.message}`);
      return false;
    }
  }

  async function callTool(name, args, account) {
    if (name === 'search') {
      const query = args?.query;
      if (typeof query !== 'string' || !query.trim() || query.length > MAX_QUERY) return failure(`query must be 1–${MAX_QUERY} characters`);
      const found = await searchVault(vaultRoot, {query, limit: args?.limit, embedder, vectors, semanticWeight, semanticFloor});
      if (!found.results.length) return text(`没有检索到与「${query.trim()}」相关的内容（已扫描 ${found.scanned} 篇）。`);
      const how = found.semantic ? '语义+关键词' : '关键词';
      return text(`检索方式：${how}\n\n` + found.results.map((entry, index) =>
        `${index + 1}. ${entry.title}\n   id: ${entry.id}\n   摘要: ${entry.preview.replace(/\s+/g, ' ').trim().slice(0, 200)}`).join('\n\n'));
    }
    if (name === 'ingest') {
      const title = typeof args?.title === 'string' && args.title.trim() ? args.title.trim() : String(args?.text ?? '').trim().split('\n')[0].slice(0, 80) || '未命名会话';
      const source = typeof args?.source === 'string' && args.source.trim() ? args.source.trim() : `cloud-kb/${account.username}`;
      const result = await ingestSession(vaultRoot, {title, text: args?.text, source, author: account.username});
      if (result.duplicate) return text(`该内容已存在，未重复入库。来源包：${result.id}`);
      const content = documentContent(args.text, result.title);
      const vectorised = await remember(result.id, content);
      return text(`已写入云端知识库。来源包：${result.id}\n路径：${result.path}\n内容校验：${result.sha256.slice(0, 16)}`
        + (embedder?.enabled ? (vectorised ? '\n已生成语义向量。' : '\n语义向量生成失败，稍后可重建；正文已安全保存。') : ''));
    }
    if (name === 'status') {
      vectors?.refresh?.();
      const documents = await collectDocuments(vaultRoot);
      const sources = documents.filter(document => !document.id.startsWith('wiki/')).length;
      const pages = documents.length - sources;
      const semantic = embedder?.enabled && vectors ? `语义检索：开启（${embedder.model}，已建向量 ${vectors.size()} 条）` : '语义检索：未配置，当前为纯关键词检索';
      return text(`云端知识库：来源包 ${sources} 个，知识页 ${pages} 页。\n${semantic}`);
    }
    throw Object.assign(new Error('Unknown tool'), {code: INVALID_PARAMS, message: `未知工具：${name}`});
  }

  async function handleMessage(message, account) {
    const id = message.id;
    const isNotification = id === undefined || id === null;
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return {message: isNotification ? null : fault(id, INVALID_REQUEST, 'Invalid JSON-RPC request'), accepted: true};
    }
    if (isNotification) return {message: null, accepted: true};
    if (message.method === 'initialize') {
      const requested = message.params?.protocolVersion;
      const protocolVersion = SUPPORTED.includes(requested) ? requested : LATEST;
      return {message: reply(id, {protocolVersion, capabilities: {tools: {}}, serverInfo: {name: serverName, version: '1.0.0'}}), session: true};
    }
    if (message.method === 'tools/list') return {message: reply(id, {tools: TOOLS})};
    if (message.method === 'tools/call') {
      const name = message.params?.name;
      if (typeof name !== 'string') return {message: fault(id, INVALID_PARAMS, 'params.name is required')};
      try {
        return {message: reply(id, await callTool(name, message.params?.arguments ?? {}, account))};
      } catch (error) {
        if (error.code === INVALID_PARAMS) return {message: fault(id, INVALID_PARAMS, error.message)};
        return {message: reply(id, {content: [{type: 'text', text: `工具执行失败：${error.message}`}], isError: true})};
      }
    }
    if (message.method === 'ping') return {message: reply(id, {})};
    return {message: fault(id, METHOD_NOT_FOUND, `Unknown method: ${message.method}`)};
  }

  return async function handle({method, headers = {}, body} = {}) {
    const authorization = headers.authorization ?? headers.Authorization ?? '';
    const token = String(authorization).replace(/^Bearer\s+/i, '').trim();
    const accountId = verifyKbToken(secret, token, accounts);
    if (!accountId) return {status: 401, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}, body: null};
    const account = accounts.get(accountId);

    if (method === 'GET' || method === 'DELETE') return {status: 405, headers: {allow: 'POST'}, body: null};
    if (method !== 'POST') return {status: 405, headers: {allow: 'POST'}, body: null};
    if (typeof body !== 'string' || body.length > MAX_BODY) return {status: 413, headers: {'content-type': 'application/json'}, body: null};

    let parsed;
    try { parsed = JSON.parse(body); }
    catch { return {status: 400, headers: {'content-type': 'application/json'}, body: JSON.stringify(fault(null, PARSE_ERROR, 'Parse error'))}; }

    const batch = Array.isArray(parsed);
    if (batch && parsed.length > MAX_BATCH) return {status: 413, headers: {'content-type': 'application/json'}, body: null};
    const messages = batch ? parsed : [parsed];
    const responses = [];
    let session = false;
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      const outcome = await handleMessage(message, account);
      if (outcome.session) session = true;
      if (outcome.message) responses.push(outcome.message);
    }
    const responseHeaders = {'content-type': 'application/json', 'cache-control': 'no-store'};
    if (session) responseHeaders['mcp-session-id'] = randomBytes(16).toString('hex');
    // Notifications alone are acknowledged with 202 and an empty body.
    if (!responses.length) return {status: 202, headers: responseHeaders, body: null};
    const payload = batch ? responses : responses[0];
    return {status: 200, headers: responseHeaders, body: JSON.stringify(payload)};
  };
}
