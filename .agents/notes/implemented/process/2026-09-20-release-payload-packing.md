# Agent Note: Packing the release payload

Status: implemented

English | [中文](2026-09-20-release-payload-packing.zh.md)

## Problem

The product ships as one Windows installer that downloads prebuilt archives, checks them, and unpacks them; it never runs a build or a package manager on a user's machine. That contract fixes what has to exist before an installer can be written: seven `.tar.zst` archives plus a `manifest.json` carrying each archive's byte count, sha256, and extraction directory. Nothing produced them.

Producing them is not a plain recursive archive. The trees the product runs from are this machine's, and they hold NTFS junctions: `profiles/web/node_modules` points at the workspace, a vendor tree, and an npm cache, and `packages/*/node_modules` points back into sibling sources, so a naive walk either stores links instead of content or follows that cycle to the filesystem's depth limit. The payload also has to be slimmed — the Python tree carries 742 MB of `*.lib` files and 113 MB of source maps that nothing loads — and the slimming must not touch the developer's own trees, because the same trees are how the product is being developed.

Two archives must never both contain one file, and the checks an installer relies on have to be reproducible from the archives alone rather than from the trees they were built from.

## Decision

`scripts/release/pack-release.ts` runs under `tsx` with three modes, and `scripts/release/tar-zstd.ts` owns archive writing. No dependency was added: the repository's `tar` package is a transitive dependency of `apps/desktop` and is not resolvable from `scripts/`, so archives are written with Node 24's own `zlib.createZstdCompress` over a minimal ustar writer.

`--plan-only` prints one row per pack — archive name, sources, file count, raw bytes, bytes removed per exclusion rule, and `unpackTo` — and writes nothing. `--build --out <dir> [--only <substr>]` writes the selected archives and the manifest, merging into an existing manifest so a pack can be rebuilt alone; `--only` exists because the Python pack is 2.7 GB of input. `--verify <dir>` re-reads every archive, recomputes byte count and sha256, compares them with the manifest, and asserts the archive members contain nothing the exclusion set forbids.

**Junctions and symlinks are read through, never stored.** Each walk calls `lstat`, and a link is replaced by `stat` of its target, so the member holds the target's bytes under the link's own name. Every directory additionally records its `realpath` in a per-pack visited set: a directory reached twice is a link cycle or the same subtree under a second name, and both are already packed, so one visit is enough. This is what turns the profile's junction farm into real files without recursing to `ELOOP`, and it collapses the skills tree's duplicate copies of a shared subtree.

**Slimming is a pack-time filter.** Ordered rules carry a label and a predicate; directory rules prune before the subtree is read, file rules record the skipped file's bytes against their label, and the plan prints each rule's cost. The default set is `*.lib`, `include/`, `__pycache__/`, `*.pyc`, `_archived/`, `*.map`, `.git/`, and `node_modules/.cache/`; the skills pack adds its two bundled ffmpeg executables, which the tools pack ships once. Nothing under a source root is deleted, so a re-run re-measures the exclusions instead of inheriting an already-slimmed tree.

**One file cannot enter two packs.** A shared claim map keys on each file's `realpath` and holds the `<pack>:<archive path>` that claimed it; a second pack claiming the same real path raises `PlanError` and stops the plan before anything is written. Within a pack, a duplicate archive path is an error rather than a silent overwrite.

**The manifest records the download.** The digest sits after compression and reads its byte count from the same stream, so `bytes` and `sha256` describe the `.tar.zst` on disk — which is what an installer verifies — rather than the uncompressed tar. The build is deterministic in every input it controls: entries are sorted, and headers carry a fixed epoch.

**A tar interleaves header and body per member.** Each member's header is followed immediately by that member's bytes, padded to a 512-byte boundary, and the two zero blocks that end the archive come after the last body. A name longer than the 100-byte field is split across the 155-byte prefix field, and a path that fits neither is rejected rather than truncated.

## Alternatives considered

**Depend on the repository's `tar` package.** It exists in `node_modules`, but only as a transitive dependency of `apps/desktop`, so importing it from `scripts/` would resolve to a directory layout that no manifest declares. Promoting it to a root dependency would be a new dependency for a format Node's own zstd plus one 200-line writer already covers.

**Slim the developer's trees on disk.** Deleting the `.lib` files, caches, and duplicate ffmpeg copies would make every pack cheaper to build. It would also mutate the trees the product is developed in, make the result depend on whether slimming had run, and turn a reversible filtering decision into an irreversible one.

**Flat-compress the whole tree with one archive.** A single archive would make `unpackTo` unnecessary and remove the manifest's per-pack structure. The installer's resume and per-pack verification, however, are per file, and the Python pack has to be rebuildable without re-compressing the model weights.

**Resolve the app pack's dependency closure by reading `node_modules` wholesale.** Copying the repository's store would have shipped 1.49 GB of packages the built output never imports. The closure is instead resolved from each package's declared runtime dependencies, following Node's own parent-walking lookup, and each distinct installed copy is mounted once under `node_modules/<name>`.

## Consequences

The four small packs are built and verified on this machine: skills 28,141,856 bytes, ffmpeg 101,715,568, BGM capability 191,085,086, whisper 444,011,945, each matching the manifest and each named by the plan with a sha256 that `--verify` recomputes. The skills archive extracts to 348 files whose byte lengths equal their sources. Flipping one byte in one archive makes `--verify` exit non-zero with the differing hashes, and restoring the byte makes it exit zero again.

The three large packs are planned but not built. The app pack plans 39,682 files and 391.6 MB raw across `packages/*/*/{lib,package.json}`, `apps/cli`, `apps/web/dist`, and the resolved closure; the plugins pack 1,712 files and 423.1 MB; the Python pack 29,664 files and 1,558.8 MB after its 855.6 MB of `*.lib` and map files are excluded. Planning them costs about 40 seconds and reads metadata only, so a plan run is cheap enough to review before a build.

Three facts about the sources are worth recording because they differ from the packaging checklist's estimates. `apps/web/dist` and the workspace's built `lib/` are 81.2 MB, so the app pack's size is its closure, not its build output. The ffmpeg binaries are 156.73 and 156.53 MB, and excluding the skills tree's two copies removes 193.3 MB. The skills tree contains no `_archived` directory at all on this machine, so that default rule currently removes nothing.

The app and plugins packs cannot be validated until they are built: their excludes are exercised only through the default rule set, and the app pack's closure has not been proved to launch the product. The Python pack's exclusion of `include/` and `*.lib` is likewise planned rather than verified against a working interpreter, which is the self-check document's own prerequisite.

## Testing

`pnpm exec oxlint scripts/release/pack-release.ts scripts/release/tar-zstd.ts` reports no findings, and `tsc -b tsconfig.host.json` reports no error in either file. The acceptance path is the three modes themselves: `--plan-only` prints the seven-row table and exits 0; `--build --only <pack>` writes an archive whose `bytes` and `sha256` the manifest carries; `--verify` exits 0 when the archives match and non-zero when one byte of one archive is flipped, naming the two hashes. Each built archive was additionally read by the platform `tar`, which lists every member and extracts the skills pack to 348 files matching their sources.
