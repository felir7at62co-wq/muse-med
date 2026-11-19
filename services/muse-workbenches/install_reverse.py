"""Wire every native Workshop video-to-screenplay intake to the shared Muse episode runner."""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def changes(backend, transform, files):
    app = backend / "app"
    for name in ("muse_reverse.py", "reverse_routes.py", "reverse_storage.py"):
        files[app / name] = (HERE / name).read_text()
    pipeline = app / "video/video_pipeline.py"
    def patch(before, after):
        transform(pipeline, before, after)
    patch("from .doubao_video import analyze_video_file", "from ..muse_reverse import analyze_video_file, reserve_revisions")
    patch('    source_kind: str = "local",', '    revision: str | None = None,\n    source_kind: str = "local",')
    for scheme in ("oss_key=video_source", "video_path=video_source"):
        patch(scheme + ",", scheme + ", revision=revision,")
    patch("    max_attempts = 2", "    max_attempts = 1")
    patch("    skip_existing: bool = False,", "    skip_existing: bool = False,\n    revision: str | None = None,")
    patch("    if not items:\n        return\n", "    if not items:\n        return\n    if revision:\n        await reserve_revisions(draft_id, [item[0] for item in items], revision)\n")
    patch('    return {int(o) for o, t in rows if o is not None and (t or "").strip()}',
          '        draft = await s.get(ScriptDraft, draft_id)\n'
          '        pending = ((draft.outline or {}).get("muse_reverse_pending") or {}) if draft else {}\n'
          '    return {int(o) for o, t in rows if o is not None and (t or "").strip() and str(o) not in pending}')
    for people in ("all_characters", "baseline_chars"):
        # The two branches have different indentation in the archive.
        indent = " " * (20 if people == "all_characters" else 24)
        old = f"draft_id, order, src, draft_title, {people},\n{indent}model=model, source_kind=kind, user_id=user_id,"
        patch(old, old + " revision=revision,")
    insertion = """        draft = await s.get(ScriptDraft, draft_id, with_for_update=True)
        outline = dict(draft.outline or {})
        pending = dict(outline.get("muse_reverse_pending") or {})
        expected = pending.pop(str(episode_order), None)
        if expected and expected != result["muse_materials"]["revision"]:
            raise RuntimeError("本集已有更新的反推任务")
        if pending:
            outline["muse_reverse_pending"] = pending
        else:
            outline.pop("muse_reverse_pending", None)
        outputs = dict(outline.get("muse_reverse") or {})
        outputs[str(episode_order)] = result["muse_materials"]
        outline["muse_reverse"] = outputs
        draft.outline = outline
"""
    patch("        # chapter(如果已存在就覆盖)", insertion + "        # chapter(如果已存在就覆盖)")
    api = app / "features/video_routes.py"
    anchor = 'router = APIRouter(prefix="/v1", tags=["video"])'
    transform(api, anchor, "from ..reverse_routes import require_reverse, router as muse_materials_router\n\n" + anchor + "\nrouter.include_router(muse_materials_router)")
    for route in ("upload", "from-url", "from-oss", "drafts/{draft_id}/retry-failed", "drafts/{draft_id}/resume"):
        old = f'@router.post("/video/{route}")'
        transform(api, old, f'@router.post("/video/{route}", dependencies=[Depends(require_reverse)])')
    transform(api, "skip_existing=not payload.redo_done,", "skip_existing=not payload.redo_done,\n                revision=uuid.uuid4().hex if payload.redo_done else None,")
    transform(api, "即将用豆包原画质整片反推(直读 TOS)", "即将用 Muse 核对原声、字幕与画面")
    transform(api, "豆包原画质整片反推(直读 TOS, 无需切片)已启动", "Muse 逐集反推已启动")
    for declaration in ("Form", "Field"):
        transform(api, f'{declaration}("", description="留空即用 ark_video_understand_model(豆包)")',
                  f'{declaration}("", description="兼容已有客户端，反推使用工坊的 Muse 模型配置")')
    # Remove a batch directory only when all its inputs have already been released by successful episodes.
    def cleanup(path, begin, end, replacement):
        source = files.get(path, path.read_text())
        if replacement in source:
            return
        if source.count(begin) != 1:
            raise ValueError(f"Unsupported video cleanup in {path.name}")
        start = source.index(begin)
        stop = source.index(end, start)
        transform(path, source[start:stop], replacement)

    empty = "            if batch_dir.is_dir() and not any(batch_dir.iterdir()):\n                batch_dir.rmdir()\n"
    cleanup(api, "            # 清理批次目录(成功集", "            _bg_tasks.pop", empty)
    cleanup(api, "            # 反推后清理原始下载文件", "            _bg_tasks.pop", "            # 用户选择保留片源时保留下载目录。\n" + empty)
    transform(api, '                model=model,\n                concurrency=1,\n                cleanup_files=True,',
              '                model=model,\n                concurrency=1,\n                cleanup_files=delete_source,')
    tikhub = app / "tikhub/routes.py"
    hook = "async def download(payload: DownloadIn, user: User = Depends(get_current_user)):\n"
    transform(tikhub, hook, hook + '    if payload.mode == "draft":\n        from ..reverse_routes import require_reverse\n        require_reverse()\n')
    transform(tikhub, "                shutil.rmtree(batch_dir, ignore_errors=True)",
              "                if batch_dir.is_dir() and not any(batch_dir.iterdir()):\n                    batch_dir.rmdir()")


def frontend_changes(frontend, transform, files):
    """Preserve the original upload modal and large-file resumable upload flow."""
    module = "workshop_video_intake.ts"
    files[frontend / "lib" / module] = (HERE / module).read_text()
    modal = frontend / "app/drafts/_VideoUploadModal.tsx"
    directive = '"use client";'
    transform(modal, directive, directive + '\nimport { submitWorkshopVideo } from "@/lib/workshop_video_intake";')
    hook = "  const ctrlsRef = useRef<Map<string, UploadController>>(new Map());"
    transform(modal, hook, hook + "\n  const serverUpload = useRef<AbortController | null>(null);")
    start = "      for (let i = 0; i < files.length; i++) {"
    finish = "      if (!r.ok) {"
    marker = "      const r = await submitWorkshopVideo("
    source = files.get(modal, modal.read_text())
    if marker not in source:
        if source.count(start) != 1:
            raise ValueError("Unsupported Workshop video upload loop")
        first = source.index(start)
        last = source.index(finish, first)
        original = source[first:last]
        callback = original.replace("const r = await fetch(", "return fetch(")
        if callback == original:
            raise ValueError("Missing Workshop draft upload response")
        callback = "\n".join("  " + line if line else "" for line in callback.splitlines())
        replacement = ("      const controller = new AbortController();\n      serverUpload.current = controller;\n" + marker
                       + "\n        BASE, token, files.map(item => item.file), title, concurrency, controller.signal, async () => {\n"
                       + callback + "\n      });\n")
        transform(modal, original, replacement)
    transform(modal, "    for (const ctrl of ctrlsRef.current.values()) ctrl.abort();",
              "    serverUpload.current?.abort();\n    for (const ctrl of ctrlsRef.current.values()) ctrl.abort();")
    transform(modal, "OSS 直传 · 支持 50GB 大文件 · 支持断点续传", "按列表顺序逐集反推")
