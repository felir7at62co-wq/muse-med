---
kind: upgrade-guide
description: "Persistent Douyin browser downloads require an explicit Host workspace-binding capability."
---

# Persistent Douyin workspace binding and recovery

English | [中文](guide.zh.md)

## Change

Persistent Douyin downloads now require `douyinBrowser.supportsExpectedCwd === true` before native browser fallback. An older version 4 Host without this capability returns `DESKTOP_WORKSPACE_BINDING_UNAVAILABLE` before native I/O. Public downloads that succeed without browser fallback keep their existing behavior. Update the Host and plugin together; matching package versions alone do not establish the capability.

Registry recovery can reclaim a complete recorded owner only after verifying its identity and process exit while holding the recovery kernel lock. Anonymous legacy reclaim guards, incomplete owners and unknown ownership fields remain `DOUYIN_TASK_LOCKED`; upgrading does not infer ownership or automatically remove old files. Session data, registry schema version 1 and original Session/model/workspace bindings are retained.

## Migration

1. Install the matching Host and Douyin plugin before explicitly resuming a persistent task that needs browser fallback. The Host must advertise `supportsExpectedCwd:true`; successful native requests retain the accepted canonical directory. A blocked request does not authorize changing its workspace or restarting a download under another identity.
2. If a legacy registry remains `DOUYIN_TASK_LOCKED`, retain its files and request explicit owner inspection before migration. Do not remove a lock based only on age, timeout or an empty file. See the [plugin recovery limits](../../../../third_party/plugins/muse-douyin-download/README.md#persistent-downloads).
