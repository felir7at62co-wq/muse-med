# Cloud transcript subtitles

Use completed cloud recognition for the selected source video. Correct display text against the script and audible performance while retaining measured timing. Keep receipts and raw recognition JSON unchanged; save corrections in derived lines, alignment and SRT files.

## Reuse and source identity

For each shot, reuse the existing `audio_transcribe` receipt whose source path and SHA-256 match the selected video. Continue an unfinished job with its original receipt. Start recognition only when usable evidence is missing and the existing authorization covers the cost; do not submit another job just to correct spelling. A receipt without usable timing is not aligned evidence.

`align_subtitles.py` reads a completed or silent `jobs/<stem>-vN.json` receipt and the corresponding `raw/<stem>-vN.json` segments. Words use `text`, `start` and `end` in seconds. Record one receipt per shot:

```json
{"shots":[{"shot":1,"receipt":"<absolute original receipt path>"}]}
```

Use explicit paths when the project uses zero-padded names such as `ep02`; do not assume the script's default filename matches an existing project. Supply a source list `{"shots":[{"shot":1,"video":"media/ep02/p1.mp4"}]}` and display lines `{"shots":[{"shot":1,"lines":["Corrected spoken text"]}]}`:

```sh
python -B <skill-directory>/scripts/align_subtitles.py --project <project> --episode 2 --shots <sources.json> --lines <corrected-lines.json> --cloud-transcripts <receipts.json> --out <derived-alignment.json>
```

Pass these same source, lines and alignment files to `drama_render` with `method: "subtitles"`, `project`, `episode`, `shots`, `lines`, `alignment` and `subtitleSrt`. The subtitle tool places supplied measurements; it does not recognize speech or verify that a correction is audible.

## Corrections and measured spans

Use the script to resolve recognition errors such as names or homophones, not to substitute words that the video never spoke. Verify actual omissions, changed words, repetitions and extra speech against the source audio. Keep unresolved differences visible without modifying the formal script.

For a verified spelling correction, add `--corrections <corrections.json>` to the cloud-reuse command. Bind each correction to the actual source video and original raw-transcript bytes:

```json
{"shots":[{"shot":1,"source_sha256":"<video SHA-256>","transcript_sha256":"<raw JSON SHA-256>","corrections":[{"word_index":0,"original":"城","replacement":"程","reason":"Verified the character name against the script and source audio"}]}]}
```

`word_index` is zero-based across raw `segments[].words` in order, including punctuation words. `original` must exactly match that raw word; normalized replacement text must be nonempty and the same length. This explicit spelling interface cannot add or remove speech. The output's `correction_evidence` records original/replacement text, unchanged word times, hashes and reasons with `listening_verified: false`. Stale identities retain a missing-evidence finding; malformed or duplicate mappings fail. Neither outcome authorizes a new paid request or changing raw evidence.

Changing the display spelling does not move its measured start or end. Split a sentence only at available word boundaries; an interpolated character position inside a multi-character word is not a measured word boundary. If only a sentence span is available, keep it together or review the missing split timing rather than evenly dividing the sentence.

The existing aligner finds matching characters. An unrecognized first or last word can shorten the matched span even when the sentence otherwise matches. Compare derived anchors with the original cloud word times and the source audio before accepting the corrected line. Preserve verified start/end values in the derived alignment; do not edit raw JSON to make a comparison pass. Estimated or partially matched output remains a candidate, not verified timing.

Map shot-local measurements through the actual source in-point, destination offset and any explicitly selected speed. Reuse a final SRT only when those selections still agree. After a source change, recover matching evidence for that source; after an edit change, update affected placements without rerunning unchanged recognition. Final text matching alone does not establish audiovisual synchronization.
