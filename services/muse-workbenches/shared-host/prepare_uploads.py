"""Point the original container upload directories at the configured host volume."""
import argparse
import re
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("backend", type=Path)
args = parser.parse_args()
for path in (args.backend / "app").rglob("*.py"):
    text = path.read_text()
    def directory(match):
        suffix = match[1].lstrip("/")
        base = 'Path(os.environ["UPLOADS_DIR"])'
        return base if not suffix else f'({base} / "{suffix}")'
    mounted = re.sub(r'Path\("/app/uploads([^"]*)"\)', directory, text)
    if mounted != text:
        if not re.search(r"^import os(?:\s|$)", mounted, re.M):
            mounted = mounted.replace("from pathlib import Path", "import os\nfrom pathlib import Path", 1)
        if "import os" not in mounted:
            raise ValueError(f"Unsupported upload module {path.name}")
        path.write_text(mounted)

# These links go directly into native image tags and downloadable file URLs.
for filename, prefixes in {
    "draft_cover/routes.py": ("drafts/uploads/draft-covers/",),
    "features/theme_routes.py": ("uploads/themes/", "uploads/preset-backgrounds/"),
    "dev_image/routes.py": ("dev/ui-mockups/", "dev/design-v2/"),
    "production_image/routes.py": ("admin-api/production-images/static/",),
}.items():
    path = args.backend / "app" / filename
    text = path.read_text()
    for prefix in prefixes:
        start = 'f"/v1/' + prefix
        public = 'f"/jubengongfang/v1/' + prefix
        if start not in text and public not in text:
            raise ValueError(f"Unsupported public media URL in {filename}")
        text = text.replace(start, public)
    path.write_text(text)
