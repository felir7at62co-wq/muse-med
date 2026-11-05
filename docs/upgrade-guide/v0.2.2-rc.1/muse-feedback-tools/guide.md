---
kind: upgrade-guide
description: "Explicit Muse account injection lists must include the Session store required by feedback target validation."
---

# Update Muse feedback tool configuration

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-muse-account` now requires `sessions` alongside `tools`, `llm`, `sessionProjections` and `agentDefaultModel`. A custom `cordis.yml` or patch row with an explicit `inject` list that omits `sessions` must be updated before the account plugin can activate. Rows that use the package's declared injections inherit the requirement automatically; their profile must still provide the Session store.

The optional `feedbackTools` setting defaults to `false`; Muse Desktop sets it to `true`. It registers `muse_feedback_submit` and `muse_feedback_status` for explicit user feedback and owner-scoped receipt queries. The existing feedback Remote method and dialog submissions remain compatible.

## Migration

1. In each custom account row's `inject` list, add `sessions` while retaining the existing services. Keep the profile's Session store provider enabled. The shipped Desktop composition already includes this configuration.
2. To expose feedback tools in a custom profile, set `config.feedbackTools: true` on its account row. Keep the existing `baseUrl`, account storage and other settings. Inspect the resolved profile with `dsh --profile <profile> --dump-config` and confirm the account row includes `sessions` and the intended tool setting.
3. Start the Host through `dsh --profile <profile>`. Confirm the account plugin activates, account sign-in and model selection still work, and enabled tool discovery includes both feedback tools. This startup check does not require submitting a real opinion.
4. Deploy the matching feedback gateway to obtain `requestId` duplicate protection. A matching legacy-gateway receipt still confirms that feedback was saved, but the tool reports `deduplication: unavailable`; query that receipt instead of resubmitting. An uncertain outcome must not be retried with a new submission key. See the [account package](../../../../packages/host/muse-account/README.md) for submission and status behavior.
