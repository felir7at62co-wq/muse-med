# Agent Note: Reversible bans for exact video versions

Status: implemented

English | [中文](2026-09-21-drama-video-bans.zh.md)

## Problem

A video can meet technical export specifications while containing a known content defect, such as reversed character roles. Recording that defect only in conversation leaves the same file available for later preparation, cached rendering or drafts. An operator needs to exclude that version immediately without first producing review images or deleting the file.

## Decision

`drama_video` belongs to the existing episode-render tool package and exposes `ban`, `unban`, `list` and `inspect`. A ban requires a readable local video and nonempty labels; a reason is optional and review evidence is not required. The tool hashes the bytes itself and records the latest reversible decision in the project's version-1 `video-bans.json`. Shared file locking and atomic writing protect updates; malformed or unsupported records are errors, not an empty ban list.

SHA-256 identifies the excluded version, not its filename, shot number or remote task. Identical-byte copies share the ban within that project. Regenerated content with a different hash is not automatically banned. Unbanning retains the recorded labels and reason but grants no review approval: the [review-evidence decision](2026-09-21-drama-policy-and-result-evidence.md) remains independent.

Native preparation and rendering check actual selected media, including cache reuse. The local production Python render, draft and state paths consume the same format through a shared read-only helper. Verification reports direct output matches and risk from currently selected banned inputs without deleting the output; current inputs cannot establish which sources an older export actually used.

## Alternatives considered

**Require review evidence before banning.** This delays a user's explicit exclusion decision. Evidence remains necessary for approval where the production workflow requires it, not for declining to use a version.

**Delete the file or ban its path or task.** Deletion is unnecessarily destructive, path bans miss copies, and task-wide bans can exclude a corrected result. Exact bytes provide reversible version-level scope.

**Track every derivative or intercept every FFmpeg call.** Arbitrary transcodes cannot be attributed reliably from a hash. A new global interception or receipt system exceeds this project-local decision.

## Consequences

Bans prevent reuse through the integrated production paths without replacing content review or changing remote provider state. Generic FFmpeg commands, other projects and unknown transformed derivatives remain outside enforcement. Hashing adds local I/O; a different hash means only that this ban does not match, not that the video is acceptable.

Required regressions cover identical-byte copies, different-byte regeneration, unban without approval, corrupt records, concurrent updates, cached inputs and non-destructive verification. Source changes do not activate a new static tool in an already running Host; deployment and actual project tagging are separate operations.
