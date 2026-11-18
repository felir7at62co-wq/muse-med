"""Verify every local resource in a built Muse studio before publication."""
import argparse
import hashlib
import json
import re
import subprocess
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


class ArtifactError(ValueError):
    pass


class Document(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.resources = []
        self.modules = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'base':
            raise ArtifactError('index.html must not override the deployment base with <base>')
        if tag == 'script' and attrs.get('src'):
            self.resources.append(attrs['src'])
            self.modules += attrs.get('type') == 'module'
        if tag == 'link' and attrs.get('href'):
            self.resources.append(attrs['href'])
        if tag in ('img', 'source', 'video', 'audio') and attrs.get('src'):
            self.resources.append(attrs['src'])


CSS_URL = re.compile(r'''url\(\s*["']?([^"')\s]+)["']?\s*\)''', re.IGNORECASE)
CSS_IMPORT = re.compile(r'''@import\s+["']([^"']+)["']''', re.IGNORECASE)


def verify(directory, base='/studio/', parser_module=None):
    if not re.fullmatch(r'/(?:[A-Za-z0-9_-]+/)*', base):
        raise ArtifactError('Expected an absolute path base ending in /')
    directory = Path(directory)
    if directory.is_symlink():
        raise ArtifactError('Artifact directory must not be a symbolic link')
    root = directory.resolve(strict=True)
    files = {}
    for path in root.rglob('*'):
        if path.is_symlink():
            raise ArtifactError(f'Artifact contains a symbolic link: {path.relative_to(root)}')
        if path.is_file():
            files[path.relative_to(root).as_posix()] = path
    if 'index.html' not in files:
        raise ArtifactError('Artifact is missing index.html')
    document = Document()
    document.feed(files['index.html'].read_text(encoding='utf-8'))
    if not document.modules:
        raise ArtifactError('index.html has no module entry script')
    checked = set()

    def resource(value, source, html=False, root_relative=False, relative_allowed=False):
        address = urlsplit(value)
        if address.scheme == 'data' and not html:
            return
        if not value or value.startswith('#'):
            return
        if address.scheme or address.netloc or '\\' in value:
            raise ArtifactError(f'Nonlocal resource in {source}: {value}')
        path = unquote(address.path)
        if '\\' in path or '\x00' in path:
            raise ArtifactError(f'Invalid resource path in {source}: {value}')
        if path.startswith('/'):
            if not path.startswith(base):
                raise ArtifactError(f'Wrong deployment base in {source}: {value}; expected {base}')
            relative = path[len(base):]
        elif html:
            raise ArtifactError(f'HTML resource must use explicit {base} base: {value}')
        elif root_relative:
            relative = path
        elif relative_allowed or path.startswith(('./', '../')):
            relative = (Path(source).parent / path).as_posix()
        else:
            raise ArtifactError(f'Unbundled module reference in {source}: {value}')
        target = root / relative
        resolved = target.resolve()
        if not resolved.is_relative_to(root):
            raise ArtifactError(f'Resource escapes artifact in {source}: {value}')
        key = resolved.relative_to(root).as_posix()
        if key not in files:
            raise ArtifactError(f'Missing resource in {source}: {value} -> {key}')
        if files[key].stat().st_size == 0:
            raise ArtifactError(f'Empty resource in {source}: {value}')
        checked.add(key)

    for value in document.resources:
        resource(value, 'index.html', html=True)
    javascript = []
    for name, path in files.items():
        if path.suffix in ('.js', '.mjs'):
            source = path.read_text(encoding='utf-8')
            javascript.append({'name': name, 'source': source})
        elif path.suffix == '.css':
            stylesheet = path.read_text(encoding='utf-8')
            for value in CSS_URL.findall(stylesheet) + CSS_IMPORT.findall(stylesheet):
                resource(value, name, relative_allowed=True)
    parser_module = Path(parser_module) if parser_module else root.parent / 'node_modules/rollup/dist/es/parseAst.js'
    if not parser_module.is_file():
        raise ArtifactError('Rollup parser unavailable; pass --parser-module from the installed Vite build environment')
    parsed = subprocess.run(['node', str(Path(__file__).with_name('verify-web-imports.mjs'))],
                            input=json.dumps({'parser': str(parser_module.resolve()), 'files': javascript}),
                            text=True, encoding='utf-8', capture_output=True, check=False)
    if parsed.returncode:
        raise ArtifactError('JavaScript dependency parsing failed: ' + parsed.stderr[:500])
    for reference in json.loads(parsed.stdout):
        resource(reference['value'], reference['source'], root_relative=reference['rootRelative'])
    bundle = '\n'.join(item['source'] for item in javascript)
    for marker in ('muse-localminidrama:ready', 'muse-localminidrama:ping'):
        if marker not in bundle:
            raise ArtifactError(f'Built JavaScript is missing the native-frame marker {marker}')
    return {'status': 'verified', 'base': base, 'directory': str(root),
            'module_entries': document.modules, 'referenced_files': len(checked),
            'artifact_files': len(files),
            'index_sha256': hashlib.sha256(files['index.html'].read_bytes()).hexdigest()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--base', default='/studio/')
    parser.add_argument('--parser-module', type=Path, help='Installed rollup/dist/es/parseAst.js; defaults to the frontend node_modules')
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.directory, args.base, args.parser_module), ensure_ascii=False))
    except (ArtifactError, OSError, UnicodeError) as error:
        parser.exit(1, f'STUDIO_ARTIFACT_REJECTED: {error}\n')
