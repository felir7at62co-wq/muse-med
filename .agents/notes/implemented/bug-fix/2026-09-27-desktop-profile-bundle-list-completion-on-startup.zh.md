# Agent Note：每次启动都补齐 Desktop profile 的 bundle 清单

Status: implemented

[English](2026-09-27-desktop-profile-bundle-list-completion-on-startup.md) | 中文

## Problem

`0.1.6-alpha.2` 的安装报出 `desktop project: profile must begin with the built-in desktop bundle list` 后，用户点了启动页的 **Restart**：应用变得可用，但被追加的那个 bundle 所拥有的设置分区没有出现。Restart 只是重启应用，profile 里仍是上一版本的六个内置 bundle。

那次失败的启动其实已经记录下本版本的运行时状态。`prepareProfile` 先链接或记录 profile，之后才求值 `profilePluginNames`，而拒绝六项清单的正是后者，所以 `desktop-runtime-state.json` 在报错之前就已与本版本匹配。下一次启动时 `applyRelease` 的早退分支比较的正是这份状态，于是不做任何 reconcile，而其他启动路径都不读 `dsh.profile.bundles`。Host 因此只用存下来的六个 bundle 组合，`@deepseek-ai/dsh-feishu-settings` 从未成为 Loader entry，由 `ctx.loader.entries()` 生成的 client bundle 名册里也就没有 `feishu` 设置分区的注册。其余恢复动作不受影响：**Disable third-party plugins and retry** 会写入完整内置清单，**Reset Desktop** 会重建 profile；只有 Restart 不动这份清单。

## Decision

[`project-manager.ts`](../../../../apps/desktop/src/project-manager.ts) 的 `applyRelease` 在早退判断之前、profile 清单存在时，先经 `profilePluginNames` 读取已存储的清单。补齐、校验、清单副本与重写都留在该读取函数里；启动只是在守护其他 profile 写入的同一把事务锁下走到它，且不运行任何包管理命令。因此，记录下来的运行时状态绝不授权复用本版本尚未接受的列表：被拒绝的列表在 `prepareProfile` 记录本版本之前就被拒绝，早前版本留下的列表也在早退读取该状态之前被补齐或拒绝。

## Alternatives considered

**只在校验通过后再记录运行时状态。** 该状态文件同时是 `linkDesktopHostPackages` 所建链接的归属记录；推迟到后续步骤写入，会留下此后任何 unlink 都不得替换的链接。把状态写入保持诚实的代价落在共享链接生命周期上，重于启动多读一次清单。

**不用早退，直接走完整 reconcile。** 每次启动重新链接全部共享包并重扫已安装清单，正是早退分支要避免的开销，也与一份单从清单即可判定的列表无关。

**让 Host 在组合时补齐清单。** Host 只按 `dsh.profile.bundles` 组合，不写任何 profile 文件；该 profile 归 shell 所有（[内置运行时决策](../architecture/2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)）。

**状态匹配而清单偏短时拒绝启动。** 这只是把静默缺失变成启动失败，并不会找回那条缺失的第一方行，而该清单是可判定、可补齐的。

## Consequences

现在每次启动都会读取 profile 清单，并仅在缺少本版本新增内置 bundle 时补齐；完整清单不被写入、也不产生副本，因此未变化的 profile 保持原有字节与修改时间。不是前缀的清单现在会在启动阶段响亮失败，包括此前会「组合偏短」的那些路径。在记录状态之后失败的准备过程仍会让那份状态保持最新，于是下次启动会跳过重新链接；两种情况下清单都会被补齐，插件依赖图的缺陷仍旧在检查已安装插件的地方暴露。

该补齐只能修好「包含它的版本所启动」的 profile。仍运行已发布 `0.1.6-alpha.2` shell（没有这次读取）的安装，需要装下一个安装包，或使用 **Disable third-party plugins and retry** 与 **Reset Desktop**；单纯重启无法补齐它们的清单。

## Testing

`apps/desktop/tests/project-manager.spec.ts` 覆盖这次读取所决定的各条路径。一个已准备、并装有一个插件的 profile，其存储列表被改写为前六个内置 bundle 加该插件，而记录下来的运行时状态仍是最新的；随后第二次 `applyRelease()` 解析为 `false`，存下七个内置 bundle 加该插件，保留依赖与插件清单，不运行任何 pnpm 命令，并只留下一个内容为改写前字节的副本。不是前缀的存储列表，在复用「最新记录状态」的那次启动以及其后一次启动上都被拒绝，清单与记录状态保持逐字节不变，且不产生副本。被拒绝的升级不把记录改成本次安装的版本，记录仍指向真正准备该 profile 的运行时，于是下一次启动重新准备，而不会复用那个版本从未接受的列表。重启用例与两条拒绝用例在「先记录运行时状态、后读取列表」的 shell 上失败；升级补齐用例在那里同样通过。

[迁移决策](2026-09-27-desktop-profile-bundle-list-migration.zh.md) 继续负责哪些已存储清单可补齐、副本的用途与拒绝规则；本笔记只涉及哪些启动路径会走到那个读取函数。
