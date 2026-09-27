# Agent Note：清单缺陷只报告，不拒绝

Status: implemented

[English](2026-09-28-drama-manifest-defects-reported-not-refused.md) | 中文

## Problem

项目的 `assets_manifest.json` 有两个读取方，都因为一处读不懂的声明就拒绝整个文件，而这次拒绝把调用方真正需要的发现全部吞掉了。

`drama_assets reconcile` 只读 `items`，并把数组缺失当成「一条记录都没有」。于是当清单把资产数组写成 `assets`（分镜脚本用的旧拼法，也是 `jubian_organize` 一并接受的拼法）时，本地一侧等于空，远端项目里已经存在的每一条已选用资产都被报成未登记——而这恰恰是这次比对存在的唯一意义。第一版修法改成抛 `CONTRACT_CHANGED` 拒绝调用，对调用方更糟：这份文件由模型自己写、也由模型自己修，一句只点名一个键的报错，换来的是模型看不到这个被三个工具共读的文件里的其它发现。`lead_readonly_records` 则是反向的失败：数组缺失被静默当成「没有记录」，于是丢了领读记录的清单把那些远端资产报成未登记，却一句话都不说。

`drama_shot validate` 在往里一层的同一条规则上有一模一样的一对失败。清单某行的 `type` 写成 `role` 而不是 `角色` 或 `character` 时，绑定规则按精确拼法匹配，这一行谁也绑不上；别的规则也不会发现，于是角色资产被静默跳过的镜头回答 `ok: true, 0 failures`。在读到 type 的地方拒绝整份清单，重复的正是[角色状态门禁已经否决过的形态](2026-09-28-character-state-gate-at-binding.zh.md)：那里的登记口径写着「读的时候拒绝整份文档，会把一行历史遗留变成解析失败，从而藏起其它所有发现」。

## Decision

**清单缺陷是结果里的一条 issue，不是一次失败的调用。** 两个读取方都继续读完能读的声明，只把读不了的报出来。

[`src/manifest.ts`](../../../../packages/drama/tool-drama-assets/src/manifest.ts) 的 `readManifest` 返回声明本身加一份 `issues`，证据文件也带同一份列表。资产数组接受 `items` 与 `assets` 两个键名，优先读 `items`，因为那是项目自己的键；不是对象的记录被跳过并点名；`lead_readonly_records` 缺失被报出来，而不是读成空。每条 issue 都有稳定的 code（`manifest_items_missing`、`manifest_items_spelling`、`lead_records_missing`、`manifest_record_unreadable`）和一句点名「缺哪个键、接受哪些键名、怎么修」的说明。「缺少数组」那句话的措辞沿用 `jubian_organize` 对同一个键的说法，好让同一个文件的两个读取方说同一件事。

`ready` 现在要求 `issues` 也为空：本地一侧读不全的比对会把远端已有的资产报成未登记，而付费生成正是拿这个结论去做决定。`dispose` 沿用证据里已有的 issues 而不重算，所以一次处置不可能把这个结论又翻回 ready。宿主钩子不用改——它读的就是 `ready`。

有三件事仍然让调用失败，因为越过它们就没得比：文件读不到、正文不是 JSON、顶层对象里没有整数 `script_id`。

**与 `jubian_organize` 的机制差异是刻意的。** `organize` 找不到数组就抛 `CONTRACT_CHANGED`；`reconcile` 返回结构化 issue 与 `ready: false`。`organize` 建索引，回答的是调用方已经框好的问题；`reconcile` 是付费生成门禁与人都会读的那份报告，而要修清单的模型是把它当一份文档读的。抛错会在第一处缺陷就结束这份文档；报出来的 issue 则和这一次运行产出的完整 `unregistered` 与 `dangling` 一起送到。

