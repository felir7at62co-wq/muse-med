# Muse 逆向工具

[English](README.md) | 中文

Muse 可以在不执行样本的情况下检查工作区内的二进制，并从固定版本、采用 MIT 许可证的 reverse-skill 项目加载分析方法。`reverse_analyze` 返回 SHA-256、大小、可执行格式，以及受数量限制的 Mach-O 符号和准确地址。`reverse_skill` 按上游规则选择分析方法，返回原始说明和已安装资源路径。PE、ELF 识别不包含符号提取；ZIP、DMG 识别不包含解包。

Desktop 的创作和编程预设挂载此工具包。独立配置可以安装包并应用 `cordis.patch.yml`。配置项包括绝对路径 `assetRoot`（默认打包资源）、`maxFileBytes`（64 MiB）、`maxSymbols`（200）、`maxSymbolNameBytes`（2048）和 `timeoutMs`（60 秒）。相对资源路径、缺失资源和非正数限制会阻止加载。样本必须是发起会话工作区内的普通文件；拒绝越界路径和文件符号链接。先将获得用户授权的外部样本复制到工作区。读取保留样本并响应取消；卸载会取消并等待正在进行的读取。

资源包只包含分析方法和脚本，不包含 Java/Python、反编译器、商业许可证、MCP 服务或采用单独许可证的 CTF 配套项目。加载工具包不会安装软件，也不授予目标操作或网络访问权限。深入分析须遵循上游范围和脚本确认要求；不能把静态识别当作源码恢复或可用下载引擎。外部工具仍适用各自的安装要求与许可证。

`SOURCE.json` 记录上游提交和各文件 SHA-256；保留随包 MIT 与嵌套许可证声明。`node --test tests/*.test.js` 执行离线行为检查，`node scripts/pack.mjs --out <绝对目录>` 生成 npm 包。不需要或内置 TOS 密钥。
