# Agent Note: The merge's silent capability losses and the ports that closed them

Status: implemented

[English](2026-09-28-merge-rc2-settings-row-and-preset-ports.md) | 中文

## Problem

把上游 `0.1.7-rc.2` 合入产品线后留下 34 条 TypeScript 错误，而其中最大的一组并不是打字问题：短剧设置行在所有部署的组合设置服务里都不再存在。`DramaSettingsSchema` 没有任何字段标记 `.volatile()`，于是 `volatileForm()` 对该条目返回 `undefined`，`describe()` 直接跳过整行（`packages/settings/settings/src/index.ts:308-309`）。三项能力就这样无声消失：绑定 `ctx.configForms.get('drama-settings')` 的设置页把命名空间报告为不可用且永远写不进去（`index.ts:385-386` 以 `Plugin entry "drama-settings" has no volatile fields` 拒绝写入），每部剧的自动花费上限读成 `undefined`（`packages/jubian/tool-jubian/src/budget-settings.ts`），而锁定的计费生图线路降级为该工具行自己的组合配置（`src/image.ts`）。一个因为 schema 注解丢失而消失的金额上限是产品缺陷，不是可以留到以后收拾的合并残渣。

同一次合并还丢了两处类型错误看不见的东西，另有一处它看得见：

- `apps/desktop/tests/profile-mcp.spec.ts` 丢了应用 Desktop Host 自身覆盖层的那一层，于是它组合出的树里根本没有 `drama-settings`、也没有 `tool-jubian` 行——那条「短剧预算命名空间在覆盖层之后仍然存在」的断言，测的是一个任何 Desktop 启动都不会挂载的组合。
- `apps/desktop-host/src/native-preset.ts` 用裸 `yaml.parse` 解析产品 preset 组合，于是 `!!js` 标签被解析成它自己的源文本。`disabled: !!js process.platform !== 'win32'` 因此以非空字符串抵达 Loader，而 Loader 对任何不是表达式节点的 `disabled` 取值一律 `Boolean()`（`vendor/loader/src/config/entry.ts:89-93`）：每个产品 preset 的两条 shell 行在所有平台都被判为停用，`fontsDir`、`pythonExecutable`、`dataDir`、`weightsPath` 也会以字面表达式文本挂载。
- `apps/desktop/tests/smoke-runtime.spec.ts` 有两条用例在运行时是红的，因为它们仍在驱动上游已删除的 `DesktopHostProcess.fetch`。

## Decision

设置行是就地修好而不是退役。`DramaSettingsSchema` 的每个可编辑字段都标记 `.volatile()`——与 `ui-theme`、`locale`、`tool-subagent`、`web-search-deepseek` 已经做过的迁移一致——于是该行重新发布命名空间，三项能力一并回来。退役这些字段（或整行）被否决：`seriesBudgetLimit` 与 `pinnedStandardId` 是部署自己对钱与线路的表态，丢掉它们正是本分支存在的意义所要避免的「合并静默吞掉能力」。

### schema 自身的类型，以及交付规格的身份

volatile 字段的输出是实时 `Volatile` 引用，而输入仍是普通值，没有单一对象类型能同时是两者（§16a）。因此 `DramaSettingsSchema` 去掉 `z<DramaSettings>` 注解，`DramaSettings` 回到它一直在描述的东西：设置传输层、页面和其下所有读取方持有的值视图。`deliverySpec` 整体标记 volatile，这让页面以整个对象为单位的 set/unset 操作继续成立（`isVolatilePath` 接受 volatile 祖先之下的路径，`validatePaths` 会递归进非 volatile 的子节点），而服务构造描述符时 `plainConfig` 一步就能解开它。`DRAMA_SETTINGS_DEFAULTS.deliverySpec` 仍是与 `DEFAULT_DELIVERY_SPEC` 同一个对象——嵌套字段自身不带 `.default()`，因此没有任何默认值被包装——并且有测试同时钉住这两件事。

### 上限读不到时响亮失败

`seriesBudgetLimit` 区分两种情形：完全没有设置提供方的组合（受支持的纯 Jubian 形态，保留人工授权），与已组合设置服务、但没有任何可读 `drama-settings` 段的组合（配置错误）。后者现在通过 `ctx.logger.warn` 记录警告，点名命名空间、修复所需的显式 `id: drama-settings` 挂载，以及账本的授权文件，并且仍然返回 `undefined`——而账本不会把它变成消费许可：没有自动上限、也没有授权条目时，`checkBudget` 会拒绝这次计费调用（`packages/jubian/jubian/src/budget.ts:209-214`）。上限既不会被凭空编造，也不会被静默丢弃。

### preset 断言移到真正拥有该行为的那一层

`@deepseek-ai/dsh-agent-presets` 已不存在，能力移到了 `@deepseek-ai/dsh-agent-preset-registry` 加上产品自己的行。围绕它的三个 spec 文件现在对着那一层断言：一条 registry 行加上每个产品组合目录一条 `native-preset` 行所产生的名册、用于读取组合内容的 `readDocument()`，以及适配器自身的拒绝行为。`authorable: false` 退役——合并后的 registry 根本没有作者化面，它的对位断言是新加的「名册里恰好只有已注册的产品行，不存在从任何目录发现出来的东西」。

