# Agent Note: Diagnosing an unreadable Jubian response

Status: implemented

[English](2026-09-28-jubian-unreadable-response-diagnostics.md) | 中文

## Problem

每一次失败的剧变读调用都报同样六个词：`Jubian response did not match the expected envelope`。2026-09-27 的现场报告列出 `storyboard get`、`prepare_video`、`erase_subtitle`、`model preview`、`video task` 与 `organize index` 都以这种方式失败，而同一账号在浏览器控制台里能看到数据，且这条消息无法说明实际发生的是两件不同事情中的哪一件。传输层会拒绝一个它无法当作信封读取的响应体；`@deepseek-ai/dsh-jubian-api` 里的读取方会拒绝一个它无法映射的载荷。两者都抛出不带详情的 `CONTRACT_CHANGED`，因此运维者分不清「远端返回了数组」与「远端少了 `modelConfig`」——而唯一幸存下来的嵌套详情 `Expected a JSON object`，来自 `jubian_model` 自己对 `modelConfig` 的处理，而不是信封。

同一份报告还暴露了第二种失败模式：`organize index` 拒绝了一份十行都带 `name` 与 `type` 的清单，因为检查只报「有资产缺少 name 或 type」——无论字段是缺失、为空，还是存在但不匹配三种类别拼写之一，都是同一句话。

## Decision

**被拒绝的响应体只被描述，绝不被复述。** `packages/jubian/jubian/src/diagnostic.ts` 里的 `describePayload()` 与 `describeUnparsed()` 产出一行结构：顶层类型、自身键名、数组长度、字节数与一段有界摘录。凭据类键名背后的取值变成 `[redacted]`，绝对 URL 被缩减为来源，长的不透明串被替换，字符串、容器与嵌套深度都有上限。本客户端抛出的每一个 `CONTRACT_CHANGED` 都带这段描述：不是 JSON、不是合法 UTF-8（此时给字节长度与十六进制前缀而不是文本）、顶层是标量、对象不带整数 `code`、无法映射的应用码、字节上限，以及不可读的响应体。

**信封形态被读取、被记录、也被限定。** `JubianResponse.envelope_layout` 说明响应体实际是哪种形态。两种有据可查的形态保持原有行为。另有四种被容忍，因为传输层一旦拒绝，读取方就再也拿不回载荷：单元素数组里的成功信封、单元素数组里的载荷对象、顶层的裸数组，以及本身就是一个成功信封的载荷。自身不带 code 的形态报告 `transport.application_code: null`，写入账本因此记为 `unknown` 而不是 `accepted`。一个合法 JSON 但不属于上述任何一种的响应体仍然失败。

**`DSH_JUBIAN_DEBUG_DUMP` 是运维者的开关，不是默认值。** 当它指向一个文件时，`request()` 会为每个响应追加一条脱敏 JSONL 记录——时间戳、方法、路径、HTTP 状态、应用码、信封形态、字节数、响应哈希与脱敏后的响应体——按需创建目录，并在平台支持时使用仅属主可读写的权限。变量未设置时它始终关闭，没有任何代码路径会打开它。记录的是每一次调用而非只有 `GET`，因为 `subtasks` 是一个只读的 `POST`。dump 从不读取请求头，且 dump 的任何失败都不会改变它所观察的那次调用。

**`organize index` 会点名它拒绝的条目与字段。** 清单行失败会报告序号、实际读到的字段、观察到的取值与可接受的拼写；文档层失败则描述它实际看到的顶层结构。`type` 还额外接受提供方自己的类别号（`1`、`2`、`3`），它们与约定所命名的正是同样三个类别。

## Alternatives considered

**把响应体或它的截断副本放进错误里。** 拒绝：工具结果会进入模型的上下文，而提供方响应体可能带令牌、带签名的 URL 或很长的提供方消息。结构描述回答了「收到的是什么」，却从不携带调用方没有索取的取值。

**把任何 JSON 响应体都当成功，交给读取方判断。** 拒绝：这会删掉那个能识别提供方错误页的信封检查，也会让一个完全没有 `code` 的响应体冒充已验证的成功。被容忍的形态更窄——必须是上述四种之一，且每一种都被记录。

**无条件解开嵌套的 `{code, data}` 载荷。** 拒绝：业务载荷完全可能同时带这两个键。只有当内层对象声明了成功码时才解开，因此歧义由证据而不是由形态来消解。

**把载荷描述接到 `@deepseek-ai/dsh-jubian-api` 的每一个读取方里。** 延后而非拒绝：那些读取方在拒绝某个字段的位置并不持有顶层载荷，因此这会是第二个包中逐个读取方的重构，需要各自的测试。在那之前，读取方层的拒绝仍是一个不带详情的信封错误码，README 写明了这一限制，而 debug dump 就是取证路径。

**通过工具行的 `Config` 配置这个 dump。** 拒绝：响应字节与凭据边界都在传输层，而 `Config` 字段会让一份已发布的 `cordis.yml` 在那个进程里未经运维者要求就打开载荷捕获。

## Consequences

`packages/jubian/jubian/tests/envelope-layout.spec.ts` 钉住每一种形态、嵌套解开、非对象响应体与不可解码响应体的描述，以及描述中不含令牌。`packages/jubian/jubian/tests/debug-dump.spec.ts` 钉住开关未设置时不写任何东西、对无人能读的响应仍记录一条脱敏行，以及（POSIX 上）仅属主可读写的文件权限。`packages/jubian/tool-jubian/tests/envelope-layout.spec.ts` 钉住报告中的调用本身：`storyboard get` 在标准信封、单元素数组与嵌套信封下的读取，以及非 JSON 响应体失败时消息里带结构。`packages/jubian/tool-jubian/tests/organize.spec.ts` 钉住点名条目的清单失败与数字类别拼写。

代价是接受集比提供方有据可查的范围更宽。那些被容忍的形态是假设：仓库里没有任何真实剧变响应处于这些形态的抓包，它们被记录下来正是为了让一次抓包能确认或收紧其中每一个，README 的已知限制也这样写。诊断描述的是结构而不是取值，因此当一个载荷的缺陷是取值错误而非字段缺失时，仍然要靠 dump。
