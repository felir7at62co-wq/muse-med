# Agent Note: Episode-scoped Jubian hydration candidates

Status: implemented

English | [中文](2026-09-21-jubian-episode-hydration-candidates.zh.md)

## Problem

Jubian task lists can include an entire account despite a project query. Project 2708 has 101 video tasks without storyboard ids, but with episode ids. Hydrating every project task exceeds the 100-candidate safety limit even when the target episode has few tasks.

## Decision

Native submission and reconciliation exclude a task before hydration only when both the preview and task state valid positive episode ids that differ. Numeric strings and numbers identify the same episode. Missing or malformed ids remain candidates. Full paged snapshots, duplicate detection, the hydration limit, identity checks, and the one-PUT ledger remain unchanged.

## Alternatives considered

**Raise or remove the cap.** This increases unbounded read work without using available ownership evidence.

**Discard rows without matching episode ids.** Missing or malformed ids do not establish that a task belongs elsewhere; dropping them could hide an existing submission.

## Consequences

Other episodes do not consume the target episode's hydration allowance. More than 100 matching or unresolved candidates still fail closed. The native tests cover submission and replay across 101 other-episode tasks, single-PUT behavior, and refusal when 101 candidates have matching or unresolved ids. No transport or ledger format changes are required.
