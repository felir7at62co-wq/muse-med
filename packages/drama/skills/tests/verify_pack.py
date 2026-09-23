"""Check the actual npm archive against the exact source allowlist, offline."""
import ast
import json
from pathlib import Path
import sys
import tarfile

package = Path(__file__).resolve().parents[1]
manifest = json.loads((package / "package.json").read_text(encoding="utf-8"))

# All authored skill resources must ship except the retained, non-product XHS
# directory. Bytecode and the .gitignore-owned local ASR cache are not source.
def authored(directory):
    return {
        path.relative_to(package).as_posix()
        for path in (package / directory).rglob("*")
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
        and path.relative_to(package / directory).parts[0] != "xiaohongshu-reference"
        and not path.is_relative_to(package / "skills/tweet-drama-draft-build/models")
    }


listed = {name for name in manifest["files"] if name.startswith("skills/")}
expected = {"package/" + name for name in ["package.json", *manifest["files"]]}
with tarfile.open(sys.argv[1], "r:gz") as archive:
    members = archive.getmembers()
    assert not any(item.name.startswith("package/skills/xiaohongshu-reference/") for item in members), "XHS must not ship"
    assert authored("skills") == listed, (
        f"unlisted skill files: {sorted(authored('skills') - listed)}; "
        f"listed but absent: {sorted(listed - authored('skills'))}"
    )
    assert {item.name for item in members} == expected, "archive differs from exact allowlist"
    assert len(members) == len(expected), "duplicate archive entries"
    for item in members:
        assert item.isfile(), f"non-file archive member: {item.name}"
        relative = Path(item.name).relative_to("package")
        assert not any(part in {"..", "__pycache__", ".env", "node_modules", "media", "index", "models"} for part in relative.parts)
        data = archive.extractfile(item).read()
        source = (package / relative).read_bytes()
        if relative.as_posix() == "package.json":
            # pnpm serializes package metadata without its source file's final newline.
            assert data.rstrip(b"\n") == source.rstrip(b"\n"), "stale archive manifest"
        else:
            assert data == source, f"stale archive member: {relative}"
        if relative.suffix == ".py":
            ast.parse(data, filename=str(relative), feature_version=(3, 11))
            assert b"aa-manju" not in data
            if "jubian-asset-library" in relative.parts:
                assert b"pipeline.env" not in data
    print(f"PASS: {len(members)} exact allowlisted files; no links, caches, credentials, dependency trees or stray media directories")
