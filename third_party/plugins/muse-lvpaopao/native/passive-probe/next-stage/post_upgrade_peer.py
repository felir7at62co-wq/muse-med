"""Bounded post-upgrade peer authorization; no native commands before commitment."""
from __future__ import annotations

import asyncio
import time
from websockets.protocol import State


async def _join(task):
    """Finish an owned task even when the waiting handler is repeatedly cancelled."""
    while not task.done():
        try:await asyncio.shield(task)
        except asyncio.CancelledError:continue
    return task.result()


def make_post_upgrade_gate(base_gate,require_peer,ProbeFailure,host):
    """Use the original exact checker twice without blocking HTTP 101 on OS work."""
    class PostUpgradeGate(base_gate):
        def __init__(self,config,guard,state,deadline):
            super().__init__(config,guard,state)
            self.deadline=deadline;self.candidate=None

        def stopping(self):
            return self.closed or self.state.stopping or self.state.done.is_set()

        def address(self,connection):
            value=connection.remote_address
            return value if isinstance(value,tuple) and len(value)>=2 and value[0]==host and type(value[1]) is int and 1<=value[1]<=65535 else None

        async def process_request(self,connection,_request):
            if self.stopping():
                self.reject('stopping');return connection.respond(503,'Probe stopping')
            if self.address(connection) is None:
                self.reject('addressRejected',{'checks':{'loopbackAddress':False}})
                return connection.respond(403,'Peer rejected')
            if self.claimed or self.candidate is not None:
                self.reject('alreadyClaimed');return connection.respond(409,'Peer already selected')
            return None

        def alive(self,connection,closed):
            return connection.state is State.OPEN and not closed.done()

        def details(self,progress):
            return {'stage':progress['stage'],'elapsedMs':max(0,min((1<<32)-1,int((time.monotonic()-progress['started'])*1000)))}

        async def prove(self,connection,closed,jobs):
            progress={'started':time.monotonic(),'stage':'hash'}
            def on_stage(value):
                if value in {'hash','preflight-powershell','predicate'}:progress['stage']=value
            async def outcome():
                # A shielded task must not retain raw subprocess exception text.
                try:return True,await asyncio.to_thread(require_peer,self.config,connection.remote_address[1],self.guard,on_stage),None
                except ProbeFailure as error:
                    reason='PowerShellFailed' if str(error)=='peer-powershell-failed' else str(error) if str(error) in {'peer-connection-unavailable','root-unavailable'} else 'rootPredicate'
                    return False,None,(reason,error.details)
                except Exception:return False,None,('peerCheckFailed',self.details(progress))
            remaining=self.deadline-time.monotonic()
            if remaining<=0:
                self.reject('openTimeout',self.details(progress));return None
            job=asyncio.create_task(outcome());jobs.append(job)
            done,_=await asyncio.wait({job,closed},timeout=remaining,return_when=asyncio.FIRST_COMPLETED)
            if not self.alive(connection,closed):
                self.reject('peer-connection-unavailable',self.details(progress));return None
            if job not in done:
                self.reject('openTimeout',self.details(progress));return None
            valid,proof,error=job.result()
            if not valid:
                self.reject(*error);return None
            return proof

        async def wait_target(self,connection,closed,waiters):
            target=asyncio.create_task(self.state.hook_enabled.wait());waiters.append(target)
            remaining=self.deadline-time.monotonic()
            if remaining<=0:
                self.reject('waitTargetTimeout',{'checks':{'targetEnabled':False}});return False
            done,_=await asyncio.wait({target,closed},timeout=remaining,return_when=asyncio.FIRST_COMPLETED)
            if not self.alive(connection,closed):
                self.reject('peer-connection-unavailable');return False
            if target not in done:
                self.reject('waitTargetTimeout',{'checks':{'targetEnabled':False}});return False
            return True

        async def authorize(self,connection):
            authorized=False;reserved=False;jobs=[];waiters=[];closed=None
            async def wait_closed():
                try:await connection.wait_closed()
                except Exception as error:
                    pass  # A transport error is still a closed, unauthorized candidate.
            async def release():
                for job in jobs:await _join(job)
                for waiter in waiters:
                    if not waiter.done():waiter.cancel()
                if waiters:await asyncio.gather(*waiters,return_exceptions=True)
                if not authorized:
                    try:await connection.close(code=1008,reason='Peer rejected')
                    except Exception as error:
                        pass  # The server's outer cleanup also closes failed transports.
                if closed is not None:
                    if not closed.done():closed.cancel()
                    await asyncio.gather(closed,return_exceptions=True)
                if reserved:
                    async with self.lock:
                        if self.candidate is connection:self.candidate=None
            try:
                async with self.lock:
                    if self.stopping():self.reject('stopping');return False
                    if self.address(connection) is None:
                        self.reject('addressRejected',{'checks':{'loopbackAddress':False}});return False
                    if self.claimed or self.candidate is not None:
                        self.reject('alreadyClaimed');return False
                    self.candidate=connection;reserved=True
                closed=asyncio.create_task(wait_closed())
                if not self.alive(connection,closed):
                    self.reject('peer-connection-unavailable');return False
                proof=await self.prove(connection,closed,jobs)
                if proof is None or self.stopping():return False
                if not await self.wait_target(connection,closed,waiters):return False
                proof=await self.prove(connection,closed,jobs)
                if proof is None:return False
                async with self.lock:
                    if self.stopping():self.reject('stopping');return False
                    if not self.alive(connection,closed):
                        self.reject('peer-connection-unavailable');return False
                    self.state.peer=proof;self.claimed=True;authorized=True
                    return True
            except asyncio.CancelledError:
                self.reject('stopping' if self.stopping() else 'openTimeout')
                return False
            finally:
                await _join(asyncio.create_task(release()))
    return PostUpgradeGate
