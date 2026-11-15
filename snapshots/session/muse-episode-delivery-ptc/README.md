---
description: "Keyless episode admission and publication through the Headless profile's Node PTC executor."
kind: "reference"
---

# Approved episode delivery through PTC

English | [中文](README.zh.md)

This scenario runs the [approved episode delivery check](../muse-episode-delivery/README.md) through `run_code` and the real Node PTC runtime. It shares the native scenario's `episode-fixture.mjs` and production service composition, while retaining its own Session recording, tool-schema sidecar and expected workspace.

The nested test-only bridge checks the original attempt, pending work, exact publication and unchanged generation ledger. `workspace.expected/episode-proof.json` records the same stable outcome. The shared renderer remains controlled; successful PTC execution does not establish native encoding or media quality.
