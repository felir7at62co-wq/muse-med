"""Request one normal target-window reentry after a verified Windows hook is armed.

The caller owns the native connection generation. This module never starts WeChat,
changes desktop focus, opens chats, retries reentry, or treats a click as readiness.
Windows APIs are loaded lazily so identity and zero-click paths run offline.
"""
from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
from dataclasses import dataclass
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
from typing import Callable, Protocol
import zlib


# These values identify the observed WeChat 25560 build and its public window UI.
EXECUTABLE_SHA256 = 'cea46b7485ff64dbd802da32811318a8844e55ce6cb3bb49325f31ebdb50f0ae'
MODULE_SHA256 = '60630cc1ba346b0e485fbf1981a07a650d1566e004c5b2b84933544860e2b3cf'
TARGET_TITLE = '绿泡泡短剧'
TARGET_CLASS = 'Chrome_WidgetWin_0'
MORE_NAMES = ('更多', '更多选项', '菜单')
REENTER_NAME = '重新进入小程序'
_MENU_RECT = (102, 260, 395, 344)
_MENU_TEMPLATE = b'c-rk<yG|TQ6y5LGXupD(f7l=36P!CCwnSi}l@m)O7J=o&k|RV!WI1qVCmspO4(!MgLIP%w=7_87deL34?t*)Q(a`hg)3@%a`>5*S>gwwH`ugVP=I-up+YvY&PKr}sWx+Tb=Mg#MJ=;YA0(0$YoQ?CKoVP2$?d|P!d*aQ;**Fi%dAklwoW~ZQyNt7OF5$c$h7abwc*AyOFwVw#7UzK`u~ki9#@RS$a9$6+ySuxzNjvwNjI(jB&UsY~(<a@n62{p$Pv>kVHO|J_<YsPQoK0?K(*B$;E-uW@Cb!GW%hMfd`GdKE514mvZ|~^n$Xxd+%MDul`yTLzDvC2V2-<mXhl+}O%62|KKi_ON!^sV^E`-L=h9^~=p@SR1d;i@5Pezg3vuDpZr`1y2B60(Hm>pMv$BYZ9!WlyQXNNwD%jU_vQ6HfX@Hw8qhK_AB;#~(f05L}7mAfviCsYNFkw=jmr#Q|Soa-_&qFS5}4-eCdtEj|0o{V35f@Nrf;`j#6TGXTe=2b-s3XO9`l>pa*GleFBfYt^^tdXVY(9VDhVTQa2=a}M<XV#5<89XT;stJ$5dQJR6UgDdVn!#e=yeb7zm0(eqvjhU+Chl6XKiN%g3G#Dmkh+|G#X)O--Q)G^*UQR{kqg#?eS%?&*`|I;io2D#0Yiq+<DawWb>Qp=0-7<VHHL|~VY-jp9-JtcST4m`D~?*ja~zDxEhFS*@RZKj+;e4os;L_=?D`A~Q_6~*8P{e-G08nv*phlMD6<Axkh3U`T07q%D7S-ygN!6IkEc_qX_Ep$dop&+&41dtK`@p%@orhUQ8>Pl9|Y^r^<)v#6JTg<`t>&AOvQ=BVsc~D!(*S$q*LiItJL+H<FryGtwC-a{oq8(YP2N4)#99&Lgb|%eQM;i*5=k4<(wg+gFiu8`B|lw+y4H(ybUkS3UDRSO<RUudb9(M%fisaileg|B>Ir7eM$mc70wxTt{)kvTf3>;rd$gN&uUc_a)wOU2KnbtKwnyMP?jS%-BH04h_sR17{WMH=};A%yPRA|0t#E%6T?RfH<0GPR-evc7^brWTt&HMbKo^D*mm$IH-}!Z-t5`6rj97CbXMueO~<?a9U93^y80MLJz2#{49CtA^`_glg&X*ZmUBdsu{>|D!r6Dx@<z~7a&zhqwz3Pg)<JH59j5~vgBl)Z<&)ESa=!JmtVF61OKJ2{LT5J!HbeaWb4kyn3g=l(gLQWKVoaR%H7+dn-*GfWZrjKTI3gO3O#hN>x%nDNlnJqnXnJ8%eaSdD=LeU2vIATd&gC1lX2r+qcGjlz%l298Ys<<lsJIStlU^<-UJ(nAPfRAI?weSc)OCZ{VnlHCW6``@bjxc?=6yp&JNrF<s!z|Zvm)=}a&r{N9t-8h=4888iAYA9E4a|(FB>h}DoJz?Vv{YebdenzdFv+G@v)YjTdc1wD>uBsSsma9x#A{auIWO6Q+#pyqPTc_scfk&>}*%xp%K&$*Dqp8(Ok!<!Z~kOfMf0cOU5nM*BWt_ZCVbXAYG>MZF+S;LL0+eyUt{y2=bS?ow24K7fH;v^S8g2xP2AQ*;`8T)-t-S6=tljwc`x=9C!$BRF=-9&MKKnPA}ZHWy{>bZOIoq#2jF$=$0;IoOQRto=L?>k#|#k|0Uyz&6(_;f6s2JbJLB#t3>asoE6%#<(5&%=WT4Rn3yF(8}E0^{&>@foY7Lq*w|dFy_3**U9B};ywHjZ?wORVa#m=|lbe$>#BRXZ-rpTxa)(Q~NfX;6X9dUUxmiUw$XNbkh*{(|-bBB#y4JRh*9t{({wA*2>Odp8>Dx>Fdr0+rcu?-+US!rS>^WqVes#O4(g%J}?Ea0YD{1ev(Au{BwrVOaaeHZo;!0{akr)>U^g!#S0e#bV=Z!jZw+=oSHTtg=N)IZ%aau+sue(x(v(yVZff4c}{x+t>xJ0vMmf}im>u-gUT*B#}Q;+>O>Ts;V<fs^w+Z1PR^jjs8C&12n!9{isl-$TraotVxtotj7{pB{Xy(#w*w3Az+_gL#!2+B?B{F+KRmfBXm{d13jgYsX%tD689{-WJja@)@N6@^AW>$<96wYsc?mAHZ2G9O!W8QOK98s|b!V3IS+Po$a~80T^2W+pYx#@Xa%oQ<=|&D_8^o7~K#?KqG4f38h#PeE>v@?W&y+}x~<GblYiJCDM7AU7D%b+50l*Txx?9-o~@;XIHVjOe;+^MnWec2GNy!g(M!7}0f!+uPeU5C)Bjgh#aV5S+(ygArYKCC)H?av0an>*qY28w|>s2@gKlxv0nKaMCGBulYu|a(*l~7?ksfFyAoWFc=I5gTY`h7z_r3!C){L3<iV2U@#aA27}>=<LvD0^XJcag2(6g;E`|NzP)?*uF6?{{`~pk#f#@2a1bwngFbR`aUp+_-s$NnzXvaY)$iZGKYaLrNB#Y;UcJI&UE?(RT0_j*7-$Zwb_qOx(1q$U0S*5|hlhvsJ-jMsbp9mZoH0sTZoIC~JLp%PE9H5olLsX@?ehrm(vKfMz>ormpfmvjf8q`Pm*}_Y!KyeH#W+*)o6W{KDJ>?WAXAnzcZu0!L)O8i6VvJ04*eBJN}zXgazY<t6rhuIlN&h1JX{Ybgy4H)%-jFlK_(EbJM9T@s_);wQw~+&tBK?L@#9Cvtl%5c(M=|$*a!25K4>>;&6$F55d6iA@+x?O6$Z%pINzo-3O$pz%Vgw4pd|cdnvG3~6|FjPa!%VJ;UVp!n+zQP#Dox(8-_k17H2jV*;0(0I{Y|}Q`fqLU%!4iUaj9r8WK+va%18LBh(6TI2RP;468&3PJlXCFg>6>b@1}zmt3Gum37YC2wG4tU%uqD;6!Iha?+E0Bb6l*r=b6c!&HxM7=0c3IXVoxbTjhwGZR1R=@1;umndY(LPfA8)m&o6&@Zue<MgG+9S8lZ5S}t`IDTHyKhskL2VLX_a~<x0%fUOpeEGuPf)-z5H21$mUr`Hxj(O~-PoL5We<N1G?8Wg(IeTz8TI2(qXJod~$*t(i_vctz%jh6J<3~5qR3EwVYXQ86*7oJbi<MX$Yn9Y(Zp7p!r;bH8ClCXUd*D%K^13<jl*_@X;Xkb_plrG6@zrk7M{c48@g-f!>Z&}LOvdCUEg;=0(L$!&cpRsoHp>IIpLo;A&=jHoiyi#w%S|rdksIf2`OdmonLkSeYc~dEj*E^IQjlt2;;Z=6ul<|G5izO6Stlh3raC=)CLjiL;f$bne0<CqI6eDSr>Cb-j<V)JxzT7~E3W8_y9Teqk(;=d)&h=*Bk8<!?ls1`xcIiOU%!$tH3hK#65rrS*_o8)kN9w~vSwaaMQbNJNGlIlK}Ti8=g{y`<R;M#PdI_-P@-EUI;qgpONZ#@B<E|88;6p<Ewh~V#y)b>EqYFv!b(UwwOD$3*Ub}g5Bd^o4e?|;gXD5~$>fxU0G^tG+gX^PR|h?T{}?4`aK2QiHL(mm(@7&qj0L{Dq~(T#TtoC3iri@S7WIBwZaTU-X@=9D#lfEWBuR?Js5{+7Z(Uk4ql1b3z)CsbbeqkFqo#%FjI#Dv8W|tQ*W$TW8NEyYDF&~&@V$QcD)Wyx%UEoW=!%TXD0;TR^EYqah}lJGGN4U8nRS7j-RT4_o=h4HPX}v=ZU%$F@VHT4d>IUeSR+UaO-cschxfM}JgHjJU}zz?E3YldgKUr{`kdW1KNt*SL3(;rmMphvHF0xV@D2#JYFD@~!eCf)P?INmFH>Tj+TUZNSDy_ALrgMSZcc#ncRsM7)1T#L70V$Fh6MC#j;`Gp;CQ1MDmB?`tSdNf_c}g4?r<Z9!SI+un<F;{xVLZLa-XW-74dJ;k`2$@_SG8<kD!PXF>-USKB%Lc^HS>@dku!i0okGF>qYJz^IQGz-@n&)op-*q-(Yz3A<tki7z_r3VQu&yC{${w'
_MORE_MASK = (
    '........###........',
    '.......#####.......',
    '###...######...###.',
    '###...######...###.',
    '.##....####....##..',
    '.......####.......',
)


