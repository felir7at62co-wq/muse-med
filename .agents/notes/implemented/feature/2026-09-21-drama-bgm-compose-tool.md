# Agent Note: Deterministic short-drama BGM composition as a tool

Status: implemented

English | [中文](2026-09-21-drama-bgm-compose-tool.zh.md)

## Problem

The short-drama workflow could rank local tracks by measured emotion and could render an episode from one already-mixed BGM bed, but no package owned the transformation between them. An agent had to run a project-local Python script to trim source tracks, choose starts, normalize volume, crossfade story segments, publish the bed, and inspect it. That script worked for one production, but its path, dependencies, cleanup, and output checks were not available to another preset or enforced by a model tool.

Combining that operation with `bgm_match` would also give candidate ranking and deterministic media assembly the same runtime and license boundary. Candidate analysis uses the m-a-p/MERT-v1-95M backbone under CC-BY-NC-4.0 and is restricted to non-commercial use; trimming and mixing do not.

## Decision

`@deepseek-ai/dsh-tool-bgm-compose` registers `drama_bgm` as an independent Host tool with `preview`, `compose`, and `verify` methods. It consumes an explicit episode plan after the agent has interpreted the plot and selected tracks. The package neither calls nor injects `bgm_match`; a preset can expose both tools, and plans may carry the matcher's measured valence and arousal as ordinary JSON evidence.

The selected episode must continuously cover the measured `body_end`. Each adjacent boundary uses the plan's `crossfade_seconds`, defaulting to 1.5 seconds. A segment either freezes `source_start_seconds` or lets the tool find the first audible onset in the 1–5 second window. FFmpeg `volumedetect` measures the consumed source window; gain targets a `-17.5 dB` mean and caps automatic boost at `+9 dB`. The final bed fades in for 1.5 seconds, fades out over its last 2.5 seconds, and is fixed to 48 kHz stereo `pcm_s16le`.

`preview` performs plan, source, hash, duration, onset, and volume work without publishing. `compose` stages the WAV and JSON report beside their destinations, probes the staged WAV, and hard-links both destinations only after all checks pass. Existing destinations are never overwritten; a conflict rolls back destinations created by that call and retains no temporary name after the operation settles. `verify` measures an existing bed without rewriting it.

All media commands use `ctx.subprocess`, with provider-owned executable resolution, cancellation, process-range termination, and bounded collected output. Plan and timeline files plus outputs stay inside the project; selected read-only source tracks may live elsewhere. The returned WAV is the input for `drama_render.bgm`, while the same plan remains the declaration passed to `drama_render.bgm_plan`.

## Alternatives considered

**Add composition to `dsh-perception-bgm`.** That package owns model-backed emotion analysis and a resident Python worker. Mixing there would make a license-neutral FFmpeg operation depend on the MERT deployment and would hide the agent's final creative choice behind candidate ranking.

**Add composition to `dsh-tool-episode-render`.** The renderer consumes one reviewed bed and mixes it with episode audio. Making it also choose source windows would combine music preparation with delivery encoding, prevent preview before rendering, and make renderer retries repeat unrelated source analysis.

**Keep the project-local Python script.** It demonstrated the audio policy, but a script named by a skill has no tool schema, Cordis lifecycle, preset inventory row, or reusable no-clobber checks. The package keeps the measured behavior and removes the per-project execution path.

**Implement beat-grid inference in the first package.** No maintained audio-analysis dependency is already installed, and FFmpeg silence detection cannot claim musical beat accuracy. The tool reports audible onset honestly and requires an explicit offset when a downbeat matters.

## Consequences

Candidate ranking, creative selection, deterministic composition, and episode rendering now have separate owners. The composer can run without MERT, while `bgm_match` candidates retain the m-a-p/MERT-v1-95M CC-BY-NC-4.0 restriction to non-commercial use.

A plan is reproducible when it freezes source hashes and offsets; omitted offsets deliberately allow onset analysis to follow the current source bytes. Mean-volume normalization is not integrated LUFS, source tracks do not loop, and technical verification is not listening approval.

The [episode renderer decision](2026-09-19-drama-episode-render-tool.md), [settings component-list decision](2026-09-20-drama-settings-panel.md), and [production evidence decision](2026-09-21-drama-policy-and-result-evidence.md) remain active. This package complements the renderer, adds one current component to the settings list, and adds assembly evidence without claiming creative approval. None is fully superseded or archived.
