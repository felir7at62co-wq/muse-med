---
kind: package-reference
description: "Product-owned Muse Desktop Host configuration and agent preset defaults."
---

# Muse Desktop Host

English | [中文](README.zh.md)

The private Host supplies the Muse compositions used by the [Desktop application](../desktop/README.md). Its bundled preset files remain ordinary Cordis configuration. User-owned model providers and credentials stay separate from the Muse account catalog.

## Compaction defaults

The Host defaults and the `standard`, `ptc`, `cordis`, `short-drama`, and `editing` presets declare exact model policies for `muse-cloud-yunying/gpt-6-sol`, `muse-cloud-yunying/gpt-6-astra`, and `muse-cloud-yunying/gemini-3.1-pro`. Each policy reserves 16,384 tokens of additional compaction headroom and caps summary generation at 8,192 tokens. The conversation retains its provider-owned output budget. Other routes inherit the compaction backend defaults; `minimal` does not mount automatic compaction.

Each creative preset owns its isolated compaction backend, so its policy lives in that preset's `agent.cordis.yml` as well as the Host defaults overlay. Personal presets can set their own `modelPolicies` using the [compaction configuration](../../packages/compaction/compaction-basic/README.md#tuning-when-condensation-starts). The backend accounts for fixed request costs and avoids retrying unchanged failed selections or a lone checkpoint until its relevant input changes.
