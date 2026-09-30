// Muse LLM Wiki: immutable captures, cited Markdown, revision history, and lexical navigation.
import {lstat, mkdir, readdir, writeFile, rename, rm, rmdir, link} from 'node:fs/promises';
import {createHash, randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {validId} from './store.mjs';
import {ingestSession, collectDocuments, collectGrantedDocuments, readRegularPage, validDocumentId} from './kb-vault.mjs';
import {buildWikilinkIndex, resolveWikilink, extractWikilinks, sourcePageSkeleton} from './kb-wiki-links.mjs';
import {recordProjectParticipation} from './kb-participation.mjs';
import {readProjectPortfolio} from './kb-portfolio.mjs';

const MAX_TEXT = 100_000, MAX_QUERY = 1000, PAGE_SIZE = 6000;
// JSON can expand each byte of a 4 MiB legacy document into a six-byte escape.
const REVISION_LIMIT = 6 * 4 * 1024 * 1024 + 128 * 1024;
const SOURCE_ID = /^SRC-\d{4}-\d{2}-\d{2}-\d{3}$/;
const HASH = /^[a-f0-9]{64}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw Object.assign(new Error(message), {wikiError: true}); };
const scopeFields = {
  scope: {type: 'string', enum: ['private', 'project', 'shared'], description: '知识范围，默认 private；shared 仅管理员可写。'},
  project_id: {type: 'string', maxLength: 80, description: 'scope 为 project 时必填的账号内项目 ID，不接受路径或磁盘根目录。'},
};
const idFields = {id: {type: 'string', maxLength: 500, description: '目录或检索结果中的来源/页面 ID。'}};
const tool = (name, description, properties = {}, required = []) => ({
  name, description, inputSchema: {type: 'object', additionalProperties: false,
    properties: ['wiki_record_project', 'wiki_project_portfolio'].includes(name) ? properties : {...scopeFields, ...properties}, required},
});

