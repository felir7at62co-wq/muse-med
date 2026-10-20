---
kind: upgrade-guide
description: Subtitle quality findings no longer reject rendering or fail the legacy strict alignment command.
---

# Subtitle alignment uses advisory results

English | [中文](guide.zh.md)

## Change

Muse returns alignment, subtitle readability and optional draft-track findings as advice. The bundled `align_subtitles.py --strict` accepts the existing flag but no longer exits unsuccessfully for those findings. Invalid input files, unusable timestamps, write errors and existing paid-operation checks still fail. `drama_render subtitles` writes a separate `.draft.srt` when findings remain, preserves the selected original SRT and records `.review.txt`; legacy `.blocked` files become warnings. Prepared material directories are preserved and a new candidate directory may be returned. Saving a draft or `ok: true` does not establish creative acceptance.

## Migration

1. Read the complete alignment report and `drama_render` warnings instead of using the `--strict` exit code as a quality decision. Inspect the returned `written` paths before selecting a subtitle candidate.
2. Use the actual path returned by `DraftGenerator.prepare_materials`, then inspect `muse-review.json` and the draft's actual editable tracks. Do not infer that optional subtitles or BGM were imported from save success alone.
3. Confirm that a fixture with missing alignment or long text returns advice and a readable candidate while preserving existing source and subtitle bytes. Retain technical error handling; do not add an approval requirement or demand empty warnings.
