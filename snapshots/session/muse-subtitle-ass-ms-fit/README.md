---
description: "Keyless Loader coverage of literal ASS breaks, preserved source times and the following model request."
kind: "reference"
---

# Subtitle display and source times

English | [中文](README.zh.md)

This authored scenario loads the production `drama_render` tool through the ordinary Loader and shipped Headless profile. Its `prepare` call reads the selected source SRT and existing source-bound recognition files, creates the display SRT and returns a verified summary to the next model request.

Assertions check that literal `\N` and `\n` become spaces in the generated display, cue endpoints remain 1.000–1.700 seconds, and the original SRT, media, receipt and word-time bytes remain unchanged. `workspace.expected/subtitle-ass-ms-proof.json` records these facts only after the actual following request contains the successful tool result. The private project lives under the ignored `.dsh` workspace; the canonical Session and prompt/schema sidecars belong to this scenario.

External media probing and audio assembly are controlled fixture inputs. This scenario does not measure glyphs, encode video, recognize speech or establish listening, visual quality, FFmpeg or Windows acceptance. The episode-render unit owner separately checks the archived EP26 word endpoints, exact SRT millisecond rounding and refusal of serialized zero-duration splits.
