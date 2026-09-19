# Agent Note: 剧变生图锁定目录行并回读到 Active

Status: implemented

[English](2026-09-19-jubian-image-row-pin-and-active-readback.md) | 中文

## Problem

三个缺陷汇聚在同一次调用 `jubian_video image_generate` 上，合起来让这条计费生图路径在实时账户上完全不可用。

`resolveImageModel()` 在 `taskType=2` 目录里按 `modelId === 'gpt-image-2'` 过滤，并要求 `matches.length === 1`，否则抛 `CONTRACT_CHANGED`。该账户把这个 modelId 列了两次：第 `66` 行在平台 `KU_AI`、0.12 元/张；第 `76` 行在 `DUO_YUAN_TAN_SUO`、1.05 元/条。结果是连请求体都构造不出来，失败发生在计费写之前——这是这个缺陷里安全的那一半，也是它以契约错误而不是错误扣费暴露出来的原因。

`readGeneratedImage()` 要求非数组对象，并读 `url`/`materialUrl` 与 `materialId`。而端点 `GET /aigc/material/getGeneratedImageByAssetId?assetId=N` 返回的是一个列表，每行用 `id` 给材质、用 `assetUrl` 给文件，所以读取器在第一步就抛错；即便过了第一步，也找不到 URL。而这个端点恰恰是唯一同时返回材质 ID 与图片 URL 的免费读取。

`POST /aigc/asset` 是异步的。它的响应带回新资产 ID，图片要等资产变成 `hsAssetStatus === "Active"` 才存在，实测在一到两分钟之后。`image_generate` 既不返回材质 ID 也不返回 URL，也不等待，于是照它落盘的调用方会得到一个空资产，而结果看起来是成功的。

## Decision

**目录行走哪一行是部署的选择，目录含糊就失败。** `resolveImageModel()`、`buildImageRequest()` 与 `readImageDisplayPrice()` 接受一个 `ImageModelSelection`——`platformId`、`standardId`，或两者都给——只有当这个选择让候选收敛到恰好一行 `gpt-image-2` 时才接受该目录。否则抛出 `CONTRACT_CHANGED`，错误里点名每个候选的 `platformId`、`standardId`、单价与单位。`dsh-tool-jubian` 用配置字段 `imagePlatformId` 与 `imageStandardId` 提供这个选择，两者都没有默认值。工具结果以 `model_selection: { standard_id, platform_id }` 回显实际购买的那一行，账本里的报价也就是该行自己的单价。

**生成图读取器同时接受两种载荷形态。** 列表取第一行；单体对象照旧可读。URL 取 `assetUrl ?? url ?? materialUrl`，材质 ID 取 `id ?? materialId`。空列表是失败，因为调用方要的是一张该资产还没有的图。

**`image_generate` 在返回任何东西之前先把资产回读到 `Active`。** 计费写被受理后，它轮询免费的 `GET /aigc/asset/{id}` 直到 `hsAssetStatus` 为 `Active`，再读生成图，然后返回 `parent_asset_id`、`model_selection`、`asset_status`、`material_id`、`image_url`、`observed_asset_status`、`waited_ms`、`readback_error` 与一句 `next`。`asset_status` 取 `active`、`timeout`、`failed`、`replayed`、`unverified` 之一；只有 `active` 表示图确实存在、可以安全落盘或送审。预算来自配置字段 `imageActiveTimeoutMs`，默认 180000 毫秒，轮询间隔 `imageActivePollMs`（默认 3000 毫秒）；两者在测试里都可注入，因此超时路径不花真实时间。

## Why a timed-out readback is a state and not an exception

回读把预算耗尽时，计费写已经被受理：信封 code 是成功码，账本里有一条 `accepted` 的 settle 行，资产也确实存在。此时抛错会把一次已经完成的扣费报告成一次失败调用，而调用方的下一个动作——换一个新的 `idempotency_key`——正是账本存在的意义所要阻止的那个错误。因此超时以 `asset_status: timeout` 返回，配上说明「确认了什么、没确认什么」的 `readback_error`，`material_id` 与 `image_url` 保持 `null`，并由 `next` 明确禁止换 key。`replayed` 与 `unverified` 与它分开，因为它们是不同的事实：前者既没发送也没回读，后者连要读的资产都点不出来。

## Alternatives considered

**默认取单价最低的一行。** 这能让该账户零配置跑通，而且 0.12 确实比 1.05 便宜。它落选是因为这两行是卖不同产品的不同平台，一个从未点名过其中之一的运维者会被替它在上面花真钱；而且这个默认值还得应付下一个账户两行价格反过来排列的情况。同样的理由否掉了「取第一行」与「取提供方列在最后的一行」：目录顺序不是契约。

**接受任意一行、让提供方去决定。** 这实质上就是修复前的状态——选择器之所以存在，正是因为一组过期或随意的值会让提供方在调用方以为成功之后才拒绝请求。

**受理即返回，并在文档里写「自己去轮询」。** 工具内部的环节更少，也是 `upscale` 与 `erase_subtitle` 的做法。它落选是因为 `image_generate` 的结果没有回读就没法用：调用方既没有可以交给 `confirm_casting` 的材质 ID，也没有 URL——那正是第三个缺陷的复述。

**无期限地等待。** 工具调用必须终止；预算做成配置，因为提供方延迟是部署自己的观测。

**超时抛一个专门的错误。** 因上述理由否掉；而且一个独立的 `JubianError` 码还得去描述一个「钱已经花了、账本也已经记了」的状态。

**状态轮询固定一次之后就固定读一次生成图，而不是循环。** 生成图行可能滞后于它所属的状态，单次读取会把这种滞后变成硬失败；循环在预算内重试生成图读取。

**要求传入材质 ID 参数，而不是取列表第一行。** 当前没有任何消费者需要在一个资产的多个生成图之间选择，凭空加一个参数等于一条没有调用方的公开接口。

## Consequences

这条计费生图路径在实时账户上能跑完了：一次 `POST`（或 `PUT`）加后续免费读取，返回 `confirm_casting` 需要的材质 ID，以及一次视觉审核可以取用的 URL。单价也不会再被算到错误的平台上，因为报价和结果都点名了那一行。

代价是一项配置义务。当账户目录列出第二行 `gpt-image-2` 时，`image_generate` 在设置 `imagePlatformId` 或 `imageStandardId` 之前就是一个响亮的配置错误——这是刻意的，因为替代方案是在一个没人点名的平台上花钱，两个包的 README 都把它记成了已知限制。此外，一次工具调用现在最长可能持续 `imageActiveTimeoutMs`，这是本包唯一一处阻塞等待异步提供方阶段的地方；即便超时，调用方手上仍留有一次待做的回读。

`packages/jubian/jubian-api/tests/image.spec.ts` 钉住多行拒绝、候选清单与按行报价，`packages/jubian/jubian-api/tests/asset.spec.ts` 钉住生成图读取的两种载荷形态与空列表，`packages/jubian/tool-jubian/tests/methods.spec.ts` 钉住轮询到 `Active`、超时状态且没有第二次计费写、未锁定目录行时不发送，以及回显的 `model_selection`。

## Related

- [Jubian storyboard isGenerate is not a gate](2026-09-19-jubian-storyboard-isgenerate-not-a-gate.zh.md) —— 该提供方版本与抓包契约之间另一处实测差异。
