/** Build the reviewed native Feishu surface behind the existing Muse channel row. */
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyFeishuReliability } from './feishu-reliability.mjs'

export const feishuDesktopCompatibility = {
  upstreamCommit: 'f10ef5f6efb5beb5bd5d10e3e31a8f68f48b6e75',
  agentComposition: 'Muse product preset and Session model selection',
  credentials: 'existing feishu-channel volatile settings',
  remoteProvider: 'retained separately at @wenbin_wb/dsh-bridge/remote',
}

function replace(text, before, after, count = 1) {
  if (text.split(before).length - 1 !== count) throw new Error(`community plugins: native Feishu source requires review near ${before.slice(0, 90)}`)
  return text.replaceAll(before, after)
}

/** Add explicit Muse extension points to a private source copy before TypeScript compilation. */
export function applyFeishuDesktopCompatibility(directory) {
  const expected = {
    'src/index.ts': '6d6a43399a7ea4ed202a53918e1358c0b2d3d52d240ff2b728937759e4638f63',
    'src/bridge.ts': 'dd36ebe93ce09249c06c81079976660aa7a41658377e17fcd90c3bd8dd05ac0c',
    'src/commands.ts': 'bc2c5b02be04b7d6638e178de659d4598c0b0d0a60e87765d501ebeb5ff4a015',
    'src/session-map.ts': '6574c74263116425d080af8f4b66832662f028df094ed8af9d0649e3613455f8',
  }
  for (const [path, digest] of Object.entries(expected)) {
    if (createHash('sha256').update(readFileSync(join(directory, path))).digest('hex') !== digest) throw new Error(`community plugins: Feishu ${path} requires source review`)
  }
  const indexPath = join(directory, 'src/index.ts')
  let text = readFileSync(indexPath, 'utf8')
  text = replace(text, 'export interface ApplyDeps {', `export interface ApplyDeps {
  createAgentStore?: (ctx: Context, config: Config) => AgentStore;
  onBridge?: (bridge: Bridge, sessionMap: SessionMap, transport: FeishuTransport) => void;
  trackOperation?: (operation: Promise<unknown>) => void;
  onSessionAdopt?: (sessionId: string) => void;
  strictSessionRestore?: boolean;
  registerSendFileTool?: typeof registerSendFileTool;
  close?: () => void;
  drain?: () => Promise<void>;`)
  text = replace(text, 'const agentStore: AgentStore = {', 'const agentStore: AgentStore = deps.createAgentStore?.(ctx, config) ?? {')
  text = replace(text, 'const bridge = new Bridge({', `const bridge = new Bridge({
    ...(deps.trackOperation === undefined ? {} : { trackOperation: deps.trackOperation }),
    ...(deps.strictSessionRestore === undefined ? {} : { strictSessionRestore: deps.strictSessionRestore }),
    ...(deps.onSessionAdopt === undefined ? {} : { onSessionAdopt: deps.onSessionAdopt }),`)
  text = replace(text, '  // Interactive approvals:', '  deps.onBridge?.(bridge, sessionMap, transport);\n  // Interactive approvals:')
  text = replace(text, `ctx.on('approval/request', (request: ApprovalRequestLike) =>
      bridge.handleApprovalRequest(request),`, `ctx.on('approval/request', (request: ApprovalRequestLike, next: () => ReturnType<Bridge['handleApprovalRequest']>) =>
      sessionMap.chatFor(String(request.agent.session.id)) === undefined ? next() : bridge.handleApprovalRequest(request),`)
  text = replace(text, `ctx.on('user-questions/request', (request: AskQuestionsRequestLike) =>
      bridge.askQuestions(request),`, `ctx.on('user-questions/request', (request: AskQuestionsRequestLike, next: () => ReturnType<Bridge['askQuestions']>) =>
      request.agent === undefined || sessionMap.chatFor(String(request.agent.session.id)) === undefined ? next() : bridge.askQuestions(request),`)
  text = replace(text, `ctx.effect(() => () => {
    bridge.dispose();
    sessionMap.persist();
  });`, `ctx.effect(() => async () => {
    deps.close?.();
    bridge.dispose();
    await finishChannelShutdown(() => transport.stop(), async () => { await deps.drain?.(); }, () => sessionMap.persist());
  });`)
  text = replace(text, 'const disposeSendFile = registerSendFileTool(ctx, {', 'const disposeSendFile = (deps.registerSendFileTool ?? registerSendFileTool)(ctx, {')
  text = replace(text, '  promoteAmbientApiKey(ctx, config);', '')
  text += `
/**
 * Complete every owned cleanup before reporting any transport, Agent, or mapping failure.
 * @param stop Stop admitting transport events and close its connection.
 * @param drain Cancel and dispose the channel-owned Agents and admitted operations.
 * @param persist Save the final Session map after owned work has stopped.
 * @returns After quiescence; rejects with every cleanup failure.
 */
export async function finishChannelShutdown(stop: () => Promise<void>, drain: () => Promise<void>, persist: () => void): Promise<void> {
  const results = await Promise.allSettled([Promise.resolve().then(stop), Promise.resolve().then(drain)]);
  const errors: unknown[] = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  try { persist(); } catch (error: unknown) { errors.push(error); }
  if (errors.length > 0) throw new AggregateError(errors, 'Native Feishu shutdown could not complete every cleanup');
}
`;
  writeFileSync(indexPath, text)
  const bridgePath = join(directory, 'src/bridge.ts')
  text = readFileSync(bridgePath, 'utf8')
  text = replace(text, 'export interface BridgeOptions {', `export interface BridgeOptions {
  readonly trackOperation?: (operation: Promise<unknown>) => void;
  readonly strictSessionRestore?: boolean;
  readonly onSessionAdopt?: (sessionId: string) => void;`)
  for (const expression of ['this.handleMessage(message)', 'this.handleCardAction(action)', 'this.handleEvent(sessionId, event)']) {
    text = replace(text, `void ${expression}.catch`, `const operation = ${expression};\n      options.trackOperation?.(operation);\n      void operation.catch`)
  }
  text = replace(text, '} catch (resumeError: unknown) {', `} catch (resumeError: unknown) {
      if (this.options.strictSessionRestore === true && !(typeof resumeError === 'object' && resumeError !== null
        && 'code' in resumeError && resumeError.code === 'MUSE_SESSION_NOT_FOUND')) throw resumeError;`, 2)
  text = replace(text, '    this.options.sessionMap.set(chatId, sessionId);', '    this.options.sessionMap.set(chatId, sessionId);\n    this.options.onSessionAdopt?.(sessionId);')
  writeFileSync(bridgePath, text)
  const commandsPath = join(directory, 'src/commands.ts')
  text = replace(readFileSync(commandsPath, 'utf8'), 'register(command: SurfaceCommand): void {',
    "register(command: SurfaceCommand): void {\n    if (command.name === 'permission' || command.name === 'plan') return;")
  writeFileSync(commandsPath, text)
  const mapPath = join(directory, 'src/session-map.ts')
  text = readFileSync(mapPath, 'utf8')
  text = replace(text, "import { dirname } from 'node:path';", "import { dirname, isAbsolute } from 'node:path';\nimport { randomUUID } from 'node:crypto';")
  text = replace(text, '() => `feishu-${Date.now()}`', '() => `feishu-${randomUUID()}`')
  text = replace(text, 'session-id minter; defaults to `feishu-<epoch-ms>`.', 'session-id minter; defaults to a random UUID-prefixed identity.')
  text = replace(text, `   * Load persisted mappings. A missing or unreadable file is a no-op; a
   * malformed file logs nothing here (callers surface it) and leaves the map
   * empty.`, `   * Load persisted mappings. A missing file is a new installation; malformed
   * or unreadable existing data throws without replacing the previous history.`)
  text = replace(text, "(parsed.version !== 1 && parsed.version !== 2) || typeof parsed.entries !== 'object'", "(parsed.version !== 1 && parsed.version !== 2) || parsed.entries === null || Array.isArray(parsed.entries) || typeof parsed.entries !== 'object'")
  text = replace(text, `        return;
      }
      for (const [chatId, sessionId] of Object.entries(parsed.entries)) {`, `        throw new Error('Native Feishu Session map has an unsupported format');
      }
      const seen = new Set<string>();
      for (const [chatId, sessionId] of Object.entries(parsed.entries)) {
        if (seen.has(sessionId)) throw new Error('Native Feishu Session map has duplicate ownership');
        seen.add(sessionId);
        if (typeof sessionId !== 'string' || sessionId === '' || chatId === '') throw new Error('Native Feishu Session map has an invalid binding');`)
  text = replace(text, '      if (parsed.version >= 2 && parsed.cwds !== undefined) {', `      if (parsed.version >= 2 && parsed.cwds !== undefined) {
        if (parsed.cwds === null || typeof parsed.cwds !== 'object' || Array.isArray(parsed.cwds)) throw new Error('Native Feishu Session map has invalid directories');`)
  text = replace(text, '          this.cwds.set(chatId, cwd);', `          if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('Native Feishu Session map has an invalid directory');
          this.cwds.set(chatId, cwd);`)
  text = replace(text, `    } catch {
      // Missing file (first run) or unreadable content: start empty.
    }`, `    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) {
        throw new Error('Native Feishu Session map could not be loaded; existing history was preserved', { cause: error });
      }
    }`)
  writeFileSync(mapPath, text)
  applyFeishuReliability(directory)
}

