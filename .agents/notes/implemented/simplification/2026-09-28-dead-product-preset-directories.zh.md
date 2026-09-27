# Agent Note: 删除失效的产品预设目录

Status: implemented

[English](2026-09-28-dead-product-preset-directories.md) | 中文

## Problem

`apps/desktop-host/presets/ptc/` 与 `apps/desktop-host/presets/standard/` 各含一行
（`config: { preset: ptc }` / `config: { preset: standard }`），是为按目录发现的预设引擎写的。0.1.7-rc.2
合并后组合的是上游注册表：预设行携带 `{ id, directory }`，适配器读取 composition 文件，因此裸 `preset`
常量解析不出目录，这两行会在挂载时报错，而不是在启动时报错。

即使修好这一点，它们也无法生效。基础包已用自己的 shipped 行声明了预设 id `ptc` 与 `standard`，且组合顺序
在前，因此同 id 的产品行永远不会被声明。被遮蔽的 shipped 行与被它遮蔽的东西并不等价：被删除的适配器会禁用
每个被适配 composition 自带的 `skill-filesystem` 行，因为选择默认根的提供方只能由 Host 独占；而 shipped
composition 保留了该行，并开启默认根发现。

## Decision

删除这两个目录及其四个文件。被遮蔽、无法挂载、又不携带产品提供方规则的行就是死数据：运行时不可见，而下一次
把它声明出来的改造会在挂载时失败。

依赖项随之一并调整：`DESKTOP_HOST_RUNTIME_FILES` 不再要求 `presets/{ptc,standard}/…`，打包集合测试断言
同一清单，产品预设测试断言剩下的产品目录，运行时冒烟测试期望剩下的产品预设，`apps/desktop/README.md`
及其中文对照改为一个产品预设而非三个。

`apps/desktop-host/presets/short-drama-local/` 本次**不**删除。它是第三个仅存在于本分支的目录，它的行是否与
`main` 的 `short-drama` 等价，是在本分支合并回 `main` 之后实测的结论。

## Alternatives considered

**留着以后再改造。** 它们仍被遮蔽，运行时行为不变，而被破坏的 `preset` 常量依旧留着，随时可能被误声明。

**把它们改指向合并后的适配器。** 两个目录注册的预设 id 已被基础包声明，属于重复行；改为禁用 shipped 行则是
名册改造决策，而非清理，应连同合并附录中记录的并回后验证一起处理。

**不动依赖项。** 打包集合要求会列出已不存在的文件，打包出的 Desktop 会在自身文件检查中失败。

## Consequences

删除四个文件、调整五处依赖项，本分支的产品名册只暴露 `short-drama-local` 一个目录。两个被删目录本应承载的
提供方规则——禁用每个被适配 composition 内的 `skill-filesystem`，使任何预设都不会在 Host 之外再挂一个默认根
提供方——由此成为并回 `main` 的显式验收项：在合并后的树上实测，任何挂载自身默认根提供方的预设都算缺陷，而不是
细节。
