# Agent Note：上游设置服务上的飞书开关

Status: implemented

[English](2026-09-28-feishu-switch-on-the-upstream-settings-service.md) | 中文

## 问题

上游 `0.1.7-rc.2` 删除了旧的文件提供者 `@deepseek-ai/dsh-settings-file`（legacy `settings.yaml`），并在同一行 id 下组合 `@deepseek-ai/dsh-settings`。替代品没有 `get`、没有 `register`、也没有文档：一个设置段属于某个组合 entry， 以该 entry 的 id 命名，内容就是该 entry 自己的 `Config` 字段，其中只有 `volatile()` 的可写。

而整个飞书栈都建立在那个文档之上。`apps/desktop-host/src/feishu-gate.ts` 解析 `<home>/settings.yaml` 来决定桥接行的 entry 级 `disabled`；`@deepseek-ai/dsh-feishu-settings` 通过 `SettingsProvider` 注册 `feishu` 与 `dsh-lark-bridge` 两个段，并把凭证对存进文档；`apps/desktop/tests/desktop-feishu-config.spec.ts` 断言读取器在文档不可读时的行为。合并之后 这些消费方全部无法编译：宿主面的 `error TS` 里有 85 条只与这个栈有关。

## 决定

**开关就是某个组合行自己的 Config。** `@deepseek-ai/dsh-feishu-settings` 以 id `feishu` 组合，并导出 `Config = z.object({ enabled: z.boolean().default(false).volatile() })`。`feishuGateLayer(rows)` 从组合出的 `feishu` 行读取 `enabled`，并把它重述进 `feishu-channel` 行自己的 `enabled` 键——这正是打包插件在启动同步层、控制服务、 心跳或二维码应用注册之前读取的开关。只有显式 `true` 才开门；行缺失、键缺失、以及字符串 `"true"` 都表示关闭。

**桥接行保持挂载但惰性，而不是 entry-disabled。** 在这个 harness 里，插件的设置段就是它自己解析出的 Config，所以被 entry-disabled 的行根本没有段可写——而“在桥接真正运行之前就存下凭证对”恰恰是 `main` 的凭据存储行为（“store the credential pair while no bridge row owns the section”）要提供的能力。因此出厂桌面补丁把 `enabled: false` 连同各项激活 控制一起作为 fail-safe 携带，gate 再整体替换该 config。可观察的保证没有变化：开关关闭时，打包桥接会在任何副作用之前 返回，而且完全不读取任何 `settings.yaml` 式文档。

**凭证对就是那一行的段。** `FeishuSetupService` 用 `settings.update('feishu-channel', …)` 写入、用 `settings.mutate(...)` 清除，并通过 `describe({ redactSecrets: true })` 读回：只报告 app id、扫码者 open id 以及密钥是否 已设置，永远不返回密钥本身。失败保留 `main` 已发布的受限 code（`feishu/credentials-unwritable` 附 `section-unregistered` 或 `write-rejected`、`feishu/secret-required`、`feishu/login-failed` 附平台 code），并在 `RemoteErrorDetailsMap` 中声明；页面把每个原因渲染成自己的文案，且在写入被拒后保留已输入的密钥，便于操作者重试。

**已存的值随文档一起搬走。** `SettingsForms` 在升级后的首次启动把 `<home>/settings.yaml` 改名为 `settings.yaml.imported`，并用页面同一条 `update()` 路径导入每个段，于是段落进 profile 补丁、以 entry id 为键；改名先 发生，这正是部分导入不会重复的原因，备份里则保留运行中组合拒绝接收的任何内容。名称映射是显式的，因为有三个段的名字与 其 entry 不同：`dsh-lark-bridge` → `feishu-channel`、`agent-presets` → `agent-preset-registry`、 `ui-developer-tools`/`ui-onboarding`/`shell` → 各自的拥有行。

## 考虑过的替代方案

**保留 entry 级 `disabled`，把凭证对挪到产品行。** 这保住了组合期的开关，代价是无法在激活前保存凭据：桥接行被 disable 时 没有段可写，操作者就无法在打开开关之前存下扫到的凭证对——而那正是该提交修掉的缺陷。它还会迫使 gate 点名凭证字段，而出厂 补丁刻意从不组合它们。

**为产品行复活 `@deepseek-ai/dsh-settings-file`。** 已否决：这等于回退一个上游拥有的组合行，并只为承载一个布尔值而保留 一个上游已删除的包。

**保留分支迁移里那个裸 `Error`。** `main` 发布带 code 的 `RemoteError`，是因为设置服务自己的消息会引用它写入的 entry 与路径，而 schema 拒绝可以引用被拒绝的值——这里就是密钥。页面无法为它无法分类的失败命名。

## 后果

- `apps/desktop-host/tsconfig.json` 现在引用 `packages/host/feishu-settings/tsconfig.host.json`；该包的 client 面把 `../../client/{locale,ui-settings}/tsconfig.client.json` 写全，而不是引用目录——这正是合并附录记录的 TS6306 形态。
- `ensureBridgeSection()` 随文件提供者一起退役：`register()` 不复存在，因此没有桥接行的组合无法被“补上”一行；页面改为 报告 `writable: false` 与原因 `section-unregistered`，而不是创建段。
- `desktop-feishu-config.spec.ts` 退役：其中文档读取器的用例随提供者失去指涉对象，其余组合用例由 `apps/desktop/tests/feishu-setup-loader.spec.ts` 拥有——后者把同一批出厂补丁文件通过真实 Loader 启动。
- 实测：本块 `pnpm run build:lib` 的 `error TS` 由 64 降到 39（剩余 39 条全在 `apps/desktop/scripts/package-target.ts` 及其 spec，属第 2 块）；`pnpm exec vitest run packages/settings/settings/tests packages/host/feishu-settings/tests` → 84 passed；`pnpm exec vitest run apps/desktop/tests/feishu-setup-loader.spec.ts` → 5 passed。client 面的 `tsc -b` 仍无法运行，因为宿主面在第 2 块处 停下，尚未生成 typert remote 产物。
