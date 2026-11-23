/** Static parsing of official Qimao catalog state with matching rendered identities and paging controls. */
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { z } from 'zod';
import { ORIGIN, QimaoError, parseMetric } from './parser.js';
import { parseQimaoState } from './state.ts';
import { sliceText } from '../../../shared/text.ts';

const identifier = z.string().regex(/^[1-9]\d{0,7}$/);
const text = z.string().trim().min(1).max(500).refine(value => !/[\uE000-\uF8FF]/u.test(value));
const leafSchema = z.object({ id: identifier, name: text, type: z.enum(['0', '1', '2']) });
const parentSchema = z.object({ id: z.union([z.literal('a'), identifier]), name: text,
  type: z.enum(['category', '0', '1', '2']), children: z.array(leafSchema).max(200) });
const rowSchema = z.object({
  index: z.string().regex(/^\d+$/), book_id: z.string().regex(/^\d{1,24}(?:_0)?$/), read_url: z.string().max(2000),
  title: text, author: z.string().max(500), category2_name: text, category_url: z.string().max(2000),
  is_over_txt: z.enum(['完结', '已完结', '连载中']), words_num: z.string().max(100), intro: z.string().max(30_000),
  image_link: z.string().max(2000), update_time: z.string().max(100), update_time_txt: z.string().max(100),
});
const sourceSchema = z.object({
  categoryFormData: z.object({ channel: z.literal('a'), category1: z.union([z.literal('a'), identifier]),
    category2: z.union([z.literal('a'), identifier]), words: z.literal('a'), update_time: z.literal('a'),
    is_vip: z.literal('a'), is_over: z.literal('a'), order: z.enum(['click', 'update_time']), page: z.string().regex(/^[1-9]\d*$/) }).strict(),
  categoryList: z.array(parentSchema).min(1).max(200), bookList: z.array(rowSchema).max(15),
  pageConfig: z.object({ count: z.string().regex(/^\d+$/), page: z.string().regex(/^[1-9]\d*$/), page_size: z.literal('15') }),
});

/** A source-advertised original-fiction category; publication categories are excluded. */
export interface QimaoCatalogCategory { parentId: string; id: string; name: string; parentName: string; type: '0' | '1'; }
/** Supported library selectors in the site's actual field order. */
export interface QimaoCatalogSelection { parentId: string | null; categoryId: string | null; order: 'click' | 'update_time'; page: number; }

type HtmlNode = DefaultTreeAdapterMap['node'];
function nodes(root: HtmlNode): HtmlNode[] {
  const result: HtmlNode[] = [], pending = [root];
  while (pending.length) {
    const node = pending.pop()!; result.push(node);
    if ('childNodes' in node && !['script', 'style', 'template', 'noscript'].includes(node.nodeName)) pending.push(...node.childNodes.toReversed());
  }
  return result;
}
const attr = (node: HtmlNode | undefined, name: string) => node && 'attrs' in node ? node.attrs.find(item => item.name === name)?.value ?? '' : '';
const has = (node: HtmlNode, ...classes: string[]) => classes.every(value => attr(node, 'class').split(/\s+/).includes(value));
/** Browsers collapse whitespace in rendered text, so state values compare in that same displayed form. */
const displayed = (value: string) => value.replace(/\s+/gu, ' ').trim();
const content = (node: HtmlNode | undefined) => node ? displayed(nodes(node).flatMap(item => 'value' in item ? [item.value] : []).join(' ')) : '';
const byClass = (node: HtmlNode, ...classes: string[]) => nodes(node).find(item => has(item, ...classes));


/**
 * Reads one library page without executing its serialized JavaScript.
 * @param html Official library HTML, already bounded by the HTTP reader.
 * @param expected Exact generated filter selection and requested page.
 * @param observedAt Page observation time used only for parsing displayed word counts.
 * @returns Verified fiction rows, current source paging and dynamically advertised fiction categories.
 */
