# Project inspect I/O contract

## Motion evidence extraction

`video_review_evidence.py <project> <source> --start <seconds> --end <seconds> --output <new-directory>` creates source-bound local evidence with Pillow and local FFmpeg/FFprobe, configurable through `--ffmpeg`, `--ffprobe`, `--fps` and `--timeout`. Source and output resolve inside the project; an existing output directory is refused. It checks the measured interval, preserves the original video, extracts a continuous clip retaining audio when present, and writes sampled frames, six-frame contact sheets and `evidence.json` with source and evidence SHA-256 values. Extraction fails if the source changes, a media process fails or times out, or no frames are sampled; partial outputs are not acceptance records. `review_status` remains `pending`. Sheet times are nominal sample-bin centers; continuous motion, sound, source requirements and reference images still require actual review. No network or generation request is made.

Input:

- Project root.
- Optional episode range.

Output:

- Status table by episode.
- Missing artifact list.
- Suggested next resume command/skill.

Acceptance:

- Existing good artifacts are preserved.
- Failed or missing artifacts are isolated clearly.

## Local evidence diagnostic

Run `python -B scripts/inspect_evidence.py <project>` from the loaded skill directory. The standard-library-only helper reads `transcript/jobs/*.json`, the referenced in-project source files, `transcript/raw/<stem>-v<version>.{txt,json,srt}`, and `qa/EP*-review.md`; it writes JSON to stdout only. Receipt `sourceSha256` identifies source media; `sha256` identifies extracted audio and cannot substitute for it. External paths require review and are not hashed automatically.

`review_for_active_sources` means a completed receipt matches its current source file, all three raw outputs are nonempty, and the JSON has structurally timed words. It does not verify selected-master lineage, utterance completeness, speaker identity, subtitle alignment, SRT validity or actual sound. Pending local snapshots and completed receipts missing outputs suggest `inspect_original_receipt`; this is a read-only recovery suggestion, never permission to upload or submit again. Malformed receipts remain individual diagnostic rows rather than preventing inspection of other evidence.

The latest level-two review section is checked for an explicit final-delivery claim and unfinished audio verification in the same paragraph or list item. Matches report `delivery_claim_with_unchecked_audio` with the excerpt. This limited text check does not read the video's images or sound and cannot establish acceptance from the absence of warnings. The helper's successful exit means inspection ran, not that the project passed QA; invalid project paths return a nonzero exit.
