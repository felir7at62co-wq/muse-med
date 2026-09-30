/** Bundled stdio MCP process for account status and authorized KB operations. */

import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MuseAccountController } from './account.ts'
import { createMuseAccountGateway, museGatewayOrigin } from './gateway.ts'
import { createMuseKbReader, MuseKbError, type MuseKbFailure, type MuseKbResult } from './kb.ts'

/** Startup data injected by the Host; no password, cookie, or bearer belongs here. */
interface LaunchConfig {
  readonly baseUrl: string
  readonly accountHome: string
  readonly requestTimeoutMs: number
}

/**
 * Validate the Host-supplied, credential-free child configuration.
 * @param raw - JSON environment value.
 * @returns Gateway origin and absolute account directory.
 */
export function parseMuseAccountLaunch(raw: string | undefined): LaunchConfig {
  if (raw === undefined) throw new Error('muse-account MCP: missing MUSE_ACCOUNT_CONFIG')
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('muse-account MCP: invalid MUSE_ACCOUNT_CONFIG')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('muse-account MCP: config must be an object')
  }
  const fields = value as Record<string, unknown>
  const requestTimeoutMs = fields.requestTimeoutMs
  if (typeof fields.baseUrl !== 'string' || typeof fields.accountHome !== 'string' || !isAbsolute(fields.accountHome)
    || typeof requestTimeoutMs !== 'number' || !Number.isSafeInteger(requestTimeoutMs)
    || requestTimeoutMs < 1_000 || requestTimeoutMs > 120_000) {
    throw new Error('muse-account MCP: baseUrl, absolute accountHome and requestTimeoutMs are required')
  }
  return {
    baseUrl: museGatewayOrigin(fields.baseUrl),
    accountHome: fields.accountHome,
    requestTimeoutMs,
  }
}

/** Only operations safe to expose to a model. */
export type MuseKbOperations = ReturnType<typeof createMuseKbReader>

/** Cloud Wiki scope fields; project ownership and shared grants remain server-enforced. */
const wikiScopeFields = {
  scope: z.enum(['private', 'project', 'shared']).optional().describe('知识范围，默认 private；shared 仅管理员可写。'),
  project_id: z.string().max(80).optional().describe('scope 为 project 时必填的账号内项目 ID，不接受路径或磁盘根目录。'),
}
const wikiIdFields = { id: z.string().max(500).describe('目录或检索结果中的来源/页面 ID。') }

/** Fixed model-facing failure text; no upstream message participates. */
const kbFailureText: Readonly<Record<MuseKbFailure, string>> = {
  'sign-in-required': 'MUSE knowledge base: sign-in-required',
  'access-denied': 'MUSE knowledge base: access-denied',
  'kb-unavailable': 'MUSE knowledge base: kb-unavailable',
  'kb-rejected': 'MUSE knowledge base: kb-rejected',
  'wiki-revision-conflict': 'MUSE knowledge base: wiki-revision-conflict. Read the current page, merge the changes, then retry with its current expected_revision.',
  'wiki-write-busy': 'MUSE knowledge base: wiki-write-busy. Reload the page before retrying; if the lock persists, ask the administrator to inspect it.',
  'wiki-invalid-citation': 'MUSE knowledge base: wiki-invalid-citation. Read the original source and use a valid Unicode character range of at most 6000 characters.',
  'wiki-unresolved-link': 'MUSE knowledge base: wiki-unresolved-link. Browse the directory and use an existing directory-qualified page ID before retrying.',
}

/** Keep tool failures independent of upstream response bodies and bearer values. */
async function kbResult(operation: () => Promise<MuseKbResult>): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    const result = await operation()
    return { content: result.content.map(block => ({ type: 'text', text: block.text })) }
  } catch (error) {
    const code = error instanceof MuseKbError ? error.code : 'kb-unavailable'
    return { content: [{ type: 'text', text: kbFailureText[code] }], isError: true }
  }
}

/**
 * Register account status, legacy sources, scoped Wiki tools and authorized participation reports.
 * @param controller - Account identity reader shared with the Host service.
 * @param kb - Account-scoped KB operations that exchange a fresh bearer per call.
 * @returns A server with no credential-taking tool.
 */
