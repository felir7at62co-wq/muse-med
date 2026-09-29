/** Display registered built-in MCP tools without copying their private connection settings. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const mcpDesktopCompatibility = { builtInConnections: 1 }

/** Apply the Desktop panel overlay to an isolated build directory. */
export function applyMcpDesktopCompatibility(directory) {
  const edit = (file, before, after) => {
    const path = join(directory, file)
    const source = readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
    if (source.split(before).length !== 2) throw new Error(`MCP Desktop overlay anchor changed: ${file}`)
    writeFileSync(path, source.replace(before, after))
  }
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
