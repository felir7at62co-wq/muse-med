"""Build Windows x64 FFmpeg and archive the exact source inputs beside its binaries."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile

RECIPE = Path(__file__).resolve().parent


def sha256(path):
    """Hash a file without loading media or source archives into memory."""
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def load_lock(path):
    """Refuse floating revisions, unexpected repositories and unpinned toolchains."""
    lock = json.loads(path.read_text(encoding='utf-8'))
    for key in ('builder_commit', 'ffmpeg_commit'):
        if not re.fullmatch(r'[0-9a-f]{40}', lock[key]):
            raise ValueError(f'{key} must be a full commit')
    for key, name in [('base_image', 'base'), ('toolchain_image', 'base-win64')]:
        if not re.fullmatch(r'ghcr\.io/btbn/ffmpeg-builds/' + name + r'@sha256:[0-9a-f]{64}', lock[key]):
            raise ValueError(f'{key} must identify an immutable BtbN image')
    for key, expected in [('builder_repository', 'https://github.com/BtbN/FFmpeg-Builds.git'),
                          ('ffmpeg_repository', 'https://github.com/FFmpeg/FFmpeg.git')]:
        if lock[key] != expected:
            raise ValueError(f'Unexpected {key}')
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', lock['version']):
        raise ValueError('Invalid FFmpeg version')
    return lock


def replace_once(text, before, after):
    """Fail closed when a pinned upstream script does not match the reviewed operation."""
    if text.count(before) != 1:
        raise ValueError(f'Expected one upstream occurrence: {before}')
    return text.replace(before, after, 1)


def pin_generated_inputs(builder, lock):
    """Pin the generated Dockerfile and download only its selected dependency stages."""
    dockerfile = (builder / 'Dockerfile').read_text(encoding='utf-8')
    stages = re.findall(r'^ENV SELF="(scripts\.d/[a-zA-Z0-9/_.-]+\.sh)" STAGENAME=', dockerfile, re.M)
    sources = sorted(set(re.findall(r'src=\.cache/downloads/([a-zA-Z0-9-]+_[0-9a-f]{64}\.tar\.xz)', dockerfile)))
    if not stages or not sources or any('..' in stage.split('/') for stage in stages):
        raise ValueError('No valid dependency input set in generated Dockerfile')
    dockerfile = replace_once(dockerfile, 'FROM ghcr.io/btbn/ffmpeg-builds/base-win64:latest AS base-layer',
                              f"FROM {lock['toolchain_image']} AS base-layer")
    downloader = (builder / 'download.sh').read_text(encoding='utf-8')
    downloader = replace_once(downloader, 'for STAGE in scripts.d/*.sh scripts.d/*/*.sh; do',
                              'for STAGE in ' + ' '.join(dict.fromkeys(stages)) + '; do')
    downloader = replace_once(downloader, '${REGISTRY}/${REPO}/base:latest${DOCKER_TAG_SUFFIX:-}', lock['base_image'])
    (builder / 'Dockerfile').write_text(dockerfile, encoding='utf-8', newline='\n')
    (builder / 'download.sh').write_text(downloader, encoding='utf-8', newline='\n')
    return sources


def run(command, cwd=None, env=None, output=None):
    """Execute once, preserve logs, and stop on any unsuccessful build operation."""
    print('+', ' '.join(map(str, command)), flush=True)
    if output:
        with output.open('w', encoding='utf-8') as stream:
            subprocess.run(command, cwd=cwd, env=env, stdout=stream, check=True)
    else:
        subprocess.run(command, cwd=cwd, env=env, check=True)


def checkout(repository, commit, destination):
    """Fetch a pinned revision without credential persistence or floating branch resolution."""
    run(['git', 'init', str(destination)])
    run(['git', '-C', str(destination), 'remote', 'add', 'origin', repository])
    run(['git', '-C', str(destination), 'fetch', '--depth=1', 'origin', commit])
    run(['git', '-C', str(destination), 'checkout', '--detach', commit])


def patch_mingw_guard(builder):
    """Require the pinned Mingw source's existing SSP priority instead of reapplying an obsolete patch."""
    stage = builder / 'scripts.d' / '10-mingw.sh'
    text = stage.read_text(encoding='utf-8')
    text = replace_once(text,
                        "sed -zi 's/__constructor__\\s*)/__constructor__(0))/g; t; q1' "
                        'mingw-w64-crt/ssp/stack_chk_guard.c',
                        "grep -Fxq '__attribute__((constructor(0)))' mingw-w64-crt/ssp/stack_chk_guard.c")
    stage.write_text(text, encoding='utf-8', newline='\n')