@dataclass(frozen=True)
class Identity:
    """Exact process identity already selected by native setup, verified again before UI use."""

    root_pid: int
    created_filetime: int
    session_id: int
    executable_path: str
    module_path: str


@dataclass(frozen=True)
class Options:
    """Deployment choices supplied explicitly by the owning connection configuration."""

    enabled: bool
    allow_fixed_layout: bool
    menu_wait_ms: int
    poll_interval_ms: int
    automation_timeout_ms: int

    def validate(self):
        """Reject invalid wait settings before querying or mutating a window."""
        if type(self.enabled) is not bool or type(self.allow_fixed_layout) is not bool:
            raise ValueError('reentry-options-invalid')
        for value, minimum, maximum in (
            (self.menu_wait_ms, 100, 10000),
            (self.poll_interval_ms, 10, 1000),
            (self.automation_timeout_ms, 100, 10000),
        ):
            if type(value) is not int or not minimum <= value <= maximum:
                raise ValueError('reentry-options-invalid')
        if self.poll_interval_ms > self.menu_wait_ms:
            raise ValueError('reentry-options-invalid')


@dataclass(frozen=True)
class Window:
    """One visible target window, in physical screen pixels."""

    handle: int
    pid: int
    title: str
    class_name: str
    rect: tuple[int, int, int, int]
    client_origin: tuple[int, int]
    client_size: tuple[int, int]
    dpi: int


