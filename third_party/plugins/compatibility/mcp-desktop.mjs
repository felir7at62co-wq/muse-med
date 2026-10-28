/** Mount the panel through dsh profiles and display built-in tools without private connection settings. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const mcpDesktopCompatibility = { builtInConnections: 1, globalCliShim: false, sharedAgentSkills: false, preserveSavedSkills: true }

/** Apply the Desktop panel overlay to an isolated build directory. */
export function applyMcpDesktopCompatibility(directory) {
  const edit = (file, before, after) => {
    const path = join(directory, file)
    const source = readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
    if (source.split(before).length !== 2) throw new Error(`MCP Desktop overlay anchor changed: ${file}`)
    writeFileSync(path, source.replace(before, after))
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
  edit('src/index.ts', 'const addResultSchema = z.object({ name: z.string(), kind: z.enum(["bundle", "flat"]), scope: scopeSchema });',
    'const addResultSchema = z.object({ name: z.string(), kind: z.enum(["bundle", "flat"]), scope: scopeSchema, status: z.literal("saved").optional(), discovery: z.enum(["ready", "pending", "unavailable"]).optional() });')
  edit('src/index.ts', `    // 让 DSH 做最终裁判：轮询注册表直到这批技能全部出现。
    // 一直不出现就整体回滚。
    const accepted = await this.waitForDiscovery(skills.map((skill) => skill.name), sessionId, targetProject ?? cwd);
    if (!accepted) {
      for (const target of written.reverse()) await rm(target, { recursive: true, force: true }).catch(() => {});
      throw new Error("DSH 未接受部分技能（格式校验未通过），已回滚。请检查 frontmatter 后重试");
    }
    return { name: skills.map((skill) => skill.name).join(", "), kind, scope: targetProject === undefined ? { kind: "global" } : await this.scopeForTarget(targetRoot, targetProject) };`,
  `    // Format validation and the file transaction have succeeded. Session discovery is separate.
    const discovery = await this.waitForDiscovery(skills.map((skill) => skill.name), sessionId, targetProject ?? cwd).catch(() => "unavailable");
    return { name: skills.map((skill) => skill.name).join(", "), kind, scope: savedScope, status: "saved", discovery };`)
  edit('src/index.ts', '    const stagingBase = join(targetRoot, ".dsh-skill-staging-" + process.pid + "-" + Math.random().toString(36).slice(2, 8));',
    '    const savedScope = targetProject === undefined ? { kind: "global" } : await this.scopeForTarget(targetRoot, targetProject);\n    const stagingBase = join(targetRoot, ".dsh-skill-staging-" + process.pid + "-" + Math.random().toString(36).slice(2, 8));')
  edit('src/index.ts', '        if (pending.size === 0) return true;', '        if (pending.size === 0) return "ready";')
  edit('src/index.ts', `        // 注册表不可用：视为已接收（没有可核对的依据）
        return true;`, `        // Keep saved files when availability cannot be checked.
        return "unavailable";`)
  edit('src/index.ts', `    return false;
  }
}

export function apply`, `    return "pending";
  }
}

export function apply`)
  edit('src/client.ts', 'addBusy: "正在添加技能…",', 'addBusy: "正在添加技能…",\n                        addSavedPending: "技能文件已保存，当前会话尚未发现。请刷新技能列表或在支持该技能的会话中使用。",\n                        addSavedUnavailable: "技能文件已保存，暂时无法检查是否可用，文件已保留。",')
  edit('src/client.ts', 'addBusy: "Adding skill…",', 'addBusy: "Adding skill…",\n                        addSavedPending: "Skill files are saved but are not available in this conversation yet. Refresh Skills or use a conversation that supports them.",\n                        addSavedUnavailable: "Skill files are saved. Availability could not be checked; your files are retained.",')
  edit('src/client.ts', `}).then(() => {
					setAdding({ status: "ok" });
					setTimeout(() => setRequest((value) => value + 1), 700);
					setTimeout(() => setAdding({ status: "idle" }), 2500);`, `}).then((result) => {
					setAdding(result.discovery === "ready" ? { status: "ok" } : { status: "saved", message: t(result.discovery === "unavailable" ? "addSavedUnavailable" : "addSavedPending") });
					setTimeout(() => setRequest((value) => value + 1), 700);
					if (result.discovery === "ready") setTimeout(() => setAdding({ status: "idle" }), 2500);`)
  edit('src/client.ts', `adding.status === "busy" ? (0, react_jsx_runtime.jsx)("p", {`, `adding.status === "saved" ? (0, react_jsx_runtime.jsx)("p", { className: c.addStatus, role: "status", children: adding.message }) : null,
						adding.status === "busy" ? (0, react_jsx_runtime.jsx)("p", {`)
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
    'subtitle: "查看内置知识库和已连接的 MCP 服务，也可以添加自己的服务器。",')
  edit('src/client.ts', 'external: "外部管理",', 'external: "内置 / 外部管理",\n                        museKnowledgeBase: "Muse 知识库（内置）",\n                        runtime: "已连接",')
  edit('src/client.ts', 'external: "External",', 'external: "Built-in / external",\n                        museKnowledgeBase: "Muse knowledge base (built-in)",\n                        runtime: "Connected",')
  edit('src/client.ts', 'className: m.name, children: server.serverName', 'className: m.name, children: server.serverName === "muse-account" ? t("museKnowledgeBase") : server.serverName')
  edit('src/client.ts', 'server.transport === "streamable-http" ? "HTTP" : "STDIO"', 'server.transport === "streamable-http" ? "HTTP" : server.transport === "stdio" ? "STDIO" : t("runtime")')
  return mcpDesktopCompatibility
}