def patch_submodule_downloads(builder):
    """Archive gitlink-pinned dependency sources before the network-disabled build starts."""
    helper = builder / 'util' / 'dl_functions.sh'
    text = helper.read_text(encoding='utf-8')
    before = r'echo "git-mini-clone \"$SCRIPT_REPO\" \"$SCRIPT_COMMIT\" \"$1\""'
    after = r'echo "git-mini-clone \"$SCRIPT_REPO\" \"$SCRIPT_COMMIT\" \"$1\" && git -C \"$1\" submodule update --init --recursive --depth=1"'
    helper.write_text(replace_once(text, before, after), encoding='utf-8', newline='\n')


def prepare_sources(work, lock):
    """Resolve the minimal BtbN dependency graph and retain every source input before compiling."""
    builder, ffmpeg = work / 'builder', work / 'ffmpeg'
    checkout(lock['builder_repository'], lock['builder_commit'], builder)
    checkout(lock['ffmpeg_repository'], lock['ffmpeg_commit'], ffmpeg)
    if (ffmpeg / 'RELEASE').read_text().strip() != lock['version']:
        raise ValueError('FFmpeg revision does not match the locked release')
    final = builder / 'scripts.d' / 'zz-final.sh'
    text = final.read_text(encoding='utf-8')
    text, count = re.subn(r'ffbuild_depends\(\) \{\n.*?\n\}',
                         'ffbuild_depends() {\n    echo x264\n    echo libass\n    echo zlib\n}', text, count=1, flags=re.S)
    if count != 1:
        raise ValueError('Missing upstream dependency root')
    final.write_text(text, encoding='utf-8', newline='\n')
    patch_mingw_guard(builder)
    patch_submodule_downloads(builder)
    # BtbN generates image names from this value; do not inherit the application's repository name.
    env = {**os.environ, 'GITHUB_REPOSITORY': 'BtbN/FFmpeg-Builds', 'REGISTRY_OVERRIDE': 'ghcr.io'}
    run(['bash', 'generate.sh', 'win64', 'gpl', '9.0'], cwd=builder, env=env)
    sources = pin_generated_inputs(builder, lock)
    run(['docker', 'pull', '--platform=linux/amd64', lock['base_image']])
    run(['bash', 'download.sh'], cwd=builder, env=env)
    run(['git', '-C', str(builder), 'diff', '--binary'], output=builder / 'muse-build.patch')
    return builder, ffmpeg, sources


def source_path(cache, name):
    """Resolve cache aliases to regular files while refusing targets outside the owned cache."""
    if Path(name).name != name:
        raise ValueError(f'Invalid dependency source name: {name}')
    cache = cache.resolve()
    target = (cache / name).resolve(strict=True)
    if not target.is_relative_to(cache):
        raise ValueError(f'Dependency source escapes its cache: {name}')
    if not target.is_file():
        raise FileNotFoundError(f'Missing dependency source: {name}')
    return target


