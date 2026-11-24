"""app/ 里的 Muse 登录适配文件与 services/muse-workbenches 中的同名文件逐字节相同。"""
from pathlib import Path

import pytest

_APP = Path(__file__).resolve().parents[1] / "app"
_WORKBENCHES = Path(__file__).resolve().parents[3] / "muse-workbenches"


@pytest.mark.parametrize("name", ["muse_login.py", "muse_login.js", "muse_storage.js", "muse_references.py"])
def test_overlay_file_matches_the_workbench_adapter(name):
    assert (_APP / name).read_bytes() == (_WORKBENCHES / name).read_bytes()
