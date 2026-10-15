/** Model-visible book search, catalog and whole-book downloads using the local independent engine. */
import { FanqieClient } from './client.js';
export const name = 'muse-fanqie-download';
export const inject = ['tools', 'agents', 'subprocess'];

/** Register session-owned read and write tools; loading performs no network request. */
export function apply(ctx, config = {}) {
  const client = new FanqieClient(config, ctx.subprocess);
  ctx.effect(() => () => client.dispose(), 'fanqie: settle engine and files');
  for (const operation of ['search', 'info', 'download']) {
    const title = operation === 'search' ? '按书名搜索番茄小说' : operation === 'info' ? '检查番茄小说完整目录' : '下载番茄小说或多本小说';
    ctx.effect(() => ctx.tools.register({
      name: operation === 'search' ? 'fanqie_search' : operation === 'info' ? 'fanqie_download_info' : 'fanqie_download',
      description: operation === 'search'
        ? '通过书名或关键词搜索番茄官方书籍，返回候选书名、原名、作者、bookId、官方链接和章节数。只有书名时先用此工具，再将符合用户书名及作者的 bookId 传给 fanqie_download；同名或身份不明确时请用户选书，不默认下载排名第一本。hasMore 为真时原样传回 nextPassback 继续同一 query。搜索和章节数不代表正文可下载或已完整下载。'
        : operation === 'info'
        ? '检查一个或多个官方番茄书籍的真实目录。bookIds 接受十进制字符串或 https://fanqienovel.com/page/书籍ID。目录成功不代表正文下载通过。'
        : '使用 Muse 本地独立引擎下载一部或多部公开免费番茄小说，按当前已发布真实完整目录下载，不设章节数量上限。注册新匿名设备，原程序和原设备不参与。逐章核对书籍/章节ID、正文长度、乱码和文件SHA256；所有书下载验证完成才交付TXT和每章收据。连载仅表示当前已发布章节齐全。付费、VIP或需要其他授权的正文明确拒绝，不把试看当全文。失败或取消清理本批未完成文件，输出仅限当前工作区。',
      parameters: { type: 'object', additionalProperties: false, properties: operation === 'search' ? {
        query: { type: 'string', description: '书名或搜索关键词' },
        passback: { type: 'string', description: '同一搜索上一页返回的 nextPassback；首次搜索省略' },
      } : {
        bookIds: { type: 'array', items: { type: 'string' }, description: '一部或多部书籍ID或官方书籍页链接；默认最多10本' },
        ...(operation === 'download' ? { outputDir: { type: 'string', description: '当前工作区内目录，默认 downloads/fanqie' } } : {}),
      }, required: [operation === 'search' ? 'query' : 'bookIds'] },
      timeoutMs: client.config.callTimeoutMs,
      output: { schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, complete: { type: 'boolean' } }, required: ['ok', 'complete'] },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      execute: (args, exec) => client.call(operation, args, ctx.agents.requireInitiator().session.header.cwd, exec.signal),
      presentCall: () => ({ card: 'generic', title, kind: operation === 'download' ? 'write' : 'read' }),
      presentResult: (_args, result) => ({ card: 'generic', title, content: result.content }),
    }), `fanqie: ${operation}`);
  }
}
