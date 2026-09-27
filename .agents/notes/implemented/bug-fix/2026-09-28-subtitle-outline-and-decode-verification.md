# Agent Note: the burned subtitle outline and the decode check

Status: implemented

English | [中文](2026-09-28-subtitle-outline-and-decode-verification.zh.md)

## Problem

[The 2026-09-28 delivery review](2026-09-28-short-drama-delivery-defects.md) fixed "subtitles that read too thick" by changing the burned ASS field from `Outline 7` to `Outline 3`, and measured the replacement as `4px` on the delivery. Both the value and the measurement missed the same fact: `Outline` is in script-canvas units, and libass only scales it to the frame it rasterizes when `ScaledBorderAndShadow` is on. The package's ASS header omitted that key, so the field was drawn as unscaled raster pixels, and the header is burned through a 2x supersample (`scale=2880:5120`, `ass`, `scale=1440:2560`) whose shrink halves what the key would have scaled. Measured through this package's own burn chain, the shipped `Outline 3` rendered a 1-2px band, not the 4px the note recorded — that figure came from a direct burn at the delivery size, where the same field renders three pixels wider.

The same review's run wrote its own FFmpeg chain and put `fps=60` before `subtitles`. The burn filter anchors the time base back to the source frame rate, so the rate change did not survive into the encode: the delivered container reported 116.7 s, 60 fps and a normal bit rate while only 603 of the comparison's 3008 frames decoded, and a seek to 30 s returned no frame at all. Nothing in `drama_render verify` decoded the picture, so a file in that state passed every check the delivery had.

Two unit mismatches sat beside those. The Jianying draft's `styles[0].strokes[0].width` is `0.04` while the style spec says `20`, and the skill text gave no dimension for either. The burned subtitle's font was stated as `SimHei` in the style bullet and as the bundled `Noto Sans CJK SC` in the dependency section.

## Decision

**The outline is authored in delivered pixels and derived, never written as a literal.** `SUBTITLE_OUTLINE_TARGET_PX` is 7, and [`assOutline(targetPx, playResY, outputHeight)`](../../../../packages/drama/tool-episode-render/src/delivery.ts) computes `targetPx x playResY / outputHeight`: the delivered band is `Outline x outputHeight / PlayResY`, and the burn's 2x supersample cancels exactly because the shrink halves the doubled raster. At the standard geometry (canvas 1080x1920, delivery 1440x2560) the derived field is 5, which measured a 5px thinnest run and a 7px median run through the shipped chain and through a direct burn alike. `buildAssHeader` and the skill's `write_ass` both call the same rule, and their tests assert the derivation — a changed delivery height re-derives (4 at 3840) instead of inheriting a number.

**The header now carries `ScaledBorderAndShadow: yes`.** Without it the derivation does not describe what renders, so the key is part of the style contract rather than an omission.

**The burn chain ends on the rate filters.** `subtitleBurnFilter` and the skill's `subtitle_filter` both end on `fps=60,setpts=N/(60*TB)`, after `ass`. A render's picture is constant-rate and anchored at zero before the encoder sees it, whatever time base the concatenated body arrived with.

**`verify` decodes the picture instead of reading its metadata.** The `decode_probe` check seeks to 0.05 s, the middle, and 0.1 s inside the tail, decodes one frame at each with `showinfo`, and fails when any position yields no frame; the decoder's own exit code is not the verdict, because a seek past a truncated file's real end exits 0 with nothing decoded. The skill's `render_episode.py` runs the same three probes through `assert_decodes_throughout` before its output replaces the previous delivery.

**The draft's subtitle values are Jianying UI units with one documented conversion.** `jianying_draft.py` names them as `SUBTITLE_*` constants with the mapping `pyJianYingDraft` applies when it writes the draft: font size as-is (`11` → `11.0`), letter spacing x 0.05 (`0` → `0.0`), border width / 100 x 0.2 (`20` → `0.04`), and line spacing always `0.02 + value x 0.05`, so the file's `0.02` is the baseline rather than a setting. Omitting the style's `font` field is what "Jianying's own default font" means: the draft file carries no font name to check. The draft's size 11 and the delivery's size 68 stay separate contracts, and each side has a test that fails if the other's numbers move.

