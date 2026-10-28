---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-28-jubian-video-reuse-advisory

English | [中文](2026-10-28-jubian-video-reuse-advisory.zh.md)

## Summary

Adds the attribution-only jubian-video-reuse source for logged extraction and reuse advice.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-28-jubian-video-reuse-advisory
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-17-session-video-selection"
    after: "36d9e021c14447252c9a0dc79d33b396c264282f755903159327fe325ee6ef31"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-17-session-video-selection"
    after: "2905955547068b8519caf2470abf2861fdc41ddba2fa8d762d454c5436e29761"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-17-session-video-selection"
    after: "887a4e5f9db8d6ac0451a64438ab53ae322bb3c18841db64e152abd39b31554b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-17-session-video-selection"
    after: "7d890878cfad3f9b08b4657f31badbd9c8d5d7f69af360935090ab352d65db14"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Session records remain valid and the writer format is unchanged. The new source carries ordinary context, imposes no validation or authority requirement, and is preserved by readers without the producer. The hook uses newly admitted human messages and does not require a source projection to resume.

<a id="verification"></a>
## Verification

video-reuse-advisory-loader.spec.ts exercises logged model context, duplicate suppression, later intent changes, normal tool execution and disposal. The muse-existing-video-reuse headless Session snapshot replays without provider writes.

<a id="dev-note"></a>
## Dev Note

None.
