---
kind: upgrade-guide
description: "Relative episode-render input and output paths now resolve from the project root instead of the host working directory."
---

# Episode-render paths resolve from the project

English | [中文](guide.zh.md)

## Change

`drama_render` resolves every relative input and output path from `project`. This includes `shots`, `lines`, `alignment`, `subtitle_srt`, `ending_audio`, `ending_effect`, and explicit `output`; `timeline`, `bgm`, and `bgm_plan` retain their project-relative behavior. Absolute paths and default project output locations are unchanged.

The background-render Python scripts use the same rule, including single-episode `--freeze-image` and batch `--bgm-dir`. Relative paths previously addressed from the calling process working directory can now address different files. The renderer does not change the process working directory, encoding, audio mixing, or deployment binary/font configuration.

## Migration

1. Pass an absolute project root across tools. A relative `project` is still resolved once from the calling process working directory.
2. Review saved render calls and script arguments. Express project files relative to that root, or keep their absolute paths. For shipped ending assets outside the project, use the actual skill installation's absolute paths; the byte checks remain required.
3. Run `prepare`, `subtitles`, `render`, and `verify` from a working directory different from the project. Confirm input paths and written paths address the intended project or explicit absolute destination. See the [renderer reference](../../../../packages/drama/tool-episode-render/README.md).
