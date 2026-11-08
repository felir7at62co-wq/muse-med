---
description: "Keyless original-episode discovery and offline receipt repair through the Headless profile's Node PTC executor."
kind: "reference"
---

# Original episode history through PTC

English | [中文](README.zh.md)

This scenario runs the [original episode history check](../muse-episode-history/README.md) through `run_code` and the real Node PTC runtime. It shares the native scenario's `history-fixture.mjs` and production composition, while retaining its own canonical Session, tool-schema sidecar and expected workspace.

The nested test-only bridge explicitly selects the original history entry after the Jubian scope restarts with its source and receipt removed. It checks offline repair, preserved output device and inode, one renderer call and an unchanged generation ledger with zero provider requests. `workspace.expected/episode-history-proof.json` records the outcome. The renderer remains controlled; PTC execution does not establish native encoding, Host-process restart or media quality.