@dataclass(frozen=True)
class Control:
    """A visible InvokePattern control scoped to the target AutomationElement."""

    name: str
    rect: tuple[int, int, int, int]


@dataclass(frozen=True)
class Image:
    """A top-down RGB capture of the entire owned target window."""

    width: int
    height: int
    rgb: bytes


class Desktop(Protocol):
    """Only the same verified process and its public target UI are exposed to the controller."""

    def identity_matches(self, identity: Identity) -> bool: ...
    def windows(self, identity: Identity) -> list[Window]: ...
    def controls(self, window: Window, identity: Identity, names: tuple[str, ...], timeout_ms: int) -> list[Control]: ...
    def invoke(self, window: Window, identity: Identity, control: Control, timeout_ms: int) -> bool: ...
    def capture(self, window: Window) -> Image | None: ...
    def click(self, window: Window, x: int, y: int) -> bool: ...
    def dismiss(self, window: Window) -> None: ...


def filetime_from_utc(value: str) -> int:
    """Convert the discovery ISO timestamp without dropping Windows' seventh fractional digit."""
    match = re.fullmatch(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{7})(?:Z|\+00:00)', value)
    if match is None:
        raise ValueError('reentry-created-time-invalid')
    base = datetime.datetime.strptime(match[1], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=datetime.timezone.utc)
    epoch = datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc)
    seconds = (base - epoch).days * 86400 + (base - epoch).seconds
    return seconds * 10000000 + int(match[2])