`native-preset.ts` 现在用组合方言的 `!!js` 标签解析，因此表达式以它本来的表达式节点（`{ __jsExpr }`）抵达 Loader，而不是以文本抵达。这是本轮唯一一处产品源码改动；没有它，重新表达后的 preset spec 里那些 `!!js` 断言就无法保留，而每个产品 preset 的两条 shell 行会一直处于停用状态。

## Verification

所有命令都在仓库根目录运行，`TEMP`/`TMP` 指向 `E:`。

| 命令 | 之前 | 之后 |
|---|---|---|
| `pnpm run build:lib` | exit 1，host 面 34 条 `error TS` | **exit 0，0 条 `error TS`**——host `tsc`、两个 `tsdown` 面、Desktop 组合包与 client 面全部跑完 |
| `pnpm exec vitest run packages/drama/drama-settings/tests/settings.spec.ts` | 文件无法收集 | 10 passed |
| `pnpm exec vitest run packages/jubian/tool-jubian/tests/budget-settings.spec.ts` | 文件无法收集 | 5 passed |
| `pnpm exec vitest run packages/jubian/tool-jubian/tests/budget-loader.spec.ts` | 文件无法收集 | 1 passed |
| `pnpm exec vitest run apps/desktop/tests/smoke-runtime.spec.ts` | 2 failed / 11 passed | 13 passed |
| `pnpm exec vitest run apps/desktop/tests/profile-mcp.spec.ts` | 1 failed | 1 passed |
| `pnpm exec vitest run apps/desktop/tests/{product-preset,native-preset,product-skill-isolation}.spec.ts` | 文件无法收集 | 4 passed |
| `pnpm exec vitest run apps/desktop/tests/{development-project,preload}.spec.ts` | 类型错误 | 4 passed |
| `pnpm exec vitest run packages/drama packages/jubian packages/settings` | — | 73 个文件通过、4 个跳过；1096 条用例通过、0 失败 |

另有两条 tool-jubian spec 出于与上面两条相同的原因变红，并按同样方式移植：`image.spec.ts`（6 条里 3 条）与
`budget-tools.spec.ts`（1 条）的文件内假服务仍在回答已删除的 `settings.get(ns)`，于是 `dramaSection()` 抛
`settings.describe is not a function`。两者现在都按 `DRAMA_SETTINGS_NAMESPACE` 返回一条描述符并全部通过（合计 7 条用例）。
上面的整包运行正是发现它们的方式。

设置修复是被证伪过的、而不只是被断言过：去掉六处 `.volatile()` 会让 drama-settings 的 10 条里 7 条变红、并让真实组合的上限用例变红，因为那时 `describe()` 不再提供这一行。preset 修复同样被证伪：没有 `!!js` 标签时，适配器注册的是字面表达式文本，重新表达的 content 断言会在 `fontsDir` 上失败——这正是发现该缺陷的方式。

## Alternatives considered

**退役短剧设置字段（方案 B）。** 上限与锁定生图行是部署自己对金额与线路的表态；退役它们等于撤掉合并已经吞过一次的能力。

**让 `seriesBudgetLimit` 在行缺失时直接抛错。** 一个为别的插件组合了设置服务、却没有短剧行的组合是受支持形态，它保留人工授权；在那里硬失败会让纯 Jubian 部署的每次计费调用都被拒。警告加上账本原有的拒绝，既守住钱又不破坏该形态。

**在移植后的 spec 里保留 `settings.get` 式读取。** 该服务按设计没有 getter：命名空间就是组合条目 id，插件的段就是它自己已解析的 Config。因此移植后的 spec 通过真实 profile 驱动 `describe()`/`update()`/`replace()`/`mutate()`——这也是唯一能看见「服务拒绝发布某一行」的台架。

**在重新表达的 preset spec 里略过 `!!js` 断言。** 那等于在一片全绿的测试之下记录一个两条 shell 行处处停用的 preset——正是本轮在修的静默丢覆盖。

## Consequences

`drama-settings` 行必须以显式 `id: drama-settings` 组合；裸包名行会被挂到生成的 id 下（`vendor/loader/src/config/tree.ts:51-58`），从而指向没人提供的命名空间。两个已发布组合本来就是这么做的（`apps/desktop-host/config/desktop.cordis.patch.yml`、`packages/drama/drama-settings/cordis.patch.yml`），而 tool-jubian 的测试组合已改正以保持一致。

产品的 `presets/ptc` 与 `presets/standard` 组合仍然只有一行、委派给已删除的引擎（`config: { preset: … }`），而在所有 Desktop 组合里，它们都被基础组合包自带的 `preset-ptc`/`preset-standard` 行遮蔽；它们在本分支上是死数据，其去向仍归 §14h 记录的名册复核所有。

`apps/desktop/tests/short-drama-loader.spec.ts` 仍在读取 `packages/preset/agent-presets/presets/short-drama/agent.cordis.yml`——上游已删除的路径。它在运行时失败、却不带任何类型错误，因此没有任何构建门禁看得见它；它需要与另外三个已移植 preset spec 相同的处置。
