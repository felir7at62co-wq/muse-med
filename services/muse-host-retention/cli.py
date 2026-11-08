"""Private host retention commands; deployment never starts a public service."""

import argparse
import json
from pathlib import Path
import re
import time

from engine import Engine, atomic, code_hash
from policy import policy_hash


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('observe','review','promote'))
    parser.add_argument('--policy',type=Path,required=True)
    parser.add_argument('--qualification',type=Path)
    args=parser.parse_args()
    engine=Engine(args.policy)
    try:
        if args.action=='observe':
            value=engine.tick()
        else:
            with engine.lock():
                report=engine.review()
                recent=engine.db.execute('SELECT MAX(at) FROM observations').fetchone()[0]
                if time.time()-recent>engine.policy['maximum_gap_seconds']:
                    raise ValueError('observer-not-running')
                if args.action=='promote':
                    if engine.policy['mode']!='dry-run' or not args.qualification:
                        raise ValueError('promotion-requires-tested-dry-run')
                    checked=json.loads(args.qualification.read_text())
                    if checked.get('code')!=code_hash() or checked.get('passed') is not True or checked.get('tests',0)<=0:
                        raise ValueError('runtime-qualification-mismatch')
                    atomic(engine.state/'approval.json',report)
                    atomic(args.policy,{**engine.policy,'mode':'enabled'})
                value={'state':'enabled' if args.action=='promote' else 'review-passed','approval':report}
                if args.action=='promote':atomic(engine.state/'review.json',value)
        print(json.dumps(value))
        return 1 if value.get('error') else 0
    except Exception as error:
        value={'state':'blocked','error':type(error).__name__}
        if isinstance(error,ValueError) and re.fullmatch('[a-z-]+',str(error)):
            value['reason']=str(error)
        if args.action=='promote':atomic(engine.state/'review.json',value)
        print(json.dumps(value));return 1
    finally:
        engine.close()


if __name__=='__main__':
    raise SystemExit(main())
