"""Read normal and delay-load PE imports without loading DLLs or using the developer machine's DLL search path."""
import argparse
import json
from pathlib import Path
import re
import sys

# Windows 10/11 system components, not the separately installed Visual C++ runtime.
WINDOWS_DLLS = frozenset(('advapi32 avicap32 avrt bcrypt bcryptprimitives cabinet cfgmgr32 combase comctl32 comdlg32 '
                         'crypt32 cryptbase cryptsp dbghelp dnsapi dwmapi dxgi gdi32 gdiplus glu32 imagehlp imm32 iphlpapi '
                         'kernel32 kernelbase msimg32 msvcrt ncrypt netapi32 normaliz ntdll ole32 oleacc oleaut32 opengl32 '
                         'pdh powrprof propsys psapi rpcrt4 secur32 setupapi shell32 shlwapi user32 userenv usp10 uxtheme '
                         'version winhttp wininet winmm winspool wintrust ws2_32 wtsapi32').split())
VC_DLL = re.compile(r'^(?:msvcp140(?:_[0-9]+|_atomic_wait|_codecvt_ids)?|vcruntime140(?:_[0-9]+)?|concrt140|vcomp140)\.dll$', re.I)


def classify_dependency(name, payload_names):
    """Distinguish exact bundled filenames, offline VC prerequisite, Windows OS and unresolved imports."""
    name = name.lower()
    if name in payload_names:
        return 'payload'
    if VC_DLL.fullmatch(name):
        return 'offline-vc-redistributable'
    if name.startswith(('api-ms-win-', 'ext-ms-win-')) or name.removesuffix('.dll') in WINDOWS_DLLS:
        return 'windows-os'
    return 'unresolved'


def audit(root, pefile):
    """Report import closure for x64 executable payloads, retaining other architectures as non-loaded inventory."""
    files = sorted(p for directory in ('python', 'ffmpeg') for p in (root / directory).rglob('*')
                   if p.is_file() and p.suffix.lower() in ('.dll', '.pyd', '.exe'))
    native = []
    by_machine = {}
    for path in files:
        if path.is_symlink():
            raise ValueError('Media PE audit refuses symbolic links')
        with pefile.PE(str(path), fast_load=True) as image:
            image.parse_data_directories(directories=[1, 13])
            imports = sorted({entry.dll.decode('ascii').lower()
                              for table in ('DIRECTORY_ENTRY_IMPORT', 'DIRECTORY_ENTRY_DELAY_IMPORT')
                              for entry in getattr(image, table, [])})
            machine = image.FILE_HEADER.Machine
            by_machine.setdefault(machine, set()).add(path.name.lower())
            native.append((path.relative_to(root).as_posix(), machine, imports))
    rows = [{'path': path, 'machine': machine, 'imports': [
        {'name': name, 'resolution': classify_dependency(name, by_machine[machine])} for name in imports]}
            for path, machine, imports in native]
    missing = sorted({item['name'] for row in rows if row['machine'] == 0x8664
                      for item in row['imports'] if item['resolution'] == 'unresolved'})
    required = sorted({item['name'] for row in rows if row['machine'] == 0x8664
                       for item in row['imports'] if item['resolution'] == 'offline-vc-redistributable'})
    return {'version': 1, 'target': 'win-x64', 'vcRuntimeRequired': required,
            'unresolvedX64': missing, 'files': rows,
            'limits': 'Static and delay imports only. Payload matches are same-architecture filename candidates, not DLL search-path or export-symbol checks. This is not clean-Windows installation or dynamic LoadLibrary evidence.'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--pefile-wheel', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(args.pefile_wheel.resolve()))
    import pefile
    result = audit(args.root.resolve(), pefile)
    with args.report.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
    if result['unresolvedX64']:
        raise SystemExit('Unresolved x64 native imports: ' + ', '.join(result['unresolvedX64']))
    print('media PE audit: VC prerequisite supplies ' + ', '.join(result['vcRuntimeRequired']))


if __name__ == '__main__':
    main()
