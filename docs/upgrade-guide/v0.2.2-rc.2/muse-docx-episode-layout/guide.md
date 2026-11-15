---
kind: upgrade-guide
description: "Muse screenplay Word exports no longer start each episode on a new page by default."
---

# Muse Word episodes run on continuously

English | [中文](guide.zh.md)

## Change

`screenplay_export_docx` used to put a page break before every episode heading after the first. It now defaults to `episode_layout: continuous`: episodes follow each other and headings still stay with the next paragraph. Readers of new Word files see fewer blank pages; files already exported are unchanged.

The `screenplay-docx` plugin option `episodeLayout` and the `desktop-office` plugin option `docxEpisodeLayout` (`continuous` or `page_per_episode`) select the deployment default, and the tool's optional `episode_layout` argument overrides it for one export. Other values are rejected.

## Migration

1. To keep one episode per page, pass `episode_layout: page_per_episode` per export, or set `episodeLayout: page_per_episode` on the `screenplay-docx` entry (`docxEpisodeLayout` on `desktop-office`) in a deployment's plugin composition.
2. Re-export existing deliverables with a new output path; the exporter never overwrites a file.
3. Confirm by opening the new DOCX: episode headings sit on a new page only with `page_per_episode`.
