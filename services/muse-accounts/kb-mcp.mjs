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
import {ingestSession, collectGrantedDocuments, readOpening, readDocumentPage} from './kb-vault.mjs';
import {verifyKbToken} from './kb-token.mjs';
import {createWikiService, WIKI_TOOLS} from './kb-wiki.mjs';
import {ingestPersonalScripts, searchPersonalScripts, readPersonalScript, readPersonalOpening} from './kb-personal.mjs';

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
    name: 'ingest_script',
    description: '将本账号已复核的仿真人剧本 Markdown 按集或章节写入私有知识库，逐项返回保存、重复或失败状态与来源 ID。仅传正文和来源标识，不传视频文件。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        items: {type: 'array', minItems: 1, maxItems: 12, description: '每项是一集或一章；总请求不超过 2 MiB，长稿分批提交并核对每项结果。', items: {
          type: 'object', additionalProperties: false,
          properties: {
            title: {type: 'string', maxLength: 200, description: '可识别作品与集或章节的标题'},
            text: {type: 'string', maxLength: 400000, description: '整理并复核后的可读剧本 Markdown 正文'},
            source: {type: 'string', maxLength: 201, description: '项目内可追溯的相对来源标识，如 project/episode-01；完整链接和时间码保留在项目来源记录'},
            reviewed: {type: 'boolean', const: true, description: '已对照来源复核正文，而非直接上传未校对的语音识别片段'},
          }, required: ['title', 'text', 'source', 'reviewed'],
        }},
      }, required: ['items'],
    },
  },
  {
    name: 'status',
    description: '查看云端知识库规模：来源包数量与知识页数量。',
    inputSchema: {type: 'object', additionalProperties: false, properties: {}},
  },
  {
    name: 'read_opening',
    description: '分段读取已授权爆款剧本或本账号私有剧本开头；每次最多 6000 字，总共最多 24000 字。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        id: {type: 'string', pattern: '^(?:private/)?SRC-\\d{4}-\\d{2}-\\d{2}-\\d{3}$', description: 'search 返回的私有剧本 ID，或管理员标定 viral-script 的来源包 ID'},
        start: {type: 'integer', enum: [0, 6000, 12000, 18000], description: '已读字符范围的起点；首次省略，下一次使用结果中的下一段起点'},
      },
      required: ['id'],
    },
  },
  {
    name: 'read',
    description: '按 search 返回的来源包或知识页 ID 分页读取已授权正文，每页最多 6000 字。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        id: {type: 'string', description: 'search 返回的来源包或知识页 ID'},
        start: {type: 'integer', minimum: 0, maximum: 4194000, multipleOf: 6000, description: '已读字符范围的起点；首次省略，续读使用上一页的下一段起点'},
      },
      required: ['id'],
    },
  },
];

const text = value => ({content: [{type: 'text', text: value}]});
const failure = value => ({content: [{type: 'text', text: value}], isError: true});

function reply(id, result) { return {jsonrpc: '2.0', id, result}; }
function fault(id, code, message) { return {jsonrpc: '2.0', id, error: {code, message}}; }

