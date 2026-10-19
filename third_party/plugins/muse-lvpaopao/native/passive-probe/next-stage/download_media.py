"""Download one native-authorized public CDN resource and validate complete media."""
import hashlib
import ipaddress
import json
import math
import os
import re
from pathlib import Path
import socket
import subprocess
import time
import urllib.parse
import urllib.request

class MediaFailure(RuntimeError):pass
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*_):raise MediaFailure('redirect-not-accepted')

def _cancel(cancel_event):
    if cancel_event is not None and cancel_event.is_set():raise MediaFailure('download-cancelled')

def _stop_process(process):
    """Stop and reap only this operation's child, including termination races."""
    if process.poll() is not None:return
    try:process.terminate()
    except OSError as error:
        pass  # The child may have exited; communicate still owns reaping it.
    try:process.communicate(timeout=2)
    except (OSError,subprocess.TimeoutExpired):
        try:process.kill()
        except OSError as error:
            pass  # Still attempt to reap a child that raced termination.
        try:process.communicate(timeout=5)
        except (OSError,subprocess.TimeoutExpired):raise MediaFailure('media-process-cleanup-failed') from None

def _run_process(arguments,timeout,cancel_event,failure_code):
    """Poll cancellation while draining pipes; never return before owned child cleanup."""
    _cancel(cancel_event)
    try:process=subprocess.Popen(arguments,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    except OSError:raise MediaFailure(failure_code) from None
    deadline=time.monotonic()+timeout
    try:
        while True:
            _cancel(cancel_event)
            remaining=deadline-time.monotonic()
            if remaining<=0:raise MediaFailure(failure_code)
            try:stdout,_stderr=process.communicate(timeout=min(0.2,remaining))
            except subprocess.TimeoutExpired:continue
            _cancel(cancel_event)
            if process.returncode!=0:raise MediaFailure(failure_code)
            return stdout
    finally:_stop_process(process)

def check_url(url):
    if not isinstance(url,str) or len(url)>8192:raise MediaFailure('url-invalid')
    parsed=urllib.parse.urlsplit(url);host=parsed.hostname
    if parsed.scheme!='https' or not host or parsed.username or parsed.password or parsed.port not in (None,443):raise MediaFailure('url-invalid')
    if not (host=='1500046565.vodpreview.wxamedia.com' or host=='qq.com' or host.endswith('.qq.com') or host.endswith('.qpic.cn')):raise MediaFailure('cdn-host-unverified')
    addresses=socket.getaddrinfo(host,443,type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(row[4][0]).is_global for row in addresses):raise MediaFailure('nonpublic-cdn-address')
    return host

def download(url,output_dir,cancel_event=None,*,output_name='laoshou-episode-01.mp4'):
    """Validate complete media, with optional cooperative threading.Event cancellation.

    Socket calls retain their 20-second timeout; DNS follows the OS resolver's
    timeout. Cancellation is checked around these blocking calls and each chunk.
    Probe/decode children are stopped and reaped before cancellation is returned.
    A successful exclusive final-file creation completes the operation; subsequent
    cancellation cannot turn that completed file into an incomplete operation.
    """
    _cancel(cancel_event)
    if not isinstance(output_name,str) or len(output_name)>80 or re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]*\.mp4',output_name) is None:
        raise MediaFailure('output-name-invalid')
    host=check_url(url);_cancel(cancel_event)
    folder=Path(output_dir);folder.mkdir(parents=True,exist_ok=True)
    path=folder/output_name;partial=path.with_suffix('.part')
    if path.exists() or partial.exists():raise MediaFailure('output-already-exists')
    digest=hashlib.sha256();count=0;deadline=time.monotonic()+120
    try:
        request=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0','Referer':'https://servicewechat.com/wx404dde55fb12df78/108/page-frame.html'})
        _cancel(cancel_event)
        with urllib.request.build_opener(NoRedirect()).open(request,timeout=20) as response:
            _cancel(cancel_event)
            with partial.open('xb') as stream:
                if response.status!=200:raise MediaFailure('http-status-rejected')
                expected=response.headers.get('Content-Length')
                expected=int(expected) if expected is not None and expected.isdecimal() else None
                if expected is not None and not 1<=expected<=200*1024*1024:raise MediaFailure('declared-size-rejected')
                while True:
                    _cancel(cancel_event)
                    if time.monotonic()>deadline:raise MediaFailure('download-deadline')
                    chunk=response.read(1024*1024)
                    _cancel(cancel_event)
                    if not chunk:break
                    count+=len(chunk)
                    if count>200*1024*1024:raise MediaFailure('media-size-limit')
                    stream.write(chunk);digest.update(chunk);_cancel(cancel_event)
        _cancel(cancel_event)
        if count==0 or expected is not None and count!=expected:raise MediaFailure('media-size-mismatch')
        probe=_run_process(['ffprobe.exe','-v','error','-show_format','-show_streams','-of','json',str(partial)],30,cancel_event,'media-probe-rejected')
        try:
            info=json.loads(probe);streams=info.get('streams',[]);video=[v for v in streams if v.get('codec_type')=='video'];audio=[v for v in streams if v.get('codec_type')=='audio']
            duration=float(info.get('format',{}).get('duration','0'))
        except (ValueError,TypeError,AttributeError):raise MediaFailure('media-probe-rejected') from None
        if not video or not math.isfinite(duration) or duration<=0:raise MediaFailure('media-probe-rejected')
        _cancel(cancel_event)
        _run_process(['ffmpeg.exe','-nostdin','-v','error','-xerror','-i',str(partial),'-f','null','-'],120,cancel_event,'media-decode-failed')
        _cancel(cancel_event)
        try:os.link(partial,path)
        except FileExistsError:raise MediaFailure('output-already-exists') from None
        partial.unlink()
        return {'status':'download-validated','path':str(path),'bytes':count,'sha256':digest.hexdigest(),'durationSeconds':duration,'videoCodec':video[0].get('codec_name'),'width':video[0].get('width'),'height':video[0].get('height'),'hasAudio':bool(audio),'audioCodec':audio[0].get('codec_name') if audio else None,'fullDecodePassed':True,'cdnHost':host}
    except MediaFailure:raise
    except Exception:
        # Retain incomplete media privately for diagnosis; never treat it as delivered.
        _cancel(cancel_event)
        raise