**The font has one authoritative statement.** It is the source of the family, and the family is deployment config: the muse-med Windows product bundles OFL-licensed `Noto Sans CJK SC` (body 68, watermark 44) through `MUSE_FONTS_DIR`/`MUSE_FONT_FAMILY` and the product's `drama_render` config, for the reason that it can be redistributed; every other deployment falls back to system-discovered `SimHei` and `Microsoft YaHei`, which is also the plugin's default, and the package ships no font files.

## Alternatives considered

**Keep `Outline 3` and state the intent as the design-coordinate width.** Rejected: it makes the visible band depend on the burn resolution — the same field rendered three pixels narrower through this package's supersampled chain than through a direct burn — which is the drift the derivation exists to remove.

**Write the fallback value and leave `ScaledBorderAndShadow` out.** Rejected: libass then treats the field as raster pixels, so the value has to be re-tuned per burn resolution and the 2x supersample becomes a silent part of the style.

**Keep the outline in canvas units and re-author the operator's "7px" as `Outline 7`.** Rejected: `7` is what the operator already judged too thick (8-10px delivered), and the delivered width is the quantity the review was about.

**Count frames with `ffprobe -count_frames` instead of probe decodes.** Rejected as the primary check: it is a second full decode of a two-minute master, and the reported failure is exactly a position that yields nothing, which three seeks answer directly.

**Anchor the rate filters in documentation only.** Rejected: the chain is built by the package, so the order is enforceable where it is produced and testable in the string the package emits.

## Consequences

Decode verification costs three seeks and up to two decoded frames per `verify` call, and it fails a file that is still partly playable — which is the intended verdict, because a delivery whose tail does not decode cannot be delivered. The skill's fallback renderer pays the same cost before publishing.

The derivation holds only while the script is burned with `ScaledBorderAndShadow` on and scaled uniformly; a filter that scales the frame non-uniformly between the burn and the encode would break it, and the tests assert the chain's own shape rather than measuring a rendered band at runtime.

The draft's conversion is documented from `pyJianYingDraft`'s own mapping rather than enforced by it: a library upgrade that changes the mapping would change the file's numbers while the UI constants stay, so the Python test builds a real `TextSegment` and pins the exported `0.04`/`0.0`/`11.0` where the library is installed.

## Verification

`pnpm vitest run packages/drama/tool-episode-render` passes 269 tests, including `assOutline`'s re-derivation, the header's `ScaledBorderAndShadow: yes` and derived field, the burn chain's trailing `fps=60,setpts=N/(60*TB)`, exactly one bottom-right AI-content mark with no top-right notice, and `decode_probe` passing a decodable file and failing a file whose tail yields no frame.

`python -B -m unittest` over `packages/drama/skills/tests` passes its three suites (162 tests), including the new `tests/render/test_subtitle_contracts.py`: the same derivation and chain order in `render_episode.py`, the three decode probes raising on an undecodable tail (measured with real FFmpeg separately: a container whose 30 s / 1800-frame metadata survives truncation decodes 2 frames at the head and 0 at 15.0 s and 29.9 s), exactly one bottom-right mark, the draft's UI values with the library's exported `0.04`, and the draft module carrying no watermark text and no track beyond `字幕轨道`.

The band is measured, not asserted: `color=c=gray:s=1440x2560` burned through `buildAssHeader` plus `subtitleBurnFilter` and scanned for black runs adjacent to the white glyph renders a 5px thinnest run and a 7px median run at the derived field 5; the same script with `ScaledBorderAndShadow` removed renders 2px, and the pre-change `Outline 3` on that header renders 1-2px.

`pnpm run verify-tool-catalog` and `pnpm run verify-translation-pairing` pass after regenerating the catalog and re-recording the pairs this change touches; the pairing gate still reports only the three unpaired documents under `docs/superpowers/` that predate it.
