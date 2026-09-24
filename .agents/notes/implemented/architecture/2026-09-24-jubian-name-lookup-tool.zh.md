# Agent Note: 在既有工具包内按名字查找剧变剧本

Status: implemented

[English](2026-09-24-jubian-name-lookup-tool.md) | 中文

## Problem

一次剧变制作由 `script_id` 定位，而驱动它的会话通常从名字开始：有人说「续跑《山海自有相逢处》」，而提供方需要的那个 ID 并不在对话里。插件里原本没有任何东西能把前者变成后者。`jubian_catalog` 的 `script` 读取的是调用方已经有 ID 的剧本身份，`jubian_organize` 的 `index` 也用同一个 ID 读取某个项目的资产。因此只拿到名字的会话只能自己去够提供方的两份列表，自带凭证查找与信封解析——这正是抢本工作流自己的脚本今天在做的事。这两份列表回答的是不同问题：`/aigc/script/list` 是调用方自己名下的画布项目，`/script/center/pool/list` 是这个账号可以认领的剧本，每一行都带 `canClaim` 与认领人姓名。

这里答错的代价高于答空。查找返回的 ID 会成为整条制作里后续每一次调用的地址，包括计费的图片、视频与去字幕路径，所以一次近似匹配会把整条流水线指向另一个项目，而对话里没有任何迹象显示这件事。池子列表还多出第二种错法：只读第一页会把一本在第 2 页的剧本报成「不在池子里」，而「这个名字不可认领」与「我没有读完」之间的差别，决定了制作是等待，还是去认领一本别的组已经在做的剧本。

## Decision

`@deepseek-ai/dsh-tool-jubian` 增加一个只读工具 `jubian_find`，实现在 [`src/find.ts`](../../../../packages/jubian/tool-jubian/src/find.ts)，与该行已挂载的八个工具一起注册。

它是既有包里的一个工具名，而不是 `jubian_catalog` 上的一个方法，也不是一个独立的包，因为它需要的一切都已经在那里建好。这一行唯一的 `JubianClient` 提供凭证解析（先凭据库，再工作区流水线文件）、基址、超时、信封归一与五个稳定失败码；新列表的读取器只是 `dsh-jubian-api` 里与其它读取并排的又一个函数。[资产整理决策](../feature/2026-09-21-jubian-asset-organization.zh.md)为 `jubian_organize` 走了同一条路，理由也相同：一个回答自己那个问题的读取值得有自己的名字，这样模型才能选中它，并在它即将调用的那个工具的描述里读到「这一个不改动任何东西」。

`scope` 必填，且只指向一个端点：`mine` 读 `GET /aigc/script/list`，`pool` 读 `GET /script/center/pool/list`。两者之外的值在任何请求离开前就以 `INVALID_ARGUMENT` 失败。`status` 是 `pool` 的参数，原样作为查询参数转发；给 `mine` 传 `status` 会被拒绝而不是静默忽略，因为调用方自己名下的项目没有池子状态，而被丢掉的过滤条件会返回一份比调用方要求的更宽的列表。

控制台读漫剧视频项目用的也是 `mine` 那一份列表，所以这个工具选择把提供方自己的选择器转发过去，而不是另造第三个范围。运维抓到的控制台「漫剧视频」请求是 `GET /aigc/script/list?pageNum=1&pageSize=40&productionType=0&shareTargetType=1`，端点与 `mine` 已经读的完全相同，只靠这两个额外查询参数区分；对提供方前端 bundle 的离线扫描没有找到与它并列的漫剧路由，因此调用方列出这些项目的方式，就是把 `production_type` 转发为 `productionType`、把 `share_target_type` 转发为 `shareTargetType`。取值是提供方自己的编码：工具只校验每个值都是安全整数，不解释、不给默认值，未提供的那个直接不出现在查询串里，而不是发一个默认值过去。它们与 `status` 之于 `pool` 一样是 `mine` 的参数，带任一参数的 `pool` 调用在任何请求离开前就以 `INVALID_ARGUMENT` 失败。

