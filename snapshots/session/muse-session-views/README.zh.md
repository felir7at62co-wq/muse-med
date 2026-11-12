# 打包的会话卡片

[English](README.md) | 中文

这个无需密钥的构建产物用例通过真实的 Deep View 插件、原生工具发现和需要身份验证的 HTTP 回复接口验证普通会话卡片。必须将 `MUSE_MAIN_DEEP_VIEW_PACKAGE` 指向社区构建流水线生成并解包后的插件目录。Headless 测试框架会把该插件安装到隔离配置中，原生 Loader 会检查插件清单及宿主兼容性。缺少构建产物会明确报告前置条件失败，不会跳过用例。测试不会修改保留的第三方源码或兼容性豁免。

先构建宿主和已审核的插件，再解包归档后重放。在仓库根目录执行：

```sh
pnpm run build
pnpm --dir third_party/plugins/toolchain run build --only deep-view --out ../../../.artifacts/snapshot-community
mkdir -p .artifacts/snapshot-deep-view
tar -xzf .artifacts/snapshot-community/deep-view-0.1.2.tgz -C .artifacts/snapshot-deep-view
export MUSE_MAIN_DEEP_VIEW_PACKAGE="$PWD/.artifacts/snapshot-deep-view/package"
DSH_EXAMPLE_MODE=lib node node_modules/vitest/vitest.mjs run --config vitest.snapshot.config.ts snapshots/session/headless.snapshot.ts -t muse-session-views
```

运行完整快照测试时也要保留同一环境变量。解包目录必须位于仓库内，以便通过工作区安装解析声明的宿主同级依赖。源码启动器也可以使用这个已审核的 JavaScript 包，但本用例不会回退到无需构建的保留源码。刷新只会写入当前输出基准，不会修改已经提交的原始录制日志。
