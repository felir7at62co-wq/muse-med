#!/usr/bin/env python3
"""静态自检：找出**导入了本地模块里并不存在的名字**的写法。

## 为什么要有这个脚本

2026-10-13 发现高清放大整条链路**在 dev 和 prod 同源同坏、100% 失败**，
线上原文：

    cannot import name '_probe_wh' from 'app.media'

`app/upscale_jobs.py` 写的是

    from .media import _probe_duration, _probe_wh, ensure_local_async, make_thumb

而 `_probe_wh` 的实现一直在 `app/desub_jobs.py`，**`media.py` 里从没有过这个名字**
（`git log -S'_probe_wh' -- app/media.py` 零输出）。

它躲过了全部既有防线：

  · `py_compile` 通过 —— 语法没错；
  · **模块导入也通过** —— 因为那句 import 写在 `_one()` **函数体内**（惰性导入），
    模块级 import 时根本不执行到它；
  · 既有的 `check_self_misuse.py` 不管这类问题（它只管 `self` 可见性）；
  · 服务照常启动、健康检查全绿。

只有用户真点了「高清放大」那一刻才炸。这正是"惰性导入"最危险的地方：
**它把导入错误从"启动时"推迟到了"用到时"**，而启动时才是有人看守的时刻。

## 判定口径

对每个 `from <本地模块> import a, b, c as d`：

  1. 解析出 `<本地模块>` 对应的 `.py` 文件（支持相对层级 `..`）；
  2. 收集该文件**顶层可见的名字**（def / class / 赋值 / import 转出，
     含 `if`/`try` 等顶层分支体内的定义 —— 它们确实可能只在一个分支里定义）；
  3. 逐个核对 `a`、`b`、`d` 是否在其中。

拿不到源码的模块（第三方库、动态拼出来的路径）一律**跳过**，不误报。

## 严重度分级

  · **惰性导入**（写在函数体内）→ 报 `LAZY`，**exit 1**。这是本脚本存在的理由。
  · 模块级导入且该模块会被加载 → 启动时就会炸，属"看得见的错"，
    报 `TOP`，同样计入失败（顺手修掉不亏）。

## 用法

    python3 backend/scripts/check_lazy_imports.py [路径 ...]

默认扫 `backend/app`。有命中则打印并 **exit 1**，可直接挂进 pre-commit / CI。
"""
from __future__ import annotations

import ast
import os
import sys

#: 只报这些，避免扫进 node_modules / 迁移产物 / 备份
_SKIP_DIRS = {"__pycache__", ".git", "node_modules", ".venv", "venv", "backups",
              ".next", "dist", "build"}

#: 项目根（backend/）—— 相对导入只能在本包内解析
_APP_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "app"))


# --------------------------------------------------------------- 导出名收集

def _collect_exports(tree: ast.Module) -> set[str]:
    """收集一个模块**顶层可见**的名字。

    必须递归进 `if` / `try` / `with` / `for` 这类顶层分支体：名字可能只在
    其中一个分支里定义（例如"装了可选依赖才有"，或平台相关的实现）。
    但**绝不进函数体与类体** —— 那里面的名字不是模块级导出。
    """
    names: set[str] = set()

    def visit(stmts: list[ast.stmt]) -> None:
        for st in stmts:
            if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names.add(st.name)
            elif isinstance(st, ast.Assign):
                for t in st.targets:
                    _bind(t, names)
            elif isinstance(st, ast.AnnAssign):
                _bind(st.target, names)
            elif isinstance(st, (ast.AugAssign,)):
                _bind(st.target, names)
            elif isinstance(st, ast.Import):
                for a in st.names:
                    names.add(a.asname or a.name.split(".")[0])
            elif isinstance(st, ast.ImportFrom):
                for a in st.names:
                    if a.name != "*":
                        names.add(a.asname or a.name)
            # 顶层分支体：继续递归（它们确实是模块级作用域）
            elif isinstance(st, ast.If):
                visit(st.body)
                visit(st.orelse)
            elif isinstance(st, ast.Try):
                visit(st.body)
                visit(st.orelse)
                visit(st.finalbody)
                for h in st.handlers:
                    visit(h.body)
            elif isinstance(st, (ast.With, ast.AsyncWith, ast.For, ast.AsyncFor,
                                 ast.While)):
                visit(st.body)
                visit(st.orelse)

    def _bind(target: ast.expr, out: set[str]) -> None:
        """从赋值目标里取名字，支持 `a, b = ...` 与 `a = b = ...`。"""
        if isinstance(target, ast.Name):
            out.add(target.id)
        elif isinstance(target, (ast.Tuple, ast.List)):
            for e in target.elts:
                _bind(e, out)

    visit(tree.body)
    return names


# --------------------------------------------------------------- 模块解析

