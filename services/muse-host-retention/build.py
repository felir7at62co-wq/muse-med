"""Compile and package the private Python service without workspace dependencies."""

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile

from engine import code_hash


def build(output):
    """Create a reproducible archive and verify all Python sources compile before packaging."""
    root=Path(__file__).parent
    files={path.name:path.read_bytes() for path in sorted(root.iterdir()) if path.is_file() and path.suffix in ('.py','.json','.md','.yaml') and path.name!='bundle-inputs.json'}
    for name,raw in files.items():
        if name.endswith('.py'):compile(raw,name,'exec')
    manifest={'code':code_hash(),'files':{name:hashlib.sha256(raw).hexdigest() for name,raw in files.items()}}
    files['bundle-inputs.json']=(json.dumps(manifest,sort_keys=True,indent=2)+'\n').encode()
    output=Path(output);output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('wb') as handle,gzip.GzipFile(filename='',fileobj=handle,mode='wb',mtime=0) as compressed,tarfile.open(fileobj=compressed,mode='w') as archive:
        for name,raw in sorted(files.items()):
            info=tarfile.TarInfo(name);info.size=len(raw);info.mode=0o644
            archive.addfile(info,io.BytesIO(raw))
    return {'code':manifest['code'],'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'files':len(files),'archive':str(output)}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    print(json.dumps(build(parser.parse_args().output)))
