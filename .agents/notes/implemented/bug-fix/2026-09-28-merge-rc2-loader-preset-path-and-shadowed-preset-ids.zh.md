# Agent Note: The deleted preset path in the Desktop loader spec, and the preset ids the shipped rows shadow

Status: implemented

[English](2026-09-28-merge-rc2-loader-preset-path-and-shadowed-preset-ids.md) | 中文

## Problem

`0.1.7-rc.2` 合并后仍有两条残留没结清，而且两条都不在任何构建门的视野内。

`apps/desktop/tests/short-drama-loader.spec.ts` 读的是 `packages/preset/agent-presets/presets/short-drama/agent.cordis.yml`。上游把这个包连同它所属的 preset 引擎一起删了， 于是该 spec 在运行时报 `ENOENT` 而 `pnpm run build:lib` 与 `tsc -b tsconfig.host.json` 照旧全绿：这个文件里没有一处是类型错误。

`apps/desktop-host/presets/ptc/agent.cordis.yml` 及其旁边的 `standard` 是写给合并前适配器的一行式委派——`name: '@deepseek-ai/dsh-desktop-host/native-preset'` 配 `config: { preset: ptc }`——而合并后适配器的 `Config` 是 `{ id, directory }`。Desktop Host 只为「组合后的各层尚未占用该 id」的打包 preset 目录声明行 （`apps/desktop-host/src/index.ts:191-205`），而基础包自己就声明了 `preset-ptc` 与 `preset-standard`，所以这两个目录被报为被遮蔽、从未挂载。 比「它们是死数据」更要紧的是它们原本做什么：`main` 的适配器正是在那里对它 include 的组合施加自己的补丁。

## Decision

**该 loader spec 改读产品自己的 preset，并保留原有主题。** `presetPath` 现在指向 `apps/desktop-host/presets/short-drama-local/agent.cordis.yml`，也就是 desktop 名册注册的那份组合。退役该文件被否决： 没有其他 spec 把 Host 的 Jubian 行与一条技能行经真实 Loader 挂到随包技能根上，而这正是它当初被写出来的行为。

它四条行断言里的三条主题不变：overlay 插入的 Jubian 行是 `@deepseek-ai/dsh-tool-jubian`，preset 的技能行是 `@deepseek-ai/dsh-tool-skill`，preset 不声明 `tool-jubian`。第四条换了归属方。被删的随包组合自带 `skill-filesystem`； 合并后的 preset 一条都不声明，因为产品重新启用了 Host 自己那一行（`desktop.cordis.patch.yml:19-22`，`disabled: false`、 `includeDefaultRoots: false`），并把它的运行期目录注入在那里（`apps/desktop-host/src/index.ts:216-223`）。因此该 spec 改从 overlay 取这个提供方、断言它带 `includeDefaultRoots: false`，并断言 preset 不声明 `skill-filesystem`——也就是「Host 拥有唯一提供方」这条产品规则。其后的挂载组合、模块表，以及所有针对已挂载服务的断言均未改动。

**被遮蔽的产品行只做取证，原样保留。** 一个探针组合了真实的 Desktop profile——基础包各层、用户 patch 与 `desktop.cordis.patch.yml`，即 `src/index.ts:176-180` 所组合的同样几层——并对打包目录套用 Host 自己的产品行规则。它确认随包行 `preset-standard`、`preset-ptc`、`preset-minimal`、`preset-cordis`（`@deepseek-ai/dsh-agent-preset`）胜出，`ptc` 与 `standard` 被遮蔽，只有 `short-drama-local` 由产品行声明。

删除死目录被否决，因为取证结论是：真正生效的行与被它们遮蔽的行**行为不等价**。`main` 的适配器给 `standard` 与 `ptc` 打了 `{ id: 'skill-filesystem', disabled: true }`——「Host 拥有唯一选择默认根目录的提供方，因此任何被适配的组合都不得留下自己选择默认根目录的提供方」—— 而两份随包组合确实都声明了该提供方。这里胜出的随包行把它启着，且 `includeDefaultRoots` 默认为 `true` （`packages/skill/skill-filesystem/src/index.ts:86`），于是 `ptc`/`standard` 的 agent 会在 Host 的提供方之外再挂一个带默认根目录发现的 文件系统提供方，而 `main` 上只挂一个。这是交给 Lead 的行为问题，不是清理工作，因此上报而不处置。

