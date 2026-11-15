---
description: "Keyless original-key recovery through the shipped Headless profile and real media decoding."
kind: "reference"
---

# Original-key video recovery through PTC

English | [中文](README.zh.md)

This authored scenario loads the production Jubian plugin through the real Loader and uses a private loopback provider. The only POST is the existing read-only child-list endpoint; generation PUTs, new intents and real accounts are forbidden. The original preview and intent are fixture inputs. The production recovery worker reconciles the original key, captures provider media and decodes both tracks through the actual subprocess provider.

The model invokes `run_code` with the real Node PTC runtime and nested `jubian_storyboard(method="reconcile_video")`. The fixture then performs explicit operator approval and direct MP4 delivery, deletes the managed original and verifies offline replay, missing-receipt repair, unchanged output bytes and preserved inode. Mutable media lives under the ignored private `.dsh` test root; `workspace.expected/recovery-proof.json` records stable observed outcomes.

The decoder resolves from `MUSE_RECOVERY_TEST_FFMPEG`, then `DSH_FFMPEG_PATH`, then `ffmpeg` on PATH. Set the first variable to the reviewed Desktop bundled binary for artifact acceptance. Missing resources fail; they do not silently skip or substitute a mock. The Linux snapshot CI lane installs FFmpeg. `platform: posix` matches that subprocess acceptance lane; it does not claim Windows validation.

The committed Session remains the replay input. `writer.expected.jsonl` records the current writer separately; refreshing its headers and tool descriptions preserves the original recovery events.
