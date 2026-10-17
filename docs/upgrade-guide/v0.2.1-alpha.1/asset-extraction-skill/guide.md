---
kind: upgrade-guide
description: "The bundled legacy creation guide, pipeline, asset extraction and shot-writing skills are no longer available by name or packaged resource path."
---
# Creative skill removal

English | [中文](guide.zh.md)

## Change

Muse no longer bundles or advertises `jubian-asset-library`, `muse-creation`, `tweet-drama-pipeline`, `tweet-drama-asset-extract`, `shot-script-creator-9-16`, `shot-script-creator-16-9-3d` or `tweet-drama-early-shot-script`. Explicit calls and packaged resource paths targeting those skills are unavailable. Muse also removes `drama_shot` from its product presets. Asset generation and visual review remain available; existing project assets, scripts and manifests are unchanged. The compiler package remains available for legacy compatibility tests.

## Migration

1. Remove calls to the removed skill names and their packaged directories from custom prompts and scripts. For editing tasks, choose the maintained `muse-script-editing`, `muse-script-doctor` or `screenplay-format` skill as applicable.
2. Describe asset and shot-writing requirements in the project instructions. Use the existing generation tools and visual-review skill for assets, and native storyboard `prepare_video` followed by `submit_video` or `submit_video_batch` for video packages.
3. Start a new session and confirm its skill catalog omits the removed names and its tool list omits `drama_shot` while retaining visual review and native video tools.
