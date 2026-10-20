---
kind: upgrade-guide
description: "Automatic goal rounds yield on empty work, and required goal/wait records need a reader that understands them."
---

# Goal continuation waits

English | [中文](guide.zh.md)

## Change

Automatic goal rounds that finish without tools no longer immediately repeat. Empty polling of a running background job yields until new output or settlement. `update_goal` supports explicit input, job and timer waits. The goal stays active while waiting, and the existing round cap remains enforced.

Required `goal/wait` session events persist the deferral and its release. Readers that do not know this event refuse such logs instead of skipping continuation state. Existing logs remain readable, and session restore still leaves automatic continuation disarmed.

## Migration

1. Upgrade every process that reads or forks sessions before sharing newly written logs with it; keep older readers away from logs containing `goal/wait`.
2. To continue a text-only automatic round, send new input or use `/goal resume`. For periodic work, call `update_goal` with `action: "wait"`, a `wait_reason`, and `wake_after_seconds` or `job_id` instead of repeatedly reporting standby.
3. Confirm the goal strip displays waiting, that a matching event resumes one round, and that pause prevents later timer or job callbacks from continuing it. Jobs remain process-local; a restored wait cannot restart a missing job.

The [goal service reference](../../../../packages/goal/goal/README.md) defines durable wait and activation behavior.