def _window_valid(window: Window, identity: Identity) -> bool:
    left, top, right, bottom = window.rect
    x, y = window.client_origin
    width, height = window.client_size
    return (
        window.handle > 0 and window.pid == identity.root_pid
        and window.title == TARGET_TITLE and window.class_name == TARGET_CLASS
        and 100 <= right - left <= 10000 and 100 <= bottom - top <= 10000
        and left <= x < right and top <= y < bottom
        and 0 < width <= right - x and 0 < height <= bottom - y
        and 96 <= window.dpi <= 384
    )


def _fixed_layout(window: Window, image: Image) -> bool:
    return (
        window.dpi == 96 and window.rect[2] - window.rect[0] == 430
        and window.rect[3] - window.rect[1] == 762
        and image.width == 430 and image.height == 762
        and len(image.rgb) == 430 * 762 * 3
    )


def _more_matches(window: Window, image: Image) -> bool:
    if not _fixed_layout(window, image):
        return False
    for dy, row in enumerate(_MORE_MASK):
        for dx, expected in enumerate(row):
            offset = ((39 + dy) * 430 + 310 + dx) * 3
            white = min(image.rgb[offset:offset + 3]) > 215
            if white != (expected == '#'):
                return False
    return True


def _menu_matches(window: Window, image: Image) -> bool:
    if not _fixed_layout(window, image):
        return False
    expected = zlib.decompress(base64.b85decode(_MENU_TEMPLATE))
    left, top, right, bottom = _MENU_RECT
    actual = b''.join(
        image.rgb[(y * 430 + left) * 3:(y * 430 + right) * 3]
        for y in range(top, bottom)
    )
    # Every foreground pixel of all five labels and icons must match. Background
    # pixels are also checked; a blank rectangle cannot satisfy this comparison.
    return len(actual) == len(expected) and all(abs(a - b) <= 8 for a, b in zip(actual, expected))


