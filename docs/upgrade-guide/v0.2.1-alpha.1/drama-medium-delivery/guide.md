---
kind: upgrade-guide
description: "Drama delivery follows explicit visual medium and prepared project canvas instead of adding the same ending and watermark to every project."
---

# Drama delivery by visual medium

English | [中文](guide.zh.md)

## Change

Projects can record `project_bible.visual_medium` independently of free-text `style`. `animation_3d` drafts and final renders stop at the body end and add no ending or watermark. `photorealistic` keeps the two-second ending and AI-content label. Missing legacy values retain marked output with a warning; invalid values and conflicting project/timeline choices fail. Source-media marks are not removed.

`drama_render prepare` saves the project's delivery width, height, frame rate and medium in `timeline.delivery`; draft and final render consume that snapshot. Existing exports and drafts are not rewritten. A saved non-default canvas now affects newly prepared delivery instead of falling back to the fixed portrait frame.

## Migration

1. Read the project with `drama_project`, confirm its intended delivery type and dimensions, and preview/update `visual_medium` using the exact returned revision and fingerprint. Do not classify a project from “realistic 3D” style text or aspect ratio.
2. Run `drama_render prepare` again after a medium or canvas change, then rebuild the affected draft and export. Remove an already-included ending from the selected body inputs before preparing a 3D delivery; the tools do not silently trim it.
3. For 3D, omit ending assets and verify the draft has no added ending/watermark tracks and the output duration equals the body. For photorealistic, retain the shipped ending assets and verify body plus two seconds. Keep subtitle and source-review checks.