## Verification

所有命令都在仓库根目录运行，`TEMP`/`TMP` 指向 `E:`。

| 命令 | 之前 | 之后 |
|---|---|---|
| `pnpm exec vitest run apps/desktop/tests/short-drama-loader.spec.ts` | exit **1**，`:30` 处 `ENOENT … packages\preset\agent-presets\presets\short-drama\agent.cordis.yml` | **exit 0，1 passed** |
| `pnpm exec tsc -b tsconfig.host.json` | exit 0 | exit 0 |

探针打印了组合结果中的各行（`preset-standard`→`standard`、`preset-ptc`→`ptc`、`preset-minimal`→`minimal`、 `preset-cordis`→`cordis`，均为 `@deepseek-ai/dsh-agent-preset`）、打包目录（`ptc`、`short-drama-local`、`standard`）、 被遮蔽集合（`ptc`、`standard`）、胜出的 `ptc`/`standard` preset 的 `skill-filesystem` 行（`disabled` 为 undefined），以及 overlay 自己的提供方 patch（`{ id: 'skill-filesystem', disabled: false, config: { includeDefaultRoots: false } }`）。 该探针是一次性文件，不在提交内。

重表达的断言由该文件自身的失败史证伪：它读的路径不存在并在那一行失败，说明它的读取不是空转；而若 overlay 不再关闭默认根目录， 提供方断言即转红。其下的组合断言本就是此前一直在跑的。

## Alternatives considered

**退役该 loader spec。** 否决：它所做的挂载——Host 的 Jubian 行与某 preset 的技能行并挂于随包技能根、并验证两者随各自的行一起退出—— 没有其他覆盖，而裁决只允许退役「行为已被别处完整覆盖」的断言。

**把 `presetPath` 指向被删路径最近的幸存者 `packages/bundle/web-app/presets/*.patch.yml`。** 否决：那是随包名册，不是产品的。 被测行为属于产品自己的组合，而名册注册的正是它的目录。

**从随包 `cordis` preset 的插件表里取技能提供方那一行。** 否决：它带指向某包目录的 `customSkillDirs` 且不关闭默认根目录， 照此组合出的提供方没有任何产品 agent 使用，断言到的归属方也是错的。

**把 `presets/ptc` 与 `presets/standard` 当死数据删掉。** 本轮否决：遮蔽它们的随包行丢掉了 `main` 施加的适配器补丁， 删除等于替 Lead 裁定一个行为问题。取证已记录，这些行未被动过。

**靠去掉遮蔽让产品行生效。** 否决：这些行是写给合并前适配器的（`config: { preset: … }`），声明出来是在挂载时失败而不是启动时； 要接管就得重写产品组合，那属于并回 `main` 所负责的名册工作。

## Consequences

产品目录 `ptc` 与 `standard` 在本分支上仍是死数据，而 `src/index.ts:191-209` 的遮蔽检查是让这份隐形保持安静的唯一原因： 它在启动时报出它们并跳过它们，这也正是它们一直没出事的原因。

并回 `main` 时以 `main` 的名册为准——五个 id（`cordis`、`minimal`、`ptc`、`short-drama`、`standard`）、默认 `short-drama`、 `main` 的适配器——`short-drama-local` 是随合并消失的分支专名。每个 id 的适配器语义都必须在合并后的树上重新核对； `ptc` 与 `standard` 已经不被带上了，而 `cordis`（其产品目录随 `main` 一起回来）以同样的方式不同 （`includeDefaultRoots` 留在默认值，`customSkillDirs` 指向 `@deepseek-ai/dsh-agent-preset` 包自己的 `skills` 目录）。