def collect_licenses(cache, sources, runtime):
    """Copy dependency notices into the binary ZIP without extracting arbitrary archive entries."""
    for name in sources:
        found = False
        with tarfile.open(source_path(cache, name)) as archive:
            for member in archive:
                path = PurePosixPath(member.name)
                if (not member.isfile() or path.is_absolute() or '..' in path.parts or '.git' in path.parts
                        or '\\' in member.name or ':' in member.name):
                    continue
                if not re.fullmatch(r'(?:COPYING|LICENSE|LICENCE|NOTICE|COPYRIGHT|AUTHORS)(?:[._-].*)?|FTL\.TXT|GPL.*\.TXT',
                                    path.name, re.I):
                    continue
                if member.size > 1024 * 1024:
                    raise ValueError(f'Unexpectedly large license: {name}/{member.name}')
                target = runtime / 'licenses' / name.removesuffix('.tar.xz') / str(path)
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open('wb') as destination:
                    shutil.copyfileobj(source, destination)
                found = True
        if not found:
            raise ValueError(f'No dependency license found in {name}; review before distribution')


def package_artifacts(output, builder, ffmpeg, runtime, evidence, recipe, lock, sources):
    """Publish the binary/source pair only when all selected dependency sources exist."""
    source_files = {name: source_path(builder / '.cache' / 'downloads', name) for name in sources}
    for name in ('bin/ffmpeg.exe', 'bin/ffprobe.exe', 'LICENSE.txt'):
        if not (runtime / name).is_file():
            raise FileNotFoundError(f'Missing runtime file: {name}')
    output.mkdir(parents=True, exist_ok=False)
    binary_name = f"muse-ffmpeg-{lock['version']}-win-x64.zip"
    source_name = f"muse-ffmpeg-{lock['version']}-corresponding-source.tar.gz"
    with zipfile.ZipFile(output / binary_name, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(runtime.rglob('*')):
            if path.is_file():
                archive.write(path, 'ffmpeg/' + path.relative_to(runtime).as_posix())
    def source_filter(member):
        parts = Path(member.name).parts
        return None if any(part in ('.git', '.cache', '__pycache__') for part in parts) else member
    with tarfile.open(output / source_name, 'w:gz') as archive:
        for path, name in [(builder, 'builder'), (ffmpeg, 'ffmpeg'), (evidence, 'evidence'), (recipe, 'recipe')]:
            archive.add(path, arcname='source/' + name, filter=source_filter)
        for name in sources:
            archive.add(source_files[name],
                        arcname='source/builder/.cache/downloads/' + name)
    manifest = {
        'inputs': lock,
        'binary_archive': binary_name,
        'source_archive': source_name,
        'artifacts': {name: sha256(output / name) for name in (binary_name, source_name)},
        'dependency_sources': {name: sha256(source_files[name]) for name in sources},
        'executables': {name: sha256(runtime / 'bin' / name) for name in ('ffmpeg.exe', 'ffprobe.exe')},
    }
    (output / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    (output / 'SHA256SUMS').write_text(''.join(f'{sha256(output / name)}  {name}\n'
                                            for name in (binary_name, source_name, 'build-manifest.json')), encoding='utf-8')
    verify_artifacts(output)


def verify_artifacts(output):
    """Reject a missing, renamed or altered member of the paired build output."""
    manifest = json.loads((output / 'build-manifest.json').read_text(encoding='utf-8'))
    names = {manifest['binary_archive'], manifest['source_archive']}
    if len(names) != 2 or names != set(manifest['artifacts']):
        raise ValueError('Both binary and source archives are required')
    for name, digest in manifest['artifacts'].items():
        if Path(name).name != name or not re.fullmatch(r'[0-9a-f]{64}', digest):
            raise ValueError('Invalid artifact record')
        if sha256(output / name) != digest:
            raise ValueError(f'Artifact checksum mismatch: {name}')
    expected = ''.join(f'{sha256(output / name)}  {name}\n'
                       for name in (manifest['binary_archive'], manifest['source_archive'], 'build-manifest.json'))
    if (output / 'SHA256SUMS').read_text(encoding='utf-8') != expected:
        raise ValueError('Build metadata or checksum inventory mismatch')
    return manifest


def build(output, sources_root=None):
    """Build on Linux Docker; an extracted source bundle can replace all source downloads."""
    if sys.platform != 'linux':
        raise RuntimeError('This cross-build requires Linux with Docker buildx; it installs no host packages')
    lock = load_lock(RECIPE / 'lock.json')
    output = output.resolve()
    if output.exists():
        raise FileExistsError(output)
    with tempfile.TemporaryDirectory(prefix='muse-ffmpeg-build-') as temporary:
        work = Path(temporary)
        if sources_root is None:
            builder, ffmpeg, sources = prepare_sources(work, lock)
        else:
            sources_root = sources_root.resolve()
            builder, ffmpeg = sources_root / 'builder', sources_root / 'ffmpeg'
            recorded = json.loads((sources_root / 'evidence' / 'source-inputs.json').read_text())
            if recorded['inputs'] != lock:
                raise ValueError('Recipe lock differs from archived build inputs')
            sources = sorted(recorded['dependency_sources'])
            for name in sources:
                if sha256(source_path(builder / '.cache' / 'downloads', name)) != recorded['dependency_sources'][name]:
                    raise ValueError('Dependency source checksum mismatch')
        evidence = work / 'evidence'
        evidence.mkdir()
        (evidence / 'source-inputs.json').write_text(json.dumps({
            'inputs': lock,
            'dependency_sources': {name: sha256(source_path(builder / '.cache' / 'downloads', name)) for name in sources},
        }, indent=2) + '\n', encoding='utf-8')
        run(['docker', 'pull', '--platform=linux/amd64', lock['toolchain_image']])
        run(['docker', 'image', 'inspect', lock['toolchain_image']], output=evidence / 'toolchain-image.json')
        run(['docker', 'version'], output=evidence / 'docker-version.txt')
        image = 'muse-ffmpeg:' + work.name
        run(['docker', 'buildx', 'build', '--platform=linux/amd64', '--network=none', '--load',
             '--progress=plain', '--tag', image, str(builder)])
        run(['docker', 'image', 'inspect', image], output=evidence / 'dependency-image.json')
        for name in ('build', 'runtime'):
            (work / name).mkdir()
        try:
            run(['docker', 'run', '--rm', '--network=none', '--platform=linux/amd64',
                 '--user', f'{os.getuid()}:{os.getgid()}', '-e', 'BUILD_JOBS=2',
                 '-v', f'{ffmpeg}:/source:ro', '-v', f'{work}:/work',
                 '-v', f'{RECIPE}:/recipe:ro', image, 'bash', '/recipe/compile.sh'])
            shutil.copyfile(ffmpeg / 'COPYING.GPLv3', work / 'runtime' / 'LICENSE.txt')
            collect_licenses(builder / '.cache' / 'downloads', sources, work / 'runtime')
            shutil.copyfile(builder / 'LICENSE', work / 'runtime' / 'licenses' / 'BtbN-build-scripts.txt')
            (work / 'runtime' / 'README.txt').write_text(
                'muse-med self-built FFmpeg ' + lock['version'] + '\n'
                'GPLv3; includes libx264, libass and their recorded dependencies.\n'
                'Redistribute the matching corresponding-source.tar.gz, build-manifest.json and SHA256SUMS\n'
                'from this same build alongside the application release. See licenses/ for dependency notices.\n',
                encoding='utf-8')
            shutil.copytree(work / 'build' / 'ffbuild', evidence / 'ffbuild',
                            ignore=shutil.ignore_patterns('*.o', '*.a'))
            for name in ('config.h', 'config_components.h'):
                shutil.copyfile(work / 'build' / name, evidence / name)
            package_artifacts(output, builder, ffmpeg, work / 'runtime', evidence, RECIPE, lock, sources)
        finally:
            run(['docker', 'image', 'rm', image])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['build', 'verify'])
    parser.add_argument('output', type=Path)
    parser.add_argument('--sources', type=Path, help='Extracted source/ directory for a source-offline rebuild')
    args = parser.parse_args()
    if args.command == 'verify':
        verify_artifacts(args.output)
    else:
        build(args.output, args.sources)
