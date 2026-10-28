---
kind: upgrade-guide
description: "Muse preserves custom skill directories and saved imports independently of current-session discovery."
---

# Muse user skill retention

English | [中文](guide.zh.md)

## Change

Muse discovers skills in the current project's `.muse/skills`, `.dsh/skills` and `.agents/skills` while continuing to exclude unconfigured shared user directories. Desktop startup preserves explicitly configured `customSkillDirs`. Creation mode includes user, project and explicit custom skills alongside its approved built-in catalog. Valid imports remain saved even when discovery is pending or the current session does not expose them; the panel reports the saved state separately from availability.

## Migration

1. Keep existing `<Muse home>/skills` and project skill directories during the application upgrade. No directory is cleared or automatically moved by this change.
2. For an additional existing skill directory, keep its path in `skill-filesystem.config.customSkillDirs`; Desktop retains the configured entries. Shared user roots remain opt-in.
3. For a custom provider composition, use `includeDefaultRoots: false` and `includeProjectRoots: true` to discover only project roots plus explicitly configured locations. Omitting the new setting retains the previous provider behavior.
4. Confirm an imported skill's saved location in the panel. If discovery is still pending, reopen the relevant project or session and inspect the availability notice; preserve the saved files.
5. A previously rolled-back import has no retained payload to migrate. Reimport the original source if available; do not overwrite surviving user files with bundled copies.
