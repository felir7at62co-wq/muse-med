---
description: "带类型的剧变（Jubian）载荷读取器与请求构造器：供读取目录、资产、视频、分镜、图片、字幕或转高清数据，并提交对应请求体的调用方使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-jubian-api

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-jubian-api` 把剧变（Jubian）的响应载荷变成经过校验的带类型值，并把调用方的输入变成剧变接受的精确请求体。一次导入即覆盖目录与分集读取、资产与材质读取、视频任务与子结果读取、分镜快照、图片生成、去字幕、转高清与有界媒体下载。它自己不发送任何剧变请求：传输与凭证属于 `@deepseek-ai/dsh-jubian`，而调用这些函数的是 `@deepseek-ai/dsh-tool-jubian`。读取器把信封的 `data` 字段当作 `unknown` 接收，任何不匹配的载荷都会抛出 `JubianError`、错误码为 `CONTRACT_CHANGED`，而不是返回一个只读了一半的值。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已经拿到剧变响应信封的任意包里导入本库。常见路径只有两次调用：先把请求发一次，再把信封的 `data` 交给对应端点的读取器。

### 何时选择

当你要读取或提交剧变业务数据、又不想重新推导提供方的线上形状时，选择本库。它是依赖项，不是组合配置行：它不注册任何 Cordis 服务、工具、提示词片段或会话事件，因此没有任何东西会挂载它，也没有属于它的 `cordis.yml` 条目。请从自己拥有传输层的插件或测试中调用它。当模型应当通过工具调用剧变时，改用 `@deepseek-ai/dsh-tool-jubian`。

每个读取器都只接收一个参数：剧变响应信封的 `data` 字段，即 `JubianResponse.data`。传输层把这个字段原样返回，而赋予它类型的就是本库。

### 最小可用调用

在一次传输调用背后读取一个视频生成任务：

```ts
import { JubianClient, JubianError } from '@deepseek-ai/dsh-jubian'
import { readTaskPage } from '@deepseek-ai/dsh-jubian-api'

const client = new JubianClient({ credential: resolveToken })
const response = await client.request({ method: 'GET', path: '/admin/aigc/video/task/428322' })

try {
  const task = readTaskPage(response.data)
  console.log(task.task_id, task.status, task.real_cost)
} catch (error) {
  if (error instanceof JubianError && error.code === 'CONTRACT_CHANGED') {
    console.error('Jubian changed the payload shape this reader expects')
  }
}
```

成功就是一个完整带类型的值：`task.task_id` 是数字，`task.real_cost` 是提供方自己的字符串或 `null`。失败就是一个 `JubianError`，其错误码为 `CONTRACT_CHANGED`，表示载荷没有携带读取器必需的字段。读取器从不返回部分结果，也从不给缺失的数字补一个零。`JubianError` 本身属于 `@deepseek-ai/dsh-jubian`，所有失败码都由它拥有。

### 读取结果列表

分页读取器返回 `{ total, rows }`。读取某个生成任务的全部子结果，并逐条判断它在目标分辨率下能否交付：

```ts
import { needsUpscale, readSubtaskPage } from '@deepseek-ai/dsh-jubian-api'

const response = await client.request({ method: 'POST', path: '/admin/aigc/video/task/sub/list',
  body: { aigcVideoTaskId: 428322 } })
const page = readSubtaskPage(response.data)

for (const row of page.rows) {
  console.log(row.subtask_id, row.video_url, row.last_stage, needsUpscale(row, '1080p'))
}
```

`needsUpscale()` 把当前文件与交付目标作比较。已记录的 SeedVR2 处理会把当前文件视为 1080p，即使生成行仍保留旧标签；其他情况下，低于目标返回 `true`，等于或高于目标返回 `false`，现有证据无法对任一侧排序时返回 `null`。要使用的文件是 `row.video_url`：转高清之后，提供方把生成输出保留在 `row.base_video_url`，并在 `video_url` 里报告最新的那个文件。

### 构造请求体

构造器接收调用方输入与实时目录，返回可提交的请求体。构造一次去字幕：

```ts
import { buildSubtitleEraseRequest } from '@deepseek-ai/dsh-jubian-api'

