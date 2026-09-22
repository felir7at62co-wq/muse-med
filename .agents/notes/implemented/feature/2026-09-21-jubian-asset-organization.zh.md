# Agent Note: 剧变工具的按集数与类别资产组织

Status: implemented

[English](2026-09-21-jubian-asset-organization.md) | 中文

## Problem

剧变制作的资产可寻址，却没有被组织起来。插件能建、能读、能删一个主体设定资产，而它建出来的每个资产都以调用方传的名字、按调用方传的类别进入控制台资产库。工具 schema 只提供一个类别字段 `asset_type`，而有证据的取值只有 `1`，于是短剧流水线对一切资产都发 `1`：它的 77 个场景与 21 个道具全部按角色建成，控制台把它们归进了角色库。插件里没有任何东西能告诉调用方哪一集用了哪个资产、哪些名字已经偏离了某种规范、哪些资产的类别是错的。人在控制台里能看见这些损坏，却没有任何工具会把它报告出来。

## Decision

本包新增一套命名规范、三个资产库写方法与一个只读的组织视图。

`src/naming.ts` 拥有这套规范。资产名读作 `EP{nn}｜{类别}｜{名称}`，跨集母版读作 `全剧｜{类别}｜{名称}`；处理任务名带 `EP05-P3-` 前缀。`episode`、`asset_category` 与 `package_number` 是 `image_generate`、`erase_subtitle`、`upscale` 与 `rename` 上的新可选参数；不给 `episode` 时 `asset_name` 与 `task_name` 逐字节保持原样，因此这个能力出现之前的每一次调用含义不变。分隔符与母版标记是 `Config` 字段（`nameSeparator`、`seriesLabel`），因为部署方可能想要 `|` 或别的母版写法；空白值会让挂载失败，而不是组合出一个没人能切分的名字。

`asset_category` 从根上修复类别缺陷。三个类别就是提供方自己的编号——角色 `1`、场景 `2`、道具 `3`——`ASSET_CATEGORY_TYPES` 就是这条外部契约。`image_generate` 由类别推导 `assetType`，所以场景或道具再也不可能按角色建出来。`asset_type` 仍然接受，以兼容类别出现之前的调用方，两者必须一致：名字写着场景、类型却写角色的资产会在请求体构造阶段失败。

`src/folders.ts` 给 `jubian_asset` 加上 `create_folder`、`move` 与 `rename`，复刻控制台自己的三个调用：`POST /aigc/assetFolder/add`、`PUT /aigc/material/move` 与 `PUT /aigc/material/reName`。每个都在既有的两阶段账本下运行，都需要调用方给出的 `idempotency_key`；每个都在自己的前置读取**之前**先查账本是否已有记录，所以重复的 key 返回已记录的结果，而不是去重新诊断一个被它自己第一次调用改变过的世界。两种拒绝在本地、在发出任何请求之前就定下来，因为提供方把两者报成同一个信封码：同级已有同名文件夹返回 `folder_exists` 与那个文件夹的 ID；目标文件夹不在该库的树里返回 `target_folder_missing`。建文件夹成功后回读文件夹树并返回新的 `folder_id`，那正是 `move` 需要的 ID。

`src/organize.ts` 新增第六个工具 `jubian_organize`，只有一个只读方法 `index`。它读取项目的分页资产列表、已使用的主体材质、视频任务与每个类别个人资产库的文件夹树，再与项目自己的 `assets_manifest.json` 连接——那是唯一存在的集数映射，因为没有任何远端字段承载它。结果带四样东西，同样的内容会写到 `<project_dir>/<assetIndexPath>`（默认 `_probe/asset-index.md`，一个 `Config` 字段）：按集数再按类别分组的 `episodes`；没有写集号的母版 `series`；读起来不符合规范的每个远端名的 `naming_violations`；以及 `assetType` 与清单行或自身名字声明不一致的资产的 `category_mismatches`。索引只报告，不改名也不移动。

## Alternatives considered

**把命名规范留在技能文本里而不是插件里。** 流水线的技能可以告诉模型按 `EP05｜道具｜红包` 命名。那是模型必须记住的规则，而且没有任何东西检查它：上面三个缺陷都是遵循技能的会话产出的。工具参数把规范带进对话记录，缺类别就直接失败，而由插件推导模型不可信会传对的提供方编号。

**不读文件夹树，直接发文件夹 ID。** `create_folder` 可以 POST 之后返回提供方说的任何东西。那样它就没有 `folder_id` 交给 `move`，而重名会与权限问题以同一个信封码回来，因为传输层刻意不让提供方的文本进入结果。免费的树读取把两者都变成可判定的答案。

**对所有已有名字强制套用规范。** 那 77 个场景与 21 个道具可以批量改名并搬家。它们是人正在读的名字与位置，而改名并不改变 `assetType`，所以批量操作只会产出「名字对了但仍躺在错误库里」的资产。索引报告不一致；如何处置是用户的决定，工具描述也这么写。

**把组织视图做成 `jubian_catalog` 的又一个读方法。** `jubian_catalog` 读的是账户级目录；这个读的是一个项目的资产加一个本地文件，而且它是模型在想要理解一个项目、而不是取某一个字段时该用的那一次调用。独立的工具名也正是让「这一次什么都不改」能用模型自己的阅读语言说出来的东西。

## Consequences

每一次已有调用的含义都不变，想要规范的调用方按调用选择。包的模型可见表面从五个工具长到六个，其中一个工具的方法枚举长到十项，这是这一行挂载期间每次请求的固定 token 开销。

三个限制记录在 README 里。类别不重新生成资产就无法纠正，所以那 98 个错放的资产在有人重新生成之前会一直错放；两个资产库写方法收的是材质 ID 而不是父资产 ID，所以传父 ID 会以未知行的身份到达提供方，回来时只是一个笼统的稳定失败码；组织视图只读个人资产库的文件夹，因为读树用的是控制台默认打开的 `assetScopeType`。

三个写方法改变的是人在控制台里读到的东西。插件没有预算检查也没有确认步骤，所以它唯一的护栏就是 `jubian_asset` 描述里那句「批量改名或搬家前必须先取得用户明确同意」。

## Testing

`packages/jubian/jubian-api/tests/folder.spec.ts` 覆盖树读取器、按名与按 ID 查找，以及每一种拒绝。`packages/jubian/tool-jubian/tests/` 新增 `naming.spec.ts`、`folders.spec.ts` 与 `organize.spec.ts`，覆盖名字组合、两份审计、三个资产库写方法（含两种本地拒绝）、重放路径、账本里只有 intent 没有 settle 的情形，以及在一份带着真实项目那种参差行的清单与提供方载荷上建出来的索引。`tools.spec.ts` 断言六个工具的注册、两份 schema，以及每个组织写方法都在触网之前到达它自己的写入器。`npx vitest run packages/jubian` 跑 288 个测试；四个新增或改动的源模块——`src/naming.ts`、`src/folders.ts`、`src/organize.ts` 与 `jubian-api/src/folder.ts`——在覆盖率门禁所用的同一套 v8 配置下报告逐文件 100% statements、branches、functions 与 lines。
