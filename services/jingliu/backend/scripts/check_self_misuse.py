#!/usr/bin/env python3
"""静态自检：找出**非方法函数里引用 `self`** 的写法。

## 为什么要有这个脚本

2026-10-06 给 seedance 加"多段参考音频"时，在 `@staticmethod _build_audios`
里写了 `self.max_reference_audios`。Python 只在**执行到那一行**才报
`NameError: name 'self' is not defined`，于是：

  · `py_compile` / 导入模块都**通过**（语法没错）；
  · 40 多项冒烟测试也通过（没人调那个分支）；
  · 一路合进生产并重启，**全项目分镜视频 100% 生成失败**。

这类错误本该由 lint 兜住（ruff/pyflakes 的 F821 会直接报 undefined name
`self`），但本仓既没有 lint 配置也没有 CI —— 这个脚本就是补那道闸。

## 判定口径

一个函数**只在**下面两种情况下才允许引用 `self`：
  1. 它是方法（首个位置参数名为 `self`）；
  2. 它被装饰器包着，而装饰器把 self 塞进了作用域（本仓没有这种用法）。

其余一律报错，**包括 `@staticmethod` / `@classmethod` / 模块级函数 /
类体内嵌套的普通函数**。嵌套函数例外：若它落在某个方法内部，`self` 是
闭包变量，是合法的 —— 所以按"最近的定义作用域"判断，而不是只看它自己。

## 用法

    python3 backend/scripts/check_self_misuse.py [路径 ...]

默认扫 `backend/app`。有命中则打印并 **exit 1**，可直接挂进 pre-commit / CI。
"""
from __future__ import annotations

import ast
import os
import sys

#: 只报这些，避免扫进 node_modules / 迁移产物 / 备份
_SKIP_DIRS = {"__pycache__", ".git", "node_modules", ".venv", "venv", "backups",
              ".next", "dist", "build"}


def _is_method(node: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    a = node.args
    pos = list(a.posonlyargs) + list(a.args)
    return bool(pos) and pos[0].arg == "self"


def scan_file(path: str) -> list[tuple[int, str, int]]:
    """返回 [(函数定义行, 函数名, self 引用行)]。"""
    try:
        src = open(path, encoding="utf-8").read()
    except (OSError, UnicodeDecodeError):
        return []
    try:
        tree = ast.parse(src, filename=path)
    except SyntaxError:
        return []          # 语法错由 python -m py_compile 报，这里不重复

    found: list[tuple[int, str, int]] = []

    def walk(node: ast.AST, in_method: bool) -> None:
        """in_method：当前是否处于**能取到 self** 的作用域里。

        注意 `self` 的可见性由**最近的外层函数**决定，不是由"是不是类成员"：
        嵌套在方法里的函数通过闭包拿得到 self，是合法的。
        所以进类体不改 in_method，进方法才把它置 True。
        """
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                now_method = _is_method(child)
                if not now_method and not in_method:
                    for sub in ast.walk(child):
                        if (isinstance(sub, ast.Name) and sub.id == "self"
                                and isinstance(sub.ctx, ast.Load)):
                            found.append((child.lineno, child.name, sub.lineno))
                # 进这一层之后的可见性：本身是方法 → True；
                # 否则**继承外层**（嵌套在方法里仍可见）
                walk(child, now_method or in_method)
            elif isinstance(child, ast.ClassDef):
                walk(child, in_method)      # 进类体不改变可见性
            else:
                walk(child, in_method)

    walk(tree, False)
    return found


def main(argv: list[str]) -> int:
    roots = argv[1:] or [os.path.join(os.path.dirname(__file__), "..", "app")]
    files: list[str] = []
    for r in roots:
        if os.path.isfile(r):
            files.append(r)
        else:
            for dirpath, dirnames, filenames in os.walk(r):
                dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
                files += [os.path.join(dirpath, f) for f in filenames
                          if f.endswith(".py")]

    hits = 0
    for f in sorted(files):
        for def_line, fname, use_line in scan_file(f):
            hits += 1
            print(f"{f}:{use_line}: 函数 {fname}()（定义在 {def_line} 行）"
                  f"引用了 self，但它不是方法 —— 运行到这一行必然 NameError")
    if hits:
        print(f"\n✗ {hits} 处 self 误用。这类错误 py_compile 查不出、"
              f"只有跑到那一行才炸，务必改掉。")
        return 1
    print(f"✓ 已扫 {len(files)} 个文件，没有非方法函数引用 self")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