const body = buildSubtitleEraseRequest('quzimuToB', {
  scriptId: 2708, episodeId: 46734, episodeCount: 1,
  taskName: 'episode-1-erase',
  firstResultId: 979766, parentResultId: 979766,
  videoUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/v.mp4',
  duration: 13, videoWidth: 720, videoHeight: 1280,
})
```

构造器返回一个普通对象，不发送任何东西。用 `client.request()` 提交它，再用 `readSubtitleTaskId()` 从响应里读回任务身份。`buildSubtitleEraseRequest` 按模型固定标准标识：`quzimuToB` 用 `26`，`ark-erase-video-subtitle-pro` 用 `67`；后者是自动路线，不接受矩形框。调用方省略 `subtitleBox` 时，区域路线改为从画面尺寸推导这个矩形。

### 解析视频设置

`resolveVideoModel(catalogue, intent)` 保留精确的 `modelId`、显式 `platformId`、生成类型和时长，宽高比与分辨率匹配不区分大小写。目录必须恰好匹配一项；缺失或歧义会失败，而不是改选其他模型或平台。返回的选择器刷新过期标准标识，并保留 `genNum=1`。原生准备流程使用实时分镜设置；按模型生成应使用 `prepare_video`/`submit_video`。

`validateVideoDuration()` 只接受整数秒。目录没有时长上下限：精确 id `doubao-seedance-2-0-260128` 保留 2–15 秒，`doubao-seedance-2-5-260628` 使用用户确认的 30 秒上限并保留现有 2 秒下限。此回退不是提供方验证的时长证据。未知 id 拒绝放行。预览校验应用相同范围，且不削弱项目、指纹或有序身份校验。

### 下载媒体

`downloadMedia()` 是本包中唯一会打开套接字的函数。它从固定的媒体来源白名单取回一个有界的载荷，并连同摘要一起返回字节：

```ts
import { downloadMedia } from '@deepseek-ai/dsh-jubian-api'

