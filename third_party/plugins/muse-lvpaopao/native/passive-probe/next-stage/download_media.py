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
import stat
import sys
import secrets
import ssl
import time
from functools import cache
import urllib.parse
import urllib.request
import urllib.error

class MediaFailure(RuntimeError):pass
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*_):raise MediaFailure('redirect-not-accepted')

@cache
def _mac_https_context():
    """Load Apple's public system roots while keeping TLS and hostname verification enabled."""
    raw=_run_process(['/usr/bin/security','find-certificate','-a','-p','/System/Library/Keychains/SystemRootCertificates.keychain'],10,None,'tls-trust-unavailable')
    if not 1<=len(raw)<=2*1024*1024:raise MediaFailure('tls-trust-unavailable')
    try:context=ssl.create_default_context(cadata=raw.decode('ascii'))
    except (UnicodeError,ssl.SSLError):raise MediaFailure('tls-trust-unavailable') from None
    if not context.check_hostname or context.verify_mode!=ssl.CERT_REQUIRED or context.cert_store_stats()['x509_ca']<1:raise MediaFailure('tls-trust-unavailable')
    return context

def _opener():
    handlers=[NoRedirect()]
    if sys.platform=='darwin':handlers.append(urllib.request.HTTPSHandler(context=_mac_https_context()))
    return urllib.request.build_opener(*handlers)

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

def _regular(path):
    info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or getattr(info,'st_file_attributes',0)&0x400:
        raise MediaFailure('resume-state-invalid')
    return info


def _resume_write(path,value):
    if path.exists() or path.is_symlink():_regular(path)
    temporary=path.with_name('.pending-'+secrets.token_hex(12))
    try:
        with temporary.open('x',encoding='utf8') as stream:
            if os.name!='nt':temporary.chmod(0o600)
            json.dump(value,stream,separators=(',',':'));stream.write('\n');stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,path)
    finally:temporary.unlink(missing_ok=True)


def _validator(headers):
    for name in ('ETag','Last-Modified'):
        value=headers.get(name)
        if isinstance(value,str) and 1<=len(value)<=512 and not re.search(r'[\x00-\x1f\x7f]',value) and (name!='ETag' or value.startswith('"') and value.endswith('"')):
            return {'name':name,'value':value}
    return None


def _resume_state(partial,state_path,url_hash):
    info=_regular(partial)
    if not state_path.exists() and not state_path.is_symlink():
        if info.st_size==0:return None
        raise MediaFailure('resume-validator-missing')
    state_info=_regular(state_path)
    if not 1<=state_info.st_size<=4096:raise MediaFailure('resume-state-invalid')
    try:value=json.loads(state_path.read_bytes())
    except (ValueError,TypeError,UnicodeError):raise MediaFailure('resume-state-invalid') from None
    if (not isinstance(value,dict) or set(value)!={'schemaVersion','urlSha256','bytes','totalBytes','prefixSha256','validator'}
            or value['schemaVersion']!=1 or value['urlSha256']!=url_hash or type(value['bytes']) is not int or type(value['totalBytes']) is not int
            or not 0<=value['bytes']<=value['totalBytes']<=200*1024*1024 or value['totalBytes']==0 or info.st_size<value['bytes']
            or not isinstance(value['prefixSha256'],str) or re.fullmatch(r'[0-9a-f]{64}',value['prefixSha256']) is None):
        raise MediaFailure('resume-state-invalid')
    validator=value['validator']
    if validator is not None and (not isinstance(validator,dict) or set(validator)!={'name','value'} or _validator({validator.get('name'):validator.get('value')})!=validator):
        raise MediaFailure('resume-state-invalid')
    digest=hashlib.sha256()
    with partial.open('rb') as stream:
        remaining=value['bytes']
        while remaining:
            chunk=stream.read(min(1024*1024,remaining))
            if not chunk:raise MediaFailure('resume-state-invalid')
            digest.update(chunk);remaining-=len(chunk)
    if digest.hexdigest()!=value['prefixSha256']:raise MediaFailure('resume-state-invalid')
    if info.st_size!=value['bytes']:
        with partial.open('r+b') as stream:stream.truncate(value['bytes'])
    return value


