"""Mount the original 2026-11-17 frontends below the two Muse paths."""
from pathlib import Path
import argparse
import re


def replace(path, old, new):
    text = path.read_text()
    if new in text:
        return
    if text.count(old) != 1:
        raise ValueError(f"Unsupported frontend hook in {path}")
    path.write_text(text.replace(old, new))


def mount_workshop(web):
    config = web / "next.config.mjs"
    replace(config, "  reactStrictMode: false,", '  basePath: "/jubengongfang",\n  output: "standalone",\n  reactStrictMode: false,')
    # Next Link and router navigation already honor basePath. Native anchors, fetch and iframe attributes do not.
    for root in ("app", "components", "hooks", "lib"):
        for path in (web / root).rglob("*"):
            if path.suffix not in {".ts", ".tsx", ".css"}:
                continue
            text = path.read_text()
            text = re.sub(r"""(location\.href\s*=\s*|location\.(?:replace|assign)\(\s*|window\.open\(\s*)(['"`])/(?!/|jubengongfang)""",
                          r"\1\2/jubengongfang/", text)
            text = re.sub(r"""(\bsrc=\{?['"`])/(?!/|jubengongfang)""", r"\1/jubengongfang/", text)
            text = re.sub(r"""(<a\s+[^<>\n]*?\bhref=\{?['"`])/(?!/|jubengongfang)""", r"\1/jubengongfang/", text)
            text = re.sub(r"""(\bfetch\(\s*|new EventSource\(\s*)(['"`])/(v1|api)/""", r"\1\2/jubengongfang/\3/", text)
            text = re.sub(r"""(window\.location\.pathname(?:\s*===\s*|\.startsWith\(\s*)['"])/(v2|login)""", r"\1/jubengongfang/\2", text)
            if path.read_text() != text:
                path.write_text(text)
    # Dynamic link targets in the native account menu come from the application's root-relative menu definitions.
    nav = web / 'app' / '_UserNav.tsx'
    replace(nav, 'href={item.href}', 'href={item.href?.startsWith("/") ? "/jubengongfang" + item.href : item.href}')
    for route in ("login", "register"):
        (web / "app" / route / "page.tsx").write_text('import { redirect } from "next/navigation";\nexport default function Page() { redirect("/jubengongfang/"); }\n')


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
    parser.add_argument("--workshop", type=Path, required=True)
    parser.add_argument("--studio", type=Path, required=True)
    args = parser.parse_args()
    mount_workshop(args.workshop)
    mount_studio(args.studio)
