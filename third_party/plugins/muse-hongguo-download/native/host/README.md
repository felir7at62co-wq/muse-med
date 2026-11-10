# Local Hongguo v2 runtime

English | [中文](README.zh.md)

## Summary

Prepare the original 2.0.0 SDK and our Java host and .NET licence broker from explicitly supplied local inputs. Preparation does not run the installer, request a licence, initialize a media guest or download a video. Original SDK JARs and DLLs retain their locked bytes. The v1 runtime and saved configuration remain separate.

## Contents

- [Prepare](#prepare)
- [Platforms and private state](#platforms-and-private-state)
- [Host and validation](#host-and-validation)

## Prepare

Run from the plugin directory with absolute paths to the original installer, Java 17, .NET 10 x64 runtime, .NET SDK 10, ECJ, Python 3.9 or later, FFmpeg, private state and a new output directory:

```sh
node scripts/prepare-v2.mjs \
  --setup-exe "$HG_SETUP_EXE" \
  --java "$HG_JAVA" \
  --dotnet "$HG_DOTNET_RUNTIME" \
  --dotnet-sdk "$HG_DOTNET_SDK" \
  --ecj "$HG_ECJ" \
  --python "$HG_PYTHON" \
  --state-dir "$HG_STATE_DIR" \
  --output "$HG_RUNTIME_OUTPUT" \
  --ffmpeg "$HG_FFMPEG"
```

The command verifies the fixed installer SHA256 and exact 37 library JARs, two signer JARs and three original licence DLLs. It extracts the matching native library from the original JNA JAR. ECJ compiles our host into a JAR; the supplied .NET SDK builds the broker with empty NuGet sources and private build caches. SDKs are not copied or installed globally. The SDK's development-certificate generation and telemetry are disabled.

`v2-runtime.json` records relative SDK/host paths, all prepared file sizes and hashes, and external Java/.NET/FFmpeg executable identities. No bare Java class files are published. Existing output directories are refused; failed owned staging directories are removed. The descriptor is published after the other files. The caller must finish preparation before activating this directory.

## Platforms and private state

Preparation supports the current Mac or Windows machine, without cross-preparing another operating system. Mac Java may be ARM64 or x64; Windows Java must be x64. The original licence SDK uses a .NET 10 x64 runtime; Apple Silicon therefore needs Rosetta. Linux is refused. Mac preparation and offline protocol composition have been exercised locally; Windows branches have automated coverage, without a Windows device acceptance claim.

`state-dir/device.json` contains only version, platform and the derived device ID. Mac derives it from the current IOPlatformUUID using a separate Muse prefix; Windows preserves the original SDK's case-sensitive `mg:` derivation from the registry MachineGuid. Raw physical identifiers are not saved or printed. Existing device records must match this machine and are not rotated or repaired. POSIX device files require mode 0600 and private state directories. Other licence state is left intact.

## Host and validation

The Java entry point is `muse.hongguo.v2.PortableHost`, with one private properties-file argument. Its `deviceFile` points to the prepared device record. Directory/resource properties must match APPDATA and the explicit Java user.home, java.io.tmpdir, signer and FFmpeg properties; HOME is not changed. Output and queue files remain under privateRoot. Each run requires a new queue file so an old SDK queue cannot resume without a separate decision.

The original verifier, production pinned public key, challenge/proof methods and the same Licence instance remain in the controller and download API. No default Open controller or private-field reflection is used. The original SDK owns its media guest strategy; this host adds no identity rotation or task retries. Licence startup and offline handshake do not establish server acceptance or completed downloads.

`node --test tests/prepare-v2.test.js` checks identity persistence, conflict preservation, failed-stage cleanup, ZIP traversal/symlink/duplicate rejection and selected-byte verification. A separate real-tool acceptance verifies normal authorization, individual episodes and the requested series before reporting successful downloads. Prepared bytes alone do not establish those results.