export function createKbMcp({vaultRoot, personalRoot, accounts, secret, documentGrants = new Map(), authorize, serverName = 'muse-llm-wiki', onWarn = () => {}} = {}) {
  if (!vaultRoot) throw new Error('vaultRoot is required');
  const wiki = createWikiService({vaultRoot, personalRoot, documentGrants});

  const canAccess = (id, account, level) => {
    const grant = documentGrants.get(id);
    return !!grant && (grant.accounts.has('*') || grant.accounts.has(account.id))
      && (level === 'opening' ? grant.kind === 'viral-script' && id.startsWith('SRC-') : grant.level === 'read');
  };
  const visibleGrants = account => new Map([...documentGrants].filter(([id, grant]) => (grant.accounts.has('*') || grant.accounts.has(account.id)) && (grant.level === 'read' || canAccess(id, account, 'opening'))));

  async function callTool(name, args, account, mode) {
    if (name.startsWith('wiki_')) {
      const value = await wiki.call(name, args, account, mode);
      return {...text(JSON.stringify(value)), structuredContent: value};
    }
    if (name === 'ingest' && (mode !== 'full' || !account.admin)) return failure('此登录会话没有共享知识库写入权限。');
    if (name === 'ingest_script') {
      if (mode !== 'account') return failure('此令牌没有用户私有知识库写入权限。');
      if (!personalRoot) return failure('用户私有知识库尚未配置。');
      const outcomes = await ingestPersonalScripts(personalRoot, account, args?.items);
      for (const item of outcomes) if (item.state !== 'failed') {
        try { item.wikiPage = await wiki.anchor(account, item.id, mode); }
        catch (error) { onWarn(`source anchor failed: ${error.message}`); item.wikiPending = true; }
      }
      return text(outcomes.map(item => item.state === 'failed'
        ? `第 ${item.index + 1} 项：失败；${item.reason}`
        : `第 ${item.index + 1} 项：${item.state === 'saved' ? '已写入' : '已存在'}；id: ${item.id}；sha256: ${item.sha256}`).join('\n')
        + '\n逐项核对全部结果；失败项未入库。原文已保存；来源页待合成。读取原文后使用 wiki_write_page 写带引用的来源、实体和概念页。');
    }
    if (name === 'read') {
      if (!args || typeof args !== 'object' || Array.isArray(args) || !Object.hasOwn(args, 'id') || Object.keys(args).some(key => key !== 'id' && key !== 'start')) return failure('read 只接受文档 id 和起点 start。');
      if (typeof args.id === 'string' && args.id.startsWith('private/wiki/')) {
        const result = await wiki.call('wiki_read', {id: args.id, ...(args.start === undefined ? {} : {start: args.start})}, account, mode);
        return {...text(`id: ${result.id}\n类型: wiki\n标题: ${result.title}\n修订: ${result.revision}\n已读字符范围: [${result.start}, ${result.end})\n下一段起点: ${result.next_start ?? '无'}\n正文:\n${result.body}`), structuredContent: result};
      }
      if (typeof args.id === 'string' && args.id.startsWith('private/')) {
        if (mode !== 'account' || !personalRoot) return failure('文档不存在或未授权。');
        const personal = await readPersonalScript(personalRoot, account.id, args.id, args.start);
        if (!personal) return failure('文档不存在或未授权。');
        return text(`id: ${personal.id}\n类型: source\n标定: user-script\n标题: ${personal.title}\n来源总字节数: ${personal.sourceBytes}\n正文页码: ${personal.start / 6000 + 1}\n已读字符范围: [${personal.start}, ${personal.endExclusive})\n后续正文未读: ${personal.truncated ? '是' : '否'}\n下一段起点: ${personal.nextStart ?? '无'}\n正文:\n${personal.body}`);
      }
      if (typeof args.id !== 'string' || !canAccess(args.id, account, 'read')) return failure('文档不存在或未授权。');
      let result;
      try { result = await readDocumentPage(vaultRoot, args.id, {start: args.start, ...documentGrants.get(args.id)}); }
      catch (error) { onWarn(`document read failed for ${args.id}: ${error.message}`); return failure('文档读取失败。'); }
      if (!result) return failure('文档不存在或未授权。');
      return text(`id: ${result.id}\n类型: ${result.type}\n标定: ${documentGrants.get(result.id).kind}\n标题: ${result.title}\n来源总字节数: ${result.sourceBytes}\n正文页码: ${result.start / 6000 + 1}\n已读字符范围: [${result.start}, ${result.endExclusive})\n后续正文未读: ${result.truncated ? '是' : '否'}\n下一段起点: ${result.nextStart ?? '无'}\n正文:\n${result.body}`);
    }
    if (name === 'read_opening') {
      if (!args || typeof args !== 'object' || Array.isArray(args) || !Object.hasOwn(args, 'id') || Object.keys(args).some(key => key !== 'id' && key !== 'start')) return failure('read_opening 只接受来源包 id 和起点 start。');
      const id = args?.id;
      if (typeof id === 'string' && id.startsWith('private/')) {
        if (mode !== 'account' || !personalRoot) return failure('开头内容不存在或未授权。');
        const personal = await readPersonalOpening(personalRoot, account.id, id, args.start);
        if (!personal) return failure('开头内容不存在或未授权。');
        return text(`id: ${personal.id}\n类型: source\n标定: user-script\n标题: ${personal.title}\n来源总字节数: ${personal.sourceBytes}\n开头页码: ${personal.start / 6000 + 1}/4\n已读字符范围: [${personal.start}, ${personal.endExclusive})\n后续正文未读: ${personal.truncated ? '是' : '否'}\n下一段起点: ${personal.nextStart ?? '无'}\n达到开头上限: ${personal.limitReached ? '是' : '否'}\n开头正文:\n${personal.opening}`);
      }
      const allowed = typeof id === 'string' && canAccess(id, account, 'opening');
      if (!allowed) return failure('开头内容不存在或未授权。');
      let result;
      try { result = await readOpening(vaultRoot, id, {start: args.start, ...documentGrants.get(id)}); }
      catch (error) { onWarn(`opening read failed for ${id}: ${error.message}`); return failure('开头内容读取失败。'); }
      if (!result) return failure('开头内容不存在或未授权。');
      return text(`id: ${result.id}\n类型: source\n标定: viral-script\n标题: ${result.title}\n来源总字节数: ${result.sourceBytes}\n开头页码: ${result.start / 6000 + 1}/4\n已读字符范围: [${result.start}, ${result.endExclusive})\n后续正文未读: ${result.truncated ? '是' : '否'}\n下一段起点: ${result.nextStart ?? '无'}\n达到开头上限: ${result.limitReached ? '是' : '否'}\n开头正文:\n${result.opening}`);
    }
    if (name === 'search') {
      const query = args?.query;
      if (typeof query !== 'string' || !query.trim() || query.length > MAX_QUERY) return failure(`query must be 1–${MAX_QUERY} characters`);
      const found = await wiki.call('wiki_search', {scope: 'shared', query, limit: args?.limit}, account, mode);
      const own = mode === 'account' && personalRoot ? await searchPersonalScripts(personalRoot, account.id, query, args?.limit) : {results: [], scanned: 0};
      const pages = mode === 'account' && personalRoot ? await wiki.call('wiki_search', {query, limit: args?.limit}, account, mode) : {results: []};
      const entries = [...new Map([...own.results, ...pages.results, ...found.results].map(entry => [entry.id, entry])).values()].slice(0, Math.min(20, Math.max(1, Number(args?.limit) || 8)));
      if (!entries.length) return text(`没有检索到与「${query.trim()}」相关的内容（已扫描 ${found.scanned + own.scanned} 篇）。`);
      const how = '关键词';
      return text(`检索方式：${how}\n\n` + entries.map((entry, index) =>
        `${index + 1}. ${entry.title}\n   id: ${entry.id}\n   类型: ${entry.type ?? (entry.id.includes('wiki/') ? 'wiki' : 'source')}\n   标定: ${entry.id.startsWith('private/') ? 'user-script' : documentGrants.get(entry.id)?.kind ?? 'unclassified'}\n   摘要: ${entry.preview.replace(/\s+/g, ' ').trim().slice(0, 200)}`).join('\n\n'));
    }
    if (name === 'ingest') {
      const title = typeof args?.title === 'string' && args.title.trim() ? args.title.trim() : String(args?.text ?? '').trim().split('\n')[0].slice(0, 80) || '未命名会话';
      const source = typeof args?.source === 'string' && args.source.trim() ? args.source.trim() : `cloud-kb/${account.username}`;
      const result = await ingestSession(vaultRoot, {title, text: args?.text, source, author: account.username});
      if (result.duplicate) return text(`该内容已存在，未重复入库。来源包：${result.id}`);

      return text(`已写入云端知识库。来源包：${result.id}\n内容校验：${result.sha256.slice(0, 16)}`);
    }
    if (name === 'status') {

      const documents = await collectGrantedDocuments(vaultRoot, visibleGrants(account));
      const own = mode === 'account' && personalRoot ? await searchPersonalScripts(personalRoot, account.id, '', 1) : {scanned: 0};
      const sources = documents.filter(document => !document.id.startsWith('wiki/')).length;
      const pages = documents.length - sources;
      const semantic = 'Wiki 检索：目录、全文关键词与页面链接';
      return text(`云端知识库：已授权来源包 ${sources} 个，知识页 ${pages} 页，本账号私有剧本 ${own.scanned} 个。\n${semantic}`);
    }
    throw Object.assign(new Error('Unknown tool'), {code: INVALID_PARAMS, message: `未知工具：${name}`});
  }

  async function handleMessage(message, account, mode) {
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
    if (message.method === 'tools/list') return {message: reply(id, {tools: [...TOOLS, ...WIKI_TOOLS].filter(tool => tool.name === 'ingest' ? mode === 'full' && account.admin : tool.name === 'ingest_script' ? mode === 'account' : true)})};
    if (message.method === 'tools/call') {
      const name = message.params?.name;
      if (typeof name !== 'string') return {message: fault(id, INVALID_PARAMS, 'params.name is required')};
      try {
        return {message: reply(id, await callTool(name, message.params?.arguments ?? {}, account, mode))};
      } catch (error) {
        if (error.code === INVALID_PARAMS) return {message: fault(id, INVALID_PARAMS, error.message)};
        if (error.wikiError) return {message: reply(id, failure(error.message))};
        onWarn(`knowledge-base tool ${name} failed: ${error.message}`);
        return {message: reply(id, failure('知识库工具执行失败，请稍后重试。'))};
      }
    }
    if (message.method === 'ping') return {message: reply(id, {})};
    return {message: fault(id, METHOD_NOT_FOUND, `Unknown method: ${message.method}`)};
  }

  return async function handle({method, headers = {}, body} = {}) {
    const authorization = headers.authorization ?? headers.Authorization ?? '';
    const token = String(authorization).replace(/^Bearer\s+/i, '').trim();
    const delegated = authorize?.(token);
    const accountId = delegated?.account?.id ?? verifyKbToken(secret, token, accounts);
    if (!accountId) return {status: 401, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}, body: null};
    const account = accounts.get(accountId);
    const mode = delegated?.mode ?? 'full';

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
      const outcome = await handleMessage(message, account, mode);
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