export function createMuseAccountMcpServer(controller: Pick<MuseAccountController, 'status'>, kb: MuseKbOperations): McpServer {
  const server = new McpServer({ name: 'muse-account', version: '0.1.0' }, { capabilities: { tools: {} } })
  server.registerTool('muse_kb_wiki_project_portfolio', {
    title: 'Browse MUSE project participation',
    description: '浏览 Muse 项目参与组合。普通登录仅查看本人；经部署授权的组合管理员可查看全部启用账号，并按 account_id 筛选。省略 project_key 分页列出项目及阶段状态统计；指定 project_key 分页读取计划和实际工作摘要、状态及产物引用。仅返回记录器维护的参与记录，不返回原始资料或其他私人 Wiki。',
    inputSchema: z.object({
      account_id: z.string().regex(/^[a-f0-9]{16}$/u).optional().describe('账号 ID；普通用户只能选本人，授权管理员可筛选其他启用账号。'),
      project_key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,74}$/u).optional().describe('项目列表返回的稳定标识；提供时读取该项目的参与内容。'),
      start: z.number().int().min(0).max(1_000_000).optional().describe('列表续读起点，默认 0。'),
      limit: z.number().int().min(1).max(50).optional().describe('每次条数，默认 30。'),
    }).strict(),
  }, async args => await kbResult(() => kb.wikiProjectPortfolio(args)))
  server.registerTool('muse_kb_wiki_record_project', {
    title: 'Record MUSE project participation',
    description: '主动登记 Muse 参与的项目、计划与实际工作、阶段状态和产物引用，保存账号记录并读回；本人和经部署授权的组合管理员可用 muse_kb_wiki_project_portfolio 查看。完成状态来自阶段汇报，不能把待生成任务记作已完成。',
    inputSchema: z.object({
      project_key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,74}$/u).describe('稳定项目标识，已有剧变绑定用 jubian-<script_id>；否则使用持久化项目 UUID，同名不同项目不能复用。'),
      project_title: z.string().max(160).describe('面向用户的项目名称。'),
      contribution_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u).describe('稳定阶段标识；同一阶段进度更新复用，重试不换 ID。'),
      stage: z.string().max(100).describe('本次参与的具体阶段，例如改编、大纲、分镜或剪辑。'),
      status: z.enum(['planned', 'in_progress', 'completed', 'blocked', 'cancelled']).describe('如实区分计划、进行中、完成、受阻和取消。'),
      content: z.string().max(5000).describe('计划或实际参与内容、检查结果与未完成项，不含凭证、推理文本或无关会话。'),
      artifacts: z.array(z.string().max(240)).max(20).describe('项目相对文件路径或稳定任务引用，例如 deliverables/EP01.md、jubian:499887；不传绝对磁盘路径或带密钥的 URL。'),
    }).strict(),
  }, async args => await kbResult(() => kb.wikiRecordProject(args)))
  server.registerTool('muse_account_status', {
    title: 'MUSE account status',
    description: 'Read the current MUSE account identity. Set verify=true to confirm the saved session with the gateway. No password or cookie is returned.',
    inputSchema: z.object({ verify: z.boolean().optional() }),
  }, async ({ verify }) => {
    try {
      const status = await controller.status(verify === undefined ? {} : { verify })
      const text = status.state === 'signed-out'
        ? 'No MUSE account is signed in.'
        : 'MUSE account: ' + status.username + '; ' + (status.verified ? 'gateway verified' : 'saved locally, not yet verified') + '.'
      return { content: [{ type: 'text', text }] }
    } catch {
      return { content: [{ type: 'text', text: 'MUSE account status is unavailable.' }], isError: true }
    }
  })
  server.registerTool('muse_kb_search', {
    title: 'Search MUSE knowledge base',
    description: 'Search this account’s private scripts and administrator-granted sources or Wiki pages. Results include 类型, 标定, and an ID. Use muse_kb_read for full pages, or muse_kb_read_opening for a viral-script or user-script opening; excerpts are incomplete.',
    inputSchema: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(20).optional() }),
  }, async ({ query, limit }) => await kbResult(() => kb.search(query, limit)))
  server.registerTool('muse_kb_read', {
    title: 'Read an authorized MUSE source or Wiki page',
    description: 'Read a 6000-character page of an account-authorized source or Wiki page by search result ID. Continue with the numeric 下一段起点 offset reported in the previous page until 后续正文未读 is 否.',
    inputSchema: z.object({ id: z.string().min(1).max(512), start: z.number().int().min(0).max(4194000).multipleOf(6000).optional() }),
  }, async ({ id, start }) => await kbResult(() => kb.read(id, start)))
  server.registerTool('muse_kb_read_opening', {
    title: 'Read an authorized script opening',
    description: 'Read a 6000-character opening page of an authorized viral-script source or this account’s private user-script. Start may be 0, 6000, 12000, or 18000. Continue when the story opening requires another page.',
    inputSchema: z.object({
      id: z.string().min(1).max(256),
      start: z.union([z.literal(0), z.literal(6000), z.literal(12000), z.literal(18000)]).optional(),
    }),
  }, async ({ id, start }) => await kbResult(() => kb.readOpening(id, start)))
  server.registerTool('muse_kb_ingest_script', {
    title: 'Save reviewed script sections to private MUSE knowledge base',
    description: 'Save reviewed, human-readable Markdown script sections from an authorized video or novel source into the signed-in account’s private knowledge base. Submit one item per episode or chapter. Results name each saved, duplicate, or failed item and its private ID. Verify the full set and read back saved IDs before reporting completion; a partial result is not a complete archive.',
    inputSchema: z.object({ items: z.array(z.object({
      title: z.string().min(1).max(200).describe('Work title and episode or chapter'),
      text: z.string().min(1).max(400_000).describe('Reviewed script Markdown, not raw speech-recognition fragments'),
      source: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/u).refine(value => !value.includes('..')).describe('Project-relative source ID; keep original URL and timecodes in the project source record'),
      reviewed: z.literal(true).describe('The script text has been checked against the source'),
    })).min(1).max(12).describe('One section per episode or chapter; split long scripts into batches below 2 MiB total') }),
  }, async ({ items }) => await kbResult(() => kb.ingestScript(items)))
  server.registerTool('muse_kb_wiki_capture_source', {
    title: 'Capture an immutable MUSE Wiki source',
    description: '保存不可变原始资料并建立待合成的来源页；继续读取来源，用 muse_kb_wiki_write_page 写带引用的总结、实体和概念页。',
    inputSchema: z.object({ ...wikiScopeFields,
      title: z.string().max(200).describe('资料标题。'),
      text: z.string().max(400_000).describe('原始 Markdown 正文，重复正文不重复保存。'),
      source: z.string().max(200).describe('项目相对来源标识，例如 project/episode-01。'),
    }).strict(),
  }, async args => await kbResult(() => kb.wikiCaptureSource(args)))
  server.registerTool('muse_kb_wiki_directory', {
    title: 'Browse the MUSE Wiki directory',
    description: '列出知识目录中的来源页、概念页和实体页，返回页面 ID 与修订号。',
    inputSchema: z.object({ ...wikiScopeFields,
      folder: z.string().max(400).optional().describe('页面目录前缀，例如 concepts；省略列出全部。'),
      start: z.number().int().min(0).optional().describe('列表续读起点，默认 0。'),
      limit: z.number().int().min(1).max(50).optional().describe('每次条数，默认 30。'),
    }).strict(),
  }, async args => await kbResult(() => kb.wikiDirectory(args)))
  server.registerTool('muse_kb_wiki_search', {
    title: 'Search the MUSE Wiki full text',
    description: '对当前知识范围做全文关键词检索，返回匹配摘录与可读取的来源/页面 ID。',
    inputSchema: z.object({ ...wikiScopeFields,
      query: z.string().max(1000).describe('全文关键词。'),
      limit: z.number().int().min(1).max(20).optional().describe('返回条数，默认 8。'),
    }).strict(),
  }, async args => await kbResult(() => kb.wikiSearch(args)))
  server.registerTool('muse_kb_wiki_read', {
    title: 'Read a MUSE Wiki source or page revision',
    description: '按 ID 分页读原文或知识页，返回修订号、引用和下一段起点；可读取指定历史修订。',
    inputSchema: z.object({ ...wikiScopeFields, ...wikiIdFields,
      start: z.number().int().min(0).multipleOf(6000).optional().describe('字符起点，默认 0，续读使用 next_start。'),
      revision: z.number().int().min(0).optional().describe('历史页面修订号，省略读当前版；旧页面导入前的原文为 0。'),
    }).strict(),
  }, async args => await kbResult(() => kb.wikiRead(args)))
  server.registerTool('muse_kb_wiki_write_page', {
    title: 'Write a cited MUSE Wiki page',
    description: '写入经过综合整理的知识页。必须带可核对的原文引用和当前修订号；新页 expected_revision 为 0，修订冲突时先重读。',
    inputSchema: z.object({ ...wikiScopeFields,
      page_id: z.string().max(400).describe('范围内的页面路径，例如 concepts/opening-hook，不带 wiki/ 或 .md。'),
      title: z.string().max(200).describe('页面标题。'),
      text: z.string().max(100_000).describe('综合后的 Markdown；用 [[concepts/name]]、[[entities/name]]、[[sources/SRC-...]] 链接现有页。'),
      expected_revision: z.number().int().min(0).describe('muse_kb_wiki_read/muse_kb_wiki_directory 返回的当前修订；新页为 0。'),
      citations: z.array(z.object({
        id: z.string().describe('可读取的不可变来源 ID。'),
        start: z.number().int().min(0).describe('Unicode 字符范围起点。'),
        end: z.number().int().min(1).describe('Unicode 字符范围终点，不含该字符；每条最多 6000 字。'),
      }).strict()).min(1).max(64).describe('支撑结论的原文字符范围，不接受页面 ID 代替原始资料。'),
    }).strict(),
  }, async args => await kbResult(() => kb.wikiWritePage(args)))
  server.registerTool('muse_kb_wiki_history', {
    title: 'Browse MUSE Wiki page history',
    description: '列出页面的不可变历史修订，可用 muse_kb_wiki_read 的 revision 读取。',
    inputSchema: z.object({ ...wikiScopeFields, ...wikiIdFields,
      start: z.number().int().min(0).optional().describe('历史列表续读起点，默认 0。'),
      limit: z.number().int().min(1).max(50).optional().describe('每次条数，默认 30。'),
    }).strict(),
  }, async args => await kbResult(() => kb.wikiHistory(args)))
  server.registerTool('muse_kb_wiki_links', {
    title: 'Inspect MUSE Wiki links and citations',
    description: '查看页面的向外链接、引用来源、反向链接与尚未解析的链接。',
    inputSchema: z.object({ ...wikiScopeFields, ...wikiIdFields }).strict(),
  }, async args => await kbResult(() => kb.wikiLinks(args)))
  server.registerTool('muse_kb_wiki_status', {
    title: 'Read the MUSE Wiki inventory status',
    description: '查看当前登录账号的私有、项目和已授权共享 Wiki 数量与检索方式。',
    inputSchema: z.object(wikiScopeFields).strict(),
  }, async args => await kbResult(() => kb.wikiStatus(args)))
  server.registerTool('muse_kb_wiki_migration_preview', {
    title: 'Preview MUSE Wiki migration coverage',
    description: '预览现有来源包和旧知识页的接入情况，列出缺少来源页的 ID；不改动原件或授权。',
    inputSchema: z.object(wikiScopeFields).strict(),
  }, async args => await kbResult(() => kb.wikiMigrationPreview(args)))
  return server
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const config = parseMuseAccountLaunch(process.env.MUSE_ACCOUNT_CONFIG)
  const sessionFile = join(config.accountHome, 'session.json')
  const controller = new MuseAccountController({
    baseUrl: config.baseUrl,
    sessionFile,
    gateway: createMuseAccountGateway(config.baseUrl, config.requestTimeoutMs),
  })
  const kb = createMuseKbReader({ baseUrl: config.baseUrl, sessionFile, requestTimeoutMs: config.requestTimeoutMs })
  serveStdio(() => createMuseAccountMcpServer(controller, kb), {
    onerror: () => { console.error('[muse-account] MCP request failed') },
  })
}
