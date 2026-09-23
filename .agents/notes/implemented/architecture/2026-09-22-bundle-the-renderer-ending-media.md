# Agent Note: Bundle the renderer's ending media with the drama skills package

Status: implemented

English | [中文](2026-09-22-bundle-the-renderer-ending-media.zh.md)

## Problem

Every rendered episode ends with a frozen last frame, an ending effect video blended over it, and an ending sound delayed to the body end. The background-render skill requires both paths and `drama_render` refuses to run without them; the tool's own parameter help already names them as *the skill's* `assets/ending_effect.mp4` and `assets/ending_audio.mp3`. The maintained package shipped neither, so a session that loaded its skills from this repository had to recover the two files from a retired `<DSH_HOME>/skills` install and pass absolute paths on every render call. `maintenance/excluded-sources.json` recorded the omission as a rights decision and told the caller to supply a path, while the tool text promised the skill carries the files.

## Decision

`packages/drama/skills` carries both resources at `skills/tweet-drama-background-render/assets/ending_effect.mp4` (1.02 s, 1080×1920, H.264, no audio) and `ending_audio.mp3` (3.47 s, 192 kbps), each named individually in `package.json#files`. Callers pass those paths as `--ending-audio` and `--ending-effect`; no code resolves a default, and a missing file still fails the render instead of substituting another resource.

The operator confirmed both files are their own material and authorized keeping them beside the skill for local use. The package stays `private: true` and `UNLICENSED`, and its README states that these bundled resources carry no public-redistribution grant. `maintenance/excluded-sources.json` no longer lists them as omissions.

## Alternatives considered

**Keep reading the two files from the retired local install.** That is where they live today and it needs no repository change. It also leaves the maintained package unable to render an episode on a clean checkout, and it keeps the tool's parameter help describing a path that only exists on one machine.

**Default the two paths inside `drama_render`.** A default would spare the caller from naming them, but the tool has no skill-root service to resolve them against, and an absolute package path baked into TypeScript breaks wherever the workspace moves. Explicit paths keep the defaulting step where the layout is known — the skill and the model reading it.

**Bundle the effect video only.** The effect is the visible half of the ending and the harder file to reproduce, but the audio is required by the same render call, so a partial bundle would leave the render failing for the same reason.

## Consequences

A checkout of this package can now render a complete episode, ending included, with no local media outside the workspace. The package redistributes operator-supplied media for the first time, so its rights statement names them instead of asserting that all user media stays out; the packaging check keeps listing every shipped file by name, which is what makes the exception reviewable.
