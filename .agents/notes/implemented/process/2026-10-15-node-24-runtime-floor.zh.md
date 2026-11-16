# Agent Note: Node 运行时下限与兼容性覆盖

Status: implemented

[English](2026-10-15-node-24-runtime-floor.md) | 中文

## 问题

根 `engines.node` 范围承诺安装后的工作区支持其允许的每一个运行时。其下限必须覆盖 DSH 使用的运行时 API 和所安装依赖声明的要求。否则，严格安装可能会在 DSH 启动前拒绝一个受支持的版本。

## 决策

将 `engines.node` 设为 `^24.15.0 || >=26.0.0`。24.x 系列的下限为 Node 24.15。插件仓库解析使用 hosted-git-info 10.1.1，其支持范围排除早期 Node 24 和 Node 25。此决策取代 [Node 22.19 下限](../../archived/process/2026-07-06-node-engine-floor.md)。迁移说明见[升级指南](../../../../docs/upgrade-guide/v0.2.2-rc.2/node-24-15/guide.zh.md)。

主要 Node 24 任务负责完整类型检查和单元测试覆盖率。聚焦的兼容性任务在固定的 Node 24.15 和 Node 26 上运行。固定下限避免用另一个浮动 Node 24 任务替代最低版本覆盖。两个受支持系列均使用 Node 24.12 引入的 v2 私有模块加载器；兼容辅助代码保留旧宿主的加载器测试数据，但不承诺在这些宿主上安装。

Node 24.15 兼容性任务还构建产物，并检查随产品提供的 Web CLI 能在禁用全文 Session 搜索时启动和释放资源。command-entrypoint、source-worker、Zstandard、source-launch、profile-resolution 和 jsdom-storage 检查在两个兼容性版本上运行。真实 API e2e 任务保留在 Node 24，因为它们验证提供方集成。

Node 类型声明版本跟随各编译程序使用的 API；依赖的声明可能需要高于运行时下限的类型包。运行时兼容性任务仍负责验证可执行 API 是否可用。独立发布的原生 addon 有自己的运行时与类型支持策略。

## 后果

- 使用 Node 22、Node 24.0–24.14 和 Node 25 的安装必须先升级，才能运行 DSH。内嵌运行时的打包应用不要求升级系统 Node。
- 受支持的运行时无需启用标志即可使用 `node:sqlite` 和原生 TypeScript 类型剥离。源码 CLI 仍使用声明的 `tsx/esm` 启动器。
- 兼容性任务图保留受支持的 v2 加载器和旧宿主测试数据。
- 后续提升运行时下限时，必须一起更新 `engines.node`、兼容性任务、当前文档、本文和升级指南。

## 考虑过的替代方案

- **保留 Node 22 支持。** 这会将 OAR 库排除在受支持的安装之外。
- **采用 OAR 声明的 Node 24.0 下限。** 现有脚本入口依赖 `import.meta.main`，而 Node 24.0 缺少该功能。仅凭依赖下限无法确定应用下限。
- **只验证最新的 Node 24。** 这不能验证受支持的最低版本。
- **将 Node 声明提升至下限之上。** 这会允许代码使用受支持运行时可能缺少的 API 编译通过。
