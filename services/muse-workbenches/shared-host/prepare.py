"""Mount the original 2026-11-17 Jingliu frontend below its Muse path."""
from pathlib import Path
import argparse


def replace(path, old, new):
    text = path.read_text()
    if new in text:
        return
    if text.count(old) != 1:
        raise ValueError(f"Unsupported frontend hook in {path}")
    path.write_text(text.replace(old, new))


def mount_studio(site):
    replace(site / "api.js", "location.pathname.startsWith('/sfp')", "location.pathname.startsWith('/jingliu/sfp')")
    replace(site / "api.js", "'/fwp/v2' : '/fw/v2'", "'/jingliu/fwp/v2' : '/jingliu/fw/v2'")
    replace(site / "api.js", "u.replace(/^\\/fw\\//, '/fwp/')", "u.replace(/^\\/fwp?\\//, '/jingliu/fwp/')")
    replace(site / "app.js", "location.assign('/fwp/v2/auth/muse/login')", "location.assign('/jingliu/')")
    replace(site / "index.html", 'id="btn-new-project">', 'id="btn-new-project" disabled>')
    replace(site / "app.js", "  $('#btn-new-project').onclick = newProject;",
            "  $('#btn-new-project').onclick = newProject;\n  $('#btn-new-project').disabled = false;")
    replace(site / "app.js", "  openModal('#modal-newproj');",
            "  $('#np-go').disabled = true;\n  openModal('#modal-newproj');")
    replace(site / "app.js", "  syncStyles();\n  $('#np-title').focus();",
            "  syncStyles();\n  $('#np-go').disabled = !$('#np-aspect').value || !$('#np-mode').value;\n  $('#np-title').focus();")
    # Preserve the original backend auth API. The public entry gets the verified account from the Muse gateway.
    replace(site / "index.html", 'src="/fwp/v2/auth/muse/storage.js"', 'src="/jingliu/fwp/v2/auth/muse/storage.js"')


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--studio", type=Path, required=True)
    args = parser.parse_args()
    mount_studio(args.studio)
