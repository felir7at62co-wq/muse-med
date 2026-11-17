---
kind: upgrade-guide
description: "Muse initializes new video choices on the Huanchang channel instead of Fangzhou."
---

# Muse video channel default

English | [中文](guide.zh.md)

## Change

Muse's Desktop profile changes `defaultVideoModel` from `doubao-seedance-2-5-260628` on `FANG_ZHOU` to `doubao-seedance-2.5` on `FZ_HUAN_CHANG`, retaining 480p. This affects conversations without a saved video choice. Explicit choices, project defaults and submitted tasks retain their identities.

The live account catalogue must contain the new combination. An unavailable default reports an error; Muse does not silently select another channel.

## Migration

1. Update Muse and sign in to Jubian. Custom Desktop overlays that set `defaultVideoModel` retain their own configuration; change that field explicitly if the same default is wanted.
2. For an existing conversation using Fangzhou, open the video-model menu and select Seedance 2.5 under `FZ_HUAN_CHANG`. Select 480p or 720p as required. This choice affects future generation, not submitted tasks.
3. Read the conversation's video settings and confirm the channel, model and resolution. A catalogue read does not establish successful generation. Verify pricing and a completed task separately before reporting delivery readiness.
