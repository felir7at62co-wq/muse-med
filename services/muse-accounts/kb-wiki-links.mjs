// Wikilink navigation adapted from @zosmaai/pi-llm-wiki 0.6.3.
// Copyright (c) 2026 zosmaai; MIT notice and exact input hashes: wiki-upstream.json.
const slugify = title => title
  .replace(/[\uFF01-\uFF5E]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
  .replace(/\u3000/g, ' ').toLowerCase().normalize('NFC')
  .replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/[\s-]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 80).replace(/[\uD800-\uDBFF]$/, '')
  .replace(/^-+|-+$/g, '') || 'untitled';

/** Build exact, folder-qualified, and unambiguous basename link indexes.
 * @param {Iterable<string>} ids Available page paths without extensions.
 * @returns {{byExact: Map, byNormPath: Map, byNormSlug: Map}} Link lookup indexes.
 */
export function buildWikilinkIndex(ids) {
  const byExact = new Map(), byNormPath = new Map(), byNormSlug = new Map();
  const push = (map, key, value) => {
    const existing = map.get(key);
    if (existing) existing.push(value); else map.set(key, [value]);
  };
  for (const id of ids) {
    byExact.set(id.normalize('NFC'), id);
    const segments = id.split('/');
    push(byNormPath, segments.map(slugify).join('/'), id);
    push(byNormSlug, slugify(segments.at(-1)), id);
  }
  return {byExact, byNormPath, byNormSlug};
}

/** Resolve a folder-qualified link or a unique basename.
 * @param {string} target Link text without brackets.
 * @param {ReturnType<typeof buildWikilinkIndex>} index Visible pages.
 * @returns {object} Resolved page ID or missing/ambiguous diagnostics.
 */
export function resolveWikilink(target, index) {
  const cleaned = target.trim().replace(/\\$/, '');
  if (!cleaned) return {kind: 'missing', target: ''};
  const exact = index.byExact.get(cleaned.normalize('NFC'));
  if (exact) return {kind: 'resolved', id: exact};
  const pathHits = index.byNormPath.get(cleaned.split('/').map(slugify).join('/'));
  if (pathHits?.length === 1) return {kind: 'resolved', id: pathHits[0]};
  if (pathHits?.length > 1) return {kind: 'ambiguous', target: cleaned, candidates: pathHits};
  if (!cleaned.includes('/')) {
    const baseHits = index.byNormSlug.get(slugify(cleaned));
    if (baseHits?.length === 1) return {kind: 'resolved', id: baseHits[0]};
    if (baseHits?.length > 1) return {kind: 'ambiguous', target: cleaned, candidates: baseHits};
  }
  return {kind: 'missing', target: cleaned};
}

/** Extract Wiki links outside fenced and inline code.
 * @param {string} body Markdown page text.
 * @returns {string[]} Unique link targets, without aliases or heading fragments.
 */
export function extractWikilinks(body) {
  const masked = body.replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[^\n]*$/gm, '')
    .replace(/(`+)[\s\S]*?\1/g, '');
  return [...new Set([...masked.matchAll(/\[\[([^\]|]+)(?:\\?\|[^\]]*)?\]\]/g)]
    .map(match => match[1].trim().replace(/\\$/, '').split('#')[0].replace(/\.md$/, '')))];
}

/** Build the upstream source-summary outline while keeping the raw packet separate.
 * @param {string} id Immutable local source ID.
 * @param {string} title Source title.
 * @param {string} text Captured Markdown.
 * @returns {string} Unsynthesized source page with a bounded preview.
 */
export function sourcePageSkeleton(id, title, text) {
  const preview = text.replace(/[#*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
  return `# ${title}\n\n## Summary\n\nPending synthesis from the immutable source.\n\n> ${preview}\n\n## Key Takeaways\n\n## Entities Mentioned\n\n## Concepts Mentioned\n\n## Notable Quotes\n\n## Source Packet\n\n- ID: ${id}\n`;
}
