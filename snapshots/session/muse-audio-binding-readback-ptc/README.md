---
description: "Keyless PTC verification of audio binding, complete results and original-key readback recovery."
kind: "reference"
---

# Audio binding and readback through PTC

English | [中文](README.zh.md)

This sibling of the [Native scenario](../muse-audio-binding-readback-native/README.md) uses the shipped Node PTC runtime. Five `run_code` calls dispatch the actual `tools.jubian_storyboard` binding and print each complete result. The first program saves its actual preview result in the private workspace; subsequent apply programs read that result's path and fingerprint. The shared loopback provider and observer verify exactly one free save, independent successful/mismatched/failed readbacks, unchanged original-key ledger bytes, preserved card fields and all five results in later model requests. Logged PTC dispatches establish real execution. No external provider, media download, generation or listening occurs.
