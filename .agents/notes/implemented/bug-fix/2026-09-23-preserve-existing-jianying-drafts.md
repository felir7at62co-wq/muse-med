# Agent Note: Refuse collisions with existing Jianying drafts

Status: implemented

English | [中文](2026-09-23-preserve-existing-jianying-drafts.zh.md)

## Problem

The local draft generator deleted a same-named directory in the caller's draft root before asking pyJianYingDraft to create a replacement. That root can be the editor's real project directory, so a repeated candidate name could erase a person's editable work. A caller-provided name prefix also reached the output path without rejecting path separators.

## Decision

[`jianying_draft.py`](../../../../packages/drama/skills/skills/tweet-drama-draft-build/scripts/jianying_draft.py) rejects a same-named draft before calling the external writer and leaves the existing directory untouched. It rejects path separators, Windows-reserved characters and control characters in `name_prefix` before reading material inputs. The caller supplies a distinct prefix for another candidate. The existing project video-ban check still runs before a new draft is created; that independent rule remains owned by the [video-ban decision](../feature/2026-09-21-drama-video-bans.md).

## Alternatives considered

**Delete and recreate the matching draft.** This makes repeat runs appear successful at the cost of irreversible user edits; the external writer's later failure can leave no draft at all.

**Invent a suffix after finding a collision.** A new directory name alone does not associate the candidate MP4 with the new draft version. A caller must choose the candidate's distinct name until a coordinated render-and-draft operation owns both outputs.

## Consequences

An existing draft produces an explicit error rather than an overwritten file; distinct names can coexist. The guard does not prove a draft is in the installed editor's actual root, generate a version-bound MP4, or make the external library's create operation atomic against another process. The offline regression uses a temporary project and a writer stub, so opening a real draft in Jianying still requires a separate installation test.