`name` 可选，匹配刻意只做子串。查询与行里的两个名字字段经过同一套去首尾空白、内部连续空白并成一个空格、忽略大小写，行在 `scriptName` 或 `manuscriptName` 包含该结果时命中。没有拼音转写、没有别名表、没有编辑距离：与库中名字只差一个字的输入，更可能是一本不同的剧本而不是一个错字，而两份列表都不含这个名字时，空的 `matches` 就是诚实的答案。省略 `name` 就是列出该范围的第一页而不是报错，想让调用方看一眼池子时正是这样做。只有读取器读不懂的载荷才报 `CONTRACT_CHANGED`；「这里没有这本剧本」与「我判断不了」绝不能长得一样。

扫描一直读到列表末尾，并报告读到了哪里。`page_size`（1..1000，默认 20）限制的是一次请求而不是整次读取：调用从 `page_num` 起持续请求页面，直到读到的行覆盖该页自己的 `total`、某一页为空，或达到 `MAX_SCAN_PAGES`（50）——这个上界让提供方无限增长的列表不会变成死循环。结果带 `total`（提供方自己的列表大小）、`scanned_pages`、`complete`、`returned`、`truncated`（`MAX_MATCHES` = 100 的输出上限）与 `scan_page_limit`，调用方因此能分清「完整地读完且为空」与「只读了一部分」。抢本工作流把同一条规则记为实测证据：`pageSize` 是单次请求的行数上限，`total` 才是池子的大小，只读第一页会把「池子比一页大」变成静默漏本（[接口笔记](../../../../packages/drama/skills/skills/jubian-snatch/references/api-notes.md)）。

这两个列表端点属于提供方无包裹的那一族：它们答 `{code, total, rows}`，没有 `data` 包裹；而本包已经在读的单对象端点会把载荷嵌在 `data` 下。[`readScriptList`](../../../../packages/jubian/jubian-api/src/catalog.ts)两种写法都接受——信封自己的键，或它们包裹的 `data`——并要求 `total` 是整数、行是数组。其他情况一律以 `CONTRACT_CHANGED` 失败，包括一行没有 ID：`total` 是「还有多少页没读」唯一的界，而空列表是一个合法答案，必须与「解析时丢掉了行」保持可区分。无包裹写法在上面同一份抢本笔记里记为实测的提供方证据。

一条匹配只带读取器真正读到的字段：剧本科目列表的每一行都有 `script_id`、`script_name`、`manuscript_name`、`episode_count`、`status` 与 `script_style`，`pool` 时另有 `can_claim`、`claim_leader_name` 与 `claim_member_name`。提供方没有发送的字段保持 `null`，而不是被猜出来。`script_style` 是提供方自己的 `scriptStyle` 编码——用来区分真人与漫剧的那个字段——且只在 `mine` 下返回：实测到取值的地方就是那里，而池子的字段清单里没有 `scriptStyle`（[接口笔记](../../../../packages/drama/skills/skills/jubian-snatch/references/api-notes.md)），所以 `pool` 的行根本不带这个键。这个工具只发 `GET` 请求，不写账本、不检查预算、不需要 `idempotency_key`，也不认领任何东西：`can_claim` 是提供方针对当前账号自己的标记，而把一本剧本移进一次制作仍然是控制台里的认领动作。

## Alternatives considered

**在 `jubian_catalog` 上加一个方法。** 派发可行，`jubian_catalog` 本来也读剧本。但它同时会把一个必填的 `scope` 放在一个必填的 `method` 枚举旁边，而后者另外四个取值都不理会它：一个 schema 会有两个选择器，一段描述还得把分页的名字扫描与三次账户级读取分开。独立的工具名让每个 schema 只有一个选择器，也让「只读、免费」这句保证出现在它所描述的那个工具的描述里。

**另建一个包 `@deepseek-ai/dsh-tool-jubian-find`。** 它要么重建这一行已有的东西——含工作区回落的凭证解析、基址与超时、信封归一、错误映射——要么为这些依赖 `tool-jubian`，那就是同一份代码经由第二次挂载与第二个账本根目录抵达。工具目录的完整性守卫还得为一次读取多启动一个包。