export function parseQimaoCatalog(html: string, expected: QimaoCatalogSelection, observedAt: string) {
  try {
    const document = parse(html), all = nodes(document);
    const title = content(all.find(node => node.nodeName === 'title'));
    if (/验证码|安全验证|访问过于频繁|Access Denied|WAF|Forbidden/iu.test(title)) throw new Error('Catalog access requires verification');
    const scripts = all.filter(node => node.nodeName === 'script' && 'childNodes' in node).map(node => 'childNodes' in node
      ? node.childNodes.flatMap(item => 'value' in item ? [item.value] : []).join('') : '').filter(value => value.includes('window.__NUXT__'));
    if (scripts.length !== 1) throw new Error('Catalog has no unique Nuxt state');
    const parsedState = z.object({ fetch: z.record(z.string(), z.unknown()) }).parse(parseQimaoState(scripts[0]!));
    const candidates = Object.values(parsedState.fetch).filter(item => typeof item === 'object' && item !== null && Object.hasOwn(item, 'categoryFormData'));
    if (candidates.length !== 1) throw new Error('Catalog state has no unique library component');
    const data = sourceSchema.parse(candidates[0]);
    const form = data.categoryFormData;
    if (form.category1 !== (expected.parentId ?? 'a') || form.category2 !== (expected.categoryId ?? 'a')
      || form.order !== expected.order || form.page !== String(expected.page)) throw new Error('Catalog filters differ from the requested page');
    const total = Number(data.pageConfig.count), page = Number(data.pageConfig.page), pageSize = 15;
    const totalPages = Math.ceil(total / pageSize);
    if (!Number.isSafeInteger(total) || total > 150_000 || page !== expected.page || expected.page < 1 || expected.page > Math.max(1, totalPages)
      || data.bookList.length !== Math.min(pageSize, Math.max(0, total - (page - 1) * pageSize))) throw new Error('Catalog paging or row count differs from its declaration');
    const categories: QimaoCatalogCategory[] = [];
    const leaves = new Map<string, { type: '0' | '1' | '2'; name: string; parentName: string }>();
    for (const parent of data.categoryList) {
      if (parent.id === 'a') { if (parent.type !== 'category' || parent.children.length) throw new Error('Invalid all-category selector'); continue; }
      if (parent.type === 'category') throw new Error('Unsupported category channel');
      for (const leaf of parent.children) {
        const key = `${parent.id}:${leaf.id}`;
        if (leaves.has(key) || leaf.type !== parent.type) throw new Error('Repeated category identity or channel mismatch');
        leaves.set(key, { type: leaf.type, name: leaf.name, parentName: parent.name });
        if (leaf.type !== '2') categories.push({ parentId: parent.id, id: leaf.id, name: leaf.name, parentName: parent.name, type: leaf.type });
      }
    }
    if (!categories.length || categories.length > 500 || expected.parentId !== null && !categories.some(item => item.parentId === expected.parentId && item.id === expected.categoryId)) throw new Error('Catalog has no supported original-fiction category selection');
    const cards = all.filter(node => has(node, 'qm-cover-text-item'));
    if (cards.length !== data.bookList.length || new Set(data.bookList.map(row => row.book_id)).size !== data.bookList.length) throw new Error('Catalog DOM and state identities are incomplete or repeated');
    const selected = all.filter(node => has(node, 'page-btn', 'num', 'active'));
    if (totalPages > 1 && (selected.length !== 1 || content(selected[0]) !== String(page))) throw new Error('Catalog rendered page number differs from its state');
    const nextButton = all.find(node => has(node, 'next-btn'));
    if (page < totalPages && (!nextButton || has(nextButton, 'disabled'))) throw new Error('Catalog next-page control is missing');
    const items = data.bookList.flatMap((row, index) => {
      const card = cards[index]!, titleNode = byClass(card, 's-tit');
      const anchor = titleNode ? nodes(titleNode).find(node => node.nodeName === 'a') : undefined;
      const canonical = `${ORIGIN}/shuku/${row.book_id}/`;
      // Each check names the field and book, so a failing page can be diagnosed from the log alone.
      const same = (field: string, rendered: string, stated: string) => {
        if (rendered !== stated) throw new Error(`Catalog rendered ${field} differs from its state for book ${row.book_id} at row ${index + 1}: ${JSON.stringify(sliceText(rendered, 0, 60))} ≠ ${JSON.stringify(sliceText(stated, 0, 60))}`);
      };
      same('read URL', row.read_url, canonical); same('title link', attr(anchor, 'href'), canonical); same('title', content(anchor), displayed(row.title));
      same('directory index', row.index, String((page - 1) * pageSize + index + 1));
      const categoryNode = byClass(card, 's-category');
      const categoryMatch = /^https:\/\/www\.qimao\.com\/shuku\/a-([1-9]\d{0,7})-([1-9]\d{0,7})-a-a-a-a-click-1\/$/.exec(row.category_url);
      const category = categoryMatch ? leaves.get(`${categoryMatch[1]}:${categoryMatch[2]}`) : undefined;
      if (!category || category.name !== row.category2_name) throw new Error(`Catalog category of book ${row.book_id} is not an advertised category`);
      same('category link', attr(categoryNode, 'href'), row.category_url); same('category', content(categoryNode), displayed(row.category2_name));
      same('author', content(byClass(card, 's-author')), displayed(row.author)); same('status', content(byClass(card, 's-status')), row.is_over_txt);
      same('word count', content(byClass(card, 's-words-num')), displayed(row.words_num)); same('update time', content(byClass(card, 's-update-time')), displayed(row.update_time));
      if (expected.parentId !== null && (categoryMatch![1] !== expected.parentId || categoryMatch![2] !== expected.categoryId)) throw new Error(`Catalog book ${row.book_id} is outside the selected category`);
      if (category.type === '2') return [];
      const wordCount = parseMetric(displayed(row.words_num), '字', observedAt).value;
      const cover = row.image_link ? new URL(row.image_link) : null;
      if (cover && (cover.protocol !== 'https:' || cover.username || cover.password)) throw new Error('Invalid catalog cover URL');
      return [{ ...row, title: displayed(row.title), author: displayed(row.author), wordCount, coverUrl: cover?.href ?? null, tags: [category.parentName, category.name] }];
    });
    return { items, ids: data.bookList.map(row => row.book_id), categories, total, page, pageSize, totalPages, excluded: data.bookList.length - items.length };
  } catch (error) {
    throw new QimaoError('invalid_catalog_metadata', error instanceof Error ? sliceText(error.message, 0, 300) : 'Catalog metadata could not be verified');
  }
}
