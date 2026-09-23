# Agent Note: Missing Jubian budget refuses paid writes

Status: implemented

English | [中文](2026-09-23-jubian-missing-budget-denies-paid-write.zh.md)

## Problem

A fresh installation has no `<ledger>/authorization.json`. The budget checker previously labelled a paid request `unauthorized` but allowed the shared writer to record an intent and send it. A teammate could incur a charge before configuring a project ceiling.

## Decision

`checkBudget` returns `refused` when neither a project authorization file nor the composed drama series setting supplies a ceiling. When the drama namespace is composed, its default supplies an automatic per-`script_id` CNY cap even without a settings file; an existing authorization entry can only lower it, and an existing file without the requested project still refuses. The shared `writeUnderLedger` path rejects a refusal before recording an intent or sending the provider request; non-spending writes remain available. A call without a usable quote or operator estimate also refuses. The [drama production decision](../feature/2026-09-21-drama-policy-and-result-evidence.md) describes the separate operator preset policy, not an executor-level grant.

An `unknown` provider outcome does not establish that no charge occurred. Every paid record without a usable quote blocks its own project's next paid claim; a paid record without project attribution blocks all projects sharing that ledger. Known projects remain isolated. These checks read existing ledger fields and require neither a format change nor migration.

## Alternatives considered

**Warn and send when no file exists.** The first request can already charge money; disclosing an unprotected result after submission is too late for a new user.

**Treat the writable file as human consent.** An agent with filesystem write access can edit it. The ceiling limits accidental repeat spending but cannot authenticate a teammate's decision; a shared multi-user deployment claiming owner-specific consent needs a separately authenticated principal.

## Consequences

A new user can perform free reads and writes. When the drama settings section is composed, its default budget permits quoted paid calls per project without a separate click; without that section or a manual ceiling, paid calls refuse. This breaks previous uncapped paid use. The editable documents are not a security boundary. The shared writer reserves an accepted quote or estimate under the same-process ledger queue, but another process does not share that lock; this change alone does not qualify the teammate installer for paid operations. Unit and shared-writer tests assert that an unbudgeted call refuses before the first provider send and leaves no ledger record.