/** The discoverable MCP operations for capture, synthesis, and bounded navigation. */
export const WIKI_TOOLS = [
  tool('wiki_project_portfolio', '浏览 Muse 项目参与组合。普通登录仅查看本人；经部署授权的组合管理员可查看全部启用账号，并按 account_id 筛选。省略 project_key 分页列出项目及阶段状态统计；指定 project_key 分页读取计划和实际工作摘要、状态及产物引用。仅返回记录器维护的参与记录，不返回原始资料或其他私人 Wiki。', {
    account_id: {type: 'string', pattern: '^[a-f0-9]{16}$', description: '账户不可变 ID；普通用户只能选择本人，组合管理员可选择其他启用账户。'},
    project_key: {type: 'string', maxLength: 75, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,74}$', description: '稳定项目标识；填写后分页读取该项目的参与记录，省略时列出项目。'},
    start: {type: 'integer', minimum: 0, maximum: 1000000, description: '项目或参与记录列表的续读起点，默认 0。'},
    limit: {type: 'integer', minimum: 1, maximum: 50, description: '每页条数，默认 30。'},
  }),
  tool('wiki_record_project', '主动登记 Muse 参与的项目、计划与实际工作、阶段状态和产物引用，保存账号记录并读回；本人和经部署授权的组合管理员可用 wiki_project_portfolio 查看。完成状态来自阶段汇报，不能把待生成任务记作已完成。', {
    project_key: {type: 'string', maxLength: 75, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,74}$', description: '稳定项目标识，已有剧变绑定用 jubian-<script_id>；否则使用持久化项目 UUID，同名不同项目不能复用。'},
    project_title: {type: 'string', maxLength: 160, description: '面向用户的项目名称。'},
    contribution_id: {type: 'string', maxLength: 80, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$', description: '稳定阶段标识；同一阶段进度更新复用，重试不换 ID。'},
    stage: {type: 'string', maxLength: 100, description: '本次参与的具体阶段，例如改编、大纲、分镜或剪辑。'},
    status: {type: 'string', enum: ['planned', 'in_progress', 'completed', 'blocked', 'cancelled'], description: '如实区分计划、进行中、完成、受阻和取消。'},
    content: {type: 'string', maxLength: 5000, description: '计划或实际参与内容、检查结果与未完成项，不含凭证、推理文本或无关会话。'},
    artifacts: {type: 'array', maxItems: 20, items: {type: 'string', maxLength: 240}, description: '项目相对文件路径或稳定任务引用，例如 deliverables/EP01.md、jubian:499887；不传绝对磁盘路径或带密钥的 URL。'},
  }, ['project_key', 'project_title', 'contribution_id', 'stage', 'status', 'content', 'artifacts']),
  tool('wiki_capture_source', '保存不可变原始资料并建立待合成的来源页；继续读取来源，用 wiki_write_page 写带引用的总结、实体和概念页。', {
    title: {type: 'string', maxLength: 200, description: '资料标题。'},
    text: {type: 'string', maxLength: 400000, description: '原始 Markdown 正文，重复正文不重复保存。'},
    source: {type: 'string', maxLength: 200, description: '项目相对来源标识，例如 project/episode-01。'},
  }, ['title', 'text', 'source']),
  tool('wiki_directory', '列出知识目录中的来源页、概念页和实体页，返回页面 ID 与修订号。', {
    folder: {type: 'string', maxLength: 400, description: '页面目录前缀，例如 concepts；省略列出全部。'},
    start: {type: 'integer', minimum: 0, description: '列表续读起点，默认 0。'},
    limit: {type: 'integer', minimum: 1, maximum: 50, description: '每次条数，默认 30。'},
  }),
  tool('wiki_search', '对当前知识范围做全文关键词检索，返回匹配摘录与可读取的来源/页面 ID。', {
    query: {type: 'string', maxLength: MAX_QUERY, description: '全文关键词。'},
    limit: {type: 'integer', minimum: 1, maximum: 20, description: '返回条数，默认 8。'},
  }, ['query']),
  tool('wiki_read', '按 ID 分页读原文或知识页，返回修订号、引用和下一段起点；可读取指定历史修订。', {
    ...idFields, start: {type: 'integer', minimum: 0, multipleOf: PAGE_SIZE, description: '字符起点，默认 0，续读使用 next_start。'},
    revision: {type: 'integer', minimum: 0, description: '历史页面修订号，省略读当前版；旧页面导入前的原文为 0。'},
  }, ['id']),
  tool('wiki_write_page', '写入经过综合整理的知识页。必须带可核对的原文引用和当前修订号；新页 expected_revision 为 0，修订冲突时先重读。', {
    page_id: {type: 'string', maxLength: 400, description: '范围内的页面路径，例如 concepts/opening-hook，不带 wiki/ 或 .md。'},
    title: {type: 'string', maxLength: 200, description: '页面标题。'},
    text: {type: 'string', maxLength: MAX_TEXT, description: '综合后的 Markdown；用 [[concepts/name]]、[[entities/name]]、[[sources/SRC-...]] 链接现有页。'},
    expected_revision: {type: 'integer', minimum: 0, description: 'wiki_read/wiki_directory 返回的当前修订；新页为 0。'},
    citations: {type: 'array', minItems: 1, maxItems: 64, description: '支撑结论的原文字符范围，不接受页面 ID 代替原始资料。', items: {
      type: 'object', additionalProperties: false, properties: {
        id: {type: 'string', description: '可读取的不可变来源 ID。'},
        start: {type: 'integer', minimum: 0, description: 'Unicode 字符范围起点。'},
        end: {type: 'integer', minimum: 1, description: 'Unicode 字符范围终点，不含该字符；每条最多 6000 字。'},
      }, required: ['id', 'start', 'end'],
    }},
  }, ['page_id', 'title', 'text', 'expected_revision', 'citations']),
  tool('wiki_history', '列出页面的不可变历史修订，可用 wiki_read 的 revision 读取。', {...idFields,
    start: {type: 'integer', minimum: 0, description: '历史列表续读起点，默认 0。'},
    limit: {type: 'integer', minimum: 1, maximum: 50, description: '每次条数，默认 30。'},
  }, ['id']),
  tool('wiki_links', '查看页面的向外链接、引用来源、反向链接与尚未解析的链接。', idFields, ['id']),
  tool('wiki_status', '查看当前登录账号的私有、项目和已授权共享 Wiki 数量与检索方式。'),
  tool('wiki_migration_preview', '预览现有来源包和旧知识页的接入情况，列出缺少来源页的 ID；不改动原件或授权。'),
];

function safeSegment(value) {
  return typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,79}$/u.test(value)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
}
function pagePath(value) {
  return typeof value === 'string' && value.length <= 400 && value.split('/').every(safeSegment);
}
function bounded(value, fallback, maximum, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > maximum) fail(`Invalid ${label}`);
  return value;
}
async function directory(path, create = false) {
  if (create) {
    try { await mkdir(path, {mode: 0o700}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const info = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) fail('Wiki directory must be a regular directory');
  return true;
}
async function descend(base, parts, create = false) {
  if (!await directory(base, create)) return null;
  let path = base;
  for (const part of parts) {
    path = join(path, part);
    if (!await directory(path, create)) return null;
  }
  return path;
}

function visibleCitations(citations, references) {
  return citations.flatMap(citation => {
    const source = references.find(item => item.id === citation.id && item.type === 'source');
    if (!source || source.sha256 !== citation.sha256) return [];
    const chars = Array.from(source.body);
    if (citation.start < 0 || citation.end > chars.length || citation.end <= citation.start) return [];
    return [{id: citation.id, start: citation.start, end: citation.end, sha256: citation.sha256,
      excerpt: chars.slice(citation.start, Math.min(citation.end, citation.start + 240)).join('')}];
  });
}

async function immutableJson(path, value) {
  const staging = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(staging, JSON.stringify(value) + '\n', {flag: 'wx', mode: 0o600});
  try { await link(staging, path); } finally { await rm(staging, {force: true}); }
}
async function lock(root, action) {
  const path = join(root, '.wiki.lock');
  try { await mkdir(path, {mode: 0o700}); }
  catch (error) {
    if (error.code === 'EEXIST') fail('Wiki is busy; reload the page before retrying. An abandoned lock requires administrator inspection.');
    throw error;
  }
  try { return await action(); } finally { await rmdir(path); }
}

/** Create an account-authenticated Wiki store over the existing raw-source vaults.
 * @param {object} options Shared/personal roots, current accounts and administrator-owned document and portfolio permissions.
 * @returns {object} MCP dispatcher, source anchor writer, and lexical search adapter.
 */
export function createWikiService({vaultRoot, personalRoot, documentGrants = new Map(), accounts, portfolioReaders = new Set()} = {}) {
  const visibleGrants = account => new Map([...documentGrants].filter(([, grant]) =>
    grant.accounts.has('*') || grant.accounts.has(account.id)));
  const descriptor = async (args, account, mode, create = false) => {
    const scope = args.scope ?? (typeof args.id === 'string' && (args.id.startsWith('wiki/') || SOURCE_ID.test(args.id)) ? 'shared' : 'private');
    if (!['private', 'shared', 'project'].includes(scope)) fail('scope must be private, project, or shared');
    if (scope !== 'project' && args.project_id !== undefined) fail('project_id requires project scope');
    if (scope === 'shared') {
      if (create && !account.admin) fail('Shared Wiki writes require an administrator account.');
      if (!await directory(vaultRoot, create)) return {scope, root: null, prefix: ''};
      return {scope, root: vaultRoot, prefix: ''};
    }
    if (!['account', 'admin'].includes(mode)) fail('Account login is required for private and project Wiki.');
    if (!personalRoot || !validId(account.id)) fail('Account Wiki is not configured.');
    const parts = [account.id];
    if (scope === 'project') {
      if (!safeSegment(args.project_id)) fail('A safe account-owned project_id is required.');
      parts.push('projects', args.project_id);
    }
    return {scope, root: await descend(personalRoot, parts, create),
      prefix: scope === 'private' ? 'private/' : `project/${args.project_id}/`};
  };
  const scopedId = (d, local) => d.prefix + local;
  const localId = (d, id) => {
    if (typeof id !== 'string' || !id.startsWith(d.prefix)) fail('Document does not exist or is not authorized.');
    const local = id.slice(d.prefix.length);
    if (!validDocumentId(local)) fail('Invalid document ID');
    return local;
  };
  const historyRoot = (d, pageId, create = false) => descend(d.root, ['meta', 'wiki-history', digest(pageId)], create);
  async function revisions(d, pageId) {
    const dir = d.root && await historyRoot(d, pageId);
    if (!dir) return [];
    const records = [];
    for (const entry of await readdir(dir, {withFileTypes: true})) {
      if (!entry.isFile() || !/^(0|[1-9]\d*)\.json$/.test(entry.name)) continue;
      const body = await readRegularPage(join(dir, entry.name), {maxChars: REVISION_LIMIT, maxBytes: REVISION_LIMIT});
      if (body === null) continue;
      const value = JSON.parse(body);
      if (value.version !== 1 || value.page_id !== pageId || value.revision !== Number(entry.name.slice(0, -5))
        || typeof value.body !== 'string' || Buffer.byteLength(value.body) > 4 * 1024 * 1024 || value.sha256 !== digest(value.body)
        || !Array.isArray(value.citations) || value.citations.length > 64 || typeof value.title !== 'string'
        || !['legacy', 'skeleton', 'synthesized'].includes(value.status)
        || typeof value.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.created_at)
        || value.citations.some(citation => !citation || typeof citation.id !== 'string' || citation.id.length > 500
          || !HASH.test(citation.sha256) || !Number.isInteger(citation.start) || !Number.isInteger(citation.end)
          || citation.start < 0 || citation.end <= citation.start || citation.end - citation.start > PAGE_SIZE
          || typeof citation.excerpt !== 'string' || citation.excerpt.length > 480)) fail('Invalid Wiki revision record; administrator inspection required.');
      records.push(value);
    }
    return records.sort((a, b) => b.revision - a.revision);
  }
  async function documents(d, account) {
    if (!d.root) return [];
    if (d.scope === 'shared') {
      const grants = visibleGrants(account);
      const loaded = (await collectGrantedDocuments(d.root, grants, {fullText: true})).map(item => ({...item,
        body: grants.get(item.id).level === 'opening' ? Array.from(item.body).slice(0, 24000).join('') : item.body,
        sha256: grants.get(item.id).sha256, type: SOURCE_ID.test(item.id) ? 'source' : 'wiki'}));
      return Promise.all(loaded.map(async item => {
        const opening = grants.get(item.id).level === 'opening';
        const body = opening ? Array.from(item.body).slice(0, 24000).join('') : item.body;
        const archived = item.id.startsWith('wiki/') ? (await revisions(d, item.id.slice(5))).find(record => record.sha256 === grants.get(item.id).sha256) : null;
        return {...item, ...archived, title: item.title, body, sha256: grants.get(item.id).sha256,
          type: SOURCE_ID.test(item.id) ? 'source' : 'wiki', revision: archived?.revision ?? 0, status: archived?.status ?? 'legacy',
          citations: visibleCitations(archived?.citations ?? [], loaded), local: item.id, id: item.id, opening};
      }));
    }
    // Private vault ancestors cannot redirect the reader into another account's files.
    await Promise.all(['raw', 'wiki', 'meta'].map(name => directory(join(d.root, name))));
    await descend(d.root, ['raw', 'sources']);
    const found = await collectDocuments(d.root);
    const result = [];
    for (const item of found) {
      if (SOURCE_ID.test(item.id)) {
        const packet = await descend(d.root, ['raw', 'sources', item.id]);
        if (!packet) continue;
        const manifestText = await readRegularPage(join(packet, 'manifest.json'));
        if (!manifestText) continue;
        const manifest = JSON.parse(manifestText);
        const body = await readRegularPage(join(packet, 'extracted.md'));
        if (body === null || manifest.id !== item.id || !HASH.test(manifest.content_sha256)
          || manifest.content_sha256 !== digest(body)) continue;
        result.push({...item, body, title: manifest.title, sha256: manifest.content_sha256,
          local: item.id, id: scopedId(d, item.id), type: 'source', revision: 0, citations: []});
      } else {
        const latest = (await revisions(d, item.id.slice(5)))[0];
        result.push({...item, ...latest, local: item.id, id: scopedId(d, item.id),
          type: 'wiki', revision: latest?.revision ?? 0, status: latest?.status ?? 'legacy',
          sha256: latest?.sha256 ?? digest(item.body), citations: latest?.citations ?? []});
      }
    }
    // A committed revision remains readable if a crash prevented its Markdown projection.
    const history = await descend(d.root, ['meta', 'wiki-history']);
    if (history) for (const entry of await readdir(history, {withFileTypes: true})) {
      if (!entry.isDirectory() || !HASH.test(entry.name)) continue;
      const dir = join(history, entry.name), files = await readdir(dir, {withFileTypes: true});
      const first = files.find(file => file.isFile() && /^(0|[1-9]\d*)\.json$/.test(file.name));
      if (!first) continue;
      const value = JSON.parse(await readRegularPage(join(dir, first.name), {maxChars: REVISION_LIMIT, maxBytes: REVISION_LIMIT}));
      if (!pagePath(value.page_id) || digest(value.page_id) !== entry.name) fail('Invalid Wiki history directory');
      if (result.some(item => item.local === 'wiki/' + value.page_id)) continue;
      const latest = (await revisions(d, value.page_id))[0];
      if (latest) result.push({...latest, local: 'wiki/' + value.page_id,
        id: scopedId(d, 'wiki/' + value.page_id), type: 'wiki'});
    }
    return result;
  }
  function metadata(item) {
    return {id: item.id, title: item.title, type: item.type, revision: item.revision,
      ...(item.status ? {status: item.status} : {}), sha256: item.sha256};
  }
  async function commit(d, account, pageId, title, body, citations, expected, status = 'synthesized') {
    return lock(d.root, async () => {
      const available = await documents(d, account), existing = available.find(item => item.local === 'wiki/' + pageId);
      const archived = await revisions(d, pageId), current = archived[0]?.revision ?? existing?.revision ?? 0;
      if (d.scope === 'shared') {
        const parent = await descend(d.root, ['wiki', ...pageId.split('/').slice(0, -1)], false);
        const projection = parent && await lstat(join(parent, pageId.split('/').at(-1) + '.md')).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if ((archived.length || projection) && !existing) fail('Existing shared page updates require a current full-read grant.');
      }
      if (current !== expected) fail(`Revision conflict: expected ${expected}, current ${current}; read the page and merge before retrying.`);
      const dir = await historyRoot(d, pageId, true);
      if (existing && !archived.length) await immutableJson(join(dir, '0.json'), {
        version: 1, page_id: pageId, revision: 0, title: existing.title, body: existing.body,
        sha256: digest(existing.body), citations: [], status: 'legacy', author: account.username, created_at: new Date().toISOString(),
      });
      const revision = current + 1;
      const record = {version: 1, page_id: pageId, revision, title, body, sha256: digest(body),
        citations, status, author: account.username, created_at: new Date().toISOString()};
      const parent = await descend(d.root, ['wiki', ...pageId.split('/').slice(0, -1)], true);
      const target = join(parent, pageId.split('/').at(-1) + '.md');
      const existingFile = await lstat(target).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
      if (existingFile && (!existingFile.isFile() || existingFile.isSymbolicLink())) fail('Wiki page must be a regular file');
      await immutableJson(join(dir, revision + '.json'), record);
      let projectionPending = false;
      const staging = target + '.' + randomBytes(8).toString('hex') + '.tmp';
      try {
        await writeFile(staging, body, {flag: 'wx', mode: 0o600});
        await rename(staging, target);
      } catch (error) {
        projectionPending = true;
      } finally { await rm(staging, {force: true}); }
      return {id: scopedId(d, 'wiki/' + pageId), revision, sha256: record.sha256, status,
        ...(projectionPending ? {projection_pending: true} : {}),
        ...(d.scope === 'shared' ? {grant_update_required: true} : {})};
    });
  }
  async function anchor(account, id, mode = 'account', args = {}) {
    const d = await descriptor(args, account, mode, true), local = localId(d, id);
    if (!SOURCE_ID.test(local)) fail('A source packet ID is required');
    const available = await documents(d, account), source = available.find(item => item.id === id);
    // Shared captures need an administrator grant before source-page synthesis.
    if (!source) return {id: scopedId(d, 'wiki/sources/' + local), status: 'grant-required'};
    const pageId = 'sources/' + local, existing = available.find(item => item.local === 'wiki/' + pageId);
    if (existing) return metadata(existing);
    const end = Math.min(500, Array.from(source.body).length);
    return commit(d, account, pageId, source.title, sourcePageSkeleton(local, source.title, source.body),
      [{id, start: 0, end, sha256: source.sha256, excerpt: Array.from(source.body).slice(0, Math.min(end, 240)).join('')}], 0, 'skeleton');
  }
  async function call(name, args, account, mode) {
    const definition = WIKI_TOOLS.find(item => item.name === name);
    if (!definition) fail('Unknown Wiki tool');
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !Object.hasOwn(definition.inputSchema.properties, key))
      || definition.inputSchema.required.some(key => !Object.hasOwn(args, key))) fail('Invalid Wiki arguments');
    if (name === 'wiki_record_project') return recordProjectParticipation(args, (operation, values) => call(operation, values, account, mode));
    if (name === 'wiki_project_portfolio') return readProjectPortfolio(args, {account, mode, accounts, portfolioReaders,
      call: (operation, values, owner) => call(operation, values, owner, mode)});
    const writes = name === 'wiki_capture_source' || name === 'wiki_write_page';
    const d = await descriptor(args, account, mode, writes);
    if (name === 'wiki_capture_source') {
      if (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 200
        || typeof args.text !== 'string' || !args.text.trim() || args.text.length > 400000
        || typeof args.source !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(args.source)
        || args.source.includes('..')) fail('A title, Markdown text, and safe relative source identifier are required.');
      const saved = await ingestSession(d.root, {title: args.title, text: args.text, source: args.source, author: account.username});
      const id = scopedId(d, saved.id), page = await anchor(account, id, mode, args);
      return {source: {id, sha256: saved.sha256, title: saved.title}, duplicate: saved.duplicate, page,
        next: 'Read the original, then use wiki_write_page to synthesize cited source, entity, and concept pages.'};
    }
    const available = await documents(d, account);
    if (name === 'wiki_status') {
      const privateD = ['account', 'admin'].includes(mode) && personalRoot ? await descriptor({scope: 'private'}, account, mode) : {root: null};
      const own = privateD.root ? await documents(privateD, account) : [];
      const sharedD = await descriptor({scope: 'shared'}, account, mode), shared = await documents(sharedD, account);
      return {configured: !!personalRoot, account: {id: account.id, username: account.username}, retrieval: 'directory-fulltext-links',
        private: {sources: own.filter(item => item.type === 'source').length, pages: own.filter(item => item.type === 'wiki').length},
        shared: {grants: visibleGrants(account).size, sources: shared.filter(item => item.type === 'source').length, pages: shared.filter(item => item.type === 'wiki').length},
        ...(d.scope === 'project' ? {project: {project_id: args.project_id, sources: available.filter(item => item.type === 'source').length, pages: available.filter(item => item.type === 'wiki').length}} : {})};
    }
    if (name === 'wiki_search') {
      if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > MAX_QUERY) fail('query must contain 1–1000 characters');
      const limit = bounded(args.limit, 8, 20, 'limit');
      if (limit < 1) fail('limit must be positive');
      const raw = args.query.trim().toLocaleLowerCase();
      const words = [...new Intl.Segmenter('zh', {granularity: 'word'}).segment(raw)].filter(item => item.isWordLike).map(item => item.segment);
      const tokens = [...new Set([raw, ...words])];
      const results = available.map(item => {
        const text = item.body.toLocaleLowerCase(), title = item.title.toLocaleLowerCase();
        const score = tokens.reduce((sum, token) => sum + text.split(token).length - 1 + (title.includes(token) ? 6 : 0), 0);
        const at = Math.max(0, text.indexOf(raw));
        return {...metadata(item), score, preview: item.body.slice(Math.max(0, at - 80), at + 240).replace(/\s+/g, ' ').trim()};
      }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
      return {retrieval: 'fulltext', scanned: available.length, results};
    }
    if (name === 'wiki_directory') {
      if (args.folder !== undefined && !pagePath(args.folder)) fail('folder must be a safe page directory');
      const start = bounded(args.start, 0, 1_000_000, 'start'), limit = bounded(args.limit, 30, 50, 'limit');
      if (limit < 1) fail('limit must be positive');
      const items = available.filter(item => !args.folder || item.type === 'wiki' && item.local.slice(5).startsWith(args.folder + '/'))
        .sort((a, b) => a.id.localeCompare(b.id)).map(metadata);
      return {items: items.slice(start, start + limit), total: items.length, next_start: start + limit < items.length ? start + limit : null};
    }
    if (name === 'wiki_migration_preview') {
      const sources = available.filter(item => item.type === 'source'), pages = available.filter(item => item.type === 'wiki');
      const missing = sources.filter(item => !pages.some(page => page.local === 'wiki/sources/' + item.local));
      return {sources: sources.length, pages: pages.length, legacy_pages: pages.filter(item => item.revision === 0).length,
        missing_source_pages: missing.length, source_ids: missing.slice(0, 50).map(item => item.id), truncated: missing.length > 50,
        originals_preserved: true, grants_preserved: true};
    }
    if (name === 'wiki_write_page') {
      if (!pagePath(args.page_id) || typeof args.title !== 'string' || !args.title.trim() || args.title.length > 200
        || typeof args.text !== 'string' || !args.text.trim() || args.text.length > MAX_TEXT
        || !Number.isInteger(args.expected_revision) || args.expected_revision < 0
        || !Array.isArray(args.citations) || args.citations.length < 1 || args.citations.length > 64) fail('A safe page ID, title, Markdown, current revision, and source citations are required.');
      const sharedD = d.scope !== 'shared' ? await descriptor({scope: 'shared'}, account, mode) : d;
      const references = d.scope === 'shared' ? available : [...available, ...await documents(sharedD, account)];
      const citations = args.citations.map(citation => {
        if (!citation || typeof citation !== 'object' || Array.isArray(citation)
          || Object.keys(citation).some(key => !['id', 'start', 'end'].includes(key))) fail('Invalid source citation');
        const source = references.find(item => item.id === citation.id && item.type === 'source');
        const chars = source && Array.from(source.body);
        if (!source || !Number.isInteger(citation.start) || !Number.isInteger(citation.end) || citation.start < 0
          || citation.end <= citation.start || citation.end > chars.length || citation.end - citation.start > PAGE_SIZE) fail('Citation must reference a readable original and valid character range.');
        return {...citation, sha256: source.sha256, excerpt: chars.slice(citation.start, Math.min(citation.end, citation.start + 240)).join('')};
      });
      if (d.scope === 'shared') {
        const parent = await descend(d.root, ['wiki', ...args.page_id.split('/').slice(0, -1)]);
        const existing = parent && await lstat(join(parent, args.page_id.split('/').at(-1) + '.md')).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (existing && !available.some(item => item.local === 'wiki/' + args.page_id && !item.opening)) {
          fail('Shared page updates require an existing full-read administrator grant.');
        }
      }
      if (args.page_id.startsWith('sources/')) {
        const sourceId = args.page_id.slice(8);
        if (!SOURCE_ID.test(sourceId) || !available.some(item => item.local === sourceId && item.type === 'source')
          || !citations.some(item => item.id === scopedId(d, sourceId))) fail('Source pages must cite their own immutable packet.');
      }
      const ids = available.filter(item => item.type === 'wiki').map(item => item.local.slice(5));
      ids.push(args.page_id);
      const index = buildWikilinkIndex(ids);
      for (const target of extractWikilinks(args.text)) {
        const result = resolveWikilink(target, index);
        if (result.kind !== 'resolved') fail(`Wiki link is ${result.kind}: ${target}; use a directory-qualified existing page ID.`);
      }
      return commit(d, account, args.page_id, args.title.trim(), args.text, citations, args.expected_revision);
    }
    const local = localId(d, args.id), item = available.find(entry => entry.local === local);
    if (!item) fail('Document does not exist or is not authorized.');
    if (name === 'wiki_read') {
      let selected = item;
      if (args.revision !== undefined) {
        if (item.type !== 'wiki') fail('Sources are immutable and have no page revision selector.');
        const revision = bounded(args.revision, undefined, Number.MAX_SAFE_INTEGER, 'revision');
        selected = (await revisions(d, local.slice(5))).find(record => record.revision === revision);
        if (!selected || d.scope === 'shared' && selected.sha256 !== documentGrants.get(local)?.sha256) fail('Revision does not exist or is not authorized.');
        selected = {...selected, id: item.id, type: item.type, ...(d.scope === 'shared' ? {title: item.title} : {})};
      }
      const start = bounded(args.start, 0, 4_194_000, 'start');
      if (start % PAGE_SIZE !== 0) fail('start must be a multiple of 6000');
      const chars = Array.from(selected.body);
      if (start >= chars.length) fail('Requested character range does not exist.');
      const end = Math.min(start + PAGE_SIZE, chars.length);
      return {...metadata(selected), body: chars.slice(start, end).join(''), start, end, total_characters: chars.length,
        next_start: end < chars.length ? end : null, citations: visibleCitations(selected.citations, d.scope === 'shared' ? available
          : [...available, ...await documents(await descriptor({scope: 'shared'}, account, mode), account)]),
        ...(selected.opening ? {opening_only: true} : {})};
    }
    if (name === 'wiki_history') {
      if (item.type !== 'wiki') fail('Sources are immutable; history is available for Wiki pages.');
      const start = bounded(args.start, 0, 1_000_000, 'start'), limit = bounded(args.limit, 30, 50, 'limit');
      if (limit < 1) fail('limit must be positive');
      let entries = await revisions(d, local.slice(5));
      if (d.scope === 'shared') entries = entries.filter(entry => entry.sha256 === documentGrants.get(local)?.sha256);
      if (!entries.length && item.revision === 0) entries = [item];
      return {id: item.id, revisions: entries.slice(start, start + limit).map(entry => ({revision: entry.revision,
        sha256: entry.sha256, title: d.scope === 'shared' ? item.title : entry.title, status: entry.status, created_at: entry.created_at})),
        total: entries.length, next_start: start + limit < entries.length ? start + limit : null};
    }
    if (name === 'wiki_links') {
      if (item.type !== 'wiki') fail('Link navigation requires a Wiki page ID.');
      const pages = available.filter(entry => entry.type === 'wiki');
      const index = buildWikilinkIndex(pages.map(entry => entry.local.slice(5)));
      const outgoing = extractWikilinks(item.body).map(target => resolveWikilink(target, index));
      const backlinks = pages.filter(entry => entry.id !== item.id && extractWikilinks(entry.body)
        .some(target => {const resolved = resolveWikilink(target, index); return resolved.kind === 'resolved' && resolved.id === local.slice(5);}));
      return {id: item.id, outgoing: outgoing.filter(entry => entry.kind === 'resolved').slice(0, 50).map(entry => scopedId(d, 'wiki/' + entry.id)), outgoing_total: outgoing.length,
        unresolved: outgoing.filter(entry => entry.kind !== 'resolved').slice(0, 50), citations: visibleCitations(item.citations, d.scope === 'shared' ? available
          : [...available, ...await documents(await descriptor({scope: 'shared'}, account, mode), account)]),
        backlinks: backlinks.slice(0, 50).map(metadata), backlinks_total: backlinks.length, truncated: backlinks.length > 50 || outgoing.length > 50};
    }
    fail('Unknown Wiki tool');
  }
  return {call, anchor};
}
