---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-16-frame-offload-notice

English | [中文](2026-11-16-frame-offload-notice.zh.md)

## Summary

Adds an optional reason to image offload decisions and derived image blocks. Video observations distinguish previously displayed frames from images excluded by request limits.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

The current reader accepts historical events without notice and preserves their request-limit meaning. The previous image/offload reader rejects any extra event field before applying a projection, so it refuses notice-bearing decisions without executing or truncating recovery. ImageBlock.offloadNotice is optional; older ordinary message readers may omit this display explanation while retaining the immutable attachment and offloaded marker. The Session writer stays at version 4; no committed generation is rewritten. Frame-image checkpoint state advances to version 3 and rebuilds from events.

<a id="verification"></a>
## Verification

687 video/offload/content tests passed with 100% changed-file coverage; 585 screenplay tests passed with 100% entry coverage; 211 content and request-pricing tests passed with 100% changed-file coverage; 160 replay tests passed with 100% entry coverage. The shipped headless lifecycle replay passes from source and built output and retains its canonical Session input.

<a id="dev-note"></a>
## Dev Note

None.