def download(url,output_dir,cancel_event=None,*,output_name='laoshou-episode-01.mp4',resume=False,ffprobe_path=None,ffmpeg_path=None):
    """Download, validate and exclusively publish one native-authorized media file.

    Resume uses the same URL's hash, fsynced prefix/hash, original resource length
    and a strong ETag or Last-Modified validator. Only a matching 206 response is
    appended; resource changes and ignored ranges preserve the existing checkpoint.
    Probe/decode children are stopped and reaped before cancellation is returned.
    The legacy default rejects existing partial files. Tools default to native OS
    executable names; trusted deployments may supply explicit executable paths.
    """
    _cancel(cancel_event)
    if not isinstance(output_name,str) or len(output_name)>80 or re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]*\.mp4',output_name) is None:
        raise MediaFailure('output-name-invalid')
    if type(resume) is not bool:raise MediaFailure('resume-state-invalid')
    host=check_url(url);_cancel(cancel_event)
    folder=Path(output_dir);folder.mkdir(parents=True,exist_ok=True)
    folder_info=folder.lstat()
    if not stat.S_ISDIR(folder_info.st_mode) or getattr(folder_info,'st_file_attributes',0)&0x400:raise MediaFailure('resume-state-invalid')
    path=folder/output_name;partial=path.with_suffix('.part');state_path=partial.with_suffix('.part.json')
    if path.exists() or path.is_symlink():raise MediaFailure('output-already-exists')
    url_hash=hashlib.sha256(url.encode('utf8')).hexdigest();state=None
    if partial.exists() or partial.is_symlink():
        if not resume:raise MediaFailure('output-already-exists')
        state=_resume_state(partial,state_path,url_hash)
    elif state_path.exists() or state_path.is_symlink():raise MediaFailure('resume-state-invalid')
    digest=hashlib.sha256();count=0;deadline=time.monotonic()+120
    if state is not None:
        with partial.open('rb') as stream:
            for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
        count=state['bytes']
    initial_count=count;expected=state['totalBytes'] if state is not None else None
    complete=state is not None and count==expected
    try:
        if not complete:
            headers={'User-Agent':'Mozilla/5.0','Referer':'https://servicewechat.com/wx404dde55fb12df78/108/page-frame.html'}
            if count:
                if state['validator'] is None:raise MediaFailure('resume-validator-missing')
                headers.update({'Range':f'bytes={count}-','If-Range':state['validator']['value']})
            request=urllib.request.Request(url,headers=headers);_cancel(cancel_event)
            with _opener().open(request,timeout=20) as response:
                _cancel(cancel_event)
                length=response.headers.get('Content-Length')
                length=int(length) if isinstance(length,str) and length.isdecimal() else None
                validator=_validator(response.headers)
                if count:
                    content_range=response.headers.get('Content-Range')
                    match=re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)',content_range or '')
                    if response.status!=206 or match is None:raise MediaFailure('resume-response-invalid')
                    start,end,total=map(int,match.groups())
                    if start!=count or total!=expected or end!=total-1 or length is not None and length!=total-count or validator!=state['validator']:
                        raise MediaFailure('resume-resource-changed')
                else:
                    if response.status!=200:raise MediaFailure('http-status-rejected')
                    expected=length
                    if expected is not None and not 1<=expected<=200*1024*1024:raise MediaFailure('declared-size-rejected')
                mode='r+b' if partial.exists() else 'xb'
                with partial.open(mode) as stream:
                    if mode=='xb' and os.name!='nt':partial.chmod(0o600)
                    stream.seek(count)
                    if resume and expected is not None:
                        stream.flush();os.fsync(stream.fileno())
                        _resume_write(state_path,{'schemaVersion':1,'urlSha256':url_hash,'bytes':count,'totalBytes':expected,'prefixSha256':digest.hexdigest(),'validator':validator})
                    while True:
                        _cancel(cancel_event)
                        if time.monotonic()>deadline:raise MediaFailure('download-deadline')
                        chunk=response.read(1024*1024);_cancel(cancel_event)
                        if not chunk:break
                        count+=len(chunk)
                        if count>200*1024*1024 or expected is not None and count>expected:raise MediaFailure('media-size-limit')
                        stream.write(chunk);digest.update(chunk)
                        if resume and expected is not None:
                            stream.flush();os.fsync(stream.fileno())
                            _resume_write(state_path,{'schemaVersion':1,'urlSha256':url_hash,'bytes':count,'totalBytes':expected,'prefixSha256':digest.hexdigest(),'validator':validator})
                        _cancel(cancel_event)
        _cancel(cancel_event)
        if count==0 or expected is not None and count!=expected:raise MediaFailure('media-size-mismatch')
        probe_name=ffprobe_path or os.environ.get('DSH_FFPROBE_PATH') or ('ffprobe.exe' if sys.platform=='win32' else 'ffprobe')
        decode_name=ffmpeg_path or os.environ.get('DSH_FFMPEG_PATH') or ('ffmpeg.exe' if sys.platform=='win32' else 'ffmpeg')
        if (ffprobe_path or os.environ.get('DSH_FFPROBE_PATH')) and not Path(probe_name).is_absolute():raise MediaFailure('media-probe-rejected')
        if (ffmpeg_path or os.environ.get('DSH_FFMPEG_PATH')) and not Path(decode_name).is_absolute():raise MediaFailure('media-decode-failed')
        probe=_run_process([probe_name,'-v','error','-show_format','-show_streams','-of','json',str(partial)],30,cancel_event,'media-probe-rejected')
        try:
            info=json.loads(probe);streams=info.get('streams',[]);video=[v for v in streams if v.get('codec_type')=='video'];audio=[v for v in streams if v.get('codec_type')=='audio']
            duration=float(info.get('format',{}).get('duration','0'))
        except (ValueError,TypeError,AttributeError):raise MediaFailure('media-probe-rejected') from None
        if not video or not math.isfinite(duration) or duration<=0:raise MediaFailure('media-probe-rejected')
        _cancel(cancel_event)
        _run_process([decode_name,'-nostdin','-v','error','-xerror','-i',str(partial),'-f','null','-'],120,cancel_event,'media-decode-failed')
        _cancel(cancel_event)
        result={'status':'download-validated','path':str(path),'bytes':count,'sha256':digest.hexdigest(),'durationSeconds':duration,'videoCodec':video[0].get('codec_name'),'width':video[0].get('width'),'height':video[0].get('height'),'hasAudio':bool(audio),'audioCodec':audio[0].get('codec_name') if audio else None,'fullDecodePassed':True,'cdnHost':host,'resumedBytes':initial_count}
        if resume:
            evidence={field:result[field] for field in ('bytes','sha256','durationSeconds','width','height','hasAudio','fullDecodePassed')}
            _resume_write(path.with_suffix('.mp4.evidence.json'),{'schemaVersion':1,'fileName':output_name,'media':evidence})
        try:os.link(partial,path)
        except FileExistsError:raise MediaFailure('output-already-exists') from None
        partial.unlink();state_path.unlink(missing_ok=True)
        return result
    except MediaFailure:raise
    except urllib.error.HTTPError as error:
        error.close()
        raise MediaFailure('http-status-rejected') from None
    except Exception:
        _cancel(cancel_event)
        raise