class Reentry:
    """At most one bounded reentry attempt for one native connection generation."""

    def __init__(self, identity: Identity, options: Options, desktop: Desktop):
        options.validate()
        self.identity = identity
        self.options = options
        self.desktop = desktop
        self._attempted = False
        self._lock = threading.Lock()

    def _current(self, window: Window) -> bool:
        if not self.desktop.identity_matches(self.identity):
            return False
        matches = self.desktop.windows(self.identity)
        return len(matches) == 1 and matches[0] == window and _window_valid(window, self.identity)

    def run(self, *, phase: str, armed: bool, ready: Callable[[], bool],
            cancelled: Callable[[], bool] = lambda: False,
            wait: Callable[[float], None] = time.sleep) -> dict:
        """Return a fixed status; native readiness must still be observed by the caller.

        Only ``waiting-target`` with an armed hook may perform UI actions. The
        one-shot claim precedes window discovery, so concurrent callers cannot
        turn an unavailable or ambiguous target into repeated refresh attempts.
        """
        if not self.options.enabled:
            return {'status': 'reentry-disabled', 'actions': 0}
        if ready():
            return {'status': 'already-ready', 'actions': 0}
        if phase != 'waiting-target' or armed is not True:
            return {'status': 'reentry-not-eligible', 'actions': 0}
        with self._lock:
            if self._attempted:
                return {'status': 'reentry-already-attempted', 'actions': 0}
            self._attempted = True
        actions = 0
        opened = False
        window = None
        try:
            if cancelled():
                return {'status': 'reentry-cancelled', 'actions': 0}
            if not self.desktop.identity_matches(self.identity):
                return {'status': 'reentry-identity-mismatch', 'actions': 0}
            matches = self.desktop.windows(self.identity)
            if len(matches) != 1:
                return {'status': 'connection-required', 'reason': 'target-window-unavailable', 'actions': 0}
            window = matches[0]
            if not _window_valid(window, self.identity):
                return {'status': 'connection-required', 'reason': 'target-window-invalid', 'actions': 0}
            menu = self.desktop.controls(window, self.identity, (REENTER_NAME,), self.options.automation_timeout_ms)
            if len(menu) > 1:
                return {'status': 'connection-required', 'reason': 'target-menu-ambiguous', 'actions': 0}
            if not menu:
                more = self.desktop.controls(window, self.identity, MORE_NAMES, self.options.automation_timeout_ms)
                if len(more) > 1:
                    return {'status': 'connection-required', 'reason': 'target-menu-ambiguous', 'actions': 0}
                if cancelled() or ready() or not self._current(window):
                    return {'status': 'reentry-state-changed', 'actions': 0}
                if more:
                    opened = self.desktop.invoke(window, self.identity, more[0], self.options.automation_timeout_ms)
                elif self.options.allow_fixed_layout:
                    image = self.desktop.capture(window)
                    if image is not None and _more_matches(window, image) and self._current(window):
                        opened = self.desktop.click(window, 320, 42)
                if not opened:
                    return {'status': 'connection-required', 'reason': 'target-menu-unrecognized', 'actions': 0}
                actions = 1
            deadline = time.monotonic() + self.options.menu_wait_ms / 1000
            while True:
                if cancelled() or ready() or not self._current(window):
                    return {'status': 'reentry-state-changed', 'actions': actions}
                menu = self.desktop.controls(window, self.identity, (REENTER_NAME,), self.options.automation_timeout_ms)
                if len(menu) > 1:
                    return {'status': 'connection-required', 'reason': 'target-menu-ambiguous', 'actions': actions}
                fixed = False
                if not menu and self.options.allow_fixed_layout:
                    image = self.desktop.capture(window)
                    fixed = image is not None and _menu_matches(window, image)
                if menu or fixed:
                    if cancelled() or ready() or not self._current(window):
                        return {'status': 'reentry-state-changed', 'actions': actions}
                    invoked = (self.desktop.invoke(window, self.identity, menu[0], self.options.automation_timeout_ms)
                               if menu else self.desktop.click(window, 244, 285))
                    if not invoked:
                        return {'status': 'connection-required', 'reason': 'target-reentry-unavailable', 'actions': actions}
                    opened = False
                    return {'status': 'reentry-requested', 'actions': actions + 1}
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return {'status': 'connection-required', 'reason': 'target-menu-unrecognized', 'actions': actions}
                wait(min(self.options.poll_interval_ms / 1000, remaining))
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
            return {'status': 'connection-required', 'reason': 'target-ui-unavailable', 'actions': actions}
        finally:
            if opened and window is not None and self._current(window):
                self.desktop.dismiss(window)


