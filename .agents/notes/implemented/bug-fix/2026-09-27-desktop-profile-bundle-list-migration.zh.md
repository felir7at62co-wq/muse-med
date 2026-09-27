# Agent Note: 升级时补齐桌面 profile 的内置 bundle 列表

Status: implemented

[English](2026-09-27-desktop-profile-bundle-list-migration.md) | 中文

## 问题

`0.1.6-alpha.2` 在保留桌面 profile 的内置 bundle 列表 `DESKTOP_PROFILE_BUNDLES` 末尾追加了第七项 `@deepseek-ai/dsh-feishu-settings`。profile 创建时写入该列表，其后追加自己的第三方 bundle；因此上一个版本写出的 profile 里存的是那个版本的 6 项内置列表。校验要求存列表以完整内置列表开头，6 项前缀在第 7 个位置即不通过，而且这是致命错误：外壳在启动对话框中报出 `desktop project: profile must begin with the built-in desktop bundle list`，profile 无法打开。

出问题的安装并不特殊。定位此问题时检查的那份 profile 恰好只存了旧版 6 项内置 bundle，没有任何第三方 bundle；因此受影响的是所有覆盖安装升级的用户，而不只是装过插件的用户。该校验位于 `profilePluginNames`，启动对账、插件清单与依赖变更都会读到它，所以 profile 在每条路径上都不可用。

## 决策

[`project-manager.ts`](../../../../apps/desktop/src/project-manager.ts) 通过 `pendingBuiltInBundles` 读取存列表：先找出存列表与 `DESKTOP_PROFILE_BUNDLES` 开始不一致的位置，只有当该位置之后的部分不含任何内置 bundle 时，才把它当作该 profile 的第三方 bundle。满足条件时，`profilePluginNames` 在该位置按内置顺序插入缺失的内置 bundle，第三方 bundle 仍排在其后。补齐后的列表随后与本已完整的列表走同一套重复项检查与包名校验，两项都通过才重写 manifest，因此无法补齐的列表只报错、不改动文件。

重写前先把 `package.json` 复制为同目录的 `package.json.<UTC 时间戳>.bak`，并保留 manifest 的其余字段。重写只发生一次：补齐后的列表在下次读取时即通过校验。

其余任何不一致仍然按原错误信息响亮失败。缺失中间项、顺序错乱、内置列表之前混入未知项，都会在剩余部分留下内置 bundle 名称，而正是这条规则让前缀可判定。没有它，损坏的列表会被修成一个看似合理的列表，而不是被报出来。

## 考虑过的替代方案

**继续失败并要求人工修复。** 第一台受影响的安装就是手工编辑 `~/.muse/profiles/desktop/package.json` 才恢复的，而这需要知道该版本新增了哪个 bundle。产品自带的恢复手段"重置桌面"会删除全部 profile 配置与第三方插件，把用户引到那里等于用数据丢失换掉启动失败。

**只要存列表包含全部内置 bundle 就补齐，不管顺序。** 把缺失的内置 bundle 重排到位，会接受一份人工编辑或其他写入方产出的、顺序无任何保证的列表。前缀规则仅凭存列表即可判定；"包含全部"不行。

**只在 `applyRelease` 里补齐。** `listPlugins` 与 `mutate` 同样通过 `profilePluginNames` 读取这份存列表，先进插件清单或先做依赖变更的 profile 依旧会失败。在读取处补齐，一条规则即覆盖全部路径。

**重写列表但不留副本。** 这次重写是产品第一次改动一份用户可能刻意编辑过的文件。一份同目录副本只占几百字节，却让升级前的列表仍可查阅。

## 后果

从任何内置列表是当前列表前缀的版本升级，现在都会补齐 profile 并正常启动。存列表不是前缀的 profile 仍按原错误信息响亮失败，文件保持逐字节不变，也不会写出副本。

本版本新写的 profile 不受影响：它们的列表已经以完整内置列表开头，因此 manifest 不被触碰，也不写副本。`createPluginProfile`、`createRuntimeProjectMetadata` 与 `createDevelopmentProjectMetadata` 仍写入当前内置列表，`DESKTOP_PROFILE_BUNDLES` 的成员与顺序不变。

副本只在新增内置 bundle 的版本之间累积，一份 profile 每个这样的版本至多多出一份。它们位于 profile 目录内，因此"重置桌面"会连同 profile 其余内容一并删除；日后再有新版本新增 bundle 时写的是新副本，而不是覆盖旧副本。

## 测试

`apps/desktop/tests/project-manager.spec.ts` 覆盖三条路径。一份存有旧版 6 项内置 bundle 加一个第三方插件的 profile，在升级到发行标识不同的运行时后正常启动，存列表变为 7 项内置 bundle 后接该插件，并留下一份内容与升级前逐字节相同的副本；同一用例还固定了已安装依赖。缺少中间项、同时带有合法第三方尾部的列表，会按原错误信息被拒绝，manifest 保持逐字节不变，且不写副本。完整的列表在升级后内容与修改时间均不变，也不写副本。

[捆绑运行时决策](../architecture/2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)继续负责 profile manifest 归属、共享包同一性与插件生命周期；[飞书可选启用决策](../architecture/2026-09-24-desktop-feishu-bridge-opt-in.zh.md)负责第七个 bundle 的用途。两者都未被取代。
