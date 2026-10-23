"""A local close must finish even while the caller keeps its pipe open."""
from pathlib import Path
import subprocess
import sys
import textwrap
import unittest


class Tests(unittest.TestCase):
    def test_valid_close_stops_the_reader_before_interpreter_shutdown(self):
        root=Path(__file__).parent.resolve()
        script=textwrap.dedent('''
            import asyncio,importlib.util,sys
            from types import SimpleNamespace
            from pathlib import Path
            root=Path(sys.argv[1])
            spec=importlib.util.spec_from_file_location('close_test_host',root/'run-persistent-host.py')
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            class Base:
                def __init__(self,config,send):self.config=config;self.done=asyncio.Event()
            async def main():
                protocol=module.make_protocol(SimpleNamespace(IdentityProtocol=Base),[],None,None)
                state=protocol({},None)
                await asyncio.wait_for(state.done.wait(),2)
                await state.shutdown()
                await asyncio.to_thread(state.reader_thread.join,1)
                assert not state.reader_thread.is_alive()
                assert state.status=='control-close'
                print('closed-cleanly',flush=True)
            asyncio.run(main())
        ''')
        process=subprocess.Popen([sys.executable,'-B','-c',script,str(root)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            process.stdin.write(b'{"protocol":1,"type":"close"}\n');process.stdin.flush()
            self.assertEqual(process.wait(timeout=5),0)
            self.assertEqual(process.stdout.read(),b'closed-cleanly\n')
            self.assertEqual(process.stderr.read(),b'')
        finally:
            if process.poll() is None:process.kill();process.wait()
            for stream in (process.stdin,process.stdout,process.stderr):stream.close()