const media = await downloadMedia(row.video_url!, { kind: 'video', timeoutMs: 60000 })
console.log(media.media_type, media.kind, media.sha256, media.bytes.byteLength)
```

该调用会拒绝 `MEDIA_ALLOWED_ORIGINS` 之外的 URL、超过对应类型上限的响应、重定向，以及自身头字节与所请求 `kind` 不符的响应体。字节会交回给你；写文件是你的步骤。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本库由八个小模块组成，每个模块只有一种形状：要么读取传输层已经接受的载荷，要么用调用方已经持有的值组合出请求体。这里没有任何东西在调用之间保留状态，也没有任何东西会改动自己的输入。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 公开表面：这里导出的每个读取器、构造器与常量 |
| [`src/catalog.ts`](src/catalog.ts) | 模型目录行、剧本身份与分集分页 |
| [`src/asset.ts`](src/asset.ts) | 资产分页与详情、主体设定材质、单张生成图 |
| [`src/video.ts`](src/video.ts) | 视频任务、子结果、阶段名与转高清判定 |
| [`src/storyboard.ts`](src/storyboard.ts) | 分镜快照与两个只改一个字段的 PUT 变换 |
| [`src/image.ts`](src/image.ts) | 目录选择器解析、图片请求体与展示单价 |
| [`src/subtitle.ts`](src/subtitle.ts) | 擦除模型与标准、推导出的擦除框、去字幕请求体 |
| [`src/upscale.ts`](src/upscale.ts) | SeedVR2 转高清请求体与提交后的任务身份 |
| [`src/download.ts`](src/download.ts) | 从允许来源进行的有界媒体传输，媒体类型来自头字节 |
| — | 不发布运行时不变量配套入口；纯读取器不持有可观测的运行时状态，其代数由单元测试保障。 |

### 校验如何保持兼容

每个读取器只校验它承诺的字段，忽略其余一切。因此，提供方新增一个字段不构成错误；而读取器需要、载荷却缺少的字段才是错误。部分读取器还接受同一事实的两种已观测写法：资产 id 可能是 `id` 或 `assetId`，结果身份可能是数字或数字字符串，而一个场景可能是一个对象，也可能是嵌套的结果。`readGeneratedImage()` 更进一步，同时接受同一个端点给过的两种形态：提供方今天返回的列表——每行用 `id` 给材质、用 `assetUrl` 给文件——以及早期抓包里的单体对象——字段是 `materialId` 与 `url` 或 `materialUrl`。空列表是失败，不是空引用。

当某个字段在提供方自己的数据里本就可选时，读取器把这种可选性以 `null` 延续下去，而不是编造一个默认值。提供方没有发来的费用保持 `null`；它绝不会变成 `0`。

### 视频阶段词表

`VIDEO_TASK_TYPES` 把 `1` 映射为 `generate`、`10` 映射为 `erase_subtitle`、`20` 映射为 `upscale`；`versions` 携带结果历史。`subtitle_erased` 要求存在当前 URL，且最新类型 10 结果成功并有显式输出 URL，或存在成功的类型 10 历史条目且其 URL 等于当前 URL。只有阶段 10 不足以成立，该标记也不代表字幕视觉审核通过。`upscaled` 要求转高清次数为正或最新阶段为 20，不能仅凭 URL 变化判断。

`RESOLUTION_ORDER` 列出该提供方从 `480p` 到 `4K` 的阶梯。`resolutionRank()` 返回标签的下标，标签无法识别时返回 `-1`。交付目标无法识别时，或来源无法识别且没有已记录的转高清时，`needsUpscale()` 返回 `null`；已记录的转高清会确立一个 1080p 当前文件。交付目标是比较，不是常量，因为生成模型可能封顶在目标之下。

### 线上形状从何而来

构造器的请求体取自产品工作台的抓包并逐字段复现：去字幕请求体带 `taskType` 10 及其按模型固定的标准，转高清请求体带 `taskType` 20、SeedVR2 模型 id 及其两个标准标识。图片请求体则属于另一类：它从实时目录解析 `standardId`、`platformId` 与 `videoStandardId`，而不是接受调用方传入，因为这些值是账户状态，而过期的一组会让提供方在调用方已经以为成功之后才拒绝请求。同一个 modelId 可能按平台列成多行、各自定价，因此 `resolveImageModel()`、`buildImageRequest()` 与 `readImageDisplayPrice()` 都接受一个 `ImageModelSelection`（`platformId`、`standardId`，或两者都给）；当这个选择没能把候选收敛到恰好一行时，它们会带着全部候选一起失败。

### 下载模块额外做了什么

`downloadMedia()` 把媒体 URL 当作不可信输入。它解析该 URL，拒绝携带凭证或 fragment，并要求来源出现在传入的白名单里。它不发送 `Authorization` 头，不跟随重定向，超时即中止。响应按对应类型的上限分块读取，媒体类型随后从载荷自身的头字节解出，所以存盘文件的扩展名从来不是猜测。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你需要这些读取器之下的传输层，或调用它们的工具时，阅读以下页面。

- [剧变传输层源码](../jubian/src/index.ts)——客户端、五个稳定失败码、凭证修复，以及这些读取器与构造器所依托的写账本。
- [剧变工具包](../tool-jubian/README.zh.md)——调用这些读取器与构造器的面向模型的工具。
- [模块图](../../../docs/module-graph.zh.md)——这些包在仓库依赖顺序中的位置。
- [新增一个包](../../../docs/cookbook/adding-a-package.zh.md#4-write-the-package-readme)——本 README 遵循的包文档约定。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包不注册任何工具、提示词片段或会话事件；这些读取器与构造器的每一种渲染用途都由 `dsh-tool-jubian` 拥有。

#### KV Cache 影响

无直接影响；渲染其输出的工具层拥有任何请求前缀变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些约束是当前的包行为，不是任务清单。

- **载荷一旦不再匹配就使调用失败**——读取器宁可抛出 `CONTRACT_CHANGED` 也不降级，而该错误不携带字段名，所以调用方报告的是契约变化，运维者要读原始载荷才能找出是哪个字段动了。
- **图片选择器由调用方决定**——只有当这个选择把候选收敛到恰好一行 `gpt-image-2` 时，`resolveImageModel()` 才接受该目录。多行而未给选择时调用失败，错误里列出每个候选的 `platformId`、`standardId`、单价与单位；给了选择却匹配不到任何候选时同样失败。本库没有任何偏好某个平台或更便宜那一行的规则。
- **费用与价格字段是证据，不是结算**——`real_cost`、`estimated_cost`、`discount_cost` 与 `readImageDisplayPrice()` 承载提供方报告的内容，且 `readImageDisplayPrice()` 始终返回 `quote_verified: false`；这里没有任何东西授权花钱。
- **默认擦除矩形不裁切到画面内**——`defaultSubtitleBox()` 复现提供方实测的比例（`zimuTop` 570/1280、高 720/1280、宽为画面内缩一个像素），因此在 720x1280 的源上这个框可以越过底边；该形状取自一次被接受的请求，而不是提供方的保证。
- **`needsUpscale()` 在无法判断时回答 `null`**——交付目标无法识别，或来源无法识别且没有已记录的转高清证据时，会得到 `null` 而不是布尔值；调用方必须把它当作未回答，而不是可以交付的许可。
- **媒体传输有界且只允许单一来源**——`downloadMedia()` 只接受 `MEDIA_ALLOWED_ORIGINS` 中的来源，把响应体限制在 `MEDIA_LIMITS`（图片 64 MiB，视频 512 MiB），拒绝重定向，且不写入磁盘。
- **分镜请求体从不从零拼装**——读取与免费保存保留非空宽高比/分辨率标签、`genNum=1` 和可安全表示为毫秒的正整数时长。传统 `withGenerationEnabled()` 路径保留 9:16/720p 与 4–14 秒内容时长，要求保存时长等于内容加一秒，并校验精确模型的时长能力。它不解析目录选择器；其他比例/分辨率返回可操作的 `INVALID_ARGUMENT`，指引调用方保留已存设置并使用原生准备流程。已存储的 `isGenerate=1` 不能证明生成已发生。
- **没有任何传输行为会被重试或续跑**——除媒体下载外，本包不自己发起任何请求，因此每一次重试、超时与轮询决定都属于调用方。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
