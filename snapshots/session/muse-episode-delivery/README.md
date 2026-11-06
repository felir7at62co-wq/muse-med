---
description: "Keyless episode admission and publication through the shipped Headless profile with a controlled local renderer."
kind: "reference"
---

# Approved episode delivery

English | [中文](README.zh.md)

This authored scenario loads the production Jubian plugin through the ordinary Loader in the shipped Headless profile. The native executor calls the test-only `snapshot_episode_delivery` bridge, which invokes the actual episode service's readiness, admission and targeted status methods. The service comes from the production Settings-mode composition; the fixture does not replace it or add a production model tool.

A controlled local renderer holds completion behind a barrier. The scenario checks that admission returns while work remains pending, a repeated request retains the original attempt, and the published bytes match the selected candidate. The original generation ledger must remain unchanged. A private loopback endpoint records and refuses provider requests; the fixture checks the actual request list and PUT count. The tool result and `workspace.expected/episode-proof.json` record the observed outcome.

The renderer writes controlled bytes and supplies fixture media facts. This scenario does not run FFmpeg or establish media decoding, playback, listening, visual quality or Windows acceptance. Mutable project and ledger files stay under the ignored private `.dsh` workspace. `platform: posix` identifies the replay lane; actual media and authenticated Gateway checks have separate owners.