_UIA = r"""$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';
$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes;
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('PARAMETERS'))|ConvertFrom-Json;
$process=Get-Process -Id $p.pid -ErrorAction Stop;
if($process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $p.created){throw 'changed'};
$root=[Windows.Automation.AutomationElement]::FromHandle([IntPtr]([long]$p.handle));
if($root.Current.ProcessId -ne $p.pid -or $root.Current.Name -cne $p.title){throw 'changed'};
$rows=[Collections.Generic.List[object]]::new();$nodes=0;
$walker=[Windows.Automation.TreeWalker]::ControlViewWalker;
function Read-Target($element,$depth) {
 if($depth -gt 8 -or $script:nodes -ge 256){return};
 $child=$walker.GetFirstChild($element);
 while($null -ne $child -and $script:nodes -lt 256){
  $script:nodes++;$v=$child.Current;$pattern=$null;
  if($v.ProcessId -eq $p.pid -and $p.names -ccontains $v.Name -and !$v.IsOffscreen -and $v.IsEnabled -and
     ($v.ControlType -eq [Windows.Automation.ControlType]::Button -or $v.ControlType -eq [Windows.Automation.ControlType]::MenuItem) -and
     $child.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){
    $r=$v.BoundingRectangle;$rect=@([int]$r.Left,[int]$r.Top,[int]$r.Right,[int]$r.Bottom);
    if($p.invoke -and ($rect -join ',') -ceq ($p.rect -join ',') -and $v.Name -ceq $p.name){
      if((Get-Process -Id $p.pid).StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $p.created){throw 'changed'};
      $pattern.Invoke();$rows.Add([pscustomobject]@{invoked=$true});return;
    } elseif(!$p.invoke){$rows.Add([pscustomobject]@{name=$v.Name;rect=$rect})};
  };
  Read-Target $child ($depth+1);if($p.invoke -and $rows.Count -ne 0){return};
  $child=$walker.GetNextSibling($child);
 }
};Read-Target $root 0;ConvertTo-Json -InputObject @($rows.ToArray()) -Compress -Depth 4
"""


