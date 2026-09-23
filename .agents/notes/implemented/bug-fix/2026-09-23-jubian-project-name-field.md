# Agent Note: Read Jubian project names from scriptName

Status: implemented

English | [中文](2026-09-23-jubian-project-name-field.zh.md)

## Problem

The provider's `GET /aigc/script/2708` returns `scriptName: "山海自有相逢处"` and no top-level `name`. The project reader looked only at `name`, so `jubian_catalog script` reported `name: null` for a project with a title. A separate `GET /aigc/storyboard/1611753` returns `scriptName: null` in its own snapshot, even though the original storyboard creation body included the title.

## Decision

`readScript()` projects nonempty project `scriptName` into its existing `name` result, with `name` as a fallback for older payloads. It leaves an absent or empty title as `null`. `readStoryboard()` continues to expose the storyboard snapshot unchanged; project reads never rewrite remote storyboard data.

## Alternatives considered

**Replace a storyboard snapshot's null name with the project title.** This would misrepresent what the provider stored and could turn a later snapshot-based PUT into an unverified remote write.

**Save or recreate existing storyboards to populate the field.** The provider already returned a null storyboard field after accepting a create body with `scriptName`; no evidence establishes that another write would persist it. The project-name read requires no write.

## Consequences

Catalogue reads now report the actual project title through the existing result field without a new public diagnostic method or additional HTTP request. Existing storyboard snapshots may still show `scriptName: null`; callers must not interpret the catalogue fix as a remote storyboard repair. Parser and tool tests cover the project response and legacy fallback.