/** Package compiled upstream modules with the product-owned activation entry and helpers. */
export function finishFeishuDesktopCompatibility(directory) {
  const lib = join(directory, 'lib')
  const temporary = join(directory, '.muse-feishu-upstream')
  renameSync(lib, temporary)
  mkdirSync(lib)
  renameSync(temporary, join(lib, 'upstream'))
  cpSync(new URL('./muse-feishu-runtime.mjs', import.meta.url), join(lib, 'muse-feishu-runtime.mjs'))
  cpSync(new URL('./muse-feishu-reliability.mjs', import.meta.url), join(lib, 'muse-feishu-reliability.mjs'))
  cpSync(new URL('../../../apps/desktop-host/lib/feishu-migration.js', import.meta.url), join(lib, 'muse-feishu-migration.mjs'))
  writeFileSync(join(lib, 'index.js'), `import * as upstream from './upstream/index.js'
import { createLarkTransport } from './upstream/transport.js'
import { sessionSelectionFor } from './upstream/model-switch.js'
import * as migration from './muse-feishu-migration.mjs'
import { createInboundClaims } from './muse-feishu-reliability.mjs'
import { mountMuseFeishu } from './muse-feishu-runtime.mjs'
export { Config, name } from './muse-feishu-runtime.mjs'
export function apply(ctx, config) {
  return mountMuseFeishu(ctx, config, upstream, { createTransport: createLarkTransport, selectionFor: sessionSelectionFor, migration, createInboundClaims })
}
`)
  writeFileSync(join(directory, 'cordis.patch.yml'), '[]\n')
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.main = 'lib/index.js'
  manifest.exports = { '.': './lib/index.js', './package.json': './package.json' }
  manifest.files = ['lib', 'cordis.patch.yml', 'LICENSE', 'SOURCE.json']
  manifest.peerDependencies['@deepseek-ai/dsh-home-paths'] = '0.2.1-alpha.1'
  delete manifest.types
  delete manifest.bin
  manifest.scripts = {}
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}