class WindowsDesktop:
    """Same-session Win32 captures and normal UI actions; no global input injection is used."""

    def __init__(self):
        if sys.platform != 'win32':
            raise OSError('reentry-windows-required')
        self.user = ctypes.WinDLL('user32', use_last_error=True)
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.advapi = ctypes.WinDLL('advapi32', use_last_error=True)
        self.gdi = ctypes.WinDLL('gdi32', use_last_error=True)
        self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel.OpenProcess.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.GetCurrentProcess.restype = wintypes.HANDLE
        self.kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        self.kernel.ProcessIdToSessionId.argtypes = [wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
        self.kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        self.advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
        self.advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
        self.advapi.EqualSid.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        self.user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        for name in ('IsWindowVisible', 'IsIconic', 'GetDpiForWindow'):
            getattr(self.user, name).argtypes = [wintypes.HWND]
        for name in ('GetWindowTextW', 'GetClassNameW'):
            getattr(self.user, name).argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        for name in ('GetWindowRect', 'GetClientRect'):
            getattr(self.user, name).argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        self.user.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
        self.user.GetWindowDC.argtypes = [wintypes.HWND]
        self.user.GetWindowDC.restype = wintypes.HDC
        self.user.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
        self.user.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
        self.user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        self.gdi.CreateCompatibleDC.argtypes = [wintypes.HDC]
        self.gdi.CreateCompatibleDC.restype = wintypes.HDC
        self.gdi.CreateDIBSection.argtypes = [wintypes.HDC, ctypes.c_void_p, wintypes.UINT, ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD]
        self.gdi.CreateDIBSection.restype = wintypes.HBITMAP
        self.gdi.SelectObject.argtypes = [wintypes.HDC, wintypes.HANDLE]
        self.gdi.SelectObject.restype = wintypes.HANDLE
        self.gdi.DeleteObject.argtypes = [wintypes.HANDLE]
        self.gdi.DeleteDC.argtypes = [wintypes.HDC]

    def identity_matches(self, identity: Identity) -> bool:
        """Recheck creation time, session, owner SID and both exact-build files."""
        process = self.kernel.OpenProcess(0x1000, False, identity.root_pid)
        if not process:
            return False
        tokens = []
        try:
            created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
            if not self.kernel.GetProcessTimes(process, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)):
                return False
            stamp = created.dwHighDateTime << 32 | created.dwLowDateTime
            current_session, target_session = wintypes.DWORD(), wintypes.DWORD()
            if not self.kernel.ProcessIdToSessionId(os.getpid(), ctypes.byref(current_session)) or not self.kernel.ProcessIdToSessionId(identity.root_pid, ctypes.byref(target_session)):
                return False
            if stamp != identity.created_filetime or current_session.value != identity.session_id or target_session.value != identity.session_id:
                return False
            size = wintypes.DWORD(32768)
            path = ctypes.create_unicode_buffer(size.value)
            if not self.kernel.QueryFullProcessImageNameW(process, 0, path, ctypes.byref(size)) or os.path.normcase(path.value) != os.path.normcase(identity.executable_path):
                return False
            sid_buffers = []
            for handle in (process, self.kernel.GetCurrentProcess()):
                token = wintypes.HANDLE()
                if not self.advapi.OpenProcessToken(handle, 8, ctypes.byref(token)):
                    return False
                tokens.append(token)
                length = wintypes.DWORD()
                self.advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(length))
                buffer = ctypes.create_string_buffer(length.value)
                if not self.advapi.GetTokenInformation(token, 1, buffer, length, ctypes.byref(length)):
                    return False
                sid_buffers.append(buffer)
            if not self.advapi.EqualSid(ctypes.cast(sid_buffers[0], ctypes.POINTER(ctypes.c_void_p))[0], ctypes.cast(sid_buffers[1], ctypes.POINTER(ctypes.c_void_p))[0]):
                return False
            for path_value, digest in ((identity.executable_path, EXECUTABLE_SHA256), (identity.module_path, MODULE_SHA256)):
                with open(path_value, 'rb') as stream:
                    if hashlib.file_digest(stream, 'sha256').hexdigest() != digest:
                        return False
            return True
        finally:
            for token in tokens:
                self.kernel.CloseHandle(token)
            self.kernel.CloseHandle(process)

    def windows(self, identity: Identity) -> list[Window]:
        """Read titles only after the HWND is confirmed to belong to the selected root PID."""
        result = []
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def visit(handle, _parameter):
            pid = wintypes.DWORD()
            self.user.GetWindowThreadProcessId(handle, ctypes.byref(pid))
            if pid.value != identity.root_pid or not self.user.IsWindowVisible(handle) or self.user.IsIconic(handle):
                return True
            name, class_name = ctypes.create_unicode_buffer(256), ctypes.create_unicode_buffer(256)
            self.user.GetWindowTextW(handle, name, 256)
            self.user.GetClassNameW(handle, class_name, 256)
            if name.value != TARGET_TITLE or class_name.value != TARGET_CLASS:
                return True
            rect, client, origin = wintypes.RECT(), wintypes.RECT(), wintypes.POINT()
            if not self.user.GetWindowRect(handle, ctypes.byref(rect)) or not self.user.GetClientRect(handle, ctypes.byref(client)) or not self.user.ClientToScreen(handle, ctypes.byref(origin)):
                return True
            result.append(Window(int(handle), pid.value, name.value, class_name.value,
                                 (rect.left, rect.top, rect.right, rect.bottom), (origin.x, origin.y),
                                 (client.right, client.bottom), self.user.GetDpiForWindow(handle)))
            return True
        callback = callback_type(visit)
        if not self.user.EnumWindows(callback, 0):
            raise OSError('reentry-window-enumeration-failed')
        return result

    def _uia(self, window, identity, names, timeout_ms, control=None):
        parameters = {'pid': identity.root_pid, 'created': str(identity.created_filetime), 'handle': str(window.handle),
                      'title': TARGET_TITLE, 'names': names, 'invoke': control is not None,
                      'name': control.name if control else '', 'rect': control.rect if control else []}
        data = base64.b64encode(json.dumps(parameters, ensure_ascii=False).encode()).decode()
        script = base64.b64encode(_UIA.replace('PARAMETERS', data).encode('utf-16le')).decode()
        executable = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32' / 'WindowsPowerShell' / 'v1.0' / 'powershell.exe'
        process = subprocess.Popen([str(executable), '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', script],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   creationflags=0x08000000)
        try:
            stdout, _stderr = process.communicate(timeout=timeout_ms / 1000)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise RuntimeError('reentry-automation-timeout') from None
        if process.returncode or len(stdout) > 32768:
            raise RuntimeError('reentry-automation-unavailable')
        rows = json.loads(stdout.decode('utf-8-sig'))
        if not isinstance(rows, list) or len(rows) > 256:
            raise ValueError('reentry-automation-invalid')
        return rows

    def controls(self, window, identity, names, timeout_ms):
        result = []
        for row in self._uia(window, identity, names, timeout_ms):
            if not isinstance(row, dict) or set(row) != {'name', 'rect'} or row['name'] not in names or not isinstance(row['rect'], list) or len(row['rect']) != 4 or any(type(v) is not int for v in row['rect']):
                raise ValueError('reentry-automation-invalid')
            rect = tuple(row['rect'])
            if window.rect[0] <= rect[0] < rect[2] <= window.rect[2] and window.rect[1] <= rect[1] < rect[3] <= window.rect[3]:
                result.append(Control(row['name'], rect))
        return result

    def invoke(self, window, identity, control, timeout_ms):
        return self._uia(window, identity, (control.name,), timeout_ms, control) == [{'invoked': True}]

    def capture(self, window):
        width, height = window.rect[2] - window.rect[0], window.rect[3] - window.rect[1]
        class Header(ctypes.Structure):
            _fields_ = [('size', wintypes.DWORD), ('width', wintypes.LONG), ('height', wintypes.LONG),
                        ('planes', wintypes.WORD), ('bits', wintypes.WORD), ('compression', wintypes.DWORD),
                        ('image_bytes', wintypes.DWORD), ('x', wintypes.LONG), ('y', wintypes.LONG),
                        ('colors', wintypes.DWORD), ('important', wintypes.DWORD)]
        source = self.user.GetWindowDC(window.handle)
        dc, bitmap, prior = None, None, None
        try:
            if not source:
                return None
            dc = self.gdi.CreateCompatibleDC(source)
            header, pixels = Header(40, width, -height, 1, 32, 0, 0, 0, 0, 0, 0), ctypes.c_void_p()
            bitmap = self.gdi.CreateDIBSection(dc, ctypes.byref(header), 0, ctypes.byref(pixels), None, 0)
            if not dc or not bitmap or not pixels:
                return None
            prior = self.gdi.SelectObject(dc, bitmap)
            if not self.user.PrintWindow(window.handle, dc, 2):
                return None
            bgra = ctypes.string_at(pixels, width * height * 4)
            rgb = bytearray(width * height * 3)
            rgb[0::3], rgb[1::3], rgb[2::3] = bgra[2::4], bgra[1::4], bgra[0::4]
            return Image(width, height, bytes(rgb))
        finally:
            if prior:
                self.gdi.SelectObject(dc, prior)
            if bitmap:
                self.gdi.DeleteObject(bitmap)
            if dc:
                self.gdi.DeleteDC(dc)
            if source:
                self.user.ReleaseDC(window.handle, source)

    def click(self, window, x, y):
        # Reference coordinates are physical window pixels, never assumed client pixels.
        client_x = window.rect[0] + x - window.client_origin[0]
        client_y = window.rect[1] + y - window.client_origin[1]
        if not (0 <= client_x < window.client_size[0] and 0 <= client_y < window.client_size[1]):
            return False
        point = client_y << 16 | client_x
        return all(self.user.PostMessageW(window.handle, message, key, point) for message, key in ((0x200, 0), (0x201, 1), (0x202, 0)))

    def dismiss(self, window):
        self.user.PostMessageW(window.handle, 0x100, 0x1B, 0)
        self.user.PostMessageW(window.handle, 0x101, 0x1B, 0)
