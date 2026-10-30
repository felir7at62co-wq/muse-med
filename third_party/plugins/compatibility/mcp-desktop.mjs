/** Mount the panel through dsh profiles and display built-in tools without private connection settings. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const mcpDesktopCompatibility = { builtInConnections: 1, globalCliShim: false, sharedAgentSkills: false, preserveSavedSkills: true, desktopManagedUpdates: true, clearsCurrentUpdateNotice: true }

/** Apply the Desktop panel overlay to an isolated build directory. */
export function applyMcpDesktopCompatibility(directory) {
  const edit = (file, before, after) => {
    const path = join(directory, file)
    const source = readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
    if (source.split(before).length !== 2) throw new Error(`MCP Desktop overlay anchor changed: ${file}`)
    writeFileSync(path, source.replace(before, after))
  }
  const editMany = (file, before, after, count) => {
    const path = join(directory, file)
    const source = readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
    if (source.split(before).length !== count + 1) throw new Error(`MCP Desktop overlay anchor changed: ${file}`)
    writeFileSync(path, source.replaceAll(before, after))
  }
  edit('src/index.ts', 'import { ensureGlobalShim } from "./global-shim.js";\n', '')
  edit('src/index.ts', '  ensureGlobalShim(ctx.logger);\n', '')
  edit('src/index.ts', '      agentsHome: resolvePath(process.env.DSH_AGENTS_HOME?.trim() ? process.env.DSH_AGENTS_HOME : join(homedir(), ".agents"))',
    '      agentsHome: undefined')
  edit('src/index.ts', '    push(join(agentsHome, "skills"), "user-agents", undefined);\n', '')
  edit('src/index.ts', '    const userRoots = [join(dshHome, "skills"), join(agentsHome, "skills")];',
    '    const userRoots = [join(dshHome, "skills")];')
  edit('src/index.ts', '      ? [{ path: join(dshHome, "skills"), source: "user-dsh" }, { path: join(agentsHome, "skills"), source: "user-agents" }]',
    '      ? [{ path: join(dshHome, "skills"), source: "user-dsh" }]')
  edit('src/index.ts', '      push(join(workspace.path, ".dsh", "skills"), "project-dsh", workspace.path);',
    '      push(join(workspace.path, ".muse", "skills"), "project-muse", workspace.path);\n      push(join(workspace.path, ".dsh", "skills"), "project-dsh", workspace.path);')
  edit('src/skill-files.ts', '    push(join(project, ".dsh", "skills"), "project-dsh", project);',
    '    push(join(project, ".muse", "skills"), "project-muse", project);\n    push(join(project, ".dsh", "skills"), "project-dsh", project);')
  edit('src/provider.ts', '    const agentsHome = process.env.DSH_AGENTS_HOME ?? join(homedir(), ".agents");',
    '    const agentsHome = undefined;')
  edit('src/provider.ts', '    return [join(agentsHome, "skills"), join(dshHome, "skills")];',
    '    return [join(dshHome, "skills")];')
  edit('src/index.ts', `  scope: scopeSchema
});

/** 注册到 API 网关的类型化 wire 描述符。 */`, `  scope: scopeSchema,
  status: z.literal("saved").optional(),
  discovery: z.enum(["ready", "pending", "unavailable"]).optional()
});

/** 注册到 API 网关的类型化 wire 描述符。 */`)
  edit('src/index.ts', '    const stagingBase = join(targetRoot, ".dsh-skill-staging-" + process.pid + "-" + Math.random().toString(36).slice(2, 8));',
    '    const savedScope = targetProject === undefined ? { kind: "global" } : await this.scopeForTarget(targetRoot, targetProject);\n    const stagingBase = join(targetRoot, ".dsh-skill-staging-" + process.pid + "-" + Math.random().toString(36).slice(2, 8));')
  edit('src/index.ts', `        skipped.push({ name: skill.name, reason: "写入失败（已回滚该技能）：" + (error instanceof Error ? error.message : String(error)) });`,
    `        for (const item of written.reverse()) await rm(item.target, { recursive: true, force: true }).catch(() => {});
        await rm(stagingBase, { recursive: true, force: true }).catch(() => {});
        throw new Error("写入技能文件失败（已回滚）：" + (error instanceof Error ? error.message : String(error)));`)
  edit('src/index.ts', `    // ── DSH 做最终裁判：未被注册表接收的单独回滚，其余保留 ────────────────
    const missing = await this.waitForDiscovery(written.map((item) => item.name), sessionId, targetProject ?? cwd);
    const added: any[] = [];
    for (const item of written) {
      if (missing.has(item.name)) {
        await rm(item.target, { recursive: true, force: true }).catch(() => {});
        skipped.push({ name: item.name, reason: "DSH 未接受（frontmatter 校验未通过或不可发现），已回滚" });
        continue;
      }
      added.push({ name: item.name, kind: item.kind });
    }
    if (added.length === 0) throw new Error("没有技能被 DSH 接受，已全部回滚：" + describeSkips(skipped));
    return { added, skipped, warnings, scope: targetProject === undefined ? { kind: "global" } : await this.scopeForTarget(targetRoot, targetProject) };`,
  `    // Saved files survive delayed or unavailable Session discovery.
    if (written.length === 0) throw new Error("没有技能写入：" + describeSkips(skipped));
    const missing = await this.waitForDiscovery(written.map((item) => item.name), sessionId, targetProject ?? cwd).catch(() => undefined);
    const discovery = missing === undefined ? "unavailable" : missing.size === 0 ? "ready" : "pending";
    const added = written.map((item) => ({ name: item.name, kind: item.kind }));
    return { added, skipped, warnings, scope: savedScope, status: "saved", discovery };`)
  edit('src/index.ts', `        // 注册表不可用：视为已接收（没有可核对的依据）
        return new Set();`, `        // Saved files remain available for later discovery.
        return undefined;`)
  edit('src/client.ts', 'addBusy: "正在添加技能…",', 'addBusy: "正在添加技能…",\n                        addSavedPending: "技能文件已保存，当前会话尚未发现。请刷新技能列表或在支持该技能的会话中使用。",\n                        addSavedUnavailable: "技能文件已保存，暂时无法检查是否可用，文件已保留。",')
  edit('src/client.ts', 'addBusy: "Adding skills…",', 'addBusy: "Adding skills…",\n                        addSavedPending: "Skill files are saved but are not available in this conversation yet. Refresh Skills or use a conversation that supports them.",\n                        addSavedUnavailable: "Skill files are saved. Availability could not be checked; your files are retained.",')
  edit('src/client.ts', `                    setAdding({ status: "ok", message: summarizeAdd(result) });`.replaceAll('    ', '\t'),
    `                    setAdding(result.discovery === "ready" ? { status: "ok", message: summarizeAdd(result) } : { status: "saved", message: summarizeAdd(result) + " " + t(result.discovery === "unavailable" ? "addSavedUnavailable" : "addSavedPending") });`.replaceAll('    ', '\t'))
  edit('src/client.ts', '                    setTimeout(() => setAdding((prev) => (prev.status === "ok" ? { status: "idle" } : prev)), 8000);'.replaceAll('    ', '\t'),
    '                    if (result.discovery === "ready") setTimeout(() => setAdding((prev) => (prev.status === "ok" ? { status: "idle" } : prev)), 8000);'.replaceAll('    ', '\t'))
  edit('src/client.ts', 'adding.status === "ok" ? (0, react_jsx_runtime.jsxs)("div", {', '(adding.status === "ok" || adding.status === "saved") ? (0, react_jsx_runtime.jsxs)("div", {')
  edit('src/client.ts', 'hostIcon(primitiveIcon("IconXOutlineRegular"), 14, PATHS)', 'hostIcon(primitiveIcon("IconCloseOutlineRegular"), 14, PATHS)')
  editMany('src/client.ts', 'if (latest !== null && snapshot.updateAvailable === true) setUpdateBanner(t("checkUpdateAvailable") + latest + t("checkUpdateCurrent") + currentV + t("checkUpdateHint"));',
    'setUpdateBanner(latest !== null && snapshot.updateAvailable === true ? t("checkUpdateAvailable") + latest + t("checkUpdateCurrent") + currentV + t("checkUpdateHint") : null);', 2)
  editMany('src/client.ts', 'checkUpdateHint: "）。可在终端运行 dsh-panel update 更新"', 'checkUpdateHint: "）。请更新 Muse 应用以获取此插件更新。"', 2)
  editMany('src/client.ts', 'checkUpdateHint: "). Run dsh-panel update in a terminal to install it"', 'checkUpdateHint: "). Update the Muse application to receive this plugin update."', 2)
  edit('src/mcp/gateway.ts', '      return { servers, externalServers, patch };', `      const known = new Set([...servers, ...externalServers].map(row => row.serverName));
      const counts = new Map<string, number>();
      for (const tool of this.C.tools?.schemas?.() ?? []) {
        const name = /^mcp__([A-Za-z0-9_-]+)__/.exec(tool.name)?.[1];
        if (name && !known.has(name)) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      for (const [serverName, toolCount] of counts) {
        externalServers.push({ serverName, transport: serverName === 'muse-account' ? 'stdio' : 'unknown',
          enabled: true, managed: false, fiberPhase: 'active', toolCount,
          envKeys: [], headerKeys: [], toolCallTimeoutMs: 60000, failOnStartupError: false,
          reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 } });
      }
      return { servers, externalServers, patch };`)
  edit('src/client.ts', 'subtitle: "在 profile cordis.patch.yml 的受管块中维护 MCP 服务器，保存后由 DSH HMR 热加载。",',
    'subtitle: "查看 Muse 内置服务和已连接的 MCP 服务，也可以添加自己的服务器。",')
  edit('src/client.ts', 'external: "外部管理",', 'external: "内置 / 外部管理",\n                        museKnowledgeBase: "Muse 服务（内置）",\n                        runtime: "已连接",')
  edit('src/client.ts', 'external: "External",', 'external: "Built-in / external",\n                        museKnowledgeBase: "Muse services (built-in)",\n                        runtime: "Connected",')
  edit('src/client.ts', 'className: m.name, children: server.serverName', 'className: m.name, children: server.serverName === "muse-account" ? t("museKnowledgeBase") : server.serverName')
  edit('src/client.ts', 'server.transport === "streamable-http" ? "HTTP" : "STDIO"', 'server.transport === "streamable-http" ? "HTTP" : server.transport === "stdio" ? "STDIO" : t("runtime")')
  return mcpDesktopCompatibility
}
