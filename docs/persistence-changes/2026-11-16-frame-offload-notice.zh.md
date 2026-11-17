---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-16-frame-offload-notice

[English](2026-11-16-frame-offload-notice.md) | 中文

## 概述

为图片移出决定与派生图片块增加可选说明，区分此前已经展示的视频帧与因请求限制而省略的图片。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-16-frame-offload-notice
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-15-session-activity-source"
    after: "be24024ea118dff9fbe21d449af0c58335014b32409218d045ccaea3b54dde71"
    decision: same-version
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "e277eb8aeb87424a414539b585f567912dbb8029a8358cc9665c85756f786d44"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "33208e37d689a197357eb538db59ab3989cf416d35244db84a831a2c924cc49a"
    decision: same-version
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "0bd56991b62580a91af94d54033eae4603346c41fd70bcb69949d1821489ae81"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-15-session-activity-source"
    after: "aed6186313bf84b9451753c1f642f4d2911c4137f7941b7494b905e18e4ad6e5"
    decision: same-version
  - root: "event:image/offload"
    previous: "2026-09-14-image-offload"
    after: "45884d6272818b92e15a54ac9f13916632015db6c76f248d5d8dee99ced5e973"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-15-session-activity-source"
    after: "f68de9b141fcfe3bc1b6fc238723412bd7781c5930c026540e0f29f827ae5871"
    decision: same-version
  - root: "event:system/message"
    previous: "2026-09-16-session-format-v4"
    after: "4bddf3226cd233cda5ef8bf26179b9f4b5510832936438a92e9ee238e59d631b"
    decision: same-version
  - root: "event:team/message/queued"
    previous: "2026-09-16-session-format-v4"
    after: "c70600c835c709e268363dbfeeae13f28586da03b39cacbaab3a6de0cfd405af"
    decision: same-version
  - root: "event:tool/ptc-dispatch"
    previous: "2026-10-05-ptc-operation-metadata"
    after: "ba40d0aec8a56dc8577b452cc915ddabb6af42ae6c98b29ac611a529f8d31990"
    decision: same-version
  - root: "event:tool/result"
    previous: "2026-09-16-session-format-v4"
    after: "2bb12f3aa48f0dbff1871e496063ca89700563d30fb738d5a0ae4c1e82f441d9"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-15-session-activity-source"
    after: "27484ff65e01149b0baead1bb7f0e34ac41076d02d50454f77f394fced668e2b"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

当前读取器继续接受没有 notice 的旧事件，保留其请求限制含义。旧 image/offload 读取器在应用投影前拒绝额外事件字段，因此遇到带 notice 的决定会安全拒绝，不执行也不截断恢复。ImageBlock.offloadNotice 为可选字段；旧普通消息读取器可能不展示这段说明，但仍保留不可变附件和 offloaded 标记。会话写入版本仍为 4，不改写任何已提交代际。帧图片检查点状态升为版本 3，并从事件重建。

<a id="verification"></a>
## 验证

687 项视频、图片移出及内容测试通过，改动文件覆盖率 100%；585 项剧本测试通过，入口覆盖率 100%；211 项内容和请求计数测试通过，改动文件覆盖率 100%；160 项回放测试通过，入口覆盖率 100%。已发布的 headless 配置在源码和构建模式下均通过生命周期回放，保留原始会话输入。

<a id="dev-note"></a>
## 开发备注

无。
