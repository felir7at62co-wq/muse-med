"""Attach shared character references to the original Jingliu library routes and gallery."""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def changes(backend, frontend, transform, files):
    library = backend / "app/routers/library.py"
    files[backend / "app/muse_references.py"] = (HERE / "muse_references.py").read_text(encoding="utf-8")
    anchor = '@router.get("/library")\ndef list_library('
    wrapper = '''from ..muse_references import shared_page


@router.get("/library")
def list_library(kind: Optional[str] = None, q: Optional[str] = None,
                 mine: bool = False, with_image: bool = True,
                 scope: str = "all", sort: str = "default", limit: int = 120, offset: int = 0,
                 importable_only: bool = False) -> dict:
    return shared_page(_native_library, kind=kind, q=q, mine=mine, with_image=with_image, scope=scope,
                       sort=sort, limit=limit, offset=offset, importable_only=importable_only)


def _native_library('''
    transform(library, anchor, wrapper)
    anchor = '        access.require_project_access(session, body.project_id)\n        uid = access.current_user_id()'
    transform(library, anchor, anchor.replace('        uid', '        if any(aid.startswith("mref-") for aid in ids):\n'
              '            raise HTTPException(409, "所选角色为创作参考素材，不能直接绑定到项目。")\n        uid'))
    if frontend is None:
        return
    api = frontend / "api.js"
    transform(api, "kind, q, mine, scope, sort, limit, offset } = {}) => get('/library?'",
              "kind, q, mine, scope, sort, limit, offset, importableOnly } = {}) => get('/library?'")
    anchor = "...(mine ? { mine: 'true' } : {}),"
    transform(api, anchor, anchor + "\n    ...(importableOnly ? { importable_only: 'true' } : {}),")
    entry = frontend / "app.js"
    transform(entry, "kind: LP.kind, q: LP.q, limit: LP.limit, offset: LP.offset,",
              "kind: LP.kind, q: LP.q, limit: LP.limit, offset: LP.offset, importableOnly: true,")
    transform(entry, "kind, q, limit: IMP_PAGE, offset,", "kind, q, limit: IMP_PAGE, offset, importableOnly: true,")
    transform(entry, 'const where = e.mine\n', "const where = e.reference_only ? esc(e.prompt || '创作参考') : e.mine\n")
    transform(entry, '${S.pid ? `<button class="ghost sm" data-libimp', '${S.pid && !e.reference_only ? `<button class="ghost sm" data-libimp')
