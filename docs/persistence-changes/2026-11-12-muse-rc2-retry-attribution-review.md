---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-12-muse-rc2-retry-attribution-review

English | [中文](2026-11-12-muse-rc2-retry-attribution-review.zh.md)

## Summary

Reviews the merged message-source declarations against the retry-control predecessor before joining the preserved histories.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-muse-rc2-retry-attribution-review
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "20aa4dc56feb4c842f717fbb80f4dd6e62add01b34e82dc099e79f73511c54d0"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "50d2dd6a64f0f38a80d30e7e9c1604ad2b7e7b7714affe74d4e01334d7e2ca77"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "5d25d2c02fdde40c58d77c42c5207fb6f60f079020535647c63c039d32794cc8"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "775923a37d6fa613ba733d996523b819af4cb2fbb7529455dee6000841366d00"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Keep Session format 4. This explicitly reviewed transition retains every predecessor source field and adds the merged declarations; it does not alter event discriminators, framing, headers, or generation names. The retry-control kind is an empty browser-correlated message, not a new human authorization; older readers can retain that empty message without providing the newer manual-retry controls. The historical structured-output-missing stop reason remains optional attribution on a subagent-settled message. Native V4 source admission is unchanged from the Muse predecessor: it accepts any nonempty producer-owned kind other than the retired plugin wrapper and retains all JSON metadata without installing its producer. Earlier readers therefore preserve the newly represented metadata; current readers preserve historical missing stop reasons and both ordinary and Muse sources. Runtime settlement renders structured-output-missing as unfinished. Current continuation admits only the authorized empty retry path and rejects nonempty retry content. The message-source additions also propagate into inbox, developer-message and title-request references. No unknown event is reclassified as ignorable, and no fallback reader or writer downgrade is introduced.

<a id="verification"></a>
## Verification

The native-source-admission, empty-prompt, continuation and continuation-messages suites passed 102 keyless tests. Five concrete attribution forms, including retry control, Muse assignment and absent/completed/structured-output-missing settlement, were decoded without producer plugins under read/write access with both none and zstd compression. Writer append preserved the complete original byte prefix. Control tests retained the original user request, deduplicated retry ids and refused empty fresh work and nonempty retry controls. Settlement tests retained exact closing output and marked missing structured output unfinished. The complete old history plus both proposed review transitions and their same-schema join passed the owner history validator in memory before any new document was written.

<a id="dev-note"></a>
## Dev Note

None.
