---
description: "Keyless native video task discovery and original-key readback."
kind: "reference"
---

# Video task discovery through Native tools

English | [中文](README.zh.md)

The shipped Headless profile and Loader run the production Jubian tools through Native execution. The shared [offline fixture](../muse-video-task-discovery-native/task-discovery-fixture.mjs) returns an empty type-filtered list, an empty unfiltered provider list and a readable known task. Four actual logged results reach subsequent model requests; the original ledger files remain byte-for-byte unchanged, and every provider request is GET.

`project_complete` covers only the provider's unfiltered list for that response. It does not establish absence of historical tasks or authorize regeneration. `workspace.expected/task-discovery-proof.json` records the verified requests, known task, original key and zero paid writes. Authored model responses are controlled replay inputs. `writerOutput: true` retains canonical input independently of current writer output.
