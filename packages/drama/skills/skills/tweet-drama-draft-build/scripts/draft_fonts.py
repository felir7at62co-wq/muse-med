"""Resolve managed font files by their SFNT names and retain them with a draft."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct


_LICENSES = {
    'ZhuqueFangsong-Regular.ttf': 'LICENSE-ZhuqueFangsong.txt',
    'NotoSansCJKsc-Regular.otf': 'LICENSE-NotoSansCJK.txt',
}


def file_hash(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def family_names(path: Path) -> set[str]:
    """Read bounded OpenType/TrueType family names; a filename is not a family identity."""
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= 64 * 1024 * 1024:
        raise ValueError('Managed font must be a regular file within 64 MiB')
    data = path.read_bytes()
    if len(data) < 12 or data[:4] not in (b'\x00\x01\x00\x00', b'OTTO', b'true'):
        raise ValueError('Managed font is not a standalone OpenType or TrueType file')
    count = struct.unpack_from('>H', data, 4)[0]
    if not 0 < count <= 512 or 12 + count * 16 > len(data):
        raise ValueError('Managed font table directory is invalid')
    names = set()
    for index in range(count):
        tag, _checksum, offset, length = struct.unpack_from('>4sIII', data, 12 + index * 16)
        if offset + length > len(data):
            raise ValueError('Managed font table exceeds file bounds')
        if tag != b'name':
            continue
        table = data[offset:offset + length]
        if len(table) < 6:
            raise ValueError('Managed font name table is truncated')
        version, records, strings = struct.unpack_from('>HHH', table)
        if version not in (0, 1) or records > 4096 or 6 + records * 12 > len(table) or strings < 6 + records * 12:
            raise ValueError('Managed font name records are invalid')
        for record in range(records):
            platform, _encoding, _language, name_id, size, start = struct.unpack_from('>HHHHHH', table, 6 + record * 12)
            start += strings
            if start + size > len(table):
                raise ValueError('Managed font name exceeds table bounds')
            if name_id not in (1, 16) or platform not in (0, 1, 3):
                continue
            name = table[start:start + size].decode('mac_roman' if platform == 1 else 'utf-16-be').strip()
            if name:
                names.add(name)
    if not names:
        raise ValueError('Managed font has no readable family name')
    return names


def resolve_managed_font(name: str) -> dict | None:
    """Find exactly one matching bundled family together with its shipped licence notice."""
    location = os.environ.get('MUSE_FONTS_DIR')
    if not location:
        return None
    root = Path(location).resolve(strict=True)
    fonts = sorted(path for path in root.iterdir() if path.suffix.lower() in ('.ttf', '.otf'))
    if len(fonts) > 32:
        raise ValueError('Managed font directory exceeds 32 files')
    matches = [path for path in fonts if name in family_names(path)]
    if not matches:
        return None
    if len(matches) != 1:
        raise ValueError('Requested family resolves to multiple managed font files')
    source = matches[0]
    notice_name = _LICENSES.get(source.name)
    if notice_name is None:
        raise ValueError('Requested managed font has no declared licence notice')
    notice = root.parent / 'licenses' / notice_name
    if notice.is_symlink() or not notice.is_file() or not 0 < notice.stat().st_size <= 1024 * 1024:
        raise ValueError('Managed font licence notice is missing or invalid')
    manifest = root.parent / 'media-runtime.json'
    if manifest.is_symlink() or not manifest.is_file() or manifest.stat().st_size > 1024 * 1024:
        raise ValueError('Managed media manifest is missing or invalid')
    document = json.loads(manifest.read_text(encoding='utf-8-sig'))
    if not isinstance(document, dict) or not isinstance(document.get('files'), list):
        raise ValueError('Managed media manifest has no file list')
    declared = document['files']
    for path, relative in ((source, 'fonts/' + source.name), (notice, 'licenses/' + notice.name)):
        rows = [row for row in declared if isinstance(row, dict) and row.get('path') == relative]
        if len(rows) != 1 or rows[0].get('bytes') != path.stat().st_size or rows[0].get('sha256') != file_hash(path):
            raise ValueError('Managed font or licence does not match the packaged manifest')
    return {'source_path': str(source), 'sha256': file_hash(source),
            'source_license_path': str(notice), 'license_sha256': file_hash(notice)}


def retain_managed_font(choice: dict, draft_path: Path) -> dict:
    """Copy verified managed bytes into the new draft without modifying or installing the source."""
    retained = {**choice}
    folder = draft_path / 'Resources' / 'fonts'
    folder.mkdir(parents=True, exist_ok=True)
    for source_key, target_key, hash_key in (
        ('source_path', 'path', 'sha256'), ('source_license_path', 'license_path', 'license_sha256')
    ):
        source = Path(choice[source_key])
        target = folder / source.name
        if source.is_symlink() or file_hash(source) != choice[hash_key]:
            raise ValueError('Managed font or licence changed before retention')
        with source.open('rb') as src, target.open('xb') as dst:
            shutil.copyfileobj(src, dst)
        if file_hash(target) != choice[hash_key] or file_hash(source) != choice[hash_key]:
            raise ValueError('Retained font or licence differs from the selected bytes')
        retained[target_key] = str(target.resolve(strict=True))
    return retained
