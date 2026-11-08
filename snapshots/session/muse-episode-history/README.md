---
description: "Keyless discovery and offline receipt recovery of an original episode through the shipped Headless profile."
kind: "reference"
---

# Original episode history and recovery

English | [中文](README.zh.md)

This authored scenario loads the production Jubian Settings composition through the ordinary Loader in the shipped Headless profile. The native executor calls the test-only `snapshot_episode_history` bridge. A controlled local renderer publishes one episode; the fixture then removes its source and delivery receipt, disposes the entire Jubian plugin scope and mounts a fresh production scope in the same process.

The new service discovers the original attempt and digest through bounded history without readiness or active-work fencing. The bridge explicitly selects that entry, reads current status and resumes the original task to repair its receipt offline. Assertions retain the output device and inode, one renderer call, the original generation ledger and zero provider requests. The tool result and `workspace.expected/episode-history-proof.json` record these facts.

The controlled renderer supplies fixture bytes and media facts. This scenario does not run FFmpeg or prove Host-process restart, media decoding, playback, listening, visual quality or Windows acceptance. The service unit owner separately destroys the entire Context and checks discovery from a new Context without a renderer. Mutable project files remain under the ignored private `.dsh` workspace; the canonical Session belongs only to this scenario.
