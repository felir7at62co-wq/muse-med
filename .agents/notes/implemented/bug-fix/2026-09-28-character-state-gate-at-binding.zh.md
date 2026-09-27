# Agent Note：绑定资产时的角色状态门禁

Status: implemented

[English](2026-09-28-character-state-gate-at-binding.md) | 中文

## Problem

2026-09-28 对《山海自有相逢处》第 25 集的交付复核发现：剧本写的是 医生：孕八周，而 沈知意 被绑到 `沈知意（孕期职场装）`（asset 81685 / material 79293），于是 分镜3 与 分镜4 渲染出了足月孕肚。[那次复核自己的 Agent Note](2026-09-28-short-drama-delivery-defects.zh.md) 用提示词与默认值修好了四个缺陷中的三个，把这一条留作待办：「要判就得让本集体型进入机器可读字段，并给『孕八周对应什么身形』立规则」。

提示词层在这里已经失败过一次。[tweet-drama-shot-asset-match](../../../../packages/drama/skills/skills/tweet-drama-shot-asset-match/SKILL.md) 要求这次运行先写每个角色的状态卡、再与资产设定板比对；运行写了状态卡，仍然挂错版本，并在日志 L2507 自我诊断（「是资产挂了错的那一版」）。没有工具读取的状态卡拦不住一次绑定，而编译真正消费的产物——镜头脚本——根本没有体型状态：`drama_shot` 判的是资产身份（official、ID、URL），从不判这些 ID 会渲染出什么状态。

## Decision

**镜头脚本按入画角色携带状态，`drama_shot` 拒绝与之不符的绑定。** `主体状态追踪` 的每个主体多写一条与该块其它字段同级的字段：

```
主体状态追踪：
【沈知意】-位置：【场景图视角诊室中央偏右木椅靠近诊桌处】；
身体状态：【孕早期（孕八周）；孕期职场装；长发】；
```

这就是复核要求的机器可读字段，而且它落在格式所有者自己的块里，不是新产物：[shot-script-creator-9-16](../../../../packages/drama/skills/skills/shot-script-creator-9-16/SKILL.md) 现在把它与 位置/动作状态/情绪状态 并列记录，资产技能本就要求的状态卡因此落在工具会读的地方。

[`src/state.ts`](../../../../packages/drama/tool-shot-script/src/state.ts) 归一化两侧。两个维度用封闭词表，因为它们决定身形——孕期阶段（`孕八周`/`怀孕8周`/`怀孕十三周` → 孕早期，`十四周` → 孕中期，`二十八周` → 孕晚期，`非孕期`，只写 `孕期` 则为 孕期待定）与年龄段（岁数，或 儿童/少年/青年/中年/老年）。声明里的其余内容——服装、发型、伤病——都算状态文字，登记值必须包含。一处写出两个不同阶段即为冲突，任一维度冲突都直接拒绝该镜头，而不是去要一个任何版本都无法满足的资产。

资产侧复用清单已有的字段：`state_or_costume`（连同资产自己的名字，因此名为 孕晚期职场装 的版本即使字段写得简略也登记了阶段）与 `episodes`。[`src/assets.ts`](../../../../packages/drama/tool-shot-script/src/assets.ts) 对每个已绑角色判四件事：

- 镜头声明了某维度而登记没有 → `asset_state_unregistered`，点名资产 ID 与 `state_or_costume`；
- 两侧都写了但取值不同，或登记值不包含镜头写出的状态文字 → `asset_state_mismatch`，点名期望值、登记值与资产 ID；
- 登记写了某维度而镜头没写 → `shot_body_state_unusable`：两侧必须写同一组维度，因为「登记声明了镜头从未主张的体型」正是孕晚期设定板混过去的方式；
- 已绑角色完全没有 `身体状态` → `shot_body_state_missing`。

**资产的 `episodes` 登记在同一点强制。** 已绑资产必须登记 `episodes`——具体集号，或全剧标记 `all`/`全剧`；调用给了 `episode` 而登记不覆盖该集时拒绝绑定（`asset_episodes_unregistered`、`asset_episode_mismatch`）。`validate` 与 `preview` 现在也接受 `compile` 本就必填的 `episode` 参数，最早可判定点因此能判同一件事。

