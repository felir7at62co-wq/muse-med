---
description: "Find the music-emotion package for ranking BGM candidates, downloading selected tracks, and optional local audio analysis."
kind: "package-group"
---

# perception/ — music emotion analysis and matching

English | [中文](README.zh.md)

## Summary

Find BGM candidates near a requested mood and download a selected public track to a verified local file. Local or public matching needs no Python; analyzing new audio needs a separately prepared interpreter and model resources. The agent chooses the music, and composition belongs to the drama packages. The analysis backbone is restricted to non-commercial use; audio rights are separate.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The group currently provides one music-emotion package:

| Package | Role |
|---|---|
| [`perception-bgm`](perception-bgm/README.md) | The `bgm_match` tool: candidate ranking, verified downloads, local index building, and single-track emotion analysis |

<a id="related-documentation"></a>
## Related documentation

- [Tools subsystem](../../docs/subsystems/tools.md) — registration, argument validation, execution, and model-facing results.
- [Drama packages](../drama/README.md) — explicit track plans, audio composition, and episode rendering.
- [Model sources and licenses](perception-bgm/SOURCES.md) — analysis dependencies and their separate redistribution conditions.

<a id="dev-note"></a>
## Dev Note

None.
