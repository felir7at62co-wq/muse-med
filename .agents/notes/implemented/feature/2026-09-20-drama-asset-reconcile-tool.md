# Agent Note: The pre-spend asset reconciliation as a tool

Status: implemented

English | [中文](2026-09-20-drama-asset-reconcile-tool.zh.md)

## Problem

The gate that refuses a paid asset creation already existed: `reconcileFirst` in `packages/guard/drama-gate` reads `_probe/asset-reconcile.json` and refuses `jubian_video` `image_generate` unless that evidence is fresh, ready, and fully disposed. What produced the evidence was a Python script in the production workspace, `_tools/asset_reconcile.py`, run by a skill's instructions with `python _tools/asset_reconcile.py`. Two things follow from that. A user's machine needs Python and the workspace for the check to be possible at all, which is the wrong prerequisite for a product that ships as a Node application; and the comparison the gate depends on lives in a file this repository does not own, so its rules cannot be reviewed, tested, or changed here.

The evidence file's format is a real contract rather than an output. Two other programs read it: the workspace's own `_tools/asset_reconcile_report.py` and the gate above. A port that renames a field, changes a type, or shifts a meaning breaks a check whose whole job is to stop a silent failure — the failure that cost 1.17 CNY when a manifest-shaped inventory missed an asset the remote project already held.

## Decision

A third `drama/` package, `@deepseek-ai/dsh-tool-drama-assets`, registers one model-facing tool, `drama_assets`, with two methods.

`reconcile` reads both sides — the remote project's `/aigc/asset/list` and `/aigc/material/list` through the shared Jubian transport, and the project's own `assets_manifest.json` — and writes `<project_dir>/_probe/asset-reconcile.json` through a temporary file and a rename. The three judgements are the pipeline's own and are ported field for field: a remote asset exists when its row carries `delFlag == "0"`; it is in use when a material row carried `isUsed == 1` and `hsAssetStatus == "Active"`; and an asset that is used but whose row is removed is not an asset, so only alive rows are compared. `unregistered` is the used assets the manifest does not record, `dangling` is the manifest records the remote project does not hold, `matched` is the rest. The disposition map is carried over from the previous evidence, one `pending` entry is added per unregistered asset, and every asset the manifest now records becomes `registered` while keeping its note. `blocking` and `ignored_without_note` are recomputed from the dispositions, `ready` is their conjunction, `ran_at` is ISO seconds with the `+08:00` offset the pipeline's own report writes, and `policy` carries the same five values the gate prices.

`dispose` records one person's decision about one asset — `registered`, or `ignored` with a non-empty reason — and recomputes the three verdict fields. It sends nothing: the comparison was made when the evidence was written, and re-running it would spend a network round trip on a decision a person already made.

The tool never calls a Jubian write method, never buys anything, and writes exactly one file. The token is the credential reference `JUBIANAI_ADMIN_TOKEN`, resolved through the credential store on every read with the same workspace-secret fallback `packages/jubian/tool-jubian` already uses, so this package adds no third token resolver.

Two details are deliberate. The evidence file keeps the pipeline's own spelling, where an absent provider field is JSON `null`; the tool result spells the same fact as an empty string or `0`, because the parameter DSL has no nullable scalar, and `0` is never a category the provider issues. And `readAssetList` / `readMaterialList` remain the authority on what a page is, while this package reads `delFlag`, `createTime` and the two name spellings from the rows those readers accepted — the mappings do not carry them and the evidence schema needs them.

The result reports `ready` from the dispositions alone, exactly as `evidence_state()` does, and adds the `next` sentence the disposition state implies. The gate's extra requirement — a fresh `ran_at` — is not folded into `ready`, because a `dispose` on a project that holds no evidence writes a file that is honestly not usable, and the gate already refuses it.

## Alternatives considered

**Keep the Python script and wrap it.** A tool that spawned `python _tools/asset_reconcile.py` would have kept one implementation and shipped immediately. It would also have kept the product's Python prerequisite, left the comparison's rules in a file this repository does not own, and made the evidence format something one script happens to emit rather than something two readers depend on.

**Read the remote project from the gate.** The gate reads files; it does not make network calls. Giving it the token and a second implementation of the comparison would put a credentialed, network-bound operation on the dispatch path of every `image_generate`, which is the work the evidence file exists to keep out of dispatch.

**Have the tool run the comparison for `dispose` too.** Re-running `reconcile` on every disposition would make each decision a fresh remote read. It would also make a disposition fail when the network is down, for a decision that needs no remote fact — and it would rewrite `ran_at`, making a stale report look fresh without anyone re-examining the project.

**Make the evidence fields nullable so the file and the result could be one type.** The parameter DSL has no nullable scalar, and the two spellings already differ: the file is read by two programs whose contract is the Python tool's output, while the result is read by a model. Spelling the same fact twice at one seam is cheaper than a schema neither reader can parse.

**Write `ready_reason` into the file.** The Python tool writes it after the verdict, and it is derived from fields the file already carries. This package returns the same sentence in the tool result and leaves the file with the four fields the gate actually reads, so the file cannot disagree with itself about why it is not ready.

## Consequences

The comparison now has one executable home inside this repository, with unit tests over the verdict rules and the evidence document. A user's machine needs Node and not Python, and the format the gate depends on is pinned by tests in the same tree as the gate.

The cost is a second implementation during the transition, and a format with two authorities. `_tools/asset_reconcile.py` stays the production workspace's own tool until sessions move over; it remains the reference for the file's byte layout, and the Dev Note in the package README names the one field this port does not write. A change to the format on either side has to be followed on the other, which is the same obligation the `reconcileFirst` gate already carried.

Three limits are deliberate and recorded in the package README: `dispose` does not re-compare, so an asset that became used after the last `reconcile` is not in the evidence it edits; a `dispose` on a project with no evidence produces a file the gate refuses; and a manifest row whose `jubian_asset_id` is a string rather than an integer is invisible to both lists, because the Python reference counts integer ids only.

The package holds no state between calls and publishes no invariant companion: every answer is a function of the files it reads and the two remote lists, with no independently changing observation to check.

## Testing

`packages/drama/tool-drama-assets/tests/` covers the comparison, the evidence document, and the registered tool. `reconcile.spec.ts` pins each verdict separately: both sides agreeing, a used asset the manifest misses, a removed asset staying off both lists, a material that is not both used and `Active`, the material row answering before the asset row, `null` for every field neither row carries, either name spelling, a dangling record with no stable id or name, ascending id order, disposition inheritance including the automatic `registered`, an ignored disposition with no note, page following and the declared-total stop, and each manifest and evidence parse failure. `disposeAsset` is pinned for both statuses, the blank-note refusal, the unknown status, the unusable id, the project with no evidence, and the fields it leaves alone. `tool.spec.ts` mounts the plugin, checks the parameter names against the interface's own, drives the registered executor end to end against a substituted transport, and validates both result shapes against the tool's own declared schema. `npx vitest run packages/drama/tool-drama-assets --coverage` reports per-file 100% statements, branches, functions, and lines across the five source modules.
