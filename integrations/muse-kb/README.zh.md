# MUSE 云端知识库补丁

[English](README.md) | 中文

此目录保存适用于独立源码树 `E:\工作间\muse-local-dev\source\muse-accounts` 的[阅读授权补丁](0001-granted-kb-reading.patch)。补丁加入按账号授权的共享文档权限，以及把登录 cookie 换成知识库访问令牌的接口。[`services/muse-accounts`](../../services/muse-accounts/README.zh.md) 中的发布服务还提供账号私有剧本入库和 [Muse LLM Wiki](../../services/muse-accounts/README.zh.md#muse-llm-wiki)。只应用此补丁不会新增 `ingest_script` 或 Wiki 工具；该操作需要部署发布服务。

## 应用与验证

隔离分支合并、目标云端源码经审阅后，在 PowerShell 中运行：

```powershell
git -C 'E:\工作间' apply --check --directory=muse-local-dev/source 'E:\deepseek-harness\integrations\muse-kb\0001-granted-kb-reading.patch'
git -C 'E:\工作间' apply --directory=muse-local-dev/source 'E:\deepseek-harness\integrations\muse-kb\0001-granted-kb-reading.patch'
Push-Location 'E:\工作间\muse-local-dev\source\muse-accounts'
node --test kb-opening.test.mjs account.test.mjs gateway.test.mjs store.test.mjs
Pop-Location
```

部署需另行执行。补丁新增 `kb-grants.mjs` 和 `kb-opening.test.mjs`，修改 `gateway.mjs`、`kb-mcp.mjs` 与 `kb-vault.mjs`。补丁适配 2026-09-28 检查的本地云端源码；`git apply --check` 会在修改文件前检测源码变化。

## 文档授权

将 `MUSE_KB_DOCUMENT_GRANTS` 设为网关管理员控制的 JSON 文件路径，并把文件放在编辑器可写的知识库目录之外。网关在启动时校验并加载授权文件。修改授权（包括撤销）后必须重启网关；仅修改文件不会撤销访问。未设置路径时授权集合为空，任何账号令牌都无法检索或阅读文档。现有绑定账号的 HMAC 令牌仍可入库，但检索和阅读也受同一份授权约束。

```json
{
  "version": 1,
  "grants": [
    {"id": "SRC-2026-09-28-001", "kind": "viral-script", "level": "opening", "access": "all-authenticated", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "title": "Approved script"},
    {"id": "wiki/剧本/节奏复盘", "kind": "knowledge", "level": "read", "access": "accounts", "accountIds": ["0123456789abcdef"], "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
  ]
}
```

将示例 ID 换成知识库来源包清单中的 ID、Wiki 路径，以及目标账号稳定的 16 位小写十六进制 ID。每个示例 `sha256` 都应替换为完整、原样的 `raw/sources/<ID>/extracted.md` 或 `wiki/<path>.md` 文件的小写 SHA-256；在 Windows 上可用 `(Get-FileHash -Algorithm SHA256 <path>).Hash.ToLowerInvariant()` 取得摘要。可选的 `title` 由管理员指定；来源包若没有此字段，就显示 ID，绝不使用知识库清单中的标题。文档修改后，必须在授权文件中写入新摘要并重启网关，才能阅读修改后的内容。`viral-script` 是管理员对来源包的标定，标题本身不会产生此标定。`knowledge` 条目可指向来源包或 Wiki 页面。`opening` 仅允许阅读前 24,000 个 Unicode 字符；`read` 允许分页阅读受支持文档的全文。只有标为 `viral-script` 的来源包可调用 `read_opening`；获得 `read` 授权的 Wiki 页面和普通来源包使用 `read`。缺少 `kind` 或有效 `sha256` 的条目会使网关启动失败。

## 账号与 MCP 访问

已登录账号服务带着会话 cookie 和网关源地址发送空的 `POST /api/kb/access`。网关返回 `{url, token, expiresAt}`。不透明令牌最长 15 分钟到期；登录会话结束、账号被禁用或密码改变时会立即失效。这个独立补丁的账号令牌可调用 `search`、`status`、`read` 和 `read_opening`，不能调用共享 vault 的 `ingest`。发布服务在保留该限制的同时，增加账号私有的 `ingest_script`。

两种令牌的 `search` 都只返回获得授权的 ID，并标示文档是来源包还是 Wiki 页面，以及管理员指定的类别。网关对每个获授权文件只打开并读取一次，先将完整字节与 `sha256` 核对，再从这些字节生成标题、匹配结果、摘要与向量查询。修改或无法读取的文件不会出现在 `search` 和 `status` 中，两种阅读工具也会拒绝它。对于 `opening` 授权，匹配和摘要只使用前 24,000 个字符；后文生成的向量不可见。`status` 只统计通过校验的文档，不显示全局向量数量。`read` 按 ID 阅读获得全文授权的来源包或 Wiki 页面，每页最多 6,000 字符。`read_opening` 按 ID 阅读标为 `viral-script` 的授权来源包，最多四页；结果显示来源包 ID 或管理员指定的标题。两种阅读工具都返回来源总字节数、精确的零基字符范围、当前页码、正文是否还有未读部分，以及下一段起点。智能体应沿 `nextStart` 阅读到所需场景和首个悬念；若先到达开头上限，就不能声称已读完整参考剧本。

阅读和检索工具拒绝超过 4 MiB 的文档。在此上限内，`read` 接受从 0 到 4,194,000、按 6,000 字符对齐的 `start`，因此返回的 `nextStart` 总是有效。这个独立补丁的检索在核对完整文件摘要后，最多索引前 400,000 个字符；[发布版 Wiki 服务](../../services/muse-accounts/README.zh.md#muse-llm-wiki)检索完整获授权正文。
