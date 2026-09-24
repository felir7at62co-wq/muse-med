---
description: "Collect the pinned BGM native corresponding sources and review the source-archive release requirements."
---

# BGM native source bundle

English | [中文](README.zh.md)

## Summary

Collect the corresponding source for the native libraries the BGM emotion runtime links or embeds: libsndfile 1.2.0 with the codecs statically linked into its DLL (reference libFLAC 1.3.4, libogg 1.3.5, libVorbis 1.3.7, libopus 1.3.1, LAME 3.100, libmpg123 1.29.3), the soxr 1.1.0 source distribution that vendors the libsoxr 0.1.3 linked into `soxr_ext.pyd`, the python-soundfile packaging recipe with the archives that produced the DLL, and pretty_midi 0.2.10 as the distributed form of the GPL-2 TimGM6mb SoundFont. This source-only operation does not rebuild or replace a wheel, edit the BGM runtime lock, or qualify an installer. The [PyAV wheel source bundle](../pyav-source-bundle/README.md) is the separate collection for the media payload's PyAV wheel, and neither archive substitutes for the other.

## Table of Contents

- [Collect and verify](#collect-and-verify)
- [Distribution requirements](#distribution-requirements)
- [Dev Note](#dev-note)

<a id="collect-and-verify"></a>
## Collect and verify

From this directory, use Python 3.11+, which needs network access and a trusted CA store when a component has to be downloaded. Never disable TLS certificate verification. Keep generated sources in the repository's ignored `.artifacts` directory:

```sh
python build.py build ../../../../.artifacts/bgm-source-bundle
python build.py verify ../../../../.artifacts/bgm-source-bundle
python -m unittest test_build
```

The lock pins twelve archives by official HTTPS URL, byte size and SHA-256. Collection takes each archive from the held `.local/bgmprep/compliance/sources` copies when they are present, rechecks size and SHA-256 before reuse, and downloads from the pinned URL only when no held copy exists; a held copy that fails the check stops the build instead of being replaced silently. `--inputs` names a different held directory, and a build without one downloads every archive. The mpg123 entry also records the vcpkg build tree path the shipped DLL embeds, and collection refuses an archive whose SHA-512 prefix does not match that path.

The output contains `source/`, `muse-bgm-native-corresponding-source.tar.gz`, `manifest.json` and `SHA256SUMS`. It archives each locked upstream source unchanged, the license texts found inside those archives, and this recipe. A complete collection and its built-in byte verification must pass before distribution; unit tests or a partial download are insufficient, and release maintainers own that qualification.

<a id="distribution-requirements"></a>
## Distribution requirements

Link the matching source archive from the same desktop release, and keep the component versions in that link consistent with the shipped libraries. LGPL-2.1 covers libsndfile 1.2.0, LAME 3.100 and libmpg123 1.29.3, and LGPL-2.1-or-later covers libsoxr 0.1.3; the TimGM6mb SoundFont shipped by pretty_midi 0.2.10 is GPL-2 while pretty_midi's own MIT label covers its code only. Recorded limitations: the shipped DLL carries no libogg version string, so its 1.3.5 is unverified; libmpg123 exposes no banner and its version rests on the build tree path in the DLL plus vcpkg's own pin for that archive; the DLL recipe's workflow runs against a runner image's preinstalled vcpkg, so the vcpkg baseline is not pinned by the archive; and the locked pretty_midi sdist contains no license file of its own.

Source collection gives no legal conclusion, no clearance, no codec patent position and no byte-identical rebuild guarantee. No wheel was recompiled and no payload was inspected while collecting these sources.

<a id="dev-note"></a>
## Dev Note

The [PyAV source-bundle decision](../../../../.agents/notes/implemented/process/2026-09-23-pyav-wheel-source-bundle.md) records why a wheel's own source distribution is not its matching source; this recipe follows the same lock, archive and verification conventions.
