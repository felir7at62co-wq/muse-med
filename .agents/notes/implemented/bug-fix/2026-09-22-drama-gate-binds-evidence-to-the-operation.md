# Agent Note: The drama gate binds evidence to the operation's own project

Status: implemented

English | [中文](2026-09-22-drama-gate-binds-evidence-to-the-operation.zh.md)

## Problem

The drama gate's two project rules — an official asset before a paid storyboard submission, and a fresh reconcile before creating a billed asset — looked for their evidence by scanning the workshop for any project root that qualified. In a workshop holding two projects, project A's `assets_manifest.json` or A's fresh `_probe/asset-reconcile.json` therefore authorized a paid call belonging to project B, and a call naming no project at all was judged against whichever project happened to carry evidence. The evidence did not mean what the refusal claimed it meant, and the refusal named every candidate root it had considered, so the model could not tell which project the gate had actually judged.

## Decision

`operationProject()` resolves the one project an operation belongs to, in order: a `projectRoot` injected through the plugin config, otherwise the call's own `project_dir`, otherwise the workshop child whose `project_config.json` declares the call's `script_id`. Both rules read evidence only below that project, and both refuse a paid call they cannot place, naming `project_dir` and `script_id` as the two ways to place it.

The resolution is removed from the rules, not from the arguments: `jubian_video.image_generate` already requires `script_id` in its own schema, and `jubian_storyboard` already accepts `project_dir` and `script_id`, so every refusal asks for an argument the caller can pass.

A session that states no working directory and a deployment that configures no fallback now refuse a paid project-bound call instead of allowing it, because with no root there is no directory to resolve `project_dir` against and none to search for `script_id`; the content rules keep allowing, since a `write` or `edit` the gate cannot classify has no artifact to judge.

## Alternatives considered

**Compare the reconcile report's own `script_id` with the project being written to.** The report carries that field, but its writer is `_tools/asset_reconcile.py` in the production project directory, not in this repository, so an identity check would refuse reports from a writer this gate cannot inspect. The package README records it as a limitation instead.

**Derive the project from the tool's own state — the storyboard's `scriptId`, the task row's project id.** Both need a network read, and the interceptor is deliberately synchronous and read-only, with no service dependencies; the binding has to come from the call.

**Allow an unbound call when exactly one project sits under the workshop.** It reads as convenient and is silently wrong the first time a second project appears, which is the case that motivated the change. The refusal costs one turn and teaches the binding.

**Keep the search and prefer the operation's project when it has evidence.** A preference order would still let a sibling's evidence decide the verdict, and the model would still not know which project was judged.

## Consequences

The allow side of each project rule now depends on the call carrying `project_dir` or a `script_id` that some `project_config.json` under the workshop declares; the gate's tests build that config into their fixture readers, so a case states both the project a call names and the evidence it must find there.

The rules again name exactly one project in a refusal, which is what lets a model distinguish "this project has no official asset" from "the gate could not place this call at all".

The residual limits are that the gate trusts the caller's own binding — a call naming project A while its `storyboard_id` belongs to project B is judged against A — and that it does not compare the reconcile report with its project. Both are recorded in the package README's limitations.
