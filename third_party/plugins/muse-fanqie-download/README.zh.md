# Muse 番茄下载工具

[English](README.md) | 中文

`fanqie_download_info` 检查一本或多本小说的官方完整目录。`fanqie_download` 将当前已发布的全部章节下载为 UTF-8 TXT，保存在发起会话的工作区。`bookIds` 接受十进制字符串 ID 或官方 `https://fanqienovel.com/page/<book-id>` 链接。结果包含当前官方书名、声明及下载章节数、文件绝对路径、SHA-256 和逐章收据。对连载小说，`complete` 表示当前已发布目录齐全，不表示作者已完结。仅检查目录不能声称下载已验证。

独立本地 Python 引擎使用正常匿名设备注册与读取接口。设备及协商密钥只保存在内存，不复制参考程序设备，不发布或写入日志。不内置闭源参考程序。采用 MIT 许可证的协议模块保留许可证声明，`SOURCE.json` 记录固定来源。引擎拒绝付费、VIP 或需要其他授权的内容，以及缺失、错书、错章、试看、未还原字体字符和不足长度的正文。所有书验证通过后才发布整批目录；失败或取消清理本批新建临时文件，保留既有下载。

正文提取优先使用 `<article>` 内的文字，否则使用 `<body>` 内的文字。它排除 `<head>`、`<script>` 和 `<style>` 内容，并保留块元素及 `<br>` 的换行；所选容器之外的文字不能补足章节声明字数。

Desktop 预设挂载工具并复用已打包的红果 Python/PyCryptodome 运行时。不需要额外 Java 服务、外部下载器或 TOS 密钥。独立配置可安装此包，应用 `cordis.patch.yml` 并设置 `MUSE_FANQIE_PYTHON_PATH`，或直接配置 `pythonExecutable`。Python 须包含 PyCryptodome 和正常 TLS 证书库；缺少运行时在首次调用时明确失败。加载插件不发起网络请求。模型工具通过 Host 子进程服务执行；卸载取消并等待引擎退出及文件清理。

配置项包括 `pythonExecutable`（默认空）、`requestTimeoutMs`（30000）、`callTimeoutMs`（1800000）、`graceMs`（1000）、`maxBooks`（10）、`batchSize`（10）、`maxResponseBytes`（16 MiB）、`maxChapterBytes`（2 MiB）、`maxBookBytes`（128 MiB）及 `maxOutputBytes`（16 MiB）。数值须为正安全整数，不限制章节总数。`outputDir` 默认 `downloads/fanqie`，须位于会话工作区内且不含符号链接目录。每批成功下载生成独立目录，不覆盖旧书。拒绝 HTTP 重定向；引擎只访问固定官方注册与阅读主机。

`node --test tests/*.test.js` 与 `<python> -I -B tests/engine_test.py` 执行离线行为检查。`node scripts/pack.mjs --out <绝对目录>` 生成 npm 包。构建 Host 与原生扩展后，将 `MUSE_FANQIE_LIVE_BOOK_IDS` 设为逗号分隔的授权免费书籍 ID，将 `MUSE_FANQIE_PYTHON_PATH` 设为 Python 路径，再运行 `node --test tests/live.test.js` 验证真实来源；未显式启用时跳过。平台安装包须由最终 Muse 发布验收；源码下载实测不代表 Windows 或 Mac 安装包已验证。