**这条取代了针对同两处声明的硬报错形态。** [2026-09-27 那份笔记](2026-09-27-silent-envelope-and-manifest-key-failures.zh.md)让 `readManifest` 在资产数组不是 `items` 时拒绝整个文件，并把 `lead_readonly_records` 留作可选。那一版曾在本仓库实现，随后被否掉：同一次运行已经产出了调用方需要的发现，而抛出的一句话会在它们送达之前就结束这次调用——而要修这个文件的模型，还得靠这些发现。它关于信封的那一半（每个 reader 都经由同一份脱敏摘要拒绝）保留，实现在 [`jubian-api/src/reading.ts`](../../../../packages/jubian/jubian-api/src/reading.ts)；这里只替换清单那一半。`lead_readonly_records` 是报出来而不是兜默认值，因为数组缺失正是「丢了领读记录却一声不吭」的成因；老清单把资产数组写成 `assets` 时照读而不是拒绝，因为那些行就在文件里，不对的只是键名。

[`src/assets.ts`](../../../../packages/drama/tool-shot-script/src/assets.ts) 的 `parseAssetManifest` 现在返回 `{ assets, issues }`，与 `parseShotScript` 的 `{ shots, issues }` 对称。不在绑定规则认的六种拼法里的 `type` 保留在行里，并作为失败 issue 报出第几条、资产名、读到的值、允许的拼法与修法。读得出来的行照常绑定，脚本自己的发现也在同一次运行里照常判定——于是 `validate` 回答的是 `ok: false` 加一个明摆着没绑上的角色资产，而不是一份空的失败列表上的 `ok: true`。

## Alternatives considered

**拒绝调用，并点名缺失的键。** 两个读取方都不采纳：换来的是一句话而不是这次运行的其它发现，调用方修不了它看不见的东西；而且同一个文件的另一个读取方 `drama_shot` 一直照读不误，一个文件两套行为本身就是裂缝。

**静默接受 `assets` 这个被容忍的拼法。** 不采纳：项目自己的键是 `items`（流水线自己的清单就这么写，`jubian_organize` 也正是为了它才扩展成接受 `items`）。两种拼法下比对用的都是那些行，所以没有任何结论取决于拼法；告诉调用方规范键名，好过留给他一份下一个读取方未必容忍的文件。

**把缺失的 `lead_readonly_records` 兜成空列表。** 不采纳：那正是「把领读资产静默报成未登记」的成因。修法只有一行，issue 里写着。

**把不能用的 `type` 降为警告。** 不采纳：被跳过的角色资产是错的产物，不是节奏建议；警告会留下 `ok: true`——正是这套检查要防的那个状态。

## Consequences

带上这些缺陷的清单从此得到 `ready: false`，在修好之前不再放行付费生成。方向是对的：这些运行本来就在产出不可信的 `unregistered` 列表。资产数组写在 `items` 下、且声明了 `lead_readonly_records` 的 `assets_manifest.json` 不受影响；清单缺陷也不再藏起脚本自己的失败。

`issues` 对 `_probe/asset-reconcile.json` 是增量字段；`_tools/asset_reconcile_report.py` 与宿主钩子照旧读它们本来就认识的字段，让新字段生效的是钩子那条 `ready` 判定。

`drama_shot` 仍会对「不是对象」「没有资产数组」「某行缺 `name` 或 `type`」失败：那些让整行读不出来，而不是用不了，也没有哪条 issue 能说出它讲的是哪个资产。

## Verification

`pnpm vitest run packages/drama/tool-drama-assets` 通过，两个 spec 文件共 66 条：只写 `assets` 的清单照真实行对账并报 `manifest_items_spelling`；完全没有数组的清单报 `manifest_items_missing` 另加两条其它 issue；`lead_readonly_records` 缺失或不是数组；不是对象的记录；以及把 issues 一路带下去的 `dispose`。

`pnpm vitest run packages/drama/tool-shot-script` 通过，七个 spec 文件共 134 条，其中有那条走注册工具的用例：`role` 类型的角色行让 `ok: false`、镜头只绑到场景，而 `failures` 里同时有类型 issue 与补料需求。

`jubian_organize` 对同一个文件的读法不受本次改动影响。
