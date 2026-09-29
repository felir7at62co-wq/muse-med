"""Check bundled dependencies and WeChat availability without installing packages."""
import importlib
import json
import os
import platform
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C


def main():
    C.force_utf8()
    dependencies = {}
    for name in ('numpy', 'cv2', 'scipy'):
        try:
            module = importlib.import_module(name)
            dependencies[name] = getattr(module, '__version__', 'available')
        except ImportError:
            dependencies[name] = None
    ready = platform.system() == 'Windows' and bool(C.wechat_profile_root())
    report = {'platform': platform.system(), 'wechat_available': ready,
              'dependencies': dependencies, 'work_root': C.WORK_ROOT}
    os.makedirs(C.WORK_ROOT, exist_ok=True)
    with open(C.LOCK_F, 'w', encoding='utf-8') as output:
        json.dump(report, output, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False))
    if not all(dependencies.values()):
        print('Bundled media runtime is incomplete; repair the Muse installation.')
        return 1
    if not ready:
        print('Open the requested mini-program in logged-in Windows WeChat, then retry.')
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