**拼音、别名与模糊匹配。** 它们会回答更多问题，也会把其中一些答错。返回的 ID 会成为整条制作里后续每一次调用的地址，所以一个仅仅「像」的匹配比没有匹配更糟：测试把近似输入摆明在案，面对库中的 `山海自有相逢处`，`山海相逢`、`shanhai` 与 `山与海` 都返回空。

**第三个范围，或一个专门的漫剧端点。** 控制台读漫剧视频项目用的就是与其它画布项目相同的 `/aigc/script/list`，只靠两个查询参数区分，而提供方前端 bundle 里并没有它自己的漫剧路由。为它加一个范围，要么是把那个端点换个名字重新推导一遍，要么是声称存在一条并不存在的路径；把提供方自己的选择器转发过去，陈述的才是控制台真正发的东西，也让工具「一个范围一个端点」这条规则保持完整。

**只返回第一页，让调用方自己再要。** 提供方自己的默认就是一页，工具也会更早返回。但它同时还得解释匹配列表是部分的，因为调用方看不见哪些行从未被读取；把 `total` 与 `complete`、`scanned_pages`、`scan_page_limit` 摆在一起就直接说明了这件事，而且只在列表多于一页时才付出那些额外请求。

## Consequences

注册的工具集增至九个，这是该行挂载期间固定的每次请求 token 开销，也是[工具目录](../../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-jubian)里多出的一份 schema。读取本身免费、不写账本，因此计费调用之前的一次查找只花掉它的往返。

调用方能看到两个限制。查找只能找到账号已经能看到的剧本：它读的是调用方自己名下的画布项目与可认领池，两份范围之外的剧本都在两个范围之外。它回答的是剧本在哪里，而不是调用方是否可以用它：池子的角色、认领冲突与状态流转仍留在控制台与抢本工作流里，`jubian_find` 没有认领方法。漫剧的选择器只是收窄 `mine` 返回什么，并不回读项目本身的任何信息：一行只陈述自己的 `script_style` 编码，而任何编码的含义仍由提供方定义。

## Testing

`packages/jubian/tool-jubian/tests/find.spec.ts`（24 个测试）覆盖两个范围、对任一名字字段的匹配、空白与大小写归一、必须不命中的近似输入、仅池子才有的字段、每条 `mine` 匹配上的 `script_style`、`status` 在池子扫描的每一页上转发以及给 `mine` 时的拒绝、`production_type` 与 `share_target_type` 按控制台实际发的 `productionType`／`shareTargetType` 查询原样转发、只给其中一个时另一个不出现在查询串里、给 `pool` 时两次都以中文报错拒绝、非整数编码在任何请求前被拒、每个范围实际请求的精确路径与方法、把 total 所需页面全部读完的扫描、报告 `complete: false` 的页数上界、匹配输出上限、两种信封写法、两种都不是时的 `CONTRACT_CHANGED`，以及每一次参数拒绝——这些都没有发出请求。`packages/jubian/jubian-api/tests/catalog.spec.ts`（16 个测试，含新增的 `readScriptList` 用例）覆盖读取器的两种写法、它要求的整数 `total`、字段投影、提供方未发送字段留下的 `null`、它接受的 `scriptStyle` 写法、它接受的布尔写法，以及它的各种拒绝。`pnpm exec vitest run packages/jubian/tool-jubian/tests/find.spec.ts packages/jubian/jubian-api/tests/catalog.spec.ts --maxWorkers=1` 报告 40 passed。

验证这个工具时没有对线上提供方发起任何调用。两条路径、两种信封写法与那对漫剧查询参数，都取自抢本工作流笔记与运维自己抓到的控制台请求，而提供方的变化会以 `CONTRACT_CHANGED` 显现，与本包里其它每个读取器完全一样。`productionType` 与 `shareTargetType` 除控制台发出的那两个取值之外的含义未被验证，工具也不解释它们。
