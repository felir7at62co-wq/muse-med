# Agent Note: The ending plays its effect at its own speed and accepts only the shipped bytes

Status: implemented

English | [中文](2026-09-26-ending-plays-at-its-own-speed.zh.md)

## Problem

The two-second ending retimed the ending effect by a speed factor of `0.729` and padded the rest of the window with black. The shipped effect is 1.020 seconds long, so the factor stretched it to 1.399 seconds and left 0.601 seconds of the ending carrying no effect at all. Nothing recorded why that factor existed, and no measurement in the render report could show it: duration, streams, frame rate and bitrate were all still correct, and the frozen frame was still proved.

The ending sound and effect arrived as caller-supplied paths that were accepted whenever the file existed and was non-empty. A session passing a different video, or an audio file of unrelated content, still rendered successfully and delivered an ending the operator never approved, with nothing in the result naming the bytes that were used.

## Decision

[`endingEffectFilter()`](../../../../packages/drama/tool-episode-render/src/delivery.ts) keeps the effect's own timeline: `setpts=PTS-STARTPTS` with no divisor. The effect therefore covers the opening of the ending for as long as it lasts — 1.020 seconds for the shipped asset — and every remaining frame of the window is the freeze frame, because the black pad screens over the frozen frame without changing it. The ending still runs exactly `ENDING_SECONDS`, and `-t 2.000` bounds it independently of the effect's own duration. The skill's `render_episode.py` builds the same graph; its `--effect-speed` flag is gone rather than defaulted to `1.0`.

[`requireShippedEndingAsset()`](../../../../packages/drama/tool-episode-render/src/ending.ts) accepts each supplied ending file only when its SHA-256 equals the shipped asset's, naming the asset, the expected digest and the measured one in its refusal. `requireEndingEffectFits()` probes the effect and refuses one longer than the ending window instead of letting the trim cut it mid-action. Both run with the other input checks, before the first media command, so a substituted asset or an over-long effect costs nothing but the message. The digests are constants beside the delivery specification.

The contract is stated where a caller reads it: the tool's `ending_audio` and `ending_effect` parameter descriptions carry the shipped paths, the digests and the measured lengths, and the `tweet-drama-background-render` skill states that the freeze, the effect and the ending sound are not equal in length — the effect plays once over the opening of the two-second ending, the rest of the window is the freeze, and only the ending sound's first 2 seconds enter the mix at the body end.

## Alternatives considered

**Keep the speed factor and set it to `1`.** A parameter whose only valid value is `1` states nothing and re-admits the stretch the moment somebody passes another value. Removing it makes the natural speed the only representable behavior, and the `ENDING_SECONDS` window states the remainder rule once.

**Compare the supplied file with a resolved shipped path.** The tool has no service that resolves the skill root, and an absolute package path compiled into the module breaks wherever the workspace moves. The bytes identify the asset; the digest is the identity a caller can check anywhere.

**Report the supplied file's digest instead of refusing it.** A report arrives after the episode is delivered with the wrong ending inside it. The refusal happens before any encode, so nothing is produced to withhold.

**Leave the ending sound's tail uncut and let the mix run longer.** The ending window is two seconds; the shipped sound is 3.474 seconds. Trimming to the window is what keeps the delivered duration the timeline's own arithmetic, and the audio graph already states that bound.

## Consequences

The ending's length and the effect's coverage are now separate facts: the ending is always two seconds, and the effect occupies exactly as much of it as the effect itself lasts. A future shipped asset longer than the ending window fails loudly instead of being truncated, which is the intended alarm when the digests and the skill text must be updated together.

The check binds the tool to those exact bytes. Replacing either file changes the delivered ending and fails every render until the constants, the tool descriptions and the skill text are updated in one change.

`packages/drama/tool-episode-render/tests/ending.spec.ts` pins that the shipped files are accepted, that a substituted effect or sound is refused by name, and that an effect longer than the window is refused; `tests/delivery.spec.ts` pins the filter's natural-speed effect branch and the ending window; `tests/render.spec.ts` pins that a substituted input is refused before the channel sees any command. `packages/drama/skills/tests/render/test_portability.py` pins the same two rules for the Python entry point. A real ending built from a synthetic freeze frame measures 2.000 seconds at 60 fps, and every frame after the effect is byte-identical to the frames around it with no black frame anywhere in the clip.
