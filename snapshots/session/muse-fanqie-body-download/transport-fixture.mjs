/**
 * Invented external-engine output through the real Fanqie Node client and workspace publication.
 * This fixture replaces engine execution and nondeterministic staging allocation, not Python HTML parsing or decryption.
 * Engine parser behavior is covered by its Python tests; no network request or real novel text appears here.
 */
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const { Service } = await importSnapshotPackage('@deepseek-ai/cordis',
  new URL('../../../apps/cli/package.json', import.meta.url))
const clientURL = new URL('../../../third_party/plugins/muse-fanqie-download/src/client.js', import.meta.url)
const engine = fileURLToPath(new URL('../../../third_party/plugins/muse-fanqie-download/python/engine.py', import.meta.url))
const allocationURL = new URL('./allocation-fixture.mjs', import.meta.url)
const books = [
  { bookId: '1000000000000000001', title: '纸灯回声（测试虚构）', chapters: [
    { itemId: '2000000000000000001', title: '第1章 留灯', text: '第1章 留灯\n林岚将纸灯留在旧站门口。灯底写着明天的日期。' },
    { itemId: '2000000000000000002', title: '第2章 昨日', text: '第2章 昨日\n前一天，许川在旧站看到一盏还没有署名的灯。' },
    { itemId: '2000000000000000003', title: '第3章 回声', text: '第3章 回声\n许川认出灯底的字。那是他昨日留下的便签。' },
  ] },
  { bookId: '1000000000000000002', title: '航站时钟（测试虚构）', chapters: [
    { itemId: '2000000000000000004', title: '第1章 慢针', text: '第1章 慢针\n沈舟发现航站的钟慢了两分钟。他记下了值班员的名字。' },
    { itemId: '2000000000000000005', title: '第2章 对时', text: '第2章 对时\n值班员取出交接表。两分钟前，沈舟已经在表上签过字。' },
  ] },
]
const sha256 = text => createHash('sha256').update(text).digest('hex')
export const name = 'snapshot-fanqie-download-transport'
export const inject = ['tools', 'agents']

class EngineFixture extends Service {
  constructor(ctx) { super(ctx, 'subprocess') }
  async resolveExecutable(value, _cwd, signal) {
    signal.throwIfAborted()
    if (value !== process.execPath) throw new Error('Fanqie snapshot refuses an unrelated executable')
    return value
  }
  spawn(spec) {
    spec.signal.throwIfAborted()
    if (JSON.stringify(spec.argv) !== JSON.stringify([process.execPath, '-I', '-B', engine])) {
      throw new Error('Fanqie snapshot refuses an unrelated engine')
    }
    const request = JSON.parse(spec.stdio.stdin.data)
    if (request.operation !== 'download'
      || JSON.stringify(request.bookIds) !== JSON.stringify(books.map(book => book.bookId))
      || request.staging !== join(spec.cwd, 'novels', '.fanqie-case01')) {
      throw new Error('Fanqie snapshot refuses an unrelated batch')
    }
    let text
    const done = (async () => {
      const items = []
      for (const book of books) {
        spec.signal.throwIfAborted()
        const content = `${book.title}\n\n${book.chapters.map(chapter => chapter.text).join('\n\n')}\n`
        const file = `${book.bookId}.txt`
        await writeFile(join(request.staging, file), content, { flag: 'wx', mode: 0o600 })
        items.push({ bookId: book.bookId, title: book.title, originalTitle: null, author: '快照虚构作者',
          chapterCount: book.chapters.length, downloadedChapters: book.chapters.length,
          complete: true, scope: 'current-published-directory', file, bytes: Buffer.byteLength(content), sha256: sha256(content),
          chapters: book.chapters.map(chapter => ({ itemId: chapter.itemId, title: chapter.title,
            characters: [...chapter.text].length, sha256: sha256(chapter.text) })) })
      }
      text = JSON.stringify({ ok: true, complete: true, items })
      return { exitCode: 0, signal: null }
    })()
    return { done, waitForExit: async () => { await done; return true }, terminate() {},
      collected: { stdout: { readFrom: () => ({ text, lossy: false, truncated: false }) } } }
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated headless profile context. */
export async function apply(ctx) {
  await ctx.plugin(EngineFixture)
  let replaced = false
  ctx.effect(() => {
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier !== 'node:fs/promises' || context.parentURL !== clientURL.href) {
          return nextResolve(specifier, context)
        }
        replaced = true
        return { url: allocationURL.href, shortCircuit: true }
      },
    })
    return () => hooks.deregister()
  }, 'fanqie-fixture.client-allocation')
  const provider = await import('../../../third_party/plugins/muse-fanqie-download/src/index.js')
  if (!replaced) throw new Error('Fanqie snapshot did not isolate client staging allocation')
  await ctx.plugin(provider, { pythonExecutable: process.execPath })
}