class Resolver:
    """把 `(当前文件, level, module)` 解析成磁盘上的 .py 路径，并缓存导出名。"""

    def __init__(self) -> None:
        self._exports: dict[str, set[str] | None] = {}
        self._paths: dict[str, str | None] = {}
        #: 模块名 → 文件路径（由扫描时登记，供绝对导入 `from app.x import y` 用）
        self._known: dict[str, str] = {}

    def register(self, module_name: str, path: str) -> None:
        """登记 `app.providers.llm` → /.../app/providers/llm.py 这类映射。"""
        self._known[module_name] = path

    def file_of(self, path: str, level: int, module: str | None) -> str | None:
        """解析 import 的目标文件；解析不出返回 None（= 跳过，不误报）。"""
        if level == 0:
            # 绝对导入：只认本包内已登记的模块（如 from app.media import x）
            return self._known.get(module or "")
        # 相对导入：从当前文件所在包往上走 level-1 层
        base = os.path.dirname(os.path.abspath(path))
        for _ in range(level - 1):
            base = os.path.dirname(base)
        if module:
            base = os.path.join(base, *module.split("."))
        for cand in (base + ".py", os.path.join(base, "__init__.py")):
            if os.path.isfile(cand):
                return cand
        return None

    def exports(self, path: str) -> set[str] | None:
        """读一个文件的导出名；语法错读不出时返回 None（交给 py_compile 报）。"""
        if path in self._exports:
            return self._exports[path]
        try:
            src = open(path, encoding="utf-8").read()
        except (OSError, UnicodeDecodeError):
            self._exports[path] = None
            return None
        try:
            tree = ast.parse(src, filename=path)
        except SyntaxError:
            self._exports[path] = None
            return None
        got = _collect_exports(tree)
        self._exports[path] = got
        return got

    @staticmethod
    def has_submodule(pkg_file: str, name: str) -> bool:
        """`from . import X` 里的 X 可能是**子模块**而不是包里的符号。

        `from .. import access`（app/routers/shots.py）解析到的目标是
        `app/__init__.py`，而 `access` 根本不在那里面 —— 它是 `app/access.py`
        这个子模块。不认这一条就会把满仓正常的 `from . import <子模块>`
        全判成错误，检查器一旦狼来了就没人看它了。
        """
        if os.path.basename(pkg_file) != "__init__.py":
            return False
        pkgdir = os.path.dirname(pkg_file)
        return (os.path.isfile(os.path.join(pkgdir, name + ".py"))
                or os.path.isfile(os.path.join(pkgdir, name, "__init__.py")))


# --------------------------------------------------------------- 扫描

def _module_name_of(path: str) -> str | None:
    """由文件路径推出包内模块名（app/providers/llm.py → app.providers.llm）。"""
    p = os.path.abspath(path)
    parent = os.path.dirname(_APP_DIR)
    if not p.startswith(parent + os.sep):
        return None
    rel = os.path.relpath(p, parent)
    if not rel.endswith(".py"):
        return None
    parts = rel[:-3].split(os.sep)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _in_function(tree: ast.Module) -> dict[int, bool]:
    """标出每一行 import 是否位于**函数体内**（惰性导入 = 最危险的那类）。"""
    lazy: dict[int, bool] = {}
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for sub in ast.walk(node):
            if isinstance(sub, (ast.Import, ast.ImportFrom)):
                lazy[sub.lineno] = True
    return lazy


def scan_file(path: str, res: Resolver) -> list[tuple[int, str, str, str]]:
    """返回 [(行号, 严重度, 目标模块, 缺失的名字)]。"""
    try:
        src = open(path, encoding="utf-8").read()
    except (OSError, UnicodeDecodeError):
        return []
    try:
        tree = ast.parse(src, filename=path)
    except SyntaxError:
        return []          # 语法错由 python -m py_compile 报，这里不重复

    lazy = _in_function(tree)
    found: list[tuple[int, str, str, str]] = []

    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom):
            continue
        if any(a.name == "*" for a in node.names):
            continue                      # `import *` 无法静态核对
        target = res.file_of(path, node.level, node.module)
        if not target:
            continue                      # 第三方 / 解析不出 → 跳过，不误报
        have = res.exports(target)
        if have is None:
            continue
        for a in node.names:
            if a.name in have:
                continue
            # `from . import <子模块>`：合法用法，不是"找不到符号"
            if Resolver.has_submodule(target, a.name):
                continue
            sev = "LAZY" if lazy.get(node.lineno) else "TOP"
            mod = ("." * node.level) + (node.module or "")
            found.append((node.lineno, sev, mod, a.name))
    return found


def main(argv: list[str]) -> int:
    roots = argv[1:] or [_APP_DIR]
    files: list[str] = []
    for r in roots:
        if os.path.isfile(r):
            files.append(os.path.abspath(r))
            continue
        for dirpath, dirnames, filenames in os.walk(r):
            dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
            files += [os.path.join(dirpath, f) for f in filenames
                      if f.endswith(".py") and f != "__init__.py"
                      or f == "__init__.py"]

    # 先登记所有模块名，`from app.x import y` 这类绝对导入才解析得出来
    res = Resolver()
    files = sorted({os.path.abspath(f) for f in files})
    for f in files:
        mn = _module_name_of(f)
        if mn:
            res.register(mn, f)

    lazy_hits = top_hits = 0
    for f in files:
        for line, sev, mod, name in scan_file(f, res):
            if sev == "LAZY":
                lazy_hits += 1
                print(f"{f}:{line}: [LAZY] `from {mod} import {name}` —— "
                      f"目标模块里没有 {name}。**写在函数体内**，模块导入时不会执行，"
                      f"启动/健康检查全绿，只有任务真跑起来才 ImportError")
            else:
                top_hits += 1
                print(f"{f}:{line}: [TOP]  `from {mod} import {name}` —— "
                      f"目标模块里没有 {name}")

    if lazy_hits or top_hits:
        print(f"\n✗ {lazy_hits} 处惰性导入错误 + {top_hits} 处模块级导入错误。"
              f"\n  这类错误 py_compile 查不出（语法没错）、"
              f"惰性导入连模块导入都查不出，务必改掉。")
        return 1
    print(f"✓ 已扫 {len(files)} 个文件，本地模块的导入名全部存在")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
