/** Session-scoped local analysis and upstream reverse-skill methodology tools. */
import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { inspectFile } from './inspect.js';
import { resourceRoot, routeTask } from './router.js';

export const name = 'muse-reverse-tools';
export const inject = ['tools', 'agents'];

/** Validate deployment limits before tool registration. */
export function resolveConfig(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('Reverse configuration must be an object');
  const defaults = { assetRoot: resourceRoot, maxFileBytes: 64 * 1024 ** 2, maxSymbols: 200, maxSymbolNameBytes: 2048, timeoutMs: 60_000 };
  if (Object.keys(config).some(key => !Object.hasOwn(defaults, key))) throw new TypeError('Unknown reverse tools setting');
  const settings = { ...defaults, ...config };
  for (const key of ['maxFileBytes', 'maxSymbols', 'maxSymbolNameBytes', 'timeoutMs']) {
    if (!Number.isSafeInteger(settings[key]) || settings[key] <= 0) throw new TypeError(`Invalid reverse tools setting: ${key}`);
  }
  if (!isAbsolute(settings.assetRoot) || !statSync(join(settings.assetRoot, 'skills/config/routing.json')).isFile()) throw new Error('Reverse skill resources are missing');
  return Object.freeze(settings);
}

/** Register pure routing and bounded workspace inspection; loading this plugin starts no process. */
export function apply(ctx, config = {}) {
  const settings = resolveConfig(config), lifetime = new AbortController(), running = new Set();
  ctx.effect(() => async () => { lifetime.abort(new Error('Reverse tools unloaded')); await Promise.allSettled([...running]); }, 'reverse: settle local reads');
  const definitions = [
    { name: 'reverse_skill', title: '选择逆向分析方法', kind: 'read',
      description: 'Load the appropriate methodology from the bundled pinned reverse-skill project. Use for authorized binary, APK, JavaScript, desktop or protocol analysis. Returns original instructions and real resource paths. Does not install tools, start services, register MCP, access networks or authorize a target. Optional tools may require separate installation and licenses.',
      parameters: { type: 'object', additionalProperties: false, properties: { hint: { type: 'string', description: 'Describe the authorized analysis target and goal' } }, required: ['hint'] },
      run: (args, signal) => {
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'hint')) throw new TypeError('Invalid reverse routing arguments');
        return routeTask(args.hint, signal, settings.assetRoot);
      } },
    { name: 'reverse_analyze', title: '检查本地软件样本', kind: 'read',
      description: 'Statically inspect a user-selected file inside the active workspace. Return SHA256, bytes, executable format and bounded Mach-O symbols with addresses. Identifies PE, ELF, ZIP and DMG; does not execute or unpack the target, contact any server, bypass authorization or reconstruct source. Use reverse_skill for deeper analysis. Symbol counts and truncation are explicit.',
      parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', description: 'Workspace-relative file path, or absolute path inside the workspace' }, symbolContains: { type: 'string', description: 'Optional literal substring filter for Mach-O symbol names' } }, required: ['path'] },
      run: (args, signal) => inspectFile(args, ctx.agents.requireInitiator().session.header.cwd, settings, signal) },
  ];
  for (const tool of definitions) ctx.effect(() => ctx.tools.register({
    name: tool.name, description: tool.description, parameters: tool.parameters,
    timeoutMs: settings.timeoutMs,
    output: { schema: { type: 'object', additionalProperties: true, properties: { status: { type: 'string' } }, required: ['status'] }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      const signal = exec.signal ? AbortSignal.any([exec.signal, lifetime.signal]) : lifetime.signal;
      const pending = Promise.resolve().then(() => tool.run(args, signal)); running.add(pending);
      try { return await pending; } finally { running.delete(pending); }
    },
    presentCall() { return { card: 'generic', title: tool.title, kind: tool.kind }; },
    presentResult(_args, result) { return { card: 'generic', title: tool.title, content: result.content }; },
  }), `reverse: register ${tool.name}`);
}
