#!/usr/bin/env python3
"""静态自检：找出**调用了本地模块里并不存在的属性**的写法。

## 为什么要有这个脚本

2026-10-24 发现 `POST /v2/assets/{id}/qc`（资产弹窗的「视觉体检」按钮）
**必然 500，且已经坏了一个多月**。

`app/routers/look.py` 写的是

    from .. import asset_qc          # ← 模块导入，完全合法
    ...
    res = await asset_qc.check_scene(url, ...)
    res = await asset_qc.check_character(url, ...)
    summary = asset_qc.describe(res)

而 `app/asset_qc.py` 在 **2026-09-21 的 `a668d8c`** 被整份重写成了另一套判据
（本地 PIL 客观体检），`check_scene` / `check_character` / `describe` 三个函数
连同整个视觉核验一起被删掉。那次提交的意图是"新增客观体检"，不是"删掉视觉体检"——
它覆盖掉了另一个功能，而**没有任何机制发现这件事**。

它躲过了全部既有防线：

  · `py_compile` 通过 —— 语法没错；
  · **模块导入也通过** —— `from .. import asset_qc` 只要模块在就成功，
    属性是在**调用那一刻**才解析的；
  · `check_lazy_imports.py` 管不到 —— 它查的是 `from X import 名字`，
    这里名字没写进 import 语句，写的是 `X.名字`；
  · `check_self_misuse.py` 管不到 —— 没有 `self`；
  · 服务照常启动、健康检查全绿、所有冒烟测试全绿。

只有用户真点那个按钮才炸。与 `check_lazy_imports.py` 里记录的是**同一类病**：
把"必然失败"从启动时推迟到了"用到时"，而启动时才是有人看守的时刻。

## 判定口径

对每个 `from <本地模块> import X`（X 是模块，不是函数）：

  1. 解析出 `<本地模块>.X` 对应的 `.py` 文件（支持相对层级 `..`）；
  2. 收集该文件**顶层可见的名字**（def / class / 赋值 / import 转出，
     含 `if`/`try` 等顶层分支体内的定义）；
  3. 核对代码里所有 `X.属性` 的用法是否都在其中。

拿不到源码的模块（第三方库、动态拼出来的路径）一律**跳过**，不误报。

⚠️ 动态赋值的属性（`setattr` / `globals()[...] = ...` / 模块 `__getattr__`）
会被误报。本仓目前没有这种用法；真出现时在 `_ALLOW` 里加白名单。

## 用法

    python3 backend/scripts/check_module_attrs.py [路径 ...]

默认扫 `backend/app`。有命中则打印并 **exit 1**，可直接挂进 pre-commit / CI。
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

#: 已知的故意用法（模块名.属性 → 理由）。目前为空。
_ALLOW: set[str] = set()

_SKIP_DIRS = {"__pycache__", ".git", "node_modules", ".venv", "venv", "backups",
              ".next", "dist", "build"}

#: 这些是模块的天然属性，不需要在源码里定义
_BUILTIN_ATTRS = {
    "__name__", "__file__", "__doc__", "__dict__", "__package__", "__spec__",
    "__loader__", "__all__", "__path__", "__builtins__", "__version__",
    "__annotations__", "__cause__", "__traceback__",
}


def _top_level_names(tree: ast.Module) -> set[str]:
    """收集一个模块顶层可见的名字。**会下钻** if / try / with 等顶层分支体。"""
    names: set[str] = set()
    stack: list[ast.AST] = list(tree.body)
    while stack:
        n = stack.pop()
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(n.name)
            # 不下钻函数体 —— 里面的是局部名，不是模块属性
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for a in n.names:
                # `import a.b` 绑定的是 `a`；`from x import y as z` 绑定 `z`
                names.add(a.asname or a.name.split(".")[0])
        elif isinstance(n, ast.Assign):
            for t in n.targets:
                if isinstance(t, ast.Name):
                    names.add(t.id)
                elif isinstance(t, (ast.Tuple, ast.List)):
                    names.update(e.id for e in t.elts if isinstance(e, ast.Name))
        elif isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name):
            names.add(n.target.id)
        elif isinstance(n, ast.Global):
            names.update(n.names)
        # 分支体 / 异常处理体：确实可能只在这些分支里定义
        for fld in ("body", "orelse", "finalbody"):
            sub = getattr(n, fld, None)
            if isinstance(sub, list) and not isinstance(
                    n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                stack.extend(x for x in sub if isinstance(x, ast.AST))
        for h in getattr(n, "handlers", []) or []:
            stack.extend(h.body)
    return names


class _ModIndex:
    """把 `app.foo.bar` 这样的点号路径映射到源文件。"""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._cache: dict[str, set[str] | None] = {}
        self._files: dict[str, Path] = {}
        base = root / "app"
        for p in base.rglob("*.py") if base.is_dir() else []:
            parts = list(p.relative_to(root).with_suffix("").parts)
            if parts and parts[-1] == "__init__":
                parts = parts[:-1]
            if not parts:
                continue
            self._files[".".join(parts)] = p
        # 包（目录）也算一个可属性访问的模块
        for mod in list(self._files):
            if self._files[mod].name == "__init__.py":
                continue

    def names(self, dotted: str) -> set[str] | None:
        if dotted in self._cache:
            return self._cache[dotted]
        p = self._files.get(dotted)
        if p is None:
            self._cache[dotted] = None
            return None
        try:
            tree = ast.parse(p.read_text(encoding="utf-8", errors="replace"))
        except (OSError, SyntaxError):
            self._cache[dotted] = None
            return None
        got = _top_level_names(tree)
        self._cache[dotted] = got
        return got


def _resolve(pkg_parts: list[str], module: str | None, level: int) -> str | None:
    """把 `from ..x import y` 的相对层级还原成绝对点号路径（指向 x.y 或 y）。"""
    if level == 0:
        return module
    base = pkg_parts[: len(pkg_parts) - (level - 1)]
    return ".".join(base + ([module] if module else []))


def scan_file(path: Path, root: Path, idx: _ModIndex) -> list[tuple[int, str, str]]:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"),
                         filename=str(path))
    except (OSError, SyntaxError):
        return []

    rel = path.relative_to(root)
    pkg_parts = list(rel.with_suffix("").parts[:-1])

    # 本次文件里，哪些局部名绑定到了一个本地模块
    bound: dict[str, str] = {}
    for n in ast.walk(tree):
        if not isinstance(n, ast.ImportFrom):
            continue
        src = _resolve(pkg_parts, n.module, n.level or 0)
        if not src:
            continue
        for a in n.names:
            full = f"{src}.{a.name}"
            # 只有当它确实指到一个本地模块时才登记（`from .x import 函数` 不算）
            if idx.names(full) is not None:
                bound[a.asname or a.name] = full
    if not bound:
        return []

    out: list[tuple[int, str, str]] = []
    for n in ast.walk(tree):
        if not (isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name)):
            continue
        mod = bound.get(n.value.id)
        if mod is None or n.attr in _BUILTIN_ATTRS:
            continue
        known = idx.names(mod)
        if known is None:
            continue
        if n.attr not in known:
            out.append((n.lineno, f"{n.value.id}.{n.attr}", mod))
    return out


def main(argv: list[str]) -> int:
    root = Path(__file__).resolve().parent.parent      # backend/
    targets = argv or [str(root / "app")]
    idx = _ModIndex(root)

    hits: list[tuple[str, int, str, str]] = []
    for t in targets:
        p = Path(t).resolve()
        files = [p] if p.is_file() else [
            q for q in p.rglob("*.py")
            if not (_SKIP_DIRS & set(q.parts))]
        for f in files:
            for line, expr, mod in scan_file(f, root, idx):
                if expr in _ALLOW:
                    continue
                try:
                    shown = str(f.relative_to(root))
                except ValueError:
                    shown = str(f)
                hits.append((shown, line, expr, mod))

    if not hits:
        print("✅ 通过：没有调用本地模块里不存在的属性")
        return 0

    for shown, line, expr, mod in sorted(set(hits)):
        print(f"{shown}:{line}: {expr}  —— {mod} 里没有 {expr.split('.', 1)[1]}")
    print(f"\n❌ {len(set(hits))} 处")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
