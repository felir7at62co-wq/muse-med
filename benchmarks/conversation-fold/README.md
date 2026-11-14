---
description: "Required Node benchmarks for compact Chat history, live tool arguments, and Assistant text; streaming calibration and executable regression controls."
---

# Conversation fold benchmarks

English | [中文](README.zh.md)

## Summary

These benchmarks measure production Conversation assembly and the Chat builder under plain Node. They cover compact historical replies, preparing tool arguments, and a live 256 KiB Assistant block. Fresh workers exclude fixture preparation and explicit garbage collection from operation timing. Network transport, browser rendering, and model pacing are outside these measurements.

## Table of Contents

- [Run](#run)
- [Measurements](#measurements)
- [Hosted streaming calibration](#hosted-streaming-calibration)
- [Regression controls](#regression-controls)
- [Dev Note](#dev-note)

<a id="run"></a>
## Run

`pnpm run test:bench` builds the production libraries and private workers before running the serial performance inventory. After those artifacts exist, select this owner with `pnpm exec vitest run --config vitest.bench.config.ts benchmarks/conversation-fold --no-file-parallelism --maxWorkers=1`. The worker rejects TypeScript loaders and workspace imports that resolve outside built `lib` entries.

<a id="measurements"></a>
## Measurements

The historical case folds 200 replies containing 500,000 compacted text and reasoning deltas. Its 40 ms absolute limit and 3.125 scaling limit remain independent. Preparing-tool cases publish complete write or Bash previews. Live Assistant cases append 4,096 or 16,384 fragments, flush Chat once, and read every output character; retained heap includes the reachable Assembler and published result after GC, with the existing 20 MiB limit.

<a id="hosted-streaming-calibration"></a>
## Hosted streaming calibration

The streaming wall limits use fixed hosted expectations and the shared 1.25 variance headroom. They do not apply the shared 2× reference-machine factor again. All other time, memory, and ratio limits retain their existing calculations. This calibration changes acceptance limits; it does not change product assembly or establish a speedup.

| Fragments | Hosted expectation | Wall limit |
|---|---|---|
| 4,096 | 32 ms | 40 ms |
| 16,384 | 91 ms | 114 ms |

The saved five-sample sets in [the benchmark](conversation-fold.bench.client.ts) come from Node 24.22.2 Linux x64 jobs. Run 43370634776 used EPYC 9V45; runs 43385079062 and 43401713553 used EPYC 7763 with four available CPUs. Their relevant fold implementations are unchanged. The hosted expectations round up the largest median across both 7763 runs, retaining the slower run rather than selecting the nearest passing result.

| Workload | 43370634776 median | 43385079062 median | 43401713553 median |
|---|---|---|---|
| 4,096 ordinary text | 16.994 ms | 29.981 ms | 27.628 ms |
| 4,096 leading-whitespace reasoning | 18.558 ms | 31.806 ms | 29.371 ms |
| 16,384 ordinary text | 54.476 ms | 87.865 ms | 80.162 ms |
| 16,384 leading-whitespace reasoning | 55.000 ms | 90.825 ms | 80.645 ms |

The earlier 12/32 ms reference allowances come from macOS arm64 Node 26.8.2, not hosted calibration. The [performance policy](../../.agents/notes/implemented/testing/2026-09-04-session-open-performance-gate.md) requires same-workload sampling and budget review after a Node or runner change. Static common limits have less sensitivity to small regressions on faster runners; CPU-model matching and environment overrides do not select the verdict.

<a id="regression-controls"></a>
## Regression controls

Saved-sample controls exercise the same verdict as live measurements: the historical 30/80 ms limits reject the recorded failures, the hosted limits accept the saved medians, and each hosted limit plus 1 ms or a 50% slowdown from the slowest saved median is rejected.

The executable accumulated-trim control copies the freshly compiled private worker into an owned temporary directory. It replaces exactly one text and one reasoning visibility expression with the previous accumulated-block trimming calculation; missing or duplicate expressions reject the transformation. Production source and exports stay untouched. Original and control workers alternate in five fresh processes for each ordinary-text fragment count. Both must preserve complete text checksums and the heap limit; the original median must fit its hosted limit and the regression median must fail it. Logs retain both worker hashes, all samples, and the replacement count. Cleanup waits for child completion before removing the temporary worker.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Calibration validation status</summary>

The saved-sample review establishes the calibration proposal. Local execution verifies the two-expression transformation, equal complete-text checksums, and regression costs above both hosted limits; two positive endpoints still fail locally. Acceptance still requires the executable accumulated-trim controls on the actual CI Node and runner; local results cannot establish that hosted verdict.

</details>
