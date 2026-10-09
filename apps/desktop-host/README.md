---
kind: package-reference
description: "Product-owned Muse Desktop Host configuration and agent preset defaults."
---

# Muse Desktop Host

English | [中文](README.zh.md)

The private Host supplies the Muse compositions used by the [Desktop application](../desktop/README.md). Its bundled preset files remain ordinary Cordis configuration. User-owned model providers and credentials stay separate from the Muse account catalog.

The Desktop account composition excludes the standalone Gemini provider `aa` through [`excludedProviderIds`](../../packages/host/muse-account/README.md#minimal-configuration). The account picker retains Yunying's `gemini-3.1-pro` and its other supplied models, plus official DeepSeek. Saved standalone Gemini selections require choosing an available model before another request; [the migration guide](../../docs/upgrade-guide/v0.2.1-alpha.1/muse-gemini-provider/guide.md) describes that step.

The Desktop account composition sets `requestTimeoutMs` to 60,000 milliseconds for gateway and knowledge-base requests, including project portfolio scans. Personal overlays can change this validated account setting; the underlying plugin's default remains 15,000 milliseconds. A timeout still reports an unavailable service and does not establish whether a remote write completed.

## Compaction defaults

The Host defaults and the `standard`, `ptc`, `cordis`, `short-drama`, and `editing` presets declare exact policies for all eight account models in the [selected catalog](../../services/muse-accounts/README.md#selected-model-budgets). Each policy reserves 16,384 tokens of additional compaction headroom and caps summaries at 8,192 tokens; conversation output keeps its provider budget. Other routes inherit backend defaults; `minimal` does not mount automatic compaction.

Each creative preset owns its isolated compaction backend, so its policy lives in that preset's `agent.cordis.yml` as well as the Host defaults overlay. Personal presets can set their own `modelPolicies` using the [compaction configuration](../../packages/compaction/compaction-basic/README.md#tuning-when-condensation-starts). The backend accounts for fixed request costs and avoids retrying unchanged failed selections or a lone checkpoint until its relevant input changes.

<a id="video-screenplay-delivery"></a>
## Video screenplay delivery

The editing and short-drama routes require visual preparation, independent episode review and sequential acceptance through [screenplay-project](../../packages/drama/screenplay-project/README.md). A managed video project uses `workflow: video_to_screenplay` and `qa/screenplay-project.json`; its formal files go under the sibling `final/` directory. Scene-file chunks and saved coverage support recovery without relying on a compressed conversation summary.

`screenplay_export_docx` verifies each managed input against the current accepted Markdown before conversion, pins those contents, and saves a `.docx.screenplay.json` record binding the candidate and output digests. Its optional `project` argument retains that binding for exports elsewhere and refuses a missing or unmarked explicit project. The Office composition also registers an actual `present` executor check: managed Markdown must match acceptance, and Word needs a matching record plus an independent body comparison against the current accepted text using the bundled Python runtime. Project paths in that record are compared after resolving filesystem aliases. Replacing the body or adding text in a table fails even with a forged matching record. Generic Python or Office outputs without acceptance cannot be declared formal managed video deliverables. Ordinary documents and projects without the video marker retain existing conversion and delivery behavior.

The default scope requires the conventional marker and directory; an unmarked project or relocated document without a record cannot be identified as video conversion. Filesystem access can edit project and verification files, which are consistency records rather than signed authorization. Direct file links and external applications do not call `present`. Independent review remains responsible for visual completeness and meaning beyond the prepared fact inventory; this check does not establish that sampling found every event.
