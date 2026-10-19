# Muse 番茄下载工具

[English](README.md) | 中文

`fanqie_search` 按书名或关键词搜索官方书籍页签。传入 `query`；`hasMore` 为真时，将返回的 `nextPassback` 原样作为 `passback` 继续同一搜索。结果包含十进制字符串 `bookId`、当前书名及原名、作者、官方书籍页链接和声明章节数。将候选 ID 交给 `fanqie_download` 前须匹配用户指定的书名和作者；同名书身份不明确时需选书，不能把搜索排名当成用户意图。空结果表示搜索成功但没有候选。搜索不写文件，也不代表正文可下载或已完整下载。

`fanqie_download_info` 检查一本或多本小说的官方完整目录。`fanqie_download` 将当前已发布的全部章节下载为 UTF-8 TXT，保存在发起会话的工作区。`bookIds` 接受十进制字符串 ID 或官方 `https://fanqienovel.com/page/<book-id>` 链接。结果包含当前官方书名、声明及下载章节数、文件绝对路径、SHA-256 和逐章收据。对连载小说，`complete` 表示当前已发布目录齐全，不表示作者已完结。仅检查目录不能声称下载已验证。

独立本地 Python 引擎使用正常匿名设备注册与读取接口。设备及协商密钥只保存在内存，不复制参考程序设备，不发布或写入日志。不内置闭源参考程序。采用 MIT 许可证的协议模块保留许可证声明，`SOURCE.json` 记录固定来源。引擎拒绝付费、VIP 或需要其他授权的内容，以及缺失、错书、错章、试看、未还原字体字符和不足长度的正文。所有书验证通过后才发布整批目录；失败或取消清理本批新建临时文件，保留既有下载。

正文提取优先使用 `<article>` 内的文字，否则使用 `<body>` 内的文字。它排除 `<head>`、`<script>` 和 `<style>` 内容，并保留块元素及 `<br>` 的换行；所选容器之外的文字不能补足章节声明字数。

Desktop 预设挂载工具并复用已打包的红果 Python/PyCryptodome 运行时。不需要额外 Java 服务、外部下载器或 TOS 密钥。独立配置可安装此包，应用 `cordis.patch.yml` 并设置 `MUSE_FANQIE_PYTHON_PATH`，或直接配置 `pythonExecutable`。Python 须包含 PyCryptodome 和正常 TLS 证书库；缺少运行时在首次调用时明确失败。加载插件不发起网络请求。Host 以 `-X utf8` 启动隔离 Python，使 Windows 与 macOS 上的 JSON 输入输出均使用 UTF-8，不受控制台代码页影响。模型工具通过 Host 子进程服务执行；卸载取消并等待引擎退出及文件清理。

配置项包括 `pythonExecutable`（默认空）、`networkMode`（默认 `direct`，接受 `direct` 或 `system`）、`requestTimeoutMs`（30000）、`callTimeoutMs`（1800000）、`graceMs`（1000）、`maxBooks`（10）、`batchSize`（10）、`maxResponseBytes`（16 MiB）、`maxChapterBytes`（2 MiB）、`maxBookBytes`（128 MiB）及 `maxOutputBytes`（16 MiB）。数值须为正安全整数，不限制章节总数。`outputDir` 默认 `downloads/fanqie`，须位于会话工作区内且不含符号链接目录。每批成功下载生成独立目录，不覆盖旧书。拒绝 HTTP 重定向；引擎只访问固定官方注册与阅读主机。

`networkMode: direct` 为此引擎禁用代理发现，包括环境代理变量和 macOS 系统代理。`networkMode: system` 使用 Python urllib 从环境变量及操作系统发现代理。引擎失败后不会自动切换模式，两种模式均保持 TLS 证书验证。需要保留系统代理行为时，在 bundle 行之后应用以下补丁：

```yaml
- id: muse-fanqie-download
  config:
    pythonExecutable: !!js process.env.MUSE_FANQIE_PYTHON_PATH || process.env.MUSE_HONGGUO_PYTHON_PATH || ''
    networkMode: system
```

补丁会替换该行的完整 `config`；须在同一映射中保留自定义 Python 路径和限制。此示例要求在所列环境变量之一中设置 Python 路径。应用补丁后重启配置。网络模式属于插件配置，不是由模型选择的工具参数。

请求失败时返回 `sourceStage`（`registration`、`search`、`catalog`、`key-negotiation` 或 `chapter-download`）、固定目标 `host`、`networkMode`，以及包含 `type`、`reasonType`、长度受限的诊断 `message` 和可用 `httpStatus` 或 `errno` 的 `error`。引擎初始化前的失败不带请求阶段或主机。诊断不包含请求 URL 及查询字符串、请求头、响应正文、设备身份、签名材料或凭证。Muse 可以区分注册失败和后续读取失败，无需暴露私有协议数据。目录成功仍只证明目录可读；只有成功下载的章节计数、逐章收据和 TXT SHA-256 才能证明完整下载。

`node --test tests/*.test.js` 与 `<python> -I -B tests/engine_test.py` 执行离线行为检查。`node scripts/pack.mjs --out <绝对目录>` 生成 npm 包。构建 Host 与原生扩展后，将 `MUSE_FANQIE_PYTHON_PATH` 设为 Python 路径，再运行 `node --test tests/live.test.js` 验证真实来源。`MUSE_FANQIE_LIVE_QUERY` 启用书名搜索、目录解析与翻页检查；`MUSE_FANQIE_LIVE_BOOK_IDS` 启用逗号分隔的授权免费书籍 ID 全文下载检查。各用例未显式启用时跳过。平台安装包须由最终 Muse 发布验收；源码下载实测不代表 Windows 或 Mac 安装包已验证。
