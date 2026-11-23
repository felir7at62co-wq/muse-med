import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Work } from '../src/shared/types.ts';
import { createFanqieNovelSource, type FanqieNovelOptions } from '../src/server/novels/fanqie.ts';
import type { NovelDirectory } from '../src/server/novels/source.ts';

const id = '7395464458719464510';
const chapterId = '7395464503774678041';
const work: Work = { id: `fanqie:${id}`, sourceId: id, platform: 'fanqie', kind: 'novel', origin: 'live', sourceUrl: `https://fanqienovel.com/page/${id}`,
  title: '三字经', author: '王应麟', description: '', coverUrl: null, tags: [], category: '', episodeCount: null, wordCount: 12, serialStatus: '已完结',
  publishedAt: null, metrics: [], rank: null, rankChange: null, board: '', observedAt: '2026-11-13T00:00:00.000Z', sourceUpdatedAt: null };
const page = { bookId: id, bookName: '三字经', author: '王应麟', status: 2, creationStatus: 0, chapterTotal: 1, chapterListWithVolume: [[{
  itemId: chapterId, title: '全文', realChapterOrder: '1', needPay: 0, isChapterLock: false, isPaidPublication: false, isPaidStory: false,
}]] };
const directories: string[] = [];
function lockedPage() {
  const changed = structuredClone(page); const chapter = changed.chapterListWithVolume[0]![0]!;
  chapter.needPay = 1; chapter.isChapterLock = true; chapter.isPaidPublication = true; chapter.isPaidStory = true;
  return changed;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

type Scenario = { hang?: boolean; ignoreTerm?: boolean; badFrame?: boolean; partial?: boolean; errorCode?: string; wrongId?: boolean;
  missing?: boolean; words?: number; text?: string; apiTitle?: string; chapterBookId?: string; exitCode?: number; envCapture?: boolean };

async function fixture(scenario: Scenario = {}, changedPage = page, overrides: Partial<FanqieNovelOptions> = {}) {
  await mkdir(resolve('.data'), { recursive: true });
  const directory = await mkdtemp(resolve('.data/fanqie-source-test-')); directories.push(directory);
  const python = resolve(directory, 'python-fixture');
  const capture = resolve(directory, 'process.json');
  const source = `#!${process.execPath}
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const scenario=${JSON.stringify(scenario)};
writeFileSync(${JSON.stringify(capture)},JSON.stringify({pid:process.pid,cwd:process.cwd(),keys:Object.keys(process.env),args:process.argv.slice(2)}));
if(scenario.ignoreTerm)process.on('SIGTERM',()=>{});
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{const request=JSON.parse(line);if(scenario.hang){setInterval(()=>{},1000);return;}
if(scenario.partial){process.stdout.write('{"id":');process.exit(0);return;}
if(scenario.badFrame){console.log(JSON.stringify({id:request.id,ok:false}));return;}
if(scenario.errorCode){console.log(JSON.stringify({id:request.id,ok:false,code:scenario.errorCode,sourceStage:'catalog',error:{httpStatus:403}}));process.exitCode=1;process.stdin.destroy();return;}
const reply=request.operation==='directory'?{bookId:${JSON.stringify(id)},title:scenario.apiTitle??'三字经',author:'王应麟',chapters:scenario.missing?[]:[{id:${JSON.stringify(chapterId)},index:1,title:'全文',wordCount:scenario.words??12,updatedAt:'1721890766'}]}:{bookId:scenario.chapterBookId??${JSON.stringify(id)},chapterId:${JSON.stringify(chapterId)},index:1,text:scenario.text??'人之初，性本善。性相近，习相远。'};
console.log(JSON.stringify({id:scenario.wrongId?request.id+1:request.id,ok:true,...reply}));});
lines.on('close',()=>{process.exitCode=scenario.exitCode??0;});
`;
  await writeFile(python, source); await chmod(python, 0o700);
  const options: FanqieNovelOptions = { pythonExecutable: python, sourceDirectory: resolve('third_party/fanqie-original'), workerDirectory: resolve(directory, 'worker'),
    requestTimeoutMs: 1000, requestIntervalMs: 0, maxResponseBytes: 1024 * 1024, maxChapterBytes: 1024, callTimeoutMs: 5000, graceMs: 20, networkMode: 'direct',
    now: () => new Date('2026-11-13T00:00:00.000Z'),
    fetch: async (url, init) => {
      expect(String(url)).toBe(`https://fanqienovel.com/page/${id}`);
      expect(init?.redirect).toBe('error'); expect(init?.credentials).toBe('omit');
      return new Response(`<script>window.__INITIAL_STATE__=${JSON.stringify({ page: changedPage })};</script>`, { headers: { 'content-type': 'text/html' } });
    }, ...overrides };
  return { adapter: createFanqieNovelSource(options), options, capture };
}

async function processGone(capture: string) {
  const { pid } = JSON.parse(await readFile(capture, 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
}

describe('Fanqie original free-reading adapter', () => {
  it('cross-checks the website and API, accepts validated directory copies and releases the isolated worker', async () => {
    const { adapter, capture } = await fixture();
    const directory = await adapter.directory(work, new AbortController().signal);
    expect(directory).toMatchObject({ workId: work.id, sourceId: id, finished: true, declaredChapterCount: 1, title: '三字经' });
    const checked: NovelDirectory = structuredClone(directory);
    expect(await adapter.chapter(checked, checked.chapters[0]!, new AbortController().signal)).toBe('人之初，性本善。性相近，习相远。');
    await adapter.release?.(checked); await processGone(capture);
    expect(JSON.parse(await readFile(capture, 'utf8'))).toMatchObject({ cwd: expect.stringContaining('/.data/'), args: ['-I', '-B', '-X', 'utf8', resolve('third_party/fanqie-original/worker.py')] });
  });

  it.each(['isChapterLock', 'isPaidPublication', 'isPaidStory'] as const)('refuses website %s flags before starting any anonymous client', async flag => {
    const changed = structuredClone(page); changed.chapterListWithVolume[0]![0]![flag] = true;
    const { adapter, capture } = await fixture({}, changed);
    await expect(adapter.directory(work, new AbortController().signal)).rejects.toMatchObject({ code: 'authorization_required' });
    await expect(readFile(capture)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a paid chapter even when its lock flag is false', async () => {
    const changed = structuredClone(page); changed.chapterListWithVolume[0]![0]!.needPay = 1;
    const { adapter } = await fixture({}, changed);
    await expect(adapter.directory(work, new AbortController().signal)).rejects.toMatchObject({ code: 'authorization_required' });
  });

  it('accepts a locked website directory in full mode while still verifying the API directory and chapter', async () => {
    const { adapter, capture } = await fixture({}, lockedPage(), { fullMode: true });
    const directory = await adapter.directory(work, new AbortController().signal);
    expect(directory).toMatchObject({ workId: work.id, sourceId: id, finished: true, declaredChapterCount: 1, title: '三字经',
      chapters: [{ id: chapterId, index: 1, title: '全文', sourceUrl: `https://fanqienovel.com/reader/${chapterId}` }] });
    const checked: NovelDirectory = structuredClone(directory);
    expect(await adapter.chapter(checked, checked.chapters[0]!, new AbortController().signal)).toBe('人之初，性本善。性相近，习相远。');
    await adapter.release?.(checked); await processGone(capture);
  });

  it('still refuses a locked website directory when full mode is disabled', async () => {
    const { adapter, capture } = await fixture({}, lockedPage(), { fullMode: false });
    await expect(adapter.directory(work, new AbortController().signal)).rejects.toMatchObject({ code: 'authorization_required' });
    await expect(readFile(capture)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts a website-renamed normal API book title in full mode while still binding every chapter', async () => {
    const { adapter, capture } = await fixture({ apiTitle: '大幅改名后的书名' }, lockedPage(), { fullMode: true });
    const directory = await adapter.directory(work, new AbortController().signal);
    expect(directory).toMatchObject({ title: '三字经', declaredChapterCount: 1, chapters: [{ id: chapterId, index: 1, title: '全文' }] });
    await adapter.release?.(directory); await processGone(capture);
  });

  it('still rejects a normal API directory with a different chapter listing in full mode', async () => {
    const { adapter, capture } = await fixture({ missing: true }, lockedPage(), { fullMode: true });
    await expect(adapter.directory(work, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_source' });
    await processGone(capture);
  });

  it('still rejects truncated chapter output in full mode', async () => {
    const { adapter, capture } = await fixture({ text: '人之初' }, lockedPage(), { fullMode: true });
    const directory = await adapter.directory(work, new AbortController().signal);
    await expect(adapter.chapter(directory, directory.chapters[0]!, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_source' });
    await processGone(capture);
  });

  it.each([{ chapterTotal: 2 }, { bookId: '1' }])('rejects mismatching website identity or declared count', async update => {
    const { adapter } = await fixture({}, { ...page, ...update });
    await expect(adapter.directory(work, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_source' });
  });

  it.each([{ missing: true }, { apiTitle: '另一本书' }])('rejects incomplete or mismatching normal API directories and closes the process', async scenario => {
    const { adapter, capture } = await fixture(scenario);
    await expect(adapter.directory(work, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_source' });
    await processGone(capture);
  });

  it('propagates normal authorization failure without private response details', async () => {
    const { adapter, capture } = await fixture({ errorCode: 'authorization_required' });
    await expect(adapter.directory(work, new AbortController().signal)).rejects.toMatchObject({ code: 'authorization_required', message: '番茄目录接口未完成核对（authorization_required，HTTP 403）' });
    await processGone(capture);
  });

  it.each([{ wrongId: true }, { badFrame: true }, { partial: true }])('requires valid complete ordered protocol frames and actual process termination', async scenario => {
    const { adapter, capture } = await fixture(scenario);
    await expect(adapter.directory(work, new AbortController().signal)).rejects.toMatchObject({ code: expect.stringMatching(/invalid_source|unavailable/) });
    await processGone(capture);
  });

  it.each([{ text: '人之初' }, { text: '人之初\ue000性本善。性相近，习相远。' }, { text: '人之初\ufffd性本善。性相近，习相远。' }, { chapterBookId: '1' }])('rejects truncated, masked, undecodable or wrong-book chapter output', async scenario => {
    const { adapter, capture } = await fixture(scenario);
    const directory = await adapter.directory(work, new AbortController().signal);
    await expect(adapter.chapter(directory, directory.chapters[0]!, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_source' });
    await processGone(capture);
  });

  it('uses a curated environment that excludes production secrets, HOME and Python module paths', async () => {
    const previous = process.env.MUSE_TEST_SECRET; process.env.MUSE_TEST_SECRET = 'must-not-be-inherited';
    try {
      const { adapter, capture } = await fixture(); const directory = await adapter.directory(work, new AbortController().signal);
      await adapter.release?.(directory);
      const { keys } = JSON.parse(await readFile(capture, 'utf8'));
      expect(keys).not.toContain('MUSE_TEST_SECRET'); expect(keys).not.toContain('HOME'); expect(keys).not.toContain('PYTHONPATH');
    } finally { if (previous === undefined) delete process.env.MUSE_TEST_SECRET; else process.env.MUSE_TEST_SECRET = previous; }
  });

  it('aborts a hanging worker, escalates termination when needed and waits for it to exit', async () => {
    const { adapter, capture } = await fixture({ hang: true, ignoreTerm: true });
    const abort = new AbortController();
    const pending = adapter.directory(work, abort.signal);
    for (let count = 0; count < 100; count++) { try { await readFile(capture); break; } catch { await new Promise(done => setTimeout(done, 5)); } }
    abort.abort(new Error('user stopped'));
    await expect(pending).rejects.toBeInstanceOf(Error); await processGone(capture);
  });

  it('requires a successful final process exit before release succeeds', async () => {
    const { adapter, capture } = await fixture({ exitCode: 7 });
    const directory = await adapter.directory(work, new AbortController().signal);
    await expect(adapter.release?.(directory)).rejects.toMatchObject({ code: 'unavailable' }); await processGone(capture);
  });

  it('rejects retired, demo or unbound work identities before network requests', async () => {
    const { adapter } = await fixture();
    await expect(adapter.directory({ ...work, origin: 'demo' }, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_source' });
    await expect(adapter.directory({ ...work, sourceUrl: 'https://example.com/' }, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_source' });
  });
});
