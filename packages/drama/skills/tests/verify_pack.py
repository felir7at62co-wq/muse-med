"""Check the actual npm archive against the exact source allowlist, offline."""
import ast
import json
from pathlib import Path
import sys
import tarfile

package = Path(__file__).resolve().parents[1]
manifest = json.loads((package / "package.json").read_text(encoding="utf-8"))

# The allowlist is default-deny, so a skill file added to the tree without a
# manifest entry would silently stop shipping. Detect that drift here; generated
# bytecode is not authored content and cannot ship either way.
def authored(directory):
    return {
        path.relative_to(package).as_posix()
        for path in (package / directory).rglob("*")
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
    }


listed = {name for name in manifest["files"] if name.startswith("skills/")}
assert authored("skills") == listed, (
    f"unlisted skill files: {sorted(authored('skills') - listed)}; "
    f"listed but absent: {sorted(listed - authored('skills'))}"
)
expected = {"package/" + name for name in ["package.json", *manifest["files"]]}
with tarfile.open(sys.argv[1], "r:gz") as archive:
    members = archive.getmembers()
    assert {item.name for item in members} == expected, "archive differs from exact allowlist"
    assert len(members) == len(expected), "duplicate archive entries"
    for item in members:
        assert item.isfile(), f"non-file archive member: {item.name}"
        relative = Path(item.name).relative_to("package")
        assert not any(part in {"..", "__pycache__", ".env", "node_modules", "media", "index"} for part in relative.parts)
        data = archive.extractfile(item).read()
        assert data == (package / relative).read_bytes(), f"stale archive member: {relative}"
        if relative.suffix == ".py":
            ast.parse(data, filename=str(relative), feature_version=(3, 11))
            assert b"aa-manju" not in data
            if "jubian-asset-library" in relative.parts:
                assert b"pipeline.env" not in data
    print(f"PASS: {len(members)} exact allowlisted files; no links, caches, credentials, binaries or user media")
