"""check_undefined_names.py — 全仓静态扫描「用了但没定义的变量」（2026-10-23 生产事故）

## 事故

2026-10-22 我提交 `de735a4` 时，在 `jobs._run_one` 里写了
`_owned_user_refs(override, shot)`，而那个作用域里**根本没有** `shot` 这个变量。
于是**每一次视频生成**都抛：

    UnboundLocalError: local variable 'shot' referenced before assignment

生产 21:56 重启后全部出片失败。

## 为什么既有防线没挡住

· `py_compile` / `import` 都不执行函数体，装不到；
· 我自己跑的那几个 `verify_*.py` 验收脚本走的都是**别的代码路径**（草稿导出、
  造型区间），没有一个真正调用 `run_shot_videos`；
· 事故那行在函数**深处**，只有跑到才会炸 —— 而它前面有一大坨在正常项目上
  也不会走到的分支。

静态分析是唯一能在提交前抓住它的手段。这个脚本就是那一道。

## 断什么

pyflakes 的 **undefined name** 这一类，按「本仓是否新引入」分：
  · 新增的 → 必须为 0（这就是事故那一类的口径）
  · 存量白名单 → 只报告、不算失败（先止住新错，不逼着一次清完）

跑法：python3 scripts/check_undefined_names.py [--strict]
  --strict：连存量也判失败（清干净之后开启）
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: 存量（事故之前就在的）undefined name。**只许减不许增。**
#: 新增一条 = 又埋了一个「跑到才炸」的雷。
LEGACY = {
    # 字符串形式的前向标注 `"asyncio.Lock"`，pyflakes 把字符串里的名字也算上。
    # 运行时 asyncio 在函数内 import，不会炸。
    "app/routers/shotflow.py:395:asyncio",
    # 同上：`-> "np.ndarray"` 是字符串前向标注，numpy 在函数体内 import。
    # 加这条不是在放水——不加的话脚本对**所有人**常红，真正的 undefined name
    # 就会淹没在"反正本来就红"里，这正是它存在的理由被抵消的方式。
    "app/sfx_features.py:66:np",
}

_r = subprocess.run([sys.executable, "-m", "pyflakes", "app"], cwd=ROOT,
                    capture_output=True, text=True)
# ⚠️ **必须连 stderr 一起收**：pyflakes 把语法/缩进错误写在 stderr，
# `undefined name` 才在 stdout。只取 stdout 的话下面那段语法检测永远读不到，
# 等于没加（2026-10-23 当场踩到）。
out = (_r.stdout or "") + (_r.stderr or "")

# ⚠️ **语法错误必须单独判失败**（2026-10-23 踩到）。
#
# pyflakes 遇到语法错误就**停止分析那个文件**，只报 `unexpected indent` /
# `invalid syntax` 之类。下面只挑 `undefined name` 这一种，
# 于是"语法坏掉的文件"会被静默归入"没有 undefined name" —— **假绿**。
#
# 真实例子：`f7c13ef`（10-19）把一行注释和 `class ShotGenerateIn(BaseModel):`
# 拼成了同一行，类根本没定义；pyflakes 报的是 unexpected indent，
# 这个脚本报的是 ✅ 通过，而 `/openapi.json` 从那天起 500 了两天。
syntax = []
for line in out.splitlines():
    low = line.lower()
    if ("undefined name" in line
            or not any(k in low for k in ("syntax", "indent", "unexpected", "expected"))):
        continue
    syntax.append(line.strip())

hits = []
for line in out.splitlines():
    # 形如 `app/jobs.py:1743:66: undefined name 'shot'`
    if "undefined name" not in line:
        continue
    head, _, name = line.partition("undefined name")
    file, _, rest = head.partition(":")
    lineno = rest.lstrip(":").split(":")[0]
    nm = name.strip().strip("'\"")
    hits.append((f"{file}:{lineno}:{nm}", line.strip()))

if syntax:
    for raw in syntax:
        print(f"  ❌ 语法/缩进错误：{raw}")
    print(f"\n❌ {len(syntax)} 处语法错误 —— 这些文件 pyflakes **根本没分析完**，"
          f"下面的 undefined name 结果不可信。先修语法。")
    sys.exit(1)

if not hits:
    print("✅ 没有 undefined name")
    sys.exit(0)

new = [h for h in hits if h[0] not in LEGACY]
legacy = [h for h in hits if h[0] in LEGACY]
for key, raw in legacy:
    print(f"  · 存量：{raw}")
for key, raw in new:
    print(f"  ❌ 新增：{raw}")

print()
if new:
    print(f"❌ {len(new)} 处**新引入**的 undefined name —— 会在运行时抛 "
          f"UnboundLocalError/NameError。既有检查全都拦不住这类错误。")
    sys.exit(1)
if legacy and "--strict" in sys.argv:
    print(f"❌ 严格模式：还有 {len(legacy)} 处存量 undefined name")
    sys.exit(1)
print(f"✅ 通过：新增 0 处（存量 {len(legacy)} 处，见脚本里的 LEGACY 白名单）")