**没有任何登记携带所需状态时，产出的是补料需求（`asset_state_missing`）而不是绑定。** 失败信息点名角色、阶段、服装与发型、新资产用于哪几集、已登记的版本，以及可执行的补料路径：从资产库复用，或生成并登记一行，再跑 `drama_assets reconcile`，然后重新校验。这些失败仍在时 `compile` 不写任何文件，所以补料需求同样拦住 `select_assets`：那次调用要带的素材键只能来自一次通过的编译。

登记口径：**清单缺这些字段时不拒绝整份文件——该行降级为未标阶段/未标集，失败落在绑定那一刻。** 清单由模型撰写、被三个工具读取；在读取时拒绝整份文档会把一条历史行变成解析失败，掩盖其它全部问题，而且会去判那些谁也绑不上的行。绑定才是伤害发生的地方，也只有在那里拒绝才能点名资产与修法。

`jubian_organize` 读同一份清单，因此接受同一个全剧标记：`episodes` 写 `all`、`*` 或配置的 `seriesLabel` 时该行归入 `series` 桶（那正是这个桶本来的含义），而不是抛 `第 N 条资产的集号 all 不是数字`。

## Alternatives considered

**在 `jubian_storyboard.select_assets` 上加 `drama-gate` 规则。** 不作为主判定点：`select_assets` 收的是素材键与 ID，不带状态，判不了任何「一次通过的 `drama_shot compile` 尚未判定」的东西——而编译失败时不会写出那些键。再加一条门禁规则等于在不拥有清单读取方的包里把同一条规则实现第二遍。

**每集一张状态卡文件，或新增顶层镜头脚本字段。** 否决：每个角色的状态在 `主体状态追踪` 里已有归宿；单独文件会让 `validate` 需要集号，也会把状态留在编译器消费的产物之外。

**整串状态按集合相等比对。** 否决：服装与发型是自由文本，相等会因为措辞（`米色风衣` 与 `风衣（米色）`）拒绝正确的绑定。维度是封闭词表，逐项判等；状态文字则检查镜头写出的内容是否被登记包含。

**给伤病立封闭词表。** 否决：格式所有者要求姿态、持有物与伤势状态不单独成字段，且已报告的缺陷关乎身形。伤病仍是状态文字，镜头写了 病弱 或 手部包扎，登记就必须写同样的内容。

**清单某行缺 `episodes` 或阶段时让 `drama_assets` 读取或 `jubian_organize` 失败。** 否决理由同登记口径：同一行会让一个根本不绑定它的工具失败，而一条坏行会掩盖清单其余部分。

## Consequences

身份与 ID 都正确、但状态错误的正式资产再也不能通过编译。清单早于这些字段的项目，在每个角色资产上都会绑定失败，直到该行写明阶段与 episodes，而失败信息会点名该行——这个强制是刻意不可降级为警告的。

门禁仍不判定的东西：资产设定板图片本身。登记文字正确而图不对的情况仍由模型复核负责，短剧技能要求在提交前完成；另一条路需要本工具没有的像素。镜头点名了角色、却没人声明它的状态、且清单里完全没有该角色的行，仍然不报错，因为脚本里没有任何东西说明该要哪种状态。

## Verification

`pnpm vitest run packages/drama/tool-shot-script` 通过，7 个 spec 文件共 129 条；新增的 [`tests/state.spec.ts`](../../../../packages/drama/tool-shot-script/tests/state.spec.ts) 端到端驱动已注册工具：不一致用例用的是事故本身的 ID（asset 81685 / material 79293），无匹配版本用例产出补料需求，`episodes: ['all']` 覆盖任意一集，另有未标阶段、缺声明、冲突、登记多写维度等边界。对 `src/state.ts` 与 `src/assets.ts` 跑 `--coverage.include` 显示两个文件全覆盖，仅有两处有理由的 `v8 ignore`（模式保证必然命中的捕获组与查表）。

`pnpm vitest run packages/jubian/tool-jubian/tests/organize.spec.ts` 通过，含新增用例：把 `episodes: ['all']` 与 `['全剧']` 读成跨集母版而不是拒绝。

清单读取现在也接受 `items` 数组——项目自己的清单用的键，`jubian_organize` 本就兼容——因此门禁在真实项目上可达，而不是先卡在数组键上。
