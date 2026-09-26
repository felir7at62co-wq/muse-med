# 社区插件源码与构建

[English](README.md) | 中文

这五份源码快照保留了 Muse Med 使用的社区插件。[sources.json](sources.json) 固定各公开上游仓库、修订、版本及许可证。快照保留上游源码和清单；部分文本文件将 CRLF 规范为 LF。已安装的用户配置、凭据、用户媒体和生成的运行时均不作为构建输入。翻译检查仅排除这五个上游目录；本 README 与其他自有文档仍须成对维护。

## 构建

使用已安装依赖、且已构建当前 Host 包的源码仓库。在仓库根目录运行：

```sh
pnpm exec node third_party/plugins/build.mjs --out .artifacts/community-plugins
pnpm exec node --test third_party/plugins/build.test.mjs
```

[build.mjs](build.mjs) 按独立的[工具链锁文件](toolchain/pnpm-lock.yaml)执行冻结安装并禁用安装脚本，再在临时目录中逐个编译和打包插件。`--only dsh-ffmpeg` 可选择单个源码目录。临时目录链接当前仓库已构建的 Host 包，不使用在线用户配置。子进程检查使用临时 Harness 主目录，并排除含凭据的环境变量。脚本先移除链接，再删除临时目录；源码目录不会产生 `lib` 或 `node_modules`。

每个压缩包保留上游许可证和 Codex 声明，按需添加所内嵌 Heroicons 的许可证，并在 `SOURCE.json` 记录上游固定版本、Host 版本及工具链锁文件摘要。产物清单禁用生命周期脚本、固定构建所用的运行时依赖版本，并仅向 DSH peer 候选增加经测试的精确 Host 版本。上游清单保持不变。Host 版本变化时，脚本拒绝构建，直到完成新的兼容性审核。

Codex 临时运行时补丁在 `SOURCE.json` 记录修改：子任务检查与准备仅接受 provider `0.1.6-alpha.2`，CLI 仍固定为 `0.153.4`。打包后从 `app.asar.unpacked` 解析 CLI 清单和启动文件。保留的上游文件不变；源码文本不符合预期时，补丁失败，而非静默跳过。

## 兼容性与桌面集成

构建脚本导入每个生成的 Host 入口。Codex 针对当前 DSH API 和 pi-ai 0.85.1 执行 26 项保留的上游检查，包括模型准备和已认证传输校验；上游注册上下文是测试替身，而非完整桌面 Loader。另有六项 Codex 检查加载真实 provider 和 CLI，通过本地模拟对端验证其认证传输，并拒绝运行时版本偏移及错误的归档路径。FFmpeg 执行 89 项保留的检查。构建测试检查全部导出产物文件，并验证同一平台下两个全新临时目录生成的五个插件压缩包均逐字节一致。这不代表跨平台或整个安装包逐字节一致。

[桌面打包入口](../../apps/desktop/scripts/package-target.ts)是将这些压缩包放在第一方打包输入旁的集成位置。[包集合准备](../../apps/desktop/scripts/prepare-package-set.ts)必须将五个插件包名选为显式根；源码工作区不得以注册表安装包替代这些压缩包。打包不等于启用：发布仍须通过真实桌面 Host/Client 烟测。账号登录、收费请求和真实媒体编码不在这些免密构建检查范围内。

Market 的 HTTP 界面不适用于无端口的桌面传输。Lark 的上游代码会在无凭据时发起开户请求，并运行本地控制服务；明确配置前应保持禁用。Codex 使用可选的 connection fetch 传输，不要求 Web 服务器。FFmpeg 需要产品配置编码器路径。压缩包存在不代表功能已启用。

## 许可证

再分发前请阅读各自保留的上游许可证和声明。构建保留 Codex PSD 编解码器声明，并包含内嵌 Heroicons 的完整许可证。运行时依赖在打包后的依赖图中保留各自许可证。Muse Med 不宣称这些项目由本团队创作或得到其背书。
