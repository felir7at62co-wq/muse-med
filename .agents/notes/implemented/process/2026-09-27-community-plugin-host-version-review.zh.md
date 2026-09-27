# Agent Note: Community plugin review against Host 0.1.7-rc.2

Status: implemented

[English](2026-09-27-community-plugin-host-version-review.md) | 中文

## Problem

[社区插件构建](../../../../third_party/plugins/build.mjs)把五个固定上游快照对着已构建的 Host 包编译，只要 checkout 版本与其记录的版本不一致就拒绝启动（`host … needs a new compatibility review`）。因此合入上游 `0.1.7-rc.2` 会停在这道守卫上；而在未做它要求的复核前就挪动版本固定，等于交付没人对着这个 Host 编译过的插件。这些快照直接导入 Host 包：被删除的导出会编译失败，而仍然存在但语义已变的服务方法会编译通过、运行出错——首轮复核两类各遇到一次。

## Decision

五个插件现在对 Host `0.1.7-rc.2` 编译，所有版本固定点都记录该版本：`build.mjs` 的守卫、[Codex 检查](../../../../third_party/plugins/checks/codex-subagent.mjs)中的 `approvedVersion`、[构建测试](../../../../third_party/plugins/build.test.mjs)中的 peer 候选与 `SOURCE.json` 期望、插件 [README](../../../../third_party/plugins/README.zh.md) 及其中文配对，以及 [ponytail README](../../../../third_party/plugins/dsh-ponytail/README.md) 的 DSH 行。[upstream.json](../../../../upstream.json) 保留自己的 `pinnedVersion`：该字段记录本分支分叉自哪个上游提交，而不是插件编译所对的 Host。

### 被删除的共享 message source kind（dsh-ponytail）

上游从 `MessageSourceMap` 移除了 catch-all 的 `plugin` kind，改由每个生产者在自己的模块声明自己的 `kind`。Ponytail 用 `{ kind: 'plugin', plugin: name }` 投递八条状态通知，八处全部编译失败。现在它在自己的模块声明 `ponytail: { kind: 'ponytail' } & ContextFormed`，并发送 `{ kind: 'ponytail' }`——与 Host 对自己原先的 `plugin` 生产者（`time-context`、`runtime-context`、`repeat-tool-reminder`）所做的迁移一致。没有放宽任何断言，也没有在文档化扩展点之外自造 kind。

### 被删除的设置提供方（dsh-lark-bridge）

我们的 [Lark 运行时检查](../../../../third_party/plugins/checks/lark-desktop-runtime.mjs) 导入了 `@deepseek-ai/dsh-settings-file`；上游在把设置服务改为基于活动 profile 的 Config 派生表单时删除了它。这次迁移不是改名：检查现在组合一个真实 profile——bundle 层插入行、profile 自己的 patch 层存该行的值——并启动真实的 `config-editor`/`settings` 组合，因此它像真实部署一样，用组合条目 id `feishu-channel` 定位插件自己的设置段；另新增一个用例端到端跑通一次成功的扫码注册。

这次迁移暴露了插件自身的移植问题。当前服务上从来不存在 `settings.get(ns)`：命名空间就是条目 id，设置段就是该条目自己已解析的 Config，而 Loader 已经把它交给 `apply`。桥现在读取该 Config，通过两个凭证字段的实时引用取值，并用 `settings.update(entryId, credentials)` 持久化一次完成的注册。由于设置服务只写入实时（`volatile`）字段，`appId`、`appSecret` 和扫码记录 `registeredBy` 在 schema 中标记为 volatile；否则这个检查现在验证的凭证保存会被拒绝，fork 的“扫一次、长期保留该应用”行为就会丢失。由此带来两点：schema 不再标注 `z<Config>`（volatile 字段的输出是引用、输入仍是普通值，没有单一对象类型能同时满足两者；Host 的 `llm-deepseek` Config 也是同样布局），以及 `resolveConfig` 同时接受 Loader 挂载的 Config 和普通配置，在一处解引用这两个字段。

### 退役的覆盖层规则

[临时目录覆盖层](../../../../third_party/plugins/compatibility/lark-desktop.mjs) 的两条规则已删除且不再需要：`host.ts` 的 `options?` 参数和 `runtime.ts` 的 `settings.register(...)` 调用。两者都是为适配 fork 的 `register(ns, schema, { base, applies })` 签名而存在，而该签名已无调用方——插件自己注册的命名空间会指向没人提供的内容。

## Verification

在仓库根目录运行，`npm_execpath` 指向 pnpm 入口（`build.mjs` 要求该变量），并确保 Host 包已构建：

```sh
node third_party/plugins/build.mjs --only <name> --out <dir>   # dshmarket, dsh-codex-subscription, dsh-ponytail, dsh-lark-bridge, dsh-ffmpeg
node --test third_party/plugins/build.test.mjs
```

六次运行全部 exit 0；`build.test.mjs` 还会从全新临时目录重建每个插件并逐字节比较压缩包。Lark 检查报告 5 项通过（三个激活用例、扫码并持久化用例，以及 schema 标记），Codex 32 项，临时目录覆盖层复核 2 项。将来升级 Host 时，必须在再次挪动版本固定之前重跑同一套命令：守卫存在的意义就是让这次复核无法跳过，其中任何常量都不得为了把红的构建变绿而挪动。

## Alternatives considered

**只挪版本固定并构建。** 守卫本身就是复核的触发点，因此用新版本构建无论如何都是第一步；但只交付这一步，就会交付它掩盖的两个失败——ponytail 的编译中断，以及 Lark 检查对已删除包的导入。

**保留 `settings.get` 并让桥拥有自己的命名空间。** 注册命名空间正是上游删除的机制；插件自有的设置段对设置服务不可见——后者的命名空间按组合条目一一对应——因此凭证页面与桥会指向不同的设置段。

**不标记 volatile，改为丢弃凭证记录。** 只写 `appId`/`appSecret` 在没有 volatile 路径时同样会被拒绝；而改走配置编辑器写入，会让产品自己的凭证页面无法定位该设置段。

**随它导入的提供方一起退役 Lark 运行时检查。** 这个检查是桥的激活开关与凭证保存在真实 Loader 和真实设置服务下唯一相遇的地方，没有其他覆盖。

## Consequences

固定的社区产物现在在 peer 候选和 `SOURCE.json` 中声明 Host `0.1.7-rc.2`，下一次上游合并必须在该版本的构建运行前重做复核。Lark 快照的 `config.ts`、`host.ts`、`runtime.ts` 不再与其固定的上游文本一致——这是设置移植早已引入的既有偏离，现在又加上凭证字段，重新固定快照时必须重新套用。Ponytail 的通知携带新的 source kind，因此任何专门匹配 `{ kind: 'plugin', plugin: 'ponytail' }` 的转录读取方将不再命中；Host 自身的读取方按设计会放过未知 kind。Lark 检查新增了对已构建 `config-editor`、`settings`、`app-boot` 包的依赖，因此只能在 Host 包已构建的 checkout 中运行——这本就是 `build.mjs` 的要求。
