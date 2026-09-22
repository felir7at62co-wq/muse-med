# Agent Note: Jubian model intent and free scoped settings

Status: implemented

English | [中文](2026-09-21-jubian-model-intent-and-scoped-settings.zh.md)

## Problem

A fixed Seedance 2.0/720p selector rejects storyboards configured in the provider console for Seedance 2.5/480p and can substitute a model the operator did not choose. Cached selector IDs also differ from the current account catalogue. Changing many storyboard settings through caller-composed bodies risks altering subject identities or triggering generation.

## Decision

The live storyboard supplies model, platform when specified, generation type, ratio, resolution and duration intent. The live video catalogue supplies selector IDs. Preparation requires one exact match, rejects ambiguity and unknown duration capabilities, and keeps the single-generation, ordered subject-identity, project, fingerprint and single-PUT checks. The exact-ID duration table retains the existing 2.0 bound and records the operator-confirmed 2.5 bound of 30 seconds; that bound is not represented as provider-verified or generalized to other models. No undocumented catalogue duration fields are interpreted.

`jubian_model` separates a read-only remote preview from free application. The frozen local plan names exact existing storyboards selected individually, by remote episode IDs, or across one project. Application checks project binding, plan fingerprint, live membership, settings and preserved non-model data before writes, then rereads each target immediately before its PUT. Every PUT forces `isGenerate=0`. Readback checks settings and preserved fields, including ordered assets; the [stored isGenerate decision](../bug-fix/2026-09-19-jubian-storyboard-isgenerate-not-a-gate.md) remains independently applicable. Existing videos and project defaults are untouched.

The ledger records the whole operation and individual target attempts. A partial or uncertain result stops further writes; replay requires the recorded method and batch request identity to match, reconciles recorded targets, and never resumes a partially applied plan. Same-runtime claims sharing a resolved ledger root are serialized, including separate ledger instances, and record identities share one process-wide suffix. This does not create cross-process transactions or remote compare-and-swap support.

A subtitle-erasure stage marker is not success evidence. The reader requires a successful erasure record identifying an available current file; a different URL alone also does not mean upscale, because erasure changes URLs. These metadata checks do not replace visual subtitle review or repair previously selected render inputs.

## Alternatives considered

**Keep a fixed model and resolution.** This contradicts the operator's saved intent and makes an otherwise supported provider setting unusable.

**Choose the first matching catalogue row or accept unknown duration limits.** Platform ambiguity can change the intended generation route, while an invented duration limit can submit an unsupported paid request.

**Apply settings and generate together.** Inspecting a batch configuration must not buy videos. Generation retains its separate prepared submission and reconciliation path.

**Retry or roll back a failed batch automatically.** An uncertain response may already have changed the target; rollback could overwrite intervening operator changes. Per-target outcomes and explicit reconciliation retain that uncertainty instead.

## Consequences

The tool exposes exact before/after settings and rejects stale previews, but requires another preview after legitimate intervening changes. Unsupported models need evidenced duration capabilities before preparation or settings application can accept them. The provider offers no transaction spanning a project, so a batch may be partially applied and is not advertised as atomic.

Focused API tests cover exact model/spec selection, refreshed IDs, ambiguity, 2.5 at 30 seconds and rejection above it. Tool tests cover free PUTs, project binding, target drift, preserved asset order, timeout, replay and concurrent same-runtime calls; a Loader test pins model-visible output and disposal. Existing paid submission tests retain identity and single-send coverage. No paid provider request is part of these checks.
