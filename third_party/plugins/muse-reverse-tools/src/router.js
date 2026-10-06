/** Select the upstream route without executing its bootstrap or touching client configuration. */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve resources outside Electron's archive so external interpreters can read routed scripts. */
export function resolveResourceRoot(moduleUrl) {
  return fileURLToPath(new URL('../resources/reverse-skill/', moduleUrl))
    .replace(/([/\\][^/\\]+\.asar)(?=[/\\])/u, '$1.unpacked');
}

export const resourceRoot = resolveResourceRoot(import.meta.url);

/** Resolve a task against the pinned upstream scoring and priority rules. */
export function selectRoute(table, hint) {
  const scores = new Map();
  const candidates = [];
  const matches = pattern => new RegExp(pattern, 'iu').test(hint);
  for (const [id, route] of Object.entries(table.routes)) {
    for (const rule of route.keywords || []) {
      const all = typeof rule.mustAll === 'string' ? [rule.mustAll] : rule.mustAll || [];
      if (rule.must && matches(rule.must) && all.every(matches) && !(rule.exclude && matches(rule.exclude))) {
        scores.set(id, (scores.get(id) || 0) + 1);
        if (!candidates.includes(id)) candidates.push(id);
      }
    }
  }
  let primary = table.meta.fallbackId;
  let score = -1;
  for (const id of table.priority) {
    if (scores.has(id) && scores.get(id) > score) { primary = id; score = scores.get(id); }
  }
  if (!table.routes[primary]) throw new Error('Pinned reverse-skill route is missing');
  return { primary, confidence: score < 0 ? 'low' : candidates.length === 1 ? 'high' : 'medium',
    secondary: candidates.filter(id => id !== primary) };
}

/** Load the selected methodology; this operation starts no process and grants no target authorization. */
export async function routeTask(hint, signal, root = resourceRoot) {
  if (typeof hint !== 'string' || !hint.trim() || hint.length > 8192) throw new TypeError('Provide a non-empty analysis task');
  signal.throwIfAborted();
  const table = JSON.parse(await readFile(join(root, 'skills/config/routing.json'), { encoding: 'utf8', signal }));
  const selected = selectRoute(table, hint);
  const route = table.routes[selected.primary];
  const path = join(root, 'skills', route.skill);
  const instructions = await readFile(path, { encoding: 'utf8', signal });
  return { status: 'routed', ...selected, label: route.label, skillPath: path, resourceDirectory: dirname(path),
    packageRoot: root, instructions,
    constraints: 'Methodology only. Confirm target authorization and scope before target operations. Scripts, tool installation, MCP registration and network access require their disclosed user authorization. Paid tools and external CTF sidecars are not bundled.' };
}
